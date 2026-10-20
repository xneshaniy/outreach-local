"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Badge,
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
  Table,
} from "@/components/ui";
import { PageHeader } from "@/components/AppShell";
import { useToast } from "@/components/ui/Toast";
import { api, errorMessage, fieldErrors } from "@/lib/client/api";

type Suppression = {
  id: string;
  scope: "GLOBAL" | "CAMPAIGN";
  emailNormalized: string;
  reason: string;
  source: string;
  createdAt: string;
  campaign: { id: string; name: string } | null;
};

type SuppressionsResponse = {
  total: number;
  page: number;
  pageSize: number;
  items: Suppression[];
};

type CampaignOption = { id: string; name: string; status: string };

const REASONS = ["UNSUBSCRIBE", "BOUNCE", "HARD_BOUNCE", "COMPLAINT", "MANUAL"] as const;

function removalWarning(s: Suppression): string {
  if (s.reason === "UNSUBSCRIBE") {
    return `${s.emailNormalized} unsubscribed. Removing this suppression is strongly discouraged — if they are re-added to a campaign they will be emailed again without consent.`;
  }
  if (s.reason === "BOUNCE" || s.reason === "HARD_BOUNCE") {
    return `${s.emailNormalized} bounced. Removing this suppression risks further bounces that damage sender reputation.`;
  }
  if (s.reason === "COMPLAINT") {
    return `${s.emailNormalized} filed a spam complaint. Removing this suppression may violate anti-spam obligations.`;
  }
  return `Remove the manual suppression for ${s.emailNormalized}? This person will be emailed again if re-added to a campaign manually.`;
}

export default function SuppressionsPage() {
  const toast = useToast();

  const [data, setData] = useState<SuppressionsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [scope, setScope] = useState("");
  const [page, setPage] = useState(1);

  // Add modal
  const [addOpen, setAddOpen] = useState(false);
  const [addSaving, setAddSaving] = useState(false);
  const [form, setForm] = useState({ email: "", scope: "GLOBAL" as "GLOBAL" | "CAMPAIGN", campaignId: "", reason: "MANUAL" });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [campaigns, setCampaigns] = useState<CampaignOption[]>([]);

  // Remove
  const [removeTarget, setRemoveTarget] = useState<Suppression | null>(null);
  const [removing, setRemoving] = useState(false);

  const load = useCallback(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: "50" });
    if (scope) params.set("scope", scope);
    api<SuppressionsResponse>(`/api/suppressions?${params.toString()}`)
      .then((d) => {
        setData(d);
        setLoadError(null);
      })
      .catch((err) => setLoadError(errorMessage(err)));
  }, [page, scope]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!addOpen) return;
    api<{ items: CampaignOption[] }>("/api/campaigns?pageSize=100")
      .then((d) => setCampaigns(d.items))
      .catch(() => undefined);
  }, [addOpen]);

  const submitAdd = async () => {
    setAddSaving(true);
    setErrs({});
    try {
      const body: Record<string, unknown> = { email: form.email.trim(), scope: form.scope, reason: form.reason };
      if (form.scope === "CAMPAIGN") body.campaignId = form.campaignId;
      const res = await api<{ created: boolean }>("/api/suppressions", { method: "POST", body: JSON.stringify(body) });
      toast.push(
        "success",
        res.created ? `${form.email.trim()} suppressed.` : `${form.email.trim()} was already suppressed — no change.`,
      );
      setAddOpen(false);
      setForm({ email: "", scope: "GLOBAL", campaignId: "", reason: "MANUAL" });
      load();
    } catch (err) {
      setErrs(fieldErrors(err));
      toast.push("error", errorMessage(err));
    } finally {
      setAddSaving(false);
    }
  };

  const confirmRemove = async () => {
    if (!removeTarget) return;
    setRemoving(true);
    try {
      await api("/api/suppressions", { method: "DELETE", body: JSON.stringify({ id: removeTarget.id }) });
      toast.push("success", `Suppression removed for ${removeTarget.emailNormalized}.`);
      setRemoveTarget(null);
      load();
    } catch (err) {
      toast.push("error", errorMessage(err));
    } finally {
      setRemoving(false);
    }
  };

  const items = data?.items ?? [];

  return (
    <>
      <PageHeader
        title="Suppressions"
        description="People who must never be emailed. Kept even if a CSV re-imports them."
        actions={<Button onClick={() => setAddOpen(true)}>Add suppression</Button>}
      />

      {loadError && (
        <div role="alert" className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {loadError}
        </div>
      )}

      <Card
        actions={
          <div className="w-44">
            <label htmlFor="scope" className="sr-only">
              Filter by scope
            </label>
            <Select
              id="scope"
              value={scope}
              onChange={(e) => {
                setScope(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All scopes</option>
              <option value="GLOBAL">Global</option>
              <option value="CAMPAIGN">Per campaign</option>
            </Select>
          </div>
        }
      >
        {!data && !loadError ? (
          <div className="flex flex-col gap-3">
            {[...Array(8)].map((_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            title="No suppressions"
            description="Unsubscribes and bounces land here automatically. You can also add addresses manually."
            action={<Button onClick={() => setAddOpen(true)}>Add suppression</Button>}
          />
        ) : (
          <>
            <Table headers={["Email", "Scope", "Reason", "Source", "Added", ""]}>
              {items.map((s) => (
                <tr key={s.id} className="text-sm">
                  <td className="px-3 py-2.5 font-medium">{s.emailNormalized}</td>
                  <td className="px-3 py-2.5">
                    {s.scope === "GLOBAL" ? (
                      <Badge tone="red">Global</Badge>
                    ) : (
                      <Badge tone="amber">Campaign</Badge>
                    )}
                    {s.campaign && <span className="ml-1 text-xs text-[var(--muted)]">{s.campaign.name}</span>}
                  </td>
                  <td className="px-3 py-2.5">
                    <Badge tone={s.reason === "UNSUBSCRIBE" ? "purple" : "neutral"}>{s.reason.replace(/_/g, " ")}</Badge>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-[var(--muted)]">{s.source}</td>
                  <td className="px-3 py-2.5 text-xs text-[var(--muted)]">{new Date(s.createdAt).toLocaleDateString()}</td>
                  <td className="px-3 py-2.5 text-right">
                    <Button variant="ghost" className="text-red-600 dark:text-red-400" onClick={() => setRemoveTarget(s)}>
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </Table>
            {data && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
          </>
        )}
      </Card>

      {/* Add modal */}
      <Modal
        open={addOpen}
        title="Add suppression"
        onClose={() => setAddOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setAddOpen(false)} disabled={addSaving}>
              Cancel
            </Button>
            <Button onClick={submitAdd} loading={addSaving}>
              Suppress
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label="Email" htmlFor="sup-email" error={errs.email}>
            <Input
              id="sup-email"
              type="email"
              value={form.email}
              invalid={Boolean(errs.email)}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              placeholder="person@example.com"
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Scope" htmlFor="sup-scope" error={errs.scope} hint="Global blocks every campaign.">
              <Select
                id="sup-scope"
                value={form.scope}
                onChange={(e) => setForm((f) => ({ ...f, scope: e.target.value as "GLOBAL" | "CAMPAIGN" }))}
              >
                <option value="GLOBAL">Global</option>
                <option value="CAMPAIGN">Campaign</option>
              </Select>
            </Field>
            <Field label="Reason" htmlFor="sup-reason" error={errs.reason}>
              <Select id="sup-reason" value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}>
                {REASONS.map((r) => (
                  <option key={r} value={r}>
                    {r.replace(/_/g, " ")}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {form.scope === "CAMPAIGN" && (
            <Field label="Campaign" htmlFor="sup-campaign" error={errs.campaignId}>
              <Select
                id="sup-campaign"
                value={form.campaignId}
                onChange={(e) => setForm((f) => ({ ...f, campaignId: e.target.value }))}
              >
                <option value="">— choose a campaign —</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
      </Modal>

      {/* Remove confirm */}
      <ConfirmDialog
        open={removeTarget !== null}
        title="Remove suppression"
        message={removeTarget ? removalWarning(removeTarget) : ""}
        confirmLabel="Remove suppression"
        loading={removing}
        onConfirm={confirmRemove}
        onClose={() => setRemoveTarget(null)}
      />
    </>
  );
}
