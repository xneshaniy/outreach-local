import { NextRequest } from "next/server";
import { handleApi } from "@/lib/http";
import { clientCanAccessCampaign, parseRange, requireClient } from "@/lib/portal";
import { campaignMetrics, dailySeries, topLinks } from "@/lib/metrics";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/errors";

/**
 * GET /api/portal/reports/print?campaignId=… — a printable HTML report.
 *
 * Self-contained (no external stylesheet) so it prints correctly from the
 * browser. Access is checked exactly like the JSON report.
 */
export const GET = handleApi(async (req: NextRequest) => {
  const client = await requireClient();
  const url = new URL(req.url);
  const range = parseRange(url);
  const campaignId = url.searchParams.get("campaignId");

  if (!campaignId) throw ApiError.badRequest("A campaignId is required.");
  if (!(await clientCanAccessCampaign(client.id, campaignId))) {
    throw ApiError.notFound("Campaign not found.");
  }

  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, userId: client.userId },
    select: { id: true, name: true, subject: true, status: true },
  });
  if (!campaign) throw ApiError.notFound("Campaign not found.");

  const [metrics, series, links] = await Promise.all([
    campaignMetrics(campaign.id, range),
    dailySeries(campaign.id, range),
    topLinks(campaign.id, 10),
  ]);

  const pct = (v: number | null): string => (v === null ? "not available" : `${v}%`);
  const num = (v: number | null): string => (v === null ? "not available" : String(v));
  const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const maxSent = Math.max(1, ...series.map((p) => p.sent));
  const bars = series
    .map(
      (p) => `<tr>
        <td>${esc(p.date)}</td>
        <td class="n">${p.sent}</td>
        <td class="n">${p.uniqueOpens}</td>
        <td class="n">${p.uniqueClicks}</td>
        <td class="n">${p.replies}</td>
        <td><div class="bar" style="width:${Math.round((p.sent / maxSent) * 100)}%"></div></td>
      </tr>`,
    )
    .join("\n");

  const linkRows = links
    .map((l) => `<tr><td>${esc(l.url)}</td><td class="n">${l.uniqueClicks}</td><td class="n">${l.clicks}</td></tr>`)
    .join("\n");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Campaign report — ${esc(campaign.name)}</title>
<style>
  body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#111827;margin:0;padding:32px;background:#fff}
  h1{font-size:22px;margin:0 0 4px} h2{font-size:15px;margin:28px 0 8px;text-transform:uppercase;letter-spacing:.04em;color:#6b7280}
  .muted{color:#6b7280;font-size:13px;margin:0 0 20px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
  .box{border:1px solid #e5e7eb;border-radius:8px;padding:12px}
  .box .label{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#6b7280}
  .box .value{font-size:22px;font-weight:600;margin-top:2px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #e5e7eb}
  th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#6b7280}
  td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
  .bar{height:8px;background:#4f46e5;border-radius:4px;min-width:2px}
  .note{margin-top:26px;font-size:12px;color:#6b7280;border-left:3px solid #d1d5db;padding:8px 12px;background:#f9fafb}
  @media print{body{padding:0}.noprint{display:none}}
</style></head><body>
<h1>${esc(campaign.name)}</h1>
<p class="muted">${esc(campaign.subject)} &middot; ${esc(campaign.status)} &middot;
${range.since.toISOString().slice(0, 10)} to ${range.until.toISOString().slice(0, 10)} &middot;
prepared for ${esc(client.company ?? client.name)}</p>

<h2>Totals</h2>
<div class="grid">
  <div class="box"><div class="label">Recipients</div><div class="value">${metrics.recipients}</div></div>
  <div class="box"><div class="label">Sent (accepted)</div><div class="value">${metrics.sent}</div></div>
  <div class="box"><div class="label">Delivered</div><div class="value">${num(metrics.delivered)}</div></div>
  <div class="box"><div class="label">Unique opens</div><div class="value">${metrics.uniqueOpens}</div></div>
  <div class="box"><div class="label">Open rate</div><div class="value">${pct(metrics.openRate)}</div></div>
  <div class="box"><div class="label">Unique clicks</div><div class="value">${metrics.uniqueClicks}</div></div>
  <div class="box"><div class="label">Click rate</div><div class="value">${pct(metrics.clickRate)}</div></div>
  <div class="box"><div class="label">Replies</div><div class="value">${metrics.replies}</div></div>
  <div class="box"><div class="label">Reply rate</div><div class="value">${pct(metrics.replyRate)}</div></div>
  <div class="box"><div class="label">Bounced</div><div class="value">${metrics.bounced}</div></div>
  <div class="box"><div class="label">Failed</div><div class="value">${metrics.failed}</div></div>
  <div class="box"><div class="label">Unsubscribed</div><div class="value">${metrics.unsubscribed}</div></div>
</div>

<h2>Daily performance</h2>
<table>
  <thead><tr><th>Date</th><th class="n">Sent</th><th class="n">Unique opens</th><th class="n">Unique clicks</th><th class="n">Replies</th><th>Volume</th></tr></thead>
  <tbody>${bars || '<tr><td colspan="6">No activity in this period.</td></tr>'}</tbody>
</table>

${
  linkRows
    ? `<h2>Most clicked links</h2>
<table><thead><tr><th>Link</th><th class="n">Unique clicks</th><th class="n">Total clicks</th></tr></thead><tbody>${linkRows}</tbody></table>`
    : ""
}

<div class="note">
  <strong>Open and click data are approximate.</strong> Apple Mail Privacy Protection, image
  blocking and security scanners load tracking automatically, so an open is <em>not</em> proof that a
  person read the message. Unique counts exclude known automated traffic where it can be identified.
  ${
    metrics.delivered === null
      ? "<br><strong>Delivered is not available</strong> with the current email provider (the Gmail API and plain SMTP do not report per-message delivery). Open and click rates therefore use <em>sent (accepted by the provider)</em> as the denominator."
      : ""
  }
</div>
</body></html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
});
