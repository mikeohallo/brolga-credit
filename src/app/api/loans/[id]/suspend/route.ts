import { ok, fail, readJson } from "@/lib/api";
import { suspendMandate } from "@/lib/domain/loans";
import type { SuspensionReason } from "@/lib/zepto";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await readJson<{ narrative?: string; reason?: SuspensionReason }>(req);
    return ok(await suspendMandate(id, body.narrative || "Hardship arrangement agreed with borrower", body.reason));
  } catch (err) {
    return fail(err);
  }
}
