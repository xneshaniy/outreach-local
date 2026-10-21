"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/AppShell";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  InfoHint,
  Note,
  ProgressBar,
  Skeleton,
  StatCard,
  StatusBadge,
  Tabs,
} from "@/components/ui";
import { BarChart, ChartLegend, LineChart, CHART_COLORS } from "@/components/charts";
import { api, errorMessage } from "@/lib/client/api";

/**
 * The administrator dashboard.
 *
 * Every figure comes from /api/dashboard, which counts real rows. Metrics the
 * provider cannot supply are shown as "not available" rather than zero, and
 * the open rate is explicitly labelled as an estimate.
 */

type Dashboard = {
  range: { days: number };
  contacts: { total: number; eligible: number; ineligible: number };
  campaigns: { total: number; byStatus: Record<string, number> };
  messages: {
    queued: number;
    processing: number;
    ambiguous: number;
    accepted: number;
    delivered: number | null;
    bounced: number;
    failed: number;
    cancelled: number;
    skipped: number;
    replies: number;
    unsubscribed: number;
  };
  engagement: {
    uniqueOpens: number;
    totalOpens: number;
    uniqueClicks: number;
    estimated: boolean;
    openRate: number | null;
    openRateDenominator: string;
  };
  followUps: { scheduled: number };
  suppressions: { total: number };
  tasks: { open: number };
  queue: {
    upcoming: Array<{
      id: string;
      scheduledAt: string;
      kind: string;
      contact: { email: string };
      campaign: { id: string; name: string };
    }>;
    deadLettered: number;
  };
  notifications: { unread: number };
  senders: Array<{
    id: string;
    email: string;
    provider: string;
    status: string;
    dailyCap: number;
    lastError: string | null;
    usage: { sentCount: number; reservedCount: number } | null;
  }>;
  activity: Array<{
    id: string;
    type: string;
    summary: string;
    createdAt: string;
    contact: { id: string; email: string; firstName: string | null };
  }>;
  failures: Array<{
    id: string;
    status: string;
    lastError: string | null;
    errorCode: string | null;
    updatedAt: string;
    contact: { email: string };
    campaign: { name: string };
  }>;
  health: { ok: boolean; problems: Array<{ level: "error" | "warning"; message: string }> };
  availability: {
    delivered: boolean;
    opens: boolean;
    clicks: boolean;
    replies: boolean;
    bounces: boolean;
  };
};

const RANGE_OPTIONS = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "365", label: "Last 12 months" },
];

export default function DashboardPage() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState("30");
  const [tab, setTab] = useState<"overview" | "campaigns" | "senders">("overview");

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api<Dashboard>(`/api/dashboard?days=${days}`)
      .then(setData)
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setLoading(false));
  }, [days]);

  useEffect(() => {
    load();
  }, [load]);

  const campaignStatus = data?.campaigns.byStatus ?? {};
  const statusEntries = Object.entries(campaignStatus).sort((a, b) => b[1] - a[1]);

  // The daily series is derived from the queue + activity, not invented.
  const activitySeries = useMemo(() => {
    if (!data) return [] as Array<{ label: string; values: Record<string, number> }>;
    const byDay = new Map<string, number>();
    for (const a of data.activity) {
      const day = new Date(a.createdAt).toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + 1);
    }
    return [...byDay.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-14)
      .map(([label, v]) => ({ label, values: { activity: v } }));
  }, [data]);

  return (
    <>
      <PageHeader
        eyebrow={
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--muted)]">
            Workspace overview
          </span>
        }
        title="Dashboard"
        description="Everything that is happening right now, and anything that needs your attention."
        actions={
          <>
            <label htmlFor="dash-range" className="sr-only">
              Reporting period
            </label>
            <select
              id="dash-range"
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
            <Button
              onClick={() => {
                setTab("overview");
                load();
              }}
              variant="outline"
            >
              Refresh
            </Button>
            <Link
              href="/campaigns/new"
              className="inline-flex h-9 items-center gap-2 rounded-[var(--radius)] bg-[var(--accent)] px-3.5 text-[13.5px] font-medium text-[var(--on-accent)] shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--accent-hover)]"
            >
              New campaign
            </Link>
          </>
        }
      />

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
      ) : data ? (
        <>
          {/* System health -------------------------------------------------- */}
          {data.health.problems.length > 0 && (
            <div className="mb-5">
              <Note tone={data.health.ok ? "warning" : "danger"} icon="⚠">
                <p className="font-medium">
                  {data.health.ok ? "Things to check" : "Action needed"}
                </p>
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  {data.health.problems.map((p) => (
                    <li key={p.message}>{p.message}</li>
                  ))}
                </ul>
              </Note>
            </div>
          )}

          {/* Headline metrics ---------------------------------------------- */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Contacts"
              value={data.contacts.total.toLocaleString()}
              hint={`${data.contacts.eligible.toLocaleString()} eligible · ${data.contacts.ineligible.toLocaleString()} excluded`}
              icon="☺"
            />
            <StatCard
              label="Campaigns"
              value={data.campaigns.total.toLocaleString()}
              hint={statusEntries.length ? statusEntries.map(([k, v]) => `${v} ${k.toLowerCase()}`).join(" · ") : "No campaigns yet"}
              icon="✉"
            />
            <StatCard
              label="Accepted by provider"
              value={data.messages.accepted.toLocaleString()}
              hint={`${data.messages.queued.toLocaleString()} queued · ${data.messages.processing.toLocaleString()} processing`}
              icon="⇄"
              tone="success"
            />
            <StatCard
              label="Replies"
              value={data.messages.replies.toLocaleString()}
              hint={
                data.availability.replies
                  ? "Matched to a contact and campaign"
                  : "This provider cannot be polled for replies"
              }
              unavailable={!data.availability.replies}
              icon="↩"
            />
            <StatCard
              label="Delivered"
              value={data.messages.delivered?.toLocaleString()}
              hint={
                data.availability.delivered
                  ? "Confirmed by a delivery event"
                  : "The provider does not report delivery"
              }
              unavailable={!data.availability.delivered}
              icon="✓"
            />
            <StatCard
              label="Unique opens"
              value={data.engagement.uniqueOpens.toLocaleString()}
              hint={
                data.availability.opens
                  ? `${data.engagement.totalOpens.toLocaleString()} total opens`
                  : "Open tracking is off for these campaigns"
              }
              unavailable={!data.availability.opens}
              icon="◉"
            />
            <StatCard
              label="Open rate"
              value={data.engagement.openRate === null ? "—" : `${data.engagement.openRate}%`}
              hint={
                data.availability.opens
                  ? `of ${data.engagement.openRateDenominator} · an estimate`
                  : "Open tracking is off"
              }
              unavailable={!data.availability.opens}
              tone="warning"
              icon="%"
            />
            <StatCard
              label="Follow-ups scheduled"
              value={data.followUps.scheduled.toLocaleString()}
              hint={`${data.tasks.open} open task${data.tasks.open === 1 ? "" : "s"}`}
              icon="↻"
            />
          </div>

          {data.availability.opens && (
            <p className="mt-3 flex items-start gap-2 text-[12px] leading-5 text-[var(--muted)]">
              <InfoHint content="Apple Mail Privacy Protection, image blocking and security scanners load tracking automatically. An open is an approximation, not proof that a person read the message." />
              <span>
                Open and click data are <strong className="font-medium text-[var(--text-secondary)]">estimates</strong>.
                Email privacy features and automated image loading distort them.
              </span>
            </p>
          )}

          {/* Tabs ----------------------------------------------------------- */}
          <div className="mt-7">
            <Tabs
              value={tab}
              onChange={(k) => setTab(k as typeof tab)}
              tabs={[
                { key: "overview", label: "Activity" },
                { key: "campaigns", label: "Campaigns", count: data.campaigns.total },
                { key: "senders", label: "Sender accounts", count: data.senders.length },
              ]}
            />
          </div>

          <div className="mt-5">
            {tab === "overview" && (
              <div className="grid gap-4 xl:grid-cols-3">
                <Card
                  className="xl:col-span-2"
                  title="Recent activity"
                  description="Messages, replies and changes across your contacts."
                >
                  {activitySeries.length === 0 ? (
                    <EmptyState
                      icon="◷"
                      title="No activity in this period"
                      description="Import contacts, connect a sender and start a campaign — the activity appears here."
                      action={
                        <Link
                          href="/campaigns/new"
                          className="text-[13px] font-medium text-[var(--accent)] hover:underline"
                        >
                          Create your first campaign
                        </Link>
                      }
                    />
                  ) : (
                    <>
                      <LineChart
                        points={activitySeries}
                        series={[
                          { key: "activity", label: "Activity", color: CHART_COLORS.accent, values: [] },
                        ]}
                        ariaLabel="Activity over the selected period"
                      />
                      <ChartLegend
                        series={[{ label: "Activity events", color: CHART_COLORS.accent }]}
                      />
                    </>
                  )}
                </Card>

                <div className="flex flex-col gap-4">
                  <Card title="Next to send" description="Scheduled in recipient-local time.">
                    {data.queue.upcoming.length === 0 ? (
                      <p className="py-4 text-center text-[13px] text-[var(--muted)]">
                        Nothing is scheduled right now.
                      </p>
                    ) : (
                      <ul className="divide-y divide-[var(--border)] text-[13px]">
                        {data.queue.upcoming.map((j) => (
                          <li key={j.id} className="flex items-center justify-between gap-3 py-2">
                            <span className="min-w-0 truncate">{j.contact.email}</span>
                            <span className="flex shrink-0 items-center gap-2">
                              {j.kind === "FOLLOW_UP" && <Badge tone="accent">follow-up</Badge>}
                              <span className="tnum text-[12px] text-[var(--muted)]">
                                {new Date(j.scheduledAt).toLocaleString()}
                              </span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Card>

                  <Card title="Quick actions">
                    <div className="grid grid-cols-2 gap-2">
                      {[
                        { href: "/campaigns/new", label: "New campaign", icon: "✉" },
                        { href: "/contacts/import", label: "Import contacts", icon: "⇧" },
                        { href: "/services", label: "Manage services", icon: "◆" },
                        { href: "/replies", label: "Review replies", icon: "↩" },
                      ].map((a) => (
                        <Link
                          key={a.href}
                          href={a.href}
                          className="flex items-center gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 text-[13px] font-medium text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-3)] hover:text-[var(--text)]"
                        >
                          <span aria-hidden className="text-[var(--accent)]">
                            {a.icon}
                          </span>
                          {a.label}
                        </Link>
                      ))}
                    </div>
                  </Card>
                </div>
              </div>
            )}

            {tab === "campaigns" && (
              <Card
                title="Campaigns by status"
                description="How many campaigns are in each state."
                actions={
                  <Link
                    href="/campaigns"
                    className="text-[12.5px] font-medium text-[var(--accent)] hover:underline"
                  >
                    Open campaigns →
                  </Link>
                }
              >
                {statusEntries.length === 0 ? (
                  <EmptyState
                    icon="✉"
                    title="No campaigns yet"
                    description="Create a campaign, add recipients and start sending inside each recipient's local window."
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
                  <div className="grid gap-5 lg:grid-cols-2">
                    <BarChart
                      points={statusEntries.map(([label, v]) => ({ label, values: { count: v } }))}
                      series={[{ key: "count", label: "Campaigns", color: CHART_COLORS.accent, values: [] }]}
                      ariaLabel="Campaigns by status"
                      stacked={false}
                    />
                    <ul className="flex flex-col justify-center gap-2">
                      {statusEntries.map(([label, v]) => (
                        <li key={label} className="flex items-center justify-between gap-3 text-[13px]">
                          <StatusBadge status={label} />
                          <span className="tnum font-medium">{v}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </Card>
            )}

            {tab === "senders" && (
              <Card title="Sender accounts" description="Capacity used today, per account.">
                {data.senders.length === 0 ? (
                  <EmptyState
                    icon="@"
                    title="No sender accounts"
                    description="Connect a Gmail or SMTP account to be able to send. Until then nothing can leave the system."
                    action={
                      <Link
                        href="/senders"
                        className="text-[13px] font-medium text-[var(--accent)] hover:underline"
                      >
                        Connect a sender
                      </Link>
                    }
                  />
                ) : (
                  <ul className="divide-y divide-[var(--border)]">
                    {data.senders.map((s) => {
                      const used = s.usage?.sentCount ?? 0;
                      const pct = s.dailyCap > 0 ? Math.round((used / s.dailyCap) * 100) : 0;
                      return (
                        <li key={s.id} className="flex flex-wrap items-center gap-3 py-3">
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13.5px] font-medium">{s.email}</span>
                            <span className="block text-[12px] text-[var(--muted)]">
                              {s.provider} · cap {s.dailyCap}/day
                            </span>
                          </span>
                          <span className="tnum w-20 text-right text-[13px] font-medium">
                            {used}/{s.dailyCap}
                          </span>
                          <span className="hidden w-24 sm:block">
                            <ProgressBar
                              value={used}
                              max={s.dailyCap}
                              tone={pct >= 100 ? "danger" : pct >= 80 ? "warning" : "accent"}
                              label={`${s.email} capacity used today`}
                            />
                          </span>
                          <StatusBadge status={s.status} />
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Card>
            )}
          </div>
        </>
      ) : null}
    </>
  );
}
