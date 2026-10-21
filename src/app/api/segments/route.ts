import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { requireUser } from "@/lib/auth/guards";
import { parseSegmentFilters, segmentCount } from "@/lib/segments";
import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/errors";
import { z } from "zod";

/**
 * GET  /api/segments — the saved audience segments.
 * POST /api/segments — save a new segment.
 */
export const GET = handleApi(async () => {
  const user = await requireUser();
  const segments = await prisma.campaignSegment.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { campaigns: true } } },
  });
  return json({ segments });
});

const createSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).nullish(),
  filters: z.record(z.unknown()),
});

export const POST = handleApi(async (req: NextRequest) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const body = createSchema.parse(await req.json());

  const filters = parseSegmentFilters(body.filters);
  const existing = await prisma.campaignSegment.findFirst({
    where: { userId: user.id, name: body.name },
    select: { id: true },
  });
  if (existing) throw ApiError.conflict("A segment with that name already exists.");

  const segment = await prisma.campaignSegment.create({
    data: {
      userId: user.id,
      name: body.name,
      description: body.description ?? null,
      filters: filters as never,
    },
  });

  await audit(prisma, {
    userId: user.id,
    action: "segment.create",
    entityType: "CampaignSegment",
    entityId: segment.id,
    metadata: { name: segment.name },
  });

  return json({ segment, count: await segmentCount(user.id, filters) }, { status: 201 });
});
