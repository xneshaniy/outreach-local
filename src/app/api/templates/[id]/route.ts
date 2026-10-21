import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { requireTemplate, requireUser } from "@/lib/auth/guards";
import { templateSchema } from "@/lib/validation";
import { audit } from "@/lib/audit";

/** GET/PATCH/DELETE /api/templates/:id */
type Ctx = { params: Promise<{ id: string }> };

export const GET = handleApi(async (_req: NextRequest, ctx: Ctx) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  const template = await requireTemplate(user.id, id);
  const versions = await prisma.templateVersion.findMany({
    where: { templateId: template.id },
    orderBy: { version: "desc" },
    take: 20,
    select: { id: true, version: true, subject: true, createdAt: true },
  });
  return json({ template, versions });
});

export const PATCH = handleApi(async (req: NextRequest, ctx: Ctx) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await ctx.params;
  const template = await requireTemplate(user.id, id);
  const body = templateSchema.partial().parse(await req.json());

  // The previous contents are kept so a template can be rolled back and the
  // history is auditable. The version counter is bumped on every change.
  const contentChanged =
    (body.subject !== undefined && body.subject !== template.subject) ||
    (body.body !== undefined && body.body !== template.body) ||
    (body.plainTextBody !== undefined && body.plainTextBody !== template.plainTextBody);

  if (contentChanged) {
    await prisma.templateVersion.create({
      data: {
        templateId: template.id,
        version: template.version,
        subject: template.subject,
        body: template.body,
        plainTextBody: template.plainTextBody,
      },
    });
  }

  const updated = await prisma.emailTemplate.update({
    where: { id: template.id },
    data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.subject !== undefined ? { subject: body.subject } : {}),
      ...(body.body !== undefined ? { body: body.body } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.category !== undefined ? { category: body.category } : {}),
      ...(body.plainTextBody !== undefined ? { plainTextBody: body.plainTextBody } : {}),
      ...(body.signature !== undefined ? { signature: body.signature } : {}),
      ...(body.serviceId !== undefined ? { serviceId: body.serviceId } : {}),
      ...(contentChanged ? { version: { increment: 1 } } : {}),
    },
  });

  await audit(prisma, {
    userId: user.id,
    action: "template.update",
    entityType: "EmailTemplate",
    entityId: template.id,
  });

  return json({ template: updated });
});

export const DELETE = handleApi(async (req: NextRequest, ctx: Ctx) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await ctx.params;
  const template = await requireTemplate(user.id, id);

  // Campaigns keep their own snapshot; templateId becomes null.
  await prisma.emailTemplate.delete({ where: { id: template.id } });

  await audit(prisma, {
    userId: user.id,
    action: "template.delete",
    entityType: "EmailTemplate",
    entityId: template.id,
  });

  return json({ ok: true });
});
