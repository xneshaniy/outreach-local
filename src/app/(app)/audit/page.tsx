"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Card, Input, Pagination, Skeleton, Table } from "@/components/ui";
import { PageHeader } from "@/components/AppShell";
import { api, errorMessage } from "@/lib/client/api";

type AuditEntry = {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: unknown;
  ip: string | null;
  createdAt: string;
};

type AuditResponse = {
  total: number;
  page: number;
  pageSize: number;
  items: AuditEntry[];
};

type Health = {
  status: string;
  version: string;
  environment: string;
  database: "up" | "down";
  queue: Record<string, number>;
  uptimeSeconds: number;
  latencyMs: number;
  timestamp: string;
};

function healthTone(status: string): "green" | "amber" | "red" {
  const s = status.toLowerCase();
  if (s === "ok" || s === "healthy" || s === "up") return "green";
  if (s === "degraded" || s === "warn") return "amber";
  return "red";
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

export default function AuditPage() {
  // --- Audit log ---
  const [audit, setAudit] = useState<AuditResponse | null>(null);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [action, setAction] = useState("");
  const [debouncedAction, setDebouncedAction] = useState("");
  const [page, setPage] = useState(1);

  // --- System health ---
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedAction(action);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [action]);

  const loadAudit = useCallback(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: "25" });
    if (debouncedAction) params.set("action", debouncedAction);
    api<AuditResponse>(`/api/audit?${params.toString()}`)
      .then((d) => {
        setAudit(d);
        setAuditError(null);
      })
      .catch((err) => setAuditError(errorMessage(err)));
  }, [page, debouncedAction]);

  useEffect(() => {
    loadAudit();
  }, [loadAudit]);

  const loadHealth = useCallback(() => {
    api<Health>("/api/health")
      .then((d) => {
        setHealth(d);
        setHealthError(null);
      })
      .catch((err) => setHealthError(errorMessage(err)));
  }, []);

  useEffect(() => {
    loadHealth();
    const interval = setInterval(loadHealth, 15_000);
    return () => clearInterval(interval);
  }, [loadHealth]);

  return (
    <>
      <PageHeader title="Audit & health" description="Who did what, and whether the system is running well." />

      <div className="flex flex-col gap-6">
        {/* System health */}
        <Card
          title="System health"
          description="Refreshes automatically every 15 seconds."
          actions={
            health && (
              <Badge tone={healthTone(health.status)}>{health.status.toUpperCase()}</Badge>
            )
          }
        >
          {healthError && (
            <div role="alert" className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
              {healthError}
            </div>
          )}
          {!health && !healthError ? (
            <Skeleton className="h-28" />
          ) : (
            health && (
              <div className="grid gap-6 sm:grid-cols-2">
                <dl className="flex flex-col gap-2 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-[var(--muted)]">Version</dt>
                    <dd className="font-medium">{health.version}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-[var(--muted)]">Environment</dt>
                    <dd className="font-medium">{health.environment}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-[var(--muted)]">Database</dt>
                    <dd>
                      <Badge tone={health.database === "up" ? "green" : "red"}>{health.database.toUpperCase()}</Badge>
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-[var(--muted)]">Uptime</dt>
                    <dd className="font-medium tabular-nums">{formatUptime(health.uptimeSeconds)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-[var(--muted)]">DB latency</dt>
                    <dd className="font-medium tabular-nums">{health.latencyMs} ms</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-[var(--muted)]">Checked at</dt>
                    <dd className="font-medium tabular-nums">{new Date(health.timestamp).toLocaleTimeString()}</dd>
                  </div>
                </dl>
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Queue depth</p>
                  {Object.keys(health.queue).length === 0 ? (
                    <p className="text-sm text-[var(--muted)]">Queue is empty.</p>
                  ) : (
                    <ul className="flex flex-wrap gap-2">
                      {Object.entries(health.queue).map(([status, count]) => (
                        <li key={status}>
                          <Badge tone="neutral">
                            {status.replace(/_/g, " ")}: {count}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )
          )}
        </Card>

        {/* Audit log */}
        <Card
          title="Audit log"
          description="Every significant action, with IP and metadata."
          actions={
            <div className="w-64">
              <label htmlFor="audit-action" className="sr-only">
                Filter by action
              </label>
              <Input
                id="audit-action"
                type="search"
                placeholder="Filter by action…"
                value={action}
                onChange={(e) => setAction(e.target.value)}
              />
            </div>
          }
        >
          {auditError && (
            <div role="alert" className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
              {auditError}
            </div>
          )}
          {!audit && !auditError ? (
            <div className="flex flex-col gap-3">
              {[...Array(8)].map((_, i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : audit && audit.items.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--muted)]">No audit entries{debouncedAction ? ` matching “${debouncedAction}”` : ""}.</p>
          ) : (
            audit && (
              <>
                <Table headers={["Timestamp", "Action", "Entity", "IP", "Metadata"]}>
                  {audit.items.map((entry) => (
                    <tr key={entry.id} className="text-sm">
                      <td className="whitespace-nowrap px-3 py-2.5 text-xs text-[var(--muted)]">
                        {new Date(entry.createdAt).toLocaleString()}
                      </td>
                      <td className="px-3 py-2.5">
                        <Badge tone="neutral">{entry.action}</Badge>
                      </td>
                      <td className="px-3 py-2.5 text-xs">
                        {entry.entityType}
                        {entry.entityId && <span className="ml-1 text-[var(--muted)]">{entry.entityId}</span>}
                      </td>
                      <td className="px-3 py-2.5 text-xs text-[var(--muted)]">{entry.ip ?? "—"}</td>
                      <td className="px-3 py-2.5">
                        <details>
                          <summary className="cursor-pointer select-none text-xs text-[var(--accent)]">View</summary>
                          <pre className="mt-1 max-w-md overflow-x-auto whitespace-pre-wrap rounded-lg bg-black/5 p-2 font-mono text-xs dark:bg-white/5">
                            {JSON.stringify(entry.metadata, null, 2)}
                          </pre>
                        </details>
                      </td>
                    </tr>
                  ))}
                </Table>
                <Pagination page={audit.page} pageSize={audit.pageSize} total={audit.total} onPage={setPage} />
              </>
            )
          )}
        </Card>
      </div>
    </>
  );
}
