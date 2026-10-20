"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Badge, Card, Skeleton, StatusBadge } from "@/components/ui";
import { PageHeader } from "@/components/AppShell";
import { api } from "@/lib/client/api";

type Me = {
  user: { name: string | null; email: string };
  counts: { senders: number; campaigns: number; contacts: number };
};
type JobsResponse = { depth: Record<string, number>; ambiguous: number };
type Analytics = {
  totals: { sent: number; attemptsByOutcome: Record<string, number> };
  todayUsage: Array<{ sentCount: number; reservedCount: number; senderAccount: { email: string; dailyCap: number; status: string } }>;
};
type RepliesResponse = { total: number; unread: number };
type FollowUpStats = { scheduled: number; failed: number };

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
      <p className="text-xs uppercase tracking-wide text-[var(--muted)]">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      {hint && <p className="mt-1 text-xs text-[var(--muted)]">{hint}</p>}
    </div>
  );
}

export default function DashboardPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [jobs, setJobs] = useState<JobsResponse | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [replies, setReplies] = useState<RepliesResponse | null>(null);
  const [followUpStats, setFollowUpStats] = useState<FollowUpStats>({ scheduled: 0, failed: 0 });

  useEffect(() => {
    Promise.all([
      api<Me>("/api/auth/me"),
      api<JobsResponse>("/api/jobs?pageSize=1"),
      api<Analytics>("/api/analytics?days=7"),
      api<RepliesResponse>("/api/replies?pageSize=1"),
      api<{ sequences: Array<{ _count?: { messages: number } }> }>("/api/follow-ups"),
    ])
      .then(([m, j, a, r, f]) => {
        setMe(m);
        setJobs(j);
        setAnalytics(a);
        setReplies(r);
        const scheduled = f.sequences.reduce((sum, s) => sum + (s._count?.messages ?? 0), 0);
        setFollowUpStats({ scheduled, failed: 0 });
      })
      .catch(() => undefined);
  }, []);

  if (!me) {
    return (
      <>
        <PageHeader title="Dashboard" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      </>
    );
  }

  const depth = jobs?.depth ?? {};
  const queued = (depth.QUEUED ?? 0) + (depth.CLAIMED ?? 0);

  return (
    <>
      <PageHeader
        title={`Welcome${me.user.name ? `, ${me.user.name}` : ""}`}
        description="Overview of your outreach workspace."
        actions={
          <Link
            href="/campaigns/new"
            className="rounded-lg bg-[var(--accent)] px-3.5 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            New campaign
          </Link>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Sender accounts" value={`${me.counts.senders}`} hint="Connected inboxes" />
        <Stat label="Contacts" value={me.counts.contacts.toLocaleString()} hint="Unique people" />
        <Stat label="Campaigns" value={me.counts.campaigns} hint="All statuses" />
        <Stat label="Queue depth" value={queued} hint={`${jobs?.ambiguous ?? 0} awaiting reconciliation`} />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card title="Sends (last 7 days)" description="Delivered vs. attempts.">
          {analytics ? (
            <div className="flex items-end gap-6">
              <div>
                <p className="text-3xl font-semibold text-emerald-600 dark:text-emerald-400">{analytics.totals.sent}</p>
                <p className="text-xs text-[var(--muted)]">sent</p>
              </div>
              {Object.entries(analytics.totals.attemptsByOutcome).map(([k, v]) => (
                <div key={k}>
                  <p className="text-xl font-semibold">{v}</p>
                  <p className="text-xs text-[var(--muted)]">{k.toLowerCase().replace(/_/g, " ")}</p>
                </div>
              ))}
            </div>
          ) : (
            <Skeleton className="h-16" />
          )}
        </Card>

        <Card
          title="Replies & follow-ups"
          description="People who answered, and the follow-ups still scheduled."
          actions={
            <Link href="/replies" className="text-sm text-[var(--accent)] hover:underline">
              Open inbox &rarr;
            </Link>
          }
        >
          {replies ? (
            <div className="flex items-end gap-6">
              <div>
                <p className="text-3xl font-semibold text-emerald-600 dark:text-emerald-400">
                  {replies.unread}
                </p>
                <p className="text-xs text-[var(--muted)]">unread replies</p>
              </div>
              <div>
                <p className="text-xl font-semibold">{replies.total}</p>
                <p className="text-xs text-[var(--muted)]">replies in total</p>
              </div>
              <div>
                <p className="text-xl font-semibold">{followUpStats.scheduled}</p>
                <p className="text-xs text-[var(--muted)]">follow-ups scheduled</p>
              </div>
              {followUpStats.failed > 0 && (
                <div>
                  <p className="text-xl font-semibold text-red-600 dark:text-red-400">
                    {followUpStats.failed}
                  </p>
                  <p className="text-xs text-[var(--muted)]">follow-ups failed</p>
                </div>
              )}
            </div>
          ) : (
            <Skeleton className="h-16" />
          )}
        </Card>

        <Card
          title="Sender usage today"
          description="Per-account quota consumption."
          actions={
            <Link href="/senders" className="text-sm text-[var(--accent)] hover:underline">
              Manage →
            </Link>
          }
        >
          {analytics ? (
            analytics.todayUsage.length === 0 ? (
              <p className="text-sm text-[var(--muted)]">No sender accounts yet.</p>
            ) : (
              <ul className="flex flex-col gap-2 text-sm">
                {analytics.todayUsage.map((u) => (
                  <li key={u.senderAccount.email} className="flex items-center justify-between gap-2">
                    <span className="truncate">{u.senderAccount.email}</span>
                    <span className="flex items-center gap-2">
                      <Badge tone={u.sentCount >= u.senderAccount.dailyCap ? "red" : "blue"}>
                        {u.sentCount}/{u.senderAccount.dailyCap}
                      </Badge>
                      <StatusBadge status={u.senderAccount.status} />
                    </span>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <Skeleton className="h-16" />
          )}
        </Card>
      </div>

      <div className="mt-6">
        <Card title="Quick start">
          <ol className="list-decimal space-y-1.5 pl-5 text-sm text-[var(--muted)]">
            <li>
              <Link href="/senders" className="text-[var(--accent)] hover:underline">Connect a sender account</Link> via Google OAuth or SMTP (max 10, 100 sends/day each by default).
            </li>
            <li>
              <Link href="/contacts" className="text-[var(--accent)] hover:underline">Import contacts</Link> with the CSV wizard (duplicates are blocked by the database).
            </li>
            <li>
              <Link href="/campaigns/new" className="text-[var(--accent)] hover:underline">Create a campaign</Link>, set the recipient-local sending window, then start it.
            </li>
            <li>
              <Link href="/queue" className="text-[var(--accent)] hover:underline">Watch the send queue</Link> — the worker sends only inside each recipient&apos;s 09:00–17:00 local window.
            </li>
          </ol>
        </Card>
      </div>
    </>
  );
}
