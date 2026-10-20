import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { requireUser } from "@/lib/auth/guards";
import { replyUpdateSchema } from "@/lib/validation";
import { applyReplyToContact } from "@/lib/replies";
import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/errors";

/**
 * PATCH /api/replies/:id — mark a reply as read, classify it, or attach it to
 *                       a contact manually.
 */
export const PATCH = handleApi(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await ctx.params;
  const body = replyUpdateSchema.parse(await req.json());

  const reply = await prisma.reply.findFirst({ where: { id, userId: user.id } });
  if (!reply) throw ApiError.notFound("Reply not found.");

  if (body.contactId) {
    const contact = await prisma.contact.findFirst({
      where: { id: body.contactId, userId: user.id },
      select: { id: true },
    });
    if (!contact) throw ApiError.badRequest("That contact does not exist.");
  }

  const updated = await prisma.reply.update({
    where: { id },
    data: {
      ...(body.isRead !== undefined ? { isRead: body.isRead } : {}),
      ...(body.outcome !== undefined ? { outcome: body.outcome } : {}),
      ...(body.contactId !== undefined ? { contactId: body.contactId } : {}),
    },
    include: {
      contact: { select: { id: true, email: true, firstName: true, lastName: true, status: true } },
      campaign: { select: { id: true, name: true } },
    },
  });

  // A reply means the conversation is alive: stop the follow-up sequence.
  if (body.contactId ?? reply.contactId) {
    await applyReplyToContact(user.id, (body.contactId ?? reply.contactId)!);
  }

  await audit(prisma, {
    userId: user.id,
    action: "reply.update",
    entityType: "Reply",
    entityId: id,
    metadata: { isRead: body.isRead, outcome: body.outcome },
  });

  return json({ reply: updated });
});
