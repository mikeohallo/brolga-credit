"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useResource, useAction, api } from "@/lib/client";
import { Card, PageHeader, Pill, Stat, LoanStatusPill, Money, Mono, Spinner, ErrorBanner, Empty } from "@/components/ui";
import { timeAgo, aud, dateTime } from "@/lib/format";
import type { Loan, Borrower } from "@/lib/db";

type Health = {
  mode: "sandbox" | "mock";
  apiVersion: string;
  baseUrl: string;
  account: { name: string; nickname: string; abn: string };
  operator: string;
  funding: { label: string; nppCapable: boolean; channels: string[]; accountType: string; availableBalance: number | null; accounts: { id: string; title: string; bank_name: string; account_type: string; available_balance: number | null; branch_code: string; account_number: string }[] };
  probes: { name: string; scope: string; ok: boolean; note?: string }[];
  counts: { borrowers: number; loans: number; apiCalls: number };
  checkedAt: string;
};

type LoansResp = { loans: (Loan & { borrower?: Borrower })[] };

export default function Overview() {
  const router = useRouter();
  const health = useResource<Health>("/api/health");
  const loans = useResource<LoansResp>("/api/loans", { poll: () => 5000 });
  const act = useAction();

  const all = loans.data?.loans ?? [];
  const active = all.filter((l) => ["active", "in_arrears", "suspended", "mandate_pending"].includes(l.status));
  const disbursed = all.reduce((sum, l) => sum + (l.disbursement?.creditStatus === "cleared" ? l.principalCents : 0), 0);
  const collected = all.reduce((sum, l) => sum + l.instalments.filter((i) => i.state === "settled").reduce((s, i) => s + i.amountCents, 0), 0);
  const arrears = all.filter((l) => l.status === "in_arrears").length;
  const events = all
    .flatMap((l) => l.events.map((e) => ({ ...e, loanId: l.id, borrower: l.borrower?.name })))
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, 8);

  const reset = () =>
    act.run("reset", async () => {
      if (!confirm("Reset the demo? Brolga forgets its loans and borrowers; objects already created in the Zepto sandbox remain there.")) return;
      await api("/api/demo/reset", { method: "POST" });
      loans.reload();
      health.reload();
      router.refresh();
    });

  return (
    <>
      <PageHeader
        kicker="Loan desk"
        title="Overview"
        actions={
          <>
            <button className="btn btn-ghost btn-sm" onClick={reset} disabled={act.busy === "reset"}>
              Reset demo
            </button>
            <Link href="/loans/new" className="btn btn-primary">
              New loan
            </Link>
          </>
        }
      >
        Small loans, settled in seconds. Disbursement over the NPP, repayments by PayTo, every movement reconciled against Zepto.
      </PageHeader>

      <ErrorBanner error={act.error} onDismiss={act.clearError} />
      <ErrorBanner error={health.error} />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Active loans" value={active.length} hint={`${all.length} total`} />
        <Stat label="Disbursed" value={aud(disbursed)} hint="cleared to borrowers" />
        <Stat label="Collected" value={aud(collected)} hint="PayTo instalments settled" />
        <Stat label="In arrears" value={arrears} tone={arrears ? "critical" : undefined} hint={arrears ? "needs attention" : "all current"} />
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <div className="space-y-4 lg:col-span-3">
          <Card title="Loans" subtitle="Most recent first" actions={<Link href="/loans" className="text-xs font-semibold text-brand hover:underline">All loans →</Link>} padded={false}>
            {loans.loading ? (
              <div className="flex items-center gap-2 p-5 text-sm text-ink-3">
                <Spinner /> Loading
              </div>
            ) : all.length === 0 ? (
              <div className="p-5">
                <Empty>
                  No loans yet.{" "}
                  <Link href="/loans/new" className="font-semibold text-brand hover:underline">
                    Write the first one
                  </Link>{" "}
                  — it takes about a minute end to end.
                </Empty>
              </div>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Loan</th>
                    <th>Borrower</th>
                    <th className="text-right">Principal</th>
                    <th>Status</th>
                    <th className="text-right">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {[...all]
                    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
                    .slice(0, 8)
                    .map((l) => (
                      <tr key={l.id} className="cursor-pointer" onClick={() => router.push(`/loans/${l.id}`)}>
                        <td>
                          <Link href={`/loans/${l.id}`} className="font-semibold text-brand hover:underline">
                            {l.id}
                          </Link>
                        </td>
                        <td>{l.borrower?.name ?? l.borrowerId}</td>
                        <td className="text-right">
                          <Money cents={l.principalCents} />
                        </td>
                        <td>
                          <LoanStatusPill status={l.status} />
                        </td>
                        <td className="text-right text-ink-3">{timeAgo(l.updatedAt)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card title="Activity" subtitle="What Zepto has told us, most recent first" padded={false}>
            {events.length === 0 ? (
              <div className="p-5 text-sm text-ink-3">Nothing has happened yet.</div>
            ) : (
              <ul className="divide-y divide-line">
                {events.map((e, i) => (
                  <li key={i} className="flex gap-3 px-5 py-3 text-sm">
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${e.level === "success" ? "bg-good" : e.level === "error" ? "bg-critical" : e.level === "warning" ? "bg-warn" : "bg-info"}`} />
                    <div className="min-w-0 flex-1">
                      <div className="break-words">{e.message}</div>
                      <div className="mt-0.5 text-xs text-ink-3">
                        <Link href={`/loans/${e.loanId}`} className="font-semibold text-brand hover:underline">
                          {e.loanId}
                        </Link>
                        {e.borrower && <> · {e.borrower}</>} · {dateTime(e.at)}
                        {e.ref && (
                          <>
                            {" "}
                            · <Mono>{e.ref}</Mono>
                          </>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-4 lg:col-span-2">
          <Card title="Zepto connection" subtitle={health.data ? `Checked ${timeAgo(health.data.checkedAt)}` : undefined} actions={<button className="btn btn-ghost btn-sm" onClick={() => api("/api/health?force=1").then(() => health.reload())}>Re-check</button>}>
            {!health.data ? (
              <div className="flex items-center gap-2 text-sm text-ink-3">
                <Spinner /> Checking the token, scopes and funding source
              </div>
            ) : (
              <div className="space-y-4 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-ink-3">Environment</span>
                  <Pill tone={health.data.mode === "sandbox" ? "brand" : "warn"}>{health.data.mode === "sandbox" ? "Zepto sandbox" : "Local mock"}</Pill>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-ink-3">Account</span>
                  <span className="truncate text-right font-medium">{health.data.account.name}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-ink-3">API version</span>
                  <Mono>Zepto-Api-Version: {health.data.apiVersion}</Mono>
                </div>
                <div>
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-ink-3">Funding source</span>
                    <Pill tone={health.data.funding.nppCapable ? "good" : "warn"}>{health.data.funding.nppCapable ? "NPP + DE" : "Direct Entry only"}</Pill>
                  </div>
                  <div className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-ink-2">
                    {health.data.funding.label}
                    {health.data.funding.availableBalance !== null && (
                      <div className="mt-1 text-sm font-semibold text-ink">
                        Balance <Money cents={health.data.funding.availableBalance} />
                      </div>
                    )}
                    {!health.data.funding.nppCapable && <div className="mt-1 text-warn">No Account Float on this sandbox yet, so payouts go by Direct Entry. Real-time NPP disbursement lights up the moment a float is enabled.</div>}
                  </div>
                </div>
                <div>
                  <div className="mb-1.5 text-ink-3">Capabilities on this token</div>
                  <ul className="space-y-1">
                    {health.data.probes.map((p) => (
                      <li key={p.name} className="flex items-center justify-between gap-2">
                        <span>{p.name}</span>
                        <span className="flex items-center gap-2">
                          {p.note && <span className="text-xs text-ink-3">{p.note}</span>}
                          <Pill tone={p.ok ? "good" : "warn"}>{p.ok ? "ok" : "unavailable"}</Pill>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="flex items-center justify-between text-xs text-ink-3">
                  <span>{health.data.counts.apiCalls} API calls logged</span>
                  <Link href="/console" className="font-semibold text-brand hover:underline">
                    Open console →
                  </Link>
                </div>
              </div>
            )}
          </Card>

          <Card title="How the demo flows">
            <ol className="space-y-2 text-sm text-ink-2">
              {[
                ["Verify", "Confirmation of Payee checks the name on the borrower's account before a cent moves."],
                ["Disburse", "One POST /payments. NPP when a float is funded, Direct Entry otherwise."],
                ["Mandate", "A PayTo agreement the borrower authorises in their own banking app."],
                ["Collect", "Each instalment is a PayTo payment that settles or fails in seconds."],
                ["Handle life", "Hardship suspensions, restructures by amendment, payoff by cancellation."],
              ].map(([k, v], i) => (
                <li key={k} className="flex gap-3">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-soft text-[11px] font-bold text-brand-ink">{i + 1}</span>
                  <span>
                    <span className="font-semibold text-ink">{k}.</span> {v}
                  </span>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
    </>
  );
}
