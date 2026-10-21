"use client";

import Link from "next/link";
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
 * The client portal dashboard.
 *
 * This is a reporting product: a client should understand their results in a
 * few seconds. Every number comes from /api/portal/summary, which only counts
 * the campaigns explicitly assigned to this client.
 *
 * Estimated metrics (open rate) are labelled as estimates, and a metric the
 * provider cannot supply is shown as "not available" — never as zero.
 */

type Summary = {
  client: { name: string; email: string; company: string | null };
  range: { since: string; until: string };
  campaigns: number;
  totals: {
    sent: number;
    delivered: number;
    deliveredKnown: boolean;
    uniqueOpens: number;
    totalOpens: number;
    openRate: number | null;
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
    rateDenominator: "delivered" | "sent";
  };
  availability: { delivered: boolean; opens: boolean; clicks: boolean };
};

type Campaign = {
  id: string;
  name: string;
  status: string;
  sent: number;
  recipients: number;
  uniqueOpens: number;
  openRate: number | null;
  replies: number;
  replyRate: number | null;
  trackingEnabled: boolean;
};

const RANGE_OPTIONS = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "365", label: "Last 12 months" },
];

export default function PortalDashboardPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState("30");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, c] = await Promise.all([
        api<Summary>(`/api/portal/summary?days=${days}`),
        api<{ campaigns: Campaign[] }>(`/api/portal/campaigns?days=${days}`),
      ]);
      setSummary(s);
      setCampaigns(c.campaigns);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  const t = summary?.totals;

  return (
    <div className="min-h-screen bg-[var(--background)]">
      {/* Branded header */}
      <header className="border-b border-[var(--border)] bg-[var(--surface)]">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-4 px-4 py-4 sm:px-6 sm:py-5">
          <div className="min-w-0 flex-1">
            <p className="text-[11.5px] font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">
              Campaign report
            </p>
            <h1 className="mt-0.5 truncate text-[22px] font-semibold leading-7 tracking-[-0.02em] sm:text-[26px] sm:leading-8">
              {summary ? summary.client.name : "Your campaigns"}
            </h1>
            {summary?.client.company && (
              <p className="mt-0.5 text-[13.5px] text-[var(--muted)]">{summary.client.company}</p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="portal-range" className="sr-only">
              Reporting period
            </label>
            <select
              id="portal-range"
              value={days}
              onChange={(e) => setDays(e.target.value)}
              className="h-9 cursor-pointer rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--surface)] px-3 text-[13px] text-[var(--text)]"
            >
              {RANGE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <a
              href="/api/portal/reports/export"
              className="inline-flex h-9 items-center gap-2 rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--surface)] px-3.5 text-[13.5px] font-medium text-[var(--text)] transition-colors hover:bg-[var(--surface-3)]"
            >
              <span aria-hidden>⇩</span>
              Download report
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

        {loading && !summary ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[...Array(8)].map((_, i) => (
              <Skeleton key={i} className="h-32 rounded-[var(--radius-lg)]" />
            ))}
          </div>
        ) : summary && t ? (
          <>
            {/* Headline numbers ------------------------------------------- */}
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard
                label="Emails sent"
                value={t.sent.toLocaleString()}
                hint="Accepted by the mail provider"
                icon="⇄"
              />
              <StatCard
                label="Delivered"
                value={t.deliveredKnown ? t.delivered.toLocaleString() : undefined}
                hint={
                  t.deliveredKnown
                    ? "Confirmed by a delivery event"
                    : "Your mail provider does not report delivery, so this figure is not available."
                }
                unavailable={!t.deliveredKnown}
                icon="✓"
                tone="success"
              />
              <StatCard
                label="Unique opens"
                value={t.uniqueOpens.toLocaleString()}
                hint={
                  summary.availability.opens
                    ? `${t.totalOpens.toLocaleString()} total opens`
                    : "Open tracking is not enabled on these campaigns."
                }
                unavailable={!summary.availability.opens}
                icon="◉"
              />
              <StatCard
                label="Open rate"
                value={t.openRate === null ? "—" : `${t.openRate}%`}
                hint={
                  summary.availability.opens
                    ? `of ${t.rateDenominator} · an estimate`
                    : "Open tracking is not enabled."
                }
                unavailable={!summary.availability.opens}
                tone="warning"
                icon="%"
              />
              <StatCard
                label="Unique clicks"
                value={t.uniqueClicks.toLocaleString()}
                hint={
                  summary.availability.clicks
                    ? `${t.totalClicks.toLocaleString()} total clicks`
                    : "Click tracking is not enabled on these campaigns."
                }
                unavailable={!summary.availability.clicks}
                icon="↗"
              />
              <StatCard
                label="Replies"
                value={t.replies.toLocaleString()}
                hint={t.replyRate === null ? undefined : `${t.replyRate}% reply rate`}
                icon="↩"
                tone="success"
              />
              <StatCard
                label="Bounced"
                value={t.bounced.toLocaleString()}
                hint="Addresses that could not be delivered"
                icon="!"
                tone={t.bounced > 0 ? "danger" : "default"}
              />
              <StatCard
                label="Unsubscribed"
                value={t.unsubscribed.toLocaleString()}
                hint="Opted out — never contacted again"
                icon="⊘"
              />
            </div>

            {summary.availability.opens && (
              <p className="mt-3 flex items-start gap-2 text-[12px] leading-5 text-[var(--muted)]">
                <InfoHint content="Apple Mail Privacy Protection, image blocking and security scanners load tracking automatically. Open numbers are an approximation, not proof that a person read the message. Replies are the reliable signal." />
                <span>
                  Open and click figures are <strong className="font-medium text-[var(--text-secondary)]">approximations</strong>.
                  Email privacy features and automated image loading distort them — replies are the
                  reliable measure of engagement.
                </span>
              </p>
            )}

            {/* Performance chart ------------------------------------------ */}
            <div className="mt-6 grid gap-4 xl:grid-cols-3">
              <Card
                className="xl:col-span-2"
                title="Campaign performance"
                description="What has been sent and what came back."
              >
                {campaigns.length === 0 ? (
                  <EmptyState
                    icon="✉"
                    title="No campaigns assigned yet"
                    description="Your account manager has not assigned any campaigns to your account."
                  />
                ) : (
                  <BarChart
                    points={campaigns.map((c) => ({
                      label: c.name.length > 14 ? `${c.name.slice(0, 14)}…` : c.name,
                      values: { sent: c.sent, replies: c.replies },
                    }))}
                    series={[
                      { key: "sent", label: "Sent", color: CHART_COLORS.accent, values: [] },
                      { key: "replies", label: "Replies", color: CHART_COLORS.success, values: [] },
                    ]}
                    ariaLabel="Messages sent and replies received per campaign"
                  />
                )}
                <ChartLegend
                  series={[
                    { label: "Sent", color: CHART_COLORS.accent },
                    { label: "Replies", color: CHART_COLORS.success },
                  ]}
                />
              </Card>

              <Card title="Progress" description="How much of each campaign has been sent.">
                {campaigns.length === 0 ? (
                  <p className="py-6 text-center text-[13px] text-[var(--muted)]">
                    Nothing to show yet.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-4">
                    {campaigns.map((c) => {
                      const sent = c.sent;
                      const total = Math.max(c.recipients, sent);
                      const pct = total > 0 ? Math.round((sent / total) * 100) : 0;
                      return (
                        <li key={c.id}>
                          <div className="mb-1.5 flex items-center justify-between gap-3">
                            <Link
                              href={`/portal/campaigns/${c.id}`}
                              className="min-w-0 truncate text-[13px] font-medium hover:underline"
                            >
                              {c.name}
                            </Link>
                            <span className="tnum shrink-0 text-[12px] text-[var(--muted)]">
                              {sent}/{total}
                            </span>
                          </div>
                          <ProgressBar
                            value={sent}
                            max={total}
                            tone={pct >= 100 ? "success" : "accent"}
                            label={`${c.name} sending progress`}
                          />
                          <div className="mt-1.5 flex items-center gap-2">
                            <StatusBadge status={c.status} />
                            {c.replies > 0 && <Badge tone="success">{c.replies} replies</Badge>}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Card>
            </div>

            {/* Campaign table --------------------------------------------- */}
            <div className="mt-6">
              <Card title="Your campaigns" padded={false} contentClassName="p-5 pb-1">
                {campaigns.length === 0 ? (
                  <EmptyState
                    icon="✉"
                    title="No campaigns yet"
                    description="When a campaign is assigned to your account it will appear here with its full report."
                  />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[640px] text-left text-[13.5px]">
                      <thead>
                        <tr className="border-b border-[var(--border)]">
                          {["Campaign", "Status", "Sent", "Opened", "Open rate", "Replies", ""].map((h) => (
                            <th
                              key={h}
                              scope="col"
                              className="whitespace-nowrap px-3 py-2.5 text-[11.5px] font-semibold uppercase tracking-[0.05em] text-[var(--muted)]"
                            >
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--border)]">
                        {campaigns.map((c) => (
                          <tr key={c.id} className="transition-colors hover:bg-[var(--surface-2)]">
                            <td className="px-3 py-3 font-medium">{c.name}</td>
                            <td className="px-3 py-3">
                              <StatusBadge status={c.status} />
                            </td>
                            <td className="tnum px-3 py-3">{c.sent.toLocaleString()}</td>
                            <td className="tnum px-3 py-3">
                              {c.trackingEnabled ? c.uniqueOpens.toLocaleString() : "—"}
                            </td>
                            <td className="tnum px-3 py-3">
                              {c.trackingEnabled && c.openRate !== null ? `${c.openRate}%` : "—"}
                            </td>
                            <td className="tnum px-3 py-3">{c.replies.toLocaleString()}</td>
                            <td className="px-3 py-3 text-right">
                              <Link
                                href={`/portal/campaigns/${c.id}`}
                                className="text-[12.5px] font-medium text-[var(--accent)] hover:underline"
                              >
                                View report →
                              </Link>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </div>

            <p className="mt-6 text-center text-[11.5px] text-[var(--muted-2)]">
              Report generated {summary.range.until.slice(0, 10)} ·{" "}
              {summary.range.since.slice(0, 10)} to {summary.range.until.slice(0, 10)}
            </p>
          </>
        ) : null}
      </main>
    </div>
  );
}
