import { ok, fail } from "@/lib/api";
import { getBorrower, getLoan, storeStatus } from "@/lib/db";
import { refreshLoan, hasInFlight, nextCollectable, collectionEligibility, outstandingCents, obligationCents, settledCents } from "@/lib/domain/loans";

export const dynamic = "force-dynamic";

// GET /api/loans/LN-0001?refresh=1 — refresh polls Zepto for anything that can still
// change: in-flight payouts and collections, and any agreement that is not in a
// final state (a borrower can pause or cancel an active agreement at any time).
// A refresh failure is reported alongside the last known state, never hidden.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const refresh = new URL(req.url).searchParams.get("refresh") === "1";
    let loan = getLoan(id);
    if (!loan) return fail(new Error(`Unknown loan ${id}`), 404);
    let refreshError: string | null = null;
    if (refresh) {
      try {
        loan = await refreshLoan(id);
      } catch (err) {
        refreshError = (err as Error).message;
      }
    }
    const borrower = getBorrower(loan.borrowerId);
    const eligibility = collectionEligibility(loan);
    return ok({
      loan,
      borrower,
      inFlight: hasInFlight(loan),
      next: nextCollectable(loan),
      eligibility,
      balance: { obligationCents: obligationCents(loan), settledCents: settledCents(loan), outstandingCents: outstandingCents(loan) },
      refreshError,
      store: storeStatus(),
    });
  } catch (err) {
    return fail(err);
  }
}
