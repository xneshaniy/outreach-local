"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
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
  status: "ACTIVE" | "UNSUBSCRIBED" | "BOUNCED" | "COMPLAINED" | "INVALID";
  sentCount: number;
  lastSentAt: string | null;
  createdAt: string;
};

type ContactsResponse = {
  total: number;
  page: number;
  pageSize: number;
  items: Contact[];
};

const STATUS_OPTIONS = ["ACTIVE", "UNSUBSCRIBED", "BOUNCED", "COMPLAINED", "INVALID"] as const;

const EMPTY_FORM = {
  email: "",
  firstName: "",
  lastName: "",
  company: "",
  website: "",
  title: "",
  timeZone: "",
  country: "",
};

export default function ContactsPage() {
  const toast = useToast();

  const [data, setData] = useState<ContactsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [status, setStatus] = useState("");
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
    api<ContactsResponse>(`/api/contacts?${params.toString()}`)
      .then((d) => {
        setData(d);
        setLoadError(null);
      })
      .catch((err) => setLoadError(errorMessage(err)));
  }, [page, debouncedSearch, status]);

  useEffect(() => {
    load();
  }, [load]);

  const submitAdd = async () => {
    setAddSaving(true);
    setErrs({});
    try {
      const body: Record<string, unknown> = { email: form.email.trim() };
      for (const key of ["firstName", "lastName", "company", "website", "title", "timeZone", "country"] as const) {
        if (form[key].trim()) body[key] = form[key].trim();
      }
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
              <Table headers={["Email", "Name", "Company", "Time zone", "Status", "Sent", "Added", ""]}>
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
                    <td className="px-3 py-2.5 text-xs text-[var(--muted)]">{c.timeZone ?? "—"}</td>
                    <td className="px-3 py-2.5">
                      <StatusBadge status={c.status} />
                    </td>
                    <td className="px-3 py-2.5 tabular-nums">
                      {c.sentCount}
                      {c.lastSentAt && (
                        <span className="ml-1 text-xs text-[var(--muted)]">· last {new Date(c.lastSentAt).toLocaleDateString()}</span>
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
