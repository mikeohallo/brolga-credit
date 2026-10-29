import { ok, fail, readJson } from "@/lib/api";
import { caseView, InvestigatorApiError, withCase } from "@/lib/investigator/api";
import { addMark } from "@/lib/investigator/store";
import type { Mark } from "@/lib/investigator/types";

export const dynamic = "force-dynamic";

// An operator's verdict on one briefing: right, wrong or incomplete, with a note.
// The mark is stored with the run id, the hash of the case file that briefing
// read and the model, so it means one exact briefing on one exact file. Marks
// are evidence for the report, never training; nothing learns from them.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await readJson<{ runId?: string; verdict?: Mark["verdict"]; note?: string; by?: string }>(req);
    if (typeof body.runId !== "string" || !body.runId) return fail(new Error("A mark names the briefing it is about (runId)"), 400);
    if (typeof body.note === "string" && body.note.length > 2000) return fail(new Error("A note is at most 2,000 characters"), 400);
    const view = await withCase(
      id,
      (c) => {
        try {
          addMark(c, { runId: body.runId!, verdict: body.verdict as Mark["verdict"], note: typeof body.note === "string" ? body.note : undefined, by: typeof body.by === "string" ? body.by.slice(0, 80) : undefined });
        } catch (e) {
          throw new InvestigatorApiError(/no briefing/.test((e as Error).message) ? 404 : 400, (e as Error).message);
        }
        return caseView(c);
      },
      { save: true },
    );
    return ok({ case: view });
  } catch (err) {
    return fail(err, err instanceof InvestigatorApiError ? err.status : 400);
  }
}
