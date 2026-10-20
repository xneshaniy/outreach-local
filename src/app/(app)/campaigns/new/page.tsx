"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button, Card, Field, Input, Select, Textarea } from "@/components/ui";
import { PageHeader } from "@/components/AppShell";
import { api, errorMessage, fieldErrors } from "@/lib/client/api";

type Template = { id: string; name: string; subject: string; body: string };

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

  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateId, setTemplateId] = useState("");

  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [subjectTouched, setSubjectTouched] = useState(false);
  const [bodyTouched, setBodyTouched] = useState(false);
  const [fromName, setFromName] = useState("");
  const [replyTo, setReplyTo] = useState("");

  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("17:00");
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);

  const [tzMode, setTzMode] = useState<"HOLD" | "FALLBACK">("HOLD");
  const [fallbackTimeZone, setFallbackTimeZone] = useState("");
  const [dailyLimit, setDailyLimit] = useState("");

  const [saving, setSaving] = useState(false);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    api<{ templates: Template[] }>("/api/templates")
      .then((d) => setTemplates(d.templates))
      .catch(() => undefined);
  }, []);

  const applyTemplate = (id: string) => {
    setTemplateId(id);
    if (!id) return;
    const tpl = templates.find((t) => t.id === id);
    if (!tpl) return;
    if (subjectTouched || bodyTouched) {
      const ok = window.confirm("Replace the current subject and body with the template content?");
      if (!ok) return;
    }
    setSubject(tpl.subject);
    setBody(tpl.body);
    setSubjectTouched(true);
    setBodyTouched(true);
  };

  const toggleDay = (value: number) => {
    setDays((d) => (d.includes(value) ? d.filter((v) => v !== value) : [...d, value].sort((a, b) => a - b)));
  };

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
      };
      if (templateId) payload.templateId = templateId;
      if (fromName.trim()) payload.fromName = fromName.trim();
      if (replyTo.trim()) payload.replyTo = replyTo.trim();
      if (tzMode === "FALLBACK") payload.fallbackTimeZone = fallbackTimeZone.trim();
      if (dailyLimit.trim()) payload.dailyLimit = Number(dailyLimit);

      const res = await api<{ campaign: { id: string } }>("/api/campaigns", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      router.push(`/campaigns/${res.campaign.id}`);
    } catch (err) {
      setErrs(fieldErrors(err));
      setSubmitError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader
        title="New campaign"
        description="Compose the message, set the recipient-local sending window, then review and start."
        actions={
          <Button variant="secondary" onClick={() => router.push("/campaigns")} disabled={saving}>
            Cancel
          </Button>
        }
      />

      {submitError && (
        <div role="alert" className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {submitError}
        </div>
      )}

      <div className="flex flex-col gap-4">
        <Card title="Message">
          <div className="flex max-w-2xl flex-col gap-4">
            <Field label="Start from template (optional)" htmlFor="tpl" hint="Choosing a template fills the subject and body.">
              <Select id="tpl" value={templateId} onChange={(e) => applyTemplate(e.target.value)}>
                <option value="">— write from scratch —</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Campaign name" htmlFor="name" error={errs.name} hint="Only visible to your team.">
              <Input
                id="name"
                value={name}
                invalid={Boolean(errs.name)}
                onChange={(e) => setName(e.target.value)}
                placeholder="Q3 intro to SaaS founders"
              />
            </Field>
            <Field label="Subject" htmlFor="subject" error={errs.subject}>
              <Input
                id="subject"
                value={subject}
                invalid={Boolean(errs.subject)}
                onChange={(e) => {
                  setSubject(e.target.value);
                  setSubjectTouched(true);
                }}
                placeholder="Quick question about {{company}}"
              />
            </Field>
            <Field
              label="Body"
              htmlFor="body"
              error={errs.body}
              hint="{{first_name}}, {{company}}, {{website}}, {{unsubscribe_url}} supported."
            >
              <Textarea
                id="body"
                value={body}
                invalid={Boolean(errs.body)}
                rows={10}
                onChange={(e) => {
                  setBody(e.target.value);
                  setBodyTouched(true);
                }}
                placeholder={"Hi {{first_name}},\n\nI saw {{company}} and…"}
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="From name (optional)" htmlFor="from-name" error={errs.fromName} hint="Defaults to the sender's display name.">
                <Input id="from-name" value={fromName} onChange={(e) => setFromName(e.target.value)} />
              </Field>
              <Field label="Reply-to (optional)" htmlFor="reply-to" error={errs.replyTo}>
                <Input id="reply-to" type="email" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} />
              </Field>
            </div>
          </div>
        </Card>

        <Card title="Sending window" description="Emails go out only inside each recipient's local time window.">
          <div className="flex max-w-2xl flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Window start" htmlFor="win-start">
                <Input id="win-start" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
              </Field>
              <Field label="Window end" htmlFor="win-end" error={errs.windowEndMinute}>
                <Input id="win-end" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
              </Field>
            </div>
            <fieldset>
              <legend className="mb-1.5 text-sm font-medium">Sending days</legend>
              <div className="flex flex-wrap gap-3">
                {WEEKDAYS.map((d) => (
                  <label key={d.value} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={days.includes(d.value)}
                      onChange={() => toggleDay(d.value)}
                      className="h-4 w-4 rounded border-[var(--border)]"
                    />
                    {d.label}
                  </label>
                ))}
              </div>
              {errs.sendingDays && (
                <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
                  {errs.sendingDays}
                </p>
              )}
            </fieldset>
          </div>
        </Card>

        <Card title="Time zone handling" description="What happens to recipients whose time zone is unknown.">
          <div className="flex max-w-2xl flex-col gap-4">
            <Field label="Unknown time zone" htmlFor="tz-mode">
              <Select id="tz-mode" value={tzMode} onChange={(e) => setTzMode(e.target.value as "HOLD" | "FALLBACK")}>
                <option value="HOLD">HOLD — hold recipients for review</option>
                <option value="FALLBACK">FALLBACK — use a fallback time zone</option>
              </Select>
            </Field>
            {tzMode === "FALLBACK" && (
              <Field
                label="Fallback time zone"
                htmlFor="fallback-tz"
                error={errs.fallbackTimeZone}
                hint="IANA name like UTC — used for recipients without a known zone."
              >
                <Input
                  id="fallback-tz"
                  value={fallbackTimeZone}
                  invalid={Boolean(errs.fallbackTimeZone)}
                  onChange={(e) => setFallbackTimeZone(e.target.value)}
                  placeholder="UTC"
                />
              </Field>
            )}
            <Field label="Daily limit (optional)" htmlFor="daily-limit" hint="Max emails from this campaign per day, across all senders.">
              <Input id="daily-limit" type="number" min={1} value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} placeholder="unlimited" />
            </Field>
          </div>
        </Card>

        <div className="flex items-center gap-3">
          <Button onClick={submit} loading={saving}>
            Create campaign
          </Button>
          <p className="text-xs text-[var(--muted)]">You can add recipients and start the campaign from its detail page.</p>
        </div>
      </div>
    </>
  );
}
