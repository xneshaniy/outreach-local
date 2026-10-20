"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Authenticated app shell: sidebar navigation, user menu, theme toggle.
 * Session state comes from /api/auth/me (server-verified).
 */

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: "◧" },
  { href: "/services", label: "Services", icon: "◆" },
  { href: "/campaigns", label: "Campaigns", icon: "✉" },
  { href: "/contacts", label: "Contacts", icon: "☺" },
  { href: "/senders", label: "Sender accounts", icon: "@" },
  { href: "/templates", label: "Templates", icon: "✎" },
  { href: "/follow-ups", label: "Follow-ups", icon: "↻" },
  { href: "/replies", label: "Replies", icon: "↩" },
  { href: "/queue", label: "Send queue", icon: "⇄" },
  { href: "/analytics", label: "Analytics", icon: "▤" },
  { href: "/suppressions", label: "Suppressions", icon: "⊘" },
  { href: "/settings", label: "Settings", icon: "⚙" },
  { href: "/audit", label: "Audit & health", icon: "☰" },
];

function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);
  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("eop-theme", next ? "dark" : "light");
    } catch {
      /* storage disabled */
    }
  };
  return (
    <button
      onClick={toggle}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      className="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-sm hover:bg-black/5 dark:hover:bg-white/5"
    >
      {dark ? "☀ light" : "☾ dark"}
    </button>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    fetch("/api/auth/me", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("unauthorized"))))
      .then((d) => setEmail(d.user.email))
      .catch(() => router.replace("/login"));
  }, [router]);

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => undefined);
    router.replace("/login");
  };

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-60 transform border-r border-[var(--border)] bg-[var(--surface)] p-4 transition-transform lg:static lg:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <Link href="/dashboard" className="mb-6 flex items-center gap-2 px-2 pt-1">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-[var(--accent)] text-sm font-bold text-white">E</span>
          <span className="text-sm font-semibold">Email Outreach</span>
        </Link>
        <nav className="flex flex-col gap-1">
          {NAV.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${
                  active
                    ? "bg-[var(--accent)]/10 font-medium text-[var(--accent)]"
                    : "text-[var(--muted)] hover:bg-black/5 dark:hover:bg-white/5"
                }`}
              >
                <span aria-hidden className="w-4 text-center">{item.icon}</span>
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="mt-6 border-t border-[var(--border)] pt-4">
          <p className="truncate px-2 text-xs text-[var(--muted)]">{email ?? "…"}</p>
          <div className="mt-2 flex items-center gap-2 px-2">
            <ThemeToggle />
            <button
              onClick={logout}
              className="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-sm text-red-600 hover:bg-red-500/10 dark:text-red-400"
            >
              Sign out
            </button>
          </div>
        </div>
      </aside>

      {open && <div className="fixed inset-0 z-30 bg-black/40 lg:hidden" onClick={() => setOpen(false)} aria-hidden />}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-[var(--border)] bg-[var(--background)]/80 px-4 py-3 backdrop-blur lg:hidden">
          <button onClick={() => setOpen(true)} aria-label="Open navigation" className="rounded-lg border border-[var(--border)] px-2.5 py-1.5">
            ☰
          </button>
          <span className="text-sm font-semibold">Email Outreach</span>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 p-4 sm:p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}

/** Consistent page heading with optional actions. */
export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-[var(--muted)]">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
