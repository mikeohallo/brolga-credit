"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useResource } from "@/lib/client";
import { Card, PageHeader, LoanStatusPill, Money, Spinner, Empty, Pill, AGREEMENT_STATUS } from "@/components/ui";
import type { Loan, Borrower } from "@/lib/db";
import { timeAgo } from "@/lib/format";

type Resp = { loans: (Loan & { borrower?: Borrower })[] };

export default function Loans() {
  const router = useRouter();
  const { data, loading } = useResource<Resp>("/api/loans", { poll: () => 5000 });
  const rows = [...(data?.loans ?? [])].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));

  return (
    <>
      <PageHeader
        kicker="Portfolio"
        title="Loans"
        actions={
          <Link href="/loans/new" className="btn btn-primary">
            New loan
          </Link>
        }
      >
        Every loan is a disbursement, a PayTo agreement and a schedule of instalments — each one a real object in Zepto.
      </PageHeader>

      <Card padded={false}>
        {loading ? (
          <div className="flex items-center gap-2 p-5 text-sm text-ink-3">
            <Spinner /> Loading
          </div>
        ) : rows.length === 0 ? (
          <div className="p-5">
            <Empty>
              No loans yet.{" "}
              <Link href="/loans/new" className="font-semibold text-brand hover:underline">
                Write one
              </Link>
              .
            </Empty>
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Loan</th>
                <th>Borrower</th>
                <th className="text-right">Principal</th>
                <th className="text-right">Instalment</th>
                <th>Disbursement</th>
                <th>PayTo</th>
                <th className="text-right">Collected</th>
                <th>Status</th>
                <th className="text-right">Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => {
                const settled = l.instalments.filter((i) => i.state === "settled").length;
                return (
                  <tr key={l.id} className="cursor-pointer" onClick={() => router.push(`/loans/${l.id}`)}>
                    <td>
                      <Link href={`/loans/${l.id}`} className="font-semibold text-brand hover:underline">
                        {l.id}
                      </Link>
                      <div className="text-xs text-ink-3">{l.purpose}</div>
                    </td>
                    <td>{l.borrower?.name}</td>
                    <td className="text-right">
                      <Money cents={l.principalCents} />
                    </td>
                    <td className="text-right">
                      <Money cents={l.instalmentCents} />
                      <div className="text-xs text-ink-3">× {l.termFortnights}</div>
                    </td>
                    <td>{l.disbursement ? (() => { const st = ["returned", "rejected", "voided"].includes(l.disbursement.creditStatus ?? "") ? l.disbursement.creditStatus! : l.disbursement.status === "cleared" ? (l.disbursement.creditStatus ?? "clearing") : l.disbursement.status; const done = st === "cleared"; const bad = ["returned", "rejected", "voided"].includes(st); return <Pill tone={done ? "good" : bad ? "critical" : "info"} pulse={!done && !bad}>{st}</Pill>; })() : <span className="text-xs text-ink-3">—</span>}</td>
                    <td>{l.mandate ? <Pill tone={AGREEMENT_STATUS[l.mandate.state]?.tone ?? "neutral"} pulse={AGREEMENT_STATUS[l.mandate.state]?.pulse}>{l.mandate.state}</Pill> : <span className="text-xs text-ink-3">—</span>}</td>
                    <td className="text-right tnum">
                      {settled}/{l.termFortnights}
                    </td>
                    <td>
                      <LoanStatusPill status={l.status} />
                    </td>
                    <td className="text-right text-ink-3">{timeAgo(l.updatedAt)}</td>
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
