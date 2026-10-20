import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { requireContact, requireUser } from "@/lib/auth/guards";
import { contactCreateSchema } from "@/lib/validation";
import { normalizeEmail } from "@/lib/email-normalize";
import { audit } from "@/lib/audit";

/**
 * GET    /api/contacts/:id
 * PATCH  /api/contacts/:id
 * DELETE /api/contacts/:id — soft-delete via INVALID status (keeps audit trail).
 */
type Ctx = { params: Promise<{ id: string }> };

export const GET = handleApi(async (_req: NextRequest, ctx: Ctx) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  const contact = await requireContact(user.id, id);
  return json({ contact });
});

const patchSchema = contactCreateSchema.partial();

export const PATCH = handleApi(async (req: NextRequest, ctx: Ctx) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await ctx.params;
  const contact = await requireContact(user.id, id);
  const body = patchSchema.parse(await req.json());

  const updated = await prisma.contact.update({
    where: { id: contact.id },
    data: {
      ...(body.email !== undefined ? { email: body.email.trim(), emailNormalized: normalizeEmail(body.email) } : {}),
      ...(body.firstName !== undefined ? { firstName: body.firstName } : {}),
      ...(body.lastName !== undefined ? { lastName: body.lastName } : {}),
      ...(body.company !== undefined ? { company: body.company } : {}),
      ...(body.website !== undefined ? { website: body.website } : {}),
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.timeZone !== undefined ? { timeZone: body.timeZone } : {}),
      ...(body.country !== undefined ? { country: body.country } : {}),
      ...(body.consentAt !== undefined ? { consentAt: body.consentAt } : {}),
      ...(body.consentSource !== undefined ? { consentSource: body.consentSource } : {}),
    },
  });

  await audit(prisma, {
    userId: user.id,
    action: "contact.update",
    entityType: "Contact",
    entityId: contact.id,
  });

  return json({ contact: updated });
});

export const DELETE = handleApi(async (req: NextRequest, ctx: Ctx) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await ctx.params;
  const contact = await requireContact(user.id, id);

  await prisma.contact.update({ where: { id: contact.id }, data: { status: "INVALID" } });
  await prisma.sendJob.updateMany({
    where: { contactId: contact.id, status: "QUEUED" },
    data: { status: "CANCELLED" },
  });

  await audit(prisma, {
    userId: user.id,
    action: "contact.delete",
    entityType: "Contact",
    entityId: contact.id,
  });

  return json({ ok: true });
});
