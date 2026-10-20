import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { requireCampaign, requireUser } from "@/lib/auth/guards";
import { ApiError } from "@/lib/errors";
import { canStartCampaign } from "@/lib/campaign";
import { audit } from "@/lib/audit";

/** POST /api/campaigns/:id/resume — re-validates pre-flight conditions. */
type Ctx = { params: Promise<{ id: string }> };

export const POST = handleApi(async (req: NextRequest, ctx: Ctx) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await ctx.params;
  const campaign = await requireCampaign(user.id, id);

  if (campaign.status !== "PAUSED") {
    throw ApiError.badRequest(`Only paused campaigns can be resumed (current: ${campaign.status}).`);
  }

  const check = await canStartCampaign(campaign);
  if (!check.ok) {
    throw ApiError.badRequest("Campaign cannot resume yet.", { problems: check.problems });
  }

  const updated = await prisma.campaign.update({
    where: { id: campaign.id },
    data: { status: "ACTIVE", emergencyStopped: false },
  });

  await audit(prisma, {
    userId: user.id,
    action: "campaign.resume",
    entityType: "Campaign",
    entityId: campaign.id,
  });

  return json({ campaign: updated });
});
