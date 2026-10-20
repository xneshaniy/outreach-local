import { google } from "googleapis";
import type { SenderAccount } from "@prisma/client";
import { decryptSecret } from "../crypto";
import { env } from "../env";
import { logger } from "../logger";
import { recordReply, type IncomingReply } from "../replies";
import { tokenAad } from "./gmail";

/**
 * Gmail inbox polling for replies.
 *
 * Uses the Gmail API (the `gmail.readonly` scope is requested when the
 * account is connected):
 *   1. `users.messages.list` with `q=in:inbox newer_than:<n>d`
 *   2. `users.messages.get` for each candidate (headers + a text snippet)
 *   3. Match the sender against a contact, store the reply and stop the
 *      follow-up sequence.
 *
 * Polling is bounded (max messages, max age) so a large mailbox cannot slow
 * the worker down, and every message id is stored once — polling twice is
 * harmless.
 */

function oauth2Client(account: SenderAccount) {
  const client = new google.auth.OAuth2(env.googleClientId, env.googleClientSecret, env.googleRedirectUri);
  if (account.refreshTokenEnc) {
    client.setCredentials({
      refresh_token: decryptSecret(account.refreshTokenEnc, tokenAad(account.id, "refreshToken")),
    });
  }
  return client;
}

function gmailClient(account: SenderAccount) {
  return google.gmail({ version: "v1", auth: oauth2Client(account) });
}

/** Extract the first matching header value from a Gmail payload. */
function headerValue(
  headers: Array<{ name?: string | null; value?: string | null }> | undefined,
  name: string,
): string {
  const wanted = name.toLowerCase();
  for (const h of headers ?? []) {
    if ((h.name ?? "").toLowerCase() === wanted) return h.value ?? "";
  }
  return "";
}

/** Pull a plain-text body out of a Gmail payload (best effort). */
function extractBody(payload: Record<string, unknown> | undefined): string {
  if (!payload) return "";
  const parts = (payload.parts ?? []) as Array<Record<string, unknown>>;
  for (const part of parts) {
    if (part.mimeType === "text/plain" && part.body) {
      const data = (part.body as { data?: string }).data;
      if (data) return Buffer.from(data, "base64url").toString("utf8");
    }
  }
  if (payload.body) {
    const data = (payload.body as { data?: string }).data;
    if (data) return Buffer.from(data, "base64url").toString("utf8");
  }
  // Nested multipart.
  for (const part of parts) {
    const nested = extractBody(part as Record<string, unknown>);
    if (nested) return nested;
  }
  return "";
}

export type PollRepliesResult = {
  checked: number;
  imported: number;
  skipped: number;
  error?: string;
};

/**
 * Poll one Gmail account for new replies.
 * Returns the number of messages inspected and imported.
 */
export async function pollGmailReplies(
  account: SenderAccount,
  options: { maxMessages?: number; maxAgeDays?: number } = {},
): Promise<PollRepliesResult> {
  const maxMessages = options.maxMessages ?? 25;
  const maxAgeDays = options.maxAgeDays ?? 14;

  try {
    const gmail = gmailClient(account);
    const list = await gmail.users.messages.list({
      userId: "me",
      q: `in:inbox newer_than:${maxAgeDays}d`,
      maxResults: maxMessages,
    });

    const ids = (list.data.messages ?? []).map((m) => m.id).filter((x): x is string => Boolean(x));
    if (ids.length === 0) return { checked: 0, imported: 0, skipped: 0 };

    let imported = 0;
    let skipped = 0;

    for (const id of ids) {
      try {
        const res = await gmail.users.messages.get({
          userId: "me",
          id,
          format: "full",
        });
        const headers = res.data.payload?.headers as Array<{ name?: string | null; value?: string | null }> | undefined;
        const from = headerValue(headers, "from");
        const to = headerValue(headers, "to");
        const subject = headerValue(headers, "subject");
        const date = headerValue(headers, "date");

        const reply: IncomingReply = {
          messageId: id,
          fromEmail: extractAddress(from),
          toEmail: extractAddress(to),
          subject,
          snippet: (res.data.snippet ?? "").slice(0, 500),
          body: extractBody(res.data.payload as unknown as Record<string, unknown> | undefined).slice(0, 20_000),
          receivedAt: date && !Number.isNaN(new Date(date).getTime()) ? new Date(date) : new Date(),
        };

        const result = await recordReply({
          userId: account.userId,
          provider: "gmail",
          senderAccountId: account.id,
          messageId: reply.messageId,
          fromEmail: reply.fromEmail,
          toEmail: reply.toEmail,
          subject: reply.subject,
          snippet: reply.snippet,
          body: reply.body,
          receivedAt: reply.receivedAt,
        });

        if (result.created) imported++;
        else skipped++;
      } catch (err) {
        skipped++;
        logger.warn("Could not read a Gmail message while polling for replies", {
          accountId: account.id,
          messageId: id,
          error: (err as Error).message,
        });
      }
    }

    return { checked: ids.length, imported, skipped };
  } catch (err) {
    return { checked: 0, imported: 0, skipped: 0, error: (err as Error).message };
  }
}

function extractAddress(value: string): string {
  if (!value) return "";
  const angle = value.match(/<([^>]+)>/);
  if (angle?.[1]) return angle[1].trim();
  return value.trim().split(/\s+/)[0] ?? "";
}
