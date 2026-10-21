"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Card,
  EmptyState,
  ErrorState,
  InfoHint,
  ProgressBar,
  Skeleton,
  StatCard,
  StatusBadge,
  Table,
  Tabs,
} from "@/components/ui";
import { PageHeader } from "@/components/AppShell";
import { BarChart, ChartLegend, DonutChart, CHART_COLORS } from "@/components/charts";
import { api, errorMessage } from "@/lib/client/api";

/**
 * Analytics.
 *
 * All figures are counted from the database. A metric the provider cannot
 * supply is shown as "not available" — never as zero. The open rate is
 * labelled as an estimate, because email privacy features distort it.
 */

type Analytics = {
  windowDays: number;
  totals: {
    sent: number;
    attemptsByOutcome: Record<string, number>;
    suppressionsByReason: Record<string, number>;
  };
  campaigns: Array<{
    id: string;
    name: string;
    status: string;
    total: number;
    byStatus: Record<string, number>;
  }>;
  todayUsage: Array<{
    sentCount: number;
    reservedCount: number;
    senderAccount: { email: string; dailyCap: number; status: string };
  }>;
  recentFailures: Array<{
    id: string;
    status: string;
    errorCode: string | null;
    lastError: string | null;
    attempts: number;
    updatedAt: string;
    campaign: { name: string };
    contact: { email: string };
  }>;
};

const DAY_OPTIONS = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "365", label: "Last 12 months" },
];

const OUTCOME_META: Record<string, { label: string; color: string }> = {
  SUCCESS: { label: "Delivered attempts", color: CHART_COLORS.success },
  TRANSIENT_FAILURE: { label: "Transient failures", color: CHART_COLORS.warning },
  PERMANENT_FAILURE: { label: "Permanent failures", color: CHART_COLORS.danger },
  AMBIGUOUS: { label: "Uncertain outcomes", color: CHART_COLORS.muted },
};

function labelize(key: string): string {
  return key.toLowerCase().replace(/_/g, " ");
}

export default function AnalyticsPage() {
  const [days, setDays] = useState("30");
  const [data, setData] = useState<Analytics | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"campaigns" | "outcomes" | "failures">("campaigns");

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    api<Analytics>(`/api/analytics?days=${days}`)
      .then(setData)
      .catch((e) => setLoadError(errorMessage(e)))
      .finally(() => setLoading(false));
  }, [days]);

  useEffect(() => {
    load();
  }, [load]);

  const outcomeSlices = data
    ? Object.entries(data.totals.attemptsByOutcome).map(([key, value]) => ({
        label: OUTCOME_META[key]?.label ?? labelize(key),
        value,
        color: OUTCOME_META[key]?.color ?? CHART_COLORS.muted,
      }))
    : [];

  const campaignPoints = (data?.campaigns ?? []).slice(0, 12).map((c) => ({
    label: c.name.length > 14 ? `${c.name.slice(0, 14)}…` : c.name,
    values: { sent: c.byStatus.SENT ?? 0, total: c.total },
  }));

  return (
    <>
      <PageHeader
        title="Analytics"
        description="Delivery outcomes, campaign performance and the failures that need attention."
        actions={
          <>
            <label htmlFor="analytics-range" className="sr-only">
              Reporting period
            </label>
            <select
              id="analytics-range"
              value={days}
              onChange={(e) => setDays(e.target.value)}
              className="h-9 cursor-pointer rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--surface)] px-3 text-[13px] text-[var(--text)]"
            >
              {DAY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <button
              onClick={load}
              className="inline-flex h-9 items-center gap-2 rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--surface)] px-3.5 text-[13.5px] font-medium text-[var(--text)] transition-colors hover:bg-[var(--surface-3)]"
            >
              <span aria-hidden>↻</span>
              Refresh
            </button>
          </>
        }
      />

      {loadError && (
        <div className="mb-5">
          <ErrorState message={loadError} onRetry={load} />
        </div>
      )}

      {loading && !data ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-32 rounded-[var(--radius-lg)]" />
          ))}
        </div>
      ) : data ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Accepted by provider"
              value={data.totals.sent.toLocaleString()}
              hint={`Over the last ${data.windowDays} days`}
              icon="⇄"
              tone="success"
            />
            <StatCard
              label="Delivered"
              hint="Not reported by the provider — shown as unavailable rather than guessed."
              unavailable
              icon="✓"
            />
            <StatCard
              label="Failed attempts"
              value={(
                (data.totals.attemptsByOutcome.PERMANENT_FAILURE ?? 0) +
                (data.totals.attemptsByOutcome.TRANSIENT_FAILURE ?? 0)
              ).toLocaleString()}
              hint={`${data.totals.attemptsByOutcome.AMBIGUOUS ?? 0} with an uncertain outcome`}
              icon="!"
              tone={(data.totals.attemptsByOutcome.PERMANENT_FAILURE ?? 0) > 0 ? "danger" : "default"}
            />
            <StatCard
              label="Suppressed"
              value={Object.values(data.totals.suppressionsByReason).reduce((a, b) => a + b, 0).toLocaleString()}
              hint="Opted out, bounced or complained"
              icon="⊘"
            />
          </div>

          <div className="mt-6">
            <Tabs
              value={tab}
              onChange={(k) => setTab(k as typeof tab)}
              tabs={[
                { key: "campaigns", label: "Campaigns", count: data.campaigns.length },
                { key: "outcomes", label: "Delivery outcomes" },
                { key: "failures", label: "Failures", count: data.recentFailures.length },
              ]}
            />
          </div>

          <div className="mt-5">
            {tab === "campaigns" && (
              <Card
                title="Sent per campaign"
                description="Messages the provider accepted, against the total audience."
              >
                {campaignPoints.length === 0 ? (
                  <EmptyState
                    icon="✉"
                    title="No campaigns yet"
                    description="Create a campaign to start collecting performance data."
                    action={
                      <Link
                        href="/campaigns/new"
                        className="text-[13px] font-medium text-[var(--accent)] hover:underline"
                      >
                        New campaign
                      </Link>
                    }
                  />
                ) : (
                  <>
                    <BarChart
                      points={campaignPoints}
                      series={[
                        { key: "sent", label: "Sent", color: CHART_COLORS.accent },
                        { key: "total", label: "Audience", color: CHART_COLORS.muted },
                      ]}
                      ariaLabel="Messages sent per campaign"
                      stacked={false}
                    />
                    <ChartLegend
                      series={[
                        { label: "Sent", color: CHART_COLORS.accent },
                        { label: "Audience", color: CHART_COLORS.muted },
                      ]}
                    />
                  </>
                )}
              </Card>
            )}

            {tab === "outcomes" && (
              <div className="grid gap-4 lg:grid-cols-2">
                <Card title="Delivery outcomes" description="What happened to every attempt.">
                  {outcomeSlices.length === 0 ? (
                    <EmptyState
                      icon="▤"
                      title="No send attempts yet"
                      description="Outcomes appear here once the worker starts sending."
                    />
                  ) : (
                    <DonutChart
                      slices={outcomeSlices}
                      ariaLabel="Delivery outcomes"
                      centerLabel="Attempts"
                    />
                  )}
                </Card>

                <Card title="Sender usage today" description="Capacity consumed per account.">
                  {data.todayUsage.length === 0 ? (
                    <EmptyState
                      icon="@"
                      title="No sender accounts"
                      description="Connect a Gmail or SMTP account to start sending."
                    />
                  ) : (
                    <ul className="flex flex-col gap-4">
                      {data.todayUsage.map((u) => {
                        const pct = u.senderAccount.dailyCap > 0 ? (u.sentCount / u.senderAccount.dailyCap) * 100 : 0;
                        return (
                          <li key={u.senderAccount.email}>
                            <div className="mb-1.5 flex items-center justify-between gap-3">
                              <span className="min-w-0 truncate text-[13.5px] font-medium">
                                {u.senderAccount.email}
                              </span>
                              <span className="tnum shrink-0 text-[12.5px] text-[var(--muted)]">
                                {u.sentCount}/{u.senderAccount.dailyCap}
                              </span>
                            </div>
                            <ProgressBar
                              value={u.sentCount}
                              max={u.senderAccount.dailyCap}
                              tone={pct >= 100 ? "danger" : pct >= 80 ? "warning" : "accent"}
                              label={`${u.senderAccount.email} usage today`}
                            />
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </Card>
              </div>
            )}

            {tab === "failures" && (
              <Card
                title="Recent failures"
                description="Messages that failed or whose outcome is unknown."
                actions={
                  <Link href="/queue" className="text-[12.5px] font-medium text-[var(--accent)] hover:underline">
                    Open queue →
                  </Link>
                }
              >
                {data.recentFailures.length === 0 ? (
                  <EmptyState
                    icon="✓"
                    title="Nothing has failed"
                    description="That is a good sign. Failures show up here with their reason."
                  />
                ) : (
                  <Table headers={["Contact", "Campaign", "Status", "Reason", "Attempts", "When"]}>
                    {data.recentFailures.map((f) => (
                      <tr key={f.id} className="text-[13.5px] transition-colors hover:bg-[var(--surface-2)]">
                        <td className="px-3 py-3 font-medium">{f.contact.email}</td>
                        <td className="px-3 py-3">{f.campaign.name}</td>
                        <td className="px-3 py-3">
                          <StatusBadge status={f.status} />
                        </td>
                        <td className="px-3 py-3 text-[12.5px] text-[var(--muted)]">
                          {f.errorCode ? `${f.errorCode}: ` : ""}
                          {f.lastError ?? "no detail"}
                        </td>
                        <td className="tnum px-3 py-3">{f.attempts}</td>
                        <td className="px-3 py-3 text-[12px] text-[var(--muted)]">
                          {new Date(f.updatedAt).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </Table>
                )}
              </Card>
            )}
          </div>

          <p className="mt-6 flex items-start gap-2 text-[12px] leading-5 text-[var(--muted)]">
            <InfoHint content="SMTP acceptance means the provider took the message, not that it reached an inbox. A separate delivery event is required for a true 'delivered' figure." />
            <span>
              <strong className="font-medium text-[var(--text-secondary)]">Accepted is not delivered.</strong>{" "}
              An SMTP or Gmail acceptance only means the provider took the message. A delivery event is
              required to confirm inbox delivery, and none is available with the current provider.
            </span>
          </p>
        </>
      ) : null}
    </>
  );
}
