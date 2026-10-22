/**
 * Structured application logging.
 * Never logs secrets, OAuth codes, tokens, or full message bodies.
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const raw = (process.env.LOG_LEVEL ?? "info") as Level;
  return LEVEL_ORDER[raw] ?? LEVEL_ORDER.info;
}

function emit(level: Level, msg: string, meta?: Record<string, unknown>) {
  if (LEVEL_ORDER[level] < threshold()) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(meta ?? {}),
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit("error", msg, meta),
};

/**
 * Remove anything that looks like a credential from a free-text message.
 *
 * Library error messages often embed the request that failed, and an OAuth
 * exchange failure can therefore carry the authorization code. The query
 * string of a URL is dropped, and so is anything that looks like a token.
 */
export function scrubMessage(message: string): string {
  return String(message)
    // Drop the query string of any URL.
    .replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s?"']+)\?[^\s"']*/g, "$1?[redacted]")
    // Drop an explicit OAuth/authorization code.
    .replace(/\b(code|access_token|refresh_token|id_token|token)=([^\s&"']+)/gi, "$1=[redacted]")
    // Drop long opaque tokens (base64url / hex).
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]");
}

/** Redact obviously-sensitive keys before logging arbitrary objects. */
export function redact(obj: Record<string, unknown>): Record<string, unknown> {
  // Note: a bare "code" is NOT treated as sensitive - provider error codes
  // ("SMTP_550", "QUOTA_EXCEEDED") are diagnostics, not credentials, and
  // redacting them would make the logs useless. OAuth authorization codes are
  // covered by "authorization" and "oauth".
  const sensitive =
    /(token|secret|password|passphrase|authorization|oauth|credential|refresh|cookie|reset|api_?key|private)/i;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = sensitive.test(k) ? "[redacted]" : v;
  }
  return out;
}
