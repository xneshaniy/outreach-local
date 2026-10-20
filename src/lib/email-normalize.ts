/**
 * Canonical email normalization.
 *
 * Used EVERYWHERE an address is deduplicated or suppression-checked:
 *  - contact creation        (UNIQUE (userId, emailNormalized))
 *  - campaign membership     (UNIQUE (campaignId, contactId) via contact)
 *  - suppression lookups
 *
 * Rules:
 *  - trim + lowercase the whole address
 *  - Gmail-family domains (gmail.com, googlemail.com): strip "+tag" and dots
 *    from the local part, since Gmail treats a.b+tag@gmail.com as ab@gmail.com
 *  - other domains: keep the local part verbatim (dots are significant)
 */

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

// Pragmatic validation: one "@", non-empty local part, dotted domain, no spaces.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email) && email.length <= 320;
}

export function normalizeEmail(email: string): string {
  const cleaned = email.trim().toLowerCase();
  const at = cleaned.lastIndexOf("@");
  if (at <= 0) return cleaned;
  let local = cleaned.slice(0, at);
  let domain = cleaned.slice(at + 1);
  if (GMAIL_DOMAINS.has(domain)) {
    // googlemail.com and gmail.com are the same mailbox; canonicalize to gmail.
    domain = "gmail.com";
    const plus = local.indexOf("+");
    if (plus > 0) local = local.slice(0, plus);
    local = local.replace(/\./g, "");
  }
  return `${local}@${domain}`;
}

/**
 * Normalize an IANA time zone name; returns null if unknown/invalid.
 */
export function normalizeTimeZone(tz: string | null | undefined): string | null {
  if (!tz) return null;
  const trimmed = tz.trim();
  if (!trimmed) return null;
  try {
    // Throws RangeError for invalid zones.
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format(new Date());
    return trimmed;
  } catch {
    return null;
  }
}
