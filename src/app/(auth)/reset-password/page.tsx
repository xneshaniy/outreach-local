"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Button, Card, Field, Input } from "@/components/ui";
import { useToast } from "@/components/ui/Toast";
import { api, errorMessage } from "@/lib/client/api";

function ResetForm() {
  const router = useRouter();
  const toast = useToast();
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({ token, password }),
      });
      toast.push("success", "Password changed. You can sign in now.");
      router.replace("/login");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <Card>
        <p className="text-sm text-[var(--muted)]">
          This link is missing its token. Request a new reset link.
        </p>
        <Button variant="secondary" className="mt-4" onClick={() => router.replace("/forgot-password")}>
          Request a new link
        </Button>
      </Card>
    );
  }

  return (
    <Card>
      <form onSubmit={submit} className="flex flex-col gap-4">
        {error && (
          <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}
        <Field label="New password" htmlFor="new-password" hint="At least 10 characters.">
          <Input
            id="new-password"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field label="Confirm the new password" htmlFor="confirm-password">
          <Input
            id="confirm-password"
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
        <Button type="submit" loading={busy}>
          Change my password
        </Button>
      </form>
    </Card>
  );
}

export default function ResetPasswordPage() {
  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <span className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-xl bg-[var(--accent)] text-base font-bold text-white">
            E
          </span>
          <h1 className="text-lg font-semibold">Choose a new password</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Changing it signs you out everywhere.
          </p>
        </div>
        <Suspense fallback={<Card><p className="text-sm text-[var(--muted)]">Loading…</p></Card>}>
          <ResetForm />
        </Suspense>
      </div>
    </main>
  );
}
