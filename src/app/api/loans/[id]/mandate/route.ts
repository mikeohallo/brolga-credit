import { ok, fail, readJson } from "@/lib/api";
import { createMandate } from "@/lib/domain/loans";
import type { AgreementSimulate } from "@/lib/zepto";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await readJson<{ simulate?: AgreementSimulate; delay?: number }>(req);
    return ok(await createMandate(id, { simulate: body.simulate, delay: body.delay }));
  } catch (err) {
    return fail(err);
  }
}
