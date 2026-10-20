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
  return json({ template });
});

export const PATCH = handleApi(async (req: NextRequest, ctx: Ctx) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await ctx.params;
  const template = await requireTemplate(user.id, id);
  const body = templateSchema.partial().parse(await req.json());

  const updated = await prisma.emailTemplate.update({
    where: { id: template.id },
    data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.subject !== undefined ? { subject: body.subject } : {}),
      ...(body.body !== undefined ? { body: body.body } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
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
