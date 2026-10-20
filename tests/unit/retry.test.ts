import { describe, expect, it } from "vitest";
import { classifyGmailError } from "@/lib/email/gmail";
import { classifySmtpError } from "@/lib/email/smtp";
import { jobIdempotencyKey } from "@/lib/queue";
import { backoffDelayMs } from "@/worker/processJob";
import { buildMimeMessage, deterministicMessageId, encodeMimeHeader } from "@/lib/email/provider";

/**
 * Retry semantics (spec §8):
 *  - rate limits / 5xx / pre-send connection failures -> TRANSIENT (retry w/ backoff)
 *  - invalid recipient / policy -> PERMANENT (never retry)
 *  - timeout after submit / socket hang up -> AMBIGUOUS (never auto-retry)
 */

describe("classifyGmailError", () => {
  it("treats 429 rate limits as transient", () => {
    const out = classifyGmailError({ code: 429, errors: [{ reason: "rateLimitExceeded" }], message: "Rate limit" });
    expect(out.kind).toBe("transient");
    expect(out.code).toBe("RATE_LIMIT");
  });

  it("treats 5xx as transient", () => {
    expect(classifyGmailError({ code: 503, message: "Backend error" }).kind).toBe("transient");
  });

  it("treats 400 as permanent (invalid request / recipient)", () => {
    const out = classifyGmailError({ code: 400, message: "Invalid To address" });
    expect(out.kind).toBe("permanent");
  });

  it("treats timeouts as AMBIGUOUS — never assume not sent", () => {
    const out = classifyGmailError({ message: "Request timed out after 30000ms" });
    expect(out.kind).toBe("ambiguous");
  });

  it("treats socket hang ups as ambiguous", () => {
    expect(classifyGmailError({ message: "socket hang up" }).kind).toBe("ambiguous");
  });
});

describe("classifySmtpError", () => {
  it("treats 4xx SMTP responses as transient", () => {
    expect(classifySmtpError({ responseCode: 451, response: "451 try later" }).kind).toBe("transient");
  });

  it("treats 5xx SMTP responses as permanent", () => {
    expect(classifySmtpError({ responseCode: 550, response: "550 no such user" }).kind).toBe("permanent");
  });

  it("treats ECONNREFUSED as transient (never connected)", () => {
    expect(classifySmtpError({ code: "ECONNREFUSED", message: "connect ECONNREFUSED" }).kind).toBe("transient");
  });

  it("treats ECONNRESET / timeouts as ambiguous", () => {
    expect(classifySmtpError({ code: "ECONNRESET", message: "socket hang up" }).kind).toBe("ambiguous");
    expect(classifySmtpError({ code: "ETIMEDOUT", message: "timed out" }).kind).toBe("ambiguous");
  });
});

describe("job idempotency key", () => {
  it("is deterministic per campaign recipient (spec §5)", () => {
    expect(jobIdempotencyKey("rec_123")).toBe(jobIdempotencyKey("rec_123"));
    expect(jobIdempotencyKey("rec_123")).not.toBe(jobIdempotencyKey("rec_124"));
    expect(jobIdempotencyKey("rec_123")).toBe("job:rec_123");
  });
});

describe("backoff", () => {
  it("grows exponentially and stays bounded with jitter", () => {
    for (let attempt = 1; attempt <= 6; attempt++) {
      for (let i = 0; i < 50; i++) {
        const delay = backoffDelayMs(attempt);
        const base = Math.min(5000 * Math.pow(2, attempt - 1), 30 * 60 * 1000);
        expect(delay).toBeGreaterThanOrEqual(Math.floor(base * 0.5) - 1);
        expect(delay).toBeLessThanOrEqual(Math.ceil(base * 1.5) + 1);
        expect(delay).toBeLessThanOrEqual(45 * 60 * 1000); // hard cap with jitter
      }
    }
  });
});

describe("MIME construction", () => {
  const input = {
    jobId: "job1",
    idempotencyHeader: "v1:job1:1",
    fromEmail: "sender@example.com",
    fromName: "Sender Name",
    toEmail: "dest@example.com",
    toName: "Dest",
    subject: "Hello",
    html: "<p>Hi</p>",
    text: "Hi",
    unsubscribeUrl: "https://app.example/api/unsubscribe?token=abc",
  };

  it("includes Message-ID, idempotency and List-Unsubscribe headers", () => {
    const mime = buildMimeMessage({ ...input, messageId: deterministicMessageId("job1", 1) });
    expect(mime).toContain("Message-ID: <eop-job1-1@mail.outreach.local>");
    expect(mime).toContain("X-EOP-Idempotency-Key: v1:job1:1");
    expect(mime).toContain("List-Unsubscribe: <https://app.example/api/unsubscribe?token=abc>");
    expect(mime).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
  });

  it("blocks header injection through names/subjects", () => {
    const mime = buildMimeMessage({
      ...input,
      fromName: "Evil\r\nBcc: victim@example.com",
      subject: "Injected\r\nX-Header: 1",
      messageId: "m1",
    });
    expect(mime).not.toContain("Bcc: victim@example.com");
    expect(mime).not.toMatch(/X-Header: 1/);
  });

  it("encodes non-ASCII subjects as MIME words", () => {
    expect(encodeMimeHeader("Grüße")).toMatch(/^=\?UTF-8\?B\?/);
    expect(encodeMimeHeader("Plain")).toBe("Plain");
  });

  it("makes deterministic message ids per attempt", () => {
    expect(deterministicMessageId("job1", 1)).toBe(deterministicMessageId("job1", 1));
    expect(deterministicMessageId("job1", 1)).not.toBe(deterministicMessageId("job1", 2));
  });
});
