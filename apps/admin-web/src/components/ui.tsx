import type { ReactNode } from 'react';
import { formatMoney } from '@transportco/utils';

/**
 * Console design-system primitives.
 *
 * Small and deliberately unclever: server components by default, no runtime
 * styling library, no context. Anything interactive is a separate client
 * component so the console ships almost no JavaScript for pages that only read.
 */

export function Card({
  title,
  action,
  children,
  className = '',
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <header className="card-header">
          {title ? <h2 className="card-title">{title}</h2> : <span />}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'default' | 'warning' | 'danger' | 'success';
}) {
  const toneClass = {
    default: 'text-ink-900',
    warning: 'text-warning-700',
    danger: 'text-danger-700',
    success: 'text-success-700',
  }[tone];

  return (
    <div className="card px-5 py-4">
      <p className="stat-label">{label}</p>
      <p className={`stat-value ${toneClass}`}>{value}</p>
      {hint ? <p className="mt-1 text-xs text-ink-500">{hint}</p> : null}
    </div>
  );
}

/** Trip and driver states, coloured so a board can be read at a glance. */
const STATUS_TONES: Record<string, string> = {
  // Trip
  REQUESTED: 'bg-ink-100 text-ink-700',
  FARE_CALCULATED: 'bg-info-100 text-info-700',
  NEGOTIATING: 'bg-accent-100 text-accent-700',
  FARE_ACCEPTED: 'bg-success-100 text-success-700',
  FARE_LOCKED: 'bg-brand-100 text-brand-700',
  DRIVER_ASSIGNED: 'bg-brand-100 text-brand-700',
  DRIVER_EN_ROUTE: 'bg-brand-200 text-brand-800',
  DRIVER_ARRIVED: 'bg-accent-200 text-accent-800',
  TRIP_STARTED: 'bg-success-100 text-success-700',
  TRIP_COMPLETED: 'bg-success-100 text-success-700',
  PAYMENT_PENDING: 'bg-warning-100 text-warning-700',
  PAYMENT_COMPLETED: 'bg-success-100 text-success-700',
  REVIEW_PENDING: 'bg-ink-100 text-ink-700',
  COMPLETED: 'bg-success-100 text-success-700',
  CANCELLED: 'bg-danger-100 text-danger-700',
  EXPIRED: 'bg-ink-200 text-ink-600',
  DRIVER_UNAVAILABLE: 'bg-danger-100 text-danger-700',
  REASSIGNED: 'bg-warning-100 text-warning-700',
  PAYMENT_FAILED: 'bg-danger-100 text-danger-700',
  DISPUTED: 'bg-danger-100 text-danger-700',
  NO_SHOW: 'bg-warning-100 text-warning-700',
  // Driver
  OFFLINE: 'bg-ink-200 text-ink-600',
  ONLINE: 'bg-info-100 text-info-700',
  AVAILABLE: 'bg-success-100 text-success-700',
  ASSIGNED: 'bg-brand-100 text-brand-700',
  PICKING_UP: 'bg-brand-200 text-brand-800',
  ARRIVED: 'bg-accent-200 text-accent-800',
  ON_TRIP: 'bg-success-100 text-success-700',
  ON_BREAK: 'bg-warning-100 text-warning-700',
  SUSPENDED: 'bg-danger-100 text-danger-700',
  // Generic
  paid: 'bg-success-100 text-success-700',
  unpaid: 'bg-ink-100 text-ink-700',
  pending: 'bg-warning-100 text-warning-700',
  failed: 'bg-danger-100 text-danger-700',
  succeeded: 'bg-success-100 text-success-700',
};

export function StatusBadge({ status }: { status: string }) {
  const tone = STATUS_TONES[status] ?? 'bg-ink-100 text-ink-700';
  return <span className={`badge ${tone}`}>{status.replace(/_/g, ' ').toLowerCase()}</span>;
}

export function Money({ minor, className = '' }: { minor: number | null | undefined; className?: string }) {
  if (minor == null) return <span className="text-ink-400">—</span>;
  return <span className={`tabular font-semibold ${className}`}>{formatMoney(minor)}</span>;
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <p className="text-sm font-semibold text-ink-700">{title}</p>
      {hint ? <p className="mt-1 max-w-sm text-sm text-ink-500">{hint}</p> : null}
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 px-6 py-10 text-center">
      <p className="text-sm font-semibold text-danger-700">Could not load this</p>
      <p className="max-w-sm text-sm text-ink-500">{message}</p>
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-bold text-ink-900">{title}</h1>
        {subtitle ? <p className="mt-0.5 text-sm text-ink-500">{subtitle}</p> : null}
      </div>
      {action}
    </header>
  );
}

/** Relative time. Dispatchers think in "4 min ago", not in timestamps. */
export function TimeAgo({ at }: { at: string | null }) {
  if (!at) return <span className="text-ink-400">—</span>;

  const seconds = Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 1000));
  const label =
    seconds < 60
      ? `${seconds}s ago`
      : seconds < 3600
        ? `${Math.round(seconds / 60)} min ago`
        : seconds < 86_400
          ? `${Math.round(seconds / 3600)} hr ago`
          : new Date(at).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' });

  return (
    <time dateTime={at} title={new Date(at).toLocaleString('en-NG')} className="text-ink-500">
      {label}
    </time>
  );
}

/** Workload pill used on the dispatch board. */
export function WorkloadPill({ score }: { score: number }) {
  const [label, tone] =
    score < 0.34
      ? ['Low', 'bg-success-100 text-success-700']
      : score < 0.67
        ? ['Medium', 'bg-warning-100 text-warning-700']
        : ['High', 'bg-danger-100 text-danger-700'];

  return <span className={`badge ${tone}`}>{label}</span>;
}
