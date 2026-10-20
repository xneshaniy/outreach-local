import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { requireCampaign, requireUser } from "@/lib/auth/guards";
import { ApiError } from "@/lib/errors";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { renderEmail, unsubscribeUrl } from "@/lib/template";
import { gmailProvider } from "@/lib/email/gmail";
import { smtpProvider } from "@/lib/email/smtp";
import { isValidEmail, normalizeEmail } from "@/lib/email-normalize";
import { logger } from "@/lib/logger";

/**
 * POST /api/campaigns/:id/test-send
 * Sends a single personalized message to a staff-controlled address so the
 * campaign can be reviewed before starting. Test sends do NOT consume
 * recipient scheduling and are clearly recorded in the audit log.
 */
type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  to: z.string().email().max(320),
  /** Optional contact id to render with real personalization data. */
  contactId: z.string().cuid().optional(),
  senderAccountId: z.string().cuid().optional(),
});

export const POST = handleApi(async (req: NextRequest, ctx: Ctx) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await ctx.params;
  const campaign = await requireCampaign(user.id, id);
  const body = bodySchema.parse(await req.json());

  if (!isValidEmail(body.to)) throw ApiError.badRequest("Invalid test recipient.");

  const sender = body.senderAccountId
    ? await prisma.senderAccount.findFirst({ where: { id: body.senderAccountId, userId: user.id, status: "CONNECTED" } })
    : await prisma.senderAccount.findFirst({
        where: { userId: user.id, status: "CONNECTED" },
        orderBy: { lastUsedAt: "asc" },
      });
  if (!sender) throw ApiError.badRequest("No connected sender account available for a test send.");

  const contact = body.contactId
    ? await prisma.contact.findFirst({ where: { id: body.contactId, userId: user.id } })
    : null;

  const testContact = contact ?? {
    id: "test",
    email: body.to,
    emailNormalized: normalizeEmail(body.to),
    firstName: "Test",
    lastName: "Recipient",
    company: "Example Co",
    website: "https://example.com",
    title: null,
    customFields: null,
  };

  const rendered = renderEmail({
    subject: `[TEST] ${campaign.subject}`,
    body: campaign.body,
    contact: testContact,
    unsubscribeUrl: unsubscribeUrl({ c: testContact.id, u: user.id, p: campaign.id }),
  });

  const provider = sender.provider === "GOOGLE" ? gmailProvider : smtpProvider;
  const outcome = await provider.send(sender, {
    jobId: `test-${campaign.id}`,
    idempotencyHeader: `test:${Date.now()}`,
    fromEmail: sender.email,
    fromName: campaign.fromName ?? sender.displayName,
    toEmail: body.to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    unsubscribeUrl: unsubscribeUrl({ c: testContact.id, u: user.id, p: campaign.id }),
  });

  await audit(prisma, {
    userId: user.id,
    action: "campaign.test_send",
    entityType: "Campaign",
    entityId: campaign.id,
    metadata: { to: body.to, outcome: outcome.kind, senderAccountId: sender.id },
  });

  if (outcome.kind === "ok") {
    return json({ ok: true, messageId: outcome.messageId });
  }
  if (outcome.kind === "ambiguous") {
    logger.warn("Test send ambiguous", { campaignId: campaign.id });
    return json({ ok: false, ambiguous: true, message: outcome.message }, { status: 202 });
  }
  return json({ ok: false, kind: outcome.kind, code: outcome.code, message: outcome.message }, { status: 502 });
});
