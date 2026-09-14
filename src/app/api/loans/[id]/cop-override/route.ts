import { ok, fail, readJson } from "@/lib/api";
import { recordCopOverride } from "@/lib/domain/loans";

export const dynamic = "force-dynamic";

// A Confirmation of Payee hold can only be lifted with a named person and a reason,
// and both are written to the loan's timeline.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await readJson<{ by?: string; reason?: string }>(req);
    return ok(await recordCopOverride(id, body.by ?? "", body.reason ?? ""));
  } catch (err) {
    return fail(err);
  }
}
