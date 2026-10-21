import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { requireUser } from "@/lib/auth/guards";
import { audit } from "@/lib/audit";
import { recordActivity } from "@/lib/activity";
import { ApiError } from "@/lib/errors";
import { z } from "zod";

/**
 * Bulk contact updates.
 *
 * Two steps, on purpose:
 *   1. POST { mode: "preview", ids, changes } — shows exactly which contacts
 *      would change and what would happen, without touching anything.
 *   2. POST { mode: "apply", ids, changes }   — applies it.
 *
 * Nothing is ever overwritten silently: a preview always comes first, and the
 * response of the apply step reports exactly what changed.
 */

const changesSchema = z.object({
  stageId: z.string().cuid().nullish(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).nullish(),
  source: z.string().max(200).nullish(),
  industry: z.string().max(200).nullish(),
  notes: z.string().max(5000).nullish(),
  ownerId: z.string().cuid().nullish(),
  isArchived: z.boolean().nullish(),
  /** Add these tags (the existing ones are kept). */
  addTags: z.array(z.string().min(1).max(60)).max(50).nullish(),
  /** Remove these tags. */
  removeTags: z.array(z.string().min(1).max(60)).max(50).nullish(),
  /** Replace the whole tag list. */
  setTags: z.array(z.string().min(1).max(60)).max(50).nullish(),
});

const bodySchema = z.object({
  mode: z.enum(["preview", "apply"]),
  ids: z.array(z.string().cuid()).min(1).max(2000),
  changes: changesSchema,
});

export const POST = handleApi(async (req: NextRequest) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const body = bodySchema.parse(await req.json());

  if (body.changes.stageId) {
    const stage = await prisma.leadStage.findFirst({
      where: { id: body.changes.stageId, userId: user.id },
      select: { id: true },
    });
    if (!stage) throw ApiError.badRequest("That stage does not exist.");
  }
  if (body.changes.ownerId) {
    const owner = await prisma.user.findFirst({
      where: { id: body.changes.ownerId },
      select: { id: true },
    });
    if (!owner) throw ApiError.badRequest("That owner does not exist.");
  }

  const contacts = await prisma.contact.findMany({
    where: { id: { in: body.ids }, userId: user.id },
    select: {
      id: true,
      email: true,
      stageId: true,
      priority: true,
      source: true,
      industry: true,
      notes: true,
      ownerId: true,
      isArchived: true,
      tags: true,
    },
  });

  const missing = body.ids.filter((id) => !contacts.some((c) => c.id === id));

  // --- Preview --------------------------------------------------------------
  if (body.mode === "preview") {
    const changes = body.changes;
    const preview = contacts.map((c) => {
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};

      if (changes.stageId !== undefined && changes.stageId !== null && changes.stageId !== c.stageId) {
        before.stageId = c.stageId;
        after.stageId = changes.stageId;
      }
      if (changes.priority !== undefined && changes.priority !== null && changes.priority !== c.priority) {
        before.priority = c.priority;
        after.priority = changes.priority;
      }
      if (changes.source !== undefined && changes.source !== null && changes.source !== c.source) {
        before.source = c.source;
        after.source = changes.source;
      }
      if (changes.industry !== undefined && changes.industry !== null && changes.industry !== c.industry) {
        before.industry = c.industry;
        after.industry = changes.industry;
      }
      if (changes.notes !== undefined && changes.notes !== null && changes.notes !== c.notes) {
        before.notes = c.notes;
        after.notes = changes.notes;
      }
      if (changes.ownerId !== undefined && changes.ownerId !== null && changes.ownerId !== c.ownerId) {
        before.ownerId = c.ownerId;
        after.ownerId = changes.ownerId;
      }
      if (changes.isArchived !== undefined && changes.isArchived !== c.isArchived) {
        before.isArchived = c.isArchived;
        after.isArchived = changes.isArchived;
      }
      if (changes.setTags) {
        before.tags = c.tags;
        after.tags = changes.setTags;
      } else if (changes.addTags?.length || changes.removeTags?.length) {
        const set = new Set(c.tags);
        for (const t of changes.addTags ?? []) set.add(t);
        for (const t of changes.removeTags ?? []) set.delete(t);
        before.tags = c.tags;
        after.tags = [...set];
      }

      return {
        id: c.id,
        email: c.email,
        changed: Object.keys(after).length > 0,
        before,
        after,
      };
    });

    return json({
      mode: "preview",
      matched: contacts.length,
      missing,
      changed: preview.filter((p) => p.changed).length,
      preview,
    });
  }

  // --- Apply ----------------------------------------------------------------
  const changes = body.changes;
  let updated = 0;

  for (const contact of contacts) {
    const data: Record<string, unknown> = {};

    if (changes.stageId !== undefined && changes.stageId !== null) data.stageId = changes.stageId;
    if (changes.priority !== undefined && changes.priority !== null) data.priority = changes.priority;
    if (changes.source !== undefined && changes.source !== null) data.source = changes.source;
    if (changes.industry !== undefined && changes.industry !== null) data.industry = changes.industry;
    if (changes.notes !== undefined && changes.notes !== null) data.notes = changes.notes;
    if (changes.ownerId !== undefined && changes.ownerId !== null) data.ownerId = changes.ownerId;
    if (changes.isArchived !== undefined) data.isArchived = changes.isArchived;

    if (changes.setTags) {
      data.tags = changes.setTags;
    } else if (changes.addTags?.length || changes.removeTags?.length) {
      const set = new Set(contact.tags);
      for (const t of changes.addTags ?? []) set.add(t);
      for (const t of changes.removeTags ?? []) set.delete(t);
      data.tags = [...set];
    }

    if (Object.keys(data).length === 0) continue;

    await prisma.contact.update({ where: { id: contact.id }, data: data as never });
    updated += 1;

    await recordActivity({
      userId: user.id,
      contactId: contact.id,
      type: changes.stageId ? "STAGE_CHANGED" : changes.ownerId ? "OWNER_CHANGED" : changes.priority ? "PRIORITY_CHANGED" : "UPDATED",
      summary: "Bulk update",
      detail: { changes: data },
    });
  }

  await audit(prisma, {
    userId: user.id,
    action: "contact.bulk_update",
    entityType: "Contact",
    metadata: { requested: body.ids.length, matched: contacts.length, updated },
  });

  return json({ mode: "apply", updated, missing });
});
