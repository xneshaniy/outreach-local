import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { claimDueJobs } from "@/lib/queue";
import { processJob } from "@/worker/processJob";
import { isDryRunMessageId } from "@/lib/email/dry-run";
import { createAlwaysOnCampaign, createScheduledRecipient } from "./helpers";
import {
  createTestContact,
  createTestUser,
  dbEnabled,
  preflight,
  resetDatabase,
} from "./helpers";

/**
 * Dry-run mode: the whole pipeline runs, but nothing is handed to a provider.
 *
 * This is the safety net for a fresh installation — a campaign can be started,
 * scheduled, quota-reserved and marked as delivered without a single email
 * leaving the machine.
 */
describe.runIf(dbEnabled)("dry-run mode", () => {
  beforeAll(preflight);
  beforeEach(resetDatabase);

  it("marks the job and the recipient as sent without contacting a provider", async () => {
    const user = await createTestUser();
    const campaign = await createAlwaysOnCampaign(user.id);
    const contact = await createTestContact(user.id, "dry@example.test", "Europe/London");
    await prisma.campaign.update({ where: { id: campaign.id }, data: { dryRun: true } });

    await createScheduledRecipient({
      campaignId: campaign.id,
      userId: user.id,
      contactId: contact.id,
      scheduledAt: new Date(),
    });

    const jobs = await claimDueJobs("worker-dry", 10, 120);
    expect(jobs.length).toBe(1);

    await processJob(jobs[0]!);

    const job = await prisma.sendJob.findUniqueOrThrow({ where: { id: jobs[0]!.id } });
    expect(job.status).toBe("SENT");
    expect(job.dryRun).toBe(true);
    // The provider message id is clearly a dry-run marker, never a real id.
    expect(isDryRunMessageId(job.providerMessageId)).toBe(true);

    const recipient = await prisma.campaignRecipient.findFirstOrThrow({
      where: { campaignId: campaign.id },
    });
    expect(recipient.status).toBe("SENT");

    const attempt = await prisma.sendAttempt.findFirstOrThrow({ where: { jobId: job.id } });
    expect(attempt.status).toBe("SUCCESS");
  });

  it("does not consume the sender's daily quota", async () => {
    const user = await createTestUser();
    const campaign = await createAlwaysOnCampaign(user.id);
    const contact = await createTestContact(user.id, "quota@example.test", "Europe/London");
    await prisma.campaign.update({ where: { id: campaign.id }, data: { dryRun: true } });

    await createScheduledRecipient({
      campaignId: campaign.id,
      userId: user.id,
      contactId: contact.id,
      scheduledAt: new Date(),
    });

    const jobs = await claimDueJobs("worker-dry-quota", 10, 120);
    await processJob(jobs[0]!);

    // No sender account exists in this test, so nothing could be reserved —
    // and the dry run must not have failed because of that.
    const usage = await prisma.senderDailyUsage.count();
    expect(usage).toBe(0);
  });

  it("does not schedule follow-ups during a dry run", async () => {
    const user = await createTestUser();
    const campaign = await createAlwaysOnCampaign(user.id);
    const contact = await createTestContact(user.id, "nofollowup@example.test", "Europe/London");
    const sequence = await prisma.followUpSequence.create({
      data: {
        userId: user.id,
        name: "Bump",
        steps: { create: [{ order: 1, delayDays: 1, subject: "Bump", body: "<p>Hi</p>" }] },
      },
    });
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { dryRun: true, followUpSequenceId: sequence.id },
    });

    await createScheduledRecipient({
      campaignId: campaign.id,
      userId: user.id,
      contactId: contact.id,
      scheduledAt: new Date(),
    });

    const jobs = await claimDueJobs("worker-dry-followup", 10, 120);
    await processJob(jobs[0]!);

    expect(await prisma.followUpMessage.count({ where: { contactId: contact.id } })).toBe(0);
  });
});
