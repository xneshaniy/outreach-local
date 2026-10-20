"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Button, Card, EmptyState, Field, Select, Table } from "@/components/ui";
import { PageHeader } from "@/components/AppShell";
import { api, errorMessage } from "@/lib/client/api";

const IMPORT_FIELDS = ["email", "firstName", "lastName", "company", "website", "title", "timeZone", "country"] as const;

type InvalidRow = { row: number; reason: string; email?: string };

type DryRunResult = {
  headers: string[];
  sample: Array<Record<string, string>>;
  detectedMapping: Record<string, string | undefined>;
  total: number;
  valid: number;
  invalid: InvalidRow[];
  duplicatesInFile: number;
};

type ImportResult = {
  batchId: string;
  added: number;
  duplicates: number;
  invalid: number;
  heldForTimezone: number;
  invalidPreview: InvalidRow[];
};

type CampaignOption = { id: string; name: string; status: string };

function StepIndicator({ step }: { step: number }) {
  const steps = ["Upload", "Map columns", "Result"];
  return (
    <ol className="mb-6 flex items-center gap-2 text-sm">
      {steps.map((label, i) => {
        const n = i + 1;
        const active = n === step;
        const done = n < step;
        return (
          <li key={label} className="flex items-center gap-2">
            <span
              className={`grid h-7 w-7 place-items-center rounded-full text-xs font-semibold ${
                active
                  ? "bg-[var(--accent)] text-white"
                  : done
                    ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                    : "bg-black/5 text-[var(--muted)] dark:bg-white/10"
              }`}
            >
              {done ? "✓" : n}
            </span>
            <span className={active ? "font-medium" : "text-[var(--muted)]"}>{label}</span>
            {i < steps.length - 1 && <span className="mx-1 h-px w-8 bg-[var(--border)]" aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}

export default function ContactImportPage() {
  const [step, setStep] = useState(1);

  const [file, setFile] = useState<File | null>(null);
  const [campaignId, setCampaignId] = useState("");
  const [campaigns, setCampaigns] = useState<CampaignOption[]>([]);

  const [dry, setDry] = useState<DryRunResult | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [result, setResult] = useState<ImportResult | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ items: CampaignOption[] }>("/api/campaigns?pageSize=100")
      .then((d) => setCampaigns(d.items))
      .catch(() => undefined);
  }, []);

  const runDryRun = async () => {
    if (!file) {
      setError("Choose a CSV file first.");
      return;
    }
    if (!file.name.toLowerCase().endsWith(".csv")) {
      setError("Only .csv files are accepted.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("dryRun", "true");
      if (campaignId) fd.append("campaignId", campaignId);
      const res = await api<DryRunResult>("/api/contacts/import", { method: "POST", body: fd });
      setDry(res);
      const initial: Record<string, string> = {};
      for (const field of IMPORT_FIELDS) {
        const detected = res.detectedMapping[field];
        initial[field] = detected && res.headers.includes(detected) ? detected : "";
      }
      setMapping(initial);
      setStep(2);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!file || !dry) return;
    if (!mapping.email) {
      setError("The email field must be mapped to a CSV column.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (campaignId) fd.append("campaignId", campaignId);
      fd.append("mapping", JSON.stringify(mapping));
      const res = await api<ImportResult>("/api/contacts/import", { method: "POST", body: fd });
      setResult(res);
      setStep(3);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setStep(1);
    setFile(null);
    setCampaignId("");
    setDry(null);
    setMapping({});
    setResult(null);
    setError(null);
  };

  return (
    <>
      <PageHeader
        title="Import contacts from CSV"
        description="Upload a CSV, map its columns, and review before anything is written."
        actions={
          <Link
            href="/contacts"
            className="inline-flex items-center rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2 text-sm font-medium hover:bg-black/5 dark:hover:bg-white/5"
          >
            Back to contacts
          </Link>
        }
      />

      <StepIndicator step={step} />

      {error && (
        <div role="alert" className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {step === 1 && (
        <Card title="Step 1 — Upload" description="Max 10 MB / 50 000 rows. Nothing is written until you confirm.">
          <div className="flex max-w-lg flex-col gap-4">
            <Field label="CSV file" htmlFor="csv-file" hint="The first row must contain column headers.">
              <input
                id="csv-file"
                type="file"
                accept=".csv"
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  setError(null);
                }}
                className="block w-full text-sm text-[var(--muted)] file:mr-3 file:rounded-lg file:border file:border-[var(--border)] file:bg-[var(--surface)] file:px-3 file:py-2 file:text-sm file:font-medium file:text-[var(--text)] hover:file:bg-black/5 dark:hover:file:bg-white/5"
              />
            </Field>
            <Field label="Add to campaign (optional)" htmlFor="csv-campaign" hint="Skip to import into your contact list only.">
              <Select id="csv-campaign" value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
                <option value="">— none (contacts only) —</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.status})
                  </option>
                ))}
              </Select>
            </Field>
            <div>
              <Button onClick={runDryRun} loading={busy} disabled={!file}>
                Continue
              </Button>
            </div>
          </div>
        </Card>
      )}

      {step === 2 && dry && (
        <>
          <Card title="Step 2 — Map columns" description="Match each contact field to a column in your CSV.">
            <div className="grid max-w-2xl gap-3 sm:grid-cols-2">
              {IMPORT_FIELDS.map((field) => (
                <Field
                  key={field}
                  label={field === "email" ? "Email (required)" : field}
                  htmlFor={`map-${field}`}
                  error={field === "email" && !mapping.email ? "Email must be mapped to a column." : undefined}
                >
                  <Select
                    id={`map-${field}`}
                    value={mapping[field] ?? ""}
                    onChange={(e) => setMapping((m) => ({ ...m, [field]: e.target.value }))}
                  >
                    <option value="">— skip —</option>
                    {dry.headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </Select>
                </Field>
              ))}
            </div>
          </Card>

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <Card title="Preview">
              {dry.sample.length === 0 ? (
                <p className="text-sm text-[var(--muted)]">No sample rows available.</p>
              ) : (
                <Table headers={dry.headers}>
                  {dry.sample.slice(0, 3).map((row, i) => (
                    <tr key={i} className="text-sm">
                      {dry.headers.map((h) => (
                        <td key={h} className="max-w-40 truncate px-3 py-2" title={row[h]}>
                          {row[h]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </Table>
              )}
              </Card>
            </div>

            <Card title="File check">
              <dl className="flex flex-col gap-2 text-sm">
                <div className="flex justify-between">
                  <dt className="text-[var(--muted)]">Total rows</dt>
                  <dd className="tabular-nums">{dry.total}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-[var(--muted)]">Valid</dt>
                  <dd className="tabular-nums text-emerald-600 dark:text-emerald-400">{dry.valid}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-[var(--muted)]">Invalid</dt>
                  <dd className="tabular-nums text-red-600 dark:text-red-400">{dry.invalid.length}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-[var(--muted)]">Duplicates within file</dt>
                  <dd className="tabular-nums">{dry.duplicatesInFile}</dd>
                </div>
              </dl>
              {dry.invalid.length > 0 && (
                <div className="mt-3 border-t border-[var(--border)] pt-3">
                  <p className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">Invalid rows (first 50)</p>
                  <ul className="max-h-40 space-y-1 overflow-y-auto text-xs text-[var(--muted)]">
                    {dry.invalid.slice(0, 50).map((inv, i) => (
                      <li key={i}>
                        Row {inv.row}: {inv.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </Card>
          </div>

          <div className="mt-4 flex gap-2">
            <Button variant="secondary" onClick={() => setStep(1)} disabled={busy}>
              Back
            </Button>
            <Button onClick={commit} loading={busy} disabled={!mapping.email}>
              Import {dry.valid} contacts
            </Button>
          </div>
        </>
      )}

      {step === 3 && result && (
        <>
          <Card title="Step 3 — Import complete" description={`Batch ${result.batchId}`}>
            <div className="grid gap-4 sm:grid-cols-4">
              {[
                { label: "Added", value: result.added, tone: "text-emerald-600 dark:text-emerald-400" },
                { label: "Duplicates skipped", value: result.duplicates, tone: "" },
                { label: "Invalid rows", value: result.invalid, tone: result.invalid > 0 ? "text-red-600 dark:text-red-400" : "" },
                { label: "Held for time zone", value: result.heldForTimezone, tone: result.heldForTimezone > 0 ? "text-amber-600 dark:text-amber-400" : "" },
              ].map((s) => (
                <div key={s.label} className="rounded-lg border border-[var(--border)] p-4">
                  <p className="text-xs uppercase tracking-wide text-[var(--muted)]">{s.label}</p>
                  <p className={`mt-1 text-2xl font-semibold tabular-nums ${s.tone}`}>{s.value}</p>
                </div>
              ))}
            </div>
            <p className="mt-4 text-sm text-[var(--muted)]">
              Duplicates were skipped by the database constraint — importing the same file again will not create double contacts.
              Recipients with an unknown time zone are held for review: set their time zone on the Contacts page or switch the campaign
              to FALLBACK mode.
            </p>
          </Card>

          {result.invalidPreview.length > 0 && (
            <div className="mt-4">
              <Card title="Invalid rows (first 50)">
                <Table headers={["Row", "Email", "Reason"]}>
                  {result.invalidPreview.map((inv, i) => (
                    <tr key={i} className="text-sm">
                      <td className="px-3 py-2 tabular-nums">{inv.row}</td>
                      <td className="px-3 py-2">{inv.email ?? "—"}</td>
                      <td className="px-3 py-2 text-[var(--muted)]">{inv.reason}</td>
                    </tr>
                  ))}
                </Table>
              </Card>
            </div>
          )}

          <div className="mt-4 flex gap-2">
            <Button onClick={reset}>Import more</Button>
            <Link
              href="/contacts"
              className="inline-flex items-center rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2 text-sm font-medium hover:bg-black/5 dark:hover:bg-white/5"
            >
              View contacts
            </Link>
          </div>
        </>
      )}

      {step === 2 && !dry && <EmptyState title="Analysis failed" description="Go back and upload the file again." />}
    </>
  );
}
