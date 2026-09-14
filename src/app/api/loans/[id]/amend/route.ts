import { ok, fail, readJson } from "@/lib/api";
import { amendMandate, planRestructure } from "@/lib/domain/loans";
import { getLoan } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET previews the restructure Brolga would apply for a requested instalment;
// POST sends the amendment to Zepto for the borrower to authorise.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const loan = getLoan(id);
    if (!loan) throw new Error(`Unknown loan ${id}`);
    const cents = Number(new URL(req.url).searchParams.get("instalmentCents"));
    return ok(planRestructure(loan, cents));
  } catch (err) {
    return fail(err);
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await readJson<{ instalmentCents: unknown; simulate?: "debtor_accept" | "debtor_decline" | "expire"; delay?: number }>(req);
    const cents = Number(body.instalmentCents);
    if (!Number.isInteger(cents)) throw new Error("instalmentCents must be a whole number of cents");
    return ok(await amendMandate(id, cents, { simulate: body.simulate, delay: body.delay }));
  } catch (err) {
    return fail(err);
  }
}
