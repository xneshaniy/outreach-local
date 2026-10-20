import { randomUUID } from "crypto";
import "dotenv/config";
import { prisma } from "../lib/db";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { claimDueJobs, listAmbiguousJobs, reclaimAbandonedJobs } from "../lib/queue";
import { processJob, reconcileAmbiguousJob } from "./processJob";

/**
 * Persistent background worker.
 *
 * Loop:
 *   1. Recover jobs abandoned by crashed workers (lease expiry).
 *   2. Claim due jobs atomically (FOR UPDATE SKIP LOCKED) and process them.
 *   3. Reconcile AMBIGUOUS jobs (never blindly retried).
 *
 * Run with: npm run worker   (deploy as its own service, see docs/DEPLOYMENT.md)
 */

const workerId = `${process.env.HOSTNAME ?? "worker"}-${randomUUID().slice(0, 8)}`;

let running = true;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tick(): Promise<void> {
  // 1. Crash recovery
  const reclaimed = await reclaimAbandonedJobs();
  if (reclaimed.requeued || reclaimed.ambiguous) {
    logger.info("Reclaimed abandoned jobs", reclaimed);
  }

  // 2. Process due jobs
  const jobs = await claimDueJobs(workerId);
  for (const job of jobs) {
    try {
      await processJob(job);
    } catch (err) {
      logger.error("Unhandled error while processing job", {
        jobId: job.id,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      // Release the claim so the job is not stuck; the attempt row (if any)
      // will mark it ambiguous if a provider call was in flight.
      try {
        await prisma.sendJob.updateMany({
          where: { id: job.id, status: "CLAIMED", claimedBy: workerId },
          data: { status: "QUEUED", claimedBy: null, leaseExpiresAt: null },
        });
      } catch {
        /* job may already be terminal */
      }
    }
  }

  // 3. Reconciliation of ambiguous outcomes (bounded per cycle)
  const ambiguous = await listAmbiguousJobs(5);
  for (const job of ambiguous) {
    try {
      const result = await reconcileAmbiguousJob(job);
      if (result === "manual") {
        logger.warn("Ambiguous job needs manual review", { jobId: job.id });
      }
    } catch (err) {
      logger.error("Reconciliation failed", { jobId: job.id, error: (err as Error).message });
    }
  }
}

async function main() {
  logger.info("Worker started", {
    workerId,
    pollIntervalMs: env.workerPollIntervalMs,
    batchSize: env.workerBatchSize,
    leaseSeconds: env.workerLeaseSeconds,
  });

  const shutdown = (signal: string) => {
    logger.info("Worker shutting down", { signal });
    running = false;
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  while (running) {
    const startedAt = Date.now();
    try {
      await tick();
    } catch (err) {
      logger.error("Worker tick failed", { error: err instanceof Error ? err.message : String(err) });
    }
    const elapsed = Date.now() - startedAt;
    const wait = Math.max(250, env.workerPollIntervalMs - elapsed);
    if (running) await sleep(wait);
  }

  await prisma.$disconnect();
  logger.info("Worker stopped", { workerId });
}

main().catch((err) => {
  logger.error("Worker crashed", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
