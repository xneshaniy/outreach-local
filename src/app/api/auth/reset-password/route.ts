import { NextRequest } from "next/server";
import { createHash } from "crypto";
import { prisma } from "@/lib/db";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { hashPassword, validatePasswordPolicy } from "@/lib/auth/password";
import { enforceRateLimit, authLimitKey } from "@/lib/ratelimit";
import { env } from "@/lib/env";
import { audit } from "@/lib/audit";
import { clientIp } from "@/lib/http";
import { z } from "zod";

/**
 * POST /api/auth/reset-password — finish a password reset.
 *
 * The token is single-use and expires. Resetting the password also bumps
 * `sessionVersion`, which invalidates every outstanding session for that
 * account — the correct behaviour when a password is reset.
 */
const schema = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(10).max(200),
});

export const POST = handleApi(async (req: NextRequest) => {
  assertSameOrigin(req);
  const body = schema.parse(await req.json());

  await enforceRateLimit(
    authLimitKey("reset-password", clientIp(req)),
    env.rateLimitAuthMax,
    env.rateLimitAuthWindowSeconds,
  );

  const policy = validatePasswordPolicy(body.password);
  if (policy) {
    return json(
      { error: { code: "VALIDATION", message: policy } },
      { status: 400 },
    );
  }

  const tokenHash = createHash("sha256").update(body.token).digest("hex");
  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    select: { id: true, userId: true, expiresAt: true, usedAt: true },
  });

  if (!record || record.usedAt || record.expiresAt.getTime() < Date.now()) {
    return json(
      { error: { code: "INVALID_TOKEN", message: "This reset link is invalid or has expired." } },
      { status: 400 },
    );
  }

  const user = await prisma.user.update({
    where: { id: record.userId },
    data: {
      passwordHash: await hashPassword(body.password),
      // Invalidate every outstanding session.
      sessionVersion: { increment: 1 },
    },
    select: { id: true, email: true },
  });

  await prisma.passwordResetToken.update({
    where: { id: record.id },
    data: { usedAt: new Date() },
  });

  await audit(prisma, {
    userId: user.id,
    action: "auth.password_reset",
    entityType: "User",
    entityId: user.id,
    ip: clientIp(req),
  });

  return json({ ok: true, email: user.email });
});
