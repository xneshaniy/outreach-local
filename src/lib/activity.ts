import { prisma } from "./db";
import { logger } from "./logger";

/**
 * The contact activity timeline.
 *
 * Every meaningful thing that happened to a contact is recorded here, so the
 * contact page can show one chronological list instead of the operator having
 * to piece it together from the queue, the replies and the audit log.
 */

export type ActivityType =
  | "CREATED"
  | "IMPORTED"
  | "UPDATED"
  | "EMAIL_SENT"
  | "EMAIL_OPENED"
  | "EMAIL_CLICKED"
  | "REPLIED"
  | "UNSUBSCRIBED"
  | "BOUNCED"
  | "SUPPRESSED"
  | "STAGE_CHANGED"
  | "PRIORITY_CHANGED"
  | "OWNER_CHANGED"
  | "NOTE_ADDED"
  | "TASK_COMPLETED"
  | "CONVERTED";

/** Record an activity. Never throws. */
export async function recordActivity(input: {
  userId: string;
  contactId: string;
  type: ActivityType;
  summary: string;
  detail?: Record<string, unknown> | null;
}): Promise<void> {
  try {
    await prisma.contactActivity.create({
      data: {
        userId: input.userId,
        contactId: input.contactId,
        type: input.type,
        summary: input.summary.slice(0, 500),
        detail: (input.detail ?? undefined) as never,
      },
    });
  } catch (err) {
    logger.warn("Could not record contact activity", {
      contactId: input.contactId,
      type: input.type,
      error: (err as Error).message,
    });
  }
}

export async function listActivity(
  contactId: string,
  options: { limit?: number } = {},
): Promise<unknown[]> {
  const limit = Math.min(200, Math.max(1, options.limit ?? 50));
  return prisma.contactActivity.findMany({
    where: { contactId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

/** Add a free-text note to a contact and record it on the timeline. */
export async function addNote(input: {
  userId: string;
  contactId: string;
  body: string;
}): Promise<{ id: string; body: string; createdAt: Date }> {
  const note = await prisma.contactNote.create({
    data: { userId: input.userId, contactId: input.contactId, body: input.body },
    select: { id: true, body: true, createdAt: true },
  });
  await recordActivity({
    userId: input.userId,
    contactId: input.contactId,
    type: "NOTE_ADDED",
    summary: "Note added",
    detail: { noteId: note.id },
  });
  return note;
}

export async function listNotes(contactId: string): Promise<unknown[]> {
  return prisma.contactNote.findMany({
    where: { contactId },
    orderBy: { createdAt: "desc" },
  });
}
