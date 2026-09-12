"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useResource, useAction, api } from "@/lib/client";
import { Card, PageHeader, Pill, Money, Spinner, ErrorBanner, Kv, type Tone } from "@/components/ui";
import type { Borrower, Loan } from "@/lib/db";
import { aud, shortDate, addDays, sydneyDate } from "@/lib/format";

type Resp = { borrowers: Borrower[] };
type Quote = { principalCents: number; feeCents: number; instalmentCents: number; totalCents: number; termFortnights: number };

const PURPOSES = ["Car repairs", "Medical bill", "Moving costs", "Vet bill", "School fees", "Consolidation", "Personal"];
const COP_TONE: Record<string, Tone> = { match: "good", close_match: "warn", no_match: "critical", account_closed: "critical", error: "neutral" };

export default function NewLoan() {
  const router = useRouter();
  const { data } = useResource<Resp>("/api/borrowers");
  const act = useAction();
  const [step, setStep] = useState(1);
  const [borrowerId, setBorrowerId] = useState<string>("");
  const [principal, setPrincipal] = useState(2500);
  const [term, setTerm] = useState(6);
  const [purpose, setPurpose] = useState(PURPOSES[0]);
  const [simulate, setSimulate] = useState("match");
  const [verified, setVerified] = useState<Record<string, Borrower>>({});
  const [quote, setQuote] = useState<Quote | null>(null);
  const borrower: Borrower | null = verified[borrowerId] ?? data?.borrowers.find((x) => x.id === borrowerId) ?? null;

  useEffect(() => {
    const p = Math.round(principal * 100);
    if (!p || !term) return;
    const h = setTimeout(() => api<Quote>(`/api/quote?principal=${p}&term=${term}`).then(setQuote).catch(() => {}), 120);
    return () => clearTimeout(h);
  }, [principal, term]);

  const today = useMemo(() => sydneyDate(), []);
  const schedule = useMemo(() => (quote ? Array.from({ length: quote.termFortnights }, (_, i) => ({ n: i + 1, date: addDays(today, 14 * i), amount: quote.instalmentCents })) : []), [quote, today]);

  const verify = () =>
    act.run("verify", async () => {
      const b = await api<Borrower>(`/api/borrowers/${borrowerId}/verify`, { method: "POST", json: { simulate } });
      setVerified((v) => ({ ...v, [b.id]: b }));
    });

  const create = () =>
    act.run("create", async () => {
      const loan = await api<Loan>("/api/loans", { method: "POST", json: { borrowerId, principalCents: Math.round(principal * 100), termFortnights: term, purpose } });
      router.push(`/loans/${loan.id}`);
    });

  const copBlocks = borrower?.cop && (borrower.cop.result === "no_match" || borrower.cop.result === "account_closed");
  const copOk = borrower?.cop && (borrower.cop.result === "match" || borrower.cop.result === "close_match");

  return (
    <>
      <PageHeader kicker="Loan desk" title="New loan">
        Three steps, then the money moves: choose the borrower, set the terms, confirm the account name with the borrower&rsquo;s bank.
      </PageHeader>

      <ErrorBanner error={act.error} onDismiss={act.clearError} />

      <div className="mb-5 flex items-center gap-2 text-sm">
        {["Borrower", "Terms", "Verify account"].map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            <button onClick={() => i + 1 < step && setStep(i + 1)} className={`flex items-center gap-2 rounded-full px-3 py-1 ${step === i + 1 ? "bg-brand text-white" : step > i + 1 ? "bg-brand-soft text-brand-ink" : "bg-neutral-soft text-ink-3"}`}>
              <span className="text-xs font-bold">{i + 1}</span> {s}
            </button>
            {i < 2 && <span className="text-ink-3">›</span>}
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <div className="lg:col-span-3">
          {step === 1 && (
            <Card title="Who is borrowing?" subtitle="Pick an existing borrower or add one first">
              <div className="grid gap-2 sm:grid-cols-2">
                {data?.borrowers.map((b) => (
                  <button key={b.id} onClick={() => setBorrowerId(b.id)} className={`rounded-xl border px-4 py-3 text-left transition ${borrowerId === b.id ? "border-brand bg-brand-soft" : "border-line hover:border-line-strong hover:bg-surface-2"}`}>
                    <div className="font-semibold">{b.name}</div>
                    <div className="mono text-xs text-ink-3">
                      {b.bsb} · {b.accountNumber}
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-xs text-ink-3">
                      {b.cop ? <Pill tone={COP_TONE[b.cop.result]}>{b.cop.result.replace("_", " ")}</Pill> : <span>not verified</span>}
                      {b.zeptoContactId && <span>· Zepto contact</span>}
                    </div>
                  </button>
                ))}
              </div>
              <div className="mt-4 flex items-center justify-between">
                <Link href="/borrowers" className="text-sm font-semibold text-brand hover:underline">
                  Add a borrower →
                </Link>
                <button className="btn btn-primary" disabled={!borrowerId} onClick={() => setStep(2)}>
                  Continue
                </button>
              </div>
            </Card>
          )}

          {step === 2 && (
            <Card title="Terms" subtitle="Flat 4% establishment fee, equal fortnightly instalments — simple enough to check by eye">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="text-sm">
                  <span className="label mb-1 block">Amount (AUD)</span>
                  <input type="number" className="input tnum" min={100} max={50000} step={50} value={principal} onChange={(e) => setPrincipal(Number(e.target.value))} />
                  <input type="range" className="mt-2 w-full accent-brand" min={100} max={10000} step={50} value={Math.min(principal, 10000)} onChange={(e) => setPrincipal(Number(e.target.value))} />
                </label>
                <label className="text-sm">
                  <span className="label mb-1 block">Term (fortnights)</span>
                  <input type="number" className="input tnum" min={1} max={26} value={term} onChange={(e) => setTerm(Number(e.target.value))} />
                  <input type="range" className="mt-2 w-full accent-brand" min={1} max={26} value={term} onChange={(e) => setTerm(Number(e.target.value))} />
                </label>
                <label className="text-sm sm:col-span-2">
                  <span className="label mb-1 block">Purpose</span>
                  <select className="select" value={purpose} onChange={(e) => setPurpose(e.target.value)}>
                    {PURPOSES.map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="mt-4 flex items-center justify-between">
                <button className="btn btn-ghost" onClick={() => setStep(1)}>
                  Back
                </button>
                <button className="btn btn-primary" disabled={!quote} onClick={() => setStep(3)}>
                  Continue
                </button>
              </div>
            </Card>
          )}

          {step === 3 && borrower && (
            <Card title="Confirm the account name" subtitle="Zepto Validate (Confirmation of Payee) asks the borrower's bank whether the name on the account matches">
              <Kv
                rows={[
                  ["Borrower", borrower.name],
                  ["Account", <span key="a" className="mono">{borrower.bsb} · {borrower.accountNumber}</span>],
                  ["Sandbox outcome", <select key="s" className="select !w-auto !py-1 !text-xs" value={simulate} onChange={(e) => setSimulate(e.target.value)}>
                    <option value="match">match</option>
                    <option value="close_match">close match</option>
                    <option value="individual_no_match">no match</option>
                    <option value="account_closed">account closed</option>
                    <option value="no_account_found">no account found</option>
                  </select>],
                ]}
              />
              <div className="mt-4">
                <button className="btn btn-secondary" onClick={verify} disabled={act.busy === "verify"}>
                  {act.busy === "verify" ? <Spinner /> : null} Run Confirmation of Payee
                </button>
              </div>
              {borrower.cop && (
                <div className={`rise mt-4 rounded-xl border px-4 py-3 text-sm ${copOk ? "border-good/30 bg-good-soft" : copBlocks ? "border-critical/30 bg-critical-soft" : "border-line bg-surface-2"}`}>
                  <div className="flex items-center gap-2">
                    <Pill tone={COP_TONE[borrower.cop.result]}>{borrower.cop.result.replace("_", " ")}</Pill>
                    {borrower.cop.matchName && <span className="text-ink-2">bank holds &ldquo;{borrower.cop.matchName}&rdquo;</span>}
                  </div>
                  <div className="mt-1 text-xs text-ink-2">
                    {borrower.cop.result === "error" ? (
                      <>
                        {borrower.cop.error}. The loan can still proceed; the check is recorded as unavailable rather than passed.
                      </>
                    ) : (
                      <>
                        {borrower.cop.riskScore !== undefined && <>Risk score {borrower.cop.riskScore}/100. </>}
                        {borrower.cop.suggestedChannels?.length ? <>Suggested channels: {borrower.cop.suggestedChannels.join(", ")}. </> : null}
                        {copBlocks && <>Brolga does not lend into an account whose name does not match — fix the details or stop here.</>}
                        {borrower.cop.result === "close_match" && <>A close match is allowed with a note on file; production policy would route this to a reviewer.</>}
                      </>
                    )}
                  </div>
                </div>
              )}
              <div className="mt-4 flex items-center justify-between">
                <button className="btn btn-ghost" onClick={() => setStep(2)}>
                  Back
                </button>
                <button className="btn btn-primary" onClick={create} disabled={!borrower.cop || !!copBlocks || act.busy === "create"}>
                  {act.busy === "create" ? <Spinner /> : null} Create loan
                </button>
              </div>
            </Card>
          )}
        </div>

        <div className="lg:col-span-2">
          <Card title="Quote" subtitle={borrower ? `for ${borrower.name}` : "pick a borrower to begin"}>
            {quote ? (
              <>
                <div className="text-3xl font-semibold tracking-tight tnum">{aud(quote.principalCents)}</div>
                <div className="mt-1 text-sm text-ink-2">
                  {quote.termFortnights} fortnightly instalments of <Money cents={quote.instalmentCents} className="font-semibold text-ink" />
                </div>
                <div className="mt-4">
                  <Kv
                    rows={[
                      ["Establishment fee", <Money key="f" cents={quote.feeCents} />],
                      ["Total repayable", <Money key="t" cents={quote.totalCents} />],
                      ["First instalment", shortDate(today)],
                      ["Last instalment", shortDate(addDays(today, 14 * (quote.termFortnights - 1)))],
                      ["Purpose", purpose],
                    ]}
                  />
                </div>
                <div className="mt-4 max-h-56 overflow-auto rounded-lg border border-line">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Due</th>
                        <th className="text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {schedule.map((s) => (
                        <tr key={s.n}>
                          <td className="tnum">{s.n}</td>
                          <td>{shortDate(s.date)}</td>
                          <td className="text-right">
                            <Money cents={s.amount} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-3 text-xs text-ink-3">The first instalment falls due today so a collection can be demonstrated immediately; the PayTo agreement permits one payment per fortnight thereafter.</p>
              </>
            ) : (
              <div className="text-sm text-ink-3">Set the amount and term to see the schedule.</div>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
