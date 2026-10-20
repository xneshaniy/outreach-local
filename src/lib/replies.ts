import { prisma } from "./db";
import { logger } from "./logger";
import { normalizeEmail } from "./email-normalize";
import { cancelFollowUpsForContactEverywhere } from "./followup";

/**
 * Reply tracking.
 *
 * Replies are matched to a contact by the sender address and to a campaign by
 * the most recent message we sent to that contact. A reply automatically:
 *
 *   - marks the contact REPLIED,
 *   - cancels every pending follow-up for that contact,
 *   - cancels the queued job for that contact (so we never send after a reply).
 *
 * The Gmail integration is real: it calls `users.messages.list` on the inbox
 * and `users.messages.get` for each candidate, using the refresh token that
 * was granted at connect time (the app requests the `gmail.readonly` scope).
 * SMTP accounts cannot be polled, so replies for them must be added manually
 * — that limitation is surfaced in the UI rather than hidden.
 */

export type IncomingReply = {
  messageId: string;
  fromEmail: string;
  toEmail: string;
  subject: string;
  snippet: string;
  body: string;
  receivedAt: Date;
};

export type ReplyMatch = {
  contactId: string | null;
  campaignId: string | null;
};

/**
 * Find the contact and the campaign a reply belongs to.
 *
 * The campaign is resolved from the newest SENT job for that contact, which
 * is the message the reply most likely answers.
 */
export async function matchReply(userId: string, fromEmail: string): Promise<ReplyMatch> {
  const emailNormalized = normalizeEmail(fromEmail);
  if (!emailNormalized) return { contactId: null, campaignId: null };

  const contact = await prisma.contact.findUnique({
    where: { userId_emailNormalized: { userId, emailNormalized } },
    select: { id: true },
  });
  if (!contact) return { contactId: null, campaignId: null };

  const lastJob = await prisma.sendJob.findFirst({
    where: { userId, contactId: contact.id, status: "SENT" },
    orderBy: { updatedAt: "desc" },
    select: { campaignId: true },
  });

  return { contactId: contact.id, campaignId: lastJob?.campaignId ?? null };
}

/**
 * Record a reply and apply its side effects.
 * Idempotent: the same provider message id is stored only once.
 */
export async function recordReply(input: {
  userId: string;
  provider: string;
  senderAccountId?: string | null;
  messageId: string;
  fromEmail: string;
  toEmail: string;
  subject?: string | null;
  snippet?: string | null;
  body?: string | null;
  receivedAt: Date;
  contactId?: string | null;
  campaignId?: string | null;
}): Promise<{ created: boolean; replyId: string | null; contactId: string | null }> {
  const match: ReplyMatch =
    input.contactId !== undefined
      ? { contactId: input.contactId ?? null, campaignId: input.campaignId ?? null }
      : await matchReply(input.userId, input.fromEmail);

  try {
    const reply = await prisma.reply.create({
      data: {
        userId: input.userId,
        provider: input.provider,
        senderAccountId: input.senderAccountId ?? null,
        messageId: input.messageId,
        fromEmail: input.fromEmail,
        toEmail: input.toEmail,
        subject: input.subject ?? null,
        snippet: input.snippet ?? null,
        body: input.body ?? null,
        receivedAt: input.receivedAt,
        contactId: match.contactId,
        campaignId: match.campaignId,
      },
    });

    if (match.contactId) {
      await applyReplyToContact(input.userId, match.contactId);
    }
    return { created: true, replyId: reply.id, contactId: match.contactId };
  } catch (err) {
    // Duplicate provider message id -> already imported.
    if ((err as { code?: string })?.code === "P2002") {
      return { created: false, replyId: null, contactId: match.contactId };
    }
    throw err;
  }
}

/**
 * Apply the side effects of a reply: mark the contact, stop the follow-ups
 * and drop any queued message so we never email someone who answered.
 */
export async function applyReplyToContact(userId: string, contactId: string): Promise<void> {
  await prisma.$transaction([
    prisma.contact.updateMany({
      where: { id: contactId, status: { notIn: ["UNSUBSCRIBED", "BOUNCED", "COMPLAINED", "INVALID"] } },
      data: { status: "REPLIED", lastRepliedAt: new Date(), repliedCount: { increment: 1 } },
    }),
    // Never send to somebody who replied.
    prisma.sendJob.updateMany({
      where: { userId, contactId, status: "QUEUED" },
      data: { status: "CANCELLED" },
    }),
  ]);

  const cancelled = await cancelFollowUpsForContactEverywhere(contactId, "The contact replied.");
  logger.info("Reply processed", { contactId, followUpsCancelled: cancelled });
}

/**
 * Parse a raw RFC822 message into the fields we store.
 * Exported for tests.
 */
export function parseRawMessage(raw: {
  from?: string;
  to?: string;
  subject?: string;
  snippet?: string;
  body?: string;
  date?: string;
}): IncomingReply {
  const extractAddress = (value: string | undefined): string => {
    if (!value) return "";
    const angle = value.match(/<([^>]+)>/);
    if (angle?.[1]) return angle[1].trim();
    return value.trim().split(/\s+/)[0] ?? "";
  };
  const receivedAt = raw.date ? new Date(raw.date) : new Date();
  return {
    messageId: "",
    fromEmail: extractAddress(raw.from),
    toEmail: extractAddress(raw.to),
    subject: raw.subject ?? "",
    snippet: (raw.snippet ?? raw.body ?? "").slice(0, 500),
    body: raw.body ?? "",
    receivedAt: Number.isNaN(receivedAt.getTime()) ? new Date() : receivedAt,
  };
}
