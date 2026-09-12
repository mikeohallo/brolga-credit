import { ok, fail } from "@/lib/api";
import { reactivateMandate } from "@/lib/domain/loans";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return ok(await reactivateMandate(id));
  } catch (err) {
    return fail(err);
  }
}
