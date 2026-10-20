"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Modal,
  Pagination,
  Skeleton,
  StatusBadge,
  Table,
  Textarea,
} from "@/components/ui";
import { PageHeader } from "@/components/AppShell";
import { useToast } from "@/components/ui/Toast";
import { api, errorMessage, fieldErrors } from "@/lib/client/api";

type SendAttempt = {
  attemptNumber: number;
  status: string;
  errorMessage: string | null;
  startedAt: string;
};

type Job = {
  id: string;
  status: "QUEUED" | "CLAIMED" | "SENT" | "FAILED" | "SKIPPED" | "CANCELLED" | "AMBIGUOUS";
  attempts: number;
  maxAttempts: number;
  scheduledAt: string;
  lastError: string | null;
  errorCode: string | null;
  providerMessageId: string | null;
  senderAccount: { email: string; provider: string } | null;
  campaign: { id: string; name: string };
  contact: { email: string; timeZone: string | null };
  sendAttempts: SendAttempt[];
};

type JobsResponse = {
  total: number;
  page: number;
  pageSize: number;
  items: Job[];
  depth: Record<string, number>;
  ambiguous: number;
};

type Decision = "sent" | "not_sent" | "drop";

const DECISIONS: Array<{ value: Decision; label: string; hint: string }> = [
  { value: "sent", label: "Sent", hint: "The email exists in the sender's mailbox / was accepted by the provider." },
  { value: "not_sent", label: "Not sent", hint: "It provably never left — the job is re-queued for a retry." },
  { value: "drop", label: "Drop", hint: "Abandon the job; the recipient is marked failed." },
];

export default function QueuePage() {
  const toast = useToast();

  const [data, setData] = useState<JobsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);

  // Resolve modal
  const [resolveTarget, setResolveTarget] = useState<Job | null>(null);
  const [decision, setDecision] = useState<Decision>("sent");
  const [note, setNote] = useState("");
  const [resolving, setResolving] = useState(false);
  const [resolveErrs, setResolveErrs] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: "20" });
    if (status) params.set("status", status);
    api<JobsResponse>(`/api/jobs?${params.toString()}`)
      .then((d) => {
        setData(d);
        setLoadError(null);
      })
      .catch((err) => setLoadError(errorMessage(err)));
  }, [page, status]);

  useEffect(() => {
    load();
  }, [load]);

  const openResolve = (job: Job) => {
    setResolveTarget(job);
    setDecision("sent");
    setNote("");
    setResolveErrs({});
  };

  const submitResolve = async () => {
    if (!resolveTarget) return;
    setResolving(true);
    setResolveErrs({});
    try {
      await api(`/api/jobs/${resolveTarget.id}/resolve`, {
        method: "POST",
        body: JSON.stringify({ decision, note: note.trim() || undefined }),
      });
      toast.push("success", `Job resolved as “${decision.replace("_", " ")}”.`);
      setResolveTarget(null);
      load();
    } catch (err) {
      setResolveErrs(fieldErrors(err));
      toast.push("error", errorMessage(err));
    } finally {
      setResolving(false);
    }
  };

  const depth = data?.depth ?? {};
  const depthEntries = Object.entries(depth).filter(([, count]) => count > 0);
  const items = data?.items ?? [];

  return (
    <>
      <PageHeader title="Send queue" description="Every send job and its delivery state. Click a row to expand attempts." />

      <div role="status" className="mb-4 rounded-lg border border-blue-500/30 bg-blue-500/10 px-4 py-3 text-sm text-blue-700 dark:text-blue-300">
        <strong>AMBIGUOUS</strong> means the outcome is unknown after a timeout (for example the provider accepted the connection but the
        response never arrived). These are never auto-retried — resolve them manually below.
      </div>

      {loadError && (
        <div role="alert" className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {loadError}
        </div>
      )}

      <div className="mb-4 flex flex-wrap gap-2">
        <button
          onClick={() => {
            setStatus("");
            setPage(1);
          }}
          className={`rounded-full border px-3 py-1 text-sm transition ${
            status === "" ? "border-[var(--accent)] bg-[var(--accent)]/10 font-medium text-[var(--accent)]" : "border-[var(--border)] text-[var(--muted)] hover:bg-black/5 dark:hover:bg-white/5"
          }`}
        >
          All ({data ? data.total : "…"})
        </button>
        {depthEntries.map(([s, count]) => (
          <button
            key={s}
            onClick={() => {
              setStatus(s);
              setPage(1);
            }}
            className={`rounded-full border px-3 py-1 text-sm transition ${
              status === s ? "border-[var(--accent)] bg-[var(--accent)]/10 font-medium text-[var(--accent)]" : "border-[var(--border)] text-[var(--muted)] hover:bg-black/5 dark:hover:bg-white/5"
            }`}
          >
            {s.replace(/_/g, " ")} ({count})
          </button>
        ))}
        {data && data.ambiguous > 0 && status !== "AMBIGUOUS" && (
          <Badge tone="amber">{data.ambiguous} ambiguous need resolution</Badge>
        )}
      </div>

      <Card>
        {!data && !loadError ? (
          <div className="flex flex-col gap-3">
            {[...Array(8)].map((_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState title="No jobs" description={status ? `No jobs with status ${status}.` : "The queue is empty — start a campaign to create jobs."} />
        ) : (
          <>
            <Table headers={["Contact", "Campaign", "Sender", "Status", "Attempts", "Scheduled", "Error", ""]}>
              {items.map((job) => (
                <Fragment key={job.id}>
                  <tr
                    className="cursor-pointer text-sm hover:bg-black/5 dark:hover:bg-white/5"
                    onClick={() => setExpanded((e) => (e === job.id ? null : job.id))}
                  >
                    <td className="px-3 py-2.5 font-medium">{job.contact.email}</td>
                    <td className="max-w-40 truncate px-3 py-2.5">{job.campaign.name}</td>
                    <td className="px-3 py-2.5 text-xs text-[var(--muted)]">{job.senderAccount ? `${job.senderAccount.email}` : "—"}</td>
                    <td className="px-3 py-2.5">
                      <StatusBadge status={job.status} />
                    </td>
                    <td className="px-3 py-2.5 tabular-nums">
                      {job.attempts}/{job.maxAttempts}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-[var(--muted)]">{new Date(job.scheduledAt).toLocaleString()}</td>
                    <td
                      className="max-w-xs truncate px-3 py-2.5 text-xs text-red-600 dark:text-red-400"
                      title={job.lastError ?? undefined}
                    >
                      {job.errorCode ? `${job.errorCode}: ${job.lastError ?? ""}` : job.lastError ?? "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                      {job.status === "AMBIGUOUS" && (
                        <Button variant="secondary" onClick={() => openResolve(job)}>
                          Resolve…
                        </Button>
                      )}
                    </td>
                  </tr>
                  {expanded === job.id && (
                    <tr key={`${job.id}-detail`}>
                      <td colSpan={8} className="bg-black/[0.02] px-3 py-3 dark:bg-white/[0.03]">
                        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Send attempts</p>
                        {job.sendAttempts.length === 0 ? (
                          <p className="text-sm text-[var(--muted)]">No attempts recorded yet.</p>
                        ) : (
                          <ul className="space-y-1.5 text-sm">
                            {job.sendAttempts.map((a) => (
                              <li key={a.attemptNumber} className="flex flex-wrap items-center gap-2">
                                <Badge tone="neutral">#{a.attemptNumber}</Badge>
                                <StatusBadge status={a.status} />
                                <span className="text-xs text-[var(--muted)]">{new Date(a.startedAt).toLocaleString()}</span>
                                {a.errorMessage && (
                                  <span className="text-xs text-red-600 dark:text-red-400">{a.errorMessage}</span>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                        {job.providerMessageId && (
                          <p className="mt-2 text-xs text-[var(--muted)]">Provider message id: {job.providerMessageId}</p>
                        )}
                        <p className="mt-2 text-xs text-[var(--muted)]">Time zone: {job.contact.timeZone ?? "unknown"}</p>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </Table>
            {data && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
          </>
        )}
      </Card>

      {/* Resolve modal */}
      <Modal
        open={resolveTarget !== null}
        title={`Resolve ambiguous job — ${resolveTarget?.contact.email ?? ""}`}
        onClose={() => setResolveTarget(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setResolveTarget(null)} disabled={resolving}>
              Cancel
            </Button>
            <Button onClick={submitResolve} loading={resolving}>
              Resolve
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs text-[var(--muted)]">
            Only resolve after confirming with the provider — <strong>sent</strong> if the email exists in the sender&apos;s mailbox,{" "}
            <strong>not_sent</strong> if it provably never left.
          </p>
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium">Decision</legend>
            <div className="flex flex-col gap-2">
              {DECISIONS.map((d) => (
                <label key={d.value} className="flex cursor-pointer items-start gap-2 rounded-lg border border-[var(--border)] px-3 py-2">
                  <input
                    type="radio"
                    name="decision"
                    value={d.value}
                    checked={decision === d.value}
                    onChange={() => setDecision(d.value)}
                    className="mt-0.5 h-4 w-4"
                  />
                  <span>
                    <span className="text-sm font-medium">{d.label}</span>
                    <span className="block text-xs text-[var(--muted)]">{d.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <Field label="Note (optional)" htmlFor="resolve-note" error={resolveErrs.note} hint="Recorded in the audit trail.">
            <Textarea id="resolve-note" value={note} rows={3} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
      </Modal>
    </>
  );
}
