"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Input,
  Pagination,
  Select,
  Skeleton,
  StatusBadge,
  Table,
} from "@/components/ui";
import { PageHeader } from "@/components/AppShell";
import { useToast } from "@/components/ui/Toast";
import { api, errorMessage } from "@/lib/client/api";

type Campaign = {
  id: string;
  name: string;
  status: "DRAFT" | "ACTIVE" | "PAUSED" | "COMPLETED" | "CANCELLED" | "ARCHIVED";
  subject: string;
  isArchived: boolean;
  dryRun: boolean;
  requiresApproval: boolean;
  approvedAt: string | null;
  serviceId: string | null;
  service?: { id: string; name: string; color: string } | null;
  followUpSequence?: { id: string; name: string } | null;
  dailyCap?: number;
  createdAt: string;
  _count: { recipients: number; sendJobs: number; replies: number };
};

type Service = { id: string; name: string; color: string };

type CampaignsResponse = {
  total: number;
  page: number;
  pageSize: number;
  items: Campaign[];
};

const STATUS_OPTIONS = ["DRAFT", "ACTIVE", "PAUSED", "COMPLETED", "CANCELLED", "ARCHIVED"] as const;

export default function CampaignsPage() {
  const router = useRouter();
  const toast = useToast();

  const [data, setData] = useState<CampaignsResponse | null>(null);
  const [services, setServices] = useState<Service[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [status, setStatus] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [page, setPage] = useState(1);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Campaign | null>(null);
  const [cancelling, setCancelling] = useState(false);

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
    if (serviceId) params.set("serviceId", serviceId);
    if (showArchived) params.set("archived", "true");
    api<CampaignsResponse>(`/api/campaigns?${params.toString()}`)
      .then((d) => {
        setData(d);
        setLoadError(null);
      })
      .catch((err) => setLoadError(errorMessage(err)));
  }, [page, debouncedSearch, status, serviceId, showArchived]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api<{ services: Service[] }>("/api/services")
      .then((d) => setServices(d.services))
      .catch(() => setServices([]));
  }, []);

  const runAction = async (campaign: Campaign, action: "pause" | "resume" | "duplicate" | "approve" | "archive") => {
    setBusyId(campaign.id);
    try {
      if (action === "duplicate") {
        await api(`/api/campaigns/${campaign.id}/duplicate`, {
          method: "POST",
          body: JSON.stringify({ includeContacts: true }),
        });
        toast.push("success", `Duplicated “${campaign.name}”.`);
      } else if (action === "archive") {
        await api(`/api/campaigns/${campaign.id}/archive`, { method: "POST" });
        toast.push("success", `Archived “${campaign.name}”.`);
      } else if (action === "approve") {
        await api(`/api/campaigns/${campaign.id}/approve`, {
          method: "POST",
          body: JSON.stringify({ approved: true }),
        });
        toast.push("success", `Approved “${campaign.name}”.`);
      } else {
        await api(`/api/campaigns/${campaign.id}/${action}`, { method: "POST" });
        toast.push("success", action === "pause" ? `Paused “${campaign.name}”.` : `Resumed “${campaign.name}”.`);
      }
      load();
    } catch (err) {
      toast.push("error", errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const confirmCancel = async () => {
    if (!cancelTarget) return;
    setCancelling(true);
    try {
      await api(`/api/campaigns/${cancelTarget.id}`, { method: "DELETE" });
      toast.push("success", `Cancelled “${cancelTarget.name}”.`);
      setCancelTarget(null);
      load();
    } catch (err) {
      toast.push("error", errorMessage(err));
    } finally {
      setCancelling(false);
    }
  };

  const items = data?.items ?? [];

  return (
    <>
      <PageHeader
        title="Campaigns"
        description="Every campaign and its current state."
        actions={<Button onClick={() => router.push("/campaigns/new")}>New campaign</Button>}
      />

      {loadError && (
        <div role="alert" className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {loadError}
        </div>
      )}

      <Card>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="min-w-56 flex-1">
            <label htmlFor="campaign-search" className="sr-only">
              Search campaigns
            </label>
            <Input
              id="campaign-search"
              type="search"
              placeholder="Search by name or subject…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="w-48">
            <label htmlFor="campaign-status" className="sr-only">
              Filter by status
            </label>
            <Select id="campaign-status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
              <option value="">All statuses</option>
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </div>
          {services.length > 0 && (
            <div className="w-52">
              <label htmlFor="campaign-service" className="sr-only">
                Filter by service
              </label>
              <Select
                id="campaign-service"
                value={serviceId}
                onChange={(e) => {
                  setServiceId(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">All services</option>
                {services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => {
                setShowArchived(e.target.checked);
                setPage(1);
              }}
              className="h-4 w-4"
            />
            Show archived
          </label>
        </div>

        {!data && !loadError ? (
          <div className="flex flex-col gap-3">
            {[...Array(6)].map((_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            title="No campaigns yet"
            description="Create a campaign, add recipients, and the worker will send inside each recipient's local window."
            action={<Button onClick={() => router.push("/campaigns/new")}>New campaign</Button>}
          />
        ) : (
          <>
            <Table headers={["Name", "Service", "Status", "Recipients", "Replies", "Created", ""]}>
              {items.map((c) => (
                <tr
                  key={c.id}
                  className="cursor-pointer text-sm hover:bg-black/5 dark:hover:bg-white/5"
                  onClick={() => router.push(`/campaigns/${c.id}`)}
                >
                  <td className="px-3 py-2.5">
                    <p className="font-medium">{c.name}</p>
                    <p className="max-w-md truncate text-xs text-[var(--muted)]">{c.subject}</p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {c.dryRun && <StatusBadge status="DRY RUN" />}
                      {c.requiresApproval && !c.approvedAt && <StatusBadge status="NEEDS APPROVAL" />}
                      {c.followUpSequence && (
                        <span className="text-[11px] text-[var(--muted)]">
                          ↻ {c.followUpSequence.name}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-xs">
                    {c.service ? (
                      <span className="flex items-center gap-1.5">
                        <span
                          aria-hidden
                          className="h-2.5 w-2.5 rounded-full"
                          style={{ background: c.service.color }}
                        />
                        {c.service.name}
                      </span>
                    ) : (
                      <span className="text-[var(--muted)]">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <StatusBadge status={c.status} />
                  </td>
                  <td className="px-3 py-2.5 tabular-nums">{c._count.recipients.toLocaleString()}</td>
                  <td className="px-3 py-2.5 tabular-nums">{c._count.replies ?? 0}</td>
                  <td className="px-3 py-2.5 text-xs text-[var(--muted)]">{new Date(c.createdAt).toLocaleDateString()}</td>
                  <td className="px-3 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                    <div className="flex justify-end gap-1">
                      {c.requiresApproval && !c.approvedAt && (
                        <Button variant="ghost" loading={busyId === c.id} onClick={() => runAction(c, "approve")}>
                          Approve
                        </Button>
                      )}
                      <Button variant="ghost" loading={busyId === c.id} onClick={() => runAction(c, "duplicate")}>
                        Duplicate
                      </Button>
                      {c.status === "ACTIVE" && (
                        <Button variant="ghost" loading={busyId === c.id} onClick={() => runAction(c, "pause")}>
                          Pause
                        </Button>
                      )}
                      {c.status === "PAUSED" && (
                        <Button variant="ghost" loading={busyId === c.id} onClick={() => runAction(c, "resume")}>
                          Resume
                        </Button>
                      )}
                      {c.isArchived ? (
                        <Button
                          variant="ghost"
                          loading={busyId === c.id}
                          onClick={() =>
                            api(`/api/campaigns/${c.id}/archive?action=restore`, { method: "POST" })
                              .then(() => {
                                toast.push("success", "Restored.");
                                load();
                              })
                              .catch((err) => toast.push("error", errorMessage(err)))
                          }
                        >
                          Restore
                        </Button>
                      ) : (
                        ["DRAFT", "PAUSED", "COMPLETED"].includes(c.status) && (
                          <Button variant="ghost" loading={busyId === c.id} onClick={() => runAction(c, "archive")}>
                            Archive
                          </Button>
                        )
                      )}
                      {["DRAFT", "ACTIVE", "PAUSED"].includes(c.status) && (
                        <Button variant="ghost" className="text-red-600 dark:text-red-400" onClick={() => setCancelTarget(c)}>
                          Cancel
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </Table>
            {data && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
          </>
        )}
      </Card>

      <ConfirmDialog
        open={cancelTarget !== null}
        title="Cancel campaign"
        message={`Cancel “${cancelTarget?.name ?? ""}”? This cancels all queued sends for the campaign. Sent emails cannot be recalled.`}
        confirmLabel="Cancel campaign"
        loading={cancelling}
        onConfirm={confirmCancel}
        onClose={() => setCancelTarget(null)}
      />
    </>
  );
}
