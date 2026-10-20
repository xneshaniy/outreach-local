"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, EmptyState, Skeleton, StatusBadge } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";

/**
 * The client portal dashboard.
 *
 * Everything shown here comes from the campaigns an administrator explicitly
 * assigned to this client. The API enforces that server-side.
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

function Metric({
  label,
  value,
  hint,
  unavailable,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  unavailable?: boolean;
}) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <p className="text-xs uppercase tracking-wide text-[var(--muted)]">{label}</p>
      {unavailable ? (
        <p className="mt-1 text-sm text-[var(--muted)]" title="This metric is not available with the current email provider.">
          Not available
        </p>
      ) : (
        <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      )}
      {hint && <p className="mt-1 text-xs text-[var(--muted)]">{hint}</p>}
    </div>
  );
}

export default function PortalDashboardPage() {
  const router = useRouter();
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState("30");

  const load = useCallback(() => {
    setError(null);
    api<Summary>(`/api/portal/summary?days=${days}`)
      .then(setData)
      .catch((err) => {
        setError(errorMessage(err));
        // A 401 means the client session is gone.
        if (errorMessage(err).toLowerCase().includes("sign in")) {
          router.replace("/portal/login");
        }
      });
  }, [days, router]);

  useEffect(() => {
    load();
  }, [load]);

  const signOut = async () => {
    await fetch("/api/auth/client-logout", { method: "POST", credentials: "same-origin" }).catch(() => undefined);
    router.replace("/portal/login");
  };

  return (
    <>
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {data ? `Hello, ${data.client.name}` : "Client portal"}
          </h1>
          {data?.client.company && (
            <p className="mt-1 text-sm text-[var(--muted)]">{data.client.company}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="portal-days" className="sr-only">
            Reporting period
          </label>
          <select
            id="portal-days"
            value={days}
            onChange={(e) => setDays(e.target.value)}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm"
          >
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="365">Last 12 months</option>
          </select>
          <Button variant="secondary" onClick={signOut}>
            Sign out
          </Button>
        </div>
      </header>

      {error && (
        <div role="alert" className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {!data && !error ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[...Array(8)].map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : data ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Recipients" value={data.totals.recipients.toLocaleString()} />
            <Metric
              label="Sent (accepted)"
              value={data.totals.sent.toLocaleString()}
              hint="Confirmed accepted by the email provider"
            />
            <Metric
              label="Delivered"
              value={data.totals.delivered.toLocaleString()}
              unavailable={!data.availability.delivered}
              hint={
                data.availability.delivered
                  ? "Confirmed by the provider"
                  : "The provider does not report delivery"
              }
            />
            <Metric
              label="Unique opens"
              value={data.totals.uniqueOpens.toLocaleString()}
              unavailable={!data.availability.opens}
              hint={data.availability.opens ? `${data.totals.totalOpens} total opens` : "Tracking is off"}
            />
            <Metric
              label="Open rate"
              value={data.totals.openRate === null ? "—" : `${data.totals.openRate}%`}
              unavailable={!data.availability.opens}
              hint={
                data.availability.opens
                  ? `of ${data.totals.rateDenominator} (${data.totals.rateDenominator})`
                  : undefined
              }
            />
            <Metric
              label="Unique clicks"
              value={data.totals.uniqueClicks.toLocaleString()}
              unavailable={!data.availability.clicks}
              hint={data.availability.clicks ? `${data.totals.totalClicks} total clicks` : "Tracking is off"}
            />
            <Metric
              label="Click rate"
              value={data.totals.clickRate === null ? "—" : `${data.totals.clickRate}%`}
              unavailable={!data.availability.clicks}
              hint={data.availability.clicks ? `of ${data.totals.rateDenominator}` : undefined}
            />
            <Metric label="Replies" value={data.totals.replies.toLocaleString()} />
            <Metric
              label="Reply rate"
              value={data.totals.replyRate === null ? "—" : `${data.totals.replyRate}%`}
              hint="of sent"
            />
            <Metric label="Bounced" value={data.totals.bounced.toLocaleString()} />
            <Metric label="Failed" value={data.totals.failed.toLocaleString()} />
            <Metric label="Unsubscribed" value={data.totals.unsubscribed.toLocaleString()} />
            <Metric label="Still to send" value={data.totals.pending.toLocaleString()} />
          </div>

          {data.availability.opens && (
            <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
              <strong>Open data is approximate.</strong> Apple Mail Privacy Protection, image
              blocking and security scanners load tracking automatically, so an open is not proof that
              a person read the message.
            </div>
          )}

          <div className="mt-6">
            <Card
              title="Your campaigns"
              description={`${data.campaigns} campaign${data.campaigns === 1 ? "" : "s"} assigned to you`}
              actions={
                <a
                  href="/api/portal/reports/export"
                  className="text-sm text-[var(--accent)] hover:underline"
                >
                  Export CSV →
                </a>
              }
            >
              <PortalCampaigns />
            </Card>
          </div>
        </>
      ) : null}
    </>
  );
}

function PortalCampaigns() {
  const [items, setItems] = useState<
    Array<{
      id: string;
      name: string;
      status: string;
      sent: number;
      uniqueOpens: number;
      openRate: number | null;
      replies: number;
      replyRate: number | null;
      trackingEnabled: boolean;
    }>
  >([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ campaigns: typeof items }>("/api/portal/campaigns?days=30")
      .then((d) => setItems(d.campaigns))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Skeleton className="h-24" />;
  if (items.length === 0) {
    return (
      <EmptyState
        title="No campaigns yet"
        description="Your account manager has not assigned any campaigns to you yet."
      />
    );
  }

  return (
    <ul className="divide-y divide-[var(--border)]">
      {items.map((c) => (
        <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div className="min-w-0">
            <Link
              href={`/portal/campaigns/${c.id}`}
              className="font-medium hover:underline"
            >
              {c.name}
            </Link>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <StatusBadge status={c.status} />
              {c.trackingEnabled ? <Badge tone="blue">open tracking</Badge> : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <span className="text-[var(--muted)]">
              sent <strong className="text-[var(--text)]">{c.sent}</strong>
            </span>
            <span className="text-[var(--muted)]">
              opened{" "}
              <strong className="text-[var(--text)]">
                {c.trackingEnabled ? c.uniqueOpens : "n/a"}
              </strong>
              {c.trackingEnabled && c.openRate !== null && (
                <span className="ml-1">({c.openRate}%)</span>
              )}
            </span>
            <span className="text-[var(--muted)]">
              replied <strong className="text-[var(--text)]">{c.replies}</strong>
              {c.replyRate !== null && <span className="ml-1">({c.replyRate}%)</span>}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}
