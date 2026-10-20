"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  StatusBadge,
  Table,
} from "@/components/ui";
import { useToast } from "@/components/ui/Toast";
import { PageHeader } from "@/components/AppShell";
import { api, errorMessage, fieldErrors } from "@/lib/client/api";

/**
 * Client accounts (owner only).
 *
 * A client is a separate login that can only see the campaigns assigned to
 * it. The password is set here, hashed with bcrypt, and never shown again.
 */

type ClientAccount = {
  id: string;
  email: string;
  name: string;
  company: string | null;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  _count?: { campaignAccess: number };
};

type Assignment = { id: string; campaignId: string; campaign: { id: string; name: string; status: string } };

const BLANK = { email: "", password: "", name: "", company: "" };

export default function ClientsPage() {
  const toast = useToast();
  const [clients, setClients] = useState<ClientAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ ...BLANK });
  const [saving, setSaving] = useState(false);
  const [errs, setErrs] = useState<Record<string, string>>({});

  const [assignFor, setAssignFor] = useState<ClientAccount | null>(null);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [campaigns, setCampaigns] = useState<Array<{ id: string; name: string }>>([]);
  const [campaignId, setCampaignId] = useState("");

  const [deleteTarget, setDeleteTarget] = useState<ClientAccount | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api<{ clients: ClientAccount[] }>("/api/clients")
      .then((d) => setClients(d.clients))
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const submitAdd = async () => {
    setSaving(true);
    setErrs({});
    try {
      await api("/api/clients", {
        method: "POST",
        body: JSON.stringify({
          email: form.email.trim(),
          password: form.password,
          name: form.name.trim(),
          company: form.company.trim() || null,
        }),
      });
      toast.push("success", "Client account created.");
      setAddOpen(false);
      setForm({ ...BLANK });
      load();
    } catch (err) {
      setErrs(fieldErrors(err));
      toast.push("error", errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const openAssign = async (client: ClientAccount) => {
    setAssignFor(client);
    setCampaignId("");
    try {
      const [assigned, all] = await Promise.all([
        api<{ assignments: Assignment[] }>(`/api/clients/${client.id}/campaigns`),
        api<{ campaigns: Array<{ id: string; name: string }> }>("/api/campaigns?pageSize=100"),
      ]);
      setAssignments(assigned.assignments);
      setCampaigns(all.campaigns);
    } catch (err) {
      toast.push("error", errorMessage(err));
    }
  };

  const assign = async () => {
    if (!assignFor || !campaignId) return;
    try {
      await api(`/api/clients/${assignFor.id}/campaigns`, {
        method: "POST",
        body: JSON.stringify({ campaignId }),
      });
      toast.push("success", "Campaign assigned.");
      setCampaignId("");
      const refreshed = await api<{ assignments: Assignment[] }>(`/api/clients/${assignFor.id}/campaigns`);
      setAssignments(refreshed.assignments);
      load();
    } catch (err) {
      toast.push("error", errorMessage(err));
    }
  };

  const unassign = async (campaignId: string) => {
    if (!assignFor) return;
    try {
      await api(`/api/clients/${assignFor.id}/campaigns?campaignId=${campaignId}`, { method: "DELETE" });
      setAssignments((a) => a.filter((x) => x.campaignId !== campaignId));
      toast.push("success", "Campaign unassigned.");
      load();
    } catch (err) {
      toast.push("error", errorMessage(err));
    }
  };

  const toggleActive = async (client: ClientAccount) => {
    try {
      await api(`/api/clients/${client.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !client.isActive }),
      });
      load();
    } catch (err) {
      toast.push("error", errorMessage(err));
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api(`/api/clients/${deleteTarget.id}`, { method: "DELETE" });
      toast.push("success", "Client removed.");
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
        title="Clients"
        description="Separate portal logins. Each client only sees the campaigns you assign to them."
        actions={<Button onClick={() => setAddOpen(true)}>Add client</Button>}
      />

      {error && (
        <div role="alert" className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      <Card>
        {loading ? (
          <p className="text-sm text-[var(--muted)]">Loading clients…</p>
        ) : clients.length === 0 ? (
          <EmptyState
            title="No client accounts yet"
            description="Create a client login so your customer can see their own campaign performance — and nothing else."
            action={<Button onClick={() => setAddOpen(true)}>Add client</Button>}
          />
        ) : (
          <Table headers={["Client", "Company", "Campaigns", "Last seen", "Status", ""]}>
            {clients.map((c) => (
              <tr key={c.id} className="text-sm">
                <td className="px-3 py-2.5">
                  <p className="font-medium">{c.name}</p>
                  <p className="text-xs text-[var(--muted)]">{c.email}</p>
                </td>
                <td className="px-3 py-2.5">{c.company ?? "—"}</td>
                <td className="px-3 py-2.5 tabular-nums">{c._count?.campaignAccess ?? 0}</td>
                <td className="px-3 py-2.5 text-xs text-[var(--muted)]">
                  {c.lastLoginAt ? new Date(c.lastLoginAt).toLocaleDateString() : "Never"}
                </td>
                <td className="px-3 py-2.5">
                  <StatusBadge status={c.isActive ? "ACTIVE" : "DISABLED"} />
                </td>
                <td className="px-3 py-2.5 text-right">
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" onClick={() => openAssign(c)}>
                      Campaigns
                    </Button>
                    <Button variant="ghost" onClick={() => toggleActive(c)}>
                      {c.isActive ? "Disable" : "Enable"}
                    </Button>
                    <Button
                      variant="ghost"
                      className="text-red-600 dark:text-red-400"
                      onClick={() => setDeleteTarget(c)}
                    >
                      Remove
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {/* Add client */}
      <Modal
        open={addOpen}
        title="Add client"
        onClose={() => setAddOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setAddOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={submitAdd} loading={saving}>
              Create client
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Name" htmlFor="cl-name" error={errs.name}>
            <Input id="cl-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Email (used to sign in)" htmlFor="cl-email" error={errs.email}>
            <Input id="cl-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </Field>
          <Field label="Company" htmlFor="cl-company" error={errs.company}>
            <Input id="cl-company" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
          </Field>
          <Field
            label="Password"
            htmlFor="cl-password"
            error={errs.password}
            hint="At least 10 characters. Share it with the client securely."
          >
            <Input
              id="cl-password"
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </Field>
        </div>
      </Modal>

      {/* Assign campaigns */}
      <Modal
        open={assignFor !== null}
        title={`Campaigns for ${assignFor?.name ?? ""}`}
        onClose={() => setAssignFor(null)}
        footer={
          <Button variant="secondary" onClick={() => setAssignFor(null)}>
            Done
          </Button>
        }
      >
        <p className="mb-3 text-xs text-[var(--muted)]">
          The client can only see the campaigns listed here.
        </p>
        <div className="mb-4 flex gap-2">
          <Select
            value={campaignId}
            onChange={(e) => setCampaignId(e.target.value)}
            className="flex-1"
          >
            <option value="">Choose a campaign…</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <Button onClick={assign} disabled={!campaignId}>
            Assign
          </Button>
        </div>
        {assignments.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No campaigns assigned yet.</p>
        ) : (
          <ul className="divide-y divide-[var(--border)] text-sm">
            {assignments.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-2 py-2">
                <span className="truncate">{a.campaign.name}</span>
                <span className="flex items-center gap-2">
                  <StatusBadge status={a.campaign.status} />
                  <Button variant="ghost" onClick={() => unassign(a.campaignId)}>
                    Remove
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Remove client"
        message={`Remove ${deleteTarget?.name ?? ""}? Their portal access and campaign assignments are deleted. The campaigns themselves are kept.`}
        confirmLabel="Remove"
        loading={deleting}
        onConfirm={confirmDelete}
        onClose={() => setDeleteTarget(null)}
      />
    </>
  );
}
