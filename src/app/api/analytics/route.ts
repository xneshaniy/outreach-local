import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json } from "@/lib/http";
import { requireUser } from "@/lib/auth/guards";
import { quotaDayKey } from "@/lib/quota";
import { env } from "@/lib/env";

/**
 * GET /api/analytics — workspace-level reporting:
 *   campaign rollup, sender usage today, delivery outcomes, recent failures.
 */
export const GET = handleApi(async (req: NextRequest) => {
  const user = await requireUser();
  const url = new URL(req.url);
  const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days") ?? 30)));
  const since = new Date(Date.now() - days * 86400000);

  const [campaigns, sentByDay, attemptsByOutcome, failures, suppressions, todayUsage] = await Promise.all([
    prisma.campaign.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 25,
      include: { _count: { select: { recipients: true } } },
    }),
    prisma.sendJob.aggregate({
      where: { userId: user.id, status: "SENT", updatedAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.sendAttempt.groupBy({
      by: ["status"],
      where: { startedAt: { gte: since }, job: { userId: user.id } },
      _count: { _all: true },
    }),
    prisma.sendJob.findMany({
      where: { userId: user.id, status: { in: ["FAILED", "AMBIGUOUS"] } },
      orderBy: { updatedAt: "desc" },
      take: 25,
      select: {
        id: true,
        status: true,
        errorCode: true,
        lastError: true,
        attempts: true,
        updatedAt: true,
        campaign: { select: { name: true } },
        contact: { select: { email: true } },
      },
    }),
    prisma.suppression.groupBy({
      by: ["reason"],
      where: { userId: user.id },
      _count: { _all: true },
    }),
    prisma.senderDailyUsage.findMany({
      where: { date: quotaDayKey(new Date(), env.senderQuotaTimezone), senderAccount: { userId: user.id } },
      include: { senderAccount: { select: { id: true, email: true, dailyCap: true, status: true } } },
    }),
  ]);

  const campaignStats = await Promise.all(
    campaigns.map(async (c) => {
      const groups = await prisma.campaignRecipient.groupBy({
        by: ["status"],
        where: { campaignId: c.id },
        _count: { _all: true },
      });
      const byStatus: Record<string, number> = {};
      for (const g of groups) byStatus[g.status] = g._count._all;
      return { id: c.id, name: c.name, status: c.status, total: c._count.recipients, byStatus };
    }),
  );

  return json({
    windowDays: days,
    totals: {
      sent: sentByDay._count._all,
      attemptsByOutcome: Object.fromEntries(attemptsByOutcome.map((a) => [a.status, a._count._all])),
      suppressionsByReason: Object.fromEntries(suppressions.map((s) => [s.reason, s._count._all])),
    },
    campaigns: campaignStats,
    todayUsage,
    recentFailures: failures,
  });
});
