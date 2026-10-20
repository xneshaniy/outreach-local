import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";
import { google } from "googleapis";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { encryptSecret } from "@/lib/crypto";
import { logger } from "@/lib/logger";
import { audit } from "@/lib/audit";
import { tokenAad } from "@/lib/email/gmail";
import { requireUser } from "@/lib/auth/guards";

/**
 * GET /api/google/callback
 * OAuth 2.0 redirect target. Verifies the signed `state` (CSRF protection),
 * exchanges the authorization code, then stores the refresh token ENCRYPTED.
 * Any error redirects to the senders page with a machine-readable code —
 * no tokens or codes are ever echoed back.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const fail = (reason: string) => {
    const target = new URL("/senders", env.appUrl);
    target.searchParams.set("oauth_error", reason);
    return NextResponse.redirect(target);
  };

  if (error) {
    logger.warn("Google OAuth denied", { error });
    return fail(error === "access_denied" ? "access_denied" : "oauth_error");
  }
  if (!code || !state) return fail("missing_parameters");

  // --- State (CSRF) verification -------------------------------------------
  const cookieState = req.cookies.get("google_oauth_state")?.value;
  if (!cookieState || cookieState !== state) return fail("state_mismatch");

  let uid: string | null = null;
  try {
    const { payload } = await jwtVerify(state, new TextEncoder().encode(env.authSecret), {
      issuer: undefined,
    });
    uid = typeof payload.uid === "string" ? payload.uid : null;
  } catch {
    return fail("state_invalid");
  }
  if (!uid) return fail("state_invalid");

  // Session must still be valid and belong to the same user.
  let user;
  try {
    user = await requireUser();
  } catch {
    return fail("session_expired");
  }
  if (user.id !== uid) return fail("state_user_mismatch");

  // --- Code exchange ---------------------------------------------------------
  if (!env.googleConfigured) return fail("google_not_configured");
  const oauth2 = new google.auth.OAuth2(env.googleClientId, env.googleClientSecret, env.googleRedirectUri);

  let tokens;
  try {
    const res = await oauth2.getToken(code);
    tokens = res.tokens;
  } catch (err) {
    logger.warn("Google token exchange failed", { error: (err as Error).message });
    return fail("token_exchange_failed");
  }

  const refreshToken = tokens.refresh_token;
  const accessToken = tokens.access_token;
  if (!refreshToken) {
    // Happens when the user previously granted access without prompt=consent.
    return fail("no_refresh_token_reconnect");
  }

  // --- Identify the Google account ------------------------------------------
  let email: string | null = null;
  let subject: string | null = null;
  try {
    if (accessToken) oauth2.setCredentials({ access_token: accessToken });
    const info = await oauth2.request({ url: "https://www.googleapis.com/oauth2/v2/userinfo" });
    email = (info.data as { email?: string; verified_email?: boolean }).email ?? null;
    subject = (info.data as { id?: string }).id ?? null;
    const verified = (info.data as { verified_email?: boolean }).verified_email;
    if (email && verified === false) return fail("email_not_verified");
  } catch (err) {
    logger.warn("Failed to fetch Google profile", { error: (err as Error).message });
    return fail("profile_fetch_failed");
  }
  if (!email) return fail("no_email");

  const normalized = email.trim().toLowerCase();

  // --- Store (encrypted) ----------------------------------------------------
  try {
    const existing = await prisma.senderAccount.findUnique({
      where: { userId_email: { userId: user.id, email: normalized } },
    });

    let accountId: string;
    if (existing) {
      accountId = existing.id;
      await prisma.senderAccount.update({
        where: { id: accountId },
        data: {
          status: "CONNECTED",
          googleSubject: subject,
          scopes: env.googleScopes,
          connectedAt: new Date(),
          lastError: null,
          disconnectedAt: null,
        },
      });
    } else {
      const count = await prisma.senderAccount.count({ where: { userId: user.id } });
      if (count >= env.maxSenderAccounts) return fail("account_limit_reached");
      const created = await prisma.senderAccount.create({
        data: {
          userId: user.id,
          provider: "GOOGLE",
          email: normalized,
          status: "CONNECTED",
          dailyCap: env.senderDailyCapDefault,
          googleSubject: subject,
          scopes: env.googleScopes,
          connectedAt: new Date(),
        },
      });
      accountId = created.id;
    }

    await prisma.senderAccount.update({
      where: { id: accountId },
      data: {
        refreshTokenEnc: encryptSecret(refreshToken, tokenAad(accountId, "refreshToken")),
        accessTokenEnc: accessToken ? encryptSecret(accessToken, tokenAad(accountId, "accessToken")) : undefined,
        tokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      },
    });

    await audit(prisma, {
      userId: user.id,
      action: "google.oauth_connected",
      entityType: "SenderAccount",
      entityId: accountId,
      metadata: { email: normalized },
    });
  } catch (err) {
    logger.error("Failed to store Google account", { error: (err as Error).message });
    return fail("storage_failed");
  }

  const target = new URL("/senders", env.appUrl);
  target.searchParams.set("connected", normalized);
  return NextResponse.redirect(target);
}
