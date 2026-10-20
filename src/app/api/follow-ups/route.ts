import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { requireUser } from "@/lib/auth/guards";
import { followUpSequenceCreateSchema } from "@/lib/validation";
import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/errors";

/**
 * GET  /api/follow-ups — list the workspace's follow-up sequences.
 * POST /api/follow-ups — create a sequence (with its steps).
 */
export const GET = handleApi(async () => {
  const user = await requireUser();
  const sequences = await prisma.followUpSequence.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
    include: {
      service: { select: { id: true, name: true, color: true } },
      steps: { orderBy: { order: "asc" } },
      _count: { select: { messages: true, campaigns: true } },
    },
  });

  // The message counts per status, so the UI can show what is pending.
  const byStatus = await prisma.followUpMessage.groupBy({
    by: ["sequenceId", "status"],
    where: { userId: user.id },
    _count: { _all: true },
  });
  const statusBySequence: Record<string, Record<string, number>> = {};
  for (const row of byStatus) {
    (statusBySequence[row.sequenceId] ??= {})[row.status] = row._count._all;
  }

  return json({ sequences: sequences.map((s) => ({ ...s, statusCounts: statusBySequence[s.id] ?? {} })) });
});

export const POST = handleApi(async (req: NextRequest) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const body = followUpSequenceCreateSchema.parse(await req.json());

  if (body.serviceId) {
    const service = await prisma.service.findFirst({
      where: { id: body.serviceId, userId: user.id },
      select: { id: true },
    });
    if (!service) throw ApiError.badRequest("That service does not exist.");
  }

  // The step orders must be unique inside a sequence.
  const orders = body.steps.map((s) => s.order);
  if (new Set(orders).size !== orders.length) {
    throw ApiError.badRequest("Each follow-up step needs a unique position.");
  }

  const sequence = await prisma.followUpSequence.create({
    data: {
      userId: user.id,
      name: body.name,
      serviceId: body.serviceId ?? null,
      isActive: body.isActive,
      steps: {
        create: body.steps.map((s) => ({
          order: s.order,
          delayDays: s.delayDays,
          subject: s.subject,
          body: s.body,
        })),
      },
    },
    include: { steps: { orderBy: { order: "asc" } } },
  });

  await audit(prisma, {
    userId: user.id,
    action: "followup.create",
    entityType: "FollowUpSequence",
    entityId: sequence.id,
    metadata: { name: sequence.name, steps: body.steps.length },
  });

  return json({ sequence }, { status: 201 });
});
