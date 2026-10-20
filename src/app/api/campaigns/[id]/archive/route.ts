import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { requireCampaign, requireUser } from "@/lib/auth/guards";
import { audit } from "@/lib/audit";
import { cancelFollowUpsForCampaign } from "@/lib/followup";
import { ApiError } from "@/lib/errors";

/**
 * POST /api/campaigns/:id/archive
 *
 * Archives a campaign: it is hidden from the default list and no more
 * messages go out. Pending follow-ups are cancelled. The history is kept.
 *
 * `?action=restore` un-archives it.
 */
export const POST = handleApi(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await ctx.params;
  const campaign = await requireCampaign(user.id, id);

  const url = new URL(req.url);
  const restore = url.searchParams.get("action") === "restore";

  if (restore) {
    const updated = await prisma.campaign.update({
      where: { id },
      data: { isArchived: false, status: campaign.status === "ARCHIVED" ? "PAUSED" : campaign.status },
    });
    await audit(prisma, {
      userId: user.id,
      action: "campaign.restore",
      entityType: "Campaign",
      entityId: id,
    });
    return json({ campaign: updated });
  }

  if (campaign.status === "ACTIVE") {
    throw ApiError.badRequest("Pause the campaign before archiving it.");
  }

  const cancelledFollowUps = await cancelFollowUpsForCampaign(id, "The campaign was archived.");

  const updated = await prisma.$transaction(async (tx) => {
    await tx.sendJob.updateMany({
      where: { campaignId: id, status: "QUEUED" },
      data: { status: "CANCELLED" },
    });
    return tx.campaign.update({
      where: { id },
      data: { isArchived: true, status: "ARCHIVED" },
    });
  });

  await audit(prisma, {
    userId: user.id,
    action: "campaign.archive",
    entityType: "Campaign",
    entityId: id,
    metadata: { followUpsCancelled: cancelledFollowUps },
  });

  return json({ campaign: updated, followUpsCancelled: cancelledFollowUps });
});
