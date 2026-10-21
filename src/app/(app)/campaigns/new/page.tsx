"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Note,
  Select,
  Skeleton,
  Textarea,
} from "@/components/ui";
import { PageHeader } from "@/components/AppShell";
import { useToast } from "@/components/ui/Toast";
import { api, errorMessage, fieldErrors } from "@/lib/client/api";

/**
 * The guided campaign builder.
 *
 * Eight steps, each with a single job, and the campaign is only created on
 * the last one — so a half-finished campaign never exists and a saved form
 * never silently becomes an active campaign.
 */

type Template = {
  id: string;
  name: string;
  subject: string;
  body: string;
  category?: string;
  plainTextBody?: string | null;
  signature?: string | null;
};
type Service = {
  id: string;
  name: string;
  color: string;
  description: string | null;
  defaultSubject: string | null;
  defaultBody: string | null;
  defaultCta: string | null;
};
type Sequence = { id: string; name: string; isActive: boolean; steps: Array<{ order: number; delayDays: number }> };
type Segment = { id: string; name: string; description: string | null; _count?: { campaigns: number } };
type Sender = { id: string; email: string; provider: string; status: string; dailyCap: number };
type Contact = { id: string; email: string; firstName: string | null; lastName: string | null; company: string | null };

const STEPS = [
  { key: "audience", label: "Audience" },
  { key: "message", label: "Message" },
  { key: "sender", label: "Sender" },
  { key: "preview", label: "Preview" },
  { key: "recipients", label: "Recipients" },
  { key: "schedule", label: "Schedule" },
  { key: "validate", label: "Validate" },
  { key: "launch", label: "Launch" },
] as const;

type StepKey = (typeof STEPS)[number]["key"];

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

export default function NewCampaignPage() {
  const router = useRouter();
  const toast = useToast();

  const [templates, setTemplates] = useState<Template[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [senders, setSenders] = useState<Sender[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);

  const [step, setStep] = useState<StepKey>("audience");
  const [stepIndex, setStepIndex] = useState(0);

  // Form state
  const [name, setName] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [segmentId, setSegmentId] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [fromName, setFromName] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("17:00");
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [tzMode, setTzMode] = useState<"HOLD" | "FALLBACK">("HOLD");
  const [fallbackTimeZone, setFallbackTimeZone] = useState("");
  const [dailyLimit, setDailyLimit] = useState("");
  const [sequenceId, setSequenceId] = useState("");
  const [dryRun, setDryRun] = useState(true);
  const [requiresApproval, setRequiresApproval] = useState(false);

  const [errs, setErrs] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<{
    preview: { to: string; subject: string; html: string; text: string } | null;
    personalization: { problems: string[] };
    reason?: string;
  } | null>(null);
  const previewProblems = preview?.personalization?.problems ?? [];
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    Promise.all([
      api<{ templates: Template[] }>("/api/templates"),
      api<{ services: Service[] }>("/api/services?seedIfEmpty=true"),
      api<{ sequences: Sequence[] }>("/api/follow-ups"),
      api<{ segments: Segment[] }>("/api/segments"),
      api<{ accounts: Sender[] }>("/api/senders"),
      api<{ items: Contact[] }>("/api/contacts?pageSize=100"),
    ])
      .then(([t, s, q, seg, sd, c]) => {
        setTemplates(t.templates);
        setServices(s.services);
        setSequences(q.sequences);
        setSegments(seg.segments);
        setSenders(sd.accounts ?? []);
        setContacts(c.items ?? []);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  const applyService = useCallback(
    (id: string) => {
      setServiceId(id);
      const svc = services.find((s) => s.id === id);
      if (!svc) return;
      if (svc.defaultSubject) setSubject(svc.defaultSubject);
      if (svc.defaultBody) setBody(svc.defaultBody);
      if (svc.defaultCta && svc.defaultBody && !svc.defaultBody.includes("{{cta}}")) {
        setBody((b) => b.replace("{{cta}}", svc.defaultCta!));
      }
      if (!name) setName(svc.name);
    },
    [services, name],
  );

  const applyTemplate = useCallback((id: string) => {
    setTemplateId(id);
    const tpl = templates.find((t) => t.id === id);
    if (!tpl) return;
    setSubject(tpl.subject);
    setBody(tpl.body);
    if (tpl.signature) setBody((b) => (b.includes(tpl.signature!) ? b : `${b}\n\n${tpl.signature}`));
  }, [templates]);

  const runPreview = useCallback(async () => {
    setPreviewing(true);
    try {
      const res = await api<typeof preview>("/api/campaigns/preview", {
        method: "POST",
        body: JSON.stringify({ subject, body }),
      });
      setPreview(res);
    } catch (e) {
      toast.push("error", errorMessage(e));
    } finally {
      setPreviewing(false);
    }
  }, [subject, body, toast]);

  useEffect(() => {
    if (step === "preview") void runPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const toggleDay = (value: number) => {
    setDays((d) => (d.includes(value) ? d.filter((v) => v !== value) : [...d, value].sort((a, b) => a - b)));
  };

  // The validation checklist — shared by the progress indicator and the
  // validation step, so a step can never claim to be done while a check fails.
  const checks = useMemo(
    () => [
      { ok: Boolean(name.trim()), label: "Campaign has a name", fix: "Add a name in step 1." },
      {
        ok: Boolean(serviceId),
        label: "A service is selected",
        fix: "Pick the business line this promotes.",
      },
      {
        ok: Boolean(subject.trim()) && Boolean(body.trim()),
        label: "Subject and body are filled in",
        fix: "Both are required.",
      },
      {
        ok: body.includes("{{unsubscribe_url}}") || /unsubscribe/i.test(body),
        label: "The message has an unsubscribe link",
        fix: "Add {{unsubscribe_url}} — it is legally required.",
      },
      {
        ok: senders.length > 0,
        label: "A sender account is connected",
        fix: "Connect Gmail or SMTP before sending.",
      },
      {
        ok: days.length > 0 && endTime > startTime,
        label: "The sending window is valid",
        fix: "The window must close after it opens.",
      },
    ],
    [name, serviceId, subject, body, senders.length, days, startTime, endTime],
  );

  // Which steps are complete — used for the progress indicator.
  const stepComplete = useMemo(
    () => ({
      audience: Boolean(name.trim()) && Boolean(serviceId),
      message: Boolean(subject.trim()) && Boolean(body.trim()),
      sender: Boolean(fromName.trim()) || senders.length > 0,
      preview: Boolean(preview?.preview),
      recipients: contacts.length > 0 || Boolean(segmentId),
      schedule: days.length > 0 && endTime > startTime,
      validate: checks.every((c) => c.ok),
      launch: false,
    }),
    [
      name,
      serviceId,
      subject,
      body,
      fromName,
      senders.length,
      preview,
      contacts.length,
      segmentId,
      days,
      startTime,
      endTime,
      checks,
    ],
  );

  const go = (index: number) => {
    const next = STEPS[index];
    if (!next) return;
    setStep(next.key);
    setStepIndex(index);
  };

  const next = () => go(Math.min(STEPS.length - 1, stepIndex + 1));
  const back = () => go(Math.max(0, stepIndex - 1));

  const submit = async () => {
    setSaving(true);
    setErrs({});
    setSubmitError(null);
    try {
      const payload: Record<string, unknown> = {
        name: name.trim(),
        subject: subject.trim(),
        body,
        windowStartMinute: toMinutes(startTime),
        windowEndMinute: toMinutes(endTime),
        sendingDays: days,
        timeZoneFallback: tzMode,
        dryRun,
        requiresApproval,
      };
      if (templateId) payload.templateId = templateId;
      if (serviceId) payload.serviceId = serviceId;
      if (segmentId) payload.segmentId = segmentId;
      if (sequenceId) payload.followUpSequenceId = sequenceId;
      if (fromName.trim()) payload.fromName = fromName.trim();
      if (replyTo.trim()) payload.replyTo = replyTo.trim();
      if (tzMode === "FALLBACK") payload.fallbackTimeZone = fallbackTimeZone.trim();
      if (dailyLimit.trim()) payload.dailyLimit = Number(dailyLimit);

      const res = await api<{ campaign: { id: string } }>("/api/campaigns", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      toast.push("success", "Campaign created as a draft.");
      router.push(`/campaigns/${res.campaign.id}`);
    } catch (err) {
      setErrs(fieldErrors(err));
      setSubmitError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <>
        <PageHeader title="New campaign" />
        <Card>
          <div className="flex flex-col gap-3">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="New campaign"
        description="Eight short steps. Nothing is created until you launch, and a new campaign never sends anything until you start it."
        actions={
          <Button variant="outline" onClick={() => router.push("/campaigns")} disabled={saving}>
            Cancel
          </Button>
        }
      />

      {/* Step indicator ------------------------------------------------- */}
      <nav aria-label="Campaign steps" className="mb-6">
        <ol className="flex flex-wrap items-center gap-1.5">
          {STEPS.map((s, i) => {
            const complete = stepComplete[s.key];
            const current = i === stepIndex;
            return (
              <li key={s.key} className="flex items-center gap-1.5">
                <button
                  onClick={() => go(i)}
                  aria-current={current ? "step" : undefined}
                  className={`flex items-center gap-2 rounded-[var(--radius)] px-2.5 py-1.5 text-[12.5px] font-medium transition-colors ${
                    current
                      ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                      : complete
                        ? "text-[var(--text-secondary)] hover:bg-[var(--surface-3)]"
                        : "text-[var(--muted-2)] hover:bg-[var(--surface-3)]"
                  }`}
                >
                  <span
                    className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10.5px] ${
                      current
                        ? "bg-[var(--accent)] text-[var(--on-accent)]"
                        : complete
                          ? "bg-[var(--success-soft)] text-[var(--success)]"
                          : "bg-[var(--surface-3)] text-[var(--muted)]"
                    }`}
                  >
                    {complete && !current ? "✓" : i + 1}
                  </span>
                  <span className="hidden sm:inline">{s.label}</span>
                </button>
                {i < STEPS.length - 1 && (
                  <span aria-hidden className="h-px w-3 bg-[var(--border)] sm:w-5" />
                )}
              </li>
            );
          })}
        </ol>
      </nav>

      {submitError && (
        <div className="mb-5">
          <Note tone="danger" icon="⚠">
            {submitError}
          </Note>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="flex flex-col gap-4">
          {/* Step 1 — audience ------------------------------------------- */}
          {step === "audience" && (
            <Card
              title="Who is this for?"
              description="Pick the business line and the audience. The service pre-fills your message."
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Campaign name" htmlFor="name" error={errs.name} required>
                  <Input
                    id="name"
                    value={name}
                    invalid={Boolean(errs.name)}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Q3 intro to SaaS founders"
                  />
                </Field>
                <Field label="Service" htmlFor="svc" hint="The business line this campaign promotes.">
                  <Select id="svc" value={serviceId} onChange={(e) => applyService(e.target.value)}>
                    <option value="">— choose a service —</option>
                    {services.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>

              {serviceId && (
                <div className="mt-4">
                  <Note tone="info" icon="◆">
                    {services.find((s) => s.id === serviceId)?.description ??
                      "The service defaults have been applied to the message."}
                  </Note>
                </div>
              )}

              <div className="mt-4">
                <Field
                  label="Saved audience (optional)"
                  htmlFor="seg"
                  hint="Reuse a saved filter instead of picking contacts by hand."
                >
                  <Select id="seg" value={segmentId} onChange={(e) => setSegmentId(e.target.value)}>
                    <option value="">— everyone —</option>
                    {segments.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                {segments.length === 0 && (
                  <p className="mt-1.5 text-[12px] text-[var(--muted)]">
                    No saved audiences yet. You can create them in Settings, or import contacts on the
                    Contacts page.
                  </p>
                )}
              </div>
            </Card>
          )}

          {/* Step 2 — message -------------------------------------------- */}
          {step === "message" && (
            <Card
              title="What are you sending?"
              description="Start from a template or write it yourself. Personalisation uses {{variables}}."
            >
              <div className="flex flex-col gap-4">
                <Field label="Template" htmlFor="tpl" hint="Choosing one fills the subject and body.">
                  <Select id="tpl" value={templateId} onChange={(e) => applyTemplate(e.target.value)}>
                    <option value="">— write from scratch —</option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                        {t.category && t.category !== "OUTREACH" ? ` · ${t.category.toLowerCase()}` : ""}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Subject line" htmlFor="subject" error={errs.subject} required>
                  <Input
                    id="subject"
                    value={subject}
                    invalid={Boolean(errs.subject)}
                    onChange={(e) => setSubject(e.target.value)}
                    placeholder="Quick question about {{company}}"
                  />
                </Field>
                <Field
                  label="Message body"
                  htmlFor="body"
                  error={errs.body}
                  required
                  hint="{{first_name}}, {{company}}, {{website}}, {{unsubscribe_url}} are supported. Always include {{unsubscribe_url}}."
                >
                  <Textarea
                    id="body"
                    value={body}
                    invalid={Boolean(errs.body)}
                    rows={12}
                    onChange={(e) => setBody(e.target.value)}
                    placeholder="<p>Hi {{first_name}}, …</p>"
                  />
                </Field>
              </div>
            </Card>
          )}

          {/* Step 3 — sender --------------------------------------------- */}
          {step === "sender" && (
            <Card
              title="Who is sending it?"
              description="The name and reply-to address the recipient sees."
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Sender name"
                  htmlFor="from"
                  error={errs.fromName}
                  hint="A real name builds more trust than a bare address."
                >
                  <Input
                    id="from"
                    value={fromName}
                    invalid={Boolean(errs.fromName)}
                    onChange={(e) => setFromName(e.target.value)}
                    placeholder="Alex from Acme"
                  />
                </Field>
                <Field
                  label="Reply-to address"
                  htmlFor="reply"
                  error={errs.replyTo}
                  hint="Where replies should land. Defaults to the sender account."
                >
                  <Input
                    id="reply"
                    type="email"
                    value={replyTo}
                    invalid={Boolean(errs.replyTo)}
                    onChange={(e) => setReplyTo(e.target.value)}
                    placeholder="hello@acme.com"
                  />
                </Field>
              </div>

              <div className="mt-5">
                <p className="mb-2 text-[13px] font-medium text-[var(--text-secondary)]">
                  Connected sender accounts
                </p>
                {senders.length === 0 ? (
                  <Note tone="warning" icon="⚠">
                    No sender account is connected. You can finish setting up the campaign, but you
                    will need a connected Gmail or SMTP account before it can send.{" "}
                    <a href="/senders" className="underline">
                      Manage senders
                    </a>
                    .
                  </Note>
                ) : (
                  <ul className="divide-y divide-[var(--border)]">
                    {senders.map((s) => (
                      <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-[13px]">
                        <span className="min-w-0 truncate font-medium">{s.email}</span>
                        <span className="flex items-center gap-2">
                          <Badge tone="neutral">{s.provider}</Badge>
                          <Badge tone="info">cap {s.dailyCap}/day</Badge>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Card>
          )}

          {/* Step 4 — preview -------------------------------------------- */}
          {step === "preview" && (
            <Card
              title="Does it look right?"
              description="Rendered exactly as the recipient will receive it."
              actions={
                <Button variant="outline" size="sm" onClick={runPreview} loading={previewing}>
                  Re-render
                </Button>
              }
            >
              {previewProblems.length > 0 && (
                <div className="mb-4">
                  <Note tone="warning" icon="⚠">
                    <ul className="list-disc space-y-0.5 pl-4">
                      {previewProblems.map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                    </ul>
                  </Note>
                </div>
              )}

              {!preview ? (
                <Skeleton className="h-56" />
              ) : preview.reason ? (
                <EmptyState
                  icon="☺"
                  title="Nothing to preview yet"
                  description={preview.reason}
                  action={
                    <a
                      href="/contacts/import"
                      className="text-[13px] font-medium text-[var(--accent)] hover:underline"
                    >
                      Import contacts
                    </a>
                  }
                />
              ) : (
                <>
                  <div className="mb-3 flex flex-wrap items-center gap-2 text-[12.5px] text-[var(--muted)]">
                    <span>To: {preview.preview!.to}</span>
                    <span aria-hidden>·</span>
                    <span className="font-medium text-[var(--text-secondary)]">
                      {preview.preview!.subject}
                    </span>
                  </div>
                  <div className="rounded-[var(--radius)] border border-[var(--border)] bg-white p-4 text-[13.5px] text-black">
                    <div dangerouslySetInnerHTML={{ __html: preview.preview!.html }} />
                  </div>
                </>
              )}
            </Card>
          )}

          {/* Step 5 — recipients ----------------------------------------- */}
          {step === "recipients" && (
            <Card
              title="Who will receive it?"
              description="Suppressed, unsubscribed and unknown-time-zone contacts are excluded automatically."
            >
              {contacts.length === 0 ? (
                <EmptyState
                  icon="☺"
                  title="No contacts yet"
                  description="Import a CSV to build your audience. Duplicates are caught automatically."
                  action={
                    <a
                      href="/contacts/import"
                      className="inline-flex h-9 items-center gap-2 rounded-[var(--radius)] bg-[var(--accent)] px-3.5 text-[13.5px] font-medium text-[var(--on-accent)]"
                    >
                      Import contacts
                    </a>
                  }
                />
              ) : (
                <>
                  <div className="grid gap-4 sm:grid-cols-3">
                    <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] p-4">
                      <p className="text-[11.5px] font-semibold uppercase tracking-[0.06em] text-[var(--muted)]">
                        In your audience
                      </p>
                      <p className="tnum mt-1 text-2xl font-semibold">{contacts.length}</p>
                    </div>
                    <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] p-4">
                      <p className="text-[11.5px] font-semibold uppercase tracking-[0.06em] text-[var(--muted)]">
                        Excluded automatically
                      </p>
                      <p className="tnum mt-1 text-2xl font-semibold">—</p>
                      <p className="mt-1 text-[11.5px] text-[var(--muted)]">
                        Shown after you add recipients
                      </p>
                    </div>
                    <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] p-4">
                      <p className="text-[11.5px] font-semibold uppercase tracking-[0.06em] text-[var(--muted)]">
                        Saved audience
                      </p>
                      <p className="mt-1 text-[15px] font-semibold">
                        {segmentId
                          ? segments.find((s) => s.id === segmentId)?.name
                          : "Everyone"}
                      </p>
                    </div>
                  </div>
                  <p className="mt-4 text-[12.5px] leading-5 text-[var(--muted)]">
                    Recipients are added on the campaign&apos;s Recipients tab after you create it —
                    that is where the import wizard and the suppression breakdown live.
                  </p>
                </>
              )}
            </Card>
          )}

          {/* Step 6 — schedule ------------------------------------------- */}
          {step === "schedule" && (
            <Card
              title="When should it go out?"
              description="Each message is sent inside the recipient's own local working hours."
            >
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Window opens" htmlFor="start">
                  <Input id="start" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
                </Field>
                <Field label="Window closes" htmlFor="end">
                  <Input id="end" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
                </Field>
                <Field label="Daily limit" htmlFor="limit" hint="Per campaign, across all senders.">
                  <Input
                    id="limit"
                    type="number"
                    min={1}
                    value={dailyLimit}
                    onChange={(e) => setDailyLimit(e.target.value)}
                    placeholder="unlimited"
                  />
                </Field>
              </div>

              <div className="mt-4">
                <p className="mb-2 text-[13px] font-medium text-[var(--text-secondary)]">Sending days</p>
                <div className="flex flex-wrap gap-1.5">
                  {WEEKDAYS.map((d) => {
                    const on = days.includes(d.value);
                    return (
                      <button
                        key={d.value}
                        onClick={() => toggleDay(d.value)}
                        aria-pressed={on}
                        className={`h-9 w-12 rounded-[var(--radius)] text-[13px] font-medium transition-colors ${
                          on
                            ? "bg-[var(--accent)] text-[var(--on-accent)]"
                            : "bg-[var(--surface-3)] text-[var(--muted)] hover:bg-[var(--border)]"
                        }`}
                      >
                        {d.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Field
                  label="Unknown time zone"
                  htmlFor="tzmode"
                  hint="Recipients without a known zone are never guessed at."
                >
                  <Select id="tzmode" value={tzMode} onChange={(e) => setTzMode(e.target.value as "HOLD" | "FALLBACK")}>
                    <option value="HOLD">HOLD — hold them for review</option>
                    <option value="FALLBACK">FALLBACK — use a fallback zone</option>
                  </Select>
                </Field>
                {tzMode === "FALLBACK" && (
                  <Field label="Fallback time zone" htmlFor="fallback" error={errs.fallbackTimeZone}>
                    <Input
                      id="fallback"
                      value={fallbackTimeZone}
                      invalid={Boolean(errs.fallbackTimeZone)}
                      onChange={(e) => setFallbackTimeZone(e.target.value)}
                      placeholder="UTC"
                    />
                  </Field>
                )}
              </div>

              <div className="mt-4">
                <Field
                  label="Follow-up sequence (optional)"
                  htmlFor="seq"
                  hint="After the first email is delivered, the next step is scheduled automatically."
                >
                  <Select id="seq" value={sequenceId} onChange={(e) => setSequenceId(e.target.value)}>
                    <option value="">— no follow-ups —</option>
                    {sequences
                      .filter((s) => s.isActive)
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} ({s.steps.length} step{s.steps.length === 1 ? "" : "s"})
                        </option>
                      ))}
                  </Select>
                </Field>
              </div>
            </Card>
          )}

          {/* Step 7 — validate ------------------------------------------- */}
          {step === "validate" && (
            <Card
              title="Ready to launch?"
              description="A last check of the configuration before it is created."
            >
              <ul className="divide-y divide-[var(--border)] text-[13.5px]">
                {checks.map((c) => (
                  <li key={c.label} className="flex items-start gap-2.5 py-2.5">
                    <span
                      aria-hidden
                      className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full text-[10px] ${
                        c.ok
                          ? "bg-[var(--success-soft)] text-[var(--success)]"
                          : "bg-[var(--warning-soft)] text-[var(--warning)]"
                      }`}
                    >
                      {c.ok ? "✓" : "!"}
                    </span>
                    <span className="min-w-0">
                      <span className={c.ok ? "text-[var(--text)]" : "text-[var(--warning)]"}>{c.label}</span>
                      {!c.ok && <span className="block text-[12px] text-[var(--muted)]">{c.fix}</span>}
                    </span>
                  </li>
                ))}
              </ul>

              <div className="mt-5 space-y-3">
                <label className="flex items-start gap-3 rounded-[var(--radius)] border border-[var(--border)] p-3">
                  <input
                    type="checkbox"
                    checked={dryRun}
                    onChange={(e) => setDryRun(e.target.checked)}
                    className="mt-0.5 h-4 w-4 cursor-pointer rounded border-[var(--border-strong)] text-[var(--accent)]"
                  />
                  <span>
                    <span className="text-[13.5px] font-medium">Dry run</span>
                    <span className="block text-[12px] leading-5 text-[var(--muted)]">
                      Render and schedule every message but never hand it to the provider. No email
                      leaves the machine and no quota is consumed. Keep it on until you are happy.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-3 rounded-[var(--radius)] border border-[var(--border)] p-3">
                  <input
                    type="checkbox"
                    checked={requiresApproval}
                    onChange={(e) => setRequiresApproval(e.target.checked)}
                    className="mt-0.5 h-4 w-4 cursor-pointer rounded border-[var(--border-strong)] text-[var(--accent)]"
                  />
                  <span>
                    <span className="text-[13.5px] font-medium">Require approval before sending</span>
                    <span className="block text-[12px] leading-5 text-[var(--muted)]">
                      The campaign cannot be started until you approve it from the campaign page.
                    </span>
                  </span>
                </label>
              </div>
            </Card>
          )}

          {/* Step 8 — launch --------------------------------------------- */}
          {step === "launch" && (
            <Card
              title="Launch"
              description="The campaign is created as a DRAFT. Nothing is sent until you start it from the campaign page."
            >
              <dl className="divide-y divide-[var(--border)] text-[13.5px]">
                {[
                  ["Name", name || "—"],
                  ["Service", services.find((s) => s.id === serviceId)?.name ?? "None"],
                  ["Subject", subject || "—"],
                  ["Sender name", fromName || "The sender account's name"],
                  ["Reply-to", replyTo || "The sender account's address"],
                  [
                    "Sending window",
                    `${startTime}–${endTime} · ${days.length} day${days.length === 1 ? "" : "s"} a week`,
                  ],
                  ["Unknown time zone", tzMode === "HOLD" ? "Held for review" : `Fallback: ${fallbackTimeZone}`],
                  ["Follow-up sequence", sequences.find((s) => s.id === sequenceId)?.name ?? "None"],
                  ["Daily limit", dailyLimit || "Unlimited (sender caps still apply)"],
                  ["Mode", dryRun ? "Dry run — nothing will be delivered" : "Live"],
                  ["Approval", requiresApproval ? "Required before it can start" : "Not required"],
                ].map(([k, v]) => (
                  <div key={k} className="flex flex-wrap justify-between gap-3 py-2.5">
                    <dt className="text-[var(--muted)]">{k}</dt>
                    <dd className="max-w-[60%] text-right font-medium">{v}</dd>
                  </div>
                ))}
              </dl>

              {dryRun && (
                <div className="mt-5">
                  <Note tone="info" icon="◉">
                    This campaign starts in <strong>dry run</strong>. Every message is rendered and
                    scheduled, but no email is delivered and no quota is used. Turn it off on the
                    campaign page when you are ready.
                  </Note>
                </div>
              )}
            </Card>
          )}

          {/* Navigation ------------------------------------------------- */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button variant="outline" onClick={back} disabled={stepIndex === 0 || saving}>
              Back
            </Button>
            <div className="flex items-center gap-3">
              <span className="text-[12.5px] text-[var(--muted)]">
                Step {stepIndex + 1} of {STEPS.length}
              </span>
              {stepIndex < STEPS.length - 1 ? (
                <Button onClick={next}>Continue</Button>
              ) : (
                <Button onClick={submit} loading={saving}>
                  Create campaign
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* Side summary ------------------------------------------------- */}
        <aside className="lg:sticky lg:top-[calc(var(--topbar-height)+2rem)] lg:self-start">
          <Card title="Summary" description="What you have set up so far.">
            <dl className="space-y-3 text-[13px]">
              {[
                ["Service", services.find((s) => s.id === serviceId)?.name ?? "Not chosen"],
                ["Template", templates.find((t) => t.id === templateId)?.name ?? "Custom"],
                ["Audience", segmentId ? segments.find((s) => s.id === segmentId)?.name : "Everyone"],
                ["Follow-ups", sequences.find((s) => s.id === sequenceId)?.name ?? "None"],
                ["Contacts available", contacts.length.toLocaleString()],
                [
                  "Window",
                  `${startTime}–${endTime} · ${days.map((d) => WEEKDAYS.find((w) => w.value === d)?.label).join(" ")}`,
                ],
              ].map(([k, v]) => (
                <div key={k} className="flex items-start justify-between gap-3">
                  <dt className="shrink-0 text-[var(--muted)]">{k}</dt>
                  <dd className="min-w-0 truncate text-right font-medium">{v}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-4 border-t border-[var(--border)] pt-3 text-[11.5px] leading-4.5 text-[var(--muted-2)]">
              Nothing is created until the last step, and a new campaign never sends anything until
              you start it.
            </p>
          </Card>
        </aside>
      </div>
    </>
  );
}
