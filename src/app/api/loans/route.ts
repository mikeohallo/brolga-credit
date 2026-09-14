import { ok, fail, readJson } from "@/lib/api";
import { loadDb } from "@/lib/db";
import { createLoan, refreshInFlight, outstandingCents } from "@/lib/domain/loans";

export const dynamic = "force-dynamic";

// The list refreshes anything still moving (throttled per loan) so the overview
// never shows a payout as "disbursing" that Zepto settled minutes ago.
export async function GET() {
  try {
    await refreshInFlight();
  } catch {
    /* individual failures are recorded on the loan; the list still renders */
  }
  const db = loadDb();
  const borrowers = Object.fromEntries(db.borrowers.map((b) => [b.id, b]));
  return ok({ loans: db.loans.map((l) => ({ ...l, borrower: borrowers[l.borrowerId], outstandingCents: outstandingCents(l) })) });
}

export async function POST(req: Request) {
  try {
    const body = await readJson<{ borrowerId?: unknown; principalCents?: unknown; termFortnights?: unknown; purpose?: unknown }>(req);
    const principalCents = Number(body.principalCents);
    const termFortnights = Number(body.termFortnights);
    if (typeof body.borrowerId !== "string" || !body.borrowerId) throw new Error("borrowerId is required");
    if (!Number.isFinite(principalCents) || !Number.isInteger(principalCents)) throw new Error("principalCents must be a whole number of cents");
    if (!Number.isFinite(termFortnights) || !Number.isInteger(termFortnights)) throw new Error("termFortnights must be a whole number");
    const loan = createLoan({ borrowerId: body.borrowerId, principalCents, termFortnights, purpose: typeof body.purpose === "string" ? body.purpose : "Personal loan" });
    return ok(loan, { status: 201 });
  } catch (err) {
    return fail(err);
  }
}
