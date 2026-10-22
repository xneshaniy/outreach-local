import type { SendAttempt } from "@prisma/client";
import { prisma, type TxLike } from "../lib/db";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { audit } from "../lib/audit";
import { checkSuppression, isTooFrequent } from "../lib/suppression";
import {
  QuotaExceededError,
  quotaDayKey,
  releaseSenderSlot,
  reserveCampaignSlot,
  reserveSenderSlot,
  rollbackCampaignSlot,
  settleSenderSlot,
} from "../lib/quota";
import { isWithinSendingWindow, nextSendingInstant, type SendingWindow } from "../lib/scheduling";
import { unsubscribeUrl } from "../lib/template";
import { gmailProvider } from "../lib/email/gmail";
import { smtpProvider } from "../lib/email/smtp";
import { dryRunProvider } from "../lib/email/dry-run";
import { mockProvider } from "../lib/email/mock";
import { advanceFollowUp } from "../lib/followup";
import { recordActivity } from "../lib/activity";
import { notify } from "../lib/notifications";
import type { ClaimedJob } from "../lib/queue";
import type { EmailProvider, SendInput } from "../lib/email/provider";

/**
 * Worker pipeline for a single claimed job (spec §8).
 *
 * Ordering matters for correctness:
 *   eligibility -> suppression -> frequency -> local window -> attempt row
 *   -> quota reservation (tx) -> provider submit -> settle (tx)
 *
 * Ambiguity rule: if the provider call may have been accepted (timeout after
 * submit), the job becomes AMBIGUOUS and is NEVER auto-retried; it must be
 * reconciled (Gmail rfc822msgid search) before any further attempt.
 */

export function providerFor(account: { provider: "GOOGLE" | "SMTP" }): EmailProvider {
  return account.provider === "GOOGLE" ? gmailProvider : smtpProvider;
}

export function backoffDelayMs(attempts: number): number {
  const base = env.workerBackoffBaseMs * Math.pow(2, Math.max(0, attempts - 1));
  const capped = Math.min(base, 30 * 60 * 1000); // never longer than 30 min
  const jitter = 0.5 + Math.random(); // 0.5x .. 1.5x
  return Math.round(capped * jitter);
}

export async function processJob(job: ClaimedJob): Promise<void> {
  const started = Date.now();

  // ---------------------------------------------------------------------------
  // 1. Campaign still active? (pause / emergency stop / cancel)
  // ---------------------------------------------------------------------------
  if (job.campaign.status === "CANCELLED" || job.campaign.status === "COMPLETED") {
    await finalizeSkipped(job, "CAMPAIGN_CANCELLED");
    return;
  }
  if (job.campaign.status !== "ACTIVE" || job.campaign.emergencyStopped) {
    // Not an error — requeue cheaply without consuming an attempt.
    await prisma.sendJob.update({
      where: { id: job.id },
      data: {
        status: "QUEUED",
        claimedBy: null,
        leaseExpiresAt: null,
        scheduledAt: new Date(Date.now() + 60_000), // re-check in a minute
      },
    });
    return;
  }

  // ---------------------------------------------------------------------------
  // 2. Recipient / contact eligibility
  //    A follow-up job has no CampaignRecipient (it belongs to a
  //    FollowUpMessage instead) — the checks below cover both kinds.
  // ---------------------------------------------------------------------------
  const recipient = job.campaignRecipient;
  const followUp = job.followUpMessage;
  if (recipient && ["SENT", "FAILED", "SKIPPED", "CANCELLED"].includes(recipient.status)) {
    await finalizeSkipped(job, `RECIPIENT_${recipient.status}`);
    return;
  }
  if (recipient?.status === "HELD_TZ") {
    await finalizeSkipped(job, "HELD_UNKNOWN_TIMEZONE");
    return;
  }
  if (followUp && followUp.status !== "SCHEDULED") {
    // The follow-up was cancelled (replied, unsubscribed, campaign paused).
    await finalizeSkipped(job, `FOLLOW_UP_${followUp.status}`);
    return;
  }

  // ---------------------------------------------------------------------------
  // 3. Suppression + unsubscribe + contact status + frequency
  // ---------------------------------------------------------------------------
  if (job.contact.status !== "ACTIVE" && job.contact.status !== "REPLIED" && job.contact.status !== "INTERESTED") {
    await finalizeSkipped(job, `CONTACT_${job.contact.status}`);
    return;
  }
  if (job.contact.status === "REPLIED" || job.contact.status === "INTERESTED") {
    // They answered — never email them again.
    await finalizeSkipped(job, "CONTACT_ALREADY_REPLIED");
    return;
  }
  const suppression = await checkSuppression(job.userId, job.contact.emailNormalized, job.campaignId);
  if (suppression.suppressed) {
    await finalizeSkipped(job, suppression.reason ?? "SUPPRESSED", suppression.detail);
    return;
  }
  const ownerSetting = await prisma.user.findUnique({
    where: { id: job.userId },
    select: { minDaysBetweenContacts: true },
  });
  const minDays = ownerSetting?.minDaysBetweenContacts ?? env.minDaysBetweenContacts;
  // The frequency guard is enforced by the follow-up scheduler; the first
  // message of a campaign is always allowed.
  if (!followUp && (await isTooFrequent(job.contact, minDays))) {
    await finalizeSkipped(job, "FREQUENCY_LIMIT");
    return;
  }

  // ---------------------------------------------------------------------------
  // 4. Recipient-local sending window
  // ---------------------------------------------------------------------------
  const window: SendingWindow = {
    startMinute: job.campaign.windowStartMinute,
    endMinute: job.campaign.windowEndMinute,
    days: job.campaign.sendingDays,
  };
  const now = new Date();
  const zone = job.contact.timeZone;
  if (!zone) {
    await finalizeSkipped(job, "UNKNOWN_TIMEZONE");
    return;
  }
  if (!isWithinSendingWindow(now, zone, window)) {
    const next = nextSendingInstant(now, zone, window);
    if (!next) {
      if (recipient) {
        await prisma.campaignRecipient.update({
          where: { id: recipient.id },
          data: { status: "HELD_TZ", skipReason: "NO_VALID_SEND_TIME" },
        });
      }
      await releaseClaim(job.id);
      return;
    }
    await prisma.$transaction([
      prisma.sendJob.update({
        where: { id: job.id },
        data: { status: "QUEUED", claimedBy: null, leaseExpiresAt: null, scheduledAt: next },
      }),
      prisma.campaignRecipient.updateMany({
        where: { id: recipient?.id ?? "" },
        data: { status: "SCHEDULED", scheduledAt: next },
      }),
    ]);
    logger.debug("Job rescheduled to recipient-local window", { jobId: job.id, next: next.toISOString() });
    return;
  }

  // ---------------------------------------------------------------------------
  // 5. Attempt row (crash-safe ambiguity marker)
  //    Created BEFORE the provider call; unfinished = possible in-flight send.
  // ---------------------------------------------------------------------------
  const attemptNumber = job.attempts + 1;
  const idempotencyHeader = `v1:${job.id}:${attemptNumber}`;
  let attempt: SendAttempt;
  try {
    attempt = await prisma.sendAttempt.create({
      data: { jobId: job.id, attemptNumber, status: "AMBIGUOUS", idempotencyHeader },
    });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") {
      // Attempt row already exists (crash-recovery replay) — abort without
      // touching the provider to avoid double-sends; the reclaimer owns it.
      logger.warn("Attempt row already existed; refusing to re-send", { jobId: job.id, attemptNumber });
      return;
    }
    throw err;
  }

  // ---------------------------------------------------------------------------
  // 6. Sender selection + transactional quota reservation
  //
  //    A dry run never contacts a provider, so it must not consume the real
  //    daily quota either — otherwise testing would silently eat the budget.
  // ---------------------------------------------------------------------------
  const quotaDay = quotaDayKey(now, env.senderQuotaTimezone);
  const isDryRun = env.dryRun || job.campaign.dryRun;

  const accounts = await prisma.senderAccount.findMany({
    where: { userId: job.userId, status: "CONNECTED" },
    orderBy: [{ lastUsedAt: "asc" }, { createdAt: "asc" }],
    take: 10,
  });
  if (accounts.length === 0 && !isDryRun && !env.mockProvider) {
    await failAttempt(job, attempt.id, attemptNumber, "NO_SENDER", "No connected sender account.", "permanent", Date.now() - started);
    return;
  }

  let reservedFor: (typeof accounts)[number] | null = null;
  let lastQuotaError: Error | null = null;

  if (!isDryRun && !env.mockProvider) {
    for (const account of accounts) {
      const cap = Math.min(account.dailyCap, env.senderDailyCapDefault);
      try {
        await prisma.$transaction(async (tx: TxLike) => {
          await reserveSenderSlot(tx, account.id, cap, quotaDay);
          await reserveCampaignSlot(tx, job.campaignId, job.campaign.dailyLimit, quotaDay);
          await tx.sendJob.update({
            where: { id: job.id },
            data: { senderAccountId: account.id, provider: account.provider === "GOOGLE" ? "GMAIL" : "SMTP" },
          });
          await tx.sendAttempt.update({ where: { id: attempt.id }, data: { senderAccountId: account.id } });
        });
        reservedFor = account;
        break;
      } catch (err) {
        if (err instanceof QuotaExceededError) {
          lastQuotaError = err;
          continue;
        }
        throw err;
      }
    }

    if (!reservedFor) {
      // Every sender is at its daily cap — requeue for the next quota day.
      await releaseClaim(job.id, { scheduledAt: nextQuotaDay(quotaDay, env.senderQuotaTimezone) });
      await prisma.sendAttempt.update({
        where: { id: attempt.id },
        data: {
          status: "TRANSIENT_FAILURE",
          finishedAt: new Date(),
          errorCode: "ALL_SENDERS_AT_CAP",
          errorMessage: lastQuotaError?.message ?? "All sender accounts reached their daily cap.",
        },
      });
      logger.info("Job deferred: all senders at cap", { jobId: job.id });
      return;
    }
  }

  // ---------------------------------------------------------------------------
  // 7. Render + submit
  // ---------------------------------------------------------------------------
  const token = unsubscribeUrl({ c: job.contact.id, u: job.userId, p: job.campaignId });
  // A follow-up carries its own subject/body; the original message uses the
  // campaign's.
  const subjectTemplate = job.subject ?? job.campaign.subject;
  const bodyTemplate = job.body ?? job.campaign.body;

  const sendInput: SendInput = {
    jobId: job.id,
    idempotencyHeader,
    fromEmail: reservedFor?.email ?? job.campaign.replyTo ?? "dry-run@localhost",
    fromName: job.campaign.fromName ?? reservedFor?.displayName,
    toEmail: job.contact.email,
    toName: [job.contact.firstName, job.contact.lastName].filter(Boolean).join(" ") || null,
    replyTo: job.campaign.replyTo,
    subject: subjectTemplate,
    html: bodyTemplate,
    text: bodyTemplate,
    unsubscribeUrl: token,
  };

  // Render personalization (the stored body is the template source).
  const { renderEmail } = await import("../lib/template");
  const rendered = renderEmail({
    subject: subjectTemplate,
    body: bodyTemplate,
    contact: job.contact,
    unsubscribeUrl: token,
  });
  sendInput.subject = rendered.subject;
  sendInput.html = rendered.html;
  sendInput.text = rendered.text;

  // ---------------------------------------------------------------------------
  // 7b. Tracking (opt-in per campaign)
  //
  // The pixel and the tracked links are added to the RENDERED body, so they
  // carry this recipient's id. Click tracking never touches the unsubscribe
  // link, so opting out always works.
  // ---------------------------------------------------------------------------
  if (job.campaign.clickTrackingEnabled) {
    const { rewriteLinksForTracking } = await import("../lib/tracking");
    sendInput.html = rewriteLinksForTracking(sendInput.html, job.campaignId, job.contactId, {
      // The unsubscribe link must keep working exactly as before.
      skipUrls: [token],
    });
  }
  if (job.campaign.trackingEnabled) {
    const { buildOpenPixelUrl, injectTrackingPixel } = await import("../lib/tracking");
    sendInput.html = injectTrackingPixel(
      sendInput.html,
      buildOpenPixelUrl(job.campaignId, job.contactId),
    );
  }

  // The mock provider is checked first so a developer with no credentials
  // can still exercise the whole pipeline.
  const provider = isDryRun
    ? dryRunProvider
    : env.mockProvider
      ? mockProvider
      : providerFor(reservedFor!);
  let outcome;
  try {
    outcome = await provider.send(reservedFor!, sendInput);
  } catch (err) {
    // A thrown error during submit is ambiguous by definition.
    logger.error("Provider threw during send", { jobId: job.id, error: (err as Error).message });
    await markAmbiguous(job, attempt.id, attemptNumber, "PROVIDER_THREW", (err as Error).message, quotaDay);
    return;
  }

  // ---------------------------------------------------------------------------
  // 8. Settle
  // ---------------------------------------------------------------------------
  if (outcome.kind === "ok") {
    const sentAt = new Date();
    await prisma.$transaction(async (tx: TxLike) => {
      if (!isDryRun && !env.mockProvider && reservedFor) {
        await settleSenderSlot(tx, reservedFor.id, quotaDay);
      }
      await tx.sendAttempt.update({
        where: { id: attempt.id },
        data: {
          status: "SUCCESS",
          providerMessageId: outcome.messageId,
          finishedAt: sentAt,
          latencyMs: Date.now() - started,
        },
      });
      await tx.sendJob.update({
        where: { id: job.id },
        data: {
          status: "SENT",
          providerMessageId: outcome.messageId,
          attempts: attemptNumber,
          lastError: null,
          ambiguousSince: null,
          dryRun: isDryRun,
        },
      });
      if (recipient) {
        await tx.campaignRecipient.update({
          where: { id: recipient.id },
          data: { status: "SENT", sentAt, lastError: null },
        });
      }
      if (followUp) {
        await tx.followUpMessage.update({
          where: { id: followUp.id },
          data: { status: "SENT", sentAt, failureReason: null },
        });
      }
      if (!isDryRun) {
        await tx.contact.update({
          where: { id: job.contactId },
          data: { lastSentAt: sentAt, sentCount: { increment: 1 } },
        });
      }
    });
    if (!isDryRun) {
      await recordActivity({
        userId: job.userId,
        contactId: job.contactId,
        type: "EMAIL_SENT",
        summary: "Email sent: " + rendered.subject,
        detail: { jobId: job.id, campaignId: job.campaignId },
      });
    }

    logger.info(isDryRun ? "Job rendered (dry run)" : "Job sent", {
      jobId: job.id,
      provider: provider.name,
      attempt: attemptNumber,
      dryRun: isDryRun,
    });

    // Schedule the next follow-up step (if the campaign has a sequence).
    // A dry run does not schedule anything: the follow-up chain only starts
    // after a real delivery.
    if (!isDryRun) {
      try {
        await advanceFollowUp({
          userId: job.userId,
          campaign: job.campaign,
          contact: job.contact,
          sentAt,
          minDaysBetweenContacts: minDays,
        });
      } catch (err) {
        logger.error("Could not schedule the next follow-up", {
          jobId: job.id,
          error: (err as Error).message,
        });
      }
    }
    return;
  }

  if (outcome.kind === "ambiguous") {
    await markAmbiguous(job, attempt.id, attemptNumber, outcome.code, outcome.message, quotaDay);
    return;
  }

  if (outcome.kind === "transient") {
    const attempts = attemptNumber;
    const exhausted = attempts >= job.maxAttempts;
    await prisma.$transaction(async (tx: TxLike) => {
      if (!isDryRun) {
        await releaseSenderSlot(tx, reservedFor!.id, quotaDay, true);
        await rollbackCampaignSlot(tx, job.campaignId, quotaDay);
      }
      await tx.sendAttempt.update({
        where: { id: attempt.id },
        data: {
          status: "TRANSIENT_FAILURE",
          errorCode: outcome.code,
          errorMessage: outcome.message,
          httpStatus: outcome.httpStatus,
          finishedAt: new Date(),
          latencyMs: Date.now() - started,
        },
      });
      if (exhausted) {
        await tx.sendJob.update({
          where: { id: job.id },
          data: { status: "FAILED", attempts, lastError: outcome.message, errorCode: outcome.code },
        });
        if (recipient) {
          await tx.campaignRecipient.update({
            where: { id: recipient.id },
            data: { status: "FAILED", failedAt: new Date(), lastError: outcome.message },
          });
        }
        if (followUp) {
          await tx.followUpMessage.update({
            where: { id: followUp.id },
            data: { status: "FAILED", failureReason: outcome.message },
          });
        }
      } else {
        await tx.sendJob.update({
          where: { id: job.id },
          data: {
            status: "QUEUED",
            attempts,
            lastError: outcome.message,
            errorCode: outcome.code,
            claimedBy: null,
            leaseExpiresAt: null,
            scheduledAt: new Date(Date.now() + backoffDelayMs(attempts)),
          },
        });
      }
    });
    logger.warn("Transient send failure", { jobId: job.id, code: outcome.code, exhausted });
    return;
  }

  // permanent
  await prisma.$transaction(async (tx: TxLike) => {
    if (!isDryRun) {
      await releaseSenderSlot(tx, reservedFor!.id, quotaDay, true);
      await rollbackCampaignSlot(tx, job.campaignId, quotaDay);
    }
    await tx.sendAttempt.update({
      where: { id: attempt.id },
      data: {
        status: "PERMANENT_FAILURE",
        errorCode: outcome.code,
        errorMessage: outcome.message,
        httpStatus: outcome.httpStatus,
        finishedAt: new Date(),
        latencyMs: Date.now() - started,
      },
    });
    await tx.sendJob.update({
      where: { id: job.id },
      data: {
        status: "FAILED",
        attempts: attemptNumber,
        lastError: outcome.message,
        errorCode: outcome.code,
        // A permanent failure is moved out of the queue for manual review.
        deadLetteredAt: new Date(),
      },
    });
    if (recipient) {
      await tx.campaignRecipient.update({
        where: { id: recipient.id },
        data: { status: "FAILED", failedAt: new Date(), lastError: outcome.message },
      });
    }
    if (followUp) {
      await tx.followUpMessage.update({
        where: { id: followUp.id },
        data: { status: "FAILED", failureReason: outcome.message },
      });
    }
  });
  logger.warn("Permanent send failure", { jobId: job.id, code: outcome.code });

  // The message is now dead-lettered: it is out of the queue and needs a
  // human decision (fix the address, retry, or drop it).
  await recordActivity({
    userId: job.userId,
    contactId: job.contactId,
    type: "BOUNCED",
    summary: "Send failed permanently: " + outcome.message,
    detail: { jobId: job.id, code: outcome.code },
  });
  await notify({
    userId: job.userId,
    type: "DEAD_LETTER",
    title: "A message to " + job.contact.email + " failed permanently",
    body: outcome.message,
    link: "/queue",
    entityType: "SendJob",
    entityId: job.id,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function releaseClaim(jobId: string, extra?: { scheduledAt: Date }): Promise<void> {
  await prisma.sendJob.update({
    where: { id: jobId },
    data: {
      status: "QUEUED",
      claimedBy: null,
      leaseExpiresAt: null,
      ...(extra?.scheduledAt ? { scheduledAt: extra.scheduledAt } : {}),
    },
  });
}

async function finalizeSkipped(job: ClaimedJob, reason: string, detail?: string): Promise<void> {
  const message = detail ? `${reason}: ${detail}` : reason;
  await prisma.$transaction([
    prisma.sendJob.update({
      where: { id: job.id },
      data: { status: "SKIPPED", lastError: message, claimedBy: null, leaseExpiresAt: null },
    }),
    prisma.campaignRecipient.updateMany({
      where: { campaignId: job.campaignId, contactId: job.contactId, status: { notIn: ["SENT"] } },
      data: { status: "SKIPPED", skippedAt: new Date(), skipReason: reason },
    }),
    ...(job.followUpMessage
      ? [
          prisma.followUpMessage.updateMany({
            where: { id: job.followUpMessage.id, status: "SCHEDULED" },
            data: { status: "SKIPPED", cancelReason: reason },
          }),
        ]
      : []),
  ]);
}

async function markAmbiguous(
  job: ClaimedJob,
  attemptId: string,
  attemptNumber: number,
  code: string | undefined,
  message: string,
  quotaDay: Date,
): Promise<void> {
  void quotaDay;
  // Quota reservations are HELD while ambiguous: the message may exist at the
  // provider, so releasing the slot could exceed the daily cap.
  await prisma.$transaction([
    prisma.sendAttempt.update({
      where: { id: attemptId },
      data: { status: "AMBIGUOUS", errorCode: code, errorMessage: message, finishedAt: new Date() },
    }),
    prisma.sendJob.update({
      where: { id: job.id },
      data: { status: "AMBIGUOUS", attempts: attemptNumber, ambiguousSince: new Date(), lastError: message, errorCode: code },
    }),
    // A follow-up job has no campaign recipient - the empty id matches nothing.
    prisma.campaignRecipient.updateMany({ where: { id: job.campaignRecipientId ?? "" }, data: { status: "SENDING", lastError: message } }),
  ]);
  logger.warn("Job marked AMBIGUOUS — reconciliation required", { jobId: job.id, code });
}

async function failAttempt(
  job: ClaimedJob,
  attemptId: string,
  attemptNumber: number,
  code: string,
  message: string,
  kind: "permanent" | "transient",
  latencyMs: number,
): Promise<void> {
  await prisma.$transaction([
    prisma.sendAttempt.update({
      where: { id: attemptId },
      data: {
        status: kind === "permanent" ? "PERMANENT_FAILURE" : "TRANSIENT_FAILURE",
        errorCode: code,
        errorMessage: message,
        finishedAt: new Date(),
        latencyMs,
      },
    }),
    prisma.sendJob.update({
      where: { id: job.id },
      data: { status: "FAILED", attempts: attemptNumber, lastError: message, errorCode: code },
    }),
    prisma.campaignRecipient.updateMany({
      where: { id: job.campaignRecipientId ?? "" },
      data: { status: "FAILED", failedAt: new Date(), lastError: message },
    }),
  ]);
}

function nextQuotaDay(quotaDay: Date, tz: string): Date {
  // Next quota day starts at local midnight of tz; approximate with +26h then
  // snap to the quota-day key boundary.
  const next = new Date(quotaDay.getTime() + 26 * 3600 * 1000);
  return quotaDayKey(next, tz);
}

// ---------------------------------------------------------------------------
// Reconciliation of AMBIGUOUS jobs
// ---------------------------------------------------------------------------

export async function reconcileAmbiguousJob(job: ClaimedJob): Promise<"sent" | "requeued" | "manual"> {
  if (!job.senderAccount) return "manual";
  const latestAttempt = await prisma.sendAttempt.findFirst({
    where: { jobId: job.id },
    orderBy: { attemptNumber: "desc" },
  });

  const provider = providerFor(job.senderAccount);
  const token = unsubscribeUrl({ c: job.contact.id, u: job.userId, p: job.campaignId });
  const input: SendInput = {
    jobId: job.id,
    idempotencyHeader: latestAttempt?.idempotencyHeader ?? `v1:${job.id}:${job.attempts}`,
    fromEmail: job.senderAccount.email,
    fromName: job.campaign.fromName,
    toEmail: job.contact.email,
    subject: job.campaign.subject,
    html: job.campaign.body,
    text: job.campaign.body,
    unsubscribeUrl: token,
  };

  const result = await provider.reconcile(job.senderAccount, input);
  const quotaDay = quotaDayKey(new Date(), env.senderQuotaTimezone);

  if (result === "sent") {
    await prisma.$transaction(async (tx: TxLike) => {
      await settleSenderSlot(tx, job.senderAccount!.id, quotaDay);
      if (latestAttempt) {
        await tx.sendAttempt.update({
          where: { id: latestAttempt.id },
          data: { status: "SUCCESS", reconciliationNote: "confirmed sent via provider reconciliation", finishedAt: new Date() },
        });
      }
      await tx.sendJob.update({
        where: { id: job.id },
        data: { status: "SENT", lastError: null, ambiguousSince: null },
      });
      await tx.campaignRecipient.updateMany({
        where: { id: job.campaignRecipientId ?? "" },
        data: { status: "SENT", sentAt: new Date(), lastError: null },
      });
      await tx.contact.update({
        where: { id: job.contactId },
        data: { lastSentAt: new Date(), sentCount: { increment: 1 } },
      });
    });
    await audit(prisma, { userId: job.userId, action: "job.reconciled_sent", entityType: "SendJob", entityId: job.id });
    return "sent";
  }

  if (result === "not_sent") {
    await prisma.$transaction(async (tx: TxLike) => {
      await releaseSenderSlot(tx, job.senderAccount!.id, quotaDay);
      await rollbackCampaignSlot(tx, job.campaignId, quotaDay);
      if (latestAttempt) {
        await tx.sendAttempt.update({
          where: { id: latestAttempt.id },
          data: { status: "TRANSIENT_FAILURE", reconciliationNote: "confirmed NOT sent; requeued", finishedAt: new Date() },
        });
      }
      const exhausted = job.attempts >= job.maxAttempts;
      if (exhausted) {
        await tx.sendJob.update({ where: { id: job.id }, data: { status: "FAILED", ambiguousSince: null, lastError: "Reconciled as not sent; attempts exhausted." } });
        await tx.campaignRecipient.updateMany({ where: { id: job.campaignRecipientId ?? "" }, data: { status: "FAILED", failedAt: new Date() } });
      } else {
        await tx.sendJob.update({
          where: { id: job.id },
          data: { status: "QUEUED", ambiguousSince: null, scheduledAt: new Date(Date.now() + backoffDelayMs(job.attempts)) },
        });
        await tx.campaignRecipient.updateMany({ where: { id: job.campaignRecipientId ?? "" }, data: { status: "QUEUED" } });
      }
    });
    return "requeued";
  }

  // unknown — leave AMBIGUOUS for manual review; NEVER blind-retry.
  return "manual";
}
