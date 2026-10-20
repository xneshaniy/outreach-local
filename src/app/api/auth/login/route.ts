import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json, clientIp, userAgent, assertSameOrigin } from "@/lib/http";
import { loginSchema } from "@/lib/validation";
import { verifyPassword } from "@/lib/auth/password";
import { setSessionCookie } from "@/lib/auth/session";
import { enforceRateLimit, authLimitKey } from "@/lib/ratelimit";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { ApiError } from "@/lib/errors";

/**
 * POST /api/auth/login
 * - Rate-limited per IP and per account.
 * - Generic error message prevents account enumeration.
 */
export const POST = handleApi(async (req: NextRequest) => {
  assertSameOrigin(req);
  const ip = clientIp(req);
  await enforceRateLimit(authLimitKey("login-ip", ip), env.rateLimitAuthMax, env.rateLimitAuthWindowSeconds);

  const body = loginSchema.parse(await req.json());
  await enforceRateLimit(authLimitKey("login-account", body.email), env.rateLimitAuthMax, env.rateLimitAuthWindowSeconds);

  const user = await prisma.user.findUnique({ where: { email: body.email } });
  const valid = user ? await verifyPassword(body.password, user.passwordHash) : false;
  if (!user || !valid) {
    await audit(prisma, {
      userId: user?.id ?? null,
      action: "auth.login_failed",
      entityType: "User",
      entityId: user?.id,
      ip,
      userAgent: userAgent(req),
    });
    throw ApiError.unauthorized("Invalid email or password.");
  }

  await setSessionCookie({ sub: user.id, email: user.email, sv: user.sessionVersion });
  await audit(prisma, {
    userId: user.id,
    action: "auth.login",
    entityType: "User",
    entityId: user.id,
    ip,
    userAgent: userAgent(req),
  });

  return json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});
