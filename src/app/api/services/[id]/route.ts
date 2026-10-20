import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { requireUser } from "@/lib/auth/guards";
import { serviceUpdateSchema } from "@/lib/validation";
import { uniqueServiceSlug } from "@/lib/services";
import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/errors";

/**
 * GET    /api/services/:id — one service profile.
 * PATCH  /api/services/:id — update it.
 * DELETE /api/services/:id — delete it (campaigns/templates are kept).
 */
export const GET = handleApi(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await ctx.params;

  const service = await prisma.service.findFirst({
    where: { id, userId: user.id },
    include: {
      _count: { select: { campaigns: true, templates: true, sequences: true } },
      campaigns: {
        select: { id: true, name: true, status: true, isArchived: true },
        orderBy: { updatedAt: "desc" },
        take: 20,
      },
      templates: { select: { id: true, name: true, subject: true }, take: 20 },
    },
  });
  if (!service) throw ApiError.notFound("Service not found.");
  return json({ service });
});

export const PATCH = handleApi(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await ctx.params;
  const body = serviceUpdateSchema.parse(await req.json());

  const existing = await prisma.service.findFirst({ where: { id, userId: user.id } });
  if (!existing) throw ApiError.notFound("Service not found.");

  const data: Record<string, unknown> = { ...body };
  if (body.name && body.name !== existing.name) {
    data.slug = await uniqueServiceSlug(user.id, body.name, id);
  }

  const service = await prisma.service.update({ where: { id }, data });

  await audit(prisma, {
    userId: user.id,
    action: "service.update",
    entityType: "Service",
    entityId: id,
  });
  return json({ service });
});

export const DELETE = handleApi(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await ctx.params;

  const existing = await prisma.service.findFirst({ where: { id, userId: user.id } });
  if (!existing) throw ApiError.notFound("Service not found.");

  await prisma.service.delete({ where: { id } });
  await audit(prisma, {
    userId: user.id,
    action: "service.delete",
    entityType: "Service",
    entityId: id,
  });
  return json({ ok: true });
});
