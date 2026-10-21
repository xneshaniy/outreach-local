"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Badge, Card, EmptyState, Skeleton, StatusBadge } from "@/components/ui";
import { PageHeader } from "@/components/AppShell";
import { api, errorMessage } from "@/lib/client/api";

/**
 * The dashboard.
 *
 * Every figure comes from /api/dashboard, which counts real rows. Where a
 * metric cannot be known (delivery with a provider that does not report it)
 * the value is "not available" — it is never shown as a zero.
 *
 * The open rate is explicitly labelled as an estimate.
 */

type Dashboard = {
  range: { days: number };
  filters: { campaignId: string | null; serviceId: string | null; senderAccountId: string | null };
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
  followUps: { byStatus: Record<string, number>; scheduled: number };
  suppressions: { total: number; byReason: Record<string, number> };
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

function Stat({
  label,
  value,
  hint,
  unavailable,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  unavailable?: boolean;
  tone?: string;
}) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <p className="text-xs uppercase tracking-wide text-[var(--muted)]">{label}</p>
      {unavailable ? (
        <p className="mt-1 text-sm text-[var(--muted)]" title="This metric is not available with the current setup.">
          Not available
        </p>
      ) : (
        <p className={`mt-1 text-2xl font-semibold tabular-nums ${tone ?? ""}`}>{value}</p>
      )}
      {hint && <p className="mt-1 text-xs text-[var(--muted)]">{hint}</p>}
    </div>
  );
}

export default function DashboardPage() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState("30");

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

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Everything that is happening, and anything that needs you."
        actions={
          <>
            <label htmlFor="dash-days" className="sr-only">
              Reporting period
            </label>
            <select
              id="dash-days"
              value={days}
              onChange={(e) => setDays(e.target.value)}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm"
            >
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
              <option value="365">Last 12 months</option>
            </select>
            <Link
              href="/campaigns/new"
              className="rounded-lg bg-[var(--accent)] px-3.5 py-2 text-sm font-medium text-white hover:opacity-90"
            >
              New campaign
            </Link>
          </>
        }
      />

      {error && (
        <div role="alert" className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {loading && !data ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[...Array(8)].map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : data ? (
        <>
          {/* System health ------------------------------------------------- */}
          {data.health.problems.length > 0 && (
            <div
              role="alert"
              className={`mb-4 rounded-lg border px-4 py-3 text-sm ${
                data.health.ok
                  ? "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200"
                  : "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300"
              }`}
            >
              <p className="font-medium">
                {data.health.ok ? "Things to check" : "Action needed"}
              </p>
              <ul className="mt-1 list-disc pl-5">
                {data.health.problems.map((p) => (
                  <li key={p.message}>{p.message}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Contacts and campaigns ----------------------------------------- */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Contacts"
              value={data.contacts.total.toLocaleString()}
              hint={`${data.contacts.eligible.toLocaleString()} eligible to receive`}
            />
            <Stat
              label="Campaigns"
              value={data.campaigns.total.toLocaleString()}
              hint={Object.entries(data.campaigns.byStatus)
                .map(([k, v]) => `${v} ${k.toLowerCase()}`)
                .join(" · ")}
            />
            <Stat
              label="Queued"
              value={data.messages.queued.toLocaleString()}
              hint={`${data.messages.processing} processing · ${data.messages.ambiguous} uncertain`}
            />
            <Stat
              label="Accepted by provider"
              value={data.messages.accepted.toLocaleString()}
              hint="Confirmed taken by the provider"
            />
            <Stat
              label="Delivered"
              value={data.messages.delivered ?? "—"}
              unavailable={!data.availability.delivered}
              hint={
                data.availability.delivered
                  ? "Confirmed by a delivery event"
                  : "The provider does not report delivery"
              }
            />
            <Stat
              label="Replied"
              value={data.messages.replies.toLocaleString()}
              hint={data.availability.replies ? "Matched to a contact" : "Record replies by hand"}
            />
            <Stat
              label="Bounced"
              value={data.messages.bounced.toLocaleString()}
              tone={data.messages.bounced > 0 ? "text-red-600 dark:text-red-400" : undefined}
            />
            <Stat
              label="Unsubscribed"
              value={data.messages.unsubscribed.toLocaleString()}
              hint={`${data.suppressions.total.toLocaleString()} on the suppression list`}
            />
            <Stat
              label="Unique opens"
              value={data.engagement.uniqueOpens.toLocaleString()}
              unavailable={!data.availability.opens}
              hint={
                data.availability.opens
                  ? `${data.engagement.totalOpens.toLocaleString()} total opens · estimated`
                  : "Tracking is off"
              }
            />
            <Stat
              label="Open rate"
              value={data.engagement.openRate === null ? "—" : `${data.engagement.openRate}%`}
              unavailable={!data.availability.opens}
              tone={data.engagement.estimated ? "text-amber-600 dark:text-amber-400" : undefined}
              hint={
                data.availability.opens
                  ? `of ${data.engagement.openRateDenominator} · an estimate, not a certainty`
                  : undefined
              }
            />
            <Stat
              label="Unique clicks"
              value={data.engagement.uniqueClicks.toLocaleString()}
              unavailable={!data.availability.clicks}
            />
            <Stat
              label="Follow-ups scheduled"
              value={data.followUps.scheduled.toLocaleString()}
              hint={`${data.tasks.open} open task${data.tasks.open === 1 ? "" : "s"}`}
            />
          </div>

          {data.availability.opens && (
            <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-800 dark:text-amber-200">
              Open and click data are <strong>estimates</strong>. Apple Mail Privacy Protection,
              image blocking and security scanners trigger tracking automatically — an open is not
              proof that a person read the message.
            </p>
          )}

          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            {/* Upcoming jobs ---------------------------------------------- */}
            <Card
              title="Next to send"
              description="The jobs scheduled next, in recipient-local time."
              actions={
                <Link href="/queue" className="text-sm text-[var(--accent)] hover:underline">
                  Open queue →
                </Link>
              }
            >
              {data.queue.upcoming.length === 0 ? (
                <p className="text-sm text-[var(--muted)]">Nothing is scheduled right now.</p>
              ) : (
                <ul className="divide-y divide-[var(--border)] text-sm">
                  {data.queue.upcoming.map((j) => (
                    <li key={j.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span className="min-w-0 truncate">{j.contact.email}</span>
                      <span className="flex shrink-0 items-center gap-2 text-xs text-[var(--muted)]">
                        {j.kind === "FOLLOW_UP" && <Badge tone="purple">follow-up</Badge>}
                        {new Date(j.scheduledAt).toLocaleString()}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {/* Recent activity --------------------------------------------- */}
            <Card
              title="Recent activity"
              description="What happened to your contacts."
              actions={
                <Link href="/contacts" className="text-sm text-[var(--accent)] hover:underline">
                  All contacts →
                </Link>
              }
            >
              {data.activity.length === 0 ? (
                <p className="text-sm text-[var(--muted)]">No activity yet.</p>
              ) : (
                <ul className="divide-y divide-[var(--border)] text-sm">
                  {data.activity.map((a) => (
                    <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span className="min-w-0 truncate">
                        <span className="text-[var(--muted)]">{a.contact.email}</span> — {a.summary}
                      </span>
                      <span className="shrink-0 text-xs text-[var(--muted)]">
                        {new Date(a.createdAt).toLocaleString()}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {/* Failures --------------------------------------------------- */}
            <Card
              title="Needs attention"
              description="Messages that failed or whose outcome is unknown."
            >
              {data.failures.length === 0 && data.queue.deadLettered === 0 ? (
                <p className="text-sm text-[var(--muted)]">Nothing has failed. </p>
              ) : (
                <ul className="divide-y divide-[var(--border)] text-sm">
                  {data.queue.deadLettered > 0 && (
                    <li className="py-2 text-amber-700 dark:text-amber-200">
                      {data.queue.deadLettered} message
                      {data.queue.deadLettered === 1 ? "" : "s"} in the dead-letter state need a
                      decision.{" "}
                      <Link href="/queue" className="underline">
                        Open the queue
                      </Link>
                      .
                    </li>
                  )}
                  {data.failures.map((f) => (
                    <li key={f.id} className="py-2">
                      <p className="truncate">
                        <span className="text-[var(--muted)]">{f.contact.email}</span> — {f.campaign.name}
                      </p>
                      <p className="text-xs text-red-600 dark:text-red-400">
                        {f.errorCode ?? f.status}: {f.lastError ?? "no detail"}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {/* Senders ---------------------------------------------------- */}
            <Card
              title="Sender accounts"
              description="Capacity used today."
              actions={
                <Link href="/senders" className="text-sm text-[var(--accent)] hover:underline">
                  Manage →
                </Link>
              }
            >
              {data.senders.length === 0 ? (
                <EmptyState
                  title="No sender accounts"
                  description="Connect a Gmail or SMTP account to be able to send."
                />
              ) : (
                <ul className="divide-y divide-[var(--border)] text-sm">
                  {data.senders.map((s) => (
                    <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span className="min-w-0 truncate">{s.email}</span>
                      <span className="flex shrink-0 items-center gap-2">
                        <Badge tone={s.usage && s.usage.sentCount >= s.dailyCap ? "red" : "blue"}>
                          {s.usage?.sentCount ?? 0}/{s.dailyCap}
                        </Badge>
                        <StatusBadge status={s.status} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      ) : null}
    </>
  );
}
