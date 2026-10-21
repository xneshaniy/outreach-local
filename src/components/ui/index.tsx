"use client";

import { useEffect, useId, useRef, useState } from "react";

/* ===========================================================================
   Design system
   ---------------------------------------------------------------------------
   One set of primitives used by every screen: buttons, controls, cards, metric
   tiles, tables, badges, modals, tabs, tooltips, empty/loading/error states.

   Rules that keep it consistent:
     - one radius scale (sm / md / lg)
     - one shadow scale (xs / sm / md)
     - one accent colour, semantic colours only for meaning
     - every control is keyboard reachable and labelled
   =========================================================================== */

/* ---------------------------------------------------------------------------
   Surfaces
   ------------------------------------------------------------------------- */

export function Card({
  title,
  description,
  actions,
  children,
  className = "",
  contentClassName = "",
  padded = true,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  contentClassName?: string;
  padded?: boolean;
}) {
  return (
    <section
      className={`rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-xs)] ${className}`}
    >
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
          <div className="min-w-0">
            {title && <h2 className="text-[15px] font-semibold leading-6">{title}</h2>}
            {description && (
              <p className="mt-0.5 text-[13px] leading-5 text-[var(--muted)]">{description}</p>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={`${padded ? "p-5" : ""} ${contentClassName}`}>{children}</div>
    </section>
  );
}

/**
 * A metric tile. `value` may be a number or a node; `unavailable` renders a
 * clear "not available" state so a missing metric is never confused with zero.
 */
export function StatCard({
  label,
  value,
  hint,
  icon,
  unavailable = false,
  tone = "default",
  footer,
}: {
  label: string;
  value?: React.ReactNode;
  hint?: React.ReactNode;
  icon?: React.ReactNode;
  unavailable?: boolean;
  tone?: "default" | "success" | "warning" | "danger" | "accent";
  footer?: React.ReactNode;
}) {
  const valueTone: Record<string, string> = {
    default: "text-[var(--text)]",
    success: "text-[var(--success)]",
    warning: "text-[var(--warning)]",
    danger: "text-[var(--danger)]",
    accent: "text-[var(--accent)]",
  };
  return (
    <div className="group relative rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-xs)] transition-shadow duration-150 hover:shadow-[var(--shadow-sm)]">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[12px] font-medium uppercase tracking-[0.06em] text-[var(--muted)]">
          {label}
        </p>
        {icon && (
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius)] bg-[var(--surface-3)] text-[var(--muted)] transition-colors group-hover:bg-[var(--accent-soft)] group-hover:text-[var(--accent)]">
            {icon}
          </span>
        )}
      </div>
      {unavailable ? (
        <p className="mt-2 text-[15px] font-medium text-[var(--muted-2)]">Not available</p>
      ) : (
        <p className={`tnum mt-2 text-[28px] font-semibold leading-8 ${valueTone[tone]}`}>{value}</p>
      )}
      {hint && <p className="mt-1.5 text-[12.5px] leading-5 text-[var(--muted)]">{hint}</p>}
      {footer && <div className="mt-3 border-t border-[var(--border)] pt-3">{footer}</div>}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Buttons
   ------------------------------------------------------------------------- */

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "outline" | "ghost" | "danger" | "success";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
  icon?: React.ReactNode;
};

export function Button({
  variant = "primary",
  size = "md",
  loading,
  icon,
  children,
  className = "",
  disabled,
  type,
  ...rest
}: ButtonProps) {
  const variants: Record<string, string> = {
    primary:
      "bg-[var(--accent)] text-[var(--on-accent)] shadow-[var(--shadow-xs)] hover:bg-[var(--accent-hover)]",
    secondary:
      "bg-[var(--surface-3)] text-[var(--text)] hover:bg-[var(--border)]",
    outline:
      "border border-[var(--border-strong)] bg-[var(--surface)] text-[var(--text)] hover:bg-[var(--surface-3)]",
    ghost: "text-[var(--text-secondary)] hover:bg-[var(--surface-3)]",
    danger: "bg-[var(--danger)] text-white shadow-[var(--shadow-xs)] hover:opacity-90",
    success: "bg-[var(--success)] text-white shadow-[var(--shadow-xs)] hover:opacity-90",
  };
  const sizes: Record<string, string> = {
    sm: "h-8 gap-1.5 rounded-[var(--radius-sm)] px-2.5 text-[13px]",
    md: "h-9 gap-2 rounded-[var(--radius)] px-3.5 text-[13.5px]",
    lg: "h-11 gap-2 rounded-[var(--radius)] px-5 text-[15px]",
  };
  return (
    <button
      {...rest}
      type={type ?? "button"}
      disabled={disabled || loading}
      className={`inline-flex shrink-0 items-center justify-center font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${variants[variant]} ${sizes[size]} ${className}`}
    >
      {loading ? <Spinner className="h-4 w-4" /> : icon}
      {children}
    </button>
  );
}

export function Spinner({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" role="status" aria-label="Loading">
      <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path
        className="opacity-90"
        fill="currentColor"
        d="M12 2a10 10 0 0 1 10 10h-3a7 7 0 0 0-7-7V2z"
      />
    </svg>
  );
}

/* ---------------------------------------------------------------------------
   Form controls
   ------------------------------------------------------------------------- */

const controlClass =
  "w-full rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--surface)] px-3 py-2 text-[13.5px] text-[var(--text)] placeholder:text-[var(--muted-2)] transition-colors focus:border-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/25 disabled:cursor-not-allowed disabled:bg-[var(--surface-3)] disabled:text-[var(--muted)]";

export function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
  required,
  className = "",
}: {
  label: string;
  htmlFor: string;
  error?: string | null;
  hint?: React.ReactNode;
  children: React.ReactNode;
  required?: boolean;
  className?: string;
}) {
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <label htmlFor={htmlFor} className="text-[13px] font-medium text-[var(--text-secondary)]">
        {label}
        {required && (
          <span className="ml-0.5 text-[var(--danger)]" aria-hidden>
            *
          </span>
        )}
      </label>
      {children}
      {hint && !error && <p className="text-[12px] leading-4.5 text-[var(--muted)]">{hint}</p>}
      {error && (
        <p role="alert" className="text-[12px] leading-4.5 text-[var(--danger)]">
          {error}
        </p>
      )}
    </div>
  );
}

export function Input({
  invalid,
  className = "",
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input
      {...rest}
      aria-invalid={invalid || undefined}
      className={`${controlClass} ${invalid ? "border-[var(--danger)] focus:ring-[var(--danger)]/25" : ""} ${className}`}
    />
  );
}

export function Textarea({
  invalid,
  className = "",
  ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return (
    <textarea
      {...rest}
      aria-invalid={invalid || undefined}
      className={`${controlClass} min-h-28 resize-y font-mono text-[12.5px] leading-5 ${invalid ? "border-[var(--danger)]" : ""} ${className}`}
    />
  );
}

export function Select({
  className = "",
  children,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={`${controlClass} cursor-pointer pr-8 ${className}`}>
      {children}
    </select>
  );
}

export function Checkbox({
  label,
  description,
  className = "",
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement> & { label: React.ReactNode; description?: React.ReactNode }) {
  const id = useId();
  return (
    <div className={`flex items-start gap-2.5 ${className}`}>
      <input
        {...rest}
        id={rest.id ?? id}
        type="checkbox"
        className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded border-[var(--border-strong)] text-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]/30"
      />
      <div className="min-w-0">
        <label htmlFor={rest.id ?? id} className="cursor-pointer text-[13.5px] leading-5 text-[var(--text)]">
          {label}
        </label>
        {description && <p className="text-[12px] leading-4.5 text-[var(--muted)]">{description}</p>}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Badges
   ------------------------------------------------------------------------- */

export type BadgeTone = "neutral" | "success" | "danger" | "warning" | "info" | "accent" | "purple";

/** Legacy tone names kept as aliases so older screens keep working. */
type LegacyBadgeTone = "green" | "red" | "amber" | "blue";
const LEGACY_TONE: Record<LegacyBadgeTone, BadgeTone> = {
  green: "success",
  red: "danger",
  amber: "warning",
  blue: "info",
};

export function Badge({
  tone = "neutral",
  children,
  dot = false,
  className = "",
}: {
  tone?: BadgeTone | LegacyBadgeTone;
  children: React.ReactNode;
  dot?: boolean;
  className?: string;
}) {
  const resolved = (tone in LEGACY_TONE ? LEGACY_TONE[tone as LegacyBadgeTone] : tone) as BadgeTone;
  const tones: Record<BadgeTone, string> = {
    neutral: "bg-[var(--surface-3)] text-[var(--text-secondary)]",
    success: "bg-[var(--success-soft)] text-[var(--success)]",
    danger: "bg-[var(--danger-soft)] text-[var(--danger)]",
    warning: "bg-[var(--warning-soft)] text-[var(--warning)]",
    info: "bg-[var(--info-soft)] text-[var(--info)]",
    accent: "bg-[var(--accent-soft)] text-[var(--accent)]",
    purple: "bg-[var(--accent-soft)] text-[var(--accent)]",
  };
  const dotTone: Record<BadgeTone, string> = {
    neutral: "bg-[var(--muted-2)]",
    success: "bg-[var(--success)]",
    danger: "bg-[var(--danger)]",
    warning: "bg-[var(--warning)]",
    info: "bg-[var(--info)]",
    accent: "bg-[var(--accent)]",
    purple: "bg-[var(--accent)]",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11.5px] font-medium ${tones[resolved]} ${className}`}
    >
      {dot && <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${dotTone[resolved]}`} />}
      {children}
    </span>
  );
}

const STATUS_TONE: Record<string, BadgeTone> = {
  SENT: "success",
  CONNECTED: "success",
  ACTIVE: "success",
  COMPLETED: "success",
  SUCCESS: "success",
  INTERESTED: "success",
  DELIVERED: "success",
  ACCEPTED: "success",
  FAILED: "danger",
  ERROR: "danger",
  DISCONNECTED: "danger",
  CANCELLED: "danger",
  BOUNCED: "danger",
  COMPLAINED: "danger",
  INVALID: "danger",
  NOT_INTERESTED: "danger",
  QUEUED: "info",
  SCHEDULED: "info",
  SENDING: "info",
  CLAIMED: "info",
  PROCESSING: "info",
  REPLIED: "accent",
  PAUSED: "warning",
  HELD_TZ: "warning",
  AMBIGUOUS: "warning",
  SKIPPED: "warning",
  NEEDS_INFO: "warning",
  DRAFT: "neutral",
  ARCHIVED: "neutral",
  UNSUBSCRIBED: "neutral",
};

export function StatusBadge({ status }: { status: string }) {
  const tone = STATUS_TONE[status] ?? "neutral";
  return (
    <Badge tone={tone} dot>
      {status.replace(/_/g, " ")}
    </Badge>
  );
}

/* ---------------------------------------------------------------------------
   Tables
   ------------------------------------------------------------------------- */

export function Table({ headers, children, className = "" }: { headers: string[]; children: React.ReactNode; className?: string }) {
  return (
    <div className={`-mx-1 overflow-x-auto ${className}`}>
      <table className="w-full min-w-[640px] text-left text-[13.5px]">
        <thead>
          <tr className="border-b border-[var(--border)]">
            {headers.map((h) => (
              <th
                key={h}
                scope="col"
                className="whitespace-nowrap px-3 py-2.5 text-[11.5px] font-semibold uppercase tracking-[0.05em] text-[var(--muted)]"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--border)]">{children}</tbody>
      </table>
    </div>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] px-1 pt-3 text-[12.5px] text-[var(--muted)]">
      <span className="tnum">
        Page {page} of {pages} · {total.toLocaleString()} total
      </span>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
        </Button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   States
   ------------------------------------------------------------------------- */

export function EmptyState({
  title,
  description,
  action,
  icon = "◦",
}: {
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-[var(--radius-lg)] border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)] px-6 py-12 text-center">
      <span
        aria-hidden
        className="grid h-10 w-10 place-items-center rounded-full bg-[var(--surface-3)] text-[var(--muted)]"
      >
        {icon}
      </span>
      <p className="text-[14px] font-semibold">{title}</p>
      {description && (
        <p className="max-w-md text-[13px] leading-5 text-[var(--muted)]">{description}</p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Skeleton({ className = "h-4 w-full" }: { className?: string }) {
  return <div className={`animate-pulse rounded-[var(--radius-sm)] bg-[var(--surface-3)] ${className}`} />;
}

/** A soft, friendly error panel with a retry affordance. */
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius)] border border-[var(--danger-border)] bg-[var(--danger-soft)] px-4 py-3 text-[13px] text-[var(--danger)]"
    >
      <span className="flex items-center gap-2">
        <span aria-hidden>⚠</span>
        {message}
      </span>
      {onRetry && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

/** An inline informational note (used for the "approximate metric" caveats). */
export function Note({
  children,
  tone = "info",
  icon,
}: {
  children: React.ReactNode;
  tone?: "info" | "warning" | "success" | "danger";
  icon?: React.ReactNode;
}) {
  const tones = {
    info: "border-[var(--info-border)] bg-[var(--info-soft)] text-[var(--info)]",
    warning: "border-[var(--warning-border)] bg-[var(--warning-soft)] text-[var(--warning)]",
    success: "border-[var(--success-border)] bg-[var(--success-soft)] text-[var(--success)]",
    danger: "border-[var(--danger-border)] bg-[var(--danger-soft)] text-[var(--danger)]",
  };
  return (
    <div className={`flex items-start gap-2.5 rounded-[var(--radius)] border px-4 py-3 text-[12.5px] leading-5 ${tones[tone]}`}>
      {icon && <span aria-hidden className="mt-px shrink-0">{icon}</span>}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Overlays
   ------------------------------------------------------------------------- */

export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  title: string;
  description?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    // Move focus into the dialog.
    const timer = setTimeout(() => {
      const focusable = ref.current?.querySelector<HTMLElement>(
        "input,select,textarea,button,[href],[tabindex]:not([tabindex='-1'])",
      );
      focusable?.focus();
    }, 30);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      clearTimeout(timer);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;

  const widths = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-3xl" };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-[#0b1020]/45 p-0 backdrop-blur-[2px] sm:items-center sm:p-4">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`w-full ${widths[size]} overflow-hidden rounded-t-[var(--radius-xl)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-lg)] sm:rounded-[var(--radius-xl)]`}
      >
        <header className="flex items-start justify-between gap-4 border-b border-[var(--border)] px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold">{title}</h2>
            {description && <p className="mt-0.5 text-[12.5px] text-[var(--muted)]">{description}</p>}
          </div>
          <button
            onClick={onClose}
            aria-label="Close dialog"
            className="-mr-1 -mt-1 shrink-0 rounded-[var(--radius-sm)] p-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--text)]"
          >
            ✕
          </button>
        </header>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4 text-[13.5px]">{children}</div>
        {footer && (
          <footer className="flex flex-wrap justify-end gap-2 border-t border-[var(--border)] bg-[var(--surface-2)] px-5 py-3.5">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  loading,
  onConfirm,
  onClose,
  destructive = true,
}: {
  open: boolean;
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  loading?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  destructive?: boolean;
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button variant={destructive ? "danger" : "primary"} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-[13.5px] leading-6 text-[var(--text-secondary)]">{message}</div>
    </Modal>
  );
}

/* ---------------------------------------------------------------------------
   Navigation & layout helpers
   ------------------------------------------------------------------------- */

export function Tabs({
  tabs,
  value,
  onChange,
}: {
  tabs: Array<{ key: string; label: string; count?: number }>;
  value: string;
  onChange: (key: string) => void;
}) {
  return (
    <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-[var(--border)]">
      {tabs.map((t) => {
        const active = value === t.key;
        return (
          <button
            key={t.key}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.key)}
            className={`-mb-px flex shrink-0 items-center gap-2 border-b-2 px-3.5 py-2.5 text-[13.5px] font-medium transition-colors ${
              active
                ? "border-[var(--accent)] text-[var(--accent)]"
                : "border-transparent text-[var(--muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)]"
            }`}
          >
            {t.label}
            {typeof t.count === "number" && (
              <span
                className={`tnum rounded-full px-1.5 py-0.5 text-[11px] ${
                  active ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "bg-[var(--surface-3)] text-[var(--muted)]"
                }`}
              >
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** A small "info" tooltip that works on hover AND on keyboard focus. */
export function Tooltip({
  content,
  children,
  align = "left",
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  align?: "left" | "center";
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <span aria-describedby={open ? id : undefined} tabIndex={0} className="inline-flex focus:outline-none">
        {children}
      </span>
      {open && (
        <span
          id={id}
          role="tooltip"
          className={`pointer-events-none absolute bottom-full z-50 mb-1.5 w-56 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--text)] px-2.5 py-2 text-[11.5px] font-normal leading-4.5 text-[var(--surface)] shadow-[var(--shadow-md)] ${
            align === "center" ? "left-1/2 -translate-x-1/2" : "left-0"
          }`}
        >
          {content}
        </span>
      )}
    </span>
  );
}

/** An inline "i" affordance that explains a metric. */
export function InfoHint({ content }: { content: React.ReactNode }) {
  return (
    <Tooltip content={content}>
      <span
        aria-label="More information"
        className="grid h-3.5 w-3.5 cursor-help place-items-center rounded-full border border-[var(--border-strong)] text-[9px] font-semibold text-[var(--muted)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
      >
        i
      </span>
    </Tooltip>
  );
}

export function ProgressBar({
  value,
  max = 100,
  tone = "accent",
  label,
}: {
  value: number;
  max?: number;
  tone?: "accent" | "success" | "warning" | "danger";
  label?: string;
}) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const tones = {
    accent: "bg-[var(--accent)]",
    success: "bg-[var(--success)]",
    warning: "bg-[var(--warning)]",
    danger: "bg-[var(--danger)]",
  };
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-3)]"
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-label={label ?? "Progress"}
    >
      <div className={`h-full rounded-full transition-[width] duration-300 ${tones[tone]}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** A small dropdown menu. Closes on Escape and on an outside click. */
export function Menu({
  trigger,
  children,
  align = "right",
}: {
  trigger: React.ReactNode;
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <div onClick={() => setOpen((o) => !o)}>{trigger}</div>
      {open && (
        <div
          className={`absolute z-50 mt-1.5 min-w-48 overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-1 shadow-[var(--shadow-md)] ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  children,
  onClick,
  danger = false,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-left text-[13px] transition-colors ${
        danger
          ? "text-[var(--danger)] hover:bg-[var(--danger-soft)]"
          : "text-[var(--text-secondary)] hover:bg-[var(--surface-3)] hover:text-[var(--text)]"
      }`}
    >
      {children}
    </button>
  );
}

/** A labelled section heading used inside cards. */
export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11.5px] font-semibold uppercase tracking-[0.06em] text-[var(--muted)]">
      {children}
    </p>
  );
}
