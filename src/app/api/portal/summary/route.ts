import { NextRequest } from "next/server";
import { handleApi, json } from "@/lib/http";
import { clientCampaigns, parseRange, requireClient, sumTotals } from "@/lib/portal";

/**
 * GET /api/portal/summary — the client dashboard totals.
 *
 * Only campaigns explicitly assigned to this client are included.
 */
export const GET = handleApi(async (req: NextRequest) => {
  const client = await requireClient();
  const range = parseRange(new URL(req.url));

  const campaigns = await clientCampaigns(client.id, range);
  const totals = sumTotals(campaigns);

  return json({
    client: { name: client.name, email: client.email, company: client.company },
    range: { since: range.since.toISOString(), until: range.until.toISOString() },
    campaigns: campaigns.length,
    totals,
    // Metrics we cannot know are reported as unavailable, never guessed.
    availability: {
      delivered: totals.deliveredKnown,
      opens: campaigns.some((c) => c.trackingEnabled),
      clicks: campaigns.some((c) => c.clickTrackingEnabled),
    },
  });
});
