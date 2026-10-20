import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { requireCampaign, requireUser } from "@/lib/auth/guards";
import { ApiError } from "@/lib/errors";
import { canStartCampaign } from "@/lib/campaign";
import { audit } from "@/lib/audit";

/** POST /api/campaigns/:id/start — with pre-flight checks (spec §4). */
type Ctx = { params: Promise<{ id: string }> };

export const POST = handleApi(async (req: NextRequest, ctx: Ctx) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await ctx.params;
  const campaign = await requireCampaign(user.id, id);

  if (campaign.status === "ACTIVE") return json({ campaign, alreadyActive: true });

  if (campaign.isArchived) {
    throw ApiError.badRequest("This campaign is archived. Restore it before starting.");
  }

  // Manual approval gate: a campaign that requires approval must be approved
  // before it can send anything.
  if (campaign.requiresApproval && !campaign.approvedAt) {
    throw ApiError.badRequest("This campaign needs approval before it can start.", {
      problems: ["Approve the campaign (Campaigns -> Approve) and try again."],
    });
  }

  const check = await canStartCampaign(campaign);
  if (!check.ok) {
    throw ApiError.badRequest("Campaign cannot start yet.", { problems: check.problems });
  }

  const updated = await prisma.campaign.update({
    where: { id: campaign.id },
    data: { status: "ACTIVE", emergencyStopped: false },
  });

  await audit(prisma, {
    userId: user.id,
    action: "campaign.start",
    entityType: "Campaign",
    entityId: campaign.id,
  });

  return json({ campaign: updated });
});
