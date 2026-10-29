import { ok, fail } from "@/lib/api";
import { caseView, InvestigatorApiError, withCase } from "@/lib/investigator/api";
import { addEvidence } from "@/lib/investigator/store";

export const dynamic = "force-dynamic";

// "New evidence arrived": append the case's next prepared record. Its id continues
// the numbering for its source, so every id an earlier briefing cited still
// points at the same record; the file's hash changes, and the next briefing is
// stamped with the new one.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const view = await withCase(
      id,
      (c) => {
        if ((c.preparedEvidence?.length ?? 0) <= c.evidence.length) throw new InvestigatorApiError(409, `${c.id} has no more prepared evidence`);
        addEvidence(c);
        return caseView(c);
      },
      { save: true },
    );
    return ok({ case: view });
  } catch (err) {
    return fail(err, err instanceof InvestigatorApiError ? err.status : 400);
  }
}
