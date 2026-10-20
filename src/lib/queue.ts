import type { Campaign, CampaignRecipient, Contact, SendJob, SenderAccount } from "@prisma/client";
import { dbRetry, prisma, type TxLike } from "./db";
import { env } from "./env";

/**
 * PostgreSQL-backed job queue with atomic claiming.
 *
 * Guarantees:
 *  - One logical job per campaign recipient:
 *      SendJob.campaignRecipientId is UNIQUE and idempotencyKey is
 *      deterministic ("job:<campaignRecipientId>"), so repeated enqueues and
 *      retried API calls can never create a second job.
 *  - Concurrent workers never claim the same job:
 *      claiming is a single UPDATE ... WHERE id IN (SELECT ... FOR UPDATE
 *      SKIP LOCKED), which is atomic in PostgreSQL.
 *  - Crash recovery: claims carry a lease; expired leases are reclaimed.
 *  - Ambiguity safety: a crash/timeout after the provider submit leaves the
 *    newest SendAttempt unfinished or AMBIGUOUS; such jobs are moved to
 *      AMBIGUOUS and must be reconciled before any retry.
 */

export type ClaimedJob = SendJob & {
  campaign: Campaign;
  contact: Contact;
  campaignRecipient: CampaignRecipient;
  senderAccount: SenderAccount | null;
};

export function jobIdempotencyKey(campaignRecipientId: string): string {
  return `job:${campaignRecipientId}`;
}

/**
 * Enqueue (or keep) the single job for a campaign recipient.
 * Safe to call repeatedly — the unique constraints do the deduplication.
 */
export async function enqueueJob(
  tx: TxLike,
  input: { campaignRecipientId: string; campaignId: string; contactId: string; userId: string; scheduledAt: Date },
): Promise<SendJob> {
  const job = await tx.sendJob.upsert({
    where: { campaignRecipientId: input.campaignRecipientId },
    create: {
      campaignRecipientId: input.campaignRecipientId,
      campaignId: input.campaignId,
      contactId: input.contactId,
      userId: input.userId,
      status: "QUEUED",
      scheduledAt: input.scheduledAt,
      maxAttempts: env.workerMaxAttempts,
      idempotencyKey: jobIdempotencyKey(input.campaignRecipientId),
    },
    // Never reset an in-flight/terminal job; only future scheduling updates.
    update: {},
  });
  return job;
}

/**
 * Atomically claim up to `limit` due jobs for this worker.
 * Uses FOR UPDATE SKIP LOCKED so parallel workers claim disjoint sets.
 */
export async function claimDueJobs(workerId: string, limit = env.workerBatchSize, leaseSeconds = env.workerLeaseSeconds): Promise<ClaimedJob[]> {
  // The claim is a single atomic UPDATE ... FOR UPDATE SKIP LOCKED, so a
  // retry after a transient connection failure can never double-claim: the
  // statement only matches rows that are still QUEUED.
  const claimed = await dbRetry(() =>
    prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE "SendJob" AS j
      SET "status" = 'CLAIMED',
          "claimedAt" = now(),
          "claimedBy" = ${workerId},
          "leaseExpiresAt" = now() + make_interval(secs => ${leaseSeconds}),
          "updatedAt" = now()
      WHERE j.id IN (
        SELECT id FROM "SendJob"
        WHERE "status" = 'QUEUED' AND "scheduledAt" <= now()
        ORDER BY "scheduledAt" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING j.id`,
  );

  if (claimed.length === 0) return [];

  const ids = claimed.map((c) => c.id);
  return prisma.sendJob.findMany({
    where: { id: { in: ids } },
    include: {
      campaign: true,
      contact: true,
      campaignRecipient: true,
      senderAccount: true,
    },
  }) as unknown as Promise<ClaimedJob[]>;
}

/**
 * Extend the lease of a job currently being processed (long provider calls).
 */
export async function heartbeatJob(jobId: string, leaseSeconds = env.workerLeaseSeconds): Promise<void> {
  await dbRetry(() =>
    prisma.$executeRaw`
      UPDATE "SendJob"
      SET "leaseExpiresAt" = now() + make_interval(secs => ${leaseSeconds}), "updatedAt" = now()
      WHERE "id" = ${jobId} AND "status" = 'CLAIMED'`,
  );
}

/**
 * Recover jobs abandoned by crashed workers.
 * - Finished attempts (outcome recorded)   -> requeue (safe to retry).
 * - Unfinished/ambiguous attempts          -> AMBIGUOUS (must be reconciled).
 * Returns counts for observability.
 */
export async function reclaimAbandonedJobs(): Promise<{ requeued: number; ambiguous: number }> {
  const abandoned = await dbRetry(() =>
    prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE "SendJob"
      SET "status" = 'QUEUED',
          "claimedBy" = NULL,
          "leaseExpiresAt" = NULL,
          "updatedAt" = now()
      WHERE "status" = 'CLAIMED'
        AND "leaseExpiresAt" IS NOT NULL
        AND "leaseExpiresAt" < now()
        AND "id" NOT IN (
          SELECT "jobId" FROM "SendAttempt"
          WHERE "finishedAt" IS NULL OR "status" = 'AMBIGUOUS'
        )
      RETURNING "id"`,
  );

  // Crashed mid-provider-call (or timed out): hold for reconciliation.
  const ambiguous = await dbRetry(() =>
    prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE "SendJob" AS j
      SET "status" = 'AMBIGUOUS',
          "ambiguousSince" = COALESCE(j."ambiguousSince", now()),
          "claimedBy" = NULL,
          "leaseExpiresAt" = NULL,
          "updatedAt" = now()
      WHERE j."status" = 'CLAIMED'
        AND j."leaseExpiresAt" IS NOT NULL
        AND j."leaseExpiresAt" < now()
        AND j."id" IN (
          SELECT "jobId" FROM "SendAttempt"
          WHERE "finishedAt" IS NULL OR "status" = 'AMBIGUOUS'
        )
      RETURNING j."id"`,
  );

  // Also catch jobs already marked AMBIGUOUS with an unfinished attempt row.
  await dbRetry(() =>
    prisma.$executeRaw`
      UPDATE "SendAttempt"
      SET "finishedAt" = now(),
          "reconciliationNote" = COALESCE("reconciliationNote", 'marked ambiguous by reclaimer')
      WHERE "finishedAt" IS NULL
        AND "jobId" IN (SELECT "id" FROM "SendJob" WHERE "status" = 'AMBIGUOUS')`,
  );

  return { requeued: abandoned.length, ambiguous: ambiguous.length };
}

/**
 * List AMBIGUOUS jobs for reconciliation (oldest first).
 */
export async function listAmbiguousJobs(limit = 50): Promise<ClaimedJob[]> {
  return prisma.sendJob.findMany({
    where: { status: "AMBIGUOUS" },
    orderBy: { ambiguousSince: "asc" },
    take: limit,
    include: {
      campaign: true,
      contact: true,
      campaignRecipient: true,
      senderAccount: true,
    },
  }) as unknown as Promise<ClaimedJob[]>;
}

/**
 * Reschedule a queued job (e.g. campaign window changed, or the recipient is
 * currently outside their local window). Only touches QUEUED jobs — a claimed
 * or terminal job is never moved.
 */
export async function rescheduleJob(jobId: string, scheduledAt: Date): Promise<boolean> {
  const updated = await prisma.sendJob.updateMany({
    where: { id: jobId, status: "QUEUED" },
    data: { scheduledAt },
  });
  return updated.count > 0;
}

/**
 * Cancel every queued job of a campaign (emergency stop / cancel).
 */
export async function cancelCampaignJobs(campaignId: string): Promise<number> {
  const res = await prisma.sendJob.updateMany({
    where: { campaignId, status: { in: ["QUEUED"] } },
    data: { status: "CANCELLED", updatedAt: new Date() },
  });
  return res.count;
}

export async function queueDepth(userId?: string): Promise<Record<string, number>> {
  const group = await prisma.sendJob.groupBy({
    by: ["status"],
    _count: { _all: true },
    ...(userId ? { where: { userId } } : {}),
  });
  return Object.fromEntries(group.map((g) => [g.status, g._count._all]));
}
