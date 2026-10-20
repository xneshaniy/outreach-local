import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json } from "@/lib/http";
import { requireCampaign, requireUser } from "@/lib/auth/guards";
import { renderEmail, unsubscribeUrl } from "@/lib/template";
import { analyzePersonalization, describePersonalization } from "@/lib/personalization";
import { ApiError } from "@/lib/errors";

/**
 * GET /api/campaigns/:id/preview
 *
 * Renders the campaign exactly like the worker will (same template engine,
 * same unsubscribe link) for one contact, and reports which personalisation
 * variables the audience cannot fill in.
 *
 * `?contactId=` picks the contact to preview (defaults to the first one).
 */
export const GET = handleApi(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  const campaign = await requireCampaign(user.id, id);

  const url = new URL(req.url);
  const contactId = url.searchParams.get("contactId");

  const contact = contactId
    ? await prisma.contact.findFirst({ where: { id: contactId, userId: user.id } })
    : await prisma.contact.findFirst({
        where: { userId: user.id, campaignRecipients: { some: { campaignId: id } } },
        orderBy: { createdAt: "asc" },
      });

  if (!contact) {
    throw ApiError.badRequest("This campaign has no contacts to preview yet.");
  }

  const token = unsubscribeUrl({ c: contact.id, u: user.id, p: campaign.id });
  const rendered = renderEmail({
    subject: campaign.subject,
    body: campaign.body,
    contact,
    unsubscribeUrl: token,
  });

  // Sample the audience so the coverage report is representative.
  const sample = await prisma.contact.findMany({
    where: { userId: user.id, campaignRecipients: { some: { campaignId: id } } },
    take: 500,
    select: {
      email: true,
      firstName: true,
      lastName: true,
      company: true,
      website: true,
      title: true,
      customFields: true,
    },
  });

  const report = analyzePersonalization(campaign.body, sample);
  const subjectReport = analyzePersonalization(campaign.subject, sample);

  return json({
    preview: {
      to: contact.email,
      toName: [contact.firstName, contact.lastName].filter(Boolean).join(" ") || null,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      unsubscribeUrl: token,
    },
    personalization: {
      body: report,
      subject: subjectReport,
      problems: [...describePersonalization(report), ...describePersonalization(subjectReport)],
    },
    dryRun: campaign.dryRun,
    audienceSize: await prisma.campaignRecipient.count({ where: { campaignId: id } }),
  });
});
