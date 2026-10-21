import { describe, expect, it } from "vitest";
import { validateLinks } from "@/lib/link-check";
import { parseSegmentFilters, segmentWhere } from "@/lib/segments";
import { deriveMessageStatus, MESSAGE_STATUS_INFO } from "@/lib/message-status";
import { capabilitiesFor, unavailableMetrics } from "@/lib/provider-capabilities";
import { mockOutbox, clearMockOutbox, mockProvider } from "@/lib/email/mock";
import { dryRunMessageId } from "@/lib/email/dry-run";

/**
 * Unit tests for the pipeline / CRM / reporting helpers.
 */

describe("validateLinks", () => {
  it("accepts ordinary https links", () => {
    expect(validateLinks('<a href="https://example.com/x">x</a>')).toEqual([]);
  });

  it("flags a placeholder link", () => {
    const problems = validateLinks('<a href="https://example.com">x</a>');
    expect(problems.some((p) => p.problem === "PLACEHOLDER")).toBe(true);
  });

  it("flags an empty href", () => {
    const problems = validateLinks('<a href="">x</a>');
    expect(problems.some((p) => p.problem === "INVALID_URL")).toBe(true);
  });

  it("flags a relative link", () => {
    const problems = validateLinks('<a href="/pricing">x</a>');
    expect(problems.some((p) => p.problem === "NOT_HTTP")).toBe(true);
  });

  it("leaves mailto and tel alone", () => {
    expect(validateLinks('<a href="mailto:a@b.com">m</a><a href="tel:+1">t</a>')).toEqual([]);
  });

  it("flags unbalanced anchor tags", () => {
    const problems = validateLinks('<a href="https://x.test">one');
    expect(problems.some((p) => p.problem === "UNBALANCED_MARKUP")).toBe(true);
  });
});

describe("parseSegmentFilters", () => {
  it("keeps only the known filter keys", () => {
    const filters = parseSegmentFilters({
      status: ["ACTIVE"],
      tags: ["saas"],
      hasTimeZone: true,
      consentedOnly: true,
      search: "  acme ",
      evil: "dropped",
      limit: 999,
    });
    expect(filters.status).toEqual(["ACTIVE"]);
    expect(filters.tags).toEqual(["saas"]);
    expect(filters.hasTimeZone).toBe(true);
    expect(filters.consentedOnly).toBe(true);
    expect(filters.search).toBe("acme");
    expect("evil" in filters).toBe(false);
    expect("limit" in filters).toBe(false);
  });

  it("ignores a non-object", () => {
    expect(parseSegmentFilters("nope")).toEqual({});
  });
});

describe("segmentWhere", () => {
  it("always scopes to the workspace and excludes archived contacts", () => {
    const where = segmentWhere("user-1", {});
    expect(where.userId).toBe("user-1");
    expect(where.isArchived).toBe(false);
  });

  it("requires every requested tag", () => {
    const where = segmentWhere("user-1", { tags: ["saas", "agency"] }) as {
      AND: Array<{ tags: { has: string } }>;
    };
    expect(where.AND).toHaveLength(2);
    expect(where.AND.map((a) => a.tags.has)).toEqual(["saas", "agency"]);
  });

  it("never leaks another workspace's contacts", () => {
    const where = segmentWhere("user-1", { search: "x" }) as { userId: string };
    expect(where.userId).toBe("user-1");
  });
});

describe("deriveMessageStatus", () => {
  const base = {
    job: null,
    recipient: null,
    contact: null,
    replied: false,
  };

  it("reports ACCEPTED when the provider took it", () => {
    const status = deriveMessageStatus({
      ...base,
      job: { status: "SENT", scheduledAt: new Date(), deliveredAt: null, deadLetteredAt: null, lastError: null },
    });
    expect(status).toBe("ACCEPTED");
  });

  it("reports DELIVERED only when a delivery event confirmed it", () => {
    const status = deriveMessageStatus({
      ...base,
      job: { status: "SENT", scheduledAt: new Date(), deliveredAt: new Date(), deadLetteredAt: null, lastError: null },
    });
    expect(status).toBe("DELIVERED");
  });

  it("never conflates ACCEPTED with DELIVERED", () => {
    const accepted = deriveMessageStatus({
      ...base,
      job: { status: "SENT", scheduledAt: new Date(), deliveredAt: null, deadLetteredAt: null, lastError: null },
    });
    expect(accepted).not.toBe("DELIVERED");
  });

  it("reports REPLIED when a reply arrived", () => {
    const status = deriveMessageStatus({
      ...base,
      job: { status: "SENT", scheduledAt: new Date(), deliveredAt: new Date(), deadLetteredAt: null, lastError: null },
      replied: true,
    });
    expect(status).toBe("REPLIED");
  });

  it("reports UNSUBSCRIBED when the contact opted out", () => {
    const status = deriveMessageStatus({
      ...base,
      contact: { status: "UNSUBSCRIBED" },
    });
    expect(status).toBe("UNSUBSCRIBED");
  });

  it("reports SCHEDULED for a job in the future and QUEUED for one now", () => {
    const future = deriveMessageStatus({
      ...base,
      job: {
        status: "QUEUED",
        scheduledAt: new Date(Date.now() + 60_000),
        deliveredAt: null,
        deadLetteredAt: null,
        lastError: null,
      },
    });
    expect(future).toBe("SCHEDULED");

    const now = deriveMessageStatus({
      ...base,
      job: { status: "QUEUED", scheduledAt: new Date(Date.now() - 1000), deliveredAt: null, deadLetteredAt: null, lastError: null },
    });
    expect(now).toBe("QUEUED");
  });

  it("reports PROCESSING for a claimed job", () => {
    const status = deriveMessageStatus({
      ...base,
      job: { status: "CLAIMED", scheduledAt: new Date(), deliveredAt: null, deadLetteredAt: null, lastError: null },
    });
    expect(status).toBe("PROCESSING");
  });

  it("has a label for every status", () => {
    for (const key of Object.keys(MESSAGE_STATUS_INFO)) {
      expect(MESSAGE_STATUS_INFO[key as keyof typeof MESSAGE_STATUS_INFO].label.length).toBeGreaterThan(0);
    }
  });
});

describe("provider capabilities", () => {
  it("knows that Gmail does not report delivery", () => {
    expect(capabilitiesFor("GMAIL").reportsDelivery).toBe(false);
    expect(capabilitiesFor("GMAIL").reportsReplies).toBe(true);
  });

  it("knows that SMTP cannot report replies", () => {
    expect(capabilitiesFor("SMTP").reportsReplies).toBe(false);
    expect(capabilitiesFor("SMTP").reportsDelivery).toBe(false);
  });

  it("lists the metrics a provider cannot supply", () => {
    expect(unavailableMetrics("SMTP")).toContain("delivered");
    expect(unavailableMetrics("SMTP")).toContain("replies");
  });
});

describe("mock provider", () => {
  it("accepts a message without touching the network", async () => {
    clearMockOutbox();
    const outcome = await mockProvider.send(
      { id: "a1" } as never,
      {
        jobId: "job-1",
        idempotencyHeader: "v1:job-1:1",
        fromEmail: "me@example.test",
        fromName: null,
        toEmail: "you@example.test",
        toName: null,
        replyTo: null,
        subject: "Hello",
        html: "<p>Hi</p>",
        text: "Hi",
        unsubscribeUrl: "https://x.test/u",
        headers: {},
      },
    );
    expect(outcome.kind).toBe("ok");
    expect(mockOutbox()).toHaveLength(1);
    expect(mockOutbox()[0]!.to).toBe("you@example.test");
  });

  it("marks a dry-run message id clearly", () => {
    expect(dryRunMessageId("job-1", 1)).toContain("dry-run:");
  });
});
