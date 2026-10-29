// What the Investigate tab is shown. The routes under /api/investigate read and
// write the investigator's own file and nothing else: no loan, payment or state
// is touched by anything here, and the model is called only from the brief route,
// server-side, with the key the scripts use. These shapes are what the browser
// receives; the types are imported by the page as types only, so no server code
// (file system, key) ever reaches the client bundle.

import type { CaseRecord } from "./case-file";
import { EXCEPTION_TYPES } from "./labels";
import { MODELS, PRICES_USD_PER_MTOK, readKey } from "./model";
import { caseRecords, expectedNow, loadStore, renderCase, saveStore, storePath } from "./store";
import type { BriefingRun, Expected, InvestigatorCase, InvestigatorStore, Mark } from "./types";

export type CaseSummary = {
  id: string;
  type: InvestigatorCase["type"];
  typeCode: string;
  typeTitle: string;
  title: string;
  loanId: string;
  heldBack: boolean;
  records: number;
  evidence: number;
  evidenceLeft: number; // prepared records "new evidence arrived" can still add
  briefings: number;
  accepted: number;
  lastRun: { at: string; model: string; accepted: boolean; diagnosis: string | null; nextStep: string | null } | null;
  marks: number;
  lastMark: Mark["verdict"] | null;
};

export type CaseView = {
  id: string;
  type: InvestigatorCase["type"];
  typeCode: string;
  typeTitle: string;
  title: string;
  loanId: string;
  question: string;
  heldBack: boolean;
  createdAt: string;
  records: (CaseRecord & { evidence?: { addedAt: string; label: string } })[]; // captured first, then appended evidence, in id order per source
  evidenceLeft: number;
  rendered: { text: string; hash: string; wordCount: number }; // the exact file the next briefing would read
  expected: Expected | null; // the label on the case as made (shown by the tab only after a mark)
  expectedNow: Expected | null; // the label that applies with the evidence added so far
  runs: BriefingRun[]; // oldest first; each carries the hash of the file it saw
  marks: Mark[];
};

export type ListResponse = {
  cases: CaseSummary[];
  models: { id: string; label: string; inputUsdPerMtok: number | null; outputUsdPerMtok: number | null }[];
  keyPresent: boolean; // whether Write briefing can work; never the key itself
  generator: string;
  generatedAt: string;
};

export const NO_CASES_MESSAGE = "No cases yet. Make them first: node --disable-warning=ExperimentalWarning scripts/investigate-cases.mjs";

export function caseSummary(c: InvestigatorCase): CaseSummary {
  const t = EXCEPTION_TYPES[c.type];
  const last = c.runs.at(-1) ?? null;
  return {
    id: c.id,
    type: c.type,
    typeCode: t.code,
    typeTitle: t.title,
    title: c.title,
    loanId: c.loanId,
    heldBack: !!c.heldBack,
    records: c.records.length,
    evidence: c.evidence.length,
    evidenceLeft: Math.max(0, (c.preparedEvidence?.length ?? 0) - c.evidence.length),
    briefings: c.runs.length,
    accepted: c.runs.filter((r) => r.check.accepted).length,
    lastRun: last ? { at: last.at, model: last.model, accepted: last.check.accepted, diagnosis: last.briefing?.diagnosis ?? null, nextStep: last.briefing?.next_step.action ?? null } : null,
    marks: c.marks.length,
    lastMark: c.marks.at(-1)?.verdict ?? null,
  };
}

export function caseView(c: InvestigatorCase): CaseView {
  const t = EXCEPTION_TYPES[c.type];
  const evidenceById = new Map(c.evidence.map((e) => [e.id, { addedAt: e.addedAt, label: e.label }]));
  const rendered = renderCase(c);
  return {
    id: c.id,
    type: c.type,
    typeCode: t.code,
    typeTitle: t.title,
    title: c.title,
    loanId: c.loanId,
    question: c.question,
    heldBack: !!c.heldBack,
    createdAt: c.createdAt,
    records: caseRecords(c).map((r) => (evidenceById.has(r.id) ? { ...r, evidence: evidenceById.get(r.id) } : r)),
    evidenceLeft: Math.max(0, (c.preparedEvidence?.length ?? 0) - c.evidence.length),
    rendered,
    expected: c.expected ?? null,
    expectedNow: expectedNow(c) ?? null,
    runs: c.runs,
    marks: c.marks,
  };
}

export function listResponse(store: InvestigatorStore): ListResponse {
  return {
    cases: store.cases.map(caseSummary),
    models: MODELS.map((m) => ({ ...m, inputUsdPerMtok: PRICES_USD_PER_MTOK[m.id]?.input ?? null, outputUsdPerMtok: PRICES_USD_PER_MTOK[m.id]?.output ?? null })),
    keyPresent: readKey() !== null,
    generator: store.generator,
    generatedAt: store.generatedAt,
  };
}

export class InvestigatorApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "InvestigatorApiError";
    this.status = status;
  }
}

/** Load the store, find the case, let the caller change it, save. One operator, one process; the save is whole-file and atomic. */
export async function withCase<T>(id: string, fn: (c: InvestigatorCase, store: InvestigatorStore) => Promise<T> | T, opts: { save?: boolean } = {}): Promise<T> {
  const file = storePath();
  const store = loadStore(file);
  if (!store) throw new InvestigatorApiError(404, NO_CASES_MESSAGE);
  const c = store.cases.find((x) => x.id === id);
  if (!c) throw new InvestigatorApiError(404, `No case ${id}`);
  const out = await fn(c, store);
  if (opts.save) saveStore(store, file);
  return out;
}
