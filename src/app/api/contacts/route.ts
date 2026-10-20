import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { requireUser } from "@/lib/auth/guards";
import { contactCreateSchema, paginationSchema } from "@/lib/validation";
import { normalizeEmail } from "@/lib/email-normalize";
import { ApiError } from "@/lib/errors";
import { audit } from "@/lib/audit";

/**
 * GET  /api/contacts — search + paginate.
 * POST /api/contacts — create (or fetch) one contact, deduped by normalized email.
 */
export const GET = handleApi(async (req: NextRequest) => {
  const user = await requireUser();
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
    ...(search
      ? {
          OR: [
            { email: { contains: search, mode: "insensitive" as const } },
            { firstName: { contains: search, mode: "insensitive" as const } },
            { lastName: { contains: search, mode: "insensitive" as const } },
            { company: { contains: search, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const [total, items] = await Promise.all([
    prisma.contact.count({ where }),
    prisma.contact.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return json({ total, page, pageSize, items });
});

export const POST = handleApi(async (req: NextRequest) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const body = contactCreateSchema.parse(await req.json());
  const emailNormalized = normalizeEmail(body.email);

  const existing = await prisma.contact.findUnique({
    where: { userId_emailNormalized: { userId: user.id, emailNormalized } },
  });
  if (existing) throw ApiError.conflict("This contact already exists.", { contactId: existing.id });

  const contact = await prisma.contact.create({
    data: {
      userId: user.id,
      email: body.email.trim(),
      emailNormalized,
      firstName: body.firstName ?? null,
      lastName: body.lastName ?? null,
      company: body.company ?? null,
      website: body.website ?? null,
      title: body.title ?? null,
      timeZone: body.timeZone ?? null,
      country: body.country ?? null,
      consentAt: body.consentAt ?? null,
      consentSource: body.consentSource ?? null,
    },
  });

  await audit(prisma, {
    userId: user.id,
    action: "contact.create",
    entityType: "Contact",
    entityId: contact.id,
  });

  return json({ contact }, { status: 201 });
});
