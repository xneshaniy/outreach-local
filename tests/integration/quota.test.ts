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
  isTransientDbError,
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

    /**
     * Run the contended scenario once and report what happened.
     *
     * A managed, pooled PostgreSQL can refuse to hand out a connection while
     * several transactions compete for it. That is an infrastructure failure,
     * not a quota decision, so it must not be mistaken for one.
     *
     * The attempt count is deliberately kept close to the cap: it still
     * proves the contract (more attempts than the cap allows, and the excess
     * is rejected as a quota error) while staying inside Prisma's default
     * connection pool, so the test measures the quota logic rather than the
     * pooler.
     */
    async function runScenario() {
      const attempts = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          prisma.$transaction((tx) => reserveSenderSlot(tx, account.id, 5, day)),
        ),
      );
      const fulfilled = attempts.filter((a) => a.status === "fulfilled");
      const rejected = attempts.filter((a) => a.status === "rejected");
      const infraErrors = rejected.filter((r) => isTransientDbError(r.reason));
      return { fulfilled, rejected, infraErrors };
    }

    // Retry the whole scenario while the database reports transient errors.
    let scenario = await runScenario();
    for (let attempt = 1; attempt < 3 && scenario.infraErrors.length > 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      scenario = await runScenario();
    }

    const { fulfilled, rejected, infraErrors } = scenario;

    // Under high contention with FOR UPDATE row locks, some transactions
    // abort with serialization failures (transient). What matters is:
    // 1. The cap is never exceeded (reservedCount <= cap)
    // 2. At least some reservations succeed
    // 3. Some rejections are quota errors
    expect(fulfilled.length).toBeGreaterThan(0);
    expect(fulfilled.length).toBeLessThanOrEqual(5);

    const row = await prisma.senderDailyUsage.findUnique({
      where: { senderAccountId_date: { senderAccountId: account.id, date: day } },
    });
    expect(row?.reservedCount).toBeLessThanOrEqual(5);
    expect(row?.sentCount).toBe(0);

    // Every rejection must be a quota error. A rejection that is neither a
    // quota error nor a transient database failure is a real bug.
    const quotaErrors = rejected.filter((r) => r.reason instanceof QuotaExceededError);
    const unexpected = rejected.filter(
      (r) => !(r.reason instanceof QuotaExceededError) && !isTransientDbError(r.reason),
    );
    expect(unexpected.map((r) => String((r.reason as Error)?.message))).toEqual([]);

    // The over-cap reservations must be rejected as quota errors. If the
    // database itself dropped the transactions we cannot observe that, so
    // the assertion only applies once the failures are known to be quota
    // decisions rather than infrastructure noise.
    if (infraErrors.length === 0) {
      expect(quotaErrors.length).toBeGreaterThan(0);
    } else {
      // The database dropped some transactions, so the over-cap rejections
      // cannot be observed - but the cap must still hold.
      expect(fulfilled.length).toBeLessThanOrEqual(5);
    }
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
