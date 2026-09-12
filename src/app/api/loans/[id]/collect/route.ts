import { ok, fail, readJson } from "@/lib/api";
import { collect } from "@/lib/domain/loans";
import type { PaytoPaymentSimulate } from "@/lib/zepto";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await readJson<{ n: number; simulate?: PaytoPaymentSimulate; delay?: number }>(req);
    return ok(await collect(id, Number(body.n), { simulate: body.simulate, delay: body.delay }));
  } catch (err) {
    return fail(err);
  }
}
