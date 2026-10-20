import { createHash } from "crypto";
import type { Contact } from "@prisma/client";
import { env } from "./env";
import { hmacSign, hmacVerify } from "./crypto";

/**
 * Template rendering + unsubscribe token handling.
 *
 * Templates use {{variable}} placeholders. Available variables come from the
 * contact record plus a few derived ones. Rendering is plain-text-safe:
 * values are HTML-escaped because Gmail bodies are HTML by default.
 */

export type RenderVars = Record<string, string>;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function contactVars(contact: Pick<Contact, "email" | "firstName" | "lastName" | "company" | "website" | "title" | "customFields">): RenderVars {
  const custom = (contact.customFields ?? {}) as Record<string, unknown>;
  return {
    email: contact.email,
    first_name: contact.firstName ?? "",
    last_name: contact.lastName ?? "",
    full_name: [contact.firstName, contact.lastName].filter(Boolean).join(" "),
    company: contact.company ?? "",
    website: contact.website ?? "",
    title: contact.title ?? "",
    ...Object.fromEntries(
      Object.entries(custom).map(([k, v]) => [k, v == null ? "" : String(v)]),
    ),
  };
}

/**
 * Render a template. Unknown variables render as empty strings so a missing
 * CSV column can never leak a raw placeholder into an email.
 */
export function renderTemplate(template: string, vars: RenderVars): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key: string) => {
    const value = vars[key];
    return value === undefined ? "" : escapeHtml(value);
  });
}

/** List of variables referenced by a template (for the editor UI). */
export function extractVariables(template: string): string[] {
  const found = new Set<string>();
  for (const m of template.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
    found.add(m[1]!);
  }
  return [...found].sort();
}

// ---------------------------------------------------------------------------
// Unsubscribe tokens (stateless, HMAC-signed)
// ---------------------------------------------------------------------------

export type UnsubscribeTokenPayload = {
  /** contact id */
  c: string;
  /** user (workspace) id */
  u: string;
  /** optional campaign id (campaign-scoped unsubscribe) */
  p?: string;
};

export function signUnsubscribeToken(payload: UnsubscribeTokenPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = hmacSign(body);
  return `${body}.${sig}`;
}

export function verifyUnsubscribeToken(token: string): UnsubscribeTokenPayload | null {
  const idx = token.lastIndexOf(".");
  if (idx <= 0) return null;
  const body = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  if (!hmacVerify(body, sig)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof parsed?.c !== "string" || typeof parsed?.u !== "string") return null;
    return parsed as UnsubscribeTokenPayload;
  } catch {
    return null;
  }
}

export function unsubscribeUrl(payload: UnsubscribeTokenPayload): string {
  const token = signUnsubscribeToken(payload);
  return `${env.appUrl}/api/unsubscribe?token=${encodeURIComponent(token)}`;
}

/**
 * Compose the final message payload for a campaign recipient.
 * The caller passes a pre-signed unsubscribe URL (it needs the real
 * contact/campaign ids, which live in the worker's job context).
 */
export function renderEmail(input: {
  subject: string;
  body: string;
  contact: Parameters<typeof contactVars>[0];
  unsubscribeUrl: string;
}): { subject: string; html: string; text: string } {
  const vars = {
    ...contactVars(input.contact),
    unsubscribe_url: input.unsubscribeUrl,
  };
  const subject = renderTemplate(input.subject, vars);
  const html = renderTemplate(input.body, vars);
  const text = html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ").trim();
  return { subject, html, text };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
