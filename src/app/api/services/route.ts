import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { requireUser } from "@/lib/auth/guards";
import { serviceCreateSchema } from "@/lib/validation";
import { ensureStarterServices, uniqueServiceSlug } from "@/lib/services";
import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/errors";

/**
 * GET  /api/services — list the workspace's service profiles.
 *      `?seedIfEmpty=true` creates the starter profiles on first use.
 * POST /api/services — create a service profile.
 */
export const GET = handleApi(async (req: NextRequest) => {
  const user = await requireUser();
  const url = new URL(req.url);
  const seedIfEmpty = url.searchParams.get("seedIfEmpty") === "true";

  let services = await prisma.service.findMany({
    where: { userId: user.id },
    orderBy: [{ isActive: "desc" }, { createdAt: "asc" }],
    include: {
      _count: { select: { campaigns: true, templates: true, sequences: true } },
    },
  });

  if (services.length === 0 && seedIfEmpty) {
    services = (await ensureStarterServices(user.id)).map((s) => ({
      ...s,
      _count: { campaigns: 0, templates: 0, sequences: 0 },
    }));
  }

  return json({ services });
});

export const POST = handleApi(async (req: NextRequest) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const body = serviceCreateSchema.parse(await req.json());

  const slug = await uniqueServiceSlug(user.id, body.name);
  const service = await prisma.service.create({
    data: {
      userId: user.id,
      name: body.name,
      slug,
      description: body.description ?? null,
      targetIndustries: body.targetIndustries,
      idealCustomerProfile: body.idealCustomerProfile ?? null,
      defaultSubject: body.defaultSubject ?? null,
      defaultBody: body.defaultBody ?? null,
      defaultCta: body.defaultCta ?? null,
      color: body.color,
      isActive: body.isActive,
    },
  });

  await audit(prisma, {
    userId: user.id,
    action: "service.create",
    entityType: "Service",
    entityId: service.id,
    metadata: { name: service.name },
  });

  return json({ service }, { status: 201 });
});

export const DELETE = handleApi(async (req: NextRequest) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const id = new URL(req.url).searchParams.get("id");
  if (!id) throw ApiError.badRequest("A service id is required.");

  const service = await prisma.service.findFirst({ where: { id, userId: user.id } });
  if (!service) throw ApiError.notFound("Service not found.");

  // Campaigns and templates keep working — the relation is ON DELETE SET NULL.
  await prisma.service.delete({ where: { id } });
  await audit(prisma, {
    userId: user.id,
    action: "service.delete",
    entityType: "Service",
    entityId: id,
  });
  return json({ ok: true });
});
