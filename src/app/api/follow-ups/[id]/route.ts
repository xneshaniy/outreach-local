import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { requireUser } from "@/lib/auth/guards";
import { followUpSequenceUpdateSchema } from "@/lib/validation";
import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/errors";

/**
 * GET    /api/follow-ups/:id — one sequence with its steps and recent messages.
 * PATCH  /api/follow-ups/:id — update the sequence (replaces the steps).
 * DELETE /api/follow-ups/:id — delete it (campaigns keep working, the link
 *         is removed).
 */
export const GET = handleApi(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await ctx.params;

  const sequence = await prisma.followUpSequence.findFirst({
    where: { id, userId: user.id },
    include: {
      service: { select: { id: true, name: true, color: true } },
      steps: { orderBy: { order: "asc" } },
      campaigns: { select: { id: true, name: true, status: true } },
      messages: {
        take: 50,
        orderBy: { createdAt: "desc" },
        include: {
          contact: { select: { id: true, email: true, firstName: true, lastName: true } },
          step: { select: { order: true, subject: true } },
        },
      },
    },
  });
  if (!sequence) throw ApiError.notFound("Follow-up sequence not found.");
  return json({ sequence });
});

export const PATCH = handleApi(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await ctx.params;
  const body = followUpSequenceUpdateSchema.parse(await req.json());

  const existing = await prisma.followUpSequence.findFirst({ where: { id, userId: user.id } });
  if (!existing) throw ApiError.notFound("Follow-up sequence not found.");

  if (body.serviceId) {
    const service = await prisma.service.findFirst({
      where: { id: body.serviceId, userId: user.id },
      select: { id: true },
    });
    if (!service) throw ApiError.badRequest("That service does not exist.");
  }

  const sequence = await prisma.$transaction(async (tx) => {
    if (body.steps) {
      const orders = body.steps.map((s) => s.order);
      if (new Set(orders).size !== orders.length) {
        throw ApiError.badRequest("Each follow-up step needs a unique position.");
      }
      // Replace the steps. Steps that already have scheduled messages are
      // kept (their messages reference them), so we only delete the ones
      // that were never used.
      const used = await tx.followUpMessage.findMany({
        where: { sequenceId: id },
        distinct: ["stepId"],
        select: { stepId: true },
      });
      const usedIds = new Set(used.map((u) => u.stepId));
      const keepIds = new Set<string>();
      for (const step of body.steps) {
        const created = await tx.followUpStep.create({
          data: {
            sequenceId: id,
            order: step.order,
            delayDays: step.delayDays,
            subject: step.subject,
            body: step.body,
          },
        });
        keepIds.add(created.id);
      }
      const removable = [...usedIds].filter((stepId) => !keepIds.has(stepId));
      if (removable.length > 0) {
        await tx.followUpStep.deleteMany({ where: { id: { in: removable } } });
      }
    }

    return tx.followUpSequence.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.serviceId !== undefined ? { serviceId: body.serviceId } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      },
      include: { steps: { orderBy: { order: "asc" } } },
    });
  });

  await audit(prisma, {
    userId: user.id,
    action: "followup.update",
    entityType: "FollowUpSequence",
    entityId: id,
  });
  return json({ sequence });
});

export const DELETE = handleApi(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await ctx.params;

  const existing = await prisma.followUpSequence.findFirst({ where: { id, userId: user.id } });
  if (!existing) throw ApiError.notFound("Follow-up sequence not found.");

  await prisma.followUpSequence.delete({ where: { id } });
  await audit(prisma, {
    userId: user.id,
    action: "followup.delete",
    entityType: "FollowUpSequence",
    entityId: id,
  });
  return json({ ok: true });
});
