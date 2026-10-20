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

/** Redact obviously-sensitive keys before logging arbitrary objects. */
export function redact(obj: Record<string, unknown>): Record<string, unknown> {
  const sensitive = /(token|secret|password|authorization|code|credential|refresh|cookie)/i;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = sensitive.test(k) ? "[redacted]" : v;
  }
  return out;
}
