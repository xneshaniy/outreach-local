import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/constants";

const PUBLIC_PATHS = [
  "/login",
  "/register",
  "/api/auth/login",
  "/api/auth/register",
  "/api/unsubscribe",
  "/api/webhooks",
  // Liveness/readiness probe — must stay reachable by load balancers.
  "/api/health",
  // The client portal has its own session; its pages are guarded by that
  // session on the server, not by the owner cookie this middleware checks.
  "/portal/login",
  "/api/auth/client-login",
  // Tracking pixels and click redirects are fetched by mail clients, which are
  // not logged in. The tokens are signed, so nothing can be forged.
  "/api/track",
];

/**
 * The client portal uses its own cookie and its own guard, so the owner
 * middleware must not block it. The portal routes re-check the client session
 * on the server for every request.
 */
const PORTAL_PREFIXES = ["/portal", "/api/portal"];

function isPortalPath(pathname: string): boolean {
  return PORTAL_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Decode a JWT payload WITHOUT verifying the signature.
 *
 * The middleware runs in the Edge Runtime, where `process.env` is inlined at
 * build time — a self-hosted deployment (bundle built on one machine, secrets
 * injected on another) would therefore not see AUTH_SECRET at runtime.
 *
 * The middleware is a *convenience gate*, never the security boundary:
 * every route handler re-validates the token signature and the `sessionVersion`
 * against the database (see src/lib/auth/guards.ts). Here we only reject
 * requests that carry no session at all, or an obviously expired one.
 */
function hasUsableSession(token: string | undefined): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    // base64url -> base64 (and restore the padding `atob` requires).
    const b64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as { exp?: number };
    if (typeof payload.exp !== "number") return true; // no exp claim -> let the server decide
    return payload.exp * 1000 > Date.now();
  } catch {
    return false;
  }
}

/**
 * Edge middleware: redirects unauthenticated page requests to /login.
 * API routes return 401 JSON (they re-validate the session server-side;
 * middleware is a convenience layer, never the only check).
 */
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (isPublic) return NextResponse.next();

  // The client portal has its own authentication (a separate cookie and
  // server-side guard), so it is not gated by the owner session here.
  if (isPortalPath(pathname)) return NextResponse.next();

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!hasUsableSession(token)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: { code: "UNAUTHORIZED", message: "Authentication required." } },
        { status: 401 },
      );
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
