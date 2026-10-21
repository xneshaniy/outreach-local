import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { requireUser } from "@/lib/auth/guards";
import { parseSegmentFilters, segmentCount } from "@/lib/segments";
import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/errors";
import { z } from "zod";

type Ctx = { params: Promise<{ id: string }> };

const updateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(500).nullish(),
  filters: z.record(z.unknown()).optional(),
});

export const PATCH = handleApi(async (req: NextRequest, ctx: Ctx) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await ctx.params;
  const body = updateSchema.parse(await req.json());

  const existing = await prisma.campaignSegment.findFirst({ where: { id, userId: user.id } });
  if (!existing) throw ApiError.notFound("Segment not found.");

  const filters = body.filters ? parseSegmentFilters(body.filters) : undefined;

  const segment = await prisma.campaignSegment.update({
    where: { id },
    data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(filters ? { filters: filters as never } : {}),
    },
  });

  await audit(prisma, {
    userId: user.id,
    action: "segment.update",
    entityType: "CampaignSegment",
    entityId: id,
  });

  return json({
    segment,
    count: filters ? await segmentCount(user.id, filters) : undefined,
  });
});

export const DELETE = handleApi(async (req: NextRequest, ctx: Ctx) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await ctx.params;

  const existing = await prisma.campaignSegment.findFirst({ where: { id, userId: user.id } });
  if (!existing) throw ApiError.notFound("Segment not found.");

  await prisma.campaignSegment.delete({ where: { id } });
  await audit(prisma, {
    userId: user.id,
    action: "segment.delete",
    entityType: "CampaignSegment",
    entityId: id,
  });
  return json({ ok: true });
});
