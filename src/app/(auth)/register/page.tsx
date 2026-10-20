"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Card, Field, Input } from "@/components/ui";
import { useToast } from "@/components/ui/Toast";
import { api, errorMessage, fieldErrors } from "@/lib/client/api";

/** Registration page. Password policy is enforced server-side. */
export default function RegisterPage() {
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setErrors({});
    try {
      await api("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({ email, password, name: name || undefined }),
      });
      toast.push("success", "Workspace created.");
      router.replace("/dashboard");
    } catch (err) {
      setError(errorMessage(err));
      setErrors(fieldErrors(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="grid min-h-screen place-items-center p-4">
      <div className="w-full max-w-md">
        <Card title="Create your workspace" description="Set up the first administrator account.">
          <form onSubmit={submit} className="flex flex-col gap-4">
            {error && (
              <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
                {error}
              </p>
            )}
            <Field label="Your name" htmlFor="name" error={errors.name}>
              <Input id="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Work email" htmlFor="email" error={errors.email}>
              <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} invalid={Boolean(errors.email)} />
            </Field>
            <Field label="Password" htmlFor="password" error={errors.password} hint="At least 10 characters.">
              <Input id="password" type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} invalid={Boolean(errors.password)} />
            </Field>
            <Button type="submit" loading={loading}>
              Create workspace
            </Button>
            <p className="text-sm text-[var(--muted)]">
              Already registered?{" "}
              <Link href="/login" className="text-[var(--accent)] underline-offset-2 hover:underline">
                Sign in
              </Link>
            </p>
          </form>
        </Card>
      </div>
    </main>
  );
}
