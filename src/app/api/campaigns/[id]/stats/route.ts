import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json } from "@/lib/http";
import { requireCampaign, requireUser } from "@/lib/auth/guards";
import { campaignStats } from "@/lib/campaign";

/** GET /api/campaigns/:id/stats — recipient status counts + recent activity. */
type Ctx = { params: Promise<{ id: string }> };

export const GET = handleApi(async (_req: NextRequest, ctx: Ctx) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  const campaign = await requireCampaign(user.id, id);

  const stats = await campaignStats(campaign.id);

  const [recentJobs, daily] = await Promise.all([
    prisma.sendJob.findMany({
      where: { campaignId: campaign.id },
      orderBy: { updatedAt: "desc" },
      take: 20,
      select: {
        id: true,
        status: true,
        attempts: true,
        lastError: true,
        errorCode: true,
        providerMessageId: true,
        updatedAt: true,
        contact: { select: { email: true } },
        senderAccount: { select: { email: true } },
      },
    }),
    prisma.campaignDailyUsage.findMany({
      where: { campaignId: campaign.id },
      orderBy: { date: "desc" },
      take: 30,
    }),
  ]);

  return json({ stats, recentJobs, daily });
});
