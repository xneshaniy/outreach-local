import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json } from "@/lib/http";
import { ApiError } from "@/lib/errors";
import { campaignMetrics, dailySeries, topLinks } from "@/lib/metrics";
import { clientCanAccessCampaign, parseRange, requireClient } from "@/lib/portal";

/**
 * GET /api/portal/campaigns/:id — the report for one assigned campaign.
 *
 * The campaign id is checked against the client's assignments. A client
 * asking for somebody else's campaign gets a 404 — never that campaign's
 * data, and never a hint that it exists.
 */
export const GET = handleApi(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const client = await requireClient();
  const { id } = await ctx.params;
  const range = parseRange(new URL(req.url));

  if (!(await clientCanAccessCampaign(client.id, id))) {
    throw ApiError.notFound("Campaign not found.");
  }

  const campaign = await prisma.campaign.findFirst({
    where: { id, userId: client.userId },
    select: {
      id: true,
      name: true,
      subject: true,
      status: true,
      isArchived: true,
      createdAt: true,
      startAt: true,
      endAt: true,
      trackingEnabled: true,
      clickTrackingEnabled: true,
      windowStartMinute: true,
      windowEndMinute: true,
      sendingDays: true,
    },
  });
  if (!campaign) throw ApiError.notFound("Campaign not found.");

  const [metrics, series, links] = await Promise.all([
    campaignMetrics(campaign.id, range),
    dailySeries(campaign.id, range),
    topLinks(campaign.id, 10),
  ]);

  return json({
    campaign: {
      id: campaign.id,
      name: campaign.name,
      subject: campaign.subject,
      status: campaign.status,
      isArchived: campaign.isArchived,
      createdAt: campaign.createdAt.toISOString(),
      startAt: campaign.startAt?.toISOString() ?? null,
      endAt: campaign.endAt?.toISOString() ?? null,
      trackingEnabled: campaign.trackingEnabled,
      clickTrackingEnabled: campaign.clickTrackingEnabled,
      sendingWindow: {
        startMinute: campaign.windowStartMinute,
        endMinute: campaign.windowEndMinute,
        days: campaign.sendingDays,
      },
    },
    range: { since: range.since.toISOString(), until: range.until.toISOString() },
    metrics,
    daily: series,
    topLinks: links,
    availability: {
      delivered: metrics.delivered !== null,
      opens: campaign.trackingEnabled,
      clicks: campaign.clickTrackingEnabled,
    },
  });
});
