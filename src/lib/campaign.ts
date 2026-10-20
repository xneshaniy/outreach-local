import type { Campaign, Contact, Prisma } from "@prisma/client";
import { prisma } from "./db";
import { enqueueJob } from "./queue";
import { clampToWindow, type SendingWindow } from "./scheduling";
import type { ParsedContactRow } from "./csv";
import { env } from "./env";

/**
 * Campaign engine: adding contacts, scheduling in recipient-local time,
 * schedule changes, lifecycle transitions and statistics.
 */

export function campaignWindow(campaign: Campaign): SendingWindow {
  return {
    startMinute: campaign.windowStartMinute,
    endMinute: campaign.windowEndMinute,
    days: campaign.sendingDays,
  };
}

export type AddContactsResult = {
  added: number;
  duplicates: number;
  invalid: number;
  heldForTimezone: number;
};

/**
 * Add contacts to a campaign (idempotent, transaction-safe).
 *
 * 1. Upsert contacts by (userId, emailNormalized) — DB unique constraint.
 * 2. Create campaign recipients — UNIQUE (campaignId, contactId) makes
 *    re-imports and concurrent requests harmless (skipDuplicates = ON CONFLICT
 *    DO NOTHING).
 * 3. Compute the recipient-local send time; HOLD unknown time zones when the
 *    campaign's fallback mode says so.
 * 4. Enqueue the single logical job per recipient (idempotent upsert).
 */
export async function addContactsToCampaign(
  campaign: Campaign,
  rows: ParsedContactRow[],
  importBatchId?: string,
): Promise<AddContactsResult> {
  const window = campaignWindow(campaign);
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    // 1. Contacts upsert
    await tx.contact.createMany({
      data: rows.map((r) => ({
        userId: campaign.userId,
        email: r.email,
        emailNormalized: r.emailNormalized,
        firstName: r.firstName ?? null,
        lastName: r.lastName ?? null,
        company: r.company ?? null,
        website: r.website ?? null,
        title: r.title ?? null,
        timeZone: r.timeZone ?? null,
        country: r.country ?? null,
      })),
      skipDuplicates: true,
    });

    const emails = rows.map((r) => r.emailNormalized);
    const contacts = await tx.contact.findMany({
      where: { userId: campaign.userId, emailNormalized: { in: emails } },
    });

    // 2 + 3. Recipients with pre-computed scheduling.
    let heldForTimezone = 0;
    const recipientRows = contacts.map((contact) => {
      const scheduledAt = clampToWindow(now, contact.timeZone, window, {
        mode: campaign.timeZoneFallback,
        fallbackTimeZone: campaign.fallbackTimeZone,
      });
      if (!scheduledAt) {
        heldForTimezone++;
        return {
          campaignId: campaign.id,
          contactId: contact.id,
          status: "HELD_TZ" as const,
          scheduledAt: null,
          skipReason: "UNKNOWN_TIMEZONE",
          importBatchId: importBatchId ?? null,
        };
      }
      return {
        campaignId: campaign.id,
        contactId: contact.id,
        status: "SCHEDULED" as const,
        scheduledAt,
        importBatchId: importBatchId ?? null,
      };
    });

    const created = await tx.campaignRecipient.createMany({
      data: recipientRows,
      skipDuplicates: true, // ON CONFLICT DO NOTHING on (campaignId, contactId)
    });

    // 4. Enqueue jobs for every scheduled recipient that does not have one yet
    //    (self-healing: also picks up rows created by earlier failed runs).
    const pending = await tx.campaignRecipient.findMany({
      where: { campaignId: campaign.id, status: "SCHEDULED", scheduledAt: { not: null }, sendJob: null },
      select: { id: true, contactId: true, scheduledAt: true },
    });
    for (const r of pending) {
      await enqueueJob(tx, {
        campaignRecipientId: r.id,
        campaignId: campaign.id,
        contactId: r.contactId,
        userId: campaign.userId,
        scheduledAt: r.scheduledAt!,
      });
    }

    const duplicates = rows.length - created.count;
    return {
      added: created.count,
      duplicates: Math.max(0, duplicates),
      invalid: 0,
      heldForTimezone,
    };
  });
}

/**
 * Recompute pending schedules after the campaign's sending window changed.
 * Only QUEUED jobs (never claimed/terminal) are moved; HELD_TZ recipients are
 * re-evaluated too (they may get a fallback if the mode changed).
 * Returns the number of rescheduled jobs.
 */
export async function reschedulePendingRecipients(campaign: Campaign): Promise<number> {
  const window = campaignWindow(campaign);
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const recipients = await tx.campaignRecipient.findMany({
      where: {
        campaignId: campaign.id,
        status: { in: ["PENDING", "SCHEDULED", "HELD_TZ"] },
      },
      include: { contact: true, sendJob: true },
    });

    let moved = 0;
    for (const r of recipients) {
      const next = clampToWindow(now, r.contact.timeZone, window, {
        mode: campaign.timeZoneFallback,
        fallbackTimeZone: campaign.fallbackTimeZone,
      });

      if (!next) {
        if (r.status !== "HELD_TZ") {
          await tx.campaignRecipient.update({
            where: { id: r.id },
            data: { status: "HELD_TZ", scheduledAt: null, skipReason: "UNKNOWN_TIMEZONE" },
          });
        }
        continue;
      }

      await tx.campaignRecipient.update({
        where: { id: r.id },
        data: { status: "SCHEDULED", scheduledAt: next, skipReason: null },
      });

      if (r.sendJob && r.sendJob.status === "QUEUED") {
        await tx.sendJob.updateMany({
          where: { id: r.sendJob.id, status: "QUEUED" },
          data: { scheduledAt: next },
        });
        moved++;
      } else if (!r.sendJob) {
        await enqueueJob(tx, {
          campaignRecipientId: r.id,
          campaignId: campaign.id,
          contactId: r.contactId,
          userId: campaign.userId,
          scheduledAt: next,
        });
        moved++;
      }
    }
    return moved;
  });
}

/**
 * Pre-flight checks required before a campaign can start sending
 * (spec §4: no bulk sending until accounts, eligibility, unsubscribe handling
 * and quota enforcement are configured).
 */
export async function canStartCampaign(campaign: Campaign): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];

  const accounts = await prisma.senderAccount.count({
    where: { userId: campaign.userId, status: "CONNECTED" },
  });
  if (accounts === 0) {
    problems.push("Connect at least one sender account before starting a campaign.");
  }

  const eligible = await prisma.campaignRecipient.count({
    where: { campaignId: campaign.id, status: "SCHEDULED" },
  });
  if (eligible === 0) {
    problems.push("The campaign has no eligible recipients (import contacts first).");
  }

  if (!env.appUrl) {
    problems.push("APP_URL must be configured for unsubscribe links.");
  }
  if (!campaign.subject.trim() || !campaign.body.trim()) {
    problems.push("Subject and message body are required.");
  }

  return { ok: problems.length === 0, problems };
}

export type CampaignStats = {
  total: number;
  byStatus: Record<string, number>;
  scheduled: number;
  queued: number;
  sending: number;
  sent: number;
  failed: number;
  skipped: number;
  cancelled: number;
  pending: number;
  heldForTimezone: number;
};

export async function campaignStats(campaignId: string): Promise<CampaignStats> {
  const groups = await prisma.campaignRecipient.groupBy({
    by: ["status"],
    where: { campaignId },
    _count: { _all: true },
  });
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const g of groups) {
    byStatus[g.status] = g._count._all;
    total += g._count._all;
  }
  return {
    total,
    byStatus,
    pending: byStatus.PENDING ?? 0,
    scheduled: byStatus.SCHEDULED ?? 0,
    heldForTimezone: byStatus.HELD_TZ ?? 0,
    queued: byStatus.QUEUED ?? 0,
    sending: byStatus.SENDING ?? 0,
    sent: byStatus.SENT ?? 0,
    failed: byStatus.FAILED ?? 0,
    skipped: byStatus.SKIPPED ?? 0,
    cancelled: byStatus.CANCELLED ?? 0,
  };
}

export type CampaignRow = Prisma.CampaignGetPayload<{ include: { recipients: false } }>;

/**
 * Release every QUEUED job of a paused campaign back out of the due window by
 * pushing their scheduled time far into the future is NOT done — instead the
 * worker skips non-ACTIVE campaigns and requeues them cheaply. This helper is
 * used by "cancel" to make the stop durable.
 */
export async function markCampaignCancelled(campaignId: string): Promise<void> {
  await prisma.$transaction([
    prisma.campaign.update({ where: { id: campaignId }, data: { status: "CANCELLED" } }),
    prisma.sendJob.updateMany({
      where: { campaignId, status: "QUEUED" },
      data: { status: "CANCELLED" },
    }),
    prisma.campaignRecipient.updateMany({
      where: { campaignId, status: { in: ["PENDING", "SCHEDULED", "QUEUED", "HELD_TZ"] } },
      data: { status: "CANCELLED" },
    }),
  ]);
}

/** Hold recipients whose contacts lack a time zone (manual review list). */
export async function listHeldRecipients(campaignId: string, limit = 100) {
  return prisma.campaignRecipient.findMany({
    where: { campaignId, status: "HELD_TZ" },
    take: limit,
    include: { contact: { select: { email: true, firstName: true, lastName: true, timeZone: true, country: true } } },
  });
}

export type { Contact };
