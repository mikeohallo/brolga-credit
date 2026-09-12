import { ok, fail } from "@/lib/api";
import { getBorrower } from "@/lib/db";
import { ensureContact } from "@/lib/domain/loans";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const b = getBorrower(id);
    if (!b) throw new Error(`Unknown borrower ${id}`);
    return ok(await ensureContact(b));
  } catch (err) {
    return fail(err);
  }
}
