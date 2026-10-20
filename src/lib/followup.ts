import type { Campaign, Contact, FollowUpSequence, FollowUpStep } from "@prisma/client";
import { prisma, type TxLike } from "./db";
import { checkSuppression } from "./suppression";
import { clampToWindow, type SendingWindow } from "./scheduling";
import { enqueueFollowUpJob } from "./queue";

/**
 * Follow-up sequences.
 *
 * Lifecycle:
 *   1. A campaign has `followUpSequenceId` set.
 *   2. After the FIRST email of that campaign is accepted by the provider, the
 *      first follow-up step is scheduled for that recipient.
 *   3. Each subsequent step is scheduled when the previous one is accepted.
 *   4. Every pending follow-up is cancelled automatically when the contact
 *      becomes ineligible (replied / unsubscribed / bounced / complained /
 *      suppressed) or when the campaign is paused or cancelled.
 *
 * Scheduling is durable: the follow-up message and its job live in the
 * database, so a worker restart loses nothing.
 */

/** Contacts that must never receive another message. */
export const INELIGIBLE_CONTACT_STATUSES = ["UNSUBSCRIBED", "BOUNCED", "COMPLAINED", "INVALID"] as const;

export function campaignWindow(campaign: Campaign): SendingWindow {
  return {
    startMinute: campaign.windowStartMinute,
    endMinute: campaign.windowEndMinute,
    days: campaign.sendingDays,
  };
}

/**
 * Is this contact still eligible to receive outreach?
 * Checks the contact status, the suppression list and the contact-frequency
 * guard. Used before scheduling any follow-up.
 */
export async function isEligibleForFollowUp(
  userId: string,
  contact: Pick<Contact, "id" | "emailNormalized" | "status" | "lastSentAt">,
  campaignId: string,
  minDaysBetweenContacts: number,
): Promise<{ eligible: boolean; reason?: string }> {
  if ((INELIGIBLE_CONTACT_STATUSES as readonly string[]).includes(contact.status)) {
    return { eligible: false, reason: `Contact status is ${contact.status}.` };
  }
  if (contact.status === "REPLIED" || contact.status === "INTERESTED") {
    return { eligible: false, reason: "The contact already replied." };
  }
  const suppression = await checkSuppression(userId, contact.emailNormalized, campaignId);
  if (suppression.suppressed) {
    return { eligible: false, reason: `Suppressed (${suppression.reason ?? "unknown"}).` };
  }
  if (minDaysBetweenContacts > 0 && contact.lastSentAt) {
    const gapMs = Date.now() - contact.lastSentAt.getTime();
    if (gapMs < minDaysBetweenContacts * 86400000) {
      return {
        eligible: false,
        reason: `Sent less than ${minDaysBetweenContacts} day(s) ago.`,
      };
    }
  }
  return { eligible: true };
}

/**
 * Schedule the next follow-up step for one recipient.
 *
 * Idempotent: the FollowUpMessage + SendJob are created with deterministic
 * keys, so a retry can never create a second message for the same step.
 */
export async function scheduleNextFollowUp(input: {
  userId: string;
  campaign: Campaign;
  contact: Contact;
  sequence: FollowUpSequence & { steps: FollowUpStep[] };
  /** The step to schedule (already resolved by the caller). */
  step: FollowUpStep;
  /** The instant the previous message was accepted. */
  from: Date;
  minDaysBetweenContacts: number;
}): Promise<{ scheduled: boolean; reason?: string; messageId?: string; jobId?: string }> {
  const { userId, campaign, contact, sequence, step, from, minDaysBetweenContacts } = input;

  if (!sequence.isActive) return { scheduled: false, reason: "The follow-up sequence is inactive." };
  if (campaign.status !== "ACTIVE") return { scheduled: false, reason: `The campaign is ${campaign.status}.` };
  if (campaign.emergencyStopped) return { scheduled: false, reason: "The campaign is emergency-stopped." };

  const eligibility = await isEligibleForFollowUp(userId, contact, campaign.id, minDaysBetweenContacts);
  if (!eligibility.eligible) return { scheduled: false, reason: eligibility.reason };

  // delayDays after the previous message, then clamped into the recipient's
  // local sending window.
  const proposed = new Date(from.getTime() + step.delayDays * 86400000);
  const scheduledAt = clampToWindow(proposed, contact.timeZone, campaignWindow(campaign), {
    mode: campaign.timeZoneFallback,
    fallbackTimeZone: campaign.fallbackTimeZone,
  });
  if (!scheduledAt) {
    return { scheduled: false, reason: "The recipient has no valid time zone (held for review)." };
  }

  return prisma.$transaction(async (tx: TxLike) => {
    // One follow-up message per (sequence, step, contact, campaign).
    const existing = await tx.followUpMessage.findFirst({
      where: { stepId: step.id, contactId: contact.id, campaignId: campaign.id },
      select: { id: true },
    });
    if (existing) return { scheduled: false, reason: "Already scheduled.", messageId: existing.id };

    const message = await tx.followUpMessage.create({
      data: {
        userId,
        sequenceId: sequence.id,
        stepId: step.id,
        campaignId: campaign.id,
        contactId: contact.id,
        scheduledAt,
        status: "SCHEDULED",
      },
    });

    // The follow-up needs its own job. A CampaignRecipient is 1:1 with the
    // first message, so a follow-up cannot reuse it — it gets a job that
    // points at the follow-up message instead of a recipient.
    const job = await enqueueFollowUpJob(tx, {
      followUpMessageId: message.id,
      campaignId: campaign.id,
      contactId: contact.id,
      userId,
      scheduledAt,
      subject: step.subject,
      body: step.body,
    });

    return { scheduled: true, messageId: message.id, jobId: job.id };
  });
}

/**
 * After a message was accepted, schedule the following step (if any).
 * Safe to call on every successful send: it only ever schedules the NEXT
 * step, and it is idempotent per (step, contact, campaign).
 */
export async function advanceFollowUp(input: {
  userId: string;
  campaign: Campaign & { followUpSequenceId: string | null };
  contact: Contact;
  sentAt: Date;
  minDaysBetweenContacts: number;
}): Promise<void> {
  const { userId, campaign, contact, sentAt, minDaysBetweenContacts } = input;
  if (!campaign.followUpSequenceId) return;

  const sequence = await prisma.followUpSequence.findUnique({
    where: { id: campaign.followUpSequenceId },
    include: { steps: { orderBy: { order: "asc" } } },
  });
  if (!sequence || !sequence.isActive || sequence.steps.length === 0) return;

  // Which step comes next? The first step that has no message for this
  // contact yet.
  const sent = await prisma.followUpMessage.findMany({
    where: { contactId: contact.id, campaignId: campaign.id },
    select: { stepId: true },
  });
  const sentStepIds = new Set(sent.map((s) => s.stepId));
  const next = sequence.steps.find((s) => !sentStepIds.has(s.id));
  if (!next) return; // the sequence is finished for this contact

  await scheduleNextFollowUp({
    userId,
    campaign,
    contact,
    sequence,
    step: next,
    from: sentAt,
    minDaysBetweenContacts,
  });
}

/**
 * Cancel every pending follow-up for a contact.
 * Called when a reply arrives, the contact unsubscribes, bounces, complains
 * or is manually suppressed.
 */
export async function cancelFollowUpsForContact(
  contactId: string,
  reason: string,
  tx?: TxLike,
): Promise<number> {
  const db = tx ?? prisma;
  const cancelled = await db.followUpMessage.updateMany({
    where: { contactId, status: "SCHEDULED" },
    data: { status: "CANCELLED", cancelReason: reason },
  });
  if (cancelled.count > 0) {
    // The queued jobs must go too, otherwise the worker would still send them.
    await db.sendJob.updateMany({
      where: {
        contactId,
        status: "QUEUED",
        followUpMessageId: { not: null },
      },
      data: { status: "CANCELLED" },
    });
  }
  return cancelled.count;
}

/**
 * Cancel every pending follow-up of a campaign (pause / cancel / archive).
 */
export async function cancelFollowUpsForCampaign(campaignId: string, reason: string): Promise<number> {
  return prisma.$transaction(async (tx: TxLike) => {
    const cancelled = await tx.followUpMessage.updateMany({
      where: { campaignId, status: "SCHEDULED" },
      data: { status: "CANCELLED", cancelReason: reason },
    });
    await tx.sendJob.updateMany({
      where: { campaignId, status: "QUEUED", followUpMessageId: { not: null } },
      data: { status: "CANCELLED" },
    });
    return cancelled.count;
  });
}

/**
 * Cancel pending follow-ups for a contact across every campaign of the
 * workspace (used by the unsubscribe endpoint and the suppression list).
 */
export async function cancelFollowUpsForContactEverywhere(contactId: string, reason: string): Promise<number> {
  const cancelled = await prisma.followUpMessage.updateMany({
    where: { contactId, status: "SCHEDULED" },
    data: { status: "CANCELLED", cancelReason: reason },
  });
  if (cancelled.count > 0) {
    await prisma.sendJob.updateMany({
      where: { contactId, status: "QUEUED", followUpMessageId: { not: null } },
      data: { status: "CANCELLED" },
    });
  }
  return cancelled.count;
}
