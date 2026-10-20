import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { requireCampaign, requireUser } from "@/lib/auth/guards";
import { audit } from "@/lib/audit";

/**
 * POST /api/campaigns/:id/approve
 *
 * Manual approval gate. A campaign created with `requiresApproval` cannot be
 * started until it is approved here. Approving (or revoking) is audited.
 */
export const POST = handleApi(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await ctx.params;
  await requireCampaign(user.id, id);

  const body = (await req.json().catch(() => ({}))) as { approved?: boolean };
  const approved = body.approved !== false;

  const updated = await prisma.campaign.update({
    where: { id },
    data: {
      requiresApproval: !approved,
      approvedAt: approved ? new Date() : null,
      approvedBy: approved ? user.id : null,
    },
  });

  await audit(prisma, {
    userId: user.id,
    action: approved ? "campaign.approve" : "campaign.approval_revoked",
    entityType: "Campaign",
    entityId: id,
  });

  return json({ campaign: updated });
});
