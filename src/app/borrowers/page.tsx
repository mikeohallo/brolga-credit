"use client";

import { useState } from "react";
import Link from "next/link";
import { useResource, useAction, api } from "@/lib/client";
import { Card, PageHeader, Pill, Mono, Spinner, ErrorBanner, type Tone } from "@/components/ui";
import type { Borrower } from "@/lib/db";
import { timeAgo } from "@/lib/format";

type Resp = { borrowers: Borrower[]; loans: { id: string; borrowerId: string; status: string }[] };

const COP_TONE: Record<string, Tone> = { match: "good", close_match: "warn", no_match: "critical", account_closed: "critical", error: "neutral" };
const COP_LABEL: Record<string, string> = { match: "Name matches", close_match: "Close match", no_match: "No match", account_closed: "Account closed", error: "Not checked" };

export default function Borrowers() {
  const { data, loading, reload } = useResource<Resp>("/api/borrowers");
  const act = useAction();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", bsb: "", accountNumber: "" });
  const [sim, setSim] = useState<Record<string, string>>({});

  const verify = (b: Borrower) =>
    act.run(`verify-${b.id}`, async () => {
      await api(`/api/borrowers/${b.id}/verify`, { method: "POST", json: { simulate: sim[b.id] || "match" } });
      reload();
    });
  const register = (b: Borrower) =>
    act.run(`register-${b.id}`, async () => {
      await api(`/api/borrowers/${b.id}/register`, { method: "POST" });
      reload();
    });
  const add = () =>
    act.run("add", async () => {
      await api("/api/borrowers", { method: "POST", json: form });
      setForm({ name: "", email: "", bsb: "", accountNumber: "" });
      setShowForm(false);
      reload();
    });

  const loansFor = (id: string) => data?.loans.filter((l) => l.borrowerId === id) ?? [];

  return (
    <>
      <PageHeader
        kicker="Customers"
        title="Borrowers"
        actions={
          <button className="btn btn-primary" onClick={() => setShowForm((s) => !s)}>
            {showForm ? "Close" : "Add borrower"}
          </button>
        }
      >
        Each borrower becomes a Zepto contact the first time money moves. Confirmation of Payee runs against the BSB and account number they gave us.
      </PageHeader>

      <ErrorBanner error={act.error} onDismiss={act.clearError} />

      {showForm && (
        <Card title="New borrower" className="rise mb-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              <span className="label mb-1 block">Full name</span>
              <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Full name as it appears on the bank account" />
            </label>
            <label className="text-sm">
              <span className="label mb-1 block">Email</span>
              <input className="input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="name@example.com" />
            </label>
            <label className="text-sm">
              <span className="label mb-1 block">BSB</span>
              <input className="input mono" value={form.bsb} onChange={(e) => setForm({ ...form, bsb: e.target.value })} placeholder="062000" maxLength={7} />
            </label>
            <label className="text-sm">
              <span className="label mb-1 block">Account number</span>
              <input className="input mono" value={form.accountNumber} onChange={(e) => setForm({ ...form, accountNumber: e.target.value })} placeholder="5–9 digits" maxLength={9} />
            </label>
          </div>
          <div className="mt-4 flex items-center gap-2">
            <button className="btn btn-primary" onClick={add} disabled={act.busy === "add"}>
              {act.busy === "add" && <Spinner />} Save borrower
            </button>
            <span className="text-xs text-ink-3">Sandbox tip: unusual account numbers avoid colliding with other sandbox tenants&rsquo; test accounts.</span>
          </div>
        </Card>
      )}

      <Card padded={false}>
        {loading ? (
          <div className="flex items-center gap-2 p-5 text-sm text-ink-3">
            <Spinner /> Loading
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Borrower</th>
                <th>Bank account</th>
                <th>Zepto contact</th>
                <th>Confirmation of Payee</th>
                <th>Loans</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data?.borrowers.map((b) => {
                const cop = b.cop;
                const ls = loansFor(b.id);
                return (
                  <tr key={b.id}>
                    <td>
                      <div className="font-semibold">{b.name}</div>
                      <div className="text-xs text-ink-3">
                        {b.id} · {b.email}
                      </div>
                    </td>
                    <td>
                      <div className="mono text-[13px]">
                        {b.bsb} · {b.accountNumber}
                      </div>
                      <div className="text-xs text-ink-3">{b.bankName ?? "bank resolved on registration"}</div>
                    </td>
                    <td>
                      {b.zeptoContactId ? (
                        <div>
                          <Mono>{b.zeptoContactRef}</Mono>
                          <div className="mt-0.5 truncate text-[11px] text-ink-3" title={b.zeptoContactId}>
                            {b.zeptoContactId.slice(0, 8)}…
                          </div>
                        </div>
                      ) : (
                        <span className="text-xs text-ink-3">not yet registered</span>
                      )}
                    </td>
                    <td>
                      {cop ? (
                        <div>
                          <Pill tone={COP_TONE[cop.result]}>{COP_LABEL[cop.result]}</Pill>
                          <div className="mt-1 text-xs text-ink-3">
                            {cop.result === "error" ? cop.error : (
                              <>
                                {cop.riskScore !== undefined && <>risk {cop.riskScore} · </>}
                                {cop.suggestedChannels?.length ? `${cop.suggestedChannels.join(", ")} · ` : ""}
                                {timeAgo(cop.checkedAt)}
                                {cop.simulated && <> · simulated {cop.simulated}</>}
                              </>
                            )}
                          </div>
                        </div>
                      ) : (
                        <span className="text-xs text-ink-3">not checked</span>
                      )}
                    </td>
                    <td>
                      {ls.length === 0 ? (
                        <span className="text-xs text-ink-3">none</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {ls.map((l) => (
                            <Link key={l.id} href={`/loans/${l.id}`} className="text-xs font-semibold text-brand hover:underline">
                              {l.id}
                            </Link>
                          ))}
                        </div>
                      )}
                    </td>
                    <td>
                      <div className="flex items-center justify-end gap-1.5">
                        <select className="select !w-auto !py-1 !text-xs" value={sim[b.id] ?? "match"} onChange={(e) => setSim({ ...sim, [b.id]: e.target.value })} title="Sandbox outcome to simulate">
                          <option value="match">simulate: match</option>
                          <option value="close_match">simulate: close match</option>
                          <option value="individual_no_match">simulate: no match</option>
                          <option value="account_closed">simulate: account closed</option>
                          <option value="no_account_found">simulate: no account</option>
                        </select>
                        <button className="btn btn-secondary btn-sm" onClick={() => verify(b)} disabled={!!act.busy}>
                          {act.busy === `verify-${b.id}` && <Spinner />} Verify
                        </button>
                        {!b.zeptoContactId && (
                          <button className="btn btn-ghost btn-sm" onClick={() => register(b)} disabled={!!act.busy}>
                            {act.busy === `register-${b.id}` && <Spinner />} Register
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
