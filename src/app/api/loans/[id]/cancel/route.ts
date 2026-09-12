import { ok, fail, readJson } from "@/lib/api";
import { cancelMandate } from "@/lib/domain/loans";
import type { CancellationReason } from "@/lib/zepto";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await readJson<{ reason?: CancellationReason; narrative?: string }>(req);
    return ok(await cancelMandate(id, body.reason ?? "contract_expired", body.narrative || "Loan repaid in full"));
  } catch (err) {
    return fail(err);
  }
}
