import { prisma } from "./db";
import { ApiError } from "./errors";
import { getCurrentClient, getClientCampaignIds } from "./auth/client-session";
import { campaignMetrics, type CampaignMetrics } from "./metrics";

/**
 * Shared helpers for the client portal.
 *
 * The access model has exactly one rule: a client sees a campaign if and only
 * if there is a `ClientCampaignAccess` row for it. Every portal query is
 * filtered by that list, so a client can never read another client's work —
 * not through a URL, an export or a query parameter.
 */

export type PortalClient = {
  id: string;
  userId: string;
  email: string;
  name: string;
  company: string | null;
};

/** Resolve the signed-in client, or fail with 401. */
export async function requireClient(): Promise<PortalClient> {
  const client = await getCurrentClient();
  if (!client) throw ApiError.unauthorized("Sign in to the client portal.");
  return client;
}

/** The campaign ids this client may see. */
export async function clientCampaignIds(clientId: string): Promise<string[]> {
  return getClientCampaignIds(clientId);
}

/** True when the client was explicitly given access to this campaign. */
export async function clientCanAccessCampaign(clientId: string, campaignId: string): Promise<boolean> {
  const ids = await clientCampaignIds(clientId);
  return ids.includes(campaignId);
}

/** Parse a date range from the query string. */
export function parseRange(url: URL, defaultDays = 30): { since: Date; until: Date } {
  const untilParam = url.searchParams.get("until");
  const sinceParam = url.searchParams.get("since");
  const daysParam = Number(url.searchParams.get("days") ?? defaultDays);

  const until = untilParam ? new Date(untilParam) : new Date();
  if (Number.isNaN(until.getTime())) throw ApiError.badRequest("Invalid `until` date.");

  const days = Math.min(365, Math.max(1, Number.isFinite(daysParam) ? daysParam : defaultDays));
  const since = sinceParam
    ? new Date(sinceParam)
    : new Date(until.getTime() - days * 86400000);

  if (Number.isNaN(since.getTime())) throw ApiError.badRequest("Invalid `since` date.");
  if (since > until) throw ApiError.badRequest("`since` must be before `until`.");
  return { since, until };
}

export type PortalCampaign = CampaignMetrics & {
  id: string;
  name: string;
  subject: string;
  status: string;
  isArchived: boolean;
  createdAt: string;
  startAt: string | null;
};

/** The campaigns assigned to the client, with their metrics. */
export async function clientCampaigns(
  clientId: string,
  range: { since: Date; until: Date },
): Promise<PortalCampaign[]> {
  const campaignIds = await clientCampaignIds(clientId);
  if (campaignIds.length === 0) return [];

  const campaigns = await prisma.campaign.findMany({
    where: { id: { in: campaignIds } },
    select: {
      id: true,
      name: true,
      subject: true,
      status: true,
      isArchived: true,
      createdAt: true,
      startAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  const out: PortalCampaign[] = [];
  for (const c of campaigns) {
    const metrics = await campaignMetrics(c.id, range);
    out.push({
      id: c.id,
      name: c.name,
      subject: c.subject,
      status: c.status,
      isArchived: c.isArchived,
      createdAt: c.createdAt.toISOString(),
      startAt: c.startAt?.toISOString() ?? null,
      ...metrics,
    });
  }
  return out;
}

/** Roll the campaign metrics up into workspace totals. */
export function sumTotals(campaigns: PortalCampaign[]) {
  const totals = campaigns.reduce(
    (acc, c) => {
      acc.sent += c.sent;
      acc.uniqueOpens += c.uniqueOpens;
      acc.totalOpens += c.totalOpens;
      acc.uniqueClicks += c.uniqueClicks;
      acc.totalClicks += c.totalClicks;
      acc.replies += c.replies;
      acc.bounced += c.bounced;
      acc.failed += c.failed;
      acc.unsubscribed += c.unsubscribed;
      acc.recipients += c.recipients;
      acc.pending += c.pending;
      if (c.delivered !== null) acc.deliveredKnown = true;
      return acc;
    },
    {
      sent: 0,
      delivered: 0,
      deliveredKnown: false,
      uniqueOpens: 0,
      totalOpens: 0,
      uniqueClicks: 0,
      totalClicks: 0,
      replies: 0,
      bounced: 0,
      failed: 0,
      unsubscribed: 0,
      recipients: 0,
      pending: 0,
    },
  );

  const denominator = totals.deliveredKnown ? totals.delivered : totals.sent;
  const rate = (n: number): number | null =>
    denominator > 0 ? Math.round((n / denominator) * 1000) / 10 : null;

  return {
    ...totals,
    openRate: rate(totals.uniqueOpens),
    clickRate: rate(totals.uniqueClicks),
    replyRate: totals.sent > 0 ? Math.round((totals.replies / totals.sent) * 1000) / 10 : null,
    rateDenominator: totals.deliveredKnown ? ("delivered" as const) : ("sent" as const),
  };
}
