import type { Prisma } from "@prisma/client";
import { getLocalParts } from "./scheduling";

/**
 * Transactional, database-enforced quota accounting.
 *
 * Every send reserves a slot inside a DB transaction with a row lock
 * (SELECT ... FOR UPDATE); the reservation is settled (sent / released) when
 * the provider call finishes. Quota rows are per (account, quota-day); the
 * quota day is computed in SENDER_QUOTA_TIMEZONE (default UTC) so caps reset
 * deterministically. The configured cap is MIN(account.dailyCap, env default)
 * applied by the caller — it can only ever *lower* provider limits, never
 * raise them.
 */

export class QuotaExceededError extends Error {
  constructor(
    public readonly scope: "sender" | "campaign",
    public readonly subjectId: string,
    message: string,
  ) {
    super(message);
    this.name = "QuotaExceededError";
  }
}

type Tx = Prisma.TransactionClient;

/** UTC midnight of the quota day, computed in the given time zone. */
export function quotaDayKey(date: Date, timeZone = process.env.SENDER_QUOTA_TIMEZONE ?? "UTC"): Date {
  const p = getLocalParts(date, timeZone);
  return new Date(Date.UTC(p.year, p.month - 1, p.day));
}

async function lockSenderRow(tx: Tx, senderAccountId: string, day: Date) {
  await tx.$executeRaw`
    INSERT INTO "SenderDailyUsage" ("id", "senderAccountId", "date", "sentCount", "reservedCount", "failureCount", "updatedAt")
    VALUES (gen_random_uuid()::text, ${senderAccountId}, ${day}, 0, 0, 0, now())
    ON CONFLICT ("senderAccountId", "date") DO NOTHING`;

  const rows = await tx.$queryRaw<Array<{ id: string; sentCount: number; reservedCount: number }>>`
    SELECT "id", "sentCount", "reservedCount"
    FROM "SenderDailyUsage"
    WHERE "senderAccountId" = ${senderAccountId} AND "date" = ${day}
    FOR UPDATE`;

  const row = rows[0];
  if (!row) throw new Error("Failed to lock sender quota row.");
  return row;
}

/**
 * Atomically reserve one send slot for a sender account.
 * Throws QuotaExceededError when the daily cap is already consumed.
 */
export async function reserveSenderSlot(tx: Tx, senderAccountId: string, cap: number, day: Date): Promise<void> {
  const row = await lockSenderRow(tx, senderAccountId, day);
  const used = row.sentCount + row.reservedCount;
  if (used >= cap) {
    throw new QuotaExceededError("sender", senderAccountId, `Sender daily cap of ${cap} reached.`);
  }
  await tx.$executeRaw`
    UPDATE "SenderDailyUsage"
    SET "reservedCount" = "reservedCount" + 1, "updatedAt" = now()
    WHERE "id" = ${row.id}`;
}

/** Settle a reservation after a successful send (slot becomes a real send). */
export async function settleSenderSlot(tx: Tx, senderAccountId: string, day: Date): Promise<void> {
  await tx.$executeRaw`
    UPDATE "SenderDailyUsage"
    SET "sentCount" = "sentCount" + 1,
        "reservedCount" = GREATEST("reservedCount" - 1, 0),
        "updatedAt" = now()
    WHERE "senderAccountId" = ${senderAccountId} AND "date" = ${day}`;
}

/** Release a reservation (permanent failure / skip) — the slot is freed. */
export async function releaseSenderSlot(tx: Tx, senderAccountId: string, day: Date, countFailure = false): Promise<void> {
  await tx.$executeRaw`
    UPDATE "SenderDailyUsage"
    SET "reservedCount" = GREATEST("reservedCount" - 1, 0),
        "failureCount" = "failureCount" + ${countFailure ? 1 : 0},
        "updatedAt" = now()
    WHERE "senderAccountId" = ${senderAccountId} AND "date" = ${day}`;
}

/**
 * Atomically reserve one slot against an optional campaign-level daily limit.
 * When `dailyLimit` is null the campaign is unlimited (sender caps still apply).
 */
export async function reserveCampaignSlot(tx: Tx, campaignId: string, dailyLimit: number | null, day: Date): Promise<void> {
  if (dailyLimit == null) return;

  await tx.$executeRaw`
    INSERT INTO "CampaignDailyUsage" ("id", "campaignId", "date", "sentCount", "updatedAt")
    VALUES (gen_random_uuid()::text, ${campaignId}, ${day}, 0, now())
    ON CONFLICT ("campaignId", "date") DO NOTHING`;

  const rows = await tx.$queryRaw<Array<{ id: string; sentCount: number }>>`
    SELECT "id", "sentCount" FROM "CampaignDailyUsage"
    WHERE "campaignId" = ${campaignId} AND "date" = ${day}
    FOR UPDATE`;

  const row = rows[0];
  if (!row) throw new Error("Failed to lock campaign quota row.");
  if (row.sentCount >= dailyLimit) {
    throw new QuotaExceededError("campaign", campaignId, `Campaign daily limit of ${dailyLimit} reached.`);
  }
  // Campaign usage counts completed sends only; reservations are enforced by
  // the sender-side lock held in the same transaction, and the worker writes
  // the settled count below inside the same transaction as the send result.
  await tx.$executeRaw`
    UPDATE "CampaignDailyUsage"
    SET "sentCount" = "sentCount" + 1, "updatedAt" = now()
    WHERE "id" = ${row.id}`;
}

export async function rollbackCampaignSlot(tx: Tx, campaignId: string, day: Date): Promise<void> {
  await tx.$executeRaw`
    UPDATE "CampaignDailyUsage"
    SET "sentCount" = GREATEST("sentCount" - 1, 0), "updatedAt" = now()
    WHERE "campaignId" = ${campaignId} AND "date" = ${day}`;
}

/** Current usage snapshot for dashboards. */
export async function senderUsageSnapshot(senderAccountId: string, day: Date) {
  const { prisma } = await import("./db");
  const row = await prisma.senderDailyUsage.findUnique({
    where: { senderAccountId_date: { senderAccountId, date: day } },
  });
  return {
    sent: row?.sentCount ?? 0,
    reserved: row?.reservedCount ?? 0,
    failures: row?.failureCount ?? 0,
  };
}
