import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { requireUser } from "@/lib/auth/guards";
import { hashPassword } from "@/lib/auth/password";
import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/errors";
import { z } from "zod";

/**
 * GET  /api/clients — list the workspace's client accounts (owner only).
 * POST /api/clients — create a client account (owner only).
 */
const createClientSchema = z.object({
  email: z.string().email().max(320).transform((e) => e.trim().toLowerCase()),
  password: z.string().min(10).max(200),
  name: z.string().min(1).max(120),
  company: z.string().max(200).nullish(),
});

export const GET = handleApi(async () => {
  const user = await requireUser();
  const clients = await prisma.client.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      email: true,
      name: true,
      company: true,
      isActive: true,
      lastLoginAt: true,
      createdAt: true,
      _count: { select: { campaignAccess: true } },
    },
  });
  return json({ clients });
});

export const POST = handleApi(async (req: NextRequest) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const body = createClientSchema.parse(await req.json());

  const existing = await prisma.client.findUnique({
    where: { email: body.email },
    select: { id: true, userId: true },
  });
  if (existing) {
    throw ApiError.conflict(
      existing.userId === user.id
        ? "A client with this email already exists."
        : "That email is already in use by another account.",
    );
  }

  const client = await prisma.client.create({
    data: {
      userId: user.id,
      email: body.email,
      passwordHash: await hashPassword(body.password),
      name: body.name.trim(),
      company: body.company?.trim() || null,
      isActive: true,
    },
    select: { id: true, email: true, name: true, company: true, isActive: true, createdAt: true },
  });

  await audit(prisma, {
    userId: user.id,
    action: "client.create",
    entityType: "Client",
    entityId: client.id,
    metadata: { email: client.email },
  });

  return json({ client }, { status: 201 });
});
