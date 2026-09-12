import { ok, fail, readJson } from "@/lib/api";
import { verifyBorrower } from "@/lib/domain/loans";
import type { CopSimulate } from "@/lib/zepto";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await readJson<{ simulate?: CopSimulate }>(req);
    return ok(await verifyBorrower(id, body.simulate));
  } catch (err) {
    return fail(err);
  }
}
