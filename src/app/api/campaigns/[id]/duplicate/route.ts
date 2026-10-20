import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { requireCampaign, requireUser } from "@/lib/auth/guards";
import { z } from "zod";
import { audit } from "@/lib/audit";

/**
 * POST /api/campaigns/:id/duplicate — clone a campaign as a new DRAFT.
 * Recipients are copied ONLY when `includeContacts` is true; membership is
 * still protected by UNIQUE (campaignId, contactId) in the new campaign.
 */
type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  includeContacts: z.boolean().default(false),
});

export const POST = handleApi(async (req: NextRequest, ctx: Ctx) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await ctx.params;
  const source = await requireCampaign(user.id, id);
  const body = bodySchema.parse(await req.json());

  const copy = await prisma.$transaction(async (tx) => {
    const campaign = await tx.campaign.create({
      data: {
        userId: user.id,
        name: body.name ?? `${source.name} (copy)`,
        subject: source.subject,
        body: source.body,
        templateId: source.templateId,
        fromName: source.fromName,
        replyTo: source.replyTo,
        windowStartMinute: source.windowStartMinute,
        windowEndMinute: source.windowEndMinute,
        sendingDays: source.sendingDays,
        timeZoneFallback: source.timeZoneFallback,
        fallbackTimeZone: source.fallbackTimeZone,
        dailyLimit: source.dailyLimit,
      },
    });

    if (body.includeContacts) {
      const recipients = await tx.campaignRecipient.findMany({
        where: { campaignId: source.id },
        select: { contactId: true },
      });
      await tx.campaignRecipient.createMany({
        data: recipients.map((r) => ({ campaignId: campaign.id, contactId: r.contactId })),
        skipDuplicates: true,
      });
    }
    return campaign;
  });

  await audit(prisma, {
    userId: user.id,
    action: "campaign.duplicate",
    entityType: "Campaign",
    entityId: copy.id,
    metadata: { sourceCampaignId: source.id, includeContacts: body.includeContacts },
  });

  return json({ campaign: copy }, { status: 201 });
});
