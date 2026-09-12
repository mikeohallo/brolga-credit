import { ok, fail, readJson } from "@/lib/api";
import { debtorAction } from "@/lib/domain/loans";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await readJson<{ action: "suspension" | "reactivation" | "cancellation"; narrative?: string }>(req);
    return ok(await debtorAction(id, body.action, body.narrative || "Requested by the borrower in their banking app"));
  } catch (err) {
    return fail(err);
  }
}
