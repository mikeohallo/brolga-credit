import { ok, fail } from "@/lib/api";
import { caseView, InvestigatorApiError, withCase } from "@/lib/investigator/api";

export const dynamic = "force-dynamic";

// One case: its records with their ids, the exact file the next briefing would
// read (and its hash), every briefing so far and every mark. Read-only.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return ok({ case: await withCase(id, (c) => caseView(c)) });
  } catch (err) {
    return fail(err, err instanceof InvestigatorApiError ? err.status : 400);
  }
}
