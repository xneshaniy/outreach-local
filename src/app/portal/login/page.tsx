"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Card, Field, Input } from "@/components/ui";
import { useToast } from "@/components/ui/Toast";
import { api, errorMessage } from "@/lib/client/api";

/**
 * Client-portal sign-in.
 *
 * A client account is separate from the workspace owner: it only ever shows
 * the campaigns an administrator assigned to it.
 */
export default function ClientLoginPage() {
  const router = useRouter();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/client-login", {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), password }),
      });
      toast.push("success", "Signed in.");
      router.replace("/portal");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <span className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-xl bg-[var(--accent)] text-base font-bold text-white">
            C
          </span>
          <h1 className="text-lg font-semibold">Client portal</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">Sign in to see your campaign reports.</p>
        </div>

        <Card>
          <form onSubmit={submit} className="flex flex-col gap-4">
            {error && (
              <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
                {error}
              </div>
            )}
            <Field label="Email" htmlFor="client-email">
              <Input
                id="client-email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field label="Password" htmlFor="client-password">
              <Input
                id="client-password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <Button type="submit" loading={busy}>
              Sign in
            </Button>
          </form>
        </Card>

        <p className="mt-4 text-center text-xs text-[var(--muted)]">
          Are you the account owner?{" "}
          <a href="/login" className="text-[var(--accent)] hover:underline">
            Sign in here
          </a>
          .
        </p>
      </div>
    </main>
  );
}
