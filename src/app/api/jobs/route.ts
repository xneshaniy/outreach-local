import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json } from "@/lib/http";
import { requireUser } from "@/lib/auth/guards";
import { paginationSchema } from "@/lib/validation";
import { queueDepth } from "@/lib/queue";
import { env } from "@/lib/env";

/**
 * GET /api/jobs — send-queue view (filter by status/campaign, paginate).
 * Returns queue depth + reconciliation backlog for the health dashboard.
 */
export const GET = handleApi(async (req: NextRequest) => {
  const user = await requireUser();
  const url = new URL(req.url);

  const { page, pageSize } = paginationSchema.parse({
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
  });
  const status = url.searchParams.get("status");
  const campaignId = url.searchParams.get("campaignId");

  const where = {
    userId: user.id,
    ...(status ? { status: status as never } : {}),
    ...(campaignId ? { campaignId } : {}),
  };

  const [total, items, depth] = await Promise.all([
    prisma.sendJob.count({ where }),
    prisma.sendJob.findMany({
      where,
      orderBy: { scheduledAt: "asc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        contact: { select: { email: true, timeZone: true } },
        campaign: { select: { id: true, name: true } },
        senderAccount: { select: { email: true, provider: true } },
        sendAttempts: { orderBy: { attemptNumber: "desc" }, take: 1 },
      },
    }),
    queueDepth(user.id),
  ]);

  return json({
    total,
    page,
    pageSize,
    items,
    depth,
    ambiguous: depth.AMBIGUOUS ?? 0,
    config: {
      maxAttempts: env.workerMaxAttempts,
      leaseSeconds: env.workerLeaseSeconds,
    },
  });
});
