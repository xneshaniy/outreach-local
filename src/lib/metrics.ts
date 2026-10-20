import { prisma } from "./db";

/**
 * Campaign performance metrics.
 *
 * Every metric is derived from real rows — nothing is estimated or invented.
 * Where the provider does not give us the data, the metric is reported as
 * `null` and labelled "not available" by the UI, rather than being guessed.
 *
 * Definitions used throughout the portal:
 *
 *  - **sent**       messages the provider ACCEPTED (job status SENT).
 *  - **delivered**  messages the provider confirmed as delivered. Not
 *                   available with the Gmail API or plain SMTP — reported as
 *                   `null` unless a delivery webhook has confirmed it.
 *  - **uniqueOpens** distinct recipients that triggered the tracking pixel,
 *                   counting only events classified as HUMAN or PREVIEW.
 *  - **totalOpens** every pixel fetch, including repeats and automated ones.
 *  - **openRate**   uniqueOpens / delivered when delivery data exists,
 *                   otherwise uniqueOpens / sent (the denominator is always
 *                   reported alongside the rate).
 *  - **uniqueClicks** distinct recipients that followed a tracked link.
 *  - **clickRate**  uniqueClicks / sent (or / delivered when available).
 *  - **replies**    replies matched to this campaign.
 *  - **replyRate**  replies / sent.
 *  - **bounces**    permanent failures reported by the provider.
 *  - **unsubscribes** suppression rows created by an unsubscribe.
 */

export type CampaignMetrics = {
  sent: number;
  delivered: number | null;
  uniqueOpens: number;
  totalOpens: number;
  openRate: number | null;
  openRateDenominator: "delivered" | "sent";
  uniqueClicks: number;
  totalClicks: number;
  clickRate: number | null;
  clickRateDenominator: "delivered" | "sent";
  replies: number;
  replyRate: number | null;
  bounced: number;
  failed: number;
  unsubscribed: number;
  /** Recipients in the campaign. */
  recipients: number;
  /** Recipients still to be sent. */
  pending: number;
  /** True when the campaign has open tracking switched on. */
  trackingEnabled: boolean;
  /** True when the campaign has click tracking switched on. */
  clickTrackingEnabled: boolean;
};

function rate(numerator: number, denominator: number | null): number | null {
  if (!denominator || denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10; // one decimal
}

/**
 * Compute the metrics for one campaign.
 * `since`/`until` bound the reporting window (null = all time).
 */
export async function campaignMetrics(
  campaignId: string,
  window?: { since?: Date; until?: Date },
): Promise<CampaignMetrics> {
  const since = window?.since ?? null;
  const until = window?.until ?? null;
  const [recipientGroups, sentJobs, deliveredJobs, openRows, clickRows, replyCount, bounceJobs, unsubCount, campaign] =
    await Promise.all([
      prisma.campaignRecipient.groupBy({
        by: ["status"],
        where: { campaignId },
        _count: { _all: true },
      }),
      prisma.sendJob.findMany({
        where: {
          campaignId,
          status: "SENT",
          ...(since || until
            ? { updatedAt: { ...(since ? { gte: since } : {}), ...(until ? { lte: until } : {}) } }
            : {}),
        },
        select: { id: true, contactId: true, deliveredAt: true },
      }),
      // Delivery is only known when a provider/webhook confirmed it.
      prisma.sendJob.count({
        where: {
          campaignId,
          status: "SENT",
          deliveredAt: { not: null },
          ...(since || until
            ? { updatedAt: { ...(since ? { gte: since } : {}), ...(until ? { lte: until } : {}) } }
            : {}),
        },
      }),
      prisma.trackingEvent.findMany({
        where: {
          campaignId,
          type: "OPEN",
          ...(since || until
            ? { createdAt: { ...(since ? { gte: since } : {}), ...(until ? { lte: until } : {}) } }
            : {}),
        },
        select: { contactId: true, source: true, dedupeKey: true },
      }),
      prisma.trackingEvent.findMany({
        where: {
          campaignId,
          type: "CLICK",
          ...(since || until
            ? { createdAt: { ...(since ? { gte: since } : {}), ...(until ? { lte: until } : {}) } }
            : {}),
        },
        select: { contactId: true, source: true, dedupeKey: true, url: true },
      }),
      prisma.reply.count({ where: { campaignId } }),
      prisma.sendJob.count({ where: { campaignId, status: "FAILED", lastError: { contains: "bounce", mode: "insensitive" } } }),
      prisma.suppression.count({ where: { campaignId, reason: { in: ["UNSUBSCRIBE", "LIST_UNSUBSCRIBE"] } } }),
      prisma.campaign.findUnique({
        where: { id: campaignId },
        select: { trackingEnabled: true, clickTrackingEnabled: true },
      }),
    ]);

  const byStatus: Record<string, number> = {};
  let recipients = 0;
  for (const g of recipientGroups) {
    byStatus[g.status] = g._count._all;
    recipients += g._count._all;
  }

  const sent = sentJobs.length;
  // Delivery is only "known" when at least one message has been confirmed.
  const delivered = deliveredJobs > 0 ? deliveredJobs : null;
  const denominator = delivered ?? sent;

  // Unique opens: the dedupe key is only set on the first event of its kind.
  const uniqueOpenContacts = new Set(
    openRows.filter((o) => o.dedupeKey && o.source !== "BOT").map((o) => o.contactId),
  );
  const uniqueOpens = uniqueOpenContacts.size;
  const totalOpens = openRows.length;

  const uniqueClickContacts = new Set(
    clickRows.filter((c) => c.dedupeKey && c.source !== "BOT").map((c) => c.contactId),
  );
  const uniqueClicks = uniqueClickContacts.size;
  const totalClicks = clickRows.length;

  const failed = byStatus.FAILED ?? 0;

  return {
    sent,
    delivered,
    uniqueOpens,
    totalOpens,
    openRate: rate(uniqueOpens, denominator),
    openRateDenominator: delivered !== null ? "delivered" : "sent",
    uniqueClicks,
    totalClicks,
    clickRate: rate(uniqueClicks, denominator),
    clickRateDenominator: delivered !== null ? "delivered" : "sent",
    replies: replyCount,
    replyRate: rate(replyCount, sent),
    bounced: bounceJobs,
    failed,
    unsubscribed: unsubCount,
    recipients,
    pending: (byStatus.PENDING ?? 0) + (byStatus.SCHEDULED ?? 0) + (byStatus.QUEUED ?? 0) + (byStatus.SENDING ?? 0),
    trackingEnabled: campaign?.trackingEnabled ?? false,
    clickTrackingEnabled: campaign?.clickTrackingEnabled ?? false,
  };
}

export type DailyPoint = {
  date: string;
  sent: number;
  uniqueOpens: number;
  uniqueClicks: number;
  replies: number;
};

/**
 * Daily performance series for the charts.
 */
export async function dailySeries(
  campaignId: string,
  window?: { since?: Date; until?: Date },
): Promise<DailyPoint[]> {
  const since = window?.since ?? null;
  const until = window?.until ?? null;
  const range = { ...(since ? { gte: since } : {}), ...(until ? { lte: until } : {}) };

  const [jobs, opens, clicks, replies] = await Promise.all([
    prisma.sendJob.findMany({
      where: { campaignId, status: "SENT", ...(Object.keys(range).length ? { updatedAt: range } : {}) },
      select: { updatedAt: true },
    }),
    prisma.trackingEvent.findMany({
      where: { campaignId, type: "OPEN", ...(Object.keys(range).length ? { createdAt: range } : {}) },
      select: { createdAt: true, dedupeKey: true, source: true },
    }),
    prisma.trackingEvent.findMany({
      where: { campaignId, type: "CLICK", ...(Object.keys(range).length ? { createdAt: range } : {}) },
      select: { createdAt: true, dedupeKey: true, source: true },
    }),
    prisma.reply.findMany({ where: { campaignId }, select: { receivedAt: true } }),
  ]);

  const day = (d: Date): string => d.toISOString().slice(0, 10);
  const points = new Map<string, DailyPoint>();

  const point = (d: Date): DailyPoint => {
    const key = day(d);
    let p = points.get(key);
    if (!p) {
      p = { date: key, sent: 0, uniqueOpens: 0, uniqueClicks: 0, replies: 0 };
      points.set(key, p);
    }
    return p;
  };

  for (const j of jobs) point(j.updatedAt).sent += 1;
  for (const o of opens) if (o.dedupeKey && o.source !== "BOT") point(o.createdAt).uniqueOpens += 1;
  for (const c of clicks) if (c.dedupeKey && c.source !== "BOT") point(c.createdAt).uniqueClicks += 1;
  for (const r of replies) point(r.receivedAt).replies += 1;

  return [...points.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * The most-clicked links of a campaign.
 */
export async function topLinks(
  campaignId: string,
  limit = 10,
): Promise<Array<{ url: string; clicks: number; uniqueClicks: number }>> {
  const events = await prisma.trackingEvent.findMany({
    where: { campaignId, type: "CLICK" },
    select: { url: true, contactId: true, dedupeKey: true, source: true },
  });

  const byUrl = new Map<string, { clicks: number; contacts: Set<string> }>();
  for (const e of events) {
    if (!e.url) continue;
    const entry = byUrl.get(e.url) ?? { clicks: 0, contacts: new Set<string>() };
    entry.clicks += 1;
    if (e.dedupeKey && e.source !== "BOT") entry.contacts.add(e.contactId);
    byUrl.set(e.url, entry);
  }

  return [...byUrl.entries()]
    .map(([url, v]) => ({ url, clicks: v.clicks, uniqueClicks: v.contacts.size }))
    .sort((a, b) => b.uniqueClicks - a.uniqueClicks || b.clicks - a.clicks)
    .slice(0, limit);
}
