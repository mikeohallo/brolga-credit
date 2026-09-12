import { ok, fail, readJson } from "@/lib/api";
import { loadDb } from "@/lib/db";
import { createLoan } from "@/lib/domain/loans";

export const dynamic = "force-dynamic";

export async function GET() {
  const db = loadDb();
  const borrowers = Object.fromEntries(db.borrowers.map((b) => [b.id, b]));
  return ok({ loans: db.loans.map((l) => ({ ...l, borrower: borrowers[l.borrowerId] })) });
}

export async function POST(req: Request) {
  try {
    const body = await readJson<{ borrowerId: string; principalCents: number; termFortnights: number; purpose: string }>(req);
    const loan = createLoan({ borrowerId: body.borrowerId, principalCents: Math.round(Number(body.principalCents)), termFortnights: Number(body.termFortnights), purpose: body.purpose || "Personal loan" });
    return ok(loan, { status: 201 });
  } catch (err) {
    return fail(err);
  }
}
