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
  try {
    await db.suppression.create({
      data: {
        userId: input.userId,
        emailNormalized: input.emailNormalized,
        scope: input.scope,
        campaignId: input.campaignId ?? null,
        reason: input.reason,
        source: input.source,
      },
    });
    return { created: true };
  } catch (err) {
    // Unique partial index violation → already suppressed (idempotent).
    if ((err as { code?: string })?.code === "P2002") {
      return { created: false };
    }
    logger.error("Failed to add suppression", { error: (err as Error).message });
    throw err;
  }
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
