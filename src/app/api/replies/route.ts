import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json } from "@/lib/http";
import { requireUser } from "@/lib/auth/guards";
import { paginationSchema } from "@/lib/validation";
import { pollGmailReplies } from "@/lib/email/reply-poller";
import { logger } from "@/lib/logger";

/**
 * GET /api/replies — list received replies.
 *
 * `?poll=true` asks the connected Gmail accounts to fetch new messages from
 * their inbox first. SMTP accounts cannot be polled, so replies for them must
 * be added by hand — the response says which accounts support polling.
 */
export const GET = handleApi(async (req: NextRequest) => {
  const user = await requireUser();
  const url = new URL(req.url);
  const { page, pageSize, search } = paginationSchema.parse({
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
    search: url.searchParams.get("search") ?? undefined,
  });
  const unreadOnly = url.searchParams.get("unread") === "true";

  const polled: { accountId: string; checked: number; imported: number; error?: string }[] = [];
  const pollRequested = url.searchParams.get("poll") === "true";
  let pollSupported = false;

  if (pollRequested) {
    const googleAccounts = await prisma.senderAccount.findMany({
      where: { userId: user.id, provider: "GOOGLE", status: "CONNECTED" },
      select: { id: true },
    });
    pollSupported = googleAccounts.length > 0;
    for (const account of googleAccounts) {
      const result = await pollGmailReplies(
        { id: account.id, userId: user.id } as never,
        { maxMessages: 25, maxAgeDays: 14 },
      );
      polled.push({ accountId: account.id, checked: result.checked, imported: result.imported, error: result.error });
      if (result.error) logger.warn("Reply polling failed", { accountId: account.id, error: result.error });
    }
  }

  const where = {
    userId: user.id,
    ...(unreadOnly ? { isRead: false } : {}),
    ...(search
      ? {
          OR: [
            { subject: { contains: search, mode: "insensitive" as const } },
            { fromEmail: { contains: search, mode: "insensitive" as const } },
            { snippet: { contains: search, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const [total, unread, items] = await Promise.all([
    prisma.reply.count({ where }),
    prisma.reply.count({ where: { userId: user.id, isRead: false } }),
    prisma.reply.findMany({
      where,
      orderBy: { receivedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        contact: { select: { id: true, email: true, firstName: true, lastName: true, company: true, status: true } },
        campaign: { select: { id: true, name: true } },
      },
    }),
  ]);

  return json({ total, unread, page, pageSize, items, polled, pollSupported });
});
