"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  InfoHint,
  ProgressBar,
  Skeleton,
  StatCard,
  StatusBadge,
} from "@/components/ui";
import { BarChart, ChartLegend, CHART_COLORS } from "@/components/charts";
import { api, errorMessage } from "@/lib/client/api";

/**
 * The client report for one campaign.
 *
 * The API refuses to return a campaign that was not explicitly assigned to
 * this client, so there is no way to reach another client's report by editing
 * the URL.
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
    sendingWindow: { startMinute: number; endMinute: number; days: number[] };
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState("30");

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api<Report>(`/api/portal/campaigns/${id}?days=${days}`)
      .then(setData)
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setLoading(false));
  }, [id, days]);

  useEffect(() => {
    load();
  }, [load]);

  const m = data?.metrics;

  return (
    <div className="min-h-screen bg-[var(--background)]">
      <header className="border-b border-[var(--border)] bg-[var(--surface)]">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-4 px-4 py-4 sm:px-6 sm:py-5">
          <div className="min-w-0 flex-1">
            <Link
              href="/portal"
              className="text-[12.5px] font-medium text-[var(--accent)] hover:underline"
            >
              ← Back to your campaigns
            </Link>
            <h1 className="mt-1.5 truncate text-[22px] font-semibold leading-7 tracking-[-0.02em] sm:text-[26px] sm:leading-8">
              {data?.campaign.name ?? "Campaign report"}
            </h1>
            {data && (
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <StatusBadge status={data.campaign.status} />
                <span className="text-[13px] text-[var(--muted)]">
                  {data.campaign.subject}
                </span>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="report-range" className="sr-only">
              Reporting period
            </label>
            <select
              id="report-range"
              value={days}
              onChange={(e) => setDays(e.target.value)}
              className="h-9 cursor-pointer rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--surface)] px-3 text-[13px] text-[var(--text)]"
            >
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
              <option value="365">Last 12 months</option>
            </select>
            <a
              href={`/api/portal/reports/print?campaignId=${id}&days=${days}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 items-center gap-2 rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--surface)] px-3.5 text-[13.5px] font-medium text-[var(--text)] transition-colors hover:bg-[var(--surface-3)]"
            >
              <span aria-hidden>⎙</span>
              Print / PDF
            </a>
            <a
              href="/api/portal/reports/export"
              className="inline-flex h-9 items-center gap-2 rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--surface)] px-3.5 text-[13.5px] font-medium text-[var(--text)] transition-colors hover:bg-[var(--surface-3)]"
            >
              <span aria-hidden>⇩</span>
              CSV
            </a>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 sm:py-8">
        {error && (
          <div className="mb-5">
            <ErrorState message={error} onRetry={load} />
          </div>
        )}

        {loading && !data ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[...Array(8)].map((_, i) => (
              <Skeleton key={i} className="h-32 rounded-[var(--radius-lg)]" />
            ))}
          </div>
        ) : data && m ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard
                label="Emails sent"
                value={m.sent.toLocaleString()}
                hint={`of ${m.recipients.toLocaleString()} recipients`}
                icon="⇄"
              />
              <StatCard
                label="Delivered"
                value={m.delivered?.toLocaleString()}
                hint={
                  data.availability.delivered
                    ? "Confirmed by a delivery event"
                    : "Your mail provider does not report delivery, so this figure is not available."
                }
                unavailable={!data.availability.delivered}
                icon="✓"
                tone="success"
              />
              <StatCard
                label="Unique opens"
                value={m.uniqueOpens.toLocaleString()}
                hint={
                  data.availability.opens
                    ? `${m.totalOpens.toLocaleString()} total opens`
                    : "Open tracking is not enabled on this campaign."
                }
                unavailable={!data.availability.opens}
                icon="◉"
              />
              <StatCard
                label="Open rate"
                value={m.openRate === null ? "—" : `${m.openRate}%`}
                hint={
                  data.availability.opens
                    ? `of ${m.openRateDenominator} · an estimate`
                    : "Open tracking is not enabled."
                }
                unavailable={!data.availability.opens}
                tone="warning"
                icon="%"
              />
              <StatCard
                label="Unique clicks"
                value={m.uniqueClicks.toLocaleString()}
                hint={
                  data.availability.clicks
                    ? `${m.totalClicks.toLocaleString()} total clicks`
                    : "Click tracking is not enabled on this campaign."
                }
                unavailable={!data.availability.clicks}
                icon="↗"
              />
              <StatCard
                label="Replies"
                value={m.replies.toLocaleString()}
                hint={m.replyRate === null ? undefined : `${m.replyRate}% reply rate`}
                icon="↩"
                tone="success"
              />
              <StatCard
                label="Bounced"
                value={m.bounced.toLocaleString()}
                icon="!"
                tone={m.bounced > 0 ? "danger" : "default"}
              />
              <StatCard
                label="Unsubscribed"
                value={m.unsubscribed.toLocaleString()}
                icon="⊘"
              />
            </div>

            {data.availability.opens && (
              <p className="mt-3 flex items-start gap-2 text-[12px] leading-5 text-[var(--muted)]">
                <InfoHint content="Apple Mail Privacy Protection, image blocking and security scanners load tracking automatically. Open numbers are an approximation, not proof that a person read the message. Replies are the reliable signal." />
                <span>
                  Open and click figures are{" "}
                  <strong className="font-medium text-[var(--text-secondary)]">approximations</strong>. Email
                  privacy features and automated image loading distort them — replies are the reliable
                  measure of engagement.
                </span>
              </p>
            )}

            <div className="mt-6 grid gap-4 xl:grid-cols-3">
              <Card
                className="xl:col-span-2"
                title="Daily performance"
                description="Sent, unique opens, unique clicks and replies per day."
              >
                {data.daily.length === 0 ? (
                  <EmptyState
                    icon="▤"
                    title="No activity in this period"
                    description="Try a longer date range."
                  />
                ) : (
                  <>
                    <BarChart
                      points={data.daily.map((d) => ({
                        label: d.date.slice(5),
                        values: {
                          sent: d.sent,
                          opens: d.uniqueOpens,
                          replies: d.replies,
                        },
                      }))}
                      series={[
                        { key: "sent", label: "Sent", color: CHART_COLORS.accent },
                        { key: "opens", label: "Unique opens", color: CHART_COLORS.info },
                        { key: "replies", label: "Replies", color: CHART_COLORS.success },
                      ]}
                      ariaLabel="Daily campaign performance"
                    />
                    <ChartLegend
                      series={[
                        { label: "Sent", color: CHART_COLORS.accent },
                        { label: "Unique opens", color: CHART_COLORS.info },
                        { label: "Replies", color: CHART_COLORS.success },
                      ]}
                    />
                  </>
                )}
              </Card>

              <Card title="Progress" description="How much of the campaign has been delivered.">
                <div className="space-y-5">
                  <div>
                    <div className="mb-1.5 flex items-center justify-between text-[13px]">
                      <span className="text-[var(--muted)]">Sent</span>
                      <span className="tnum font-medium">
                        {m.sent}/{m.recipients}
                      </span>
                    </div>
                    <ProgressBar
                      value={m.sent}
                      max={Math.max(1, m.recipients)}
                      tone={m.sent >= m.recipients ? "success" : "accent"}
                      label="Sending progress"
                    />
                  </div>
                  {m.pending > 0 && (
                    <p className="text-[12.5px] text-[var(--muted)]">
                      {m.pending.toLocaleString()} still scheduled.
                    </p>
                  )}
                  <div className="space-y-2 border-t border-[var(--border)] pt-4 text-[12.5px]">
                    <div className="flex items-center justify-between">
                      <span className="text-[var(--muted)]">Started</span>
                      <span>{(data.campaign.startAt ?? data.campaign.createdAt).slice(0, 10)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[var(--muted)]">Sending window</span>
                      <span>
                        {Math.floor(data.campaign.sendingWindow.startMinute / 60).toString().padStart(2, "0")}:
                        {(data.campaign.sendingWindow.startMinute % 60).toString().padStart(2, "0")} –{" "}
                        {Math.floor(data.campaign.sendingWindow.endMinute / 60).toString().padStart(2, "0")}:
                        {(data.campaign.sendingWindow.endMinute % 60).toString().padStart(2, "0")}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[var(--muted)]">Sending days</span>
                      <span>{data.campaign.sendingWindow.days.length} per week</span>
                    </div>
                  </div>
                </div>
              </Card>
            </div>

            {data.topLinks.length > 0 && (
              <div className="mt-4">
                <Card title="Most clicked links" description="Where the interest is coming from.">
                  <ul className="divide-y divide-[var(--border)] text-[13px]">
                    {data.topLinks.map((l) => (
                      <li key={l.url} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                        <span className="min-w-0 truncate text-[var(--muted)]">{l.url}</span>
                        <span className="flex shrink-0 items-center gap-2">
                          <Badge tone="accent">{l.uniqueClicks} unique</Badge>
                          <span className="text-[11.5px] text-[var(--muted)]">{l.clicks} total</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </Card>
              </div>
            )}

            <p className="mt-6 text-center text-[11.5px] text-[var(--muted-2)]">
              Report generated {data.range.until.slice(0, 10)} · {data.range.since.slice(0, 10)} to{" "}
              {data.range.until.slice(0, 10)}
            </p>
          </>
        ) : null}
      </main>
    </div>
  );
}
