import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { requireUser } from "@/lib/auth/guards";
import { z } from "zod";
import { recordActivity } from "@/lib/activity";
import { notify } from "@/lib/notifications";
import { ApiError } from "@/lib/errors";

/**
 * GET  /api/tasks — the task list (open tasks first, then by due date).
 * POST /api/tasks — create a task / reminder.
 */
export const GET = handleApi(async (req: NextRequest) => {
  const user = await requireUser();
  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? "OPEN";
  const contactId = url.searchParams.get("contactId");

  const tasks = await prisma.task.findMany({
    where: {
      userId: user.id,
      ...(status !== "ALL" ? { status: status as never } : {}),
      ...(contactId ? { contactId } : {}),
    },
    orderBy: [{ status: "asc" }, { dueAt: "asc" }, { createdAt: "desc" }],
    take: 200,
    include: {
      contact: { select: { id: true, email: true, firstName: true, lastName: true, company: true } },
      campaign: { select: { id: true, name: true } },
    },
  });

  return json({ tasks });
});

const createSchema = z.object({
  title: z.string().min(1).max(200),
  notes: z.string().max(5000).nullish(),
  contactId: z.string().cuid().nullish(),
  campaignId: z.string().cuid().nullish(),
  dueAt: z.coerce.date().nullish(),
});

export const POST = handleApi(async (req: NextRequest) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const body = createSchema.parse(await req.json());

  if (body.contactId) {
    const contact = await prisma.contact.findFirst({
      where: { id: body.contactId, userId: user.id },
      select: { id: true },
    });
    if (!contact) throw ApiError.badRequest("That contact does not exist.");
  }

  const task = await prisma.task.create({
    data: {
      userId: user.id,
      title: body.title,
      notes: body.notes ?? null,
      contactId: body.contactId ?? null,
      campaignId: body.campaignId ?? null,
      dueAt: body.dueAt ?? null,
    },
  });

  if (body.contactId) {
    await recordActivity({
      userId: user.id,
      contactId: body.contactId,
      type: "UPDATED",
      summary: `Task created: ${body.title}`,
      detail: { taskId: task.id },
    });
  }

  // A task that is already overdue is worth a notification straight away.
  if (task.dueAt && task.dueAt.getTime() <= Date.now()) {
    await notify({
      userId: user.id,
      type: "TASK_DUE",
      title: `Task due: ${task.title}`,
      body: "This task was already overdue when it was created.",
      link: "/pipeline",
      entityType: "Task",
      entityId: task.id,
    });
  }

  return json({ task }, { status: 201 });
});
