import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ParsedContactRow } from "@/lib/csv";
import { prisma } from "@/lib/db";
import { addContactsToCampaign } from "@/lib/campaign";
import { enqueueJob, jobIdempotencyKey } from "@/lib/queue";
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
 * Spec §5: duplicate prevention must be enforced by the DATABASE, not by
 * application logic — so retries, concurrent requests and re-imports can never
 * create a second copy of the same row.
 */
describe.runIf(dbEnabled)("database-enforced duplicate prevention", () => {
  beforeAll(preflight);
  beforeEach(resetDatabase);

  it("rejects a second contact with the same normalized email (UNIQUE userId+emailNormalized)", async () => {
    const user = await createTestUser();
    await createTestContact(user.id, "Ada@Example.com");

    // Case/whitespace variants normalize to the same address -> constraint hit.
    await expect(
      prisma.contact.create({
        data: { userId: user.id, email: "  ADA@EXAMPLE.COM", emailNormalized: "ada@example.com" },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("lets a different workspace store the same address (uniqueness is per user)", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    await createTestContact(a.id, "ada@example.com");
    await expect(createTestContact(b.id, "ada@example.com")).resolves.toMatchObject({
      emailNormalized: "ada@example.com",
    });
  });

  it("createMany(skipDuplicates) makes re-imports harmless", async () => {
    const user = await createTestUser();
    const rows = [
      { email: "one@example.test", emailNormalized: "one@example.test" },
      { email: "two@example.test", emailNormalized: "two@example.test" },
    ];
    const first = await prisma.contact.createMany({ data: rows.map((r) => ({ ...r, userId: user.id })), skipDuplicates: true });
    const second = await prisma.contact.createMany({ data: rows.map((r) => ({ ...r, userId: user.id })), skipDuplicates: true });
    expect(first.count).toBe(2);
    expect(second.count).toBe(0);
    expect(await prisma.contact.count({ where: { userId: user.id } })).toBe(2);
  });

  it("adds a contact to a campaign exactly once, even when imported twice", async () => {
    const user = await createTestUser();
    const campaign = await createTestCampaign(user.id);
    const rows: ParsedContactRow[] = [
      { email: "ada@example.test", emailNormalized: "ada@example.test", firstName: "Ada", timeZone: "Europe/London" },
    ];

    const first = await addContactsToCampaign(campaign, rows);
    const second = await addContactsToCampaign(campaign, rows);

    expect(first.added).toBe(1);
    expect(second.added).toBe(0);
    expect(second.duplicates).toBe(1);
    expect(await prisma.campaignRecipient.count({ where: { campaignId: campaign.id } })).toBe(1);
    expect(await prisma.sendJob.count({ where: { campaignId: campaign.id } })).toBe(1);
  });

  it("concurrent duplicate imports still create exactly one recipient and one job", async () => {
    const user = await createTestUser();
    const campaign = await createTestCampaign(user.id);
    const rows: ParsedContactRow[] = [
      { email: "ada@example.test", emailNormalized: "ada@example.test", timeZone: "UTC" },
    ];

    const [a, b] = await Promise.all([
      addContactsToCampaign(campaign, rows),
      addContactsToCampaign(campaign, rows),
    ]);

    expect(a.added + b.added).toBe(1);
    expect(await prisma.campaignRecipient.count({ where: { campaignId: campaign.id } })).toBe(1);
    expect(await prisma.sendJob.count({ where: { campaignId: campaign.id } })).toBe(1);
  });

  it("uses one deterministic idempotency key per campaign recipient", async () => {
    const user = await createTestUser();
    const campaign = await createTestCampaign(user.id);
    const contact = await createTestContact(user.id);
    const { recipient } = await createScheduledRecipient({
      campaignId: campaign.id,
      userId: user.id,
      contactId: contact.id,
    });

    // Two separate (retried) enqueue calls -> still one job row.
    await prisma.$transaction((tx) =>
      enqueueJob(tx, {
        campaignRecipientId: recipient.id,
        campaignId: campaign.id,
        contactId: contact.id,
        userId: user.id,
        scheduledAt: new Date(),
      }),
    );
    await prisma.$transaction((tx) =>
      enqueueJob(tx, {
        campaignRecipientId: recipient.id,
        campaignId: campaign.id,
        contactId: contact.id,
        userId: user.id,
        scheduledAt: new Date(),
      }),
    );

    const jobs = await prisma.sendJob.findMany({ where: { campaignRecipientId: recipient.id } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.idempotencyKey).toBe(`job:${recipient.id}`);
    expect(jobIdempotencyKey(recipient.id)).toBe(`job:${recipient.id}`);

    // And the key itself is UNIQUE in the schema: a forced duplicate fails.
    await expect(
      prisma.sendJob.create({
        data: {
          campaignRecipientId: `forced-dup-${recipient.id}`,
          campaignId: campaign.id,
          contactId: contact.id,
          userId: user.id,
          scheduledAt: new Date(),
          idempotencyKey: jobs[0]!.idempotencyKey,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("HOLDs recipients with unknown time zones instead of scheduling them", async () => {
    const user = await createTestUser();
    const campaign = await createTestCampaign(user.id); // default timeZoneFallback = HOLD
    const rows: ParsedContactRow[] = [
      { email: "notz@example.test", emailNormalized: "notz@example.test", timeZone: null },
      { email: "oktz@example.test", emailNormalized: "oktz@example.test", timeZone: "America/New_York" },
    ];

    const result = await addContactsToCampaign(campaign, rows);
    expect(result.heldForTimezone).toBe(1);
    expect(result.added).toBe(2);

    const held = await prisma.campaignRecipient.findFirst({
      where: { campaignId: campaign.id, status: "HELD_TZ" },
      include: { contact: true },
    });
    expect(held?.contact.email).toBe("notz@example.test");
    expect(held?.scheduledAt).toBeNull();
    expect(held?.skipReason).toBe("UNKNOWN_TIMEZONE");

    // A held recipient never gets a job.
    const jobs = await prisma.sendJob.findMany({ where: { campaignId: campaign.id }, include: { contact: true } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.contact.email).toBe("oktz@example.test");
  });
});
