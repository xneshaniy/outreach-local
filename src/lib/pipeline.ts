import { prisma } from "./db";
import { ApiError } from "./errors";

/**
 * The lead pipeline (a small, dependency-free CRM).
 *
 * Stages are configurable per workspace. A contact sits in one stage, has a
 * priority, can be owned by a member of the workspace, and can carry tasks
 * (reminders). A contact can be converted into a client account, which is the
 * "prospect became a customer" moment.
 *
 * No paid CRM dependency is introduced: the model is small and every query is
 * a plain indexed Prisma call.
 */

export const DEFAULT_STAGES: Array<{ name: string; color: string; isWon: boolean }> = [
  { name: "New", color: "#6366f1", isWon: false },
  { name: "Researched", color: "#0ea5e9", isWon: false },
  { name: "Contacted", color: "#f59e0b", isWon: false },
  { name: "Replied", color: "#8b5cf6", isWon: false },
  { name: "Qualified", color: "#10b981", isWon: false },
  { name: "Proposal", color: "#ec4899", isWon: false },
  { name: "Client", color: "#059669", isWon: true },
  { name: "Lost", color: "#6b7280", isWon: false },
];

/** Create the default stages when the workspace has none. Idempotent. */
export async function ensureDefaultStages(userId: string) {
  const existing = await prisma.leadStage.findMany({ where: { userId } });
  if (existing.length > 0) return existing;

  const created = [];
  for (const [index, stage] of DEFAULT_STAGES.entries()) {
    created.push(
      await prisma.leadStage.create({
        data: {
          userId,
          name: stage.name,
          order: index,
          color: stage.color,
          isWon: stage.isWon,
          isDefault: index === 0,
        },
      }),
    );
  }
  return created;
}

export async function listStages(userId: string) {
  await ensureDefaultStages(userId);
  return prisma.leadStage.findMany({
    where: { userId },
    orderBy: { order: "asc" },
    include: { _count: { select: { contacts: true } } },
  });
}

export async function stageByName(userId: string, name: string) {
  await ensureDefaultStages(userId);
  return prisma.leadStage.findFirst({ where: { userId, name } });
}

/** Move a contact to a stage and record it on the timeline. */
export async function moveContactToStage(input: {
  userId: string;
  contactId: string;
  stageId: string;
}): Promise<void> {
  const stage = await prisma.leadStage.findFirst({
    where: { id: input.stageId, userId: input.userId },
    select: { id: true, name: true },
  });
  if (!stage) throw ApiError.badRequest("That stage does not exist.");

  const contact = await prisma.contact.findFirst({
    where: { id: input.contactId, userId: input.userId },
    select: { id: true, stageId: true },
  });
  if (!contact) throw ApiError.notFound("Contact not found.");
  if (contact.stageId === stage.id) return;

  await prisma.contact.update({ where: { id: contact.id }, data: { stageId: stage.id } });
  const { recordActivity } = await import("./activity");
  await recordActivity({
    userId: input.userId,
    contactId: contact.id,
    type: "STAGE_CHANGED",
    summary: `Stage changed to ${stage.name}`,
    detail: { stageId: stage.id, stageName: stage.name },
  });
}

/**
 * Convert a prospect into a client.
 *
 * The contact is marked as converted and linked to the client account, so the
 * portal can show the history of the engagement that led there.
 */
export async function convertProspect(input: {
  userId: string;
  contactId: string;
  clientId: string;
}): Promise<void> {
  const client = await prisma.client.findFirst({
    where: { id: input.clientId, userId: input.userId },
    select: { id: true, name: true },
  });
  if (!client) throw ApiError.badRequest("That client does not exist.");

  const contact = await prisma.contact.findFirst({
    where: { id: input.contactId, userId: input.userId },
    select: { id: true },
  });
  if (!contact) throw ApiError.notFound("Contact not found.");

  await prisma.contact.update({
    where: { id: contact.id },
    data: { convertedAt: new Date(), convertedToClientId: client.id },
  });
  const { recordActivity } = await import("./activity");
  await recordActivity({
    userId: input.userId,
    contactId: contact.id,
    type: "CONVERTED",
    summary: `Converted to client ${client.name}`,
    detail: { clientId: client.id },
  });
}
