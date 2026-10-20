import type { SenderAccount } from "@prisma/client";
import { createHash } from "crypto";
import { logger } from "../logger";
import type { EmailProvider, ReconcileResult, SendInput, SendOutcome } from "./provider";

/**
 * Dry-run provider.
 *
 * It renders and "delivers" the message without contacting any provider.
 * This is the safe default for a fresh installation: the whole pipeline
 * (scheduling, quota reservation, follow-ups, audit trail) runs exactly as it
 * would in production, but no email ever leaves the machine.
 *
 * The job is marked as a dry run so the UI can say so plainly — the app
 * never claims a real email was sent when it was not.
 */

export const DRY_RUN_MESSAGE_PREFIX = "dry-run:";

/** Build the deterministic fake message id for a dry run. */
export function dryRunMessageId(jobId: string, attempt: number): string {
  const hash = createHash("sha256").update(`${jobId}:${attempt}`).digest("hex").slice(0, 24);
  return `${DRY_RUN_MESSAGE_PREFIX}${hash}`;
}

/** Is this provider message id a dry-run marker? */
export function isDryRunMessageId(messageId: string | null | undefined): boolean {
  return typeof messageId === "string" && messageId.startsWith(DRY_RUN_MESSAGE_PREFIX);
}

export const dryRunProvider: EmailProvider = {
  name: "GMAIL", // never used: the worker picks this before the real provider

  async send(_account: SenderAccount, input: SendInput): Promise<SendOutcome> {
    const messageId = dryRunMessageId(input.jobId, Number(input.idempotencyHeader.split(":").pop() ?? "1"));
    logger.info("DRY RUN: message rendered but not sent", {
      jobId: input.jobId,
      to: input.toEmail,
      subject: input.subject,
      bytes: input.html.length,
    });
    return { kind: "ok", messageId };
  },

  async reconcile(): Promise<ReconcileResult> {
    // Nothing was ever submitted, so a dry run is by definition "not sent".
    return "not_sent";
  },
};
