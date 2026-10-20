"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
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

type Contact = {
  id: string;
  email: string;
  emailNormalized: string;
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
  status: "ACTIVE" | "UNSUBSCRIBED" | "BOUNCED" | "COMPLAINED" | "INVALID" | "REPLIED" | "INTERESTED";
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

const STATUS_OPTIONS = [
  "ACTIVE",
  "REPLIED",
  "INTERESTED",
  "UNSUBSCRIBED",
  "BOUNCED",
  "COMPLAINED",
  "INVALID",
] as const;

const EMPTY_FORM = {
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
  const [loadError, setLoadError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [status, setStatus] = useState("");
  const [source, setSource] = useState("");
  const [page, setPage] = useState(1);

  // Add contact modal
  const [addOpen, setAddOpen] = useState(false);
  const [addSaving, setAddSaving] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [errs, setErrs] = useState<Record<string, string>>({});

  // Delete
  const [deleteTarget, setDeleteTarget] = useState<Contact | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: "20" });
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (status) params.set("status", status);
    if (source) params.set("source", source);
    api<ContactsResponse>(`/api/contacts?${params.toString()}`)
      .then((d) => {
        setData(d);
        setLoadError(null);
      })
      .catch((err) => setLoadError(errorMessage(err)));
  }, [page, debouncedSearch, status, source]);

  useEffect(() => {
    load();
  }, [load]);

  const exportUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (status) params.set("status", status);
    if (source) params.set("source", source);
    const q = params.toString();
    return `/api/contacts/export${q ? `?${q}` : ""}`;
  }, [debouncedSearch, status, source]);

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
      setForm(EMPTY_FORM);
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
      toast.push("success", `${deleteTarget.email} deleted.`);
      setDeleteTarget(null);
      load();
    } catch (err) {
      toast.push("error", errorMessage(err));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Contacts"
        description="Everyone you can reach. Duplicates are blocked by the database."
        actions={
          <>
            <a
              href={exportUrl}
              download
              className="inline-flex items-center rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2 text-sm font-medium hover:bg-black/5 dark:hover:bg-white/5"
            >
              Export CSV
            </a>
            <Link
              href="/contacts/import"
              className="inline-flex items-center rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2 text-sm font-medium hover:bg-black/5 dark:hover:bg-white/5"
            >
              Import CSV
            </Link>
            <Button onClick={() => setAddOpen(true)}>Add contact</Button>
          </>
        }
      />

      {loadError && (
        <div role="alert" className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {loadError}
        </div>
      )}

      <Card>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="min-w-56 flex-1">
            <label htmlFor="contact-search" className="sr-only">
              Search contacts
            </label>
            <Input
              id="contact-search"
              type="search"
              placeholder="Search by email, name, or company…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="w-48">
            <label htmlFor="contact-status" className="sr-only">
              Filter by status
            </label>
            <Select id="contact-status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
              <option value="">All statuses</option>
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </div>
          {data?.sources && data.sources.length > 0 && (
            <div className="w-48">
              <label htmlFor="contact-source" className="sr-only">
                Filter by source
              </label>
              <Select
                id="contact-source"
                value={source}
                onChange={(e) => {
                  setSource(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">All sources</option>
                {data.sources.map((s) => (
                  <option key={s ?? ""} value={s ?? ""}>
                    {s}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </div>

        {!data && !loadError ? (
          <div className="flex flex-col gap-3">
            {[...Array(8)].map((_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : data && data.items.length === 0 ? (
          <EmptyState
            title="No contacts found"
            description={debouncedSearch || status ? "Try a different search or filter." : "Add contacts one at a time or import a CSV to get started."}
            action={
              <Button
                onClick={() => {
                  setForm(EMPTY_FORM);
                  setAddOpen(true);
                }}
              >
                Add contact
              </Button>
            }
          />
        ) : (
          data && (
            <>
              <Table headers={["Email", "Name", "Company", "Source", "Tags", "Time zone", "Status", "Sent", "Added", ""]}>
                {data.items.map((c) => (
                  <tr key={c.id} className="text-sm">
                    <td className="px-3 py-2.5">
                      <p className="font-medium">{c.email}</p>
                      {c.title && <p className="text-xs text-[var(--muted)]">{c.title}</p>}
                    </td>
                    <td className="px-3 py-2.5">
                      {[c.firstName, c.lastName].filter(Boolean).join(" ") || "—"}
                    </td>
                    <td className="px-3 py-2.5">
                      {c.company ? (
                        <span>
                          {c.company}
                          {c.website && (
                            <span className="ml-1 text-xs text-[var(--muted)]">({c.website})</span>
                          )}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-[var(--muted)]">{c.source ?? "—"}</td>
                    <td className="px-3 py-2.5">
                      {c.tags.length > 0 ? (
                        <span className="flex flex-wrap gap-1">
                          {c.tags.slice(0, 3).map((t) => (
                            <span
                              key={t}
                              className="rounded-full bg-black/5 px-2 py-0.5 text-[11px] dark:bg-white/10"
                            >
                              {t}
                            </span>
                          ))}
                          {c.tags.length > 3 && (
                            <span className="text-[11px] text-[var(--muted)]">+{c.tags.length - 3}</span>
                          )}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-[var(--muted)]">{c.timeZone ?? "—"}</td>
                    <td className="px-3 py-2.5">
                      <StatusBadge status={c.status} />
                    </td>
                    <td className="px-3 py-2.5 tabular-nums">
                      {c.sentCount}
                      {c.lastSentAt && (
                        <span className="ml-1 text-xs text-[var(--muted)]">· last {new Date(c.lastSentAt).toLocaleDateString()}</span>
                      )}
                      {c.lastRepliedAt && (
                        <span className="ml-1 text-xs text-emerald-600 dark:text-emerald-400">
                          · replied {new Date(c.lastRepliedAt).toLocaleDateString()}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-[var(--muted)]">{new Date(c.createdAt).toLocaleDateString()}</td>
                    <td className="px-3 py-2.5 text-right">
                      <Button variant="ghost" className="text-red-600 dark:text-red-400" onClick={() => setDeleteTarget(c)}>
                        Delete
                      </Button>
                    </td>
                  </tr>
                ))}
              </Table>
              <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
            </>
          )
        )}
      </Card>

      {/* Add contact modal */}
      <Modal
        open={addOpen}
        title="Add contact"
        onClose={() => setAddOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setAddOpen(false)} disabled={addSaving}>
              Cancel
            </Button>
            <Button onClick={submitAdd} loading={addSaving}>
              Add contact
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label="Email" htmlFor="c-email" error={errs.email}>
            <Input
              id="c-email"
              type="email"
              value={form.email}
              invalid={Boolean(errs.email)}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              placeholder="person@example.com"
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="First name" htmlFor="c-first" error={errs.firstName}>
              <Input id="c-first" value={form.firstName} onChange={(e) => setForm((f) => ({ ...f, firstName: e.target.value }))} />
            </Field>
            <Field label="Last name" htmlFor="c-last" error={errs.lastName}>
              <Input id="c-last" value={form.lastName} onChange={(e) => setForm((f) => ({ ...f, lastName: e.target.value }))} />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Company" htmlFor="c-company" error={errs.company}>
              <Input id="c-company" value={form.company} onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))} />
            </Field>
            <Field label="Website" htmlFor="c-website" error={errs.website}>
              <Input id="c-website" value={form.website} onChange={(e) => setForm((f) => ({ ...f, website: e.target.value }))} placeholder="https://acme.com" />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Title" htmlFor="c-title" error={errs.title}>
              <Input id="c-title" value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
            </Field>
            <Field label="Country" htmlFor="c-country" error={errs.country}>
              <Input id="c-country" value={form.country} onChange={(e) => setForm((f) => ({ ...f, country: e.target.value }))} />
            </Field>
          </div>
          <Field
            label="Time zone"
            htmlFor="c-tz"
            error={errs.timeZone}
            hint="IANA name like Asia/Karachi — used to send inside the recipient's local window."
          >
            <Input id="c-tz" value={form.timeZone} onChange={(e) => setForm((f) => ({ ...f, timeZone: e.target.value }))} placeholder="Europe/Berlin" />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Source" htmlFor="c-source" error={errs.source} hint="Where the lead came from.">
              <Input id="c-source" value={form.source} onChange={(e) => setForm((f) => ({ ...f, source: e.target.value }))} placeholder="Referral, LinkedIn, webinar…" />
            </Field>
            <Field label="Tags" htmlFor="c-tags" error={errs.tags} hint="Comma separated.">
              <Input id="c-tags" value={form.tags} onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))} placeholder="saas, agency, high-value" />
            </Field>
          </div>
          <Field label="Notes" htmlFor="c-notes" error={errs.notes}>
            <Input id="c-notes" value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="Context you want to remember about this lead" />
          </Field>
        </div>
      </Modal>

      {/* Delete confirm */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete contact"
        message={`Delete ${deleteTarget?.email ?? ""}? They will be removed from all lists and future campaign targeting. Pending sends for this contact are cancelled.`}
        confirmLabel="Delete"
        loading={deleting}
        onConfirm={confirmDelete}
        onClose={() => setDeleteTarget(null)}
      />
    </>
  );
}
