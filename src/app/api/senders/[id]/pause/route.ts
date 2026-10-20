import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { requireSenderAccount, requireUser } from "@/lib/auth/guards";
import { ApiError } from "@/lib/errors";
import { audit } from "@/lib/audit";

/** POST /api/senders/:id/pause — the account stops being selected by workers. */
type Ctx = { params: Promise<{ id: string }> };

export const POST = handleApi(async (req: NextRequest, ctx: Ctx) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await ctx.params;
  const account = await requireSenderAccount(user.id, id);

  if (account.status === "DISCONNECTED") {
    throw ApiError.badRequest("Reconnect this account before changing its status.");
  }

  const updated = await prisma.senderAccount.update({
    where: { id: account.id },
    data: { status: "PAUSED" },
    select: { id: true, email: true, status: true },
  });

  await audit(prisma, {
    userId: user.id,
    action: "sender.pause",
    entityType: "SenderAccount",
    entityId: account.id,
  });

  return json({ account: updated });
});
