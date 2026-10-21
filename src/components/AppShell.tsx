"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { NotificationBell } from "./NotificationBell";
import { Button, Menu, MenuItem } from "./ui";

/**
 * The authenticated shell.
 *
 * A fixed, grouped sidebar (desktop) that becomes a slide-in drawer on mobile,
 * plus a compact top bar with the page context, the notification bell and the
 * account menu. The owner session comes from /api/auth/me (server-verified).
 */

type NavItem = { href: string; label: string; icon: string };
type NavGroup = { heading: string; items: NavItem[] };

const NAV: NavGroup[] = [
  {
    heading: "Overview",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: "◧" },
      { href: "/analytics", label: "Analytics", icon: "▤" },
      { href: "/queue", label: "Send queue", icon: "⇄" },
    ],
  },
  {
    heading: "Outreach",
    items: [
      { href: "/services", label: "Services", icon: "◆" },
      { href: "/campaigns", label: "Campaigns", icon: "✉" },
      { href: "/contacts", label: "Contacts", icon: "☺" },
      { href: "/pipeline", label: "Pipeline", icon: "▥" },
      { href: "/templates", label: "Templates", icon: "✎" },
      { href: "/follow-ups", label: "Follow-ups", icon: "↻" },
    ],
  },
  {
    heading: "Engagement",
    items: [
      { href: "/replies", label: "Replies", icon: "↩" },
      { href: "/senders", label: "Sender accounts", icon: "@" },
      { href: "/suppressions", label: "Suppressions", icon: "⊘" },
    ],
  },
  {
    heading: "Workspace",
    items: [
      { href: "/clients", label: "Clients", icon: "◫" },
      { href: "/settings", label: "Settings", icon: "⚙" },
      { href: "/audit", label: "Audit & health", icon: "☰" },
    ],
  },
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
      className="grid h-9 w-9 place-items-center rounded-[var(--radius)] border border-[var(--border)] text-[13px] text-[var(--muted)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--text)]"
    >
      <span aria-hidden>{dark ? "☀" : "☾"}</span>
    </button>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    fetch("/api/auth/me", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("unauthorized"))))
      .then((d: { user: { email: string; name: string | null } }) => {
        setEmail(d.user.email);
        setName(d.user.name);
      })
      .catch(() => router.replace("/login"));
  }, [router]);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Lock the page behind the drawer on mobile.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => undefined);
    router.replace("/login");
  };

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  const sidebar = (
    <>
      <div className="flex h-[var(--topbar-height)] items-center gap-2.5 border-b border-[var(--border)] px-5">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius)] bg-[var(--accent)] text-[13px] font-bold text-[var(--on-accent)]">
          E
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[13.5px] font-semibold leading-4">Email Outreach</span>
          <span className="block text-[11px] leading-4 text-[var(--muted)]">Workspace</span>
        </span>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4" aria-label="Main">
        {NAV.map((group) => (
          <div key={group.heading} className="mb-5 last:mb-0">
            <p className="mb-1.5 px-3 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-2)]">
              {group.heading}
            </p>
            <ul className="flex flex-col gap-0.5">
              {group.items.map((item) => {
                const active = isActive(item.href);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={`flex items-center gap-2.5 rounded-[var(--radius)] px-3 py-2 text-[13.5px] transition-colors ${
                        active
                          ? "bg-[var(--accent-soft)] font-medium text-[var(--accent)]"
                          : "text-[var(--text-secondary)] hover:bg-[var(--surface-3)] hover:text-[var(--text)]"
                      }`}
                    >
                      <span aria-hidden className="w-4 shrink-0 text-center text-[13px] opacity-80">
                        {item.icon}
                      </span>
                      <span className="truncate">{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="border-t border-[var(--border)] px-3 py-3">
        <div className="flex items-center gap-2 rounded-[var(--radius)] bg-[var(--surface-2)] px-3 py-2">
          <span
            aria-hidden
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[var(--accent-soft)] text-[11px] font-semibold text-[var(--accent)]"
          >
            {(name ?? email ?? "?").slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12.5px] font-medium leading-4">{name ?? "Workspace"}</span>
            <span className="block truncate text-[11px] leading-4 text-[var(--muted)]">{email ?? "…"}</span>
          </span>
        </div>
      </div>
    </>
  );

  return (
    <div className="flex min-h-screen bg-[var(--background)]">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[var(--sidebar-width)] flex-col border-r border-[var(--border)] bg-[var(--surface)] lg:flex">
        {sidebar}
      </aside>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-[#0b1020]/45 backdrop-blur-[2px]"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <aside className="relative flex h-full w-[min(82vw,var(--sidebar-width))] flex-col border-r border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-lg)]">
            <button
              onClick={() => setOpen(false)}
              aria-label="Close navigation"
              className="absolute right-3 top-4 grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] text-[var(--muted)] hover:bg-[var(--surface-3)]"
            >
              ✕
            </button>
            {sidebar}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col lg:pl-[var(--sidebar-width)]">
        {/* Compact top bar */}
        <header className="sticky top-0 z-30 flex h-[var(--topbar-height)] items-center gap-3 border-b border-[var(--border)] bg-[var(--surface)]/85 px-4 backdrop-blur-md sm:px-6">
          <button
            onClick={() => setOpen(true)}
            aria-label="Open navigation"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-[var(--radius)] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--surface-3)] lg:hidden"
          >
            <span aria-hidden>☰</span>
          </button>

          <div className="min-w-0 flex-1">
            <p className="truncate text-[14px] font-semibold leading-5">
              {NAV.flatMap((g) => g.items).find((i) => isActive(i.href))?.label ?? "Workspace"}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <NotificationBell />
            <ThemeToggle />
            <Menu
              align="right"
              trigger={
                <button
                  aria-label="Account menu"
                  className="grid h-9 w-9 place-items-center rounded-full border border-[var(--border)] bg-[var(--surface-2)] text-[12px] font-semibold text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-3)]"
                >
                  {(name ?? email ?? "?").slice(0, 1).toUpperCase()}
                </button>
              }
            >
              <div className="border-b border-[var(--border)] px-2.5 py-2">
                <p className="truncate text-[12.5px] font-medium">{name ?? "Workspace"}</p>
                <p className="truncate text-[11.5px] text-[var(--muted)]">{email}</p>
              </div>
              <div className="pt-1">
                <MenuItem onClick={() => router.push("/settings")}>Settings</MenuItem>
                <MenuItem onClick={() => router.push("/audit")}>Audit & health</MenuItem>
                <MenuItem onClick={logout} danger>
                  Sign out
                </MenuItem>
              </div>
            </Menu>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
      </div>
    </div>
  );
}

/** Consistent page heading with optional actions. */
export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  eyebrow?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1.5">{eyebrow}</div>}
        <h1 className="text-[22px] font-semibold leading-7 tracking-[-0.02em] sm:text-[26px] sm:leading-8">
          {title}
        </h1>
        {description && (
          <p className="mt-1.5 max-w-2xl text-[13.5px] leading-5 text-[var(--muted)]">{description}</p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** A compact button that reads as a link, used in card headers. */
export function GhostLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 text-[12.5px] font-medium text-[var(--accent)] transition-opacity hover:opacity-80"
    >
      {children}
      <span aria-hidden>→</span>
    </Link>
  );
}

export { Button };
