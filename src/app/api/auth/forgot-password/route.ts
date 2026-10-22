import { NextRequest } from "next/server";
import { randomBytes, createHash } from "crypto";
import { prisma } from "@/lib/db";
import { handleApi, json } from "@/lib/http";
import { enforceRateLimit, authLimitKey } from "@/lib/ratelimit";
import { env } from "@/lib/env";
import { logger, redact } from "@/lib/logger";
import { z } from "zod";

/**
 * POST /api/auth/forgot-password — start a password reset.
 *
 * The response is ALWAYS the same, whether or not the account exists, so the
 * endpoint cannot be used to discover which addresses are registered.
 *
 * Only the SHA-256 hash of the token is stored, the token is single-use and
 * expires after 30 minutes.
 *
 * Without a mail transport configured the reset link is logged (development)
 * and returned in the response ONLY when the app is explicitly in development
 * mode - never in production.
 */
const schema = z.object({ email: z.string().email().max(320).transform((e) => e.trim().toLowerCase()) });

const TOKEN_TTL_MS = 30 * 60 * 1000;

export const POST = handleApi(async (req: NextRequest) => {
  const body = schema.parse(await req.json());
  await enforceRateLimit(
    authLimitKey("forgot-password", body.email),
    env.rateLimitAuthMax,
    env.rateLimitAuthWindowSeconds,
  );

  const user = await prisma.user.findUnique({
    where: { email: body.email },
    select: { id: true, email: true, name: true },
  });

  let resetUrl: string | null = null;

  if (user) {
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
      },
    });
    // Any earlier unused token is invalidated.
    await prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null, id: { not: (await prisma.passwordResetToken.findFirst({
        where: { userId: user.id, usedAt: null },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      }))?.id } },
      data: { usedAt: new Date() },
    });

    resetUrl = `${env.appUrl}/reset-password?token=${encodeURIComponent(token)}`;
    // The reset token is a credential: anyone who reads the log could take it
    // and reset that account's password. It is only ever logged in
    // development, where it is the only way to get at the link.
    logger.info(
      "Password reset requested",
      redact({
        email: user.email,
        resetUrl: env.nodeEnv === "development" ? resetUrl : "[redacted]",
      }),
    );
  }

  return json({
    ok: true,
    message: "If that address has an account, a reset link has been sent.",
    // Development convenience only.
    ...(env.nodeEnv === "development" && resetUrl ? { devResetUrl: resetUrl } : {}),
  });
});
