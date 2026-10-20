import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { requireUser } from "@/lib/auth/guards";
import { addContactsToCampaign, campaignStats } from "@/lib/campaign";
import { withIdempotency } from "@/lib/idempotency";
import { z } from "zod";
import { normalizeEmail, isValidEmail } from "@/lib/email-normalize";
import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/errors";

/**
 * POST /api/campaigns/:id/contacts
 * Add contacts by email list (or existing contact ids) to the campaign.
 *
 * Duplicate safety (spec §5):
 *  - contacts upsert by (userId, emailNormalized)
 *  - campaign recipients use UNIQUE (campaignId, contactId) + ON CONFLICT
 *  - optional Idempotency-Key header makes retried requests no-ops
 *
 * GET  /api/campaigns/:id/contacts — paginated recipient list with status.
 */

type Ctx = { params: Promise<{ id: string }> };

const addSchema = z
  .object({
    emails: z.array(z.string().max(320)).max(5000).optional(),
    contactIds: z.array(z.string().cuid()).max(5000).optional(),
  })
  .refine((v) => (v.emails?.length ?? 0) + (v.contactIds?.length ?? 0) > 0, {
    message: "Provide at least one email or contact id.",
  });

export const POST = handleApi(async (req: NextRequest, ctx: Ctx) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await ctx.params;

  const { requireCampaign } = await import("@/lib/auth/guards");
  const campaign = await requireCampaign(user.id, id);
  const body = addSchema.parse(await req.json());

  // Resolve existing contacts by ids.
  let rows: { email: string; emailNormalized: string }[] = [];
  if (body.contactIds?.length) {
    const contacts = await prisma.contact.findMany({
      where: { userId: user.id, id: { in: body.contactIds } },
    });
    rows = contacts.map((c) => ({ email: c.email, emailNormalized: c.emailNormalized }));
  }

  // Validate + normalize inline emails.
  const invalidEmails: string[] = [];
  const inline: { email: string; emailNormalized: string }[] = [];
  for (const raw of body.emails ?? []) {
    const trimmed = raw.trim();
    if (!isValidEmail(trimmed)) {
      invalidEmails.push(raw);
      continue;
    }
    inline.push({ email: trimmed, emailNormalized: normalizeEmail(trimmed) });
  }
  if (invalidEmails.length > 0) {
    throw ApiError.badRequest("Some emails are invalid.", { invalidEmails: invalidEmails.slice(0, 20) });
  }
  rows = [...rows, ...inline];

  const idempotencyKey = req.headers.get("idempotency-key");
  const { result, replayed } = await withIdempotency(
    user.id,
    `POST /api/campaigns/${id}/contacts`,
    idempotencyKey,
    body,
    async () => addContactsToCampaign(campaign, rows),
  );

  const stats = await campaignStats(campaign.id);
  await audit(prisma, {
    userId: user.id,
    action: "campaign.contacts_add",
    entityType: "Campaign",
    entityId: campaign.id,
    metadata: { ...result, replayed },
  });

  return json({ ...result, replayed, stats }, { status: replayed ? 200 : 201 });
});

export const GET = handleApi(async (req: NextRequest, ctx: Ctx) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  const { requireCampaign } = await import("@/lib/auth/guards");
  const campaign = await requireCampaign(user.id, id);

  const url = new URL(req.url);
  const page = Number(url.searchParams.get("page") ?? 1);
  const pageSize = Math.min(Number(url.searchParams.get("pageSize") ?? 20), 100);
  const status = url.searchParams.get("status");

  const where = {
    campaignId: campaign.id,
    ...(status ? { status: status as never } : {}),
  };

  const [total, items] = await Promise.all([
    prisma.campaignRecipient.count({ where }),
    prisma.campaignRecipient.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        contact: {
          select: {
            email: true,
            firstName: true,
            lastName: true,
            company: true,
            timeZone: true,
            status: true,
          },
        },
      },
    }),
  ]);

  return json({ total, page, pageSize, items });
});
