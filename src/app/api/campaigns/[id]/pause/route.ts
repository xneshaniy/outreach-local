import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { requireCampaign, requireUser } from "@/lib/auth/guards";
import { ApiError } from "@/lib/errors";
import { audit } from "@/lib/audit";

/** POST /api/campaigns/:id/pause — stops new sends; queued jobs are kept. */
type Ctx = { params: Promise<{ id: string }> };

export const POST = handleApi(async (req: NextRequest, ctx: Ctx) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await ctx.params;
  const campaign = await requireCampaign(user.id, id);

  if (campaign.status !== "ACTIVE") {
    throw ApiError.badRequest(`Only active campaigns can be paused (current: ${campaign.status}).`);
  }

  const updated = await prisma.campaign.update({
    where: { id: campaign.id },
    data: { status: "PAUSED", emergencyStopped: true },
  });

  await audit(prisma, {
    userId: user.id,
    action: "campaign.pause",
    entityType: "Campaign",
    entityId: campaign.id,
  });

  return json({ campaign: updated });
});
