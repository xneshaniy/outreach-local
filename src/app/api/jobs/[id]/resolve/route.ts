import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { requireUser } from "@/lib/auth/guards";
import { ApiError } from "@/lib/errors";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { releaseSenderSlot, rollbackCampaignSlot, quotaDayKey } from "@/lib/quota";
import { env } from "@/lib/env";

/**
 * POST /api/jobs/:id/resolve
 * Manual resolution of an AMBIGUOUS job by an operator.
 *   decision: "sent"      — operator confirmed the email exists at the provider
 *             "not_sent"  — operator confirmed it never went out (requeues)
 *             "drop"      — abandon the job (marks recipient FAILED)
 * Quota accounting is settled accordingly.
 */
type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  decision: z.enum(["sent", "not_sent", "drop"]),
  note: z.string().max(500).optional(),
});

export const POST = handleApi(async (req: NextRequest, ctx: Ctx) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await ctx.params;
  const body = bodySchema.parse(await req.json());

  const job = await prisma.sendJob.findFirst({
    where: { id, userId: user.id },
    include: { senderAccount: true },
  });
  if (!job) throw ApiError.notFound("Job not found.");
  if (job.status !== "AMBIGUOUS") {
    throw ApiError.badRequest(`Only ambiguous jobs can be resolved (current: ${job.status}).`);
  }

  const quotaDay = quotaDayKey(new Date(), env.senderQuotaTimezone);
  const latestAttempt = await prisma.sendAttempt.findFirst({
    where: { jobId: job.id },
    orderBy: { attemptNumber: "desc" },
  });

  await prisma.$transaction(async (tx) => {
    if (body.decision === "sent") {
      if (job.senderAccount) await settleIfHeld(tx, job.senderAccount.id, quotaDay);
      if (latestAttempt) {
        await tx.sendAttempt.update({
          where: { id: latestAttempt.id },
          data: { status: "SUCCESS", reconciliationNote: body.note ?? "manually confirmed sent", finishedAt: new Date() },
        });
      }
      await tx.sendJob.update({ where: { id: job.id }, data: { status: "SENT", ambiguousSince: null } });
      await tx.campaignRecipient.update({
        where: { id: job.campaignRecipientId },
        data: { status: "SENT", sentAt: new Date() },
      });
      await tx.contact.update({
        where: { id: job.contactId },
        data: { lastSentAt: new Date(), sentCount: { increment: 1 } },
      });
    } else {
      if (job.senderAccount) {
        await releaseSenderSlot(tx, job.senderAccount.id, quotaDay, body.decision === "drop");
      }
      await rollbackCampaignSlot(tx, job.campaignId, quotaDay);
      if (latestAttempt) {
        await tx.sendAttempt.update({
          where: { id: latestAttempt.id },
          data: {
            status: body.decision === "drop" ? "PERMANENT_FAILURE" : "TRANSIENT_FAILURE",
            reconciliationNote: body.note ?? `manually resolved: ${body.decision}`,
            finishedAt: new Date(),
          },
        });
      }
      if (body.decision === "drop") {
        await tx.sendJob.update({ where: { id: job.id }, data: { status: "FAILED", ambiguousSince: null } });
        await tx.campaignRecipient.update({
          where: { id: job.campaignRecipientId },
          data: { status: "FAILED", failedAt: new Date(), lastError: body.note ?? "Dropped after ambiguous outcome." },
        });
      } else {
        await tx.sendJob.update({
          where: { id: job.id },
          data: { status: "QUEUED", ambiguousSince: null, scheduledAt: new Date(Date.now() + 60_000) },
        });
      }
    }
  });

  await audit(prisma, {
    userId: user.id,
    action: "job.resolve_ambiguous",
    entityType: "SendJob",
    entityId: job.id,
    metadata: { decision: body.decision, note: body.note },
  });

  return json({ ok: true, decision: body.decision });
});

async function settleIfHeld(tx: import("@/lib/db").TxLike, senderAccountId: string, day: Date) {
  // The slot was held during AMBIGUOUS; convert it into a real send.
  const { settleSenderSlot } = await import("@/lib/quota");
  await settleSenderSlot(tx, senderAccountId, day);
}
