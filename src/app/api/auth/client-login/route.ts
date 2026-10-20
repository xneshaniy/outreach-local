import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json, clientIp, userAgent } from "@/lib/http";
import { verifyPassword } from "@/lib/auth/password";
import { setClientSessionCookie } from "@/lib/auth/client-session";
import { enforceRateLimit, authLimitKey } from "@/lib/ratelimit";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { z } from "zod";
import { ApiError } from "@/lib/errors";

/**
 * POST /api/auth/client-login
 *
 * Client-portal sign-in. Separate from the workspace owner's login: a client
 * only ever sees the campaigns an administrator assigned to it.
 */
const clientLoginSchema = z.object({
  email: z.string().email().max(320).transform((e) => e.trim().toLowerCase()),
  password: z.string().min(1).max(200),
});

export const POST = handleApi(async (req: NextRequest) => {
  const ip = clientIp(req);
  await enforceRateLimit(authLimitKey("client-login-ip", ip), env.rateLimitAuthMax, env.rateLimitAuthWindowSeconds);

  const body = clientLoginSchema.parse(await req.json());
  await enforceRateLimit(
    authLimitKey("client-login-account", body.email),
    env.rateLimitAuthMax,
    env.rateLimitAuthWindowSeconds,
  );

  const client = await prisma.client.findUnique({
    where: { email: body.email },
    select: { id: true, userId: true, email: true, name: true, company: true, passwordHash: true, isActive: true, sessionVersion: true },
  });

  const valid = client ? await verifyPassword(body.password, client.passwordHash) : false;
  if (!client || !valid || !client.isActive) {
    // The same message for every failure: no account enumeration.
    await audit(prisma, {
      userId: client?.userId ?? null,
      action: "client.login_failed",
      entityType: "Client",
      entityId: client?.id,
      ip,
      userAgent: userAgent(req),
    });
    throw ApiError.unauthorized("Invalid email or password.");
  }

  await prisma.client.update({ where: { id: client.id }, data: { lastLoginAt: new Date() } });
  await setClientSessionCookie({
    cid: client.id,
    uid: client.userId,
    email: client.email,
    sv: client.sessionVersion,
  });

  await audit(prisma, {
    userId: client.userId,
    action: "client.login",
    entityType: "Client",
    entityId: client.id,
    ip,
    userAgent: userAgent(req),
  });

  return json({
    client: { id: client.id, email: client.email, name: client.name, company: client.company },
  });
});
