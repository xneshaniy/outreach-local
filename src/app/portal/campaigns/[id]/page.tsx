"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Badge, Card, EmptyState, Skeleton } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";

/**
 * The client report for one campaign.
 *
 * The API refuses to return a campaign that was not explicitly assigned to
 * this client, so there is no way to reach another client's report by
 * changing the URL.
 */

type Report = {
  campaign: {
    id: string;
    name: string;
    subject: string;
    status: string;
    createdAt: string;
    startAt: string | null;
    trackingEnabled: boolean;
    clickTrackingEnabled: boolean;
  };
  range: { since: string; until: string };
  metrics: {
    sent: number;
    delivered: number | null;
    uniqueOpens: number;
    totalOpens: number;
    openRate: number | null;
    openRateDenominator: "delivered" | "sent";
    uniqueClicks: number;
    totalClicks: number;
    clickRate: number | null;
    replies: number;
    replyRate: number | null;
    bounced: number;
    failed: number;
    unsubscribed: number;
    recipients: number;
    pending: number;
  };
  daily: Array<{ date: string; sent: number; uniqueOpens: number; uniqueClicks: number; replies: number }>;
  topLinks: Array<{ url: string; clicks: number; uniqueClicks: number }>;
  availability: { delivered: boolean; opens: boolean; clicks: boolean };
};

export default function PortalCampaignReportPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState("30");

  const load = useCallback(() => {
    setError(null);
    api<Report>(`/api/portal/campaigns/${id}?days=${days}`)
      .then(setData)
      .catch((err) => setError(errorMessage(err)));
  }, [id, days]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) {
    return (
      <>
        <Link href="/portal" className="text-sm text-[var(--accent)] hover:underline">
          ← Back to the portal
        </Link>
        <div role="alert" className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      </>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  const m = data.metrics;
  const maxSent = Math.max(1, ...data.daily.map((p) => p.sent));

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/portal" className="text-sm text-[var(--accent)] hover:underline">
            ← Back to the portal
          </Link>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">{data.campaign.name}</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {data.campaign.subject} · {data.campaign.status}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="report-days" className="sr-only">
            Reporting period
          </label>
          <select
            id="report-days"
            value={days}
            onChange={(e) => setDays(e.target.value)}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm"
          >
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="365">Last 12 months</option>
          </select>
          <a
            href={`/api/portal/reports/print?campaignId=${data.campaign.id}&days=${days}`}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2 text-sm font-medium hover:bg-black/5 dark:hover:bg-white/5"
          >
            Print / PDF
          </a>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Recipients" value={m.recipients} />
        <Stat label="Sent (accepted)" value={m.sent} hint="Confirmed accepted by the provider" />
        <Stat
          label="Delivered"
          value={m.delivered}
          unavailable={!data.availability.delivered}
          hint={data.availability.delivered ? "Confirmed by the provider" : "Not reported by the provider"}
        />
        <Stat
          label="Unique opens"
          value={m.uniqueOpens}
          unavailable={!data.availability.opens}
          hint={data.availability.opens ? `${m.totalOpens} total opens` : "Tracking is off"}
        />
        <Stat
          label="Open rate"
          value={m.openRate === null ? "—" : `${m.openRate}%`}
          unavailable={!data.availability.opens}
          hint={data.availability.opens ? `of ${m.openRateDenominator}` : undefined}
        />
        <Stat
          label="Unique clicks"
          value={m.uniqueClicks}
          unavailable={!data.availability.clicks}
          hint={data.availability.clicks ? `${m.totalClicks} total clicks` : "Tracking is off"}
        />
        <Stat
          label="Click rate"
          value={m.clickRate === null ? "—" : `${m.clickRate}%`}
          unavailable={!data.availability.clicks}
        />
        <Stat label="Replies" value={m.replies} />
        <Stat label="Reply rate" value={m.replyRate === null ? "—" : `${m.replyRate}%`} hint="of sent" />
        <Stat label="Bounced" value={m.bounced} />
        <Stat label="Failed" value={m.failed} />
        <Stat label="Unsubscribed" value={m.unsubscribed} />
        <Stat label="Still to send" value={m.pending} />
      </div>

      {data.availability.opens && (
        <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
          <strong>Open and click data are approximate.</strong> Apple Mail Privacy Protection, image
          blocking and security scanners trigger tracking automatically — an open is not proof that a
          person read the message.
        </div>
      )}

      <div className="mt-6">
        <Card title="Daily performance" description="Sent, unique opens, unique clicks and replies per day.">
          {data.daily.length === 0 ? (
            <EmptyState title="No activity in this period" description="Try a longer date range." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-[var(--border)] text-xs uppercase tracking-wide text-[var(--muted)]">
                    <th scope="col" className="px-3 py-2 font-medium">Date</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Sent</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Opens</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Clicks</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Replies</th>
                    <th scope="col" className="px-3 py-2 font-medium">Volume</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {data.daily.map((p) => (
                    <tr key={p.date}>
                      <td className="px-3 py-2 whitespace-nowrap">{p.date}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{p.sent}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {data.availability.opens ? p.uniqueOpens : "n/a"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {data.availability.clicks ? p.uniqueClicks : "n/a"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{p.replies}</td>
                      <td className="px-3 py-2">
                        <div
                          className="h-2 rounded bg-[var(--accent)]"
                          style={{ width: `${Math.max(2, Math.round((p.sent / maxSent) * 100))}%` }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {data.topLinks.length > 0 && (
        <div className="mt-4">
          <Card title="Most clicked links">
            <ul className="divide-y divide-[var(--border)] text-sm">
              {data.topLinks.map((l) => (
                <li key={l.url} className="flex flex-wrap items-center justify-between gap-3 py-2">
                  <span className="min-w-0 truncate text-[var(--muted)]">{l.url}</span>
                  <span className="flex shrink-0 items-center gap-3">
                    <Badge tone="blue">{l.uniqueClicks} unique</Badge>
                    <span className="text-xs text-[var(--muted)]">{l.clicks} total</span>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </>
  );
}

function Stat({
  label,
  value,
  hint,
  unavailable,
}: {
  label: string;
  value: number | string | null;
  hint?: string;
  unavailable?: boolean;
}) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <p className="text-xs uppercase tracking-wide text-[var(--muted)]">{label}</p>
      {unavailable ? (
        <p className="mt-1 text-sm text-[var(--muted)]">Not available</p>
      ) : (
        <p className="mt-1 text-2xl font-semibold tabular-nums">
          {value === null ? "—" : typeof value === "number" ? value.toLocaleString() : value}
        </p>
      )}
      {hint && <p className="mt-1 text-xs text-[var(--muted)]">{hint}</p>}
    </div>
  );
}
