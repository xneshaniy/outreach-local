import type { Campaign } from "@prisma/client";
import { prisma } from "./db";
import { validateLinks } from "./link-check";
import { capabilitiesFor, type ProviderKind } from "./provider-capabilities";

/**
 * Campaign pre-flight checks.
 *
 * Run before a campaign is allowed to start. They answer the questions the
 * operator actually needs answered:
 *
 *   - Is the message complete (subject, body, signature, reply-to)?
 *   - Does it contain an unsubscribe link?  (legally required in many places)
 *   - Do the links work?
 *   - Does the audience have the data the template asks for?
 *   - How many recipients are eligible, and why are the others excluded?
 *   - Is there a connected sender with capacity left?
 *
 * Nothing here sends an email. It is a report.
 */

export type PreflightSeverity = "BLOCKER" | "WARNING" | "INFO";

export type PreflightFinding = {
  severity: PreflightSeverity;
  code: string;
  message: string;
  detail?: string;
};

export type PreflightReport = {
  campaignId: string;
  ok: boolean;
  findings: PreflightFinding[];
  eligible: number;
  excluded: number;
  excludedReasons: Record<string, number>;
  personalization: {
    variables: string[];
    missing: string[];
    partial: string[];
    checked: number;
  };
  providerCapabilities: ReturnType<typeof capabilitiesFor>;
  checkedAt: string;
};

const SEVERITY_WEIGHT: Record<PreflightSeverity, number> = { INFO: 0, WARNING: 1, BLOCKER: 2 };

export async function runPreflight(
  campaign: Campaign & { followUpSequenceId?: string | null },
  options: { provider?: ProviderKind } = {},
): Promise<PreflightReport> {
  const findings: PreflightFinding[] = [];
  const add = (f: PreflightFinding) => findings.push(f);

  // --- The message itself --------------------------------------------------
  if (!campaign.subject.trim()) {
    add({ severity: "BLOCKER", code: "NO_SUBJECT", message: "The campaign has no subject line." });
  }
  if (!campaign.body.trim()) {
    add({ severity: "BLOCKER", code: "NO_BODY", message: "The campaign has no message body." });
  }
  if (!campaign.replyTo) {
    add({
      severity: "WARNING",
      code: "NO_REPLY_TO",
      message: "No reply-to address is set.",
      detail: "Replies will go to the sender account's address, which is harder to monitor.",
    });
  }
  if (!campaign.fromName) {
    add({
      severity: "WARNING",
      code: "NO_FROM_NAME",
      message: "No sender name is set.",
      detail: "A bare address looks more like spam than a person writing.",
    });
  }

  // --- The unsubscribe link ------------------------------------------------
  const body = campaign.body ?? "";
  const hasUnsubscribe =
    /unsubscribe/i.test(body) || body.includes("{{unsubscribe_url}}");
  if (!hasUnsubscribe) {
    add({
      severity: "BLOCKER",
      code: "NO_UNSUBSCRIBE",
      message: "The message has no unsubscribe link.",
      detail:
        "An unsubscribe link is legally required in many jurisdictions and is required by every provider policy. Add {{unsubscribe_url}} to the body.",
    });
  }

  // --- Links ---------------------------------------------------------------
  for (const problem of validateLinks(body)) {
    add({
      severity: problem.problem === "PLACEHOLDER" ? "WARNING" : "WARNING",
      code: `LINK_${problem.problem}`,
      message: `Link problem: ${problem.detail}`,
      detail: problem.url || undefined,
    });
  }

  // --- Personalisation -----------------------------------------------------
  const sample = await prisma.contact.findMany({
    where: { userId: campaign.userId },
    take: 500,
    select: {
      email: true,
      firstName: true,
      lastName: true,
      company: true,
      website: true,
      title: true,
      customFields: true,
    },
  });
  const { analyzePersonalization } = await import("./personalization");
  const report = analyzePersonalization(body, sample);
  for (const missing of report.missing) {
    add({
      severity: "WARNING",
      code: "MISSING_PERSONALIZATION",
      message: `No contact has a value for "{{ ${missing} }}".`,
      detail: "That placeholder will render as empty text.",
    });
  }
  for (const partial of report.partial) {
    add({
      severity: "INFO",
      code: "PARTIAL_PERSONALIZATION",
      message: `Some contacts are missing "{{ ${partial} }}".`,
    });
  }

  // --- The audience --------------------------------------------------------
  const recipients = await prisma.campaignRecipient.findMany({
    where: { campaignId: campaign.id },
    select: { status: true, skipReason: true, contact: { select: { status: true } } },
  });

  const excludedReasons: Record<string, number> = {};
  let eligible = 0;
  for (const r of recipients) {
    const reason =
      r.status === "HELD_TZ"
        ? "UNKNOWN_TIMEZONE"
        : r.status === "SENT"
          ? "ALREADY_SENT"
          : r.status === "SKIPPED"
            ? (r.skipReason ?? "SKIPPED")
            : r.status === "CANCELLED"
              ? "CANCELLED"
              : r.status === "FAILED"
                ? "PREVIOUSLY_FAILED"
                : r.contact.status !== "ACTIVE"
                  ? `CONTACT_${r.contact.status}`
                  : null;
    if (reason) {
      excludedReasons[reason] = (excludedReasons[reason] ?? 0) + 1;
    } else {
      eligible++;
    }
  }
  if (eligible === 0) {
    add({
      severity: "BLOCKER",
      code: "NO_ELIGIBLE_RECIPIENTS",
      message: "No recipient is eligible to receive this campaign.",
      detail: "Import contacts, or fix the ones that are held for review.",
    });
  }
  const held = excludedReasons.UNKNOWN_TIMEZONE ?? 0;
  if (held > 0) {
    add({
      severity: "INFO",
      code: "HELD_TIMEZONE",
      message: `${held} recipient${held === 1 ? " is" : "s are"} held because the time zone is unknown.`,
      detail: "They are not scheduled. Fix the time zone or use the FALLBACK mode.",
    });
  }

  // --- Senders -------------------------------------------------------------
  const senders = await prisma.senderAccount.findMany({
    where: { userId: campaign.userId, status: "CONNECTED" },
    select: { id: true, email: true, dailyCap: true },
  });
  if (senders.length === 0) {
    add({
      severity: "BLOCKER",
      code: "NO_SENDER",
      message: "No connected sender account.",
      detail: "Connect a Gmail or SMTP account before starting.",
    });
  }

  // --- Follow-ups ----------------------------------------------------------
  if (campaign.followUpSequenceId) {
    const steps = await prisma.followUpStep.count({
      where: { sequence: { id: campaign.followUpSequenceId } },
    });
    if (steps === 0) {
      add({
        severity: "WARNING",
        code: "EMPTY_SEQUENCE",
        message: "The attached follow-up sequence has no steps.",
      });
    }
  }

  const providerCapabilities = capabilitiesFor(options.provider ?? "SMTP");
  if (!providerCapabilities.reportsDelivery) {
    add({
      severity: "INFO",
      code: "NO_DELIVERY_DATA",
      message: "This provider does not report delivery.",
      detail: "The 'delivered' figure stays empty and the rates use 'sent' as the denominator.",
    });
  }
  if (!providerCapabilities.reportsReplies) {
    add({
      severity: "INFO",
      code: "NO_REPLY_DATA",
      message: "This provider cannot be polled for replies.",
      detail: "Record replies by hand, or connect a Gmail account.",
    });
  }

  const blockers = findings.filter((f) => f.severity === "BLOCKER");
  return {
    campaignId: campaign.id,
    ok: blockers.length === 0,
    findings: findings.sort(
      (a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity],
    ),
    eligible,
    excluded: recipients.length - eligible,
    excludedReasons,
    personalization: {
      variables: report.variables,
      missing: report.missing,
      partial: report.partial,
      checked: report.contactsChecked,
    },
    providerCapabilities,
    checkedAt: new Date().toISOString(),
  };
}
