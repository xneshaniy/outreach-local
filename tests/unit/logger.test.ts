import { describe, expect, it } from "vitest";
import { redact, scrubMessage } from "@/lib/logger";

/**
 * Logging must never leak a credential.
 *
 * The reset link in particular contains a token that can be used to take over
 * an account, and library error messages can embed the request that failed -
 * an OAuth exchange failure carries the authorization code.
 */
describe("log redaction", () => {
  it("redacts sensitive keys", () => {
    const out = redact({
      email: "a@b.test",
      token: "abc",
      accessToken: "abc",
      refreshToken: "abc",
      password: "hunter2",
      authorization: "Bearer x",
      cookie: "e=1",
      resetUrl: "https://x/reset-password?token=abc",
      apiKey: "k",
      secret: "s",
    });

    expect(out.email).toBe("a@b.test");
    for (const key of [
      "token",
      "accessToken",
      "refreshToken",
      "password",
      "authorization",
      "cookie",
      "resetUrl",
      "apiKey",
      "secret",
    ]) {
      expect(out[key]).toBe("[redacted]");
    }
  });

  it("keeps provider error codes, which are diagnostics and not secrets", () => {
    const out = redact({ jobId: "j1", code: "SMTP_550", exhausted: false });
    expect(out.code).toBe("SMTP_550");
    expect(out.jobId).toBe("j1");
  });

  it("removes the query string of a URL from a message", () => {
    const message =
      "request to https://oauth2.googleapis.com/token?code=4/0Aean&client_id=1 failed";
    const scrubbed = scrubMessage(message);
    expect(scrubbed).not.toContain("4/0Aean");
    expect(scrubbed).toContain("[redacted]");
  });

  it("removes an explicit authorization code from a message", () => {
    const scrubbed = scrubMessage("token exchange failed: code=4/0AVerifier&state=xyz");
    expect(scrubbed).not.toContain("4/0AVerifier");
    expect(scrubbed).toContain("code=[redacted]");
  });

  it("removes a long opaque token from a message", () => {
    const token = "a".repeat(64);
    const scrubbed = scrubMessage(`failed with ${token}`);
    expect(scrubbed).not.toContain(token);
    expect(scrubbed).toContain("[redacted]");
  });

  it("leaves ordinary messages alone", () => {
    const message = "Job sent to contact cmv123 after 42ms";
    expect(scrubMessage(message)).toBe(message);
  });
});
