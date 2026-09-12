import { ok, fail } from "@/lib/api";
import { getZepto, withApiContext } from "@/lib/zepto";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const z = getZepto();
    const rows = await withApiContext("operations · ledger", () => z.transactions({ per_page: "50" }));
    return ok({ transactions: rows });
  } catch (err) {
    return fail(err);
  }
}
