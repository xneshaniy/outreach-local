import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json } from "@/lib/http";
import { requireUser } from "@/lib/auth/guards";
import { renderEmail, unsubscribeUrl } from "@/lib/template";
import { analyzePersonalization, describePersonalization } from "@/lib/personalization";
import { z } from "zod";

/**
 * POST /api/campaigns/preview — render a message WITHOUT saving anything.
 *
 * The campaign builder uses this to show the operator exactly what a contact
 * will receive, using the same template engine and the same unsubscribe link
 * the worker will use. Nothing is written to the database.
 */
const schema = z.object({
  subject: z.string().max(500),
  body: z.string().max(200_000),
  /** Which contact to render for. Defaults to the first one in the workspace. */
  contactId: z.string().cuid().nullish(),
});

export const POST = handleApi(async (req: NextRequest) => {
  const user = await requireUser();
  const body = schema.parse(await req.json());

  const contact = body.contactId
    ? await prisma.contact.findFirst({ where: { id: body.contactId, userId: user.id } })
    : await prisma.contact.findFirst({
        where: { userId: user.id, status: "ACTIVE" },
        orderBy: { createdAt: "asc" },
      });

  if (!contact) {
    return json({
      preview: null,
      reason: "There are no contacts yet, so there is nothing to render the message with.",
    });
  }

  const token = unsubscribeUrl({ c: contact.id, u: user.id });
  const rendered = renderEmail({
    subject: body.subject,
    body: body.body,
    contact,
    unsubscribeUrl: token,
  });

  const sample = await prisma.contact.findMany({
    where: { userId: user.id },
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
  const report = analyzePersonalization(body.body, sample);

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
      subject: analyzePersonalization(body.subject, sample),
      problems: describePersonalization(report),
    },
  });
});
