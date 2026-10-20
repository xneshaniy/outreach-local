import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { prisma } from "../db";
import { env } from "../env";
import { CLIENT_SESSION_COOKIE } from "./constants";

/**
 * Client-portal sessions.
 *
 * A client is a separate account from the workspace owner. It gets its own
 * cookie (`eop_client_session`) and its own JWT issuer, so a client token can
 * never be mistaken for an owner token and vice versa.
 *
 * The token carries the client's id and the workspace owner's id. Every
 * authorisation decision is re-checked against the database (is the client
 * still active? does it still have access to this campaign?), so revoking
 * access takes effect immediately.
 */

export { CLIENT_SESSION_COOKIE };

export type ClientSessionPayload = {
  cid: string; // client id
  uid: string; // workspace owner id
  email: string;
  sv: number; // client session version
};

function secretKey(): Uint8Array {
  return new TextEncoder().encode(env.authSecret);
}

export async function createClientSessionToken(payload: ClientSessionPayload): Promise<string> {
  return new SignJWT({ uid: payload.uid, email: payload.email, sv: payload.sv, typ: "client" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.cid)
    .setIssuedAt()
    .setIssuer("email-outreach-client")
    .setExpirationTime(`${env.sessionTtlSeconds}s`)
    .sign(secretKey());
}

export async function verifyClientSessionToken(token: string): Promise<ClientSessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), { issuer: "email-outreach-client" });
    if (!payload.sub || typeof payload.sv !== "number" || typeof payload.uid !== "string") return null;
    return {
      cid: payload.sub,
      uid: payload.uid,
      email: String(payload.email ?? ""),
      sv: payload.sv,
    };
  } catch {
    return null;
  }
}

export async function setClientSessionCookie(payload: ClientSessionPayload): Promise<void> {
  const token = await createClientSessionToken(payload);
  const jar = await cookies();
  jar.set(CLIENT_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env.isProd,
    sameSite: "lax",
    path: "/",
    maxAge: env.sessionTtlSeconds,
  });
}

export async function clearClientSessionCookie(): Promise<void> {
  const jar = await cookies();
  jar.set(CLIENT_SESSION_COOKIE, "", {
    httpOnly: true,
    secure: env.isProd,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

export type AuthenticatedClient = {
  id: string;
  userId: string;
  email: string;
  name: string;
  company: string | null;
};

/**
 * Resolve the client from the session cookie.
 * Returns null when there is no valid session (or the account was deactivated).
 */
export async function getCurrentClient(): Promise<AuthenticatedClient | null> {
  const jar = await cookies();
  const token = jar.get(CLIENT_SESSION_COOKIE)?.value;
  if (!token) return null;

  const session = await verifyClientSessionToken(token);
  if (!session) return null;

  const client = await prisma.client.findFirst({
    where: { id: session.cid, userId: session.uid, isActive: true },
    select: { id: true, userId: true, email: true, name: true, company: true, sessionVersion: true },
  });
  if (!client) return null;
  // A password change or a forced sign-out invalidates outstanding sessions.
  if (client.sessionVersion !== session.sv) return null;

  return { id: client.id, userId: client.userId, email: client.email, name: client.name, company: client.company };
}

/**
 * The campaign ids this client may see.
 *
 * EVERY portal query is filtered by this list. It is the single place where
 * access is decided, so a client can never read another client's campaigns.
 */
export async function getClientCampaignIds(clientId: string): Promise<string[]> {
  const rows = await prisma.clientCampaignAccess.findMany({
    where: { clientId },
    select: { campaignId: true },
  });
  return rows.map((r) => r.campaignId);
}

/** True when the client has been explicitly given access to this campaign. */
export async function clientCanAccessCampaign(clientId: string, campaignId: string): Promise<boolean> {
  const row = await prisma.clientCampaignAccess.findFirst({
    where: { clientId, campaignId },
    select: { id: true },
  });
  return row !== null;
}
