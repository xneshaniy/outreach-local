import { NextRequest } from "next/server";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { requireUser } from "@/lib/auth/guards";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/errors";
import { z } from "zod";

type Ctx = { params: Promise<{ id: string }> };

const updateSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  order: z.number().int().min(0).max(100).optional(),
  isWon: z.boolean().optional(),
  isDefault: z.boolean().optional(),
});

export const PATCH = handleApi(async (req: NextRequest, ctx: Ctx) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await ctx.params;
  const body = updateSchema.parse(await req.json());

  const existing = await prisma.leadStage.findFirst({ where: { id, userId: user.id } });
  if (!existing) throw ApiError.notFound("Stage not found.");

  if (body.isDefault === true) {
    await prisma.leadStage.updateMany({ where: { userId: user.id }, data: { isDefault: false } });
  }

  const stage = await prisma.leadStage.update({ where: { id }, data: body });

  await audit(prisma, {
    userId: user.id,
    action: "pipeline.stage_update",
    entityType: "LeadStage",
    entityId: id,
  });

  return json({ stage });
});

export const DELETE = handleApi(async (req: NextRequest, ctx: Ctx) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await ctx.params;

  const existing = await prisma.leadStage.findFirst({ where: { id, userId: user.id } });
  if (!existing) throw ApiError.notFound("Stage not found.");

  // Contacts in this stage lose the link rather than being deleted.
  await prisma.leadStage.delete({ where: { id } });

  await audit(prisma, {
    userId: user.id,
    action: "pipeline.stage_delete",
    entityType: "LeadStage",
    entityId: id,
  });

  return json({ ok: true });
});
