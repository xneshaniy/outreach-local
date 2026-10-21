import { NextRequest } from "next/server";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { requireUser } from "@/lib/auth/guards";
import { listStages } from "@/lib/pipeline";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/errors";
import { z } from "zod";

/**
 * GET  /api/pipeline/stages — the pipeline stages (created on first use).
 * POST /api/pipeline/stages — add a stage.
 */
export const GET = handleApi(async () => {
  const user = await requireUser();
  const stages = await listStages(user.id);
  return json({ stages });
});

const createSchema = z.object({
  name: z.string().min(1).max(60),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#6366f1"),
  isWon: z.boolean().default(false),
});

export const POST = handleApi(async (req: NextRequest) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const body = createSchema.parse(await req.json());

  const existing = await prisma.leadStage.findFirst({ where: { userId: user.id, name: body.name } });
  if (existing) throw ApiError.conflict("A stage with that name already exists.");

  const max = await prisma.leadStage.aggregate({ where: { userId: user.id }, _max: { order: true } });
  const stage = await prisma.leadStage.create({
    data: {
      userId: user.id,
      name: body.name,
      color: body.color,
      isWon: body.isWon,
      order: (max._max.order ?? -1) + 1,
    },
  });

  await audit(prisma, {
    userId: user.id,
    action: "pipeline.stage_create",
    entityType: "LeadStage",
    entityId: stage.id,
    metadata: { name: stage.name },
  });

  return json({ stage }, { status: 201 });
});
