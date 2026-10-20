import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { requireUser } from "@/lib/auth/guards";
import { campaignCreateSchema, paginationSchema } from "@/lib/validation";
import { enforceRateLimit, apiLimitKey } from "@/lib/ratelimit";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";

/**
 * GET  /api/campaigns — list (search, filter by status, paginate).
 * POST /api/campaigns — create a DRAFT campaign.
 */
export const GET = handleApi(async (req: NextRequest) => {
  const user = await requireUser();
  await enforceRateLimit(apiLimitKey(user.id, "campaigns"), env.rateLimitApiMax, env.rateLimitApiWindowSeconds);

  const url = new URL(req.url);
  const { page, pageSize, search } = paginationSchema.parse({
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
    search: url.searchParams.get("search") ?? undefined,
  });
  const status = url.searchParams.get("status");

  const where = {
    userId: user.id,
    ...(status ? { status: status as never } : {}),
    ...(search ? { name: { contains: search, mode: "insensitive" as const } } : {}),
  };

  const [total, items] = await Promise.all([
    prisma.campaign.count({ where }),
    prisma.campaign.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { _count: { select: { recipients: true, sendJobs: true } } },
    }),
  ]);

  return json({ total, page, pageSize, items });
});

export const POST = handleApi(async (req: NextRequest) => {
  assertSameOrigin(req);
  const user = await requireUser();
  await enforceRateLimit(apiLimitKey(user.id, "campaigns-create"), env.rateLimitApiMax, env.rateLimitApiWindowSeconds);

  const body = campaignCreateSchema.parse(await req.json());

  const campaign = await prisma.campaign.create({
    data: {
      userId: user.id,
      name: body.name,
      subject: body.subject,
      body: body.body,
      templateId: body.templateId ?? null,
      fromName: body.fromName ?? null,
      replyTo: body.replyTo ?? null,
      windowStartMinute: body.windowStartMinute,
      windowEndMinute: body.windowEndMinute,
      sendingDays: body.sendingDays,
      timeZoneFallback: body.timeZoneFallback,
      fallbackTimeZone: body.fallbackTimeZone ?? null,
      dailyLimit: body.dailyLimit ?? null,
      startAt: body.startAt ?? null,
      endAt: body.endAt ?? null,
    },
  });

  await audit(prisma, {
    userId: user.id,
    action: "campaign.create",
    entityType: "Campaign",
    entityId: campaign.id,
  });

  return json({ campaign }, { status: 201 });
});
