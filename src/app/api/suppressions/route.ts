import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { requireUser } from "@/lib/auth/guards";
import { addSuppression } from "@/lib/suppression";
import { normalizeEmail, isValidEmail } from "@/lib/email-normalize";
import { ApiError } from "@/lib/errors";
import { audit } from "@/lib/audit";
import { z } from "zod";

/**
 * GET    /api/suppressions — list (filter by scope).
 * POST   /api/suppressions — manually suppress an address (global or per campaign).
 * DELETE /api/suppressions — remove a suppression row.
 */
export const GET = handleApi(async (req: NextRequest) => {
  const user = await requireUser();
  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("pageSize") ?? 50)));
  const scope = url.searchParams.get("scope");

  const where = {
    userId: user.id,
    ...(scope === "GLOBAL" || scope === "CAMPAIGN" ? { scope: scope as never } : {}),
  };

  const [total, items] = await Promise.all([
    prisma.suppression.count({ where }),
    prisma.suppression.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { campaign: { select: { id: true, name: true } } },
    }),
  ]);

  return json({ total, page, pageSize, items });
});

const createSchema = z.object({
  email: z.string().max(320),
  scope: z.enum(["GLOBAL", "CAMPAIGN"]).default("GLOBAL"),
  campaignId: z.string().cuid().optional(),
  reason: z.enum(["UNSUBSCRIBE", "BOUNCE", "HARD_BOUNCE", "COMPLAINT", "MANUAL", "LIST_UNSUBSCRIBE"]).default("MANUAL"),
});

export const POST = handleApi(async (req: NextRequest) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const body = createSchema.parse(await req.json());

  if (!isValidEmail(body.email)) throw ApiError.badRequest("Invalid email address.");
  if (body.scope === "CAMPAIGN" && !body.campaignId) {
    throw ApiError.badRequest("campaignId is required for campaign-scope suppressions.");
  }
  if (body.campaignId) {
    const campaign = await prisma.campaign.findFirst({ where: { id: body.campaignId, userId: user.id } });
    if (!campaign) throw ApiError.notFound("Campaign not found.");
  }

  const emailNormalized = normalizeEmail(body.email);
  const { created } = await addSuppression({
    userId: user.id,
    emailNormalized,
    scope: body.scope,
    campaignId: body.campaignId ?? null,
    reason: body.reason,
    source: "manual",
  });

  if (body.scope === "GLOBAL") {
    await prisma.contact.updateMany({
      where: { userId: user.id, emailNormalized, status: "ACTIVE" },
      data: { status: body.reason === "UNSUBSCRIBE" ? "UNSUBSCRIBED" : "BOUNCED" },
    });
    await prisma.sendJob.updateMany({
      where: { userId: user.id, contact: { emailNormalized }, status: { in: ["QUEUED"] } },
      data: { status: "CANCELLED" },
    });
  }

  await audit(prisma, {
    userId: user.id,
    action: "suppression.add",
    entityType: "Suppression",
    metadata: { email: emailNormalized, scope: body.scope, campaignId: body.campaignId, reason: body.reason },
  });

  return json({ created }, { status: created ? 201 : 200 });
});

const deleteSchema = z.object({
  id: z.string().cuid(),
});

export const DELETE = handleApi(async (req: NextRequest) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = deleteSchema.parse(await req.json());

  const row = await prisma.suppression.findFirst({ where: { id, userId: user.id } });
  if (!row) throw ApiError.notFound("Suppression not found.");

  await prisma.suppression.delete({ where: { id } });
  await audit(prisma, {
    userId: user.id,
    action: "suppression.remove",
    entityType: "Suppression",
    entityId: id,
    metadata: { email: row.emailNormalized, scope: row.scope },
  });

  return json({ ok: true });
});
