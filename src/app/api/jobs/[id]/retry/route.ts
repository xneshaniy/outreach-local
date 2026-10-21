import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { requireUser } from "@/lib/auth/guards";
import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/errors";

/**
 * POST /api/jobs/:id/retry — put a dead-lettered job back in the queue.
 *
 * This is a MANUAL action, never automatic. A job whose outcome is uncertain
 * (AMBIGUOUS) is deliberately NOT retryable here: retrying it could send the
 * same message twice. Only a job that definitively failed can be retried.
 */
type Ctx = { params: Promise<{ id: string }> };

export const POST = handleApi(async (req: NextRequest, ctx: Ctx) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await ctx.params;

  const job = await prisma.sendJob.findFirst({
    where: { id, userId: user.id },
    select: {
      id: true,
      status: true,
      attempts: true,
      maxAttempts: true,
      deadLetteredAt: true,
      ambiguousSince: true,
      kind: true,
      contact: { select: { id: true, email: true, status: true } },
    },
  });
  if (!job) throw ApiError.notFound("Job not found.");

  if (job.status === "AMBIGUOUS" || job.ambiguousSince) {
    throw ApiError.badRequest(
      "This message has an uncertain outcome and must be reconciled, not retried.",
      { hint: "Use the queue page to resolve it manually - retrying could send it twice." },
    );
  }
  if (job.status !== "FAILED" && !job.deadLetteredAt) {
    throw ApiError.badRequest(`Only a failed job can be retried (current: ${job.status}).`);
  }
  if (job.contact.status !== "ACTIVE") {
    throw ApiError.badRequest(`The contact is ${job.contact.status} - they must not be contacted.`);
  }
  if (job.attempts >= job.maxAttempts) {
    throw ApiError.badRequest(
      `The job already used all ${job.maxAttempts} attempts. Raise the limit or fix the cause first.`,
    );
  }

  const updated = await prisma.sendJob.update({
    where: { id: job.id },
    data: {
      status: "QUEUED",
      claimedBy: null,
      claimedAt: null,
      leaseExpiresAt: null,
      deadLetteredAt: null,
      lastError: null,
      errorCode: null,
      scheduledAt: new Date(),
    },
    select: { id: true, status: true, scheduledAt: true },
  });

  await audit(prisma, {
    userId: user.id,
    action: "job.retry",
    entityType: "SendJob",
    entityId: job.id,
    metadata: { previousStatus: job.status },
  });

  return json({ job: updated });
});
