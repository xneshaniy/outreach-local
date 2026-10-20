import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { requireSenderAccount, requireUser } from "@/lib/auth/guards";
import { senderSettingsSchema } from "@/lib/validation";
import { env } from "@/lib/env";
import { audit } from "@/lib/audit";

/**
 * PATCH  /api/senders/:id — update the daily cap (clamped by app maximum).
 * DELETE /api/senders/:id — disconnect (token material is destroyed).
 */
type Ctx = { params: Promise<{ id: string }> };

export const PATCH = handleApi(async (req: NextRequest, ctx: Ctx) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await ctx.params;
  const account = await requireSenderAccount(user.id, id);
  const body = senderSettingsSchema.parse(await req.json());

  // The configured cap can only ever be LOWER than the platform maximum —
  // it must never exceed provider limits (spec §3).
  const cappedDaily = Math.min(body.dailyCap, env.senderDailyCapDefault);

  const updated = await prisma.senderAccount.update({
    where: { id: account.id },
    data: { dailyCap: cappedDaily },
    select: { id: true, email: true, dailyCap: true, status: true },
  });

  await audit(prisma, {
    userId: user.id,
    action: "sender.update_cap",
    entityType: "SenderAccount",
    entityId: account.id,
    metadata: { requested: body.dailyCap, applied: cappedDaily },
  });

  return json({ account: updated });
});

export const DELETE = handleApi(async (req: NextRequest, ctx: Ctx) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await ctx.params;
  const account = await requireSenderAccount(user.id, id);

  // Destroy every secret material; keep the row for audit/attribution.
  await prisma.senderAccount.update({
    where: { id: account.id },
    data: {
      status: "DISCONNECTED",
      refreshTokenEnc: null,
      accessTokenEnc: null,
      smtpPasswordEnc: null,
      tokenExpiresAt: null,
      disconnectedAt: new Date(),
    },
  });

  await audit(prisma, {
    userId: user.id,
    action: "sender.disconnect",
    entityType: "SenderAccount",
    entityId: account.id,
    metadata: { email: account.email },
  });

  return json({ ok: true });
});
