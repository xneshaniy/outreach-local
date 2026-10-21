import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json } from "@/lib/http";
import { requireCampaign, requireUser } from "@/lib/auth/guards";
import { runPreflight } from "@/lib/preflight";
import { capabilitiesFor } from "@/lib/provider-capabilities";

/**
 * GET /api/campaigns/:id/preflight — the pre-launch report.
 *
 * Reports blockers (the campaign must not start), warnings and info, the
 * eligible/excluded recipient split, and the personalisation coverage. It
 * sends nothing.
 */
export const GET = handleApi(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  const campaign = await requireCampaign(user.id, id);

  const sender = await prisma.senderAccount.findFirst({
    where: { userId: user.id, status: "CONNECTED" },
    orderBy: { createdAt: "asc" },
    select: { provider: true },
  });
  const provider = sender?.provider === "GOOGLE" ? "GMAIL" : "SMTP";

  const report = await runPreflight(campaign, { provider });
  return json({ report, capabilities: capabilitiesFor(provider) });
});
