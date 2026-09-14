"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useResource, useAction, api } from "@/lib/client";
import { Card, PageHeader, Pill, Money, Mono, Spinner, ErrorBanner, StaleBanner, Kv, LoanStatusPill, PAYOUT_STATUS, AGREEMENT_STATUS, INSTALMENT_STATUS } from "@/components/ui";
import type { Loan, Borrower, Instalment } from "@/lib/db";
import { aud, shortDate, dateTime, clock } from "@/lib/format";

type Eligibility = { ok: boolean; instalment: Instalment | null; reason?: string; waiting?: boolean };
type Resp = {
  loan: Loan;
  borrower: Borrower;
  inFlight: boolean;
  next: { instalment: Instalment | null; reason?: string };
  eligibility: Eligibility;
  balance: { obligationCents: number; settledCents: number; outstandingCents: number };
  refreshError: string | null;
  store: { readable: boolean; error?: string };
};
type Plan = { instalmentCents: number; count: number; roundingCents: number; remainingCents: number; firstDueDate: string; lastDueDate: string; committedCount: number };

const PAYOUT_STEPS = ["matured", "preprocessing", "processing", "clearing", "cleared"];
const FAILED = ["returned", "rejected", "voided"];

export default function LoanDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const res = useResource<Resp>(`/api/loans/${id}?refresh=1`, { poll: (d) => (d?.inFlight ? 2500 : 8000) });
  const act = useAction();
  const [agreementSim, setAgreementSim] = useState("debtor_accept");
  const [paymentSim, setPaymentSim] = useState("auto_settle");
  const [retrySim, setRetrySim] = useState("auto_settle");
  const [amendAmount, setAmendAmount] = useState<string>("");
  const [showAmend, setShowAmend] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [showOverride, setShowOverride] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");

  const loan = res.data?.loan;
  const borrower = res.data?.borrower;

  // Preview the restructure as the amount is typed: the plan comes from the server
  // so the numbers on screen are exactly the ones that will be sent.
  const planKey = showAmend && amendAmount ? Math.round(Number(amendAmount) * 100) : 0;
  useEffect(() => {
    if (!planKey) return;
    let alive = true;
    const h = setTimeout(() => {
      api<Plan>(`/api/loans/${id}/amend?instalmentCents=${planKey}`)
        .then((p) => {
          if (!alive) return;
          setPlan(p);
          setPlanError(null);
        })
        .catch((e) => {
          if (!alive) return;
          setPlan(null);
          setPlanError(e?.api?.detail ?? String(e));
        });
    }, 150);
    return () => {
      alive = false;
      clearTimeout(h);
    };
  }, [planKey, id]);
  const planView = planKey ? plan : null;
  const planErrorView = planKey ? planError : null;

  const post = (name: string, path: string, json?: unknown) =>
    act.run(name, async () => {
      const updated = await api<Loan>(`/api/loans/${id}/${path}`, { method: "POST", json });
      res.setData((d) => (d ? { ...d, loan: updated, inFlight: true } : d));
      setTimeout(res.reload, 300);
    });

  if (res.error && !loan) return <ErrorBanner error={res.error} />;
  if (!loan || !borrower)
    return (
      <div className="flex items-center gap-2 text-sm text-ink-3">
        <Spinner /> Loading {id}
      </div>
    );

  const d = loan.disbursement;
  const m = loan.mandate;
  const elig = res.data!.eligibility;
  const bal = res.data!.balance;
  const disbursementFailed = !!d && (FAILED.includes(d.status) || FAILED.includes(d.creditStatus ?? ""));
  const canDisburse = !d || disbursementFailed;
  const disbursed = !!d && d.status === "cleared" && d.creditStatus === "cleared";
  const mandateLive = m && ["pending", "created", "active", "suspended"].includes(m.state);
  const effectiveStatus = d ? (FAILED.includes(d.creditStatus ?? "") ? d.creditStatus! : d.status === "cleared" ? (d.creditStatus ?? "clearing") : d.status) : "";
  const repaid = bal.outstandingCents <= 0;

  return (
    <>
      <PageHeader
        kicker={
          <span>
            <Link href="/loans" className="hover:underline">
              Loans
            </Link>{" "}
            / {loan.id}
          </span>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            {borrower.name} <LoanStatusPill status={loan.status} />
          </span>
        }
        actions={
          <div className="text-right">
            <div className="text-2xl font-semibold tracking-tight tnum">{aud(loan.principalCents)}</div>
            <div className="text-xs text-ink-3">
              {loan.instalments.length} × {aud(m?.instalmentCents ?? loan.instalmentCents)} · {loan.purpose}
            </div>
          </div>
        }
      />

      <ErrorBanner error={act.error} onDismiss={act.clearError} />
      <StaleBanner message={res.data?.refreshError ?? (res.error ? res.error.detail : null)} />
      {res.data?.store && !res.data.store.readable && <StaleBanner message={res.data.store.error ?? "The data store is unreadable"} />}

      <div className="grid gap-4 lg:grid-cols-5">
        <div className="space-y-4 lg:col-span-3">
          {/* ---- CoP hold ------------------------------------------------------------ */}
          {loan.copHold && (
            <Card title="Held: Confirmation of Payee did not match" subtitle="No money moves on this loan until a named person records why" className="rise">
              <p className="text-sm text-ink-2">
                The bank reported <strong>{borrower.cop?.result.replace("_", " ")}</strong> for {borrower.bsb} {borrower.accountNumber}. Brolga&rsquo;s policy is no match, no money. An override is possible but it is audited: the name and reason go on the loan&rsquo;s timeline.
              </p>
              {!showOverride ? (
                <div className="mt-4 flex gap-2">
                  <Link href="/borrowers" className="btn btn-primary">
                    Fix the account details
                  </Link>
                  <button className="btn btn-ghost" onClick={() => setShowOverride(true)}>
                    Record an override
                  </button>
                </div>
              ) : (
                <div className="rise mt-4 rounded-lg bg-surface-2 p-3">
                  <textarea className="input" rows={2} placeholder="Reason — e.g. borrower showed a bank statement in branch; name on statement matches; officer J. Ng" value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} />
                  <div className="mt-2 flex gap-2">
                    <button className="btn btn-danger btn-sm" disabled={overrideReason.trim().length < 10 || !!act.busy} onClick={() => post("override", "cop-override", { by: "loan officer", reason: overrideReason })}>
                      {act.busy === "override" ? <Spinner /> : null} Override and release the hold
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => setShowOverride(false)}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </Card>
          )}

          {/* ---- disburse ---------------------------------------------------------- */}
          {canDisburse && !loan.copHold && (
            <Card title={d ? "Disburse again" : "Disburse the loan"} subtitle="POST /payments — one payout to the borrower's account, with an idempotency key that is kept until Zepto answers" className="rise">
              {d && d.failure && (
                <div className="mb-3 rounded-lg bg-critical-soft px-3 py-2 text-sm text-critical">
                  Previous attempt {d.payoutRef} failed: {d.failure.code} {d.failure.title}. {d.reversalRef ? `Funds reversed to Brolga (${d.reversalRef}).` : "Zepto reverses the funds to Brolga once the return is processed; Brolga keeps watching for it."}
                </div>
              )}
              {loan.disbursementIntent?.outcome === "unknown" && (
                <div className="mb-3 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
                  Attempt {loan.disbursementIntent.attempt} got no answer from Zepto. Disbursing again re-sends the same request with the same idempotency key, so it cannot pay twice.
                </div>
              )}
              <p className="text-sm text-ink-2">
                {aud(loan.principalCents)} to {borrower.name}, {borrower.bsb} {borrower.accountNumber}. Zepto picks NPP when the funding account supports it and falls back to Direct Entry.
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button className="btn btn-primary" onClick={() => post("disburse", "disburse")} disabled={!!act.busy}>
                  {act.busy === "disburse" ? <Spinner /> : null} Disburse {aud(loan.principalCents)}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => post("disburse-fail", "disburse", { forceFailure: "de_account_not_found" })} disabled={!!act.busy} title="Sends the sandbox amount $1.05, which the receiving bank returns as E105 Account Not Found">
                  Simulate a returned payment
                </button>
              </div>
            </Card>
          )}

          {d && !canDisburse && !disbursed && (
            <Card title="Disbursement in flight" subtitle={`Payout ${d.payoutRef} · polling GET /payments/${d.paymentRef} and GET /transactions?parent_ref=${d.paymentRef}&both_parties=true`} className="rise">
              <ol className="flex flex-wrap items-center gap-2 text-xs">
                {PAYOUT_STEPS.map((s, i) => {
                  const idx = PAYOUT_STEPS.indexOf(effectiveStatus);
                  const done = idx > i || disbursed;
                  const now = effectiveStatus === s;
                  return (
                    <li key={s} className="flex items-center gap-2">
                      <span className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 font-semibold ${done ? "bg-good-soft text-good" : now ? "bg-info-soft text-info" : "bg-neutral-soft text-ink-3"}`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${done ? "bg-good" : now ? "bg-info pulse" : "bg-ink-3"}`} />
                        {s}
                      </span>
                      {i < PAYOUT_STEPS.length - 1 && <span className="text-ink-3">→</span>}
                    </li>
                  );
                })}
              </ol>
              {d.status === "channel_switched" && <div className="mt-3 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">The receiving account rejected the NPP payment, so Zepto re-sent it over Direct Entry automatically (channel switching is a property of the float).</div>}
              <p className="mt-3 text-xs text-ink-3">
                {d.currentChannel === "new_payments_platform" ? "NPP payments clear in seconds." : "Direct Entry runs on Zepto's sandbox cycle of about a minute per step, so expect three to four minutes; in production it is next banking day."}{" "}
                {d.status === "cleared" && !d.creditStatus ? "The debit has left Brolga's account; waiting for the borrower-side credit to appear." : ""} The PayTo agreement can be set up while this clears; collections wait until the money has landed.
              </p>
            </Card>
          )}

          {/* ---- mandate ---------------------------------------------------------- */}
          {d && !disbursementFailed && !mandateLive && !repaid && (
            <Card title="Set up repayments with PayTo" subtitle="POST /payto/agreements — the borrower authorises the mandate in their own banking app" className="rise">
              {m && (
                <div className="mb-3 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
                  The previous agreement {m.uid} is {m.state}
                  {m.stateReason ? ` (${m.stateReason.code} ${m.stateReason.title})` : ""}. {m.state === "cancelled" ? `The debt (${aud(bal.outstandingCents)}) is still owed; a new agreement restores the authority to collect it.` : "A new one can be issued; Zepto allows six attempts per debtor account per day."}
                </div>
              )}
              <p className="text-sm text-ink-2">
                Fixed terms: <Money cents={loan.instalmentCents} className="font-semibold text-ink" /> fortnightly from {shortDate(loan.instalments.find((i) => i.state !== "settled")?.dueDate ?? loan.instalments[0].dueDate)} to {shortDate(loan.instalments[loan.instalments.length - 1].dueDate)}, purpose <Mono>loan</Mono>. In production the borrower sees this in their banking app within seconds; here we tell the sandbox how they respond.
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <select className="select !w-auto" value={agreementSim} onChange={(e) => setAgreementSim(e.target.value)}>
                  <option value="debtor_accept">borrower accepts</option>
                  <option value="debtor_decline">borrower declines</option>
                  <option value="expire">borrower never responds (expires)</option>
                </select>
                <button className="btn btn-primary" onClick={() => post("mandate", "mandate", { simulate: agreementSim, delay: 4 })} disabled={!!act.busy}>
                  {act.busy === "mandate" ? <Spinner /> : null} Send PayTo agreement
                </button>
              </div>
            </Card>
          )}

          {m && (m.state === "pending" || m.state === "created") && (
            <Card title="Waiting for the borrower" subtitle={`Agreement ${m.uid} · polling GET /payto/agreements/{uid}`} className="rise">
              <div className="flex items-center gap-3 text-sm text-ink-2">
                <Spinner className="text-brand" />
                {m.state === "pending" ? "Zepto is submitting the agreement to the NPP Mandate Management Service…" : "The mandate is in the borrower's banking app awaiting authorisation…"}
              </div>
            </Card>
          )}

          {m && m.state === "suspended" && (
            <Card title="Agreement suspended" subtitle={m.stateCausedBy === "debtor" ? "Suspended by the borrower from their banking app" : "Suspended by Brolga"} className="rise">
              <p className="text-sm text-ink-2">
                {m.stateReason?.detail ?? "No collections can be initiated while the agreement is suspended."}
                {m.stateCausedBy === "debtor" && " Only the borrower can lift a suspension they initiated — Zepto will reject a reactivation from us."}
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <button className="btn btn-primary" onClick={() => post("reactivate", "reactivate")} disabled={!!act.busy}>
                  {act.busy === "reactivate" ? <Spinner /> : null} Reactivate
                </button>
                {m.stateCausedBy === "debtor" && (
                  <button className="btn btn-secondary" onClick={() => post("debtor-react", "debtor", { action: "reactivation", narrative: "Borrower lifted the pause in their banking app" })} disabled={!!act.busy}>
                    Simulate borrower reactivating
                  </button>
                )}
              </div>
            </Card>
          )}

          {/* ---- instalments -------------------------------------------------------- */}
          <Card
            title="Repayment schedule"
            subtitle={
              elig.ok ? "Each collection is a POST /payto/payments against the agreement" : elig.reason
            }
            actions={
              <div className="text-right text-xs text-ink-3">
                <div>
                  Owed <Money cents={bal.obligationCents} className="font-semibold text-ink" /> · settled <Money cents={bal.settledCents} className="font-semibold text-ink" />
                </div>
                <div>
                  Outstanding <Money cents={Math.max(0, bal.outstandingCents)} className="font-semibold text-ink" />
                </div>
              </div>
            }
            padded={false}
          >
            {!elig.ok && elig.waiting && (
              <div className="flex items-center gap-2 border-b border-line bg-info-soft px-5 py-2 text-xs text-info">
                <Spinner /> {elig.reason}
              </div>
            )}
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Due</th>
                  <th className="text-right">Amount</th>
                  <th>Status</th>
                  <th>PayTo payment</th>
                  <th className="text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {loan.instalments.map((i) => {
                  const st = INSTALMENT_STATUS[i.state];
                  const isNext = elig.instalment?.n === i.n;
                  const collectable = isNext && elig.ok && (i.state === "scheduled" || i.state === "unknown");
                  return (
                    <tr key={i.n} className={isNext ? "bg-brand-soft/30" : ""}>
                      <td className="tnum">{i.n}</td>
                      <td>{shortDate(i.dueDate)}</td>
                      <td className="text-right">
                        <Money cents={i.amountCents} />
                      </td>
                      <td>
                        <Pill tone={st.tone} pulse={st.pulse}>
                          {st.label}
                        </Pill>
                        {i.failure && (
                          <div className="mt-1 text-xs text-critical">
                            {i.failure.code} {i.failure.title}
                            {i.failure.retryable ? " · retryable" : " · not retryable"}
                          </div>
                        )}
                      </td>
                      <td>
                        {i.paymentUid ? (
                          <div>
                            <Mono>{i.paymentUid}</Mono>
                            {i.attempts > 1 && <div className="text-xs text-ink-3">{i.attempts} attempts</div>}
                          </div>
                        ) : (
                          <span className="text-xs text-ink-3">—</span>
                        )}
                      </td>
                      <td className="text-right">
                        {collectable && (
                          <div className="flex items-center justify-end gap-1.5">
                            <select className="select !w-auto !py-1 !text-xs" value={paymentSim} onChange={(e) => setPaymentSim(e.target.value)} title="Sandbox outcome">
                              <option value="auto_settle">settles</option>
                              <option value="insufficient_funds">insufficient funds</option>
                              <option value="investigate_and_settle">bank investigates, then settles</option>
                              <option value="debtor_account_closed">account closed</option>
                            </select>
                            <button className="btn btn-primary btn-sm" onClick={() => post(`collect-${i.n}`, "collect", { n: i.n, simulate: paymentSim, delay: 3 })} disabled={!!act.busy}>
                              {act.busy === `collect-${i.n}` ? <Spinner /> : null} {i.state === "unknown" ? "Check and collect" : "Collect now"}
                            </button>
                          </div>
                        )}
                        {i.state === "failed" && i.failure?.retryable && isNext && elig.ok && (
                          <div className="flex items-center justify-end gap-1.5">
                            <select className="select !w-auto !py-1 !text-xs" value={retrySim} onChange={(e) => setRetrySim(e.target.value)}>
                              <option value="auto_settle">settles</option>
                              <option value="insufficient_funds">insufficient funds again</option>
                            </select>
                            <button className="btn btn-secondary btn-sm" onClick={() => post(`retry-${i.n}`, "retry", { n: i.n, simulate: retrySim, delay: 3 })} disabled={!!act.busy}>
                              {act.busy === `retry-${i.n}` ? <Spinner /> : null} Retry
                            </button>
                          </div>
                        )}
                        {isNext && !elig.ok && !elig.waiting && (i.state === "scheduled" || i.state === "failed") && <span className="text-xs text-ink-3">{elig.reason}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!!loan.adjustments?.length && (
              <div className="border-t border-line px-5 py-3 text-xs text-ink-2">
                <span className="label mr-2">Adjustments</span>
                {loan.adjustments.map((a, i) => (
                  <span key={i} className="mr-3">
                    {a.cents >= 0 ? "+" : "−"}
                    {aud(Math.abs(a.cents))} {a.type.replace("_", " ")} · {a.note}
                  </span>
                ))}
              </div>
            )}
          </Card>

          {/* ---- timeline ------------------------------------------------------------ */}
          <Card title="Timeline" subtitle="Every state change Brolga observed, oldest first" padded={false}>
            <ol className="divide-y divide-line">
              {loan.events.map((e, i) => (
                <li key={i} className="flex gap-3 px-5 py-3 text-sm">
                  <span className="mono w-16 shrink-0 pt-0.5 text-xs text-ink-3">{clock(e.at)}</span>
                  <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${e.level === "success" ? "bg-good" : e.level === "error" ? "bg-critical" : e.level === "warning" ? "bg-warn" : "bg-info"}`} />
                  <div className="min-w-0 flex-1">
                    <div className="break-words">{e.message}</div>
                    <div className="mt-0.5 text-xs text-ink-3">
                      <span className="mono">{e.type}</span>
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
            </ol>
          </Card>
        </div>

        {/* ---- right column ---------------------------------------------------------- */}
        <div className="space-y-4 lg:col-span-2">
          <Card title="Disbursement" subtitle={d ? `Created ${dateTime(d.createdAt)}${d.attempt && d.attempt > 1 ? ` · attempt ${d.attempt}` : ""}` : "Not yet sent"}>
            {d ? (
              <Kv
                rows={[
                  ["Debit (Brolga)", <span key="s" className="flex items-center gap-2"><Mono>{d.payoutRef}</Mono><Pill tone={PAYOUT_STATUS[d.status]?.tone ?? "neutral"} pulse={PAYOUT_STATUS[d.status]?.pulse}>{d.status}</Pill></span>],
                  ["Credit (borrower)", d.creditRef ? <span key="c" className="flex items-center gap-2"><Mono>{d.creditRef}</Mono><Pill tone={PAYOUT_STATUS[d.creditStatus ?? ""]?.tone ?? "neutral"} pulse={PAYOUT_STATUS[d.creditStatus ?? ""]?.pulse}>{d.creditStatus}</Pill></span> : <span key="c" className="text-xs text-ink-3">not yet visible</span>],
                  ["Batch", <Mono key="b">{d.paymentRef}</Mono>],
                  ["Channel", d.currentChannel === "new_payments_platform" ? "NPP (real-time)" : "Direct Entry"],
                  ["Fallback", d.channels.length > 1 ? "Direct Entry if NPP fails" : "none"],
                  ["Funded from", <span key="f" className="text-xs">{d.fundingLabel}</span>],
                  ...(d.failure ? [["Failure", <span key="x" className="text-critical">{d.failure.code} {d.failure.title}</span>] as [string, React.ReactNode]] : []),
                  ...(disbursementFailed ? [["Reversal", d.reversalRef ? <Mono key="rv">{d.reversalRef}</Mono> : <span key="rv" className="text-xs text-warn">expected — still watching the ledger</span>] as [string, React.ReactNode]] : []),
                  ...(d.clearedAt ? [["Cleared", dateTime(d.clearedAt)] as [string, React.ReactNode]] : []),
                ]}
              />
            ) : (
              <p className="text-sm text-ink-3">Disbursing creates a payment batch (PB.*) with one payout. Zepto records it twice: a debit (D.*) from Brolga and a credit (C.*) to the borrower. The credit is the one that tells the truth.</p>
            )}
          </Card>

          <Card title="PayTo agreement" subtitle={m ? `Created ${dateTime(m.createdAt)}` : "Not yet created"} actions={m && <Pill tone={AGREEMENT_STATUS[m.state]?.tone ?? "neutral"} pulse={AGREEMENT_STATUS[m.state]?.pulse}>{m.state}</Pill>}>
            {m ? (
              <>
                <Kv
                  rows={[
                    ["Agreement uid", <Mono key="u">{m.uid}</Mono>],
                    ["MMS id", m.mmsAgreementId ? <Mono key="m">{m.mmsAgreementId}</Mono> : <span key="m" className="text-xs text-ink-3">assigned on activation</span>],
                    ["Terms", <span key="t"><Money cents={m.instalmentCents} /> fortnightly, {shortDate(m.firstPaymentDate)} → {shortDate(m.lastPaymentDate)}</span>],
                    ["Valid until", shortDate(m.validityEndDate)],
                    ...(m.stateReason ? [["Reason", <span key="r">{m.stateReason.code} {m.stateReason.title}</span>] as [string, React.ReactNode]] : []),
                    ...(m.stateCausedBy ? [["Last change by", m.stateCausedBy === "debtor" ? "borrower" : m.stateCausedBy === "initiator" ? "Brolga" : "Zepto"] as [string, React.ReactNode]] : []),
                    ...(m.pendingAmendment ? [["Pending amendment", <span key="pa" className="text-info">{m.pendingAmendment.plan.count} × {aud(m.pendingAmendment.plan.instalmentCents)} from {shortDate(m.pendingAmendment.plan.firstDueDate)} — awaiting borrower</span>] as [string, React.ReactNode]] : []),
                  ]}
                />
                {m.state === "active" && (
                  <div className="mt-4 space-y-2 border-t border-line pt-4">
                    <div className="label">Lifecycle actions</div>
                    <div className="flex flex-wrap gap-2">
                      <button className="btn btn-secondary btn-sm" onClick={() => post("suspend", "suspend", { narrative: "Hardship arrangement: collections paused at the borrower's request" })} disabled={!!act.busy}>
                        {act.busy === "suspend" ? <Spinner /> : null} Suspend (hardship)
                      </button>
                      <button className="btn btn-secondary btn-sm" onClick={() => setShowAmend((s) => !s)} disabled={!!act.busy || !!m.pendingAmendment || repaid}>
                        Restructure
                      </button>
                      <button
                        className="btn btn-danger btn-sm"
                        onClick={() => post("cancel", "cancel", repaid ? { reason: "contract_expired", narrative: "Loan repaid in full — mandate no longer required" } : { reason: "initiating_party_requested", narrative: `Repayment authority withdrawn with ${aud(bal.outstandingCents)} outstanding; the debt remains` })}
                        disabled={!!act.busy}
                        title={repaid ? "Cancel the mandate: the loan is repaid" : "Cancels the authority to collect, not the debt"}
                      >
                        {act.busy === "cancel" ? <Spinner /> : null} {repaid ? "Cancel (repaid)" : "Withdraw mandate"}
                      </button>
                    </div>
                    {showAmend && (
                      <div className="rise mt-2 rounded-lg bg-surface-2 p-3">
                        <div className="text-xs text-ink-2">
                          Bilateral amendment: the borrower authorises the new terms in their banking app. Money already settled or in flight is untouched; the <em>remaining</em> debt is re-cut into equal instalments at or just under the amount you enter, and the term extends to match.
                        </div>
                        <div className="mt-2 flex items-center gap-2">
                          <input className="input !w-32 tnum" placeholder={(m.instalmentCents / 100).toFixed(2)} value={amendAmount} onChange={(e) => setAmendAmount(e.target.value)} />
                          <button
                            className="btn btn-primary btn-sm"
                            disabled={!planView || !!act.busy}
                            onClick={() => {
                              post("amend", "amend", { instalmentCents: Math.round(Number(amendAmount) * 100), simulate: "debtor_accept", delay: 4 });
                              setShowAmend(false);
                              setAmendAmount("");
                            }}
                          >
                            {act.busy === "amend" ? <Spinner /> : null} Send amendment
                          </button>
                        </div>
                        {planView && (
                          <div className="mt-2 text-xs text-ink-2">
                            <span className="font-semibold text-ink">{aud(planView.remainingCents)} remaining</span> → {planView.count} × <span className="font-semibold text-ink">{aud(planView.instalmentCents)}</span>, {shortDate(planView.firstDueDate)} to {shortDate(planView.lastDueDate)}
                            {planView.roundingCents ? ` (+${planView.roundingCents}c rounding, recorded as an adjustment)` : ""}
                            {planView.committedCount ? ` · ${planView.committedCount} instalment${planView.committedCount === 1 ? "" : "s"} already settled or in flight stay as they are` : ""}
                          </div>
                        )}
                        {planErrorView && <div className="mt-2 text-xs text-critical">{planErrorView}</div>}
                      </div>
                    )}
                    <div className="label pt-2">Simulate the borrower</div>
                    <div className="flex flex-wrap gap-2">
                      <button className="btn btn-ghost btn-sm" onClick={() => post("debtor-susp", "debtor", { action: "suspension", narrative: "Borrower paused the agreement in their banking app" })} disabled={!!act.busy}>
                        Borrower pauses
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={() => post("debtor-cancel", "debtor", { action: "cancellation", narrative: "Borrower cancelled the agreement in their banking app" })} disabled={!!act.busy}>
                        Borrower cancels
                      </button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <p className="text-sm text-ink-3">A PayTo agreement replaces the direct-debit form: the borrower authorises it in their banking app, their bank validates the account, and every collection settles or fails in real time with an ISO reason code.</p>
            )}
          </Card>

          <Card title="Borrower">
            <Kv
              rows={[
                ["Name", <Link key="n" href="/borrowers" className="font-semibold text-brand hover:underline">{borrower.name}</Link>],
                ["Account", <span key="a" className="mono">{borrower.bsb} · {borrower.accountNumber}</span>],
                ["Bank", borrower.bankName ?? "—"],
                ["Zepto contact", borrower.zeptoContactRef ? <Mono key="c">{borrower.zeptoContactRef}</Mono> : <span key="c" className="text-xs text-ink-3">created on first payout</span>],
                ["Confirmation of Payee", borrower.cop ? (borrower.cop.result === "error" ? <span key="cop" className="text-xs text-warn">unavailable — {borrower.cop.error}</span> : <span key="cop">{borrower.cop.result.replace("_", " ")}{borrower.cop.riskScore !== undefined ? ` · risk ${borrower.cop.riskScore}` : ""}</span>) : "not checked"],
                ...(loan.copOverride ? [["CoP override", <span key="ov" className="text-xs text-warn">{loan.copOverride.by}, {dateTime(loan.copOverride.at)}: {loan.copOverride.reason}</span>] as [string, React.ReactNode]] : []),
              ]}
            />
          </Card>
        </div>
      </div>
    </>
  );
}
