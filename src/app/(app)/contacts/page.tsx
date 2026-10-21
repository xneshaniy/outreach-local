"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Modal,
  Pagination,
  Select,
  Skeleton,
  StatusBadge,
  Table,
} from "@/components/ui";
import { PageHeader } from "@/components/AppShell";
import { useToast } from "@/components/ui/Toast";
import { api, errorMessage, fieldErrors } from "@/lib/client/api";

/**
 * Contacts.
 *
 * The list is built for a large audience: a filter bar that stays out of the
 * way, a table that reads well, bulk actions that always preview first, and
 * clear empty states.
 */

type Contact = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  website: string | null;
  title: string | null;
  timeZone: string | null;
  country: string | null;
  source: string | null;
  notes: string | null;
  tags: string[];
  status: string;
  priority: string;
  stageId: string | null;
  isArchived: boolean;
  sentCount: number;
  lastSentAt: string | null;
  lastRepliedAt: string | null;
  createdAt: string;
};

type ContactsResponse = {
  total: number;
  page: number;
  pageSize: number;
  items: Contact[];
  sources?: (string | null)[];
};

type Stage = { id: string; name: string; color: string };

const STATUS_OPTIONS = [
  "ACTIVE",
  "REPLIED",
  "INTERESTED",
  "UNSUBSCRIBED",
  "BOUNCED",
  "COMPLAINED",
  "INVALID",
];

const PRIORITY_OPTIONS = ["LOW", "MEDIUM", "HIGH", "URGENT"];

const BLANK = {
  email: "",
  firstName: "",
  lastName: "",
  company: "",
  website: "",
  title: "",
  timeZone: "",
  country: "",
  source: "",
  tags: "",
  notes: "",
};

export default function ContactsPage() {
  const toast = useToast();

  const [data, setData] = useState<ContactsResponse | null>(null);
  const [stages, setStages] = useState<Stage[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [status, setStatus] = useState("");
  const [source, setSource] = useState("");
  const [tag, setTag] = useState("");
  const [stageId, setStageId] = useState("");
  const [page, setPage] = useState(1);

  const [addOpen, setAddOpen] = useState(false);
  const [addSaving, setAddSaving] = useState(false);
  const [form, setForm] = useState({ ...BLANK });
  const [errs, setErrs] = useState<Record<string, string>>({});

  const [deleteTarget, setDeleteTarget] = useState<Contact | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Bulk selection + preview
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkPreview, setBulkPreview] = useState<{
    changed: number;
    matched: number;
    preview: Array<{ id: string; email: string; changed: boolean; before: Record<string, unknown>; after: Record<string, unknown> }>;
  } | null>(null);
  const [bulkForm, setBulkForm] = useState({ source: "", industry: "", priority: "", stageId: "", addTags: "" });

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), pageSize: "25" });
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (status) params.set("status", status);
    if (source) params.set("source", source);
    if (tag) params.set("tag", tag);
    api<ContactsResponse>(`/api/contacts?${params.toString()}`)
      .then((d) => {
        setData(d);
        setLoadError(null);
        setSelected((s) => s.filter((id) => d.items.some((c) => c.id === id)));
      })
      .catch((err) => setLoadError(errorMessage(err)))
      .finally(() => setLoading(false));
  }, [page, debouncedSearch, status, source, tag]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api<{ stages: Stage[] }>("/api/pipeline/stages")
      .then((d) => setStages(d.stages))
      .catch(() => setStages([]));
  }, []);

  const submitAdd = async () => {
    setAddSaving(true);
    setErrs({});
    try {
      const body: Record<string, unknown> = { email: form.email.trim() };
      for (const key of [
        "firstName",
        "lastName",
        "company",
        "website",
        "title",
        "timeZone",
        "country",
        "source",
        "notes",
      ] as const) {
        if (form[key].trim()) body[key] = form[key].trim();
      }
      const tags = form.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      if (tags.length > 0) body.tags = tags;
      await api("/api/contacts", { method: "POST", body: JSON.stringify(body) });
      toast.push("success", "Contact added.");
      setAddOpen(false);
      setForm({ ...BLANK });
      load();
    } catch (err) {
      setErrs(fieldErrors(err));
      toast.push("error", errorMessage(err));
    } finally {
      setAddSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api(`/api/contacts/${deleteTarget.id}`, { method: "DELETE" });
      toast.push("success", `${deleteTarget.email} removed.`);
      setDeleteTarget(null);
      load();
    } catch (err) {
      toast.push("error", errorMessage(err));
    } finally {
      setDeleting(false);
    }
  };

  const runBulkPreview = async () => {
    if (selected.length === 0) return;
    const changes: Record<string, unknown> = {};
    if (bulkForm.source.trim()) changes.source = bulkForm.source.trim();
    if (bulkForm.industry.trim()) changes.industry = bulkForm.industry.trim();
    if (bulkForm.priority) changes.priority = bulkForm.priority;
    if (bulkForm.stageId) changes.stageId = bulkForm.stageId;
    const tags = bulkForm.addTags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (tags.length > 0) changes.addTags = tags;
    if (Object.keys(changes).length === 0) {
      toast.push("error", "Choose at least one change first.");
      return;
    }
    try {
      const res = await api<typeof bulkPreview>("/api/contacts/bulk", {
        method: "POST",
        body: JSON.stringify({ mode: "preview", ids: selected, changes }),
      });
      setBulkPreview(res);
    } catch (err) {
      toast.push("error", errorMessage(err));
    }
  };

  const runBulkApply = async () => {
    const changes: Record<string, unknown> = {};
    if (bulkForm.source.trim()) changes.source = bulkForm.source.trim();
    if (bulkForm.industry.trim()) changes.industry = bulkForm.industry.trim();
    if (bulkForm.priority) changes.priority = bulkForm.priority;
    if (bulkForm.stageId) changes.stageId = bulkForm.stageId;
    const tags = bulkForm.addTags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (tags.length > 0) changes.addTags = tags;

    try {
      const res = await api<{ updated: number }>("/api/contacts/bulk", {
        method: "POST",
        body: JSON.stringify({ mode: "apply", ids: selected, changes }),
      });
      toast.push("success", `${res.updated} contact${res.updated === 1 ? "" : "s"} updated.`);
      setBulkOpen(false);
      setBulkPreview(null);
      setSelected([]);
      load();
    } catch (err) {
      toast.push("error", errorMessage(err));
    }
  };

  const allSelected = useMemo(
    () => (data?.items.length ? data.items.every((c) => selected.includes(c.id)) : false),
    [data, selected],
  );

  const items = data?.items ?? [];
  const hasFilters = Boolean(debouncedSearch || status || source || tag);

  return (
    <>
      <PageHeader
        title="Contacts"
        description="Everyone you can reach. Duplicates are blocked by the database, and suppressed contacts are never contacted again."
        actions={
          <>
            <a
              href="/api/contacts/export"
              download
              className="inline-flex h-9 items-center gap-2 rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--surface)] px-3.5 text-[13.5px] font-medium text-[var(--text)] transition-colors hover:bg-[var(--surface-3)]"
            >
              <span aria-hidden>⇩</span>
              Export CSV
            </a>
            <Link
              href="/contacts/import"
              className="inline-flex h-9 items-center gap-2 rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--surface)] px-3.5 text-[13.5px] font-medium text-[var(--text)] transition-colors hover:bg-[var(--surface-3)]"
            >
              <span aria-hidden>⇧</span>
              Import CSV
            </Link>
            <Button onClick={() => setAddOpen(true)}>Add contact</Button>
          </>
        }
      />

      {loadError && (
        <div className="mb-5">
          <ErrorState message={loadError} onRetry={load} />
        </div>
      )}

      <Card padded={false} contentClassName="p-5">
        {/* Filter bar -------------------------------------------------- */}
        <div className="mb-4 flex flex-wrap items-center gap-2.5">
          <div className="min-w-[220px] flex-1">
            <label htmlFor="contact-search" className="sr-only">
              Search contacts
            </label>
            <Input
              id="contact-search"
              type="search"
              placeholder="Search by email, name, company, notes…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="w-40">
            <label htmlFor="contact-status" className="sr-only">
              Filter by status
            </label>
            <Select id="contact-status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
              <option value="">All statuses</option>
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s.replace(/_/g, " ").toLowerCase()}
                </option>
              ))}
            </Select>
          </div>
          <div className="w-40">
            <label htmlFor="contact-stage" className="sr-only">
              Filter by pipeline stage
            </label>
            <Select id="contact-stage" value={stageId} onChange={(e) => { setStageId(e.target.value); setPage(1); }}>
              <option value="">All stages</option>
              {stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </div>
          {data?.sources && data.sources.length > 0 && (
            <div className="w-40">
              <label htmlFor="contact-source" className="sr-only">
                Filter by source
              </label>
              <Select id="contact-source" value={source} onChange={(e) => { setSource(e.target.value); setPage(1); }}>
                <option value="">All sources</option>
                {data.sources.map((s) => (
                  <option key={s ?? ""} value={s ?? ""}>
                    {s}
                  </option>
                ))}
              </Select>
            </div>
          )}
          {hasFilters && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSearch("");
                setStatus("");
                setSource("");
                setTag("");
                setStageId("");
              }}
            >
              Clear
            </Button>
          )}
        </div>

        {/* Select-all + bulk action bar ------------------------------------ */}
        {items.length > 0 && (
          <div className="mb-3 flex items-center gap-2 text-[12.5px] text-[var(--muted)]">
            <input
              type="checkbox"
              id="contact-select-all"
              aria-label="Select every contact on this page"
              checked={allSelected}
              onChange={(e) =>
                setSelected(e.target.checked ? items.map((c) => c.id) : [])
              }
              className="h-4 w-4 cursor-pointer rounded border-[var(--border-strong)] text-[var(--accent)]"
            />
            <label htmlFor="contact-select-all" className="cursor-pointer">
              Select all on this page
            </label>
          </div>
        )}

        {selected.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-3 rounded-[var(--radius)] border border-[var(--accent-border)] bg-[var(--accent-soft)] px-3.5 py-2.5 text-[13px] text-[var(--accent)]">
            <span className="font-medium">{selected.length} selected</span>
            <button onClick={() => setBulkOpen(true)} className="font-medium underline underline-offset-2">
              Bulk update
            </button>
            <button onClick={() => setSelected([])} className="ml-auto font-medium underline underline-offset-2">
              Clear selection
            </button>
          </div>
        )}

        {/* Table ------------------------------------------------------- */}
        {loading && !data ? (
          <div className="flex flex-col gap-3">
            {[...Array(8)].map((_, i) => (
              <Skeleton key={i} className="h-11" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon="☺"
            title={hasFilters ? "No contacts match those filters" : "No contacts yet"}
            description={
              hasFilters
                ? "Try a different search or clear the filters."
                : "Add contacts one at a time, or import a CSV. Duplicates are caught automatically."
            }
            action={
              hasFilters ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    setSearch("");
                    setStatus("");
                    setSource("");
                    setTag("");
                  }}
                >
                  Clear filters
                </Button>
              ) : (
                <Button onClick={() => setAddOpen(true)}>Add contact</Button>
              )
            }
          />
        ) : (
          <>
            <Table headers={["", "Email", "Name", "Company", "Stage", "Status", "Sent", "Added", ""]}>
              {items.map((c) => (
                <tr key={c.id} className="text-[13.5px] transition-colors hover:bg-[var(--surface-2)]">
                  <td className="w-8 px-3 py-3">
                    <input
                      type="checkbox"
                      aria-label={`Select ${c.email}`}
                      checked={selected.includes(c.id)}
                      onChange={(e) =>
                        setSelected((s) =>
                          e.target.checked ? [...s, c.id] : s.filter((x) => x !== c.id),
                        )
                      }
                      className="h-4 w-4 cursor-pointer rounded border-[var(--border-strong)] text-[var(--accent)]"
                    />
                  </td>
                  <td className="px-3 py-3">
                    <Link href={`/contacts/${c.id}`} className="font-medium hover:underline">
                      {c.email}
                    </Link>
                    {c.tags.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {c.tags.slice(0, 3).map((t) => (
                          <span
                            key={t}
                            className="rounded-full bg-[var(--surface-3)] px-2 py-0.5 text-[10.5px] text-[var(--text-secondary)]"
                          >
                            {t}
                          </span>
                        ))}
                        {c.tags.length > 3 && (
                          <span className="text-[10.5px] text-[var(--muted)]">+{c.tags.length - 3}</span>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <span className="block">{[c.firstName, c.lastName].filter(Boolean).join(" ") || "—"}</span>
                    {c.title && <span className="block text-[11.5px] text-[var(--muted)]">{c.title}</span>}
                  </td>
                  <td className="px-3 py-3">
                    {c.company ? (
                      <span>
                        {c.website ? (
                          <a
                            href={c.website.startsWith("http") ? c.website : `https://${c.website}`}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="font-medium text-[var(--accent)] hover:underline"
                          >
                            {c.company}
                          </a>
                        ) : (
                          c.company
                        )}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-3">
                    {stages.find((s) => s.id === c.stageId) ? (
                      <Badge tone="accent">{stages.find((s) => s.id === c.stageId)!.name}</Badge>
                    ) : (
                      <span className="text-[12px] text-[var(--muted-2)]">—</span>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <StatusBadge status={c.status} />
                  </td>
                  <td className="tnum px-3 py-3">
                    {c.sentCount}
                    {c.lastRepliedAt && (
                      <span className="ml-1.5 text-[11px] text-[var(--success)]">· replied</span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-[12px] text-[var(--muted)]">
                    {new Date(c.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-3 py-3 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-[var(--danger)]"
                      onClick={() => setDeleteTarget(c)}
                    >
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </Table>
            <Pagination
              page={data!.page}
              pageSize={data!.pageSize}
              total={data!.total}
              onPage={setPage}
            />
          </>
        )}
      </Card>

      {/* Add contact --------------------------------------------------- */}
      <Modal
        open={addOpen}
        title="Add contact"
        description="Only the email address is required."
        onClose={() => setAddOpen(false)}
        footer={
          <>
            <Button variant="outline" onClick={() => setAddOpen(false)} disabled={addSaving}>
              Cancel
            </Button>
            <Button onClick={submitAdd} loading={addSaving}>
              Add contact
            </Button>
          </>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Email" htmlFor="c-email" error={errs.email} required className="sm:col-span-2">
            <Input
              id="c-email"
              type="email"
              value={form.email}
              invalid={Boolean(errs.email)}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              placeholder="person@example.com"
            />
          </Field>
          <Field label="First name" htmlFor="c-first" error={errs.firstName}>
            <Input id="c-first" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
          </Field>
          <Field label="Last name" htmlFor="c-last" error={errs.lastName}>
            <Input id="c-last" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
          </Field>
          <Field label="Company" htmlFor="c-company" error={errs.company}>
            <Input id="c-company" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
          </Field>
          <Field label="Role" htmlFor="c-title" error={errs.title}>
            <Input id="c-title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </Field>
          <Field label="Website" htmlFor="c-website" error={errs.website}>
            <Input id="c-website" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} placeholder="https://acme.com" />
          </Field>
          <Field
            label="Time zone"
            htmlFor="c-tz"
            error={errs.timeZone}
            hint="IANA name like Asia/Karachi — used to send inside their local window."
          >
            <Input id="c-tz" value={form.timeZone} onChange={(e) => setForm({ ...form, timeZone: e.target.value })} placeholder="Europe/Berlin" />
          </Field>
          <Field label="Country" htmlFor="c-country" error={errs.country}>
            <Input id="c-country" value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} />
          </Field>
          <Field label="Source" htmlFor="c-source" error={errs.source} hint="Where the lead came from.">
            <Input id="c-source" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} placeholder="Referral, LinkedIn…" />
          </Field>
          <Field label="Tags" htmlFor="c-tags" error={errs.tags} hint="Comma separated.">
            <Input id="c-tags" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="saas, agency" />
          </Field>
          <Field label="Notes" htmlFor="c-notes" error={errs.notes} className="sm:col-span-2">
            <Input id="c-notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Context worth remembering" />
          </Field>
        </div>
      </Modal>

      {/* Bulk update --------------------------------------------------- */}
      <Modal
        open={bulkOpen}
        title={`Bulk update ${selected.length} contact${selected.length === 1 ? "" : "s"}`}
        description="Nothing is written until you review the preview."
        onClose={() => {
          setBulkOpen(false);
          setBulkPreview(null);
        }}
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => {
                setBulkOpen(false);
                setBulkPreview(null);
              }}
            >
              Cancel
            </Button>
            {bulkPreview ? (
              <Button onClick={runBulkApply}>
                Apply to {bulkPreview.changed} contact{bulkPreview.changed === 1 ? "" : "s"}
              </Button>
            ) : (
              <Button onClick={runBulkPreview}>Preview changes</Button>
            )}
          </>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Source" htmlFor="bulk-source">
            <Input id="bulk-source" value={bulkForm.source} onChange={(e) => setBulkForm({ ...bulkForm, source: e.target.value })} />
          </Field>
          <Field label="Industry" htmlFor="bulk-industry">
            <Input id="bulk-industry" value={bulkForm.industry} onChange={(e) => setBulkForm({ ...bulkForm, industry: e.target.value })} />
          </Field>
          <Field label="Priority" htmlFor="bulk-priority">
            <Select id="bulk-priority" value={bulkForm.priority} onChange={(e) => setBulkForm({ ...bulkForm, priority: e.target.value })}>
              <option value="">Leave unchanged</option>
              {PRIORITY_OPTIONS.map((p) => (
                <option key={p} value={p}>
                  {p.toLowerCase()}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Pipeline stage" htmlFor="bulk-stage">
            <Select id="bulk-stage" value={bulkForm.stageId} onChange={(e) => setBulkForm({ ...bulkForm, stageId: e.target.value })}>
              <option value="">Leave unchanged</option>
              {stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Add tags" htmlFor="bulk-tags" hint="Comma separated. Existing tags are kept." className="sm:col-span-2">
            <Input id="bulk-tags" value={bulkForm.addTags} onChange={(e) => setBulkForm({ ...bulkForm, addTags: e.target.value })} placeholder="saas, qualified" />
          </Field>
        </div>

        {bulkPreview && (
          <div className="mt-5">
            <p className="mb-2 text-[13px] font-medium">
              {bulkPreview.changed} of {bulkPreview.matched} contact
              {bulkPreview.matched === 1 ? "" : "s"} will change.
            </p>
            <ul className="max-h-48 divide-y divide-[var(--border)] overflow-y-auto rounded-[var(--radius)] border border-[var(--border)]">
              {bulkPreview.preview
                .filter((p) => p.changed)
                .slice(0, 25)
                .map((p) => (
                  <li key={p.id} className="px-3 py-2 text-[12.5px]">
                    <p className="font-medium">{p.email}</p>
                    <p className="text-[var(--muted)]">
                      {Object.entries(p.after)
                        .map(([k, v]) => `${k}: ${String(p.before[k] ?? "—")} → ${String(v)}`)
                        .join(" · ")}
                    </p>
                  </li>
                ))}
            </ul>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Remove contact"
        message={
          <>
            Remove <strong>{deleteTarget?.email}</strong>? They are marked invalid, every pending
            message is cancelled, and they are excluded from future targeting. The history is kept.
          </>
        }
        confirmLabel="Remove contact"
        loading={deleting}
        onConfirm={confirmDelete}
        onClose={() => setDeleteTarget(null)}
      />
    </>
  );
}
