import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { requireContact, requireUser } from "@/lib/auth/guards";
import { contactUpdateSchema } from "@/lib/validation";
import { audit } from "@/lib/audit";
import { cancelFollowUpsForContactEverywhere } from "@/lib/followup";

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
  const [replies, followUps, campaigns] = await Promise.all([
    prisma.reply.findMany({
      where: { contactId: id },
      orderBy: { receivedAt: "desc" },
      take: 20,
    }),
    prisma.followUpMessage.findMany({
      where: { contactId: id },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: {
        step: { select: { order: true, subject: true } },
        campaign: { select: { id: true, name: true } },
      },
    }),
    prisma.campaignRecipient.findMany({
      where: { contactId: id },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: { campaign: { select: { id: true, name: true, status: true } } },
    }),
  ]);
  return json({ contact, replies, followUps, campaigns });
});

export const PATCH = handleApi(async (req: NextRequest, ctx: Ctx) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await ctx.params;
  const contact = await requireContact(user.id, id);
  const body = contactUpdateSchema.parse(await req.json());

  const updated = await prisma.contact.update({
    where: { id: contact.id },
    data: {
      ...(body.firstName !== undefined ? { firstName: body.firstName } : {}),
      ...(body.lastName !== undefined ? { lastName: body.lastName } : {}),
      ...(body.company !== undefined ? { company: body.company } : {}),
      ...(body.website !== undefined ? { website: body.website } : {}),
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.timeZone !== undefined ? { timeZone: body.timeZone } : {}),
      ...(body.country !== undefined ? { country: body.country } : {}),
      ...(body.source !== undefined ? { source: body.source } : {}),
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
      ...(body.tags !== undefined ? { tags: body.tags ?? [] } : {}),
      ...(body.consentAt !== undefined ? { consentAt: body.consentAt } : {}),
      ...(body.consentSource !== undefined ? { consentSource: body.consentSource } : {}),
    },
  });

  // Marking a contact as unsubscribed must stop every pending message.
  if (updated.status === "UNSUBSCRIBED" || updated.status === "INVALID") {
    await cancelFollowUpsForContactEverywhere(contact.id, `Contact marked ${updated.status}.`);
    await prisma.sendJob.updateMany({
      where: { userId: user.id, contactId: contact.id, status: "QUEUED" },
      data: { status: "CANCELLED" },
    });
  }

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
  await cancelFollowUpsForContactEverywhere(contact.id, "The contact was deleted.");

  await audit(prisma, {
    userId: user.id,
    action: "contact.delete",
    entityType: "Contact",
    entityId: contact.id,
  });

  return json({ ok: true });
});
