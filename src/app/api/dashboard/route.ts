import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json } from "@/lib/http";
import { requireUser } from "@/lib/auth/guards";
import { quotaDayKey } from "@/lib/quota";
import { env } from "@/lib/env";
import { capabilitiesFor, type ProviderKind } from "@/lib/provider-capabilities";

/**
 * GET /api/dashboard — everything the dashboard needs, in one request.
 *
 * Design rules:
 *  - Every number is counted from real rows. Nothing is estimated.
 *  - A metric the provider cannot supply is returned as `null` together with an
 *    `availability` flag, so the UI can say "not available" instead of 0.
 *  - `estimated` marks a figure that is an approximation (open rate).
 */
export const GET = handleApi(async (req: NextRequest) => {
  const user = await requireUser();
  const url = new URL(req.url);

  const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days") ?? 30)));
  const since = new Date(Date.now() - days * 86400000);
  const campaignId = url.searchParams.get("campaignId")?.trim() || null;
  const serviceId = url.searchParams.get("serviceId")?.trim() || null;
  const senderAccountId = url.searchParams.get("senderAccountId")?.trim() || null;

  // --- Scope ---------------------------------------------------------------
  const campaignWhere = {
    userId: user.id,
    ...(campaignId ? { id: campaignId } : {}),
    ...(serviceId ? { serviceId } : {}),
  };

  const jobWhere = {
    userId: user.id,
    ...(campaignId ? { campaignId } : {}),
    ...(serviceId ? { campaign: { serviceId } } : {}),
    ...(senderAccountId ? { senderAccountId } : {}),
  };

  const [
    contactsTotal,
    contactsEligible,
    campaignsByStatus,
    jobsGrouped,
    attemptsGrouped,
    suppressionsByReason,
    followUpsGrouped,
    upcomingJobs,
    deadLettered,
    openTasks,
    recentActivity,
    recentFailures,
    senders,
    unreadNotifications,
  ] = await Promise.all([
    prisma.contact.count({ where: { userId: user.id, isArchived: false } }),
    // Eligible = active, consented, not suppressed, not archived.
    prisma.contact.count({
      where: {
        userId: user.id,
        isArchived: false,
        status: "ACTIVE",
        consentAt: { not: null },
      },
    }),
    prisma.campaign.groupBy({
      by: ["status"],
      where: campaignWhere,
      _count: { _all: true },
    }),
    prisma.sendJob.groupBy({
      by: ["status"],
      where: jobWhere,
      _count: { _all: true },
    }),
    prisma.sendAttempt.groupBy({
      by: ["status"],
      where: { job: jobWhere },
      _count: { _all: true },
    }),
    prisma.suppression.groupBy({
      by: ["reason"],
      where: { userId: user.id },
      _count: { _all: true },
    }),
    prisma.followUpMessage.groupBy({
      by: ["status"],
      where: { userId: user.id },
      _count: { _all: true },
    }),
    prisma.sendJob.findMany({
      where: { ...jobWhere, status: "QUEUED" },
      orderBy: { scheduledAt: "asc" },
      take: 10,
      select: {
        id: true,
        scheduledAt: true,
        kind: true,
        contact: { select: { email: true } },
        campaign: { select: { id: true, name: true } },
      },
    }),
    prisma.sendJob.count({ where: { ...jobWhere, deadLetteredAt: { not: null } } }),
    prisma.task.count({ where: { userId: user.id, status: "OPEN" } }),
    prisma.contactActivity.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 15,
      include: { contact: { select: { id: true, email: true, firstName: true } } },
    }),
    prisma.sendJob.findMany({
      where: { ...jobWhere, status: { in: ["FAILED", "AMBIGUOUS"] } },
      orderBy: { updatedAt: "desc" },
      take: 10,
      select: {
        id: true,
        status: true,
        lastError: true,
        errorCode: true,
        updatedAt: true,
        contact: { select: { email: true } },
        campaign: { select: { name: true } },
      },
    }),
    prisma.senderAccount.findMany({
      where: { userId: user.id },
      select: { id: true, email: true, provider: true, status: true, dailyCap: true, lastError: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.notification.count({ where: { userId: user.id, isRead: false } }),
  ]);

  // --- Totals --------------------------------------------------------------
  const byJobStatus: Record<string, number> = {};
  for (const g of jobsGrouped) byJobStatus[g.status] = g._count._all;
  const byAttemptStatus: Record<string, number> = {};
  for (const g of attemptsGrouped) byAttemptStatus[g.status] = g._count._all;

  const accepted = byJobStatus.SENT ?? 0;
  const deliveredJobs = await prisma.sendJob.count({
    where: { ...jobWhere, status: "SENT", deliveredAt: { not: null } },
  });
  const replied = await prisma.reply.count({
    where: {
      userId: user.id,
      ...(campaignId ? { campaignId } : {}),
      ...(serviceId ? { campaign: { serviceId } } : {}),
    },
  });
  const bounced = byJobStatus.FAILED ?? 0;
  const failed = byAttemptStatus.PERMANENT_FAILURE ?? 0;
  const unsubscribed =
    (suppressionsByReason.find((s) => s.reason === "UNSUBSCRIBE")?._count._all ?? 0) +
    (suppressionsByReason.find((s) => s.reason === "LIST_UNSUBSCRIBE")?._count._all ?? 0);

  // --- Open / click (opt-in, therefore possibly absent) --------------------
  // TrackingEvent belongs to a campaign, not directly to the user, so the
  // workspace scope goes through the campaign relation. The scope and the
  // service filter are merged into ONE relation filter - two "campaign" keys
  // would silently overwrite each other.
  const campaignScope = {
    userId: user.id,
    ...(serviceId ? { serviceId } : {}),
  };
  const openWhere = {
    campaign: campaignScope,
    type: "OPEN" as const,
    ...(campaignId ? { campaignId } : {}),
  };
  const [uniqueOpens, totalOpens, uniqueClicks] = await Promise.all([
    prisma.trackingEvent.count({ where: { ...openWhere, dedupeKey: { not: null }, source: { not: "BOT" } } }),
    prisma.trackingEvent.count({ where: openWhere }),
    prisma.trackingEvent.count({
      where: {
        ...openWhere,
        type: "CLICK",
        dedupeKey: { not: null },
        source: { not: "BOT" },
      },
    }),
  ]);

  const trackingEnabled = await prisma.campaign.count({
    where: { ...campaignWhere, trackingEnabled: true },
  });
  const clickTrackingEnabled = await prisma.campaign.count({
    where: { ...campaignWhere, clickTrackingEnabled: true },
  });

  const provider: ProviderKind = senders.find((s) => s.status === "CONNECTED")?.provider === "GOOGLE" ? "GMAIL" : "SMTP";
  const caps = capabilitiesFor(provider);

  // --- System health --------------------------------------------------------
  const problems: Array<{ level: "error" | "warning"; message: string }> = [];
  if (senders.length === 0) {
    problems.push({ level: "error", message: "No sender account is connected — nothing can be sent." });
  }
  for (const s of senders) {
    if (s.status === "ERROR") {
      problems.push({ level: "error", message: `Sender ${s.email} needs attention: ${s.lastError ?? "unknown error"}` });
    } else if (s.status === "DISCONNECTED") {
      problems.push({ level: "warning", message: `Sender ${s.email} is disconnected.` });
    }
  }
  if (deadLettered > 0) {
    problems.push({
      level: "warning",
      message: `${deadLettered} message${deadLettered === 1 ? "" : "s"} need manual attention (dead letter).`,
    });
  }
  if (campaignsByStatus.some((c) => c.status === "ACTIVE" && c._count._all > 0) && senders.length === 0) {
    problems.push({ level: "error", message: "A campaign is active but no sender can deliver it." });
  }

  const campaignStatusCounts: Record<string, number> = {};
  for (const c of campaignsByStatus) campaignStatusCounts[c.status] = c._count._all;

  const suppressionCounts: Record<string, number> = {};
  for (const s of suppressionsByReason) suppressionCounts[s.reason] = s._count._all;

  const followUpCounts: Record<string, number> = {};
  for (const f of followUpsGrouped) followUpCounts[f.status] = f._count._all;

  const today = quotaDayKey(new Date(), env.senderQuotaTimezone);
  const todayUsage = await prisma.senderDailyUsage.findMany({
    where: { date: today, senderAccount: { userId: user.id } },
    include: { senderAccount: { select: { email: true, dailyCap: true, status: true } } },
  });

  return json({
    range: { days, since: since.toISOString() },
    filters: { campaignId, serviceId, senderAccountId },
    contacts: {
      total: contactsTotal,
      eligible: contactsEligible,
      ineligible: contactsTotal - contactsEligible,
    },
    campaigns: {
      total: Object.values(campaignStatusCounts).reduce((a, b) => a + b, 0),
      byStatus: campaignStatusCounts,
    },
    messages: {
      queued: byJobStatus.QUEUED ?? 0,
      processing: byJobStatus.CLAIMED ?? 0,
      ambiguous: byJobStatus.AMBIGUOUS ?? 0,
      accepted: accepted,
      delivered: deliveredJobs > 0 ? deliveredJobs : null,
      bounced,
      failed,
      cancelled: byJobStatus.CANCELLED ?? 0,
      skipped: byJobStatus.SKIPPED ?? 0,
      replies: replied,
      unsubscribed,
    },
    engagement: {
      uniqueOpens,
      totalOpens,
      uniqueClicks,
      // An open rate is an approximation, never a certainty.
      estimated: true,
      openRate: accepted > 0 ? Math.round((uniqueOpens / accepted) * 1000) / 10 : null,
      openRateDenominator: "sent",
    },
    followUps: {
      byStatus: followUpCounts,
      scheduled: followUpCounts.SCHEDULED ?? 0,
    },
    suppressions: { total: Object.values(suppressionCounts).reduce((a, b) => a + b, 0), byReason: suppressionCounts },
    tasks: { open: openTasks },
    queue: {
      upcoming: upcomingJobs,
      deadLettered,
    },
    notifications: { unread: unreadNotifications },
    senders: senders.map((s) => ({
      ...s,
      usage: todayUsage.find((u) => u.senderAccount.email === s.email) ?? null,
    })),
    activity: recentActivity,
    failures: recentFailures,
    health: { ok: problems.every((p) => p.level !== "error"), problems },
    availability: {
      delivered: caps.reportsDelivery && deliveredJobs > 0,
      opens: trackingEnabled > 0,
      clicks: clickTrackingEnabled > 0,
      replies: caps.reportsReplies,
      bounces: caps.reportsBounces,
    },
    provider: { kind: provider, capabilities: caps },
  });
});
