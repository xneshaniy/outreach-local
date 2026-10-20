"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/AppShell";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Textarea } from "@/components/ui";
import { useToast } from "@/components/ui/Toast";
import { api, errorMessage } from "@/lib/client/api";

/**
 * Follow-up sequences.
 *
 * A sequence is a list of steps. When a campaign with this sequence sends its
 * first email, the first step is scheduled for each recipient; when that step
 * is delivered the next one is scheduled, and so on. Every step is cancelled
 * automatically when the contact replies, unsubscribes, bounces or is
 * suppressed, or when the campaign is paused.
 */

type Step = { id?: string; order: number; delayDays: number; subject: string; body: string };
type Sequence = {
  id: string;
  name: string;
  isActive: boolean;
  serviceId: string | null;
  service?: { id: string; name: string; color: string } | null;
  steps: Step[];
  _count?: { messages: number; campaigns: number };
};
type Service = { id: string; name: string; color: string };

function emptyStep(order: number): Step {
  return { order, delayDays: order === 1 ? 3 : 4, subject: "", body: "" };
}

export default function FollowUpsPage() {
  const toast = useToast();
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Sequence | null>(null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<{ name: string; serviceId: string; isActive: boolean; steps: Step[] }>({
    name: "",
    serviceId: "",
    isActive: true,
    steps: [emptyStep(1)],
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [seqs, svc] = await Promise.all([
        api<{ sequences: Sequence[] }>("/api/follow-ups"),
        api<{ services: Service[] }>("/api/services"),
      ]);
      setSequences(seqs.sequences);
      setServices(svc.services);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const startCreate = () => {
    setEditing(null);
    setCreating(true);
    setForm({ name: "", serviceId: "", isActive: true, steps: [emptyStep(1)] });
  };

  const startEdit = (s: Sequence) => {
    setCreating(false);
    setEditing(s);
    setForm({
      name: s.name,
      serviceId: s.serviceId ?? "",
      isActive: s.isActive,
      steps: s.steps.map((st) => ({ ...st })),
    });
  };

  const updateStep = (index: number, patch: Partial<Step>) => {
    setForm((f) => ({
      ...f,
      steps: f.steps.map((s, i) => (i === index ? { ...s, ...patch } : s)),
    }));
  };

  const addStep = () =>
    setForm((f) => ({ ...f, steps: [...f.steps, emptyStep(f.steps.length + 1)] }));

  const removeStep = (index: number) =>
    setForm((f) => ({
      ...f,
      steps: f.steps
        .filter((_, i) => i !== index)
        .map((s, i) => ({ ...s, order: i + 1 })),
    }));

  const save = async () => {
    if (!form.name.trim()) {
      toast.push("error", "Give the sequence a name.");
      return;
    }
    if (form.steps.some((s) => !s.subject.trim() || !s.body.trim())) {
      toast.push("error", "Every step needs a subject line and a body.");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        serviceId: form.serviceId || null,
        isActive: form.isActive,
        steps: form.steps.map((s, i) => ({
          order: i + 1,
          delayDays: s.delayDays,
          subject: s.subject.trim(),
          body: s.body.trim(),
        })),
      };
      if (editing) {
        await api(`/api/follow-ups/${editing.id}`, { method: "PATCH", body: JSON.stringify(payload) });
        toast.push("success", "Sequence updated.");
      } else {
        await api("/api/follow-ups", { method: "POST", body: JSON.stringify(payload) });
        toast.push("success", "Sequence created.");
      }
      setCreating(false);
      setEditing(null);
      await load();
    } catch (e) {
      toast.push("error", errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (s: Sequence) => {
    if (!window.confirm(`Delete the sequence "${s.name}"?`)) return;
    try {
      await api(`/api/follow-ups/${s.id}`, { method: "DELETE" });
      toast.push("success", "Sequence deleted.");
      await load();
    } catch (e) {
      toast.push("error", errorMessage(e));
    }
  };

  const toggleActive = async (s: Sequence) => {
    try {
      await api(`/api/follow-ups/${s.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !s.isActive }),
      });
      await load();
    } catch (e) {
      toast.push("error", errorMessage(e));
    }
  };

  return (
    <>
      <PageHeader
        title="Follow-up sequences"
        description="Automatically send a follow-up after the first email — and stop the moment the contact replies or opts out."
        actions={
          <Button onClick={startCreate} disabled={creating || !!editing}>
            + New sequence
          </Button>
        }
      />

      {error && (
        <div role="alert" className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <Card>
          <p className="text-sm text-[var(--muted)]">Loading sequences…</p>
        </Card>
      ) : sequences.length === 0 && !creating ? (
        <Card>
          <EmptyState
            title="No follow-up sequences yet"
            description="A sequence turns one outreach email into a short, polite series. Pick a campaign, attach the sequence, and the next step is scheduled automatically once the first email is delivered."
            action={<Button onClick={startCreate}>+ Create a sequence</Button>}
          />
        </Card>
      ) : (
        <div className="grid gap-4">
          {sequences.map((s) => (
            <Card
              key={s.id}
              title={
                <span className="flex flex-wrap items-center gap-2">
                  {s.name}
                  {s.service && (
                    <Badge tone="blue">
                      <span aria-hidden className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: s.service.color }} />
                      {s.service.name}
                    </Badge>
                  )}
                  {!s.isActive && <Badge tone="neutral">Paused</Badge>}
                </span>
              }
              actions={
                <>
                  <Button variant="secondary" onClick={() => toggleActive(s)}>
                    {s.isActive ? "Pause" : "Activate"}
                  </Button>
                  <Button variant="secondary" onClick={() => startEdit(s)}>
                    Edit
                  </Button>
                  <Button variant="ghost" onClick={() => remove(s)}>
                    Delete
                  </Button>
                </>
              }
            >
              <ol className="space-y-2">
                {s.steps.map((st) => (
                  <li key={st.id ?? st.order} className="rounded-lg border border-[var(--border)] p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="purple">Step {st.order}</Badge>
                      <span className="text-sm text-[var(--muted)]">
                        {st.delayDays === 0 ? "same day" : `after ${st.delayDays} day${st.delayDays === 1 ? "" : "s"}`}
                      </span>
                    </div>
                    <p className="mt-1.5 text-sm font-medium">{st.subject}</p>
                    <p className="mt-1 line-clamp-2 text-sm text-[var(--muted)]">{st.body.replace(/<[^>]+>/g, " ")}</p>
                  </li>
                ))}
              </ol>
              <p className="mt-3 text-xs text-[var(--muted)]">
                {s._count?.campaigns ?? 0} campaigns use this · {s._count?.messages ?? 0} follow-up messages
              </p>
            </Card>
          ))}
        </div>
      )}

      {(creating || editing) && (
        <Card
          title={editing ? `Edit "${editing.name}"` : "New follow-up sequence"}
          actions={
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  setCreating(false);
                  setEditing(null);
                }}
              >
                Cancel
              </Button>
              <Button onClick={save} loading={saving}>
                {editing ? "Save changes" : "Create sequence"}
              </Button>
            </>
          }
        >
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Name" htmlFor="seq-name">
              <Input
                id="seq-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Two polite bumps"
              />
            </Field>
            <Field label="Service" htmlFor="seq-service" hint="Optional — groups this sequence with a business line.">
              <Select
                id="seq-service"
                value={form.serviceId}
                onChange={(e) => setForm({ ...form, serviceId: e.target.value })}
              >
                <option value="">No service</option>
                {services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="mt-5 space-y-4">
            <p className="text-sm font-medium">Steps</p>
            {form.steps.map((step, index) => (
              <div key={index} className="rounded-lg border border-[var(--border)] p-4">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <Badge tone="purple">Step {index + 1}</Badge>
                  <div className="w-40">
                    <Field label="Delay (days)" htmlFor={`delay-${index}`}>
                      <Input
                        id={`delay-${index}`}
                        type="number"
                        min={0}
                        max={365}
                        value={step.delayDays}
                        onChange={(e) =>
                          updateStep(index, { delayDays: Number(e.target.value) || 0 })
                        }
                      />
                    </Field>
                  </div>
                  {form.steps.length > 1 && (
                    <Button variant="ghost" onClick={() => removeStep(index)}>
                      Remove step
                    </Button>
                  )}
                </div>
                <Field label="Subject line" htmlFor={`subject-${index}`}>
                  <Input
                    id={`subject-${index}`}
                    value={step.subject}
                    onChange={(e) => updateStep(index, { subject: e.target.value })}
                    placeholder="Quick follow-up"
                  />
                </Field>
                <div className="mt-3">
                  <Field label="Message body" htmlFor={`body-${index}`}>
                    <Textarea
                      id={`body-${index}`}
                      value={step.body}
                      onChange={(e) => updateStep(index, { body: e.target.value })}
                      placeholder="<p>Hi {{first_name}}, just checking in…</p>"
                    />
                  </Field>
                </div>
              </div>
            ))}
            <Button variant="secondary" onClick={addStep}>
              + Add step
            </Button>
          </div>
        </Card>
      )}
    </>
  );
}
