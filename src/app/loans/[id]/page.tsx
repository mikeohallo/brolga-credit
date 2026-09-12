"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useResource, useAction, api } from "@/lib/client";
import { Card, PageHeader, Pill, Money, Mono, Spinner, ErrorBanner, Kv, LoanStatusPill, PAYOUT_STATUS, AGREEMENT_STATUS, INSTALMENT_STATUS } from "@/components/ui";
import type { Loan, Borrower, Instalment } from "@/lib/db";
import { aud, shortDate, dateTime, clock } from "@/lib/format";

type Resp = { loan: Loan; borrower: Borrower; inFlight: boolean; next: { instalment: Instalment | null; reason?: string } };

const PAYOUT_STEPS = ["matured", "preprocessing", "processing", "clearing", "cleared"];

export default function LoanDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const res = useResource<Resp>(`/api/loans/${id}?refresh=1`, { poll: (d) => (d?.inFlight ? 2500 : 8000) });
  const act = useAction();
  const [agreementSim, setAgreementSim] = useState("debtor_accept");
  const [paymentSim, setPaymentSim] = useState("auto_settle");
  const [retrySim, setRetrySim] = useState("auto_settle");
  const [amendAmount, setAmendAmount] = useState<string>("");
  const [showAmend, setShowAmend] = useState(false);

  const loan = res.data?.loan;
  const borrower = res.data?.borrower;

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
  const next = res.data!.next;
  const failedStates = ["returned", "rejected", "voided"];
  const disbursementFailed = !!d && (failedStates.includes(d.status) || failedStates.includes(d.creditStatus ?? ""));
  const canDisburse = !d || disbursementFailed;
  const disbursed = !!d && d.status === "cleared" && d.creditStatus === "cleared";
  const mandateLive = m && ["pending", "created", "active", "suspended"].includes(m.state);
  const effectiveStatus = d ? (failedStates.includes(d.creditStatus ?? "") ? d.creditStatus! : d.status === "cleared" ? (d.creditStatus ?? "clearing") : d.status) : "";
  const settledCents = loan.instalments.filter((i) => i.state === "settled").reduce((s, i) => s + i.amountCents, 0);
  const outstanding = loan.principalCents + loan.feeCents - settledCents;

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
              {loan.termFortnights} × {aud(loan.instalmentCents)} · {loan.purpose}
            </div>
          </div>
        }
      />

      <ErrorBanner error={act.error} onDismiss={act.clearError} />

      <div className="grid gap-4 lg:grid-cols-5">
        <div className="space-y-4 lg:col-span-3">
          {/* ---- contextual next step ------------------------------------------------ */}
          {canDisburse && (
            <Card title={d ? "Disburse again" : "Disburse the loan"} subtitle="POST /payments — one payout to the borrower's verified account" className="rise">
              {d && d.failure && (
                <div className="mb-3 rounded-lg bg-critical-soft px-3 py-2 text-sm text-critical">
                  Previous attempt {d.payoutRef} failed: {d.failure.code} {d.failure.title}. {d.reversalRef ? `Funds reversed to Brolga (${d.reversalRef}).` : "Zepto reverses the funds to Brolga once the return is processed."}
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
                {d.currentChannel === "new_payments_platform" ? "NPP payments clear in seconds." : "Direct Entry runs on Zepto's sandbox cycle of about a minute per step, so expect two to three minutes; in production it is next banking day."}{" "}
                {d.status === "cleared" && !d.creditStatus ? "The debit has left Brolga's account; waiting for the borrower-side credit to appear." : ""} Brolga polls rather than listening for webhooks so the demo needs no public URL. The PayTo agreement can be sent while this clears.
              </p>
            </Card>
          )}

          {d && !disbursementFailed && !mandateLive && (
            <Card title="Set up repayments with PayTo" subtitle="POST /payto/agreements — the borrower authorises the mandate in their own banking app" className="rise">
              {m && (
                <div className="mb-3 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
                  The previous agreement {m.uid} is {m.state}
                  {m.stateReason ? ` (${m.stateReason.code} ${m.stateReason.title})` : ""}. A new one can be issued; Zepto allows six attempts per debtor account per day.
                </div>
              )}
              <p className="text-sm text-ink-2">
                Fixed terms: <Money cents={loan.instalmentCents} className="font-semibold text-ink" /> fortnightly from {shortDate(loan.instalments[0].dueDate)} to {shortDate(loan.instalments[loan.instalments.length - 1].dueDate)}, purpose <Mono>loan</Mono>. In production the borrower sees this in their banking app within seconds; here we tell the sandbox how they respond.
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
            subtitle={m?.state === "active" ? "Each collection is a POST /payto/payments against the agreement" : "Collections open once the PayTo agreement is active"}
            actions={
              <div className="text-right text-xs text-ink-3">
                Outstanding <Money cents={Math.max(0, outstanding)} className="font-semibold text-ink" />
              </div>
            }
            padded={false}
          >
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
                  const isNext = next.instalment?.n === i.n;
                  const collectable = isNext && !next.reason && m?.state === "active";
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
                        {collectable && i.state !== "failed" && (
                          <div className="flex items-center justify-end gap-1.5">
                            <select className="select !w-auto !py-1 !text-xs" value={paymentSim} onChange={(e) => setPaymentSim(e.target.value)} title="Sandbox outcome">
                              <option value="auto_settle">settles</option>
                              <option value="insufficient_funds">insufficient funds</option>
                              <option value="investigate_and_settle">bank investigates, then settles</option>
                              <option value="debtor_account_closed">account closed</option>
                            </select>
                            <button className="btn btn-primary btn-sm" onClick={() => post(`collect-${i.n}`, "collect", { n: i.n, simulate: paymentSim, delay: 3 })} disabled={!!act.busy}>
                              {act.busy === `collect-${i.n}` ? <Spinner /> : null} Collect now
                            </button>
                          </div>
                        )}
                        {i.state === "failed" && i.failure?.retryable && m?.state === "active" && (
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
                        {isNext && next.reason && i.state === "scheduled" && <span className="text-xs text-ink-3">{next.reason}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
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
          <Card title="Disbursement" subtitle={d ? `Created ${dateTime(d.createdAt)}` : "Not yet sent"}>
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
                  ...(d.reversalRef ? [["Reversal", <Mono key="rv">{d.reversalRef}</Mono>] as [string, React.ReactNode]] : []),
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
                    ...(m.pendingAmendment ? [["Pending amendment", <span key="pa" className="text-info">instalment → {aud((m.pendingAmendment.changes as { payment_terms?: { amount?: number } }).payment_terms?.amount ?? 0)} — awaiting borrower</span>] as [string, React.ReactNode]] : []),
                  ]}
                />
                {m.state === "active" && (
                  <div className="mt-4 space-y-2 border-t border-line pt-4">
                    <div className="label">Lifecycle actions</div>
                    <div className="flex flex-wrap gap-2">
                      <button className="btn btn-secondary btn-sm" onClick={() => post("suspend", "suspend", { narrative: "Hardship arrangement: collections paused at the borrower's request" })} disabled={!!act.busy}>
                        {act.busy === "suspend" ? <Spinner /> : null} Suspend (hardship)
                      </button>
                      <button className="btn btn-secondary btn-sm" onClick={() => setShowAmend((s) => !s)} disabled={!!act.busy || !!m.pendingAmendment}>
                        Restructure
                      </button>
                      <button className="btn btn-danger btn-sm" onClick={() => post("cancel", "cancel", { reason: "contract_expired", narrative: "Loan repaid in full — mandate no longer required" })} disabled={!!act.busy}>
                        {act.busy === "cancel" ? <Spinner /> : null} Cancel
                      </button>
                    </div>
                    {showAmend && (
                      <div className="rise mt-2 rounded-lg bg-surface-2 p-3">
                        <div className="text-xs text-ink-2">Bilateral amendment: the borrower must authorise a new instalment amount in their banking app. Remaining instalments are re-priced when it lands.</div>
                        <div className="mt-2 flex items-center gap-2">
                          <input className="input !w-32 tnum" placeholder={(m.instalmentCents / 100).toFixed(2)} value={amendAmount} onChange={(e) => setAmendAmount(e.target.value)} />
                          <button
                            className="btn btn-primary btn-sm"
                            disabled={!amendAmount || !!act.busy}
                            onClick={() => {
                              post("amend", "amend", { instalmentCents: Math.round(Number(amendAmount) * 100), simulate: "debtor_accept", delay: 4 });
                              setShowAmend(false);
                              setAmendAmount("");
                            }}
                          >
                            {act.busy === "amend" ? <Spinner /> : null} Send amendment
                          </button>
                        </div>
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
              ]}
            />
          </Card>
        </div>
      </div>
    </>
  );
}
