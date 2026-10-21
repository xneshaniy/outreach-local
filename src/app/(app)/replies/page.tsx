"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/AppShell";
import { Badge, Button, Card, EmptyState, Input } from "@/components/ui";
import { useToast } from "@/components/ui/Toast";
import { api, errorMessage } from "@/lib/client/api";

/**
 * Replies inbox.
 *
 * Replies are matched to a contact (by the sender address) and to a campaign
 * (by the most recent message we sent to that contact). A reply stops the
 * follow-up sequence for that contact automatically.
 *
 * Gmail accounts can be polled directly from this page ("Check for new
 * replies"). SMTP accounts cannot be polled — their replies must be recorded
 * by hand, and the page says so plainly rather than pretending otherwise.
 */

type Reply = {
  id: string;
  fromEmail: string;
  toEmail: string;
  subject: string | null;
  snippet: string | null;
  body: string | null;
  receivedAt: string;
  isRead: boolean;
  outcome: string | null;
  contact: { id: string; email: string; firstName: string | null; lastName: string | null; company: string | null; status: string } | null;
  campaign: { id: string; name: string } | null;
};

type RepliesResponse = {
  total: number;
  unread: number;
  items: Reply[];
  polled?: Array<{ accountId: string; checked: number; imported: number; error?: string }>;
  pollSupported?: boolean;
};

const OUTCOME_TONE: Record<string, "green" | "red" | "amber" | "neutral"> = {
  INTERESTED: "green",
  NOT_INTERESTED: "red",
  NEEDS_INFO: "amber",
  OTHER: "neutral",
};

export default function RepliesPage() {
  const toast = useToast();
  const [data, setData] = useState<RepliesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ pageSize: "50" });
      if (search) params.set("search", search);
      if (unreadOnly) params.set("unread", "true");
      const res = await api<RepliesResponse>(`/api/replies?${params.toString()}`);
      setData(res);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [search, unreadOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  const poll = async () => {
    setPolling(true);
    try {
      const res = await api<RepliesResponse>("/api/replies?poll=true&pageSize=50");
      setData(res);
      const imported = (res.polled ?? []).reduce((sum, p) => sum + p.imported, 0);
      const failed = (res.polled ?? []).filter((p) => p.error);
      if (failed.length > 0) {
        toast.push("error", `Polling failed for ${failed.length} account(s): ${failed[0]!.error}`);
      } else {
        toast.push("success", imported > 0 ? `${imported} new repl${imported === 1 ? "y" : "ies"}.` : "Inbox checked — no new replies.");
      }
    } catch (e) {
      toast.push("error", errorMessage(e));
    } finally {
      setPolling(false);
    }
  };

  const update = async (id: string, patch: Record<string, unknown>) => {
    try {
      await api(`/api/replies/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
      await load();
    } catch (e) {
      toast.push("error", errorMessage(e));
    }
  };

  return (
    <>
      <PageHeader
        eyebrow={
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--muted)]">
            {data?.unread ?? 0} unread
          </span>
        }
        title="Replies"
        description="Incoming replies matched to your contacts and campaigns. A reply stops the follow-up sequence."
        actions={
          <Button onClick={poll} loading={polling}>
            Check for new replies
          </Button>
        }
      />

      {error && (
        <div role="alert" className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm">
          {error}
        </div>
      )}

      {data && !data.pollSupported && (
        <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
          No connected Gmail account, so the inbox cannot be polled automatically. Connect a Gmail
          sender account to detect replies, or record them by hand from your mail client.
        </div>
      )}

      <Card
        title="Inbox"
        description={data ? `${data.total} replies · ${data.unread} unread` : undefined}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="reply-search">
              Search replies
            </label>
            <Input
              id="reply-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search subject or sender"
              className="w-56"
            />
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={unreadOnly}
                onChange={(e) => setUnreadOnly(e.target.checked)}
                className="h-4 w-4"
              />
              Unread only
            </label>
          </div>
        }
      >
        {loading ? (
          <p className="text-sm text-[var(--muted)]">Loading replies…</p>
        ) : !data || data.items.length === 0 ? (
          <EmptyState
            title="No replies yet"
            description="When a contact answers an outreach email it appears here, matched to their contact record and the campaign it belongs to."
          />
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {data.items.map((r) => {
              const isOpen = expanded === r.id;
              return (
                <li key={r.id} className="py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className={`truncate text-sm ${r.isRead ? "font-normal" : "font-semibold"}`}>
                        {r.subject || "(no subject)"}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-[var(--muted)]">
                        from {r.fromEmail} · {new Date(r.receivedAt).toLocaleString()}
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {r.contact ? (
                          <Badge tone="blue">{r.contact.email}</Badge>
                        ) : (
                          <Badge tone="neutral">No matching contact</Badge>
                        )}
                        {r.campaign && <Badge tone="purple">{r.campaign.name}</Badge>}
                        {r.outcome && <Badge tone={OUTCOME_TONE[r.outcome] ?? "neutral"}>{r.outcome.replace("_", " ")}</Badge>}
                        {!r.isRead && <Badge tone="amber">New</Badge>}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button variant="secondary" onClick={() => setExpanded(isOpen ? null : r.id)}>
                        {isOpen ? "Hide" : "Open"}
                      </Button>
                      {!r.isRead && (
                        <Button variant="ghost" onClick={() => update(r.id, { isRead: true })}>
                          Mark read
                        </Button>
                      )}
                      <select
                        aria-label="Classify reply"
                        value={r.outcome ?? ""}
                        onChange={(e) => update(r.id, { outcome: e.target.value || null })}
                        className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs"
                      >
                        <option value="">Not classified</option>
                        <option value="INTERESTED">Interested</option>
                        <option value="NOT_INTERESTED">Not interested</option>
                        <option value="NEEDS_INFO">Needs info</option>
                        <option value="OTHER">Other</option>
                      </select>
                    </div>
                  </div>
                  {isOpen && (
                    <div className="mt-3 rounded-lg border border-[var(--border)] bg-black/[0.02] p-3 dark:bg-white/[0.03]">
                      <pre className="whitespace-pre-wrap break-words font-sans text-sm">
                        {r.body || r.snippet || "(no message body was captured)"}
                      </pre>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}
