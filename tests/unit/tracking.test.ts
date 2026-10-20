import { describe, expect, it } from "vitest";
import {
  buildClickUrl,
  buildDedupeKey,
  buildOpenPixelUrl,
  classifyTrackingRequest,
  injectTrackingPixel,
  rewriteLinksForTracking,
  signTrackingToken,
  TRACKING_PIXEL_GIF,
  verifyTrackingToken,
} from "@/lib/tracking";

/**
 * Unit tests for the tracking helpers.
 *
 * The behaviour that matters: a token cannot be forged, a link cannot be
 * hijacked, automated traffic is recognised, and the unsubscribe link is never
 * rewritten.
 */

describe("tracking tokens", () => {
  it("signs and verifies an open token", () => {
    const token = signTrackingToken("open", ["camp1", "contact1"]);
    expect(verifyTrackingToken("open", token)).toEqual(["camp1", "contact1"]);
  });

  it("rejects a tampered token", () => {
    const token = signTrackingToken("open", ["camp1", "contact1"]);
    const [body, sig] = token.split(".");
    const forged = `${body}x.${sig}`;
    expect(verifyTrackingToken("open", forged)).toBeNull();
  });

  it("rejects a token signed for a different scope", () => {
    const token = signTrackingToken("open", ["camp1", "contact1"]);
    // A click token must never be replayable as an open.
    expect(verifyTrackingToken("click", token)).toBeNull();
  });

  it("rejects garbage", () => {
    expect(verifyTrackingToken("open", "nonsense")).toBeNull();
    expect(verifyTrackingToken("open", "")).toBeNull();
    expect(verifyTrackingToken("open", "a.b")).toBeNull();
  });

  it("round-trips a target URL with special characters", () => {
    const url = "https://example.com/a?b=1&c=two#frag";
    const token = signTrackingToken("click", ["camp1", "contact1", url]);
    const parts = verifyTrackingToken("click", token);
    expect(parts).toEqual(["camp1", "contact1", url]);
  });
});

describe("tracking URLs", () => {
  it("builds a pixel URL that carries a signed token", () => {
    const url = buildOpenPixelUrl("camp1", "contact1");
    expect(url).toContain("/api/track/open?t=");
    const token = decodeURIComponent(url.split("t=")[1]!);
    expect(verifyTrackingToken("open", token)).toEqual(["camp1", "contact1"]);
  });

  it("builds a click URL that carries the target", () => {
    const url = buildClickUrl("camp1", "contact1", "https://example.com/offer");
    expect(url).toContain("/api/track/click?t=");
    const token = decodeURIComponent(url.split("t=")[1]!);
    expect(verifyTrackingToken("click", token)).toEqual([
      "camp1",
      "contact1",
      "https://example.com/offer",
    ]);
  });
});

describe("rewriteLinksForTracking", () => {
  it("rewrites http(s) links", () => {
    const html = '<p><a href="https://example.com/offer">See the offer</a></p>';
    const out = rewriteLinksForTracking(html, "camp1", "contact1");
    expect(out).not.toContain('href="https://example.com/offer"');
    expect(out).toContain("/api/track/click?t=");
    // The link text is untouched.
    expect(out).toContain("See the offer");
  });

  it("leaves mailto, tel and relative links alone", () => {
    const html =
      '<a href="mailto:a@b.com">mail</a><a href="tel:+123">call</a><a href="/local">local</a>';
    const out = rewriteLinksForTracking(html, "camp1", "contact1");
    expect(out).toBe(html);
  });

  it("never rewrites the unsubscribe link", () => {
    const unsub = "https://app.example.com/api/unsubscribe?token=abc";
    const html = `<p><a href="${unsub}">Unsubscribe</a></p>`;
    const out = rewriteLinksForTracking(html, "camp1", "contact1", { skipUrls: [unsub] });
    expect(out).toBe(html);
  });

  it("keeps single-quoted attributes working", () => {
    const html = "<a href='https://example.com/x'>x</a>";
    const out = rewriteLinksForTracking(html, "camp1", "contact1");
    expect(out).toContain("href='");
    expect(out).toContain("/api/track/click?t=");
  });
});

describe("injectTrackingPixel", () => {
  it("adds the pixel before the closing body tag", () => {
    const out = injectTrackingPixel("<html><body><p>Hi</p></body></html>", "https://x/p.gif");
    expect(out).toContain('src="https://x/p.gif"');
    expect(out).toContain("aria-hidden");
    expect(out.indexOf("p.gif")).toBeLessThan(out.indexOf("</body>"));
  });

  it("appends the pixel when there is no body tag", () => {
    const out = injectTrackingPixel("<p>Hi</p>", "https://x/p.gif");
    expect(out).toContain("p.gif");
    expect(out.startsWith("<p>Hi</p>")).toBe(true);
  });

  it("ships a real 1x1 GIF", () => {
    expect(TRACKING_PIXEL_GIF.subarray(0, 3).toString("ascii")).toBe("GIF");
    expect(TRACKING_PIXEL_GIF.length).toBeGreaterThan(20);
  });
});

describe("classifyTrackingRequest", () => {
  it("classifies a normal mail client as HUMAN", () => {
    expect(
      classifyTrackingRequest({
        userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
        ipAddress: "203.0.113.9",
      }),
    ).toBe("HUMAN");
  });

  it("classifies a security scanner as BOT", () => {
    expect(classifyTrackingRequest({ userAgent: "Mozilla/5.0 (compatible; Googlebot/2.1)" })).toBe("BOT");
    expect(classifyTrackingRequest({ userAgent: "curl/8.4.0" })).toBe("BOT");
    expect(classifyTrackingRequest({ userAgent: "Mozilla/5.0 (compatible; LinkChecker)" })).toBe("BOT");
  });

  it("classifies Apple Mail Privacy Protection as PREVIEW", () => {
    expect(
      classifyTrackingRequest({ userAgent: "Mozilla/5.0 (Macintosh) AppleMail privacy proxy" }),
    ).toBe("PREVIEW");
  });

  it("classifies an image proxy IP as PREVIEW", () => {
    expect(classifyTrackingRequest({ userAgent: "Mozilla/5.0", ipAddress: "17.1.2.3" })).toBe("PREVIEW");
    expect(classifyTrackingRequest({ userAgent: "Mozilla/5.0", ipAddress: "66.249.66.1" })).toBe("PREVIEW");
  });
});

describe("buildDedupeKey", () => {
  it("gives one key per recipient for opens", () => {
    const a = buildDedupeKey("OPEN", "camp1", "contact1");
    const b = buildDedupeKey("OPEN", "camp1", "contact1");
    const c = buildDedupeKey("OPEN", "camp1", "contact2");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("gives one key per recipient AND link for clicks", () => {
    const a = buildDedupeKey("CLICK", "camp1", "contact1", "https://x/1");
    const b = buildDedupeKey("CLICK", "camp1", "contact1", "https://x/2");
    expect(a).not.toBe(b);
  });

  it("separates opens from clicks", () => {
    expect(buildDedupeKey("OPEN", "c", "k")).not.toBe(buildDedupeKey("CLICK", "c", "k", "u"));
  });
});
