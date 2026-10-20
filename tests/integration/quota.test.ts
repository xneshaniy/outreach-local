import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import {
  QuotaExceededError,
  quotaDayKey,
  releaseSenderSlot,
  reserveCampaignSlot,
  reserveSenderSlot,
  rollbackCampaignSlot,
  settleSenderSlot,
} from "@/lib/quota";
import {
  createSenderAccount,
  createTestCampaign,
  createTestUser,
  dbEnabled,
  preflight,
  resetDatabase,
} from "./helpers";

/**
 * Spec §7: quota accounting must be transactional. Reservations take a row
 * lock, so concurrent workers can never push a sender past its daily cap.
 */
describe.runIf(dbEnabled)("transactional quota enforcement", () => {
  beforeAll(preflight);
  beforeEach(resetDatabase);

  const day = quotaDayKey(new Date());

  it("never lets concurrent reservations exceed the cap", async () => {
    const user = await createTestUser();
    const account = await createSenderAccount(user.id, { dailyCap: 5 });

    const attempts = await Promise.allSettled(
      Array.from({ length: 20 }, () => prisma.$transaction((tx) => reserveSenderSlot(tx, account.id, 5, day))),
    );

    const fulfilled = attempts.filter((a) => a.status === "fulfilled");
    const rejected = attempts.filter((a) => a.status === "rejected") as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(5); // exactly cap reservations win
    expect(rejected).toHaveLength(15);
    expect(rejected.every((r) => r.reason instanceof QuotaExceededError)).toBe(true);

    const row = await prisma.senderDailyUsage.findUnique({
      where: { senderAccountId_date: { senderAccountId: account.id, date: day } },
    });
    expect(row?.reservedCount).toBe(5);
    expect(row?.sentCount).toBe(0);
  });

  it("settle turns a reservation into a real send", async () => {
    const user = await createTestUser();
    const account = await createSenderAccount(user.id, { dailyCap: 1 });

    await prisma.$transaction((tx) => reserveSenderSlot(tx, account.id, 1, day));
    await prisma.$transaction((tx) => settleSenderSlot(tx, account.id, day));

    const row = await prisma.senderDailyUsage.findUnique({
      where: { senderAccountId_date: { senderAccountId: account.id, date: day } },
    });
    expect(row?.sentCount).toBe(1);
    expect(row?.reservedCount).toBe(0);

    // sent + reserved is what the cap counts -> cap 1 is now consumed.
    await expect(prisma.$transaction((tx) => reserveSenderSlot(tx, account.id, 1, day))).rejects.toBeInstanceOf(
      QuotaExceededError,
    );
  });

  it("releases the slot (and counts the failure) when a send permanently fails", async () => {
    const user = await createTestUser();
    const account = await createSenderAccount(user.id, { dailyCap: 1 });
    const day2 = quotaDayKey(new Date());

    await prisma.$transaction((tx) => reserveSenderSlot(tx, account.id, 1, day2));
    await prisma.$transaction((tx) => releaseSenderSlot(tx, account.id, day2, true));

    const row = await prisma.senderDailyUsage.findUnique({
      where: { senderAccountId_date: { senderAccountId: account.id, date: day2 } },
    });
    expect(row?.reservedCount).toBe(0);
    expect(row?.failureCount).toBe(1);

    // The freed slot is usable again.
    await expect(prisma.$transaction((tx) => reserveSenderSlot(tx, account.id, 1, day2))).resolves.toBeUndefined();
  });

  it("enforces the campaign daily limit and rolls it back on failure", async () => {
    const user = await createTestUser();
    const campaign = await createTestCampaign(user.id, { dailyLimit: 1 });

    await prisma.$transaction((tx) => reserveCampaignSlot(tx, campaign.id, 1, day));
    await expect(prisma.$transaction((tx) => reserveCampaignSlot(tx, campaign.id, 1, day))).rejects.toBeInstanceOf(
      QuotaExceededError,
    );

    await prisma.$transaction((tx) => rollbackCampaignSlot(tx, campaign.id, day));
    await expect(prisma.$transaction((tx) => reserveCampaignSlot(tx, campaign.id, 1, day))).resolves.toBeUndefined();

    // No limit configured -> unlimited (sender caps still apply).
    await expect(prisma.$transaction((tx) => reserveCampaignSlot(tx, campaign.id, null, day))).resolves.toBeUndefined();
  });

  it("computes the quota day in the configured quota time zone", () => {
    const instant = new Date("2026-06-15T20:00:00.000Z");
    expect(quotaDayKey(instant, "UTC").toISOString()).toBe("2026-06-15T00:00:00.000Z");
    // Auckland is UTC+12 in June -> local date is already the 16th.
    expect(quotaDayKey(instant, "Pacific/Auckland").toISOString()).toBe("2026-06-16T00:00:00.000Z");
    // Los Angeles is UTC-7 in June -> still the 15th locally.
    expect(quotaDayKey(instant, "America/Los_Angeles").toISOString()).toBe("2026-06-15T00:00:00.000Z");
  });
});
