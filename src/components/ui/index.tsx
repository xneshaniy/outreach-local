"use client";

/**
 * Form + display primitives. All controls are accessible:
 * labels are wired via htmlFor/id, inputs have aria-invalid on errors,
 * and buttons expose type= explicitly.
 */

export function Card({ title, description, actions, children }: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-sm">
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-5 py-4">
          <div>
            {title && <h2 className="text-base font-semibold">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-[var(--muted)]">{description}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  loading?: boolean;
};

export function Button({ variant = "primary", loading, children, className = "", disabled, ...rest }: ButtonProps) {
  const styles: Record<string, string> = {
    primary: "bg-[var(--accent)] text-white hover:opacity-90",
    secondary: "border border-[var(--border)] bg-[var(--surface)] hover:bg-black/5 dark:hover:bg-white/5",
    danger: "bg-red-600 text-white hover:bg-red-700",
    ghost: "text-[var(--muted)] hover:bg-black/5 dark:hover:bg-white/5",
  };
  return (
    <button
      {...rest}
      type={rest.type ?? "button"}
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${styles[variant]} ${className}`}
    >
      {loading && <Spinner className="h-4 w-4" />}
      {children}
    </button>
  );
}

export function Spinner({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-label="Loading">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

export function Field({ label, htmlFor, error, hint, children }: {
  label: string;
  htmlFor: string;
  error?: string | null;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-[var(--muted)]">{hint}</p>}
      {error && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

const controlClass =
  "w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] placeholder:text-[var(--muted)] focus:border-[var(--accent)]";

export function Input(props: React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  const { invalid, className = "", ...rest } = props;
  return <input {...rest} aria-invalid={invalid || undefined} className={`${controlClass} ${invalid ? "border-red-500" : ""} ${className}`} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  const { invalid, className = "", ...rest } = props;
  return <textarea {...rest} aria-invalid={invalid || undefined} className={`${controlClass} min-h-28 font-mono text-[13px] ${invalid ? "border-red-500" : ""} ${className}`} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const { className = "", ...rest } = props;
  return <select {...rest} className={`${controlClass} ${className}`} />;
}

export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "green" | "red" | "amber" | "blue" | "purple"; children: React.ReactNode }) {
  const tones: Record<string, string> = {
    neutral: "bg-black/5 dark:bg-white/10 text-[var(--muted)]",
    green: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    red: "bg-red-500/15 text-red-700 dark:text-red-300",
    amber: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    blue: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
    purple: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>
  );
}

export function Table({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-[var(--border)] text-xs uppercase tracking-wide text-[var(--muted)]">
            {headers.map((h) => (
              <th key={h} scope="col" className="px-3 py-2.5 font-medium">
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

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-[var(--border)] px-6 py-12 text-center">
      <p className="text-sm font-semibold">{title}</p>
      {description && <p className="max-w-md text-sm text-[var(--muted)]">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Skeleton({ className = "h-4 w-full" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-black/5 dark:bg-white/10 ${className}`} />;
}

export function Modal({ open, title, onClose, children, footer }: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="w-full max-w-lg rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl">
        <header className="flex items-center justify-between border-b border-[var(--border)] px-5 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button onClick={onClose} aria-label="Close dialog" className="rounded p-1 text-[var(--muted)] hover:bg-black/5 dark:hover:bg-white/10">
            ✕
          </button>
        </header>
        <div className="px-5 py-4 text-sm">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-[var(--border)] px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

/** Confirmation dialog for destructive/irreversible actions. */
export function ConfirmDialog({ open, title, message, confirmLabel = "Confirm", loading, onConfirm, onClose }: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  loading?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-[var(--muted)]">{message}</p>
    </Modal>
  );
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;
  return (
    <div className="flex items-center justify-between px-1 pt-3 text-sm text-[var(--muted)]">
      <span>
        Page {page} of {pages} · {total} total
      </span>
      <div className="flex gap-2">
        <Button variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <Button variant="secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
        </Button>
      </div>
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const tone =
    ["SENT", "CONNECTED", "ACTIVE", "COMPLETED", "SUCCESS", "INTERESTED"].includes(status)
      ? "green"
      : ["FAILED", "ERROR", "DISCONNECTED", "CANCELLED", "BOUNCED", "COMPLAINED", "INVALID", "NOT_INTERESTED"].includes(status)
        ? "red"
        : ["QUEUED", "SCHEDULED", "SENDING", "CLAIMED", "PROCESSING", "REPLIED"].includes(status)
          ? "blue"
          : ["PAUSED", "HELD_TZ", "AMBIGUOUS", "SKIPPED", "NEEDS_INFO"].includes(status)
            ? "amber"
            : "neutral";
  return <Badge tone={tone as never}>{status.replace(/_/g, " ")}</Badge>;
}
