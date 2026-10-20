"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, ConfirmDialog, EmptyState, Field, Input, Modal, Skeleton, Textarea } from "@/components/ui";
import { PageHeader } from "@/components/AppShell";
import { useToast } from "@/components/ui/Toast";
import { api, errorMessage, fieldErrors } from "@/lib/client/api";

type Template = {
  id: string;
  name: string;
  subject: string;
  body: string;
  description: string | null;
  updatedAt: string;
};

type TemplatesResponse = { templates: Template[] };

const VARIABLE_REGEX = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

const SAMPLE_VALUES: Record<string, string> = {
  first_name: "Ada",
  company: "Acme",
  website: "https://acme.com",
  unsubscribe_url: "https://example.com/u",
};

function renderSample(text: string): string {
  return text.replace(VARIABLE_REGEX, (match, key: string) => SAMPLE_VALUES[key] ?? match);
}

function extractVariables(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(VARIABLE_REGEX)) {
    if (match[1]) found.add(match[1]);
  }
  return [...found];
}

const EMPTY_FORM = { name: "", subject: "", body: "", description: "" };

export default function TemplatesPage() {
  const toast = useToast();

  const [data, setData] = useState<TemplatesResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Template | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<Template | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(() => {
    api<TemplatesResponse>("/api/templates")
      .then((d) => {
        setData(d);
        setLoadError(null);
      })
      .catch((err) => setLoadError(errorMessage(err)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openNew = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setErrs({});
    setEditorOpen(true);
  };

  const openEdit = (tpl: Template) => {
    setEditing(tpl);
    setForm({ name: tpl.name, subject: tpl.subject, body: tpl.body, description: tpl.description ?? "" });
    setErrs({});
    setEditorOpen(true);
  };

  const save = async () => {
    setSaving(true);
    setErrs({});
    try {
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        subject: form.subject.trim(),
        body: form.body,
      };
      if (form.description.trim()) body.description = form.description.trim();
      if (editing) {
        await api(`/api/templates/${editing.id}`, { method: "PATCH", body: JSON.stringify(body) });
        toast.push("success", "Template updated.");
      } else {
        await api("/api/templates", { method: "POST", body: JSON.stringify(body) });
        toast.push("success", "Template created.");
      }
      setEditorOpen(false);
      load();
    } catch (err) {
      setErrs(fieldErrors(err));
      toast.push("error", errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api(`/api/templates/${deleteTarget.id}`, { method: "DELETE" });
      toast.push("success", "Template deleted.");
      setDeleteTarget(null);
      load();
    } catch (err) {
      toast.push("error", errorMessage(err));
    } finally {
      setDeleting(false);
    }
  };

  const templates = data?.templates ?? [];
  const previewVariables = extractVariables(`${form.subject}\n${form.body}`);

  return (
    <>
      <PageHeader
        title="Templates"
        description="Reusable messages. Variables like {{first_name}} are filled per recipient at send time."
        actions={<Button onClick={openNew}>New template</Button>}
      />

      {loadError && (
        <div role="alert" className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {loadError}
        </div>
      )}

      {!data && !loadError ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      ) : templates.length === 0 ? (
        <EmptyState
          title="No templates yet"
          description="Templates let you reuse proven copy across campaigns."
          action={<Button onClick={openNew}>New template</Button>}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {templates.map((tpl) => (
            <Card
              key={tpl.id}
              title={tpl.name}
              description={tpl.description ?? undefined}
              actions={
                <>
                  <Button variant="ghost" onClick={() => openEdit(tpl)}>
                    Edit
                  </Button>
                  <Button variant="ghost" className="text-red-600 dark:text-red-400" onClick={() => setDeleteTarget(tpl)}>
                    Delete
                  </Button>
                </>
              }
            >
              <p className="text-sm font-medium">{tpl.subject}</p>
              <pre className="mt-2 max-h-28 overflow-hidden whitespace-pre-wrap rounded-lg bg-black/5 p-2 font-mono text-xs text-[var(--muted)] dark:bg-white/5">
                {tpl.body.length > 220 ? `${tpl.body.slice(0, 220)}…` : tpl.body}
              </pre>
              <p className="mt-2 text-xs text-[var(--muted)]">Updated {new Date(tpl.updatedAt).toLocaleDateString()}</p>
            </Card>
          ))}
        </div>
      )}

      {/* Editor modal with live preview */}
      <Modal
        open={editorOpen}
        title={editing ? `Edit template — ${editing.name}` : "New template"}
        onClose={() => setEditorOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditorOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} loading={saving}>
              {editing ? "Save changes" : "Create template"}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label="Name" htmlFor="tpl-name" error={errs.name}>
            <Input
              id="tpl-name"
              value={form.name}
              invalid={Boolean(errs.name)}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Cold intro v1"
            />
          </Field>
          <Field label="Subject" htmlFor="tpl-subject" error={errs.subject}>
            <Input
              id="tpl-subject"
              value={form.subject}
              invalid={Boolean(errs.subject)}
              onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))}
              placeholder="Quick question about {{company}}"
            />
          </Field>
          <Field label="Body" htmlFor="tpl-body" error={errs.body}>
            <Textarea
              id="tpl-body"
              value={form.body}
              invalid={Boolean(errs.body)}
              rows={8}
              onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
              placeholder={"Hi {{first_name}},\n\n…\n\n{{unsubscribe_url}}"}
            />
          </Field>
          <Field label="Description (optional)" htmlFor="tpl-desc" error={errs.description}>
            <Input
              id="tpl-desc"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
          </Field>

          <div className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Preview (sample values)</p>
            {previewVariables.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {previewVariables.map((v) => (
                  <Badge key={v} tone="purple">
                    {`{{${v}}}`}
                  </Badge>
                ))}
              </div>
            )}
            <p className="mt-2 text-sm font-medium">{renderSample(form.subject) || "Subject preview…"}</p>
            <div className="mt-1 whitespace-pre-wrap text-sm text-[var(--muted)]">
              {renderSample(form.body) || "Body preview…"}
            </div>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete template"
        message={`Delete “${deleteTarget?.name ?? ""}”? Campaigns that already used it keep their copied content; only this template is removed.`}
        confirmLabel="Delete"
        loading={deleting}
        onConfirm={confirmDelete}
        onClose={() => setDeleteTarget(null)}
      />
    </>
  );
}
