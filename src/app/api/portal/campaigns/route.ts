import { NextRequest } from "next/server";
import { handleApi, json } from "@/lib/http";
import { clientCampaigns, parseRange, requireClient } from "@/lib/portal";

/**
 * GET /api/portal/campaigns — the campaigns assigned to this client.
 */
export const GET = handleApi(async (req: NextRequest) => {
  const client = await requireClient();
  const range = parseRange(new URL(req.url));
  const campaigns = await clientCampaigns(client.id, range);
  return json({
    range: { since: range.since.toISOString(), until: range.until.toISOString() },
    campaigns,
  });
});
