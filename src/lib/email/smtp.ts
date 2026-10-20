import nodemailer, { type Transporter } from "nodemailer";
import type { SenderAccount } from "@prisma/client";
import { decryptSecret } from "../crypto";
import {
  deterministicMessageId,
  type EmailProvider,
  type ReconcileResult,
  type SendFailure,
  type SendInput,
  type SendOutcome,
} from "./provider";

/**
 * SMTP provider (nodemailer) for accounts connected with SMTP credentials.
 *
 * Credentials are stored encrypted (AES-256-GCM) and decrypted only inside the
 * worker, immediately before use.
 *
 * IMPORTANT: SMTP gives us no way to query delivery state, so `reconcile`
 * always returns "unknown" — ambiguous SMTP jobs stay AMBIGUOUS for manual
 * review instead of being blindly retried (which could double-send).
 */

function transport(account: SenderAccount): Transporter {
  if (!account.smtpHost || !account.smtpUsername || !account.smtpPasswordEnc) {
    throw new Error("SMTP account is missing host/credentials.");
  }
  return nodemailer.createTransport({
    host: account.smtpHost,
    port: account.smtpPort ?? 587,
    secure: account.smtpSecure ?? false,
    auth: {
      user: account.smtpUsername,
      pass: decryptSecret(account.smtpPasswordEnc, `sender:${account.id}:smtpPassword`),
    },
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
}

type SmtpErrorLike = {
  responseCode?: number;
  response?: string;
  code?: string;
  message?: string;
};

/** Exported for unit tests. */
export function classifySmtpError(err: unknown): SendFailure {
  const e = err as SmtpErrorLike;
  const code = typeof e.code === "string" ? e.code : undefined;
  const message = e.response ?? e.message ?? "Unknown SMTP error.";

  // Connection was never established — safe to retry.
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EHOSTUNREACH") {
    return { kind: "transient", code, message };
  }
  // Connection dropped around submission — the message MAY have been accepted.
  if (code === "ETIMEDOUT" || code === "ECONNRESET" || code === "ESOCKET" || /timeout|hang up/i.test(message)) {
    return { kind: "ambiguous", code: code ?? "TIMEOUT", message };
  }
  const rc = e.responseCode;
  if (typeof rc === "number") {
    if (rc >= 400 && rc < 500) return { kind: "transient", code: `SMTP_${rc}`, message, httpStatus: rc };
    if (rc >= 500) return { kind: "permanent", code: `SMTP_${rc}`, message, httpStatus: rc };
  }
  return { kind: "transient", code: code ?? "SMTP_UNKNOWN", message };
}

export const smtpProvider: EmailProvider = {
  name: "SMTP",

  async send(account, input: SendInput): Promise<SendOutcome> {
    const messageId = deterministicMessageId(input.jobId, Number(input.idempotencyHeader.split(":").pop() ?? "1"));
    try {
      const info = await transport(account).sendMail({
        from: input.fromName ? `"${input.fromName.replace(/"/g, "")}" <${input.fromEmail}>` : input.fromEmail,
        to: input.toName ? `"${input.toName.replace(/"/g, "")}" <${input.toEmail}>` : input.toEmail,
        replyTo: input.replyTo || undefined,
        subject: input.subject,
        html: input.html,
        text: input.text,
        messageId: `<${messageId}>`,
        headers: {
          "X-EOP-Idempotency-Key": input.idempotencyHeader,
          "List-Unsubscribe": `<${input.unsubscribeUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          ...(input.headers ?? {}),
        },
      });
      return { kind: "ok", messageId: info.messageId ?? messageId };
    } catch (err) {
      return classifySmtpError(err);
    }
  },

  async reconcile(): Promise<ReconcileResult> {
    return "unknown";
  },
};

/** Quick connectivity/auth check used by the "test connection" UI action. */
export async function verifySmtpConnection(account: SenderAccount): Promise<{ ok: boolean; error?: string }> {
  try {
    await transport(account).verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
