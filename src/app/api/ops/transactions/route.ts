import { ok, fail } from "@/lib/api";
import { getZepto, withApiContext } from "@/lib/zepto";

export const dynamic = "force-dynamic";

// Both sides of every payout: Brolga's debit and the borrower's credit. Without
// both_parties=true a returned credit — the failure — never appears in this list.
export async function GET() {
  try {
    const z = getZepto();
    const rows = await withApiContext("operations · ledger", () => z.transactions({ per_page: "50", both_parties: "true" }));
    const labelled = rows.map((t) => ({
      ...t,
      side:
        t.category === "payout_reversal"
          ? "Reversal to Brolga"
          : t.category === "payout" && t.type === "debit"
            ? "Brolga's debit"
            : t.category === "payout" && t.type === "credit"
              ? "Borrower's credit"
              : `${t.category} (${t.type})`,
    }));
    return ok({ transactions: labelled });
  } catch (err) {
    return fail(err);
  }
}
