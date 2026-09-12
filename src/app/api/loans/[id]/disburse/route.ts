import { ok, fail, readJson } from "@/lib/api";
import { disburse } from "@/lib/domain/loans";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await readJson<{ forceFailure?: "de_account_not_found" | "npp_not_enabled" }>(req);
    return ok(await disburse(id, { forceFailure: body.forceFailure }));
  } catch (err) {
    return fail(err);
  }
}
