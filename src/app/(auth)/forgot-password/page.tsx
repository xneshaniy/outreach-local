"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Card, Field, Input } from "@/components/ui";
import { useToast } from "@/components/ui/Toast";
import { api, errorMessage } from "@/lib/client/api";

/**
 * "I forgot my password".
 *
 * The response is the same whether or not the address exists, so this page
 * cannot be used to find out who has an account. In development the API also
 * returns the reset link, which is shown here as a convenience.
 */
export default function ForgotPasswordPage() {
  const router = useRouter();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [devLink, setDevLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ message: string; devResetUrl?: string }>("/api/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email: email.trim() }),
      });
      setSent(true);
      setDevLink(res.devResetUrl ?? null);
      toast.push("success", res.message);
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
            E
          </span>
          <h1 className="text-lg font-semibold">Reset your password</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            We will email you a link to choose a new one.
          </p>
        </div>

        <Card>
          {sent ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm">
                If that address has an account, a reset link is on its way. The link expires in 30
                minutes and can only be used once.
              </p>
              {devLink && (
                <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                  <span className="font-medium">Development mode.</span> No mail transport is
                  configured, so here is the link:{" "}
                  <a className="underline" href={devLink}>
                    open it
                  </a>
                </p>
              )}
              <Button variant="secondary" onClick={() => router.replace("/login")}>
                Back to sign in
              </Button>
            </div>
          ) : (
            <form onSubmit={submit} className="flex flex-col gap-4">
              {error && (
                <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
                  {error}
                </div>
              )}
              <Field label="Email" htmlFor="reset-email">
                <Input
                  id="reset-email"
                  type="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </Field>
              <Button type="submit" loading={busy}>
                Send the reset link
              </Button>
              <Button variant="ghost" onClick={() => router.replace("/login")}>
                Back to sign in
              </Button>
            </form>
          )}
        </Card>
      </div>
    </main>
  );
}
