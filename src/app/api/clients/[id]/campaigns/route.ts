import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { requireUser } from "@/lib/auth/guards";
import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/errors";
import { z } from "zod";

/**
 * GET  /api/clients/:id/campaigns — the campaigns assigned to a client.
 * POST /api/clients/:id/campaigns — assign a campaign to a client.
 *
 * Assignment is explicit and one-way: a client only ever sees a campaign
 * that appears here.
 */
type Ctx = { params: Promise<{ id: string }> };

const assignSchema = z.object({
  campaignId: z.string().cuid(),
});

export const GET = handleApi(async (_req: NextRequest, ctx: Ctx) => {
  const user = await requireUser();
  const { id } = await ctx.params;

  const client = await prisma.client.findFirst({ where: { id, userId: user.id } });
  if (!client) throw ApiError.notFound("Client not found.");

  const access = await prisma.clientCampaignAccess.findMany({
    where: { clientId: id },
    select: {
      id: true,
      campaignId: true,
      campaign: { select: { id: true, name: true, status: true, isArchived: true, createdAt: true } },
    },
  });

  return json({ assignments: access });
});

export const POST = handleApi(async (req: NextRequest, ctx: Ctx) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await ctx.params;
  const body = assignSchema.parse(await req.json());

  const client = await prisma.client.findFirst({ where: { id, userId: user.id } });
  if (!client) throw ApiError.notFound("Client not found.");

  // The campaign must belong to this workspace.
  const campaign = await prisma.campaign.findFirst({
    where: { id: body.campaignId, userId: user.id },
    select: { id: true, name: true },
  });
  if (!campaign) throw ApiError.notFound("Campaign not found.");

  const assignment = await prisma.clientCampaignAccess.upsert({
    where: { clientId_campaignId: { clientId: id, campaignId: body.campaignId } },
    create: { clientId: id, campaignId: body.campaignId },
    update: {},
    select: { id: true, clientId: true, campaignId: true, createdAt: true },
  });

  await audit(prisma, {
    userId: user.id,
    action: "client.assign_campaign",
    entityType: "Client",
    entityId: id,
    metadata: { campaignId: body.campaignId, campaignName: campaign.name },
  });

  return json({ assignment }, { status: 201 });
});

export const DELETE = handleApi(async (req: NextRequest, ctx: Ctx) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await ctx.params;
  const campaignId = new URL(req.url).searchParams.get("campaignId");
  if (!campaignId) throw ApiError.badRequest("A campaignId is required.");

  const client = await prisma.client.findFirst({ where: { id, userId: user.id } });
  if (!client) throw ApiError.notFound("Client not found.");

  await prisma.clientCampaignAccess.deleteMany({ where: { clientId: id, campaignId } });

  await audit(prisma, {
    userId: user.id,
    action: "client.unassign_campaign",
    entityType: "Client",
    entityId: id,
    metadata: { campaignId },
  });

  return json({ ok: true });
});
