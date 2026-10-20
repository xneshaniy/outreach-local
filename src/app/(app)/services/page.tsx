"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/AppShell";
import { Badge, Button, Card, Field, Input, Textarea } from "@/components/ui";
import { useToast } from "@/components/ui/Toast";
import { api, errorMessage } from "@/lib/client/api";

/**
 * Service profiles — one per business line.
 *
 * Each service holds the description, target industries, ideal customer
 * profile, default subject/body and call to action. Campaigns and templates
 * can be linked to a service so the whole workspace stays organised.
 */

type Service = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  targetIndustries: string[];
  idealCustomerProfile: string | null;
  defaultSubject: string | null;
  defaultBody: string | null;
  defaultCta: string | null;
  color: string;
  isActive: boolean;
  _count?: { campaigns: number; templates: number; sequences: number };
};

const BLANK = {
  name: "",
  description: "",
  targetIndustries: "",
  idealCustomerProfile: "",
  defaultSubject: "",
  defaultBody: "",
  defaultCta: "",
  color: "#6366f1",
};

export default function ServicesPage() {
  const toast = useToast();
  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Service | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ ...BLANK });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (seed: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api<{ services: Service[] }>(`/api/services${seed ? "?seedIfEmpty=true" : ""}`);
      setServices(res.services);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  const startCreate = () => {
    setEditing(null);
    setForm({ ...BLANK });
    setCreating(true);
  };

  const startEdit = (s: Service) => {
    setCreating(false);
    setEditing(s);
    setForm({
      name: s.name,
      description: s.description ?? "",
      targetIndustries: s.targetIndustries.join(", "),
      idealCustomerProfile: s.idealCustomerProfile ?? "",
      defaultSubject: s.defaultSubject ?? "",
      defaultBody: s.defaultBody ?? "",
      defaultCta: s.defaultCta ?? "",
      color: s.color,
    });
  };

  const save = async () => {
    if (!form.name.trim()) {
      toast.push("error", "Give the service a name.");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        targetIndustries: form.targetIndustries
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        idealCustomerProfile: form.idealCustomerProfile.trim() || null,
        defaultSubject: form.defaultSubject.trim() || null,
        defaultBody: form.defaultBody.trim() || null,
        defaultCta: form.defaultCta.trim() || null,
        color: form.color,
      };
      if (editing) {
        await api(`/api/services/${editing.id}`, { method: "PATCH", body: JSON.stringify(payload) });
        toast.push("success", "Service updated.");
      } else {
        await api("/api/services", { method: "POST", body: JSON.stringify(payload) });
        toast.push("success", "Service created.");
      }
      setCreating(false);
      setEditing(null);
      setForm({ ...BLANK });
      await load(false);
    } catch (e) {
      toast.push("error", errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (s: Service) => {
    if (!window.confirm(`Delete "${s.name}"? Its campaigns and templates are kept.`)) return;
    try {
      await api(`/api/services/${s.id}`, { method: "DELETE" });
      toast.push("success", "Service deleted.");
      await load(false);
    } catch (e) {
      toast.push("error", errorMessage(e));
    }
  };

  return (
    <>
      <PageHeader
        title="Services"
        description="One profile per business line — used to group campaigns, templates and follow-up sequences."
        actions={
          <Button onClick={startCreate} disabled={creating || !!editing}>
            + New service
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
          <p className="text-sm text-[var(--muted)]">Loading services…</p>
        </Card>
      ) : services.length === 0 && !creating ? (
        <Card>
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <p className="text-sm font-medium">No service profiles yet</p>
            <p className="max-w-md text-sm text-[var(--muted)]">
              Services group your work by business line — lead generation, virtual assistance, CRM
              automation, e-commerce. Each one can carry its own message templates and call to action.
            </p>
            <Button onClick={startCreate}>+ Add your first service</Button>
          </div>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {services.map((s) => (
            <Card
              key={s.id}
              title={
                <span className="flex items-center gap-2">
                  <span aria-hidden className="h-3 w-3 rounded-full" style={{ background: s.color }} />
                  {s.name}
                  {!s.isActive && <Badge tone="neutral">Inactive</Badge>}
                </span>
              }
              actions={
                <>
                  <Button variant="secondary" onClick={() => startEdit(s)}>
                    Edit
                  </Button>
                  <Button variant="ghost" onClick={() => remove(s)}>
                    Delete
                  </Button>
                </>
              }
            >
              {s.description && <p className="mb-3 text-sm text-[var(--muted)]">{s.description}</p>}
              {s.targetIndustries.length > 0 && (
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {s.targetIndustries.map((t) => (
                    <Badge key={t} tone="blue">
                      {t}
                    </Badge>
                  ))}
                </div>
              )}
              {s.idealCustomerProfile && (
                <p className="mb-3 text-sm">
                  <span className="font-medium">Ideal customer: </span>
                  <span className="text-[var(--muted)]">{s.idealCustomerProfile}</span>
                </p>
              )}
              {s.defaultCta && (
                <p className="mb-3 text-sm">
                  <span className="font-medium">Call to action: </span>
                  <span className="text-[var(--muted)]">{s.defaultCta}</span>
                </p>
              )}
              <p className="text-xs text-[var(--muted)]">
                {s._count?.campaigns ?? 0} campaigns · {s._count?.templates ?? 0} templates ·{" "}
                {s._count?.sequences ?? 0} follow-up sequences
              </p>
            </Card>
          ))}
        </div>
      )}

      {(creating || editing) && (
        <Card
          title={editing ? `Edit "${editing.name}"` : "New service"}
          description="These defaults are used when you create a campaign or template for this service."
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
                {editing ? "Save changes" : "Create service"}
              </Button>
            </>
          }
        >
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Name" htmlFor="svc-name">
              <Input
                id="svc-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Lead Generation & List Building"
              />
            </Field>
            <Field label="Colour" htmlFor="svc-color" hint="Used for the service badge.">
              <Input
                id="svc-color"
                type="color"
                value={form.color}
                onChange={(e) => setForm({ ...form, color: e.target.value })}
                className="h-10 w-20 p-1"
              />
            </Field>
          </div>

          <div className="mt-4">
            <Field label="Description" htmlFor="svc-desc">
              <Textarea
                id="svc-desc"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="What this service does and who it is for."
              />
            </Field>
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <Field label="Target industries" htmlFor="svc-industries" hint="Comma separated.">
              <Input
                id="svc-industries"
                value={form.targetIndustries}
                onChange={(e) => setForm({ ...form, targetIndustries: e.target.value })}
                placeholder="SaaS, Agencies, Consulting"
              />
            </Field>
            <Field label="Ideal customer profile" htmlFor="svc-icp">
              <Input
                id="svc-icp"
                value={form.idealCustomerProfile}
                onChange={(e) => setForm({ ...form, idealCustomerProfile: e.target.value })}
                placeholder="B2B teams with a sales team that needs qualified leads."
              />
            </Field>
          </div>

          <div className="mt-4">
            <Field label="Default subject line" htmlFor="svc-subject" hint="Supports {{variable}} placeholders.">
              <Input
                id="svc-subject"
                value={form.defaultSubject}
                onChange={(e) => setForm({ ...form, defaultSubject: e.target.value })}
                placeholder="A {{company}}-focused list of {{target_industry}} decision makers"
              />
            </Field>
          </div>

          <div className="mt-4">
            <Field label="Default message body" htmlFor="svc-body">
              <Textarea
                id="svc-body"
                value={form.defaultBody}
                onChange={(e) => setForm({ ...form, defaultBody: e.target.value })}
                placeholder="<p>Hi {{first_name}}, …</p>"
              />
            </Field>
          </div>

          <div className="mt-4">
            <Field label="Default call to action" htmlFor="svc-cta">
              <Input
                id="svc-cta"
                value={form.defaultCta}
                onChange={(e) => setForm({ ...form, defaultCta: e.target.value })}
                placeholder="Could I send you a 10-row sample?"
              />
            </Field>
          </div>
        </Card>
      )}
    </>
  );
}
