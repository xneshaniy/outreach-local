import { createHmac, timingSafeEqual } from "crypto";
import { env } from "./env";

/**
 * Open and click tracking.
 *
 * ## How it works
 *
 * **Open tracking** adds a 1x1 transparent GIF to the message body. The pixel
 * URL carries a signed token, so a third party cannot forge an open for a
 * recipient they do not own, and the recipient id cannot be guessed.
 *
 * **Click tracking** rewrites the links in the body to a redirecting URL that
 * carries a signed token. The token binds (campaign, contact, target URL), so
 * the redirect can be verified before anything is recorded or opened.
 *
 * ## What it is NOT
 *
 * An open is **not** proof that a human read the message. Many clients fetch
 * images automatically, most block them, and Apple Mail Privacy Protection
 * pre-fetches images from its own proxy, which looks exactly like an open.
 * Security scanners and link checkers do the same.
 *
 * The API therefore classifies every event as HUMAN, PREVIEW or BOT and the
 * reports exclude the non-human ones from the *rates* while still showing the
 * raw totals. Always read an open rate as an approximation.
 *
 * ## Provider support
 *
 * The Gmail API does **not** expose per-recipient open or delivery events for
 * ordinary accounts, and SMTP does not either. These are first-party
 * trackers, so they work with any provider — but they are only as accurate as
 * the client allows, and they require the campaign to opt in.
 */

export const TRACKING_PIXEL_PATH = "/api/track/open";
export const TRACKING_CLICK_PATH = "/api/track/click";

/** A 1x1 transparent GIF — the smallest thing a mail client will render. */
export const TRACKING_PIXEL_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

function hmac(payload: string): string {
  return createHmac("sha256", env.authSecret).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Sign a tracking token.
 * `scope` separates opens from clicks so a click token can never be replayed
 * as an open.
 *
 * The signature covers the ENCODED body, so the verifier can check it before
 * decoding anything.
 */
export function signTrackingToken(scope: "open" | "click", parts: string[]): string {
  const encoded = Buffer.from([scope, ...parts].join("|"), "utf8").toString("base64url");
  return `${encoded}.${hmac(encoded)}`;
}

/** Verify a tracking token and return its parts, or null when invalid. */
export function verifyTrackingToken(
  scope: "open" | "click",
  token: string,
): string[] | null {
  const idx = token.lastIndexOf(".");
  if (idx <= 0) return null;
  const body = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  if (!safeEqual(hmac(body), sig)) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(body, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const parts = decoded.split("|");
  if (parts[0] !== scope) return null;
  return parts.slice(1);
}

/**
 * The tracking pixel URL for one recipient.
 * `contactId` is embedded in the signed token, never in the clear.
 */
export function buildOpenPixelUrl(campaignId: string, contactId: string): string {
  const token = signTrackingToken("open", [campaignId, contactId]);
  return `${env.appUrl}${TRACKING_PIXEL_PATH}?t=${encodeURIComponent(token)}`;
}

/** A tracked redirect URL for one link. */
export function buildClickUrl(campaignId: string, contactId: string, targetUrl: string): string {
  const token = signTrackingToken("click", [campaignId, contactId, targetUrl]);
  return `${env.appUrl}${TRACKING_CLICK_PATH}?t=${encodeURIComponent(token)}`;
}

/**
 * Rewrite the links in an HTML body so they point at the tracker.
 *
 * Only http(s) links are rewritten. `mailto:`, `tel:` and unsubscribe links
 * are left alone — the unsubscribe link must keep working exactly as before.
 */
export function rewriteLinksForTracking(
  html: string,
  campaignId: string,
  contactId: string,
  options: { skipUrls?: string[] } = {},
): string {
  const skip = (options.skipUrls ?? []).filter(Boolean);
  return html.replace(/<a\b([^>]*?)href\s*=\s*("([^"]*)"|'([^']*)')([^>]*)>/gi, (match, before, _q, dq, sq, after) => {
    const url = dq ?? sq ?? "";
    if (!/^https?:\/\//i.test(url)) return match;
    if (skip.some((s) => url.startsWith(s))) return match;
    const tracked = buildClickUrl(campaignId, contactId, url);
    const quote = dq !== undefined ? '"' : "'";
    return `<a${before}href=${quote}${tracked}${quote}${after}>`;
  });
}

/**
 * Append the tracking pixel to an HTML body.
 * The image is marked `aria-hidden` and has a 1x1 size so it is invisible.
 */
export function injectTrackingPixel(html: string, pixelUrl: string): string {
  const pixel = `<img src="${pixelUrl}" width="1" height="1" alt="" style="display:none!important;width:1px!important;height:1px!important;border:0;outline:none;opacity:0;" aria-hidden="true" decoding="async" tabindex="-1" role="presentation" />`;
  if (html.includes("</body>")) return html.replace("</body>", `${pixel}</body>`);
  return `${html}${pixel}`;
}

// ---------------------------------------------------------------------------
// Bot / preview detection
// ---------------------------------------------------------------------------

/** User agents of scanners, link checkers and image proxies. */
const BOT_PATTERNS: RegExp[] = [
  /bot\b/i,
  /crawler/i,
  /spider/i,
  /slurp/i,
  /scrapy/i,
  /headlesschrome/i,
  /phantomjs/i,
  /lighthouse/i,
  /pingdom|uptimerobot|statuscake|site24x7|newrelicpinger/i,
  /facebookexternalhit|twitterbot|linkedinbot|slackbot|discordbot|telegrambot|whatsapp/i,
  /mailgun|postmark|sendgrid|mailchimp|sparkpost/i,
  /apachebench|curl\/|wget\/|python-requests|go-http-client|okhttp|axios|node-fetch/i,
  /linkchecker|validator|link-?validator|checker/i,
  /preview|scanner|virus|antivirus|mcafee|norton|symantec/i,
  /googleimageproxy|google-proxy/i,
  /yahoobot|duckduckbot|baiduspider|yandexbot|sogou|exabot|ia_archiver/i,
];

/**
 * Apple Mail Privacy Protection and similar relays fetch images from a
 * proxy, so the request never comes from the recipient's own address.
 */
const PROXY_IP_PATTERNS: RegExp[] = [
  /^17\./, // Apple
  /^66\.249\.66\./, // Google image proxy
  /^199\.47\./, // Fastly / Apple
  /^104\./, // various image proxies
  /^192\.0\./, // WordPress proxy
  /^3\./, // Amazon
];

/** Classify a tracking request. */
export function classifyTrackingRequest(input: {
  userAgent?: string | null;
  ipAddress?: string | null;
}): "HUMAN" | "PREVIEW" | "BOT" {
  const ua = (input.userAgent ?? "").toLowerCase();
  const ip = input.ipAddress ?? "";

  if (ua && BOT_PATTERNS.some((re) => re.test(ua))) return "BOT";
  if (ip && PROXY_IP_PATTERNS.some((re) => re.test(ip))) return "PREVIEW";
  // Apple Mail Privacy Protection sends a distinctive user agent.
  if (ua.includes("applemail") || ua.includes("apple-mail") || ua.includes("privacy.apple")) {
    return "PREVIEW";
  }
  if (ua.includes("microsoft outlook") && ua.includes("preview")) return "PREVIEW";
  return "HUMAN";
}

/**
 * The dedupe key for an event.
 *
 * Opens are unique per (campaign, recipient); clicks are unique per
 * (campaign, recipient, link). The key is stored only on the FIRST event —
 * repeats keep a NULL key, which a Postgres unique index allows many times.
 */
export function buildDedupeKey(
  type: "OPEN" | "CLICK",
  campaignId: string,
  contactId: string,
  url?: string | null,
): string {
  if (type === "OPEN") return `open:${campaignId}:${contactId}`;
  return `click:${campaignId}:${contactId}:${url ?? ""}`;
}

/**
 * The number of characters a tracking token adds to a link.
 * Useful to keep an eye on URL length limits.
 */
export function trackingOverhead(url: string): number {
  return buildClickUrl("c", "k", url).length - url.length;
}
