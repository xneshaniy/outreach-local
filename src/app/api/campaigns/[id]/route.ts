import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { requireCampaign, requireUser } from "@/lib/auth/guards";
import { campaignUpdateSchema } from "@/lib/validation";
import { campaignStats, reschedulePendingRecipients } from "@/lib/campaign";
import { audit } from "@/lib/audit";
import { normalizeTimeZone } from "@/lib/email-normalize";

/**
 * GET    /api/campaigns/:id — campaign detail + live statistics.
 * PATCH  /api/campaigns/:id — update fields; schedule changes reschedule
 *                             pending recipients (spec §6).
 * DELETE /api/campaigns/:id — cancel the campaign durably (no data loss).
 */

type Ctx = { params: Promise<{ id: string }> };

export const GET = handleApi(async (_req: NextRequest, ctx: Ctx) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  const campaign = await requireCampaign(user.id, id);
  const stats = await campaignStats(campaign.id);
  return json({ campaign, stats });
});

export const PATCH = handleApi(async (req: NextRequest, ctx: Ctx) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await ctx.params;
  const campaign = await requireCampaign(user.id, id);

  const body = campaignUpdateSchema.parse(await req.json());

  const scheduleChanged =
    (body.windowStartMinute !== undefined && body.windowStartMinute !== campaign.windowStartMinute) ||
    (body.windowEndMinute !== undefined && body.windowEndMinute !== campaign.windowEndMinute) ||
    (body.sendingDays !== undefined && JSON.stringify(body.sendingDays) !== JSON.stringify(campaign.sendingDays)) ||
    (body.timeZoneFallback !== undefined && body.timeZoneFallback !== campaign.timeZoneFallback) ||
    (body.fallbackTimeZone !== undefined && normalizeTimeZone(body.fallbackTimeZone) !== campaign.fallbackTimeZone);

  const updated = await prisma.campaign.update({
    where: { id: campaign.id },
    data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.subject !== undefined ? { subject: body.subject } : {}),
      ...(body.body !== undefined ? { body: body.body } : {}),
      ...(body.templateId !== undefined ? { templateId: body.templateId } : {}),
      ...(body.fromName !== undefined ? { fromName: body.fromName } : {}),
      ...(body.replyTo !== undefined ? { replyTo: body.replyTo } : {}),
      ...(body.windowStartMinute !== undefined ? { windowStartMinute: body.windowStartMinute } : {}),
      ...(body.windowEndMinute !== undefined ? { windowEndMinute: body.windowEndMinute } : {}),
      ...(body.sendingDays !== undefined ? { sendingDays: body.sendingDays } : {}),
      ...(body.timeZoneFallback !== undefined ? { timeZoneFallback: body.timeZoneFallback } : {}),
      ...(body.fallbackTimeZone !== undefined ? { fallbackTimeZone: normalizeTimeZone(body.fallbackTimeZone) } : {}),
      ...(body.dailyLimit !== undefined ? { dailyLimit: body.dailyLimit } : {}),
      ...(body.startAt !== undefined ? { startAt: body.startAt } : {}),
      ...(body.endAt !== undefined ? { endAt: body.endAt } : {}),
    },
  });

  let rescheduled = 0;
  if (scheduleChanged && ["DRAFT", "ACTIVE", "PAUSED"].includes(updated.status)) {
    rescheduled = await reschedulePendingRecipients(updated);
  }

  await audit(prisma, {
    userId: user.id,
    action: "campaign.update",
    entityType: "Campaign",
    entityId: campaign.id,
    metadata: { scheduleChanged, rescheduled },
  });

  return json({ campaign: updated, rescheduled });
});

export const DELETE = handleApi(async (req: NextRequest, ctx: Ctx) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await ctx.params;
  const campaign = await requireCampaign(user.id, id);

  const { markCampaignCancelled } = await import("@/lib/campaign");
  await markCampaignCancelled(campaign.id);

  await audit(prisma, {
    userId: user.id,
    action: "campaign.cancel",
    entityType: "Campaign",
    entityId: campaign.id,
  });

  return json({ ok: true, status: "CANCELLED" });
});
