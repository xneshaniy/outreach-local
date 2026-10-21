"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The notification bell.
 *
 * It polls the notifications endpoint (30 s) and shows the unread count. A
 * click opens the list; clicking a notification marks it read and follows the
 * link. The list is a real dropdown with keyboard support, not a placeholder.
 */

type Notification = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  isRead: boolean;
  createdAt: string;
};

const POLL_MS = 30_000;

export function NotificationBell() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications?limit=20", { credentials: "same-origin" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { items: Notification[]; unread: number };
      setItems(data.items);
      setUnread(data.unread);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  // Close on Escape or an outside click.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  // Re-read when the user navigates, so the count is fresh.
  useEffect(() => {
    void load();
  }, [pathname, load]);

  const markRead = async (n: Notification) => {
    if (n.isRead) return;
    setItems((list) => list.map((x) => (x.id === n.id ? { ...x, isRead: true } : x)));
    setUnread((c) => Math.max(0, c - 1));
    try {
      await fetch("/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [n.id] }),
        credentials: "same-origin",
      });
    } catch {
      /* the next poll will reconcile it */
    }
  };

  const markAllRead = async () => {
    setItems((list) => list.map((x) => ({ ...x, isRead: true })));
    setUnread(0);
    try {
      await fetch("/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
        credentials: "same-origin",
      });
    } catch {
      /* ignored */
    }
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        aria-expanded={open}
        className="relative rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-sm hover:bg-black/5 dark:hover:bg-white/5"
      >
        <span aria-hidden>🔔</span>
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-xl">
          <header className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2.5">
            <p className="text-sm font-semibold">Notifications</p>
            {unread > 0 && (
              <button
                onClick={markAllRead}
                className="text-xs text-[var(--accent)] hover:underline"
              >
                Mark all read
              </button>
            )}
          </header>

          {error ? (
            <p className="px-4 py-6 text-center text-xs text-red-600 dark:text-red-400">
              Could not load notifications.
            </p>
          ) : items.length === 0 ? (
            <p className="px-4 py-8 text-center text-xs text-[var(--muted)]">
              Nothing needs your attention right now.
            </p>
          ) : (
            <ul className="max-h-80 overflow-y-auto">
              {items.map((n) => {
                const body = (
                  <>
                    <p className={`text-sm ${n.isRead ? "font-normal" : "font-medium"}`}>{n.title}</p>
                    {n.body && (
                      <p className="mt-0.5 line-clamp-2 text-xs text-[var(--muted)]">{n.body}</p>
                    )}
                    <p className="mt-1 text-[11px] text-[var(--muted)]">
                      {new Date(n.createdAt).toLocaleString()}
                    </p>
                  </>
                );
                return (
                  <li key={n.id} className="border-b border-[var(--border)] last:border-0">
                    {n.link ? (
                      <Link
                        href={n.link}
                        onClick={() => {
                          void markRead(n);
                          setOpen(false);
                        }}
                        className="block px-4 py-3 hover:bg-black/5 dark:hover:bg-white/5"
                      >
                        {body}
                      </Link>
                    ) : (
                      <button
                        onClick={() => void markRead(n)}
                        className="block w-full px-4 py-3 text-left hover:bg-black/5 dark:hover:bg-white/5"
                      >
                        {body}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
