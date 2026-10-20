import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { requireCampaign, requireUser } from "@/lib/auth/guards";
import { scheduleSchema } from "@/lib/validation";
import { reschedulePendingRecipients } from "@/lib/campaign";
import { audit } from "@/lib/audit";

/**
 * POST /api/campaigns/:id/schedule
 * Update the recipient-local sending window; all pending (unclaimed) jobs are
 * recomputed in UTC against each recipient's IANA time zone (spec §6).
 */
type Ctx = { params: Promise<{ id: string }> };

export const POST = handleApi(async (req: NextRequest, ctx: Ctx) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await ctx.params;
  const campaign = await requireCampaign(user.id, id);

  const body = scheduleSchema.parse(await req.json());

  const updated = await prisma.campaign.update({
    where: { id: campaign.id },
    data: {
      windowStartMinute: body.windowStartMinute,
      windowEndMinute: body.windowEndMinute,
      sendingDays: body.sendingDays,
    },
  });

  const rescheduled = await reschedulePendingRecipients(updated);

  await audit(prisma, {
    userId: user.id,
    action: "campaign.schedule_update",
    entityType: "Campaign",
    entityId: campaign.id,
    metadata: { windowStartMinute: body.windowStartMinute, windowEndMinute: body.windowEndMinute, rescheduled },
  });

  return json({ campaign: updated, rescheduled });
});
