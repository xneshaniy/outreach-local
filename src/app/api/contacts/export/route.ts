import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi } from "@/lib/http";
import { requireUser } from "@/lib/auth/guards";
import { normalizeTimeZone } from "@/lib/email-normalize";

/**
 * GET /api/contacts/export — download the contact list as CSV.
 *
 * Supports the same filters as /api/contacts (?status=, ?search=) plus
 * ?tags=a,b and ?campaignId=. The file is generated server-side from the
 * database, so it always reflects the real data.
 *
 * Only the workspace's own contacts are exported, and the response is
 * marked no-store so it is never cached by a proxy.
 */
export const GET = handleApi(async (req: NextRequest) => {
  const user = await requireUser();
  const url = new URL(req.url);

  const status = url.searchParams.get("status");
  const search = url.searchParams.get("search")?.trim();
  const campaignId = url.searchParams.get("campaignId");
  const tags = (url.searchParams.get("tags") ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  const where = {
    userId: user.id,
    ...(status ? { status: status as never } : {}),
    ...(tags.length > 0 ? { tags: { has: tags[0]! } } : {}),
    ...(campaignId
      ? { campaignRecipients: { some: { campaignId } } }
      : {}),
    ...(search
      ? {
          OR: [
            { email: { contains: search, mode: "insensitive" as const } },
            { firstName: { contains: search, mode: "insensitive" as const } },
            { lastName: { contains: search, mode: "insensitive" as const } },
            { company: { contains: search, mode: "insensitive" as const } },
            { notes: { contains: search, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const contacts = await prisma.contact.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 50_000,
    select: {
      email: true,
      firstName: true,
      lastName: true,
      company: true,
      website: true,
      title: true,
      timeZone: true,
      country: true,
      source: true,
      tags: true,
      notes: true,
      status: true,
      consentAt: true,
      consentSource: true,
      sentCount: true,
      lastSentAt: true,
      lastRepliedAt: true,
      createdAt: true,
    },
  });

  const headers = [
    "email",
    "firstName",
    "lastName",
    "company",
    "website",
    "title",
    "timeZone",
    "country",
    "source",
    "tags",
    "notes",
    "status",
    "consentAt",
    "consentSource",
    "sentCount",
    "lastSentAt",
    "lastRepliedAt",
    "createdAt",
  ];

  const escapeCell = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    const s = Array.isArray(value) ? value.join(";") : String(value);
    // Guard against CSV formula injection when the file is opened in Excel.
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };

  const rows = [headers.join(",")];
  for (const c of contacts) {
    rows.push(
      [
        c.email,
        c.firstName,
        c.lastName,
        c.company,
        c.website,
        c.title,
        c.timeZone ? normalizeTimeZone(c.timeZone) : "",
        c.country,
        c.source,
        c.tags,
        c.notes,
        c.status,
        c.consentAt?.toISOString(),
        c.consentSource,
        c.sentCount,
        c.lastSentAt?.toISOString(),
        c.lastRepliedAt?.toISOString(),
        c.createdAt.toISOString(),
      ]
        .map(escapeCell)
        .join(","),
    );
  }

  const csv = `${rows.join("\r\n")}\r\n`;
  const stamp = new Date().toISOString().slice(0, 10);

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="contacts-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
});
