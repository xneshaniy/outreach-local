"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Field,
  Input,
  Modal,
  Skeleton,
  StatusBadge,
  Table,
} from "@/components/ui";
import { PageHeader } from "@/components/AppShell";
import { useToast } from "@/components/ui/Toast";
import { api, errorMessage, fieldErrors } from "@/lib/client/api";

type SenderAccount = {
  id: string;
  provider: "GOOGLE" | "SMTP";
  email: string;
  displayName: string | null;
  status: "CONNECTED" | "PAUSED" | "DISCONNECTED" | "ERROR";
  dailyCap: number;
  lastError: string | null;
  lastUsedAt: string | null;
  connectedAt: string | null;
  scopes: string[];
  usage: { sent: number; reserved: number; failures: number };
  remaining: number;
};

type SendersResponse = {
  accounts: SenderAccount[];
  quotaDay: string;
  maxAccounts: number;
};

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  access_denied: "Google authorization was cancelled or denied. No account was connected.",
  state_mismatch: "OAuth state mismatch — the connection could not be verified. Please try again.",
  token_exchange_failed: "The token exchange with Google failed. Please try connecting again.",
  no_refresh_token_reconnect:
    "Google did not return a refresh token. Reconnect and grant offline access so sending can work unattended.",
  account_limit_reached: "The sender account limit was reached. Disconnect an account before connecting another.",
  google_not_configured: "Google OAuth is not configured on this server. Use an SMTP account instead.",
};

const EMPTY_SMTP_FORM = {
  email: "",
  displayName: "",
  host: "",
  port: "587",
  secure: false,
  username: "",
  password: "",
  dailyCap: "",
};

function SendersInner() {
  const toast = useToast();
  const params = useSearchParams();
  const oauthError = params.get("oauth_error");
  const connected = params.get("connected");

  const [data, setData] = useState<SendersResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [connectGoogleLoading, setConnectGoogleLoading] = useState(false);
  const [googleAlert, setGoogleAlert] = useState<string | null>(null);

  // SMTP modal
  const [smtpOpen, setSmtpOpen] = useState(false);
  const [smtpSaving, setSmtpSaving] = useState(false);
  const [smtpForm, setSmtpForm] = useState(EMPTY_SMTP_FORM);
  const [smtpErrs, setSmtpErrs] = useState<Record<string, string>>({});

  // Set-cap modal
  const [capTarget, setCapTarget] = useState<SenderAccount | null>(null);
  const [capValue, setCapValue] = useState("");
  const [capSaving, setCapSaving] = useState(false);

  // Disconnect
  const [disconnectTarget, setDisconnectTarget] = useState<SenderAccount | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  // Row-level busy indicator for pause/resume
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    api<SendersResponse>("/api/senders")
      .then((d) => {
        setData(d);
        setLoadError(null);
      })
      .catch((err) => setLoadError(errorMessage(err)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const connectGoogle = async () => {
    setConnectGoogleLoading(true);
    setGoogleAlert(null);
    try {
      const res = await api<{ url: string }>("/api/google/connect", { method: "POST" });
      window.location.href = res.url;
    } catch (err) {
      setGoogleAlert(errorMessage(err));
      setConnectGoogleLoading(false);
    }
  };

  const submitSmtp = async () => {
    setSmtpSaving(true);
    setSmtpErrs({});
    try {
      const body: Record<string, unknown> = {
        email: smtpForm.email.trim(),
        host: smtpForm.host.trim(),
        port: Number(smtpForm.port),
        secure: smtpForm.secure,
        username: smtpForm.username.trim(),
        password: smtpForm.password,
      };
      if (smtpForm.displayName.trim()) body.displayName = smtpForm.displayName.trim();
      if (smtpForm.dailyCap.trim()) body.dailyCap = Number(smtpForm.dailyCap);
      await api("/api/senders", { method: "POST", body: JSON.stringify(body) });
      toast.push("success", "SMTP account connected.");
      setSmtpOpen(false);
      setSmtpForm(EMPTY_SMTP_FORM);
      load();
    } catch (err) {
      setSmtpErrs(fieldErrors(err));
      toast.push("error", errorMessage(err));
    } finally {
      setSmtpSaving(false);
    }
  };

  const togglePause = async (account: SenderAccount) => {
    setBusyId(account.id);
    try {
      await api(`/api/senders/${account.id}/${account.status === "PAUSED" ? "resume" : "pause"}`, { method: "POST" });
      toast.push("success", account.status === "PAUSED" ? `Resumed ${account.email}.` : `Paused ${account.email}.`);
      load();
    } catch (err) {
      toast.push("error", errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const saveCap = async () => {
    if (!capTarget) return;
    const dailyCap = Number(capValue);
    if (!Number.isInteger(dailyCap) || dailyCap < 1 || dailyCap > 2000) {
      toast.push("error", "Daily cap must be a whole number between 1 and 2000.");
      return;
    }
    setCapSaving(true);
    try {
      await api(`/api/senders/${capTarget.id}`, { method: "PATCH", body: JSON.stringify({ dailyCap }) });
      toast.push("success", `Daily cap updated for ${capTarget.email}.`);
      setCapTarget(null);
      load();
    } catch (err) {
      toast.push("error", errorMessage(err));
    } finally {
      setCapSaving(false);
    }
  };

  const disconnect = async () => {
    if (!disconnectTarget) return;
    setDisconnecting(true);
    try {
      await api(`/api/senders/${disconnectTarget.id}`, { method: "DELETE" });
      toast.push("success", `${disconnectTarget.email} disconnected.`);
      setDisconnectTarget(null);
      load();
    } catch (err) {
      toast.push("error", errorMessage(err));
    } finally {
      setDisconnecting(false);
    }
  };

  const accounts = data?.accounts ?? [];
  const atLimit = data ? accounts.length >= data.maxAccounts : false;

  return (
    <>
      <PageHeader
        title="Sender accounts"
        description={
          data
            ? `${accounts.length} of ${data.maxAccounts} accounts · quota day ${new Date(data.quotaDay).toLocaleDateString()}`
            : "Connected inboxes used for sending."
        }
        actions={
          <>
            <Button variant="secondary" onClick={connectGoogle} loading={connectGoogleLoading} disabled={atLimit}>
              Connect Google
            </Button>
            <Button onClick={() => setSmtpOpen(true)} disabled={atLimit}>
              Connect SMTP account
            </Button>
          </>
        }
      />

      {oauthError && (
        <div role="alert" className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {OAUTH_ERROR_MESSAGES[oauthError] ?? `Google OAuth failed (${oauthError}).`}
        </div>
      )}
      {connected && (
        <div role="status" className="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300">
          {connected} connected via Google OAuth.
        </div>
      )}
      {googleAlert && (
        <div role="alert" className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
          Could not start Google OAuth: {googleAlert}
        </div>
      )}
      {loadError && (
        <div role="alert" className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {loadError}
        </div>
      )}
      {atLimit && (
        <div role="status" className="mb-4 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-sm text-[var(--muted)]">
          You have reached the maximum of {data?.maxAccounts} sender accounts. Disconnect one before connecting another.
        </div>
      )}

      <Card title="Accounts" description="Tokens and SMTP passwords are encrypted at rest and never displayed.">
        {!data && !loadError ? (
          <div className="flex flex-col gap-3">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        ) : accounts.length === 0 ? (
          <p className="py-8 text-center text-sm text-[var(--muted)]">
            No sender accounts yet. Connect a Google or SMTP account to start sending.
          </p>
        ) : (
          <Table headers={["Sender", "Provider", "Status", "Usage today", "Last error", ""]}>
            {accounts.map((a) => (
              <tr key={a.id} className="text-sm">
                <td className="px-3 py-2.5">
                  <p className="font-medium">{a.email}</p>
                  {a.displayName && <p className="text-xs text-[var(--muted)]">{a.displayName}</p>}
                </td>
                <td className="px-3 py-2.5">
                  <Badge tone={a.provider === "GOOGLE" ? "blue" : "neutral"}>{a.provider}</Badge>
                </td>
                <td className="px-3 py-2.5">
                  <StatusBadge status={a.status} />
                </td>
                <td className="px-3 py-2.5">
                  <span className="tabular-nums">
                    {a.usage.sent}/{a.dailyCap} sent · {a.remaining} remaining
                  </span>
                  {a.usage.failures > 0 && (
                    <span className="ml-2 text-xs text-red-600 dark:text-red-400">{a.usage.failures} failed</span>
                  )}
                </td>
                <td className="max-w-xs truncate px-3 py-2.5 text-xs text-[var(--muted)]" title={a.lastError ?? undefined}>
                  {a.lastError ?? "—"}
                </td>
                <td className="whitespace-nowrap px-3 py-2.5 text-right">
                  <div className="flex justify-end gap-1">
                    {a.status === "PAUSED" ? (
                      <Button variant="ghost" loading={busyId === a.id} onClick={() => togglePause(a)}>
                        Resume
                      </Button>
                    ) : (
                      <Button variant="ghost" disabled={a.status !== "CONNECTED"} loading={busyId === a.id} onClick={() => togglePause(a)}>
                        Pause
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setCapTarget(a);
                        setCapValue(String(a.dailyCap));
                      }}
                    >
                      Set cap
                    </Button>
                    <Button variant="ghost" className="text-red-600 dark:text-red-400" onClick={() => setDisconnectTarget(a)}>
                      Disconnect
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {/* Connect SMTP modal */}
      <Modal
        open={smtpOpen}
        title="Connect SMTP account"
        onClose={() => setSmtpOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setSmtpOpen(false)} disabled={smtpSaving}>
              Cancel
            </Button>
            <Button onClick={submitSmtp} loading={smtpSaving}>
              Connect
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label="Email address" htmlFor="smtp-email" error={smtpErrs.email}>
            <Input
              id="smtp-email"
              type="email"
              value={smtpForm.email}
              invalid={Boolean(smtpErrs.email)}
              onChange={(e) => setSmtpForm((f) => ({ ...f, email: e.target.value }))}
              placeholder="sender@example.com"
            />
          </Field>
          <Field label="Display name (optional)" htmlFor="smtp-name" error={smtpErrs.displayName}>
            <Input
              id="smtp-name"
              value={smtpForm.displayName}
              onChange={(e) => setSmtpForm((f) => ({ ...f, displayName: e.target.value }))}
              placeholder="Ada from Acme"
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="SMTP host" htmlFor="smtp-host" error={smtpErrs.host}>
              <Input
                id="smtp-host"
                value={smtpForm.host}
                invalid={Boolean(smtpErrs.host)}
                onChange={(e) => setSmtpForm((f) => ({ ...f, host: e.target.value }))}
                placeholder="smtp.example.com"
              />
            </Field>
            <Field label="Port" htmlFor="smtp-port" error={smtpErrs.port}>
              <Input
                id="smtp-port"
                type="number"
                value={smtpForm.port}
                invalid={Boolean(smtpErrs.port)}
                onChange={(e) => setSmtpForm((f) => ({ ...f, port: e.target.value }))}
              />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={smtpForm.secure}
              onChange={(e) => setSmtpForm((f) => ({ ...f, secure: e.target.checked }))}
              className="h-4 w-4 rounded border-[var(--border)]"
            />
            Use TLS (SSL) — usually port 465
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Username" htmlFor="smtp-username" error={smtpErrs.username}>
              <Input
                id="smtp-username"
                value={smtpForm.username}
                invalid={Boolean(smtpErrs.username)}
                onChange={(e) => setSmtpForm((f) => ({ ...f, username: e.target.value }))}
              />
            </Field>
            <Field label="Password" htmlFor="smtp-password" error={smtpErrs.password} hint="Encrypted at rest; never shown again.">
              <Input
                id="smtp-password"
                type="password"
                value={smtpForm.password}
                invalid={Boolean(smtpErrs.password)}
                onChange={(e) => setSmtpForm((f) => ({ ...f, password: e.target.value }))}
              />
            </Field>
          </div>
          <Field label="Daily cap (optional)" htmlFor="smtp-cap" error={smtpErrs.dailyCap} hint="Max sends per day for this account.">
            <Input
              id="smtp-cap"
              type="number"
              min={1}
              value={smtpForm.dailyCap}
              onChange={(e) => setSmtpForm((f) => ({ ...f, dailyCap: e.target.value }))}
              placeholder="default"
            />
          </Field>
        </div>
      </Modal>

      {/* Set cap modal */}
      <Modal
        open={capTarget !== null}
        title={`Set daily cap — ${capTarget?.email ?? ""}`}
        onClose={() => setCapTarget(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCapTarget(null)} disabled={capSaving}>
              Cancel
            </Button>
            <Button onClick={saveCap} loading={capSaving}>
              Save cap
            </Button>
          </>
        }
      >
        <Field label="Max sends per day" htmlFor="cap-input" hint="The worker will not exceed this quota in the sender's quota day.">
          <Input id="cap-input" type="number" min={1} value={capValue} onChange={(e) => setCapValue(e.target.value)} />
        </Field>
      </Modal>

      {/* Disconnect confirm */}
      <ConfirmDialog
        open={disconnectTarget !== null}
        title="Disconnect sender account"
        message={`Disconnect ${disconnectTarget?.email ?? ""}? OAuth tokens and stored credentials are destroyed immediately and cannot be recovered. Queued sends from this account will be reassigned or delayed.`}
        confirmLabel="Disconnect"
        loading={disconnecting}
        onConfirm={disconnect}
        onClose={() => setDisconnectTarget(null)}
      />
    </>
  );
}

export default function SendersPage() {
  return (
    // The page reads the query string, so it is rendered on the client. The
    // fallback therefore has to carry the heading itself, otherwise the
    // server-rendered page has no <h1> (bad for screen readers and for SEO).
    <Suspense
      fallback={
        <>
          <PageHeader
            title="Sender accounts"
            description="Connected inboxes used for sending."
          />
          <Card>
            <Skeleton className="h-64" />
          </Card>
        </>
      }
    >
      <SendersInner />
    </Suspense>
  );
}
