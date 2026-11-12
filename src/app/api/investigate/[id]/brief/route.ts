import { ok, fail, readJson } from "@/lib/api";
import { inStore } from "@/lib/files";
import { caseView, InvestigatorApiError, withCase } from "@/lib/investigator/api";
import { MODELS, NO_KEY_MESSAGE, readKey } from "@/lib/investigator/model";
import { produceBriefing } from "@/lib/investigator/run";

export const dynamic = "force-dynamic";

// Write a briefing: one model call, server-side, with the key the scripts use
// (the environment, the file BROLGA_ENV_FILE names, or .env.local). Without a key
// it refuses and says so. The run is checked and recorded whatever the outcome;
// a rejected briefing is kept as a rejection. Nothing here changes a loan, and
// held-back cases are refused: they are run only by the eval script, on Mike's
// line, for the final comparison (decisions D16).
//
// The model call happens between two short visits to the store, not inside one:
// first the case is read as it stands (a copy), then the model takes its tens of
// seconds, then the run is appended to the case as it is by then and saved. A
// mark or a record added meanwhile survives (the fourth review, 6 Nov 2026, F1).
// The run carries the hash of the file it actually read.
// In the hosted build each visit is its own short scope under the store lock (inStore);
// on a machine inStore does nothing and the files are the state.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await readJson<{ model?: string }>(req);
    const model = typeof body.model === "string" ? body.model : MODELS.at(-1)!.id;
    if (!MODELS.some((m) => m.id === model)) return fail(new Error(`Unknown model ${model}; the tab offers ${MODELS.map((m) => m.id).join(", ")}`), 400);
    const apiKey = readKey();
    if (!apiKey) return fail(new Error(NO_KEY_MESSAGE), 400);
    const snapshot = await inStore(() =>
      withCase(id, (c) => {
        if (c.heldBack) throw new InvestigatorApiError(403, `${c.id} is held back from development; it is run only in the final comparison, by the eval script.`);
        return structuredClone(c);
      }),
    );
    const run = await produceBriefing(snapshot, { model, apiKey });
    const view = await inStore(() =>
      withCase(
        id,
        (c) => {
          c.runs.push(run);
          return caseView(c);
        },
        { save: true },
      ),
    );
    return ok({ case: view });
  } catch (err) {
    return fail(err, err instanceof InvestigatorApiError ? err.status : 400);
  }
}
