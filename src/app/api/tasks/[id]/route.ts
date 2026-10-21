import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { requireUser } from "@/lib/auth/guards";
import { recordActivity } from "@/lib/activity";
import { ApiError } from "@/lib/errors";
import { z } from "zod";

type Ctx = { params: Promise<{ id: string }> };

const updateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  notes: z.string().max(5000).nullish(),
  dueAt: z.coerce.date().nullish(),
  status: z.enum(["OPEN", "DONE", "CANCELLED"]).optional(),
});

export const PATCH = handleApi(async (req: NextRequest, ctx: Ctx) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await ctx.params;
  const body = updateSchema.parse(await req.json());

  const existing = await prisma.task.findFirst({ where: { id, userId: user.id } });
  if (!existing) throw ApiError.notFound("Task not found.");

  const task = await prisma.task.update({
    where: { id },
    data: {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
      ...(body.dueAt !== undefined ? { dueAt: body.dueAt } : {}),
      ...(body.status !== undefined
        ? {
            status: body.status,
            completedAt: body.status === "DONE" ? new Date() : null,
          }
        : {}),
    },
  });

  if (body.status === "DONE" && task.contactId) {
    await recordActivity({
      userId: user.id,
      contactId: task.contactId,
      type: "TASK_COMPLETED",
      summary: `Task completed: ${task.title}`,
      detail: { taskId: task.id },
    });
  }

  return json({ task });
});

export const DELETE = handleApi(async (req: NextRequest, ctx: Ctx) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await ctx.params;

  const existing = await prisma.task.findFirst({ where: { id, userId: user.id } });
  if (!existing) throw ApiError.notFound("Task not found.");

  await prisma.task.delete({ where: { id } });
  return json({ ok: true });
});
