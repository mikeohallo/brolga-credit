"use client";

import type { ReactNode } from "react";
import { aud } from "@/lib/format";

// ---- status vocabulary -----------------------------------------------------
// Status colours are reserved and always paired with a label (never colour alone).

export type Tone = "neutral" | "info" | "good" | "warn" | "serious" | "critical" | "brand";

const TONE_CLASS: Record<Tone, string> = {
  neutral: "bg-neutral-soft text-ink-2",
  info: "bg-info-soft text-info",
  good: "bg-good-soft text-good",
  warn: "bg-warn-soft text-warn",
  serious: "bg-serious-soft text-serious",
  critical: "bg-critical-soft text-critical",
  brand: "bg-brand-soft text-brand-ink",
};

const DOT_CLASS: Record<Tone, string> = {
  neutral: "bg-ink-3",
  info: "bg-info",
  good: "bg-good",
  warn: "bg-warn",
  serious: "bg-serious",
  critical: "bg-critical",
  brand: "bg-brand",
};

export function Pill({ tone = "neutral", children, pulse, className = "" }: { tone?: Tone; children: ReactNode; pulse?: boolean; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONE_CLASS[tone]} ${className}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${DOT_CLASS[tone]} ${pulse ? "pulse" : ""}`} />
      {children}
    </span>
  );
}

export const LOAN_STATUS: Record<string, { label: string; tone: Tone; pulse?: boolean }> = {
  draft: { label: "Draft", tone: "neutral" },
  verified: { label: "Account verified", tone: "info" },
  disbursing: { label: "Disbursing", tone: "info", pulse: true },
  disbursed: { label: "Disbursed · no mandate", tone: "warn" },
  disbursement_failed: { label: "Disbursement failed", tone: "critical" },
  mandate_pending: { label: "Awaiting PayTo authorisation", tone: "info", pulse: true },
  active: { label: "Active", tone: "good" },
  in_arrears: { label: "In arrears", tone: "serious" },
  suspended: { label: "Suspended", tone: "warn" },
  closed: { label: "Repaid", tone: "brand" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

export const PAYOUT_STATUS: Record<string, { tone: Tone; pulse?: boolean }> = {
  scheduled: { tone: "info", pulse: true },
  maturing: { tone: "info", pulse: true },
  matured: { tone: "info", pulse: true },
  preprocessing: { tone: "info", pulse: true },
  processing: { tone: "info", pulse: true },
  clearing: { tone: "info", pulse: true },
  cleared: { tone: "good" },
  channel_switched: { tone: "warn", pulse: true },
  returned: { tone: "critical" },
  rejected: { tone: "critical" },
  voided: { tone: "neutral" },
  paused: { tone: "warn" },
  pending_verification: { tone: "warn" },
};

export const AGREEMENT_STATUS: Record<string, { tone: Tone; pulse?: boolean }> = {
  pending: { tone: "info", pulse: true },
  created: { tone: "info", pulse: true },
  active: { tone: "good" },
  suspended: { tone: "warn" },
  declined: { tone: "critical" },
  expired: { tone: "serious" },
  failed: { tone: "critical" },
  cancelled: { tone: "neutral" },
};

export const INSTALMENT_STATUS: Record<string, { label: string; tone: Tone; pulse?: boolean }> = {
  scheduled: { label: "Scheduled", tone: "neutral" },
  created: { label: "Initiated", tone: "info", pulse: true },
  submitting: { label: "Submitting", tone: "info", pulse: true },
  pending: { label: "Pending", tone: "warn", pulse: true },
  under_investigation: { label: "Under investigation", tone: "warn", pulse: true },
  settled: { label: "Settled", tone: "good" },
  failed: { label: "Failed", tone: "critical" },
};

export function LoanStatusPill({ status }: { status: string }) {
  const s = LOAN_STATUS[status] ?? { label: status, tone: "neutral" as Tone };
  return (
    <Pill tone={s.tone} pulse={s.pulse}>
      {s.label}
    </Pill>
  );
}

// ---- layout primitives -----------------------------------------------------

export function PageHeader({ title, kicker, children, actions }: { title: ReactNode; kicker?: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        {kicker && <div className="label mb-1">{kicker}</div>}
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {children && <p className="mt-1 max-w-2xl text-sm text-ink-2">{children}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, subtitle, children, actions, className = "", padded = true }: { title?: ReactNode; subtitle?: ReactNode; children: ReactNode; actions?: ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-3.5">
          <div>
            {title && <h2 className="text-sm font-semibold">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-ink-3">{subtitle}</p>}
          </div>
          {actions}
        </header>
      )}
      <div className={padded ? "p-5" : ""}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: Tone }) {
  return (
    <div className="card px-5 py-4">
      <div className="label">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tracking-tight tnum ${tone === "critical" ? "text-critical" : tone === "good" ? "text-good" : ""}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-ink-3">{hint}</div>}
    </div>
  );
}

export function Kv({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
      {rows.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-ink-3">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Money({ cents, className = "" }: { cents: number; className?: string }) {
  return <span className={`tnum ${className}`}>{aud(cents)}</span>;
}

export function Mono({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <code className={`mono rounded bg-neutral-soft px-1.5 py-0.5 text-[12px] ${className}`}>{children}</code>;
}

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg className={`h-4 w-4 animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export type ApiError = { source: "zepto" | "brolga"; status?: number; code?: string; title: string; detail: string; requiredScope?: string; requestId?: string; path?: string };

export function ErrorBanner({ error, onDismiss }: { error: ApiError | null; onDismiss?: () => void }) {
  if (!error) return null;
  const isScope = !!error.requiredScope;
  return (
    <div className={`rise mb-4 flex items-start gap-3 rounded-xl border px-4 py-3 text-sm ${isScope ? "border-warn/30 bg-warn-soft text-warn" : "border-critical/30 bg-critical-soft text-critical"}`}>
      <span className="mt-0.5 text-base leading-none" aria-hidden>
        {isScope ? "⚠" : "✕"}
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-semibold">
          {error.source === "zepto" ? "Zepto said: " : ""}
          {error.code ? `${error.code} · ` : ""}
          {error.title}
        </div>
        <div className="mt-0.5 break-words opacity-90">{error.detail}</div>
        {(error.path || error.requestId) && (
          <div className="mt-1 text-xs opacity-70">
            {error.path && <span className="mono">{error.path}</span>}
            {error.requestId && <span className="ml-2 mono">req {error.requestId}</span>}
          </div>
        )}
      </div>
      {onDismiss && (
        <button onClick={onDismiss} className="text-xs opacity-70 hover:opacity-100">
          Dismiss
        </button>
      )}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-line-strong px-6 py-10 text-center text-sm text-ink-3">{children}</div>;
}
