"use client";

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Card,
  ConfirmDialog,
  Field,
  Input,
  Modal,
  Pagination,
  Select,
  Skeleton,
  StatusBadge,
  Table,
  Textarea,
} from "@/components/ui";
import { PageHeader } from "@/components/AppShell";
import { useToast } from "@/components/ui/Toast";
import { api, errorMessage, fieldErrors } from "@/lib/client/api";

type Campaign = {
  id: string;
  name: string;
  subject: string;
  body: string;
  status: "DRAFT" | "ACTIVE" | "PAUSED" | "COMPLETED" | "CANCELLED" | "ARCHIVED";
  emergencyStopped: boolean;
  isArchived: boolean;
  dryRun: boolean;
  requiresApproval: boolean;
  approvedAt: string | null;
  serviceId: string | null;
  followUpSequenceId: string | null;
  windowStartMinute: number;
  windowEndMinute: number;
  sendingDays: number[];
  timeZoneFallback: "HOLD" | "FALLBACK";
  fallbackTimeZone: string | null;
  dailyLimit: number | null;
  fromName: string | null;
  replyTo: string | null;
  templateId: string | null;
};

type CampaignStats = {
  total: number;
  pending: number;
  scheduled: number;
  heldForTimezone: number;
  queued: number;
  sending: number;
  sent: number;
  failed: number;
  skipped: number;
  cancelled: number;
};

type CampaignDetail = { campaign: Campaign; stats: CampaignStats };

type PreviewResponse = {
  preview: {
    to: string;
    toName: string | null;
    subject: string;
    html: string;
    text: string;
    unsubscribeUrl: string;
  };
  personalization: {
    body: { variables: string[]; missing: string[]; partial: string[]; contactsChecked: number };
    subject: { variables: string[]; missing: string[]; partial: string[]; contactsChecked: number };
    problems: string[];
  };
  audienceSize: number;
};

type Recipient = {
  id: string;
  status: string;
  scheduledAt: string | null;
  sentAt: string | null;
  skipReason: string | null;
  lastError: string | null;
  contact: {
    email: string;
    firstName: string | null;
    lastName: string | null;
    company: string | null;
    timeZone: string | null;
    status: string;
  };
};

type RecipientsResponse = {
  total: number;
  page: number;
  pageSize: number;
  items: Recipient[];
};

type RecentJob = {
  id: string;
  status: string;
  attempts: number;
  lastError: string | null;
  errorCode: string | null;
  providerMessageId: string | null;
  updatedAt: string;
  contact: { email: string };
  senderAccount: { email: string } | null;
};

type ActivityResponse = {
  recentJobs: RecentJob[];
  daily: Array<{ date: string; sentCount: number }>;
};

type TestSendResponse =
  | { ok: true; messageId?: string }
  | { ok: false; ambiguous?: boolean; message?: string };

const RECIPIENT_STATUSES = ["PENDING", "SCHEDULED", "HELD_TZ", "QUEUED", "SENDING", "SENT", "FAILED", "SKIPPED", "CANCELLED"];

const WEEKDAYS = [
  { value: 0, label: "Sun" },
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
];

function toMinutes(time: string): number {
  const [h, m] = time.split(":").map((n) => Number(n));
  return (h || 0) * 60 + (m || 0);
}

function fromMinutes(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function StatTile({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <p className="text-xs uppercase tracking-wide text-[var(--muted)]">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${tone ?? ""}`}>{value.toLocaleString()}</p>
    </div>
  );
}

type Tab = "preview" | "recipients" | "schedule" | "settings" | "activity";

export default function CampaignDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();

  const [detail, setDetail] = useState<CampaignDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("preview");

  // Preview tab
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  // Test send
  const [testOpen, setTestOpen] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [testSending, setTestSending] = useState(false);
  const [testMessage, setTestMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [testErr, setTestErr] = useState<Record<string, string>>({});

  // Recipients tab
  const [rStatus, setRStatus] = useState("");
  const [rPage, setRPage] = useState(1);
  const [recipients, setRecipients] = useState<RecipientsResponse | null>(null);
  const [recipientsError, setRecipientsError] = useState<string | null>(null);
  const [emailsText, setEmailsText] = useState("");
  const [adding, setAdding] = useState(false);

  // Schedule tab
  const [schedStart, setSchedStart] = useState("09:00");
  const [schedEnd, setSchedEnd] = useState("17:00");
  const [schedDays, setSchedDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [schedSaving, setSchedSaving] = useState(false);
  const [schedErrs, setSchedErrs] = useState<Record<string, string>>({});

  // Settings tab
  const [settings, setSettings] = useState({
    name: "",
    subject: "",
    body: "",
    fromName: "",
    replyTo: "",
    dailyLimit: "",
    timeZoneFallback: "HOLD" as "HOLD" | "FALLBACK",
    fallbackTimeZone: "",
    serviceId: "",
    followUpSequenceId: "",
    dryRun: false,
    requiresApproval: false,
  });
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsErrs, setSettingsErrs] = useState<Record<string, string>>({});
  const [services, setServices] = useState<Array<{ id: string; name: string }>>([]);
  const [sequences, setSequences] = useState<Array<{ id: string; name: string; isActive: boolean }>>([]);

  // Activity tab
  const [activity, setActivity] = useState<ActivityResponse | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<CampaignDetail>(`/api/campaigns/${id}`)
      .then((d) => {
        setDetail(d);
        setLoadError(null);
        setSchedStart(fromMinutes(d.campaign.windowStartMinute));
        setSchedEnd(fromMinutes(d.campaign.windowEndMinute));
        setSchedDays(d.campaign.sendingDays);
        setSettings({
          name: d.campaign.name,
          subject: d.campaign.subject,
          body: d.campaign.body,
          fromName: d.campaign.fromName ?? "",
          replyTo: d.campaign.replyTo ?? "",
          dailyLimit: d.campaign.dailyLimit ? String(d.campaign.dailyLimit) : "",
          timeZoneFallback: d.campaign.timeZoneFallback,
          fallbackTimeZone: d.campaign.fallbackTimeZone ?? "",
          serviceId: d.campaign.serviceId ?? "",
          followUpSequenceId: d.campaign.followUpSequenceId ?? "",
          dryRun: d.campaign.dryRun,
          requiresApproval: d.campaign.requiresApproval,
        });
      })
      .catch((err) => setLoadError(errorMessage(err)));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api<{ services: Array<{ id: string; name: string }> }>("/api/services")
      .then((d) => setServices(d.services))
      .catch(() => setServices([]));
    api<{ sequences: Array<{ id: string; name: string; isActive: boolean }> }>("/api/follow-ups")
      .then((d) => setSequences(d.sequences))
      .catch(() => setSequences([]));
  }, []);

  const loadRecipients = useCallback(() => {
    const params = new URLSearchParams({ page: String(rPage), pageSize: "20" });
    if (rStatus) params.set("status", rStatus);
    api<RecipientsResponse>(`/api/campaigns/${id}/contacts?${params.toString()}`)
      .then((d) => {
        setRecipients(d);
        setRecipientsError(null);
      })
      .catch((err) => setRecipientsError(errorMessage(err)));
  }, [id, rStatus, rPage]);

  useEffect(() => {
    if (tab === "recipients") loadRecipients();
  }, [tab, loadRecipients]);

  const loadActivity = useCallback(() => {
    api<ActivityResponse>(`/api/campaigns/${id}/stats`)
      .then((d) => {
        setActivity(d);
        setActivityError(null);
      })
      .catch((err) => setActivityError(errorMessage(err)));
  }, [id]);

  useEffect(() => {
    if (tab === "activity") loadActivity();
  }, [tab, loadActivity]);

  const loadPreview = useCallback(() => {
    api<PreviewResponse>(`/api/campaigns/${id}/preview`)
      .then((d) => {
        setPreview(d);
        setPreviewError(null);
      })
      .catch((err) => {
        setPreview(null);
        setPreviewError(errorMessage(err));
      });
  }, [id]);

  useEffect(() => {
    if (tab === "preview") loadPreview();
  }, [tab, loadPreview, detail]);

  const runStatusAction = async (action: "start" | "pause" | "resume" | "approve") => {
    setActionBusy(action);
    try {
      await api(`/api/campaigns/${id}/${action}`, { method: "POST" });
      toast.push(
        "success",
        action === "start"
          ? "Campaign started."
          : action === "pause"
            ? "Campaign paused."
            : action === "approve"
              ? "Campaign approved."
              : "Campaign resumed.",
      );
      load();
    } catch (err) {
      toast.push("error", errorMessage(err));
    } finally {
      setActionBusy(null);
    }
  };

  const confirmCancel = async () => {
    setCancelling(true);
    try {
      await api(`/api/campaigns/${id}`, { method: "DELETE" });
      toast.push("success", "Campaign cancelled. Queued sends were dropped.");
      setCancelOpen(false);
      load();
    } catch (err) {
      toast.push("error", errorMessage(err));
    } finally {
      setCancelling(false);
    }
  };

  const sendTest = async () => {
    setTestSending(true);
    setTestErr({});
    setTestMessage(null);
    try {
      // Raw fetch: failures return a non-enveloped 502 body with the provider message.
      const res = await fetch(`/api/campaigns/${id}/test-send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ to: testTo.trim() }),
      });
      const data = (await res.json().catch(() => null)) as TestSendResponse | { error?: { message?: string } } | null;
      if (res.ok && data && "ok" in data && data.ok) {
        setTestMessage({ kind: "success", text: `Test email sent${data.messageId ? ` (message id ${data.messageId})` : ""}.` });
      } else if (data && "ok" in data && !data.ok) {
        setTestMessage({
          kind: "error",
          text: "ambiguous" in data && data.ambiguous
            ? `Test send outcome is ambiguous: ${data.message ?? "no detail"}`
            : `Test send failed: ${data.message ?? "unknown provider error"}`,
        });
      } else {
        const msg = data && "error" in data ? data.error?.message : undefined;
        setTestMessage({ kind: "error", text: msg ?? `Test send failed (HTTP ${res.status}).` });
      }
    } catch {
      setTestMessage({ kind: "error", text: "Test send failed: network error." });
    } finally {
      setTestSending(false);
    }
  };

  const addRecipients = async () => {
    const emails = emailsText
      .split(/\r?\n/)
      .map((e) => e.trim())
      .filter(Boolean);
    if (emails.length === 0) {
      toast.push("error", "Enter at least one email address.");
      return;
    }
    if (emails.length > 5000) {
      toast.push("error", "Maximum 5000 emails per batch.");
      return;
    }
    setAdding(true);
    try {
      const res = await api<{ added: number; duplicates: number; heldForTimezone: number }>(`/api/campaigns/${id}/contacts`, {
        method: "POST",
        body: JSON.stringify({ emails }),
        idempotencyKey: crypto.randomUUID(),
      });
      toast.push(
        "success",
        `Added ${res.added} · ${res.duplicates} duplicates skipped by database constraint · ${res.heldForTimezone} held for time zone.`,
      );
      setEmailsText("");
      load();
      loadRecipients();
    } catch (err) {
      toast.push("error", errorMessage(err));
    } finally {
      setAdding(false);
    }
  };

  const applySchedule = async () => {
    setSchedSaving(true);
    setSchedErrs({});
    try {
      const res = await api<{ rescheduled: number }>(`/api/campaigns/${id}/schedule`, {
        method: "POST",
        body: JSON.stringify({
          windowStartMinute: toMinutes(schedStart),
          windowEndMinute: toMinutes(schedEnd),
          sendingDays: schedDays,
        }),
      });
      toast.push("success", `${res.rescheduled} pending sends rescheduled.`);
      load();
    } catch (err) {
      setSchedErrs(fieldErrors(err));
      toast.push("error", errorMessage(err));
    } finally {
      setSchedSaving(false);
    }
  };

  const saveSettings = async () => {
    setSettingsSaving(true);
    setSettingsErrs({});
    try {
      const payload: Record<string, unknown> = {
        name: settings.name.trim(),
        subject: settings.subject.trim(),
        body: settings.body,
        timeZoneFallback: settings.timeZoneFallback,
      };
      payload.fromName = settings.fromName.trim() || null;
      payload.replyTo = settings.replyTo.trim() || null;
      payload.dailyLimit = settings.dailyLimit.trim() ? Number(settings.dailyLimit) : null;
      payload.serviceId = settings.serviceId || null;
      payload.followUpSequenceId = settings.followUpSequenceId || null;
      payload.dryRun = settings.dryRun;
      payload.requiresApproval = settings.requiresApproval;
      if (settings.timeZoneFallback === "FALLBACK") payload.fallbackTimeZone = settings.fallbackTimeZone.trim();
      await api(`/api/campaigns/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
      toast.push("success", "Settings saved.");
      load();
    } catch (err) {
      setSettingsErrs(fieldErrors(err));
      toast.push("error", errorMessage(err));
    } finally {
      setSettingsSaving(false);
    }
  };

  if (loadError) {
    return (
      <>
        <PageHeader title="Campaign" />
        <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {loadError}
        </div>
        <div className="mt-4">
          <Button variant="secondary" onClick={() => router.push("/campaigns")}>
            Back to campaigns
          </Button>
        </div>
      </>
    );
  }

  if (!detail) {
    return (
      <>
        <PageHeader title="Campaign" />
        <Skeleton className="mb-4 h-20" />
        <div className="grid gap-4 sm:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      </>
    );
  }

  const { campaign, stats } = detail;
  const editable = ["DRAFT", "ACTIVE", "PAUSED"].includes(campaign.status);
  const tabs: Array<{ key: Tab; label: string }> = [
    { key: "preview", label: "Preview" },
    { key: "recipients", label: "Recipients" },
    { key: "schedule", label: "Schedule" },
    { key: "settings", label: "Settings" },
    { key: "activity", label: "Activity" },
  ];

  return (
    <>
      <PageHeader
        title={campaign.name}
        actions={
          <>
            <span className="mr-1">
              <StatusBadge status={campaign.status} />
            </span>
            {(campaign.status === "DRAFT" || campaign.status === "PAUSED") && (
              <Button loading={actionBusy === "start"} onClick={() => runStatusAction("start")}>
                Start
              </Button>
            )}
            {campaign.status === "ACTIVE" && (
              <Button variant="secondary" loading={actionBusy === "pause"} onClick={() => runStatusAction("pause")}>
                Pause
              </Button>
            )}
            {campaign.status === "PAUSED" && (
              <Button variant="secondary" loading={actionBusy === "resume"} onClick={() => runStatusAction("resume")}>
                Resume
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={() => {
                setTestOpen(true);
                setTestMessage(null);
              }}
            >
              Send test
            </Button>
            {editable && (
              <Button variant="danger" onClick={() => setCancelOpen(true)}>
                Cancel
              </Button>
            )}
          </>
        }
      />

      {campaign.emergencyStopped && (
        <div role="alert" className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
          This campaign was emergency-stopped. Review the queue and sender errors before resuming.
        </div>
      )}

      {campaign.dryRun && (
        <div role="status" className="mb-4 rounded-lg border border-blue-500/40 bg-blue-500/10 px-4 py-3 text-sm text-blue-700 dark:text-blue-300">
          <span className="font-medium">Dry run.</span> Messages are rendered and scheduled normally
          but no email is handed to the provider and no quota is consumed. Turn it off from the
          campaign settings when you are ready to send for real.
        </div>
      )}

      {campaign.requiresApproval && !campaign.approvedAt && (
        <div role="alert" className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
          <span className="font-medium">Waiting for approval.</span> This campaign cannot start
          until it is approved.
          <Button
            variant="secondary"
            className="ml-3"
            loading={actionBusy === "approve"}
            onClick={() => runStatusAction("approve")}
          >
            Approve now
          </Button>
        </div>
      )}

      <div className="mb-6 grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile label="Recipients" value={stats.total} />
        <StatTile label="Sent" value={stats.sent} tone="text-emerald-600 dark:text-emerald-400" />
        <StatTile label="Scheduled" value={stats.scheduled + stats.queued + stats.sending} tone="text-blue-600 dark:text-blue-400" />
        <StatTile label="Held (time zone)" value={stats.heldForTimezone} tone={stats.heldForTimezone > 0 ? "text-amber-600 dark:text-amber-400" : undefined} />
        <StatTile label="Failed" value={stats.failed} tone={stats.failed > 0 ? "text-red-600 dark:text-red-400" : undefined} />
      </div>

      <div className="mb-4 flex gap-1 border-b border-[var(--border)]">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm transition ${
              tab === t.key
                ? "border-[var(--accent)] font-medium text-[var(--accent)]"
                : "border-transparent text-[var(--muted)] hover:text-[var(--text)]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "preview" && (
        <Card
          title="Message preview"
          description="Rendered exactly as the worker will send it, including the unsubscribe link."
        >
          {previewError && (
            <div role="alert" className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
              {previewError}
            </div>
          )}
          {preview ? (
            <>
              {preview.personalization.problems.length > 0 && (
                <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
                  <p className="font-medium">Personalisation gaps</p>
                  <ul className="mt-1 list-disc pl-5">
                    {preview.personalization.problems.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </div>
              )}
              <dl className="mb-4 grid gap-3 sm:grid-cols-2">
                <div>
                  <dt className="text-xs uppercase tracking-wide text-[var(--muted)]">To</dt>
                  <dd className="text-sm">{preview.preview.to}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-[var(--muted)]">Subject</dt>
                  <dd className="text-sm">{preview.preview.subject}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-[var(--muted)]">Audience</dt>
                  <dd className="text-sm">
                    {preview.audienceSize} recipient{preview.audienceSize === 1 ? "" : "s"}
                    {preview.personalization.body.contactsChecked > 0 && (
                      <span className="text-[var(--muted)]">
                        {" "}
                        (checked {preview.personalization.body.contactsChecked})
                      </span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-[var(--muted)]">Unsubscribe</dt>
                  <dd className="truncate text-xs text-[var(--muted)]">{preview.preview.unsubscribeUrl}</dd>
                </div>
              </dl>
              <div className="rounded-lg border border-[var(--border)] bg-white p-4 text-sm text-black">
                <div dangerouslySetInnerHTML={{ __html: preview.preview.html }} />
              </div>
            </>
          ) : (
            <p className="text-sm text-[var(--muted)]">Loading the preview…</p>
          )}
        </Card>
      )}

      {tab === "recipients" && (
        <>
          {stats.heldForTimezone > 0 && (
            <div role="status" className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
              {stats.heldForTimezone} recipient{stats.heldForTimezone === 1 ? " is" : "s are"} held because their time zone is unknown.
              Fix their time zone on the <strong>Contacts</strong> page, or switch this campaign to FALLBACK mode in Settings.
            </div>
          )}

          <Card
            title="Recipients"
            actions={
              <div className="w-48">
                <label htmlFor="r-status" className="sr-only">
                  Filter by status
                </label>
                <Select
                  id="r-status"
                  value={rStatus}
                  onChange={(e) => {
                    setRStatus(e.target.value);
                    setRPage(1);
                  }}
                >
                  <option value="">All statuses</option>
                  {RECIPIENT_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
              </div>
            }
          >
            {recipientsError && (
              <div role="alert" className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
                {recipientsError}
              </div>
            )}
            {!recipients && !recipientsError ? (
              <div className="flex flex-col gap-3">
                {[...Array(5)].map((_, i) => (
                  <Skeleton key={i} className="h-10" />
                ))}
              </div>
            ) : recipients && recipients.items.length === 0 ? (
              <p className="py-8 text-center text-sm text-[var(--muted)]">
                No recipients{rStatus ? ` with status ${rStatus}` : ""} yet. Add them below.
              </p>
            ) : (
              recipients && (
                <>
                  <Table headers={["Email", "Contact", "Time zone", "Status", "Scheduled", "Sent", "Details"]}>
                    {recipients.items.map((r) => (
                      <tr key={r.id} className="text-sm">
                        <td className="px-3 py-2.5 font-medium">{r.contact.email}</td>
                        <td className="px-3 py-2.5">
                          {[r.contact.firstName, r.contact.lastName].filter(Boolean).join(" ") || "—"}
                          {r.contact.company && <span className="ml-1 text-xs text-[var(--muted)]">· {r.contact.company}</span>}
                        </td>
                        <td className="px-3 py-2.5 text-xs text-[var(--muted)]">{r.contact.timeZone ?? "—"}</td>
                        <td className="px-3 py-2.5">
                          <StatusBadge status={r.status} />
                        </td>
                        <td className="px-3 py-2.5 text-xs text-[var(--muted)]">
                          {r.scheduledAt ? new Date(r.scheduledAt).toLocaleString() : "—"}
                        </td>
                        <td className="px-3 py-2.5 text-xs text-[var(--muted)]">
                          {r.sentAt ? new Date(r.sentAt).toLocaleString() : "—"}
                        </td>
                        <td className="max-w-xs truncate px-3 py-2.5 text-xs text-[var(--muted)]" title={r.lastError ?? r.skipReason ?? undefined}>
                          {r.lastError ?? r.skipReason ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </Table>
                  <Pagination page={recipients.page} pageSize={recipients.pageSize} total={recipients.total} onPage={setRPage} />
                </>
              )
            )}
          </Card>

          <div className="mt-4">
            <Card title="Add recipients" description="Paste emails, one per line. Maximum 5000 per batch.">
              <Textarea
                aria-label="Recipient emails"
                value={emailsText}
                onChange={(e) => setEmailsText(e.target.value)}
                rows={6}
                placeholder={"ada@example.com\ngrace@example.com"}
              />
              <div className="mt-3 flex items-center gap-3">
                <Button onClick={addRecipients} loading={adding}>
                  Add recipients
                </Button>
                <p className="text-xs text-[var(--muted)]">
                  Duplicates (already on this campaign or suppressed) are skipped by the database constraint.
                </p>
              </div>
            </Card>
          </div>
        </>
      )}

      {tab === "schedule" && (
        <Card title="Sending window" description="Emails go out only inside each recipient's local window on the selected days.">
          <div className="flex max-w-2xl flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Window start" htmlFor="s-start">
                <Input id="s-start" type="time" value={schedStart} onChange={(e) => setSchedStart(e.target.value)} />
              </Field>
              <Field label="Window end" htmlFor="s-end" error={schedErrs.windowEndMinute}>
                <Input id="s-end" type="time" value={schedEnd} onChange={(e) => setSchedEnd(e.target.value)} />
              </Field>
            </div>
            <fieldset>
              <legend className="mb-1.5 text-sm font-medium">Sending days</legend>
              <div className="flex flex-wrap gap-3">
                {WEEKDAYS.map((d) => (
                  <label key={d.value} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={schedDays.includes(d.value)}
                      onChange={() =>
                        setSchedDays((days) =>
                          days.includes(d.value) ? days.filter((v) => v !== d.value) : [...days, d.value].sort((a, b) => a - b),
                        )
                      }
                      className="h-4 w-4 rounded border-[var(--border)]"
                    />
                    {d.label}
                  </label>
                ))}
              </div>
              {schedErrs.sendingDays && (
                <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
                  {schedErrs.sendingDays}
                </p>
              )}
            </fieldset>
            <div>
              <Button onClick={applySchedule} loading={schedSaving}>
                Apply &amp; reschedule pending
              </Button>
              <p className="mt-2 text-xs text-[var(--muted)]">Recomputes send times for every not-yet-sent recipient.</p>
            </div>
          </div>
        </Card>
      )}

      {tab === "settings" && (
        <Card title="Campaign settings" description="Changing the body affects not-yet-sent jobs only; already-sent copies stay as delivered.">
          <div className="flex max-w-2xl flex-col gap-4">
            <Field label="Name" htmlFor="set-name" error={settingsErrs.name}>
              <Input
                id="set-name"
                value={settings.name}
                invalid={Boolean(settingsErrs.name)}
                onChange={(e) => setSettings((s) => ({ ...s, name: e.target.value }))}
              />
            </Field>
            <Field label="Subject" htmlFor="set-subject" error={settingsErrs.subject}>
              <Input
                id="set-subject"
                value={settings.subject}
                invalid={Boolean(settingsErrs.subject)}
                onChange={(e) => setSettings((s) => ({ ...s, subject: e.target.value }))}
              />
            </Field>
            <Field
              label="Body"
              htmlFor="set-body"
              error={settingsErrs.body}
              hint="{{first_name}}, {{company}}, {{website}}, {{unsubscribe_url}} supported."
            >
              <Textarea
                id="set-body"
                value={settings.body}
                invalid={Boolean(settingsErrs.body)}
                rows={10}
                onChange={(e) => setSettings((s) => ({ ...s, body: e.target.value }))}
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="From name" htmlFor="set-from" error={settingsErrs.fromName}>
                <Input
                  id="set-from"
                  value={settings.fromName}
                  onChange={(e) => setSettings((s) => ({ ...s, fromName: e.target.value }))}
                />
              </Field>
              <Field label="Reply-to" htmlFor="set-reply" error={settingsErrs.replyTo}>
                <Input
                  id="set-reply"
                  type="email"
                  value={settings.replyTo}
                  onChange={(e) => setSettings((s) => ({ ...s, replyTo: e.target.value }))}
                />
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Daily limit" htmlFor="set-limit" error={settingsErrs.dailyLimit} hint="Leave empty for unlimited.">
                <Input
                  id="set-limit"
                  type="number"
                  min={1}
                  value={settings.dailyLimit}
                  onChange={(e) => setSettings((s) => ({ ...s, dailyLimit: e.target.value }))}
                  placeholder="unlimited"
                />
              </Field>
              <Field label="Unknown time zone" htmlFor="set-tzmode">
                <Select
                  id="set-tzmode"
                  value={settings.timeZoneFallback}
                  onChange={(e) => setSettings((s) => ({ ...s, timeZoneFallback: e.target.value as "HOLD" | "FALLBACK" }))}
                >
                  <option value="HOLD">HOLD — hold recipients for review</option>
                  <option value="FALLBACK">FALLBACK — use a fallback time zone</option>
                </Select>
              </Field>
            </div>
            {settings.timeZoneFallback === "FALLBACK" && (
              <Field
                label="Fallback time zone"
                htmlFor="set-fallback-tz"
                error={settingsErrs.fallbackTimeZone}
                hint="IANA name like UTC."
              >
                <Input
                  id="set-fallback-tz"
                  value={settings.fallbackTimeZone}
                  invalid={Boolean(settingsErrs.fallbackTimeZone)}
                  onChange={(e) => setSettings((s) => ({ ...s, fallbackTimeZone: e.target.value }))}
                  placeholder="UTC"
                />
              </Field>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Service" htmlFor="set-service" hint="The business line this campaign promotes.">
                <Select
                  id="set-service"
                  value={settings.serviceId}
                  onChange={(e) => setSettings((s) => ({ ...s, serviceId: e.target.value }))}
                >
                  <option value="">— no service —</option>
                  {services.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="Follow-up sequence"
                htmlFor="set-sequence"
                hint="Scheduled automatically after the first email is delivered."
              >
                <Select
                  id="set-sequence"
                  value={settings.followUpSequenceId}
                  onChange={(e) => setSettings((s) => ({ ...s, followUpSequenceId: e.target.value }))}
                >
                  <option value="">— no follow-ups —</option>
                  {sequences.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <div className="flex flex-col gap-3 rounded-lg border border-[var(--border)] p-3">
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={settings.dryRun}
                  onChange={(e) => setSettings((s) => ({ ...s, dryRun: e.target.checked }))}
                  className="mt-1 h-4 w-4"
                />
                <span>
                  <span className="text-sm font-medium">Dry run</span>
                  <span className="block text-xs text-[var(--muted)]">
                    Render and schedule every message but never hand it to the provider. No email
                    leaves the machine and no quota is consumed.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={settings.requiresApproval}
                  onChange={(e) => setSettings((s) => ({ ...s, requiresApproval: e.target.checked }))}
                  className="mt-1 h-4 w-4"
                />
                <span>
                  <span className="text-sm font-medium">Require approval before sending</span>
                  <span className="block text-xs text-[var(--muted)]">
                    The campaign cannot be started until it is approved. Changing the subject or body
                    clears a previous approval.
                  </span>
                </span>
              </label>
            </div>

            <div>
              <Button onClick={saveSettings} loading={settingsSaving}>
                Save settings
              </Button>
            </div>
          </div>
        </Card>
      )}

      {tab === "activity" && (
        <>
          {activityError && (
            <div role="alert" className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
              {activityError}
            </div>
          )}
          {!activity && !activityError ? (
            <Skeleton className="h-64" />
          ) : activity ? (
            <>
              <Card title="Sends per day">
                {activity.daily.length === 0 ? (
                  <p className="text-sm text-[var(--muted)]">No sends yet.</p>
                ) : (
                  <ul className="flex flex-wrap gap-2 text-sm">
                    {activity.daily.map((d) => (
                      <li key={d.date} className="rounded-lg border border-[var(--border)] px-3 py-1.5">
                        <span className="text-[var(--muted)]">{d.date}</span>{" "}
                        <span className="font-semibold tabular-nums">{d.sentCount}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <div className="mt-4">
                <Card title="Recent jobs" description="Latest delivery attempts for this campaign.">
                  {activity.recentJobs.length === 0 ? (
                    <p className="text-sm text-[var(--muted)]">No jobs yet.</p>
                  ) : (
                    <Table headers={["Contact", "Sender", "Status", "Attempts", "Error", "Updated"]}>
                      {activity.recentJobs.map((j) => (
                        <tr key={j.id} className="text-sm">
                          <td className="px-3 py-2.5">{j.contact.email}</td>
                          <td className="px-3 py-2.5 text-xs text-[var(--muted)]">{j.senderAccount?.email ?? "—"}</td>
                          <td className="px-3 py-2.5">
                            <StatusBadge status={j.status} />
                          </td>
                          <td className="px-3 py-2.5 tabular-nums">{j.attempts}</td>
                          <td
                            className="max-w-xs truncate px-3 py-2.5 text-xs text-red-600 dark:text-red-400"
                            title={j.lastError ?? undefined}
                          >
                            {j.errorCode ? `${j.errorCode}: ${j.lastError ?? ""}` : j.lastError ?? "—"}
                          </td>
                          <td className="px-3 py-2.5 text-xs text-[var(--muted)]">{new Date(j.updatedAt).toLocaleString()}</td>
                        </tr>
                      ))}
                    </Table>
                  )}
                </Card>
              </div>
            </>
          ) : null}
        </>
      )}

      {/* Test send modal */}
      <Modal
        open={testOpen}
        title="Send a test email"
        onClose={() => setTestOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setTestOpen(false)} disabled={testSending}>
              Close
            </Button>
            <Button onClick={sendTest} loading={testSending}>
              Send test
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label="Recipient" htmlFor="test-to" error={testErr.to} hint="Send it to yourself — personalization uses sample data.">
            <Input
              id="test-to"
              type="email"
              value={testTo}
              invalid={Boolean(testErr.to)}
              onChange={(e) => setTestTo(e.target.value)}
              placeholder="you@example.com"
            />
          </Field>
          {testMessage && (
            <div
              role={testMessage.kind === "success" ? "status" : "alert"}
              className={`rounded-lg border px-3 py-2 text-sm ${
                testMessage.kind === "success"
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  : "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300"
              }`}
            >
              {testMessage.text}
            </div>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        open={cancelOpen}
        title="Cancel campaign"
        message="Cancel this campaign? All queued and scheduled sends are cancelled immediately. Emails already delivered cannot be recalled."
        confirmLabel="Cancel campaign"
        loading={cancelling}
        onConfirm={confirmCancel}
        onClose={() => setCancelOpen(false)}
      />
    </>
  );
}
