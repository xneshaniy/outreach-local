import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json, clientIp, userAgent, assertSameOrigin } from "@/lib/http";
import { registerSchema } from "@/lib/validation";
import { hashPassword, validatePasswordPolicy } from "@/lib/auth/password";
import { setSessionCookie } from "@/lib/auth/session";
import { enforceRateLimit, authLimitKey } from "@/lib/ratelimit";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { ApiError } from "@/lib/errors";

/**
 * POST /api/auth/register — create the first workspace user.
 * Rate-limited per IP. Passwords are bcrypt-hashed (12 rounds).
 */
export const POST = handleApi(async (req: NextRequest) => {
  assertSameOrigin(req);
  await enforceRateLimit(authLimitKey("register", clientIp(req)), env.rateLimitAuthMax, env.rateLimitAuthWindowSeconds);

  const body = registerSchema.parse(await req.json());

  const policyError = validatePasswordPolicy(body.password);
  if (policyError) throw ApiError.badRequest(policyError);

  const existing = await prisma.user.findUnique({ where: { email: body.email } });
  if (existing) throw ApiError.conflict("An account with this email already exists.");

  const passwordHash = await hashPassword(body.password);
  const user = await prisma.user.create({
    data: { email: body.email, passwordHash, name: body.name },
    select: { id: true, email: true, name: true, role: true },
  });

  await setSessionCookie({ sub: user.id, email: user.email, sv: 0 });
  await audit(prisma, {
    userId: user.id,
    action: "auth.register",
    entityType: "User",
    entityId: user.id,
    ip: clientIp(req),
    userAgent: userAgent(req),
  });

  return json({ user }, { status: 201 });
});
