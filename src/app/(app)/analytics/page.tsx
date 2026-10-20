"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Card, Select, Skeleton, StatusBadge, Table } from "@/components/ui";
import { PageHeader } from "@/components/AppShell";
import { api, errorMessage } from "@/lib/client/api";

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

const DAY_OPTIONS = [7, 30, 90];

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
      <p className="text-xs uppercase tracking-wide text-[var(--muted)]">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs text-[var(--muted)]">{hint}</p>}
    </div>
  );
}

function labelize(key: string): string {
  return key.toLowerCase().replace(/_/g, " ");
}

export default function AnalyticsPage() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Analytics | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<Analytics>(`/api/analytics?days=${days}`)
      .then((d) => {
        setData(d);
        setLoadError(null);
      })
      .catch((err) => setLoadError(errorMessage(err)));
  }, [days]);

  useEffect(() => {
    load();
  }, [load]);

  const totals = data?.totals;

  return (
    <>
      <PageHeader
        title="Analytics"
        description="Delivery outcomes, per-campaign progress, and sender usage."
        actions={
          <div className="w-40">
            <label htmlFor="days" className="sr-only">
              Time window
            </label>
            <Select id="days" value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
              {DAY_OPTIONS.map((d) => (
                <option key={d} value={d}>
                  Last {d} days
                </option>
              ))}
            </Select>
          </div>
        }
      />

      {loadError && (
        <div role="alert" className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {loadError}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {!data ? (
          [...Array(4)].map((_, i) => <Skeleton key={i} className="h-24" />)
        ) : (
          <>
            <Stat label={`Sent (${days}d)`} value={totals?.sent ?? 0} hint="Accepted by the provider" />
            {Object.entries(totals?.attemptsByOutcome ?? {}).slice(0, 3).map(([k, v]) => (
              <Stat key={k} label={labelize(k)} value={v} hint="Delivery attempts" />
            ))}
          </>
        )}
      </div>

      {totals && Object.keys(totals.suppressionsByReason).length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          <span className="self-center text-xs uppercase tracking-wide text-[var(--muted)]">Suppressions:</span>
          {Object.entries(totals.suppressionsByReason).map(([reason, count]) => (
            <Badge key={reason} tone="neutral">
              {labelize(reason)}: {count}
            </Badge>
          ))}
        </div>
      )}

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card title="Campaigns" description="Sent vs. total recipients with the full status breakdown.">
          {!data ? (
            <Skeleton className="h-40" />
          ) : data.campaigns.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">No campaigns yet.</p>
          ) : (
            <Table headers={["Campaign", "Status", "Progress", "Breakdown"]}>
              {data.campaigns.map((c) => {
                const pct = c.total > 0 ? Math.round(((c.byStatus.SENT ?? 0) / c.total) * 100) : 0;
                return (
                  <tr key={c.id} className="text-sm">
                    <td className="max-w-40 truncate px-3 py-2.5 font-medium">{c.name}</td>
                    <td className="px-3 py-2.5">
                      <StatusBadge status={c.status} />
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-24 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
                          <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="tabular-nums text-xs text-[var(--muted)]">
                          {c.byStatus.SENT ?? 0}/{c.total}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-[var(--muted)]">
                      {Object.entries(c.byStatus)
                        .map(([s, n]) => `${labelize(s)} ${n}`)
                        .join(" · ")}
                    </td>
                  </tr>
                );
              })}
            </Table>
          )}
        </Card>

        <Card title="Sender usage today" description="Sent + reserved against each account's daily cap.">
          {!data ? (
            <Skeleton className="h-40" />
          ) : data.todayUsage.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">No sender accounts yet.</p>
          ) : (
            <ul className="flex flex-col gap-4">
              {data.todayUsage.map((u) => {
                const cap = Math.max(1, u.senderAccount.dailyCap);
                const pct = Math.min(100, Math.round(((u.sentCount + u.reservedCount) / cap) * 100));
                return (
                  <li key={u.senderAccount.email}>
                    <div className="mb-1 flex items-center justify-between gap-2 text-sm">
                      <span className="truncate">{u.senderAccount.email}</span>
                      <span className="flex items-center gap-2">
                        <span className="tabular-nums text-xs text-[var(--muted)]">
                          {u.sentCount} sent · {u.reservedCount} reserved / {u.senderAccount.dailyCap}
                        </span>
                        <StatusBadge status={u.senderAccount.status} />
                      </span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
                      <div
                        className={`h-full rounded-full ${pct >= 100 ? "bg-red-500" : "bg-[var(--accent)]"}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      <div className="mt-6">
        <Card title="Recent failures" description="Latest failed delivery attempts across all campaigns.">
          {!data ? (
            <Skeleton className="h-40" />
          ) : data.recentFailures.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">No recent failures. 🎉</p>
          ) : (
            <Table headers={["Contact", "Campaign", "Status", "Attempts", "Error", "Updated"]}>
              {data.recentFailures.map((f) => (
                <tr key={f.id} className="text-sm">
                  <td className="px-3 py-2.5">{f.contact.email}</td>
                  <td className="max-w-40 truncate px-3 py-2.5">{f.campaign.name}</td>
                  <td className="px-3 py-2.5">
                    <StatusBadge status={f.status} />
                  </td>
                  <td className="px-3 py-2.5 tabular-nums">{f.attempts}</td>
                  <td className="max-w-xs truncate px-3 py-2.5 text-xs text-red-600 dark:text-red-400" title={f.lastError ?? undefined}>
                    {f.errorCode ? `${f.errorCode}: ${f.lastError ?? ""}` : f.lastError ?? "—"}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-[var(--muted)]">{new Date(f.updatedAt).toLocaleString()}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
