import { ok, fail, readJson } from "@/lib/api";
import { amendMandate } from "@/lib/domain/loans";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await readJson<{ instalmentCents: number; simulate?: "debtor_accept" | "debtor_decline" | "expire"; delay?: number }>(req);
    return ok(await amendMandate(id, Math.round(Number(body.instalmentCents)), { simulate: body.simulate, delay: body.delay }));
  } catch (err) {
    return fail(err);
  }
}
