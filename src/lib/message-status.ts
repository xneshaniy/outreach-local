import type { CampaignRecipient, Contact, SendJob } from "@prisma/client";

/**
 * The unified message-status vocabulary.
 *
 * The rest of the application used three different vocabularies (job status,
 * recipient status and reply state). Everything user-facing now uses this one,
 * so "delivered" can never be shown for a message that was merely accepted.
 *
 *   DRAFT        not queued yet
 *   QUEUED       in the database queue
 *   SCHEDULED    queued for a future instant
 *   PROCESSING   claimed by a worker
 *   ACCEPTED     the provider took the message
 *   DELIVERED    a delivery event confirmed it
 *   BOUNCED      the address hard-bounced
 *   FAILED       the send failed permanently
 *   CANCELLED    stopped before sending
 *   REPLIED      the contact replied
 *   UNSUBSCRIBED the contact opted out
 *   SKIPPED      ineligible (suppressed, held, frequency limit, ...)
 */

export type MessageStatus =
  | "DRAFT"
  | "QUEUED"
  | "SCHEDULED"
  | "PROCESSING"
  | "ACCEPTED"
  | "DELIVERED"
  | "BOUNCED"
  | "FAILED"
  | "CANCELLED"
  | "REPLIED"
  | "UNSUBSCRIBED"
  | "SKIPPED";

export type MessageSnapshot = {
  job: Pick<SendJob, "status" | "scheduledAt" | "deliveredAt" | "deadLetteredAt" | "lastError"> | null;
  recipient: Pick<CampaignRecipient, "status" | "sentAt" | "scheduledAt" | "skipReason"> | null;
  contact: Pick<Contact, "status"> | null;
  replied: boolean;
};

/**
 * Derive the user-facing status of one message.
 * The order matters: the most specific / most recent fact wins.
 */
export function deriveMessageStatus(snapshot: MessageSnapshot): MessageStatus {
  const { job, recipient, contact, replied } = snapshot;

  if (contact?.status === "UNSUBSCRIBED") return "UNSUBSCRIBED";
  if (contact?.status === "BOUNCED") return "BOUNCED";
  if (contact?.status === "COMPLAINED") return "UNSUBSCRIBED";
  if (replied) return "REPLIED";

  if (job) {
    switch (job.status) {
      case "SENT":
        // Delivered only when a delivery event confirmed it.
        return job.deliveredAt ? "DELIVERED" : "ACCEPTED";
      case "FAILED":
        return job.deadLetteredAt ? "FAILED" : "FAILED";
      case "AMBIGUOUS":
        return "PROCESSING"; // outcome unknown - shown as still in flight
      case "CLAIMED":
        return "PROCESSING";
      case "QUEUED":
        return job.scheduledAt && job.scheduledAt.getTime() > Date.now() ? "SCHEDULED" : "QUEUED";
      case "CANCELLED":
        return "CANCELLED";
      case "SKIPPED":
        return "SKIPPED";
      default:
        return "QUEUED";
    }
  }

  if (recipient) {
    switch (recipient.status) {
      case "SENT":
        return "ACCEPTED";
      case "FAILED":
        return "FAILED";
      case "CANCELLED":
        return "CANCELLED";
      case "SKIPPED":
        return "SKIPPED";
      case "HELD_TZ":
        return "SKIPPED";
      case "SENDING":
        return "PROCESSING";
      case "QUEUED":
        return "QUEUED";
      case "SCHEDULED":
        return "SCHEDULED";
      default:
        return "DRAFT";
    }
  }

  return "DRAFT";
}

/** The status labels the UI shows, with an honest description. */
export const MESSAGE_STATUS_INFO: Record<
  MessageStatus,
  { label: string; tone: "neutral" | "green" | "red" | "amber" | "blue" | "purple"; confirmed: boolean }
> = {
  DRAFT: { label: "Draft", tone: "neutral", confirmed: true },
  QUEUED: { label: "Queued", tone: "blue", confirmed: true },
  SCHEDULED: { label: "Scheduled", tone: "blue", confirmed: true },
  PROCESSING: { label: "Processing", tone: "blue", confirmed: true },
  ACCEPTED: {
    label: "Accepted by provider",
    tone: "green",
    confirmed: true,
  },
  DELIVERED: { label: "Delivered", tone: "green", confirmed: true },
  BOUNCED: { label: "Bounced", tone: "red", confirmed: true },
  FAILED: { label: "Failed", tone: "red", confirmed: true },
  CANCELLED: { label: "Cancelled", tone: "neutral", confirmed: true },
  REPLIED: { label: "Replied", tone: "purple", confirmed: true },
  UNSUBSCRIBED: { label: "Unsubscribed", tone: "neutral", confirmed: true },
  SKIPPED: { label: "Skipped", tone: "amber", confirmed: true },
};
