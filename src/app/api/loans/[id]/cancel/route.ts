import { ok, fail, readJson } from "@/lib/api";
import { cancelMandate, outstandingCents } from "@/lib/domain/loans";
import { getLoan } from "@/lib/db";
import type { CancellationReason } from "@/lib/zepto";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await readJson<{ reason?: CancellationReason; narrative?: string }>(req);
    const loan = getLoan(id);
    if (!loan) throw new Error(`Unknown loan ${id}`);
    // Cancelling the mandate is not the same as repaying the loan; say which it is.
    const owed = outstandingCents(loan);
    const reason = body.reason ?? (owed <= 0 ? "contract_expired" : "initiating_party_requested");
    const narrative = body.narrative || (owed <= 0 ? "Loan repaid in full — mandate no longer required" : `Repayment authority withdrawn by ${"Brolga Credit"} with a balance outstanding; the debt remains`);
    return ok(await cancelMandate(id, reason, narrative));
  } catch (err) {
    return fail(err);
  }
}
