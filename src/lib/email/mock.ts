import type { SenderAccount } from "@prisma/client";
import { logger } from "../logger";
import type { EmailProvider, ReconcileResult, SendInput, SendOutcome } from "./provider";

/**
 * Mock email provider — for local development and the automated tests.
 *
 * It never touches the network. Every accepted message is written to the
 * in-memory outbox below and logged, so a developer can see exactly what
 * would have been sent.
 *
 * Set MOCK_PROVIDER=true to route the worker through it.
 */

export type MockMessage = {
  to: string;
  subject: string;
  html: string;
  sentAt: Date;
  messageId: string;
  jobId: string;
};

const outbox: MockMessage[] = [];

/** The messages the mock provider accepted (newest last). */
export function mockOutbox(): MockMessage[] {
  return outbox;
}

export function clearMockOutbox(): void {
  outbox.length = 0;
}

export const mockProvider: EmailProvider = {
  name: "GMAIL",

  async send(_account: SenderAccount, input: SendInput): Promise<SendOutcome> {
    const messageId = `mock-${input.jobId}-${outbox.length + 1}`;
    outbox.push({
      to: input.toEmail,
      subject: input.subject,
      html: input.html,
      sentAt: new Date(),
      messageId,
      jobId: input.jobId,
    });
    logger.info("MOCK PROVIDER: message accepted (not sent)", {
      to: input.toEmail,
      subject: input.subject,
      messageId,
    });
    return { kind: "ok", messageId };
  },

  async reconcile(_account: SenderAccount, input: SendInput): Promise<ReconcileResult> {
    return outbox.some((m) => m.jobId === input.jobId) ? "sent" : "not_sent";
  },
};
