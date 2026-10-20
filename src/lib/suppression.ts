import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { logger } from "./logger";

/**
 * Suppression handling (global + per-campaign).
 *
 * A recipient is ineligible when:
 *  - a GLOBAL suppression row exists for their normalized email, or
 *  - a CAMPAIGN suppression row exists for (campaign, email), or
 *  - their contact status is UNSUBSCRIBED / BOUNCED / COMPLAINED / INVALID.
 *
 * Suppression rows are written by the unsubscribe endpoint, bounce/complaint
 * webhooks, and manual actions. Inserts are idempotent (unique partial indexes
 * in the migration + P2002 tolerance).
 */

export type SuppressionCheckResult = {
  suppressed: boolean;
  reason?: "GLOBAL_SUPPRESSION" | "CAMPAIGN_SUPPRESSION" | "CONTACT_STATUS";
  detail?: string;
};

export async function checkSuppression(
  userId: string,
  emailNormalized: string,
  campaignId?: string,
): Promise<SuppressionCheckResult> {
  const global = await prisma.suppression.findFirst({
    where: { userId, scope: "GLOBAL", emailNormalized },
  });
  if (global) return { suppressed: true, reason: "GLOBAL_SUPPRESSION", detail: global.reason };

  if (campaignId) {
    const campaign = await prisma.suppression.findFirst({
      where: { userId, scope: "CAMPAIGN", campaignId, emailNormalized },
    });
    if (campaign) return { suppressed: true, reason: "CAMPAIGN_SUPPRESSION", detail: campaign.reason };
  }
  return { suppressed: false };
}

export async function addSuppression(input: {
  userId: string;
  emailNormalized: string;
  scope: "GLOBAL" | "CAMPAIGN";
  campaignId?: string | null;
  reason: "UNSUBSCRIBE" | "BOUNCE" | "HARD_BOUNCE" | "COMPLAINT" | "MANUAL" | "LIST_UNSUBSCRIBE";
  source?: string;
  tx?: Prisma.TransactionClient;
}): Promise<{ created: boolean }> {
  const db = input.tx ?? prisma;

  // Use raw SQL with ON CONFLICT DO NOTHING to avoid transaction abort on partial unique indexes.
  // The partial unique indexes in the migration are:
  // - global: ("userId", "emailNormalized") WHERE scope='GLOBAL' AND "campaignId" IS NULL
  // - campaign: ("campaignId", "emailNormalized") WHERE scope='CAMPAIGN' AND "campaignId" IS NOT NULL
  // Note: Prisma uses camelCase column names in the database. Enum values need explicit cast.
  const conflictTarget =
    input.scope === "GLOBAL"
      ? '("userId", "emailNormalized") WHERE scope = \'GLOBAL\' AND "campaignId" IS NULL'
      : '("campaignId", "emailNormalized") WHERE scope = \'CAMPAIGN\' AND "campaignId" IS NOT NULL';

  const columns = ['id', '"userId"', '"emailNormalized"', 'scope', '"campaignId"', 'reason', 'source'];
  // Cast enum values: scope::"SuppressionScope", reason::"SuppressionReason"
  // Generate UUID for id
  const placeholders = ['gen_random_uuid()::text', '$1', '$2', '$3::"SuppressionScope"', '$4', '$5::"SuppressionReason"', '$6'].join(', ');
  const values = [
    input.userId,
    input.emailNormalized,
    input.scope,
    input.campaignId ?? null,
    input.reason,
    input.source ?? null,
  ];

  const sql = `
    INSERT INTO "Suppression" (${columns.join(', ')})
    VALUES (${placeholders})
    ON CONFLICT ${conflictTarget} DO NOTHING
  `;

  const result = await db.$executeRawUnsafe(sql, ...values);
  // result is the number of rows inserted (1 if created, 0 if conflict)
  return { created: result > 0 };
}

/**
 * Contact-frequency guard: was this contact emailed by this workspace within
 * the configured minimum gap?
 */
export async function isTooFrequent(contact: { lastSentAt: Date | null }, minDays: number): Promise<boolean> {
  if (!contact.lastSentAt || minDays <= 0) return false;
  const gapMs = Date.now() - contact.lastSentAt.getTime();
  return gapMs < minDays * 86400000;
}
