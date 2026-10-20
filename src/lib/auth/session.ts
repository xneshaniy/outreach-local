import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { env } from "../env";

/**
 * Session management.
 *
 * - Stateless JWT (HS256) in an HttpOnly, SameSite=Lax, Secure(in prod) cookie.
 * - `sessionVersion` is embedded in the token and checked against the DB row,
 *   so "log out everywhere"/account changes invalidate outstanding sessions.
 * - The token is never exposed to client-side JavaScript.
 */

export const SESSION_COOKIE = "eop_session";

export type SessionPayload = {
  sub: string; // user id
  email: string;
  sv: number; // session version
};

function secretKey(): Uint8Array {
  return new TextEncoder().encode(env.authSecret);
}

export async function createSessionToken(payload: SessionPayload): Promise<string> {
  return new SignJWT({ email: payload.email, sv: payload.sv })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setIssuer("email-outreach-platform")
    .setExpirationTime(`${env.sessionTtlSeconds}s`)
    .sign(secretKey());
}

export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), { issuer: "email-outreach-platform" });
    if (!payload.sub || typeof payload.sv !== "number") return null;
    return { sub: payload.sub, email: String(payload.email ?? ""), sv: payload.sv };
  } catch {
    return null;
  }
}

export async function setSessionCookie(payload: SessionPayload): Promise<void> {
  const token = await createSessionToken(payload);
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env.isProd,
    sameSite: "lax",
    path: "/",
    maxAge: env.sessionTtlSeconds,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: env.isProd,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

export async function readSessionToken(): Promise<SessionPayload | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySessionToken(token);
}
