"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, Field, Input, Skeleton } from "@/components/ui";
import { PageHeader } from "@/components/AppShell";
import { useToast } from "@/components/ui/Toast";
import { api, errorMessage, fieldErrors } from "@/lib/client/api";

type Me = {
  user: {
    id: string;
    email: string;
    name: string | null;
    role: string;
    minDaysBetweenContacts: number;
  };
};

export default function SettingsPage() {
  const toast = useToast();

  const [me, setMe] = useState<Me | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [minDays, setMinDays] = useState("3");
  const [saving, setSaving] = useState(false);
  const [errs, setErrs] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    api<Me>("/api/auth/me")
      .then((d) => {
        setMe(d);
        setName(d.user.name ?? "");
        setMinDays(String(d.user.minDaysBetweenContacts));
        setLoadError(null);
      })
      .catch((err) => setLoadError(errorMessage(err)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    const days = Number(minDays);
    if (!Number.isInteger(days) || days < 0 || days > 30) {
      setErrs({ minDaysBetweenContacts: "Must be a whole number between 0 and 30." });
      return;
    }
    setSaving(true);
    setErrs({});
    try {
      const res = await api<{ user: Me["user"] }>("/api/settings", {
        method: "POST",
        body: JSON.stringify({ name: name.trim() || null, minDaysBetweenContacts: days }),
      });
      setMe({ user: res.user });
      toast.push("success", "Settings saved.");
    } catch (err) {
      setErrs(fieldErrors(err));
      toast.push("error", errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (!me && !loadError) {
    return (
      <>
        <PageHeader title="Settings" />
        <div className="flex max-w-2xl flex-col gap-4">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Settings" description="Your profile and workspace-wide sending rules." />

      {loadError && (
        <div role="alert" className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {loadError}
        </div>
      )}

      <div className="flex max-w-2xl flex-col gap-4">
        <Card title="Profile">
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-[var(--muted)]">Email</span>
              <span className="font-medium">{me?.user.email ?? "—"}</span>
              <Badge tone="blue">{me?.user.role ?? ""}</Badge>
            </div>
            <Field label="Display name" htmlFor="set-name" error={errs.name}>
              <Input id="set-name" value={name} invalid={Boolean(errs.name)} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field
              label="Minimum days between emails to the same contact"
              htmlFor="set-mindays"
              error={errs.minDaysBetweenContacts}
              hint="0–30. A contact receives at most one email from you per this interval, across every campaign."
            >
              <Input
                id="set-mindays"
                type="number"
                min={0}
                max={30}
                value={minDays}
                invalid={Boolean(errs.minDaysBetweenContacts)}
                onChange={(e) => setMinDays(e.target.value)}
              />
            </Field>
            <div>
              <Button onClick={save} loading={saving}>
                Save settings
              </Button>
            </div>
          </div>
        </Card>

        <Card title="Security">
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-[var(--muted)]">
            <li>Sessions are HttpOnly cookies — they cannot be read by JavaScript.</li>
            <li>OAuth tokens and SMTP passwords are encrypted at rest with AES-256-GCM.</li>
            <li>Use a strong, unique password for your account (minimum 10 characters).</li>
            <li>API rate limits are enabled; repeated abuse will temporarily block the client.</li>
          </ul>
        </Card>
      </div>
    </>
  );
}
