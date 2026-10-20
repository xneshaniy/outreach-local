import { NextRequest } from "next/server";
import { handleApi } from "@/lib/http";
import { clientCampaigns, parseRange, requireClient } from "@/lib/portal";

/**
 * GET /api/portal/reports/export — CSV export of the client's reports.
 *
 * Only the campaigns assigned to this client are exported. The file is
 * generated from the database, never from anything the browser sends.
 *
 * Unavailable metrics are exported as an empty cell with a note in the
 * header, so the numbers are never confused with a real zero.
 */
export const GET = handleApi(async (req: NextRequest) => {
  const client = await requireClient();
  const url = new URL(req.url);
  const range = parseRange(url);
  const campaigns = await clientCampaigns(client.id, range);

  const escapeCell = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    const s = String(value);
    // Guard against CSV formula injection when the file is opened in Excel.
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };

  const headers = [
    "Campaign",
    "Status",
    "Date range",
    "Recipients",
    "Sent (accepted by provider)",
    "Delivered (confirmed)",
    "Unique opens",
    "Total opens",
    "Open rate %",
    "Open rate denominator",
    "Unique clicks",
    "Total clicks",
    "Click rate %",
    "Replies",
    "Reply rate %",
    "Bounced",
    "Failed",
    "Unsubscribed",
    "Open tracking",
    "Click tracking",
  ];

  const rows = [headers.join(",")];
  for (const c of campaigns) {
    rows.push(
      [
        c.name,
        c.status,
        `${range.since.toISOString().slice(0, 10)} .. ${range.until.toISOString().slice(0, 10)}`,
        c.recipients,
        c.sent,
        c.delivered ?? "not available",
        c.uniqueOpens,
        c.totalOpens,
        c.openRate ?? "not available",
        c.openRateDenominator,
        c.uniqueClicks,
        c.totalClicks,
        c.clickRate ?? "not available",
        c.replies,
        c.replyRate ?? "not available",
        c.bounced,
        c.failed,
        c.unsubscribed,
        c.trackingEnabled ? "enabled" : "disabled",
        c.clickTrackingEnabled ? "enabled" : "disabled",
      ]
        .map(escapeCell)
        .join(","),
    );
  }

  // A short note at the end so the file explains itself.
  rows.push("");
  rows.push(
    escapeCell(
      "Note: opens and clicks are approximate. Apple Mail Privacy Protection, image blocking and security scanners trigger tracking automatically. An open is not proof that a person read the message.",
    ),
  );
  rows.push(
    escapeCell(
      "Delivered is only reported when the provider confirmed delivery; the Gmail API and plain SMTP do not report it.",
    ),
  );

  const csv = `${rows.join("\r\n")}\r\n`;
  const stamp = new Date().toISOString().slice(0, 10);

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="campaign-report-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
});
