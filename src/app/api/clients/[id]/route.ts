import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { requireUser } from "@/lib/auth/guards";
import { hashPassword } from "@/lib/auth/password";
import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/errors";
import { z } from "zod";

/**
 * GET    /api/clients/:id — one client with its assigned campaigns.
 * PATCH  /api/clients/:id — rename, change the password, activate/deactivate.
 * DELETE /api/clients/:id — remove the client and its assignments.
 */
type Ctx = { params: Promise<{ id: string }> };

const updateClientSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  company: z.string().max(200).nullish(),
  isActive: z.boolean().optional(),
  password: z.string().min(10).max(200).optional(),
});

export const GET = handleApi(async (_req: NextRequest, ctx: Ctx) => {
  const user = await requireUser();
  const { id } = await ctx.params;

  const client = await prisma.client.findFirst({
    where: { id, userId: user.id },
    select: {
      id: true,
      email: true,
      name: true,
      company: true,
      isActive: true,
      lastLoginAt: true,
      createdAt: true,
      campaignAccess: {
        select: {
          campaignId: true,
          campaign: { select: { id: true, name: true, status: true } },
        },
      },
    },
  });
  if (!client) throw ApiError.notFound("Client not found.");

  return json({ client });
});

export const PATCH = handleApi(async (req: NextRequest, ctx: Ctx) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await ctx.params;
  const body = updateClientSchema.parse(await req.json());

  const existing = await prisma.client.findFirst({ where: { id, userId: user.id } });
  if (!existing) throw ApiError.notFound("Client not found.");

  const updated = await prisma.client.update({
    where: { id },
    data: {
      ...(body.name !== undefined ? { name: body.name.trim() } : {}),
      ...(body.company !== undefined ? { company: body.company?.trim() || null } : {}),
      ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      // A new password invalidates every outstanding session of that client.
      ...(body.password !== undefined
        ? { passwordHash: await hashPassword(body.password), sessionVersion: { increment: 1 } }
        : {}),
      // Deactivating a client also ends its sessions.
      ...(body.isActive === false ? { sessionVersion: { increment: 1 } } : {}),
    },
    select: { id: true, email: true, name: true, company: true, isActive: true },
  });

  await audit(prisma, {
    userId: user.id,
    action: "client.update",
    entityType: "Client",
    entityId: id,
    metadata: { isActive: body.isActive, passwordChanged: Boolean(body.password) },
  });

  return json({ client: updated });
});

export const DELETE = handleApi(async (req: NextRequest, ctx: Ctx) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await ctx.params;

  const existing = await prisma.client.findFirst({ where: { id, userId: user.id } });
  if (!existing) throw ApiError.notFound("Client not found.");

  // The campaign assignments go with it; the campaigns themselves stay.
  await prisma.client.delete({ where: { id } });

  await audit(prisma, {
    userId: user.id,
    action: "client.delete",
    entityType: "Client",
    entityId: id,
  });
  return json({ ok: true });
});
