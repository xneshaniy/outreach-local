import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { ApiError, zodDetails } from "./errors";
import { logger } from "./logger";

/**
 * Wrap an API route handler with consistent error handling.
 * - ApiError -> mapped JSON error
 * - ZodError -> 400 with field details
 * - anything else -> 500 (details logged, never leaked to the client)
 */
export function handleApi<Args extends unknown[]>(
  fn: (...args: Args) => Promise<NextResponse | Response>,
): (...args: Args) => Promise<NextResponse | Response> {
  return async (...args: Args) => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof ApiError) {
        return NextResponse.json(
          { error: { code: err.code, message: err.message, details: err.details } },
          { status: err.status },
        );
      }
      if (err instanceof ZodError) {
        return NextResponse.json(
          { error: { code: "VALIDATION", message: "Invalid request.", details: zodDetails(err) } },
          { status: 400 },
        );
      }
      logger.error("Unhandled API error", {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      return NextResponse.json(
        { error: { code: "INTERNAL", message: "Internal server error." } },
        { status: 500 },
      );
    }
  };
}

export function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

/**
 * CSRF protection for state-changing requests: the Origin (or Referer) header,
 * when present, must match the app origin or an explicitly allowed origin.
 * Combined with SameSite=Lax session cookies this blocks cross-site writes.
 */
export function assertSameOrigin(req: NextRequest): void {
  const allowed = new Set<string>([process.env.APP_URL ?? "http://localhost:3000", ...extraOrigins()]);

  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");
  const candidate = origin ?? (referer ? safeOrigin(referer) : null);

  // Non-browser clients (no Origin, no Referer) are allowed; session cookie
  // SameSite=Lax still prevents browser-based cross-site requests.
  if (!candidate) return;

  if (!allowed.has(candidate)) {
    throw ApiError.forbidden("Request origin not allowed.");
  }
}

function extraOrigins(): string[] {
  return (process.env.EXTRA_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function safeOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    return u.origin;
  } catch {
    return null;
  }
}

export function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

export function userAgent(req: NextRequest): string | undefined {
  return req.headers.get("user-agent") ?? undefined;
}
