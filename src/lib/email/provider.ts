import type { SenderAccount } from "@prisma/client";

/**
 * Provider abstraction for outbound email.
 *
 * Implementations:
 *  - GmailProvider: official Gmail API (users.messages.send) with OAuth2.
 *  - SmtpProvider:  any standards-compliant SMTP server via nodemailer.
 *
 * Outcome semantics (critical for correctness):
 *  - ok            : provider accepted the message, messageId known.
 *  - transient     : definitely NOT accepted (rate limit / 5xx / network
 *                    refused before send) — safe to retry with backoff.
 *  - permanent     : definitely rejected (invalid recipient / policy) — never retry.
 *  - ambiguous     : the request may have been accepted (timeout AFTER
 *                    submit, dropped connection mid-flight) — NEVER auto-retry;
 *                    must be reconciled first.
 */

export type SendInput = {
  jobId: string;
  /** Deterministic per (job, attempt) value, used in headers for reconciliation. */
  idempotencyHeader: string;
  fromEmail: string;
  fromName?: string | null;
  toEmail: string;
  toName?: string | null;
  replyTo?: string | null;
  subject: string;
  html: string;
  text: string;
  /** Full unsubscribe URL (also set as List-Unsubscribe header). */
  unsubscribeUrl: string;
  headers?: Record<string, string>;
};

export type SendOutcome =
  | { kind: "ok"; messageId: string }
  | { kind: "transient"; code?: string; message: string; httpStatus?: number }
  | { kind: "permanent"; code?: string; message: string; httpStatus?: number }
  | { kind: "ambiguous"; code?: string; message: string };

/** Any outcome that is NOT a successful send — what classifiers return. */
export type SendFailure = Exclude<SendOutcome, { kind: "ok" }>;

export type ReconcileResult = "sent" | "not_sent" | "unknown";

export interface EmailProvider {
  readonly name: "GMAIL" | "SMTP";
  send(account: SenderAccount, input: SendInput): Promise<SendOutcome>;
  /**
   * Determine whether an ambiguous job actually reached the provider.
   * Returns "unknown" when the provider cannot answer (e.g. SMTP).
   */
  reconcile(account: SenderAccount, input: SendInput): Promise<ReconcileResult>;
}

// ---------------------------------------------------------------------------
// MIME construction (shared)
// ---------------------------------------------------------------------------

function isAscii(value: string): boolean {
  return !/[^\x00-\x7F]/.test(value);
}

export function encodeMimeHeader(value: string): string {
  if (isAscii(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/**
 * Header-injection guard: a CR/LF inside a header value would start a NEW
 * header line ("Evil\r\nBcc: victim@..."). We truncate the value at the first
 * control character instead of trying to salvage it — anything after a line
 * break in a name/subject is forged content, not data. Remaining control
 * characters are stripped as well.
 */
export function sanitizeHeaderValue(value: string): string {
  const cut = value.search(/[\r\n]/);
  const base = cut === -1 ? value : value.slice(0, cut);
  return base.replace(/[\x00-\x1F\x7F]/g, "").trim();
}

export function buildMimeMessage(input: SendInput & { messageId: string }): string {
  const fromName = input.fromName ? sanitizeHeaderValue(input.fromName) : "";
  const toName = input.toName ? sanitizeHeaderValue(input.toName) : "";
  const subject = sanitizeHeaderValue(input.subject);
  const fromEmail = sanitizeHeaderValue(input.fromEmail);
  const toEmail = sanitizeHeaderValue(input.toEmail);

  const from = fromName ? `${encodeMimeHeader(fromName)} <${fromEmail}>` : fromEmail;
  const to = toName ? `${encodeMimeHeader(toName)} <${toEmail}>` : toEmail;

  const lines: string[] = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeMimeHeader(subject)}`,
    `Message-ID: <${sanitizeHeaderValue(input.messageId)}>`,
    `Date: ${new Date().toUTCString()}`,
    `X-EOP-Idempotency-Key: ${sanitizeHeaderValue(input.idempotencyHeader)}`,
    `List-Unsubscribe: <${sanitizeHeaderValue(input.unsubscribeUrl)}>`,
    `List-Unsubscribe-Post: List-Unsubscribe=One-Click`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset=UTF-8`,
    `Content-Transfer-Encoding: 8bit`,
  ];
  for (const [k, v] of Object.entries(input.headers ?? {})) {
    const key = sanitizeHeaderValue(k);
    const value = sanitizeHeaderValue(v);
    if (!key || !value) continue; // header injection guard
    lines.push(`${key}: ${value}`);
  }
  lines.push("", input.html);
  return lines.join("\r\n");
}

/**
 * Deterministic Message-ID for a (job, attempt). Used by Gmail reconciliation
 * via the `rfc822msgid:` search operator.
 */
export function deterministicMessageId(jobId: string, attempt: number, domain = "mail.outreach.local"): string {
  return `eop-${jobId}-${attempt}@${domain}`;
}
