import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { claimDueJobs, listAmbiguousJobs, reclaimAbandonedJobs, rescheduleJob, cancelCampaignJobs } from "@/lib/queue";
import {
  createScheduledRecipient,
  createTestCampaign,
  createTestContact,
  createTestUser,
  dbEnabled,
  preflight,
  resetDatabase,
} from "./helpers";

/**
 * Queue guarantees (spec §8): atomic claiming with FOR UPDATE SKIP LOCKED,
 * lease-based crash recovery, and AMBIGUOUS handling that never blind-retries.
 */
describe.runIf(dbEnabled)("queue claiming, recovery and ambiguity", () => {
  beforeAll(preflight);
  beforeEach(resetDatabase);

  // The jobs are scheduled well in the past so the database's clock can never
  // make them "not due yet" (the app and the database may be a few seconds
  // apart, and the suite runs against a remote database over a network).
  async function makeDueJobs(count: number, scheduledAt = new Date(Date.now() - 5 * 60_000)) {
    const user = await createTestUser();
    const campaign = await createTestCampaign(user.id, { status: "ACTIVE" });
    const jobs = [];
    for (let i = 0; i < count; i++) {
      const contact = await createTestContact(user.id, undefined, "UTC");
      const { job } = await createScheduledRecipient({
        campaignId: campaign.id,
        userId: user.id,
        contactId: contact.id,
        scheduledAt,
      });
      jobs.push(job);
    }
    return { user, campaign, jobs };
  }

  it("two concurrent workers claim disjoint due jobs", async () => {
    const { jobs } = await makeDueJobs(6);

    const [a, b] = await Promise.all([claimDueJobs("worker-1", 3), claimDueJobs("worker-2", 3)]);

    const ids = [...a, ...b].map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length); // never claimed twice
    expect(ids.length).toBe(6); // both workers got their full batch

    const rows = await prisma.sendJob.findMany({ where: { id: { in: jobs.map((j) => j.id) } } });
    expect(rows.every((r) => r.status === "CLAIMED")).toBe(true);
    expect(rows.every((r) => r.claimedBy === "worker-1" || r.claimedBy === "worker-2")).toBe(true);
    expect(rows.every((r) => r.leaseExpiresAt !== null && r.leaseExpiresAt > new Date())).toBe(true);

    // Nothing is claimable any more.
    const third = await claimDueJobs("worker-3", 10);
    expect(third).toHaveLength(0);
  });

  it("never claims a job that is not due yet", async () => {
    const future = new Date(Date.now() + 60 * 60_000);
    await makeDueJobs(2, future);
    expect(await claimDueJobs("worker-1", 10)).toHaveLength(0);
    expect(await prisma.sendJob.count({ where: { status: "QUEUED" } })).toBe(2);
  });

  it("reclaims a lease abandoned by a worker that crashed before submitting", async () => {
    const { jobs } = await makeDueJobs(1);
    const claimed = await claimDueJobs("worker-crash", 1);
    expect(claimed).toHaveLength(1);

    // Simulate: worker died, lease expired, no provider attempt was started.
    await prisma.sendJob.update({
      where: { id: jobs[0]!.id },
      data: { leaseExpiresAt: new Date(Date.now() - 60_000) },
    });

    const result = await reclaimAbandonedJobs();
    expect(result.requeued).toBe(1);
    expect(result.ambiguous).toBe(0);

    const job = await prisma.sendJob.findUnique({ where: { id: jobs[0]!.id } });
    expect(job?.status).toBe("QUEUED");
    expect(job?.claimedBy).toBeNull();

    // ... and it is safe to claim again (nothing reached the provider).
    const again = await claimDueJobs("worker-2", 1);
    expect(again.map((j) => j.id)).toContain(jobs[0]!.id);
  });

  it("moves a crashed mid-send job to AMBIGUOUS and never re-queues it", async () => {
    const { jobs } = await makeDueJobs(1);
    await claimDueJobs("worker-crash", 1);

    // An attempt row with no outcome = the provider call may have succeeded.
    await prisma.sendAttempt.create({
      data: {
        jobId: jobs[0]!.id,
        attemptNumber: 1,
        status: "AMBIGUOUS",
        idempotencyHeader: `v1:${jobs[0]!.id}:1`,
        startedAt: new Date(Date.now() - 120_000),
      },
    });
    await prisma.sendJob.update({
      where: { id: jobs[0]!.id },
      data: { leaseExpiresAt: new Date(Date.now() - 60_000) },
    });

    const result = await reclaimAbandonedJobs();
    expect(result.requeued).toBe(0);
    expect(result.ambiguous).toBe(1);

    const job = await prisma.sendJob.findUnique({ where: { id: jobs[0]!.id } });
    expect(job?.status).toBe("AMBIGUOUS");
    expect(job?.ambiguousSince).not.toBeNull();
    expect(job?.claimedBy).toBeNull();

    // The unfinished attempt is closed out for the audit trail.
    const attempt = await prisma.sendAttempt.findFirst({ where: { jobId: jobs[0]!.id } });
    expect(attempt?.finishedAt).not.toBeNull();

    // Never blind-retried: claiming must skip AMBIGUOUS jobs entirely.
    expect(await claimDueJobs("worker-2", 10)).toHaveLength(0);
    const ambiguous = await listAmbiguousJobs();
    expect(ambiguous.map((j) => j.id)).toContain(jobs[0]!.id);
  });

  it("enforces one attempt row per (job, attemptNumber)", async () => {
    const { jobs } = await makeDueJobs(1);
    const data = { jobId: jobs[0]!.id, attemptNumber: 1, status: "TRANSIENT_FAILURE" as const };
    await prisma.sendAttempt.create({ data });
    await expect(prisma.sendAttempt.create({ data })).rejects.toMatchObject({ code: "P2002" });
  });

  it("only reschedules QUEUED jobs (a claimed job is never moved)", async () => {
    const { jobs } = await makeDueJobs(1);
    const claimed = await claimDueJobs("worker-1", 1);
    expect(claimed).toHaveLength(1);

    const original = claimed[0]!.scheduledAt;
    const moved = await rescheduleJob(jobs[0]!.id, new Date(Date.now() + 3 * 3600_000));
    expect(moved).toBe(false);
    const job = await prisma.sendJob.findUnique({ where: { id: jobs[0]!.id } });
    expect(job?.scheduledAt).toEqual(original);

    // A queued job IS movable.
    await prisma.sendJob.update({ where: { id: jobs[0]!.id }, data: { status: "QUEUED" } });
    const target = new Date(Date.now() + 3 * 3600_000);
    expect(await rescheduleJob(jobs[0]!.id, target)).toBe(true);
  });

  it("cancels only queued jobs (emergency stop leaves in-flight work alone)", async () => {
    const { campaign, jobs } = await makeDueJobs(2);
    await claimDueJobs("worker-1", 1); // one of them is now CLAIMED

    const cancelled = await cancelCampaignJobs(campaign.id);
    expect(cancelled).toBe(1);

    const rows = await prisma.sendJob.findMany({ where: { id: { in: jobs.map((j) => j.id) } } });
    const byStatus = rows.map((r) => r.status).sort();
    expect(byStatus).toEqual(["CANCELLED", "CLAIMED"]);
  });
});
