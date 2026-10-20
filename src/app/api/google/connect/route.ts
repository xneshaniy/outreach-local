import { NextResponse } from "next/server";
import { SignJWT } from "jose";
import { handleApi } from "@/lib/http";
import { requireUser } from "@/lib/auth/guards";
import { env } from "@/lib/env";
import { ApiError } from "@/lib/errors";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { randomBytes } from "crypto";

/**
 * POST /api/google/connect
 * Starts the official Google OAuth 2.0 flow (authorization code + PKCE-less
 * confidential client). Returns the consent-screen URL.
 *
 * CSRF protection: a random `state` is minted, signed (HMAC via JWT) and
 * stored in a short-lived HttpOnly cookie; the callback verifies it.
 * We NEVER ask for Gmail passwords or automate Google sign-in.
 */
export const POST = handleApi(async () => {
  const user = await requireUser();

  if (!env.googleConfigured) {
    throw ApiError.badRequest(
      "Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (see docs/GOOGLE_OAUTH.md).",
    );
  }

  const count = await prisma.senderAccount.count({ where: { userId: user.id } });
  if (count >= env.maxSenderAccounts) {
    throw ApiError.badRequest(`You can connect at most ${env.maxSenderAccounts} sender accounts.`);
  }

  const nonce = randomBytes(16).toString("base64url");
  const state = await new SignJWT({ uid: user.id, nonce })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(env.authSecret));

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", env.googleClientId);
  url.searchParams.set("redirect_uri", env.googleRedirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", env.googleScopes.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);

  await audit(prisma, { userId: user.id, action: "google.oauth_start", entityType: "SenderAccount" });

  const res = NextResponse.json({ url: url.toString() });
  res.cookies.set("google_oauth_state", state, {
    httpOnly: true,
    secure: env.isProd,
    sameSite: "lax",
    path: "/api/google",
    maxAge: 600,
  });
  return res;
});
