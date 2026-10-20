import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { requireUser } from "@/lib/auth/guards";
import { smtpAccountSchema } from "@/lib/validation";
import { encryptSecret } from "@/lib/crypto";
import { quotaDayKey, senderUsageSnapshot } from "@/lib/quota";
import { env } from "@/lib/env";
import { ApiError } from "@/lib/errors";
import { audit } from "@/lib/audit";
import { verifySmtpConnection } from "@/lib/email/smtp";

/**
 * GET  /api/senders — connected accounts (never returns tokens/credentials).
 * POST /api/senders — connect an SMTP account (credentials encrypted at rest).
 */
export const GET = handleApi(async () => {
  const user = await requireUser();

  const accounts = await prisma.senderAccount.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      provider: true,
      email: true,
      displayName: true,
      status: true,
      dailyCap: true,
      lastError: true,
      lastUsedAt: true,
      connectedAt: true,
      scopes: true,
    },
  });

  const day = quotaDayKey(new Date(), env.senderQuotaTimezone);
  const withUsage = await Promise.all(
    accounts.map(async (a) => {
      const usage = await senderUsageSnapshot(a.id, day);
      return {
        ...a,
        usage,
        remaining: Math.max(0, Math.min(a.dailyCap, env.senderDailyCapDefault) - usage.sent - usage.reserved),
      };
    }),
  );

  return json({ accounts: withUsage, quotaDay: day.toISOString(), maxAccounts: env.maxSenderAccounts });
});

export const POST = handleApi(async (req: NextRequest) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const body = smtpAccountSchema.parse(await req.json());

  const count = await prisma.senderAccount.count({ where: { userId: user.id } });
  if (count >= env.maxSenderAccounts) {
    throw ApiError.badRequest(`You can connect at most ${env.maxSenderAccounts} sender accounts.`);
  }

  const existing = await prisma.senderAccount.findUnique({
    where: { userId_email: { userId: user.id, email: body.email } },
  });
  if (existing) throw ApiError.conflict("This email is already connected.");

  // Verify connectivity before storing anything.
  const probe = await verifySmtpConnection({
    id: "probe",
    smtpHost: body.host,
    smtpPort: body.port,
    smtpSecure: body.secure,
    smtpUsername: body.username,
    smtpPasswordEnc: encryptSecret(body.password, "sender:probe:smtpPassword"),
  } as never);
  if (!probe.ok) {
    throw ApiError.badRequest(`SMTP connection failed: ${probe.error ?? "unknown error"}`);
  }

  // Create the row first so the encryption AAD binds to the real account id,
  // then store the encrypted password. Credentials are never returned.
  const account = await prisma.senderAccount.create({
    data: {
      userId: user.id,
      provider: "SMTP",
      email: body.email,
      displayName: body.displayName ?? null,
      status: "CONNECTED",
      dailyCap: Math.min(body.dailyCap ?? env.senderDailyCapDefault, env.senderDailyCapDefault),
      smtpHost: body.host,
      smtpPort: body.port,
      smtpSecure: body.secure,
      smtpUsername: body.username,
      connectedAt: new Date(),
    },
    select: { id: true, provider: true, email: true, status: true, dailyCap: true },
  });

  await prisma.senderAccount.update({
    where: { id: account.id },
    data: { smtpPasswordEnc: encryptSecret(body.password, `sender:${account.id}:smtpPassword`) },
  });

  await audit(prisma, {
    userId: user.id,
    action: "sender.connect_smtp",
    entityType: "SenderAccount",
    entityId: account.id,
    metadata: { email: body.email, host: body.host },
  });

  return json({ account }, { status: 201 });
});
