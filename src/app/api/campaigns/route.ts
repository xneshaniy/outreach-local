import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { requireUser } from "@/lib/auth/guards";
import { campaignCreateSchema, paginationSchema } from "@/lib/validation";
import { enforceRateLimit, apiLimitKey } from "@/lib/ratelimit";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { ApiError } from "@/lib/errors";

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
  const serviceId = url.searchParams.get("serviceId")?.trim();
  const archived = url.searchParams.get("archived");

  const where = {
    userId: user.id,
    // Archived campaigns are hidden unless explicitly requested.
    ...(archived === "true" ? { isArchived: true } : { isArchived: false }),
    ...(status ? { status: status as never } : {}),
    ...(serviceId ? { serviceId } : {}),
    ...(search ? { name: { contains: search, mode: "insensitive" as const } } : {}),
  };

  const [total, items] = await Promise.all([
    prisma.campaign.count({ where }),
    prisma.campaign.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        service: { select: { id: true, name: true, color: true } },
        followUpSequence: { select: { id: true, name: true } },
        _count: { select: { recipients: true, sendJobs: true, replies: true } },
      },
    }),
  ]);

  return json({ total, page, pageSize, items });
});

export const POST = handleApi(async (req: NextRequest) => {
  assertSameOrigin(req);
  const user = await requireUser();
  await enforceRateLimit(apiLimitKey(user.id, "campaigns-create"), env.rateLimitApiMax, env.rateLimitApiWindowSeconds);

  const body = campaignCreateSchema.parse(await req.json());

  // The service and the follow-up sequence must belong to this workspace.
  if (body.serviceId) {
    const service = await prisma.service.findFirst({
      where: { id: body.serviceId, userId: user.id },
      select: { id: true },
    });
    if (!service) throw ApiError.badRequest("That service does not exist.");
  }
  if (body.followUpSequenceId) {
    const sequence = await prisma.followUpSequence.findFirst({
      where: { id: body.followUpSequenceId, userId: user.id },
      select: { id: true, isActive: true },
    });
    if (!sequence) throw ApiError.badRequest("That follow-up sequence does not exist.");
    if (!sequence.isActive) throw ApiError.badRequest("That follow-up sequence is inactive.");
  }

  const campaign = await prisma.campaign.create({
    data: {
      userId: user.id,
      name: body.name,
      subject: body.subject,
      body: body.body,
      templateId: body.templateId ?? null,
      serviceId: body.serviceId ?? null,
      followUpSequenceId: body.followUpSequenceId ?? null,
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
      requiresApproval: body.requiresApproval,
      dryRun: body.dryRun,
      trackingEnabled: body.trackingEnabled,
      clickTrackingEnabled: body.clickTrackingEnabled,
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
