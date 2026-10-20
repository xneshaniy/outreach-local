import { google, type gmail_v1 } from "googleapis";
import type { SenderAccount } from "@prisma/client";
import { decryptSecret, encryptSecret } from "../crypto";
import { prisma } from "../db";
import { env } from "../env";
import { logger } from "../logger";
import {
  buildMimeMessage,
  deterministicMessageId,
  type EmailProvider,
  type ReconcileResult,
  type SendFailure,
  type SendInput,
  type SendOutcome,
} from "./provider";

/**
 * Gmail provider — official Gmail API (users.messages.send) via OAuth2.
 *
 * - Uses the user-granted refresh token; access tokens are refreshed on demand
 *   and stored encrypted at rest.
 * - `invalid_grant` marks the account as needing reconnection (ERROR).
 * - Never scrapes or automates Google sign-in; OAuth2 only.
 */

export class TokenInvalidError extends Error {
  constructor(message = "The Google grant is no longer valid; the account must be reconnected.") {
    super(message);
    this.name = "TokenInvalidError";
  }
}

export function tokenAad(accountId: string, field: string): string {
  return `sender:${accountId}:${field}`;
}

function oauth2Client(account: SenderAccount) {
  const client = new google.auth.OAuth2(env.googleClientId, env.googleClientSecret, env.googleRedirectUri);
  if (account.refreshTokenEnc) {
    client.setCredentials({
      refresh_token: decryptSecret(account.refreshTokenEnc, tokenAad(account.id, "refreshToken")),
    });
  }
  return client;
}

function gmailClient(account: SenderAccount): gmail_v1.Gmail {
  const auth = oauth2Client(account);
  return google.gmail({ version: "v1", auth });
}

/** Refresh + persist the (encrypted) access token when needed. */
async function ensureAccess(account: SenderAccount): Promise<void> {
  const client = oauth2Client(account);
  try {
    const { token } = await client.getAccessToken();
    if (!token) throw new TokenInvalidError("Google returned no access token.");
    const expiry = client.credentials.expiry_date ?? null;
    // Persist only when it changed, to limit writes.
    if (token !== (account.accessTokenEnc ? decryptSecret(account.accessTokenEnc, tokenAad(account.id, "accessToken")) : null)) {
      await prisma.senderAccount.update({
        where: { id: account.id },
        data: {
          accessTokenEnc: encryptSecret(token, tokenAad(account.id, "accessToken")),
          tokenExpiresAt: expiry ? new Date(expiry) : null,
          lastError: null,
        },
      });
    }
  } catch (err) {
    const e = err as { response?: { data?: { error?: string } }; message?: string };
    const invalidGrant = e.response?.data?.error === "invalid_grant" || /invalid_grant/.test(e.message ?? "");
    if (invalidGrant) {
      await markAccountError(account.id, "Google OAuth grant is invalid or revoked. Reconnect the account.");
      throw new TokenInvalidError();
    }
    throw err;
  }
}

async function markAccountError(accountId: string, message: string): Promise<void> {
  await prisma.senderAccount.updateMany({
    where: { id: accountId, status: { not: "DISCONNECTED" } },
    data: { status: "ERROR", lastError: message },
  });
  logger.warn("Sender account marked ERROR", { accountId, reason: message });
}

type GmailErrorLike = {
  code?: number | string;
  response?: { status?: number; data?: { error?: { code?: number; message?: string; status?: string } } };
  errors?: Array<{ reason?: string; domain?: string }>;
  message?: string;
};

/** Exported for unit tests. */
export function classifyGmailError(err: unknown): SendFailure {
  const e = err as GmailErrorLike;
  const status = typeof e.code === "number" ? e.code : e.response?.status;
  const reason = e.errors?.[0]?.reason ?? e.response?.data?.error?.status ?? "";
  const message = e.response?.data?.error?.message ?? e.message ?? "Unknown Gmail API error.";

  // Timeouts / dropped connections AFTER submit are ambiguous: the message may
  // have been accepted. Never assume it was not sent.
  const msgLower = message.toLowerCase();
  if (
    status === undefined &&
    (msgLower.includes("timeout") ||
      msgLower.includes("timed out") ||
      msgLower.includes("time out") ||
      msgLower.includes("etimedout") ||
      msgLower.includes("econnreset") ||
      msgLower.includes("socket hang up") ||
      msgLower.includes("aborted") ||
      msgLower.includes("network"))
  ) {
    return { kind: "ambiguous", code: "NETWORK_AMBIGUOUS", message };
  }

  if (status === 429 || reason === "rateLimitExceeded" || reason === "userRateLimitExceeded") {
    return { kind: "transient", code: "RATE_LIMIT", message, httpStatus: 429 };
  }
  if (status === 401) {
    return { kind: "transient", code: "UNAUTHORIZED", message, httpStatus: 401 };
  }
  if (status !== undefined && status >= 500) {
    return { kind: "transient", code: "PROVIDER_5XX", message, httpStatus: status };
  }
  if (status === 403) {
    // Policy/permission problems do not fix themselves, but quota-ish 403s do;
    // treat 403 as transient until attempts are exhausted (bounded).
    return { kind: "transient", code: "FORBIDDEN", message, httpStatus: 403 };
  }
  if (status === 400 || status === 404) {
    return { kind: "permanent", code: "INVALID_REQUEST", message, httpStatus: status };
  }
  return { kind: "transient", code: "UNKNOWN", message, httpStatus: status };
}

export const gmailProvider: EmailProvider = {
  name: "GMAIL",

  async send(account, input: SendInput): Promise<SendOutcome> {
    try {
      await ensureAccess(account);
    } catch (err) {
      if (err instanceof TokenInvalidError) {
        return { kind: "transient", code: "TOKEN_INVALID", message: err.message };
      }
      const e = err as GmailErrorLike;
      return { kind: "transient", code: "AUTH_REFRESH_FAILED", message: e.message ?? "Token refresh failed." };
    }

    const messageId = deterministicMessageId(input.jobId, Number(input.idempotencyHeader.split(":").pop() ?? "1"));
    const raw = buildMimeMessage({ ...input, messageId });
    const gmail = gmailClient(account);

    try {
      const res = await withTimeout(
        gmail.users.messages.send({
          userId: "me",
          requestBody: { raw: Buffer.from(raw, "utf8").toString("base64url") },
        }),
        30_000,
      );
      const id = res.data.id;
      if (!id) return { kind: "ambiguous", code: "NO_MESSAGE_ID", message: "Gmail accepted the message but returned no id." };
      await prisma.senderAccount.update({ where: { id: account.id }, data: { lastUsedAt: new Date(), lastError: null } });
      return { kind: "ok", messageId: id };
    } catch (err) {
      const outcome = classifyGmailError(err);
      if (outcome.code === "TOKEN_INVALID" || (outcome.kind !== "ambiguous" && outcome.httpStatus === 401)) {
        await markAccountError(account.id, "Google authorization expired or was revoked. Reconnect the account.");
      }
      return outcome;
    }
  },

  async reconcile(account, input: SendInput): Promise<ReconcileResult> {
    try {
      await ensureAccess(account);
      const gmail = gmailClient(account);
      const messageId = deterministicMessageId(input.jobId, Number(input.idempotencyHeader.split(":").pop() ?? "1"));
      const res = await withTimeout(
        gmail.users.messages.list({
          userId: "me",
          q: `rfc822msgid:${messageId}`,
          includeSpamTrash: true,
          maxResults: 1,
        }),
        20_000,
      );
      if ((res.data.messages?.length ?? 0) > 0) return "sent";
      return "not_sent";
    } catch {
      // Cannot determine — the caller must keep the job AMBIGUOUS.
      return "unknown";
    }
  },
};

/**
 * Verify a connected account by asking Gmail for the profile address.
 * Used right after OAuth and by the "test send" flow.
 */
export async function fetchGmailProfile(account: SenderAccount): Promise<{ email: string; historyId?: string }> {
  const gmail = gmailClient(account);
  const res = await gmail.users.getProfile({ userId: "me" });
  return { email: res.data.emailAddress ?? "", historyId: res.data.historyId ?? undefined };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        Object.assign(new Error(`Provider request timed out after ${ms}ms; outcome unknown.`), {
          code: undefined,
          name: "TimeoutError",
        }),
      );
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
