"use client";

import { useState } from "react";
import { useResource } from "@/lib/client";
import { Card, PageHeader, Pill, Money, Mono, Spinner, ErrorBanner, Empty, PAYOUT_STATUS, INSTALMENT_STATUS } from "@/components/ui";
import type { Transaction, PaytoPayment, Webhook, WebhookDelivery } from "@/lib/zepto/types";
import { dateTime } from "@/lib/format";

type LabelledTransaction = Transaction & { side: string };

type Tab = "ledger" | "payto" | "webhooks";

export default function Operations() {
  const [tab, setTab] = useState<Tab>("ledger");
  return (
    <>
      <PageHeader kicker="Back office" title="Operations">
        The reconciliation view: what Zepto&rsquo;s ledger says, independent of what Brolga believes. Two API generations sit side by side here — legacy payouts with <Mono>D.*</Mono> refs and page numbers, PayTo with UUIDs and cursors.
      </PageHeader>
      <div className="mb-4 flex gap-1 rounded-xl bg-neutral-soft p-1 text-sm">
        {(["ledger", "payto", "webhooks"] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`rounded-lg px-3 py-1.5 font-medium transition ${tab === t ? "bg-surface shadow-sm" : "text-ink-2 hover:text-ink"}`}>
            {t === "ledger" ? "Payout ledger" : t === "payto" ? "PayTo payments" : "Webhooks"}
          </button>
        ))}
      </div>
      {tab === "ledger" && <Ledger />}
      {tab === "payto" && <Payto />}
      {tab === "webhooks" && <Webhooks />}
    </>
  );
}

function Ledger() {
  const { data, error, loading, reload } = useResource<{ transactions: LabelledTransaction[] }>("/api/ops/transactions");
  return (
    <Card title="GET /transactions?both_parties=true" subtitle="Both sides of every payout — Brolga's debit and the borrower's credit — plus reversals, newest first. Without both_parties the borrower-side return never appears." actions={<button className="btn btn-ghost btn-sm" onClick={reload}>Refresh</button>} padded={false}>
      <ErrorBanner error={error} />
      {loading ? (
        <div className="flex items-center gap-2 p-5 text-sm text-ink-3">
          <Spinner /> Loading
        </div>
      ) : !data?.transactions.length ? (
        <div className="p-5">
          <Empty>No transactions yet. Disburse a loan and they appear here within a minute.</Empty>
        </div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Ref</th>
              <th>Side</th>
              <th>Counterparty</th>
              <th className="text-right">Amount</th>
              <th>Channel</th>
              <th>Status</th>
              <th>Loan</th>
              <th className="text-right">Created</th>
            </tr>
          </thead>
          <tbody>
            {data.transactions.map((t) => (
              <tr key={t.ref}>
                <td>
                  <Mono>{t.ref}</Mono>
                  {t.parent_ref && <div className="text-[11px] text-ink-3">in {t.parent_ref}</div>}
                </td>
                <td>
                  <div>{t.side}</div>
                  <div className="text-[11px] text-ink-3">{t.category.replace("_", " ")} · {t.type}</div>
                </td>
                <td>{t.party_name ?? "—"}</td>
                <td className={`text-right ${t.type === "credit" ? "text-good" : ""}`}>
                  {t.type === "credit" ? "+" : "−"}
                  <Money cents={t.amount} />
                </td>
                <td className="text-xs">{t.current_channel === "new_payments_platform" ? "NPP" : t.current_channel === "direct_entry" ? "Direct Entry" : t.current_channel ?? "—"}</td>
                <td>
                  <Pill tone={PAYOUT_STATUS[t.status]?.tone ?? "neutral"} pulse={PAYOUT_STATUS[t.status]?.pulse}>
                    {t.status}
                  </Pill>
                  {t.failure && <div className="mt-1 text-xs text-critical">{t.failure.code} {t.failure.title}</div>}
                </td>
                <td className="text-xs">{t.metadata?.loan_id ?? "—"}</td>
                <td className="text-right text-xs text-ink-3">{dateTime(t.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function Payto() {
  const { data, error, loading, reload } = useResource<{ payments: PaytoPayment[] }>("/api/ops/payto-payments");
  return (
    <Card title="GET /payto/payments" subtitle="Every PayTo collection attempted, newest first" actions={<button className="btn btn-ghost btn-sm" onClick={reload}>Refresh</button>} padded={false}>
      <ErrorBanner error={error} />
      {loading ? (
        <div className="flex items-center gap-2 p-5 text-sm text-ink-3">
          <Spinner /> Loading
        </div>
      ) : !data?.payments.length ? (
        <div className="p-5">
          <Empty>No PayTo payments yet.</Empty>
        </div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Payment uid</th>
              <th>Agreement</th>
              <th className="text-right">Amount</th>
              <th>Statement reference</th>
              <th>State</th>
              <th className="text-right">Created</th>
            </tr>
          </thead>
          <tbody>
            {data.payments.map((p) => (
              <tr key={p.uid}>
                <td>
                  <Mono>{p.uid}</Mono>
                </td>
                <td>
                  <Mono>{p.agreement_uid}</Mono>
                </td>
                <td className="text-right">
                  <Money cents={p.amount} />
                </td>
                <td className="text-xs">{p.reference}</td>
                <td>
                  <Pill tone={INSTALMENT_STATUS[p.state]?.tone ?? "neutral"} pulse={INSTALMENT_STATUS[p.state]?.pulse}>
                    {p.state}
                  </Pill>
                  {p.failure && (
                    <div className="mt-1 text-xs text-critical">
                      {p.failure.code} {p.failure.title}
                    </div>
                  )}
                </td>
                <td className="text-right text-xs text-ink-3">{dateTime(p.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function Webhooks() {
  const { data, error, loading } = useResource<{ webhooks: Webhook[]; deliveries: WebhookDelivery[] }>("/api/ops/webhooks");
  return (
    <div className="space-y-4">
      <Card title="Webhook endpoints" subtitle="GET /webhooks — endpoints are created in the Zepto portal; the API can list, inspect and redeliver but not create">
        <ErrorBanner error={error} />
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-ink-3">
            <Spinner /> Loading
          </div>
        ) : !data?.webhooks.length ? (
          <div className="text-sm text-ink-2">
            No webhook endpoints are configured for this account. Brolga polls instead, which is the right call for a laptop demo; in production the same <Mono>refreshLoan</Mono> logic would be driven by <Mono>debtor_credit.cleared</Mono>, <Mono>payto_agreement.activated</Mono> and <Mono>payto_payment.settled</Mono> events, verified with the HMAC in the <Mono>Split-Signature</Mono> header.
          </div>
        ) : (
          <ul className="space-y-2 text-sm">
            {data.webhooks.map((w) => (
              <li key={w.id}>
                <Mono>{w.url}</Mono> <span className="text-xs text-ink-3">{w.events.length} events</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {!!data?.deliveries.length && (
        <Card title="Recent deliveries" padded={false}>
          <table className="table">
            <thead>
              <tr>
                <th>Event</th>
                <th>State</th>
                <th>Response</th>
                <th>Refs</th>
              </tr>
            </thead>
            <tbody>
              {data.deliveries.map((d) => (
                <tr key={d.id}>
                  <td>
                    <Mono>{d.event_type}</Mono>
                  </td>
                  <td>{d.state}</td>
                  <td>{d.response_status_code ?? "—"}</td>
                  <td className="text-xs">{d.payload_data_summary?.map((p) => p.ref).join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
