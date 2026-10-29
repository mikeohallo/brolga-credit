// The investigator's own store: cases, briefing runs and marks, in a JSON file
// beside Brolga's loan store and separate from it. The money code and its tests
// never read this file; the investigator can be reset or removed without
// touching anything that moves money.

import fs from "node:fs";
import path from "node:path";
import { configuredMode } from "../zepto";
import { assignIds, renderCaseFile, type CaseRecord, type RenderedCaseFile } from "./case-file";
import type { InvestigatorCase, InvestigatorStore, Mark } from "./types";

/** The variable that moves the investigator's file: a path (relative to the app folder, or absolute). */
export const STORE_VARIABLE = "BROLGA_INVESTIGATOR_STORE";

/**
 * Where the investigator's file lives. By default beside Brolga's own store in
 * data/, one file per mode. BROLGA_INVESTIGATOR_STORE moves it, so a run from a
 * fresh copy of the repo can keep its cases, briefings and marks somewhere that
 * outlives the copy; the scripts and the server both read this, so they agree.
 */
export function storePath(root = process.cwd()): string {
  const configured = process.env[STORE_VARIABLE]?.trim();
  if (configured) return path.resolve(root, configured);
  return path.join(root, "data", configuredMode() === "mock" ? "investigator.mock.json" : "investigator.json");
}

export function emptyStore(generator: string): InvestigatorStore {
  return { version: 1, generatedAt: new Date().toISOString(), generator, cases: [] };
}

export function loadStore(file = storePath()): InvestigatorStore | null {
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as InvestigatorStore;
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.cases)) throw new Error(`${path.relative(process.cwd(), file)} is not an investigator store`);
  return parsed;
}

export function saveStore(store: InvestigatorStore, file = storePath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, file);
}

/** The records the model sees for a case right now: the captured ones plus every evidence record added so far. */
export function caseRecords(c: InvestigatorCase): CaseRecord[] {
  return [...c.records, ...c.evidence.map(({ addedAt: _a, label: _l, ...r }) => (void _a, void _l, r))];
}

export function renderCase(c: InvestigatorCase): RenderedCaseFile {
  return renderCaseFile({ caseId: c.id, type: c.type, loanId: c.loanId, question: c.question, records: caseRecords(c) });
}

/**
 * "New evidence arrived": append the next prepared record (or a supplied one)
 * to the case. The id continues the numbering for its source, so every id
 * already cited in an earlier briefing still points at the same record.
 */
export function addEvidence(c: InvestigatorCase, record?: Omit<CaseRecord, "id"> & { label?: string }): CaseRecord {
  const next = record ?? c.preparedEvidence?.[c.evidence.length];
  if (!next) throw new Error(`Case ${c.id} has no more prepared evidence`);
  const [withId] = assignIds([...caseRecords(c), { ...next, id: undefined }]).slice(-1);
  const { label, ...rest } = next as Omit<CaseRecord, "id"> & { label?: string };
  const stored = { ...rest, id: withId.id, addedAt: new Date().toISOString(), label: label ?? "new evidence" };
  c.evidence.push(stored);
  return { ...rest, id: withId.id };
}

/**
 * An operator's verdict on one briefing. The mark carries the run id, the hash
 * of the case file that run saw and the model, so it means one exact briefing
 * on one exact file. The verdict and the run must both exist; nothing else is
 * read from the request.
 */
export function addMark(c: InvestigatorCase, input: { runId: string; verdict: Mark["verdict"]; note?: string; by?: string }): Mark {
  if (!["right", "wrong", "incomplete"].includes(input.verdict)) throw new Error(`A mark is right, wrong or incomplete; "${String(input.verdict)}" is none of those`);
  const run = c.runs.find((r) => r.id === input.runId);
  if (!run) throw new Error(`Case ${c.id} has no briefing ${input.runId}`);
  if (!run.check.accepted || !run.briefing) throw new Error(`Briefing ${run.id} was rejected before anyone saw it; it cannot be marked`);
  const note = (input.note ?? "").trim();
  const mark: Mark = { at: new Date().toISOString(), by: (input.by ?? "").trim() || "operator", verdict: input.verdict, ...(note ? { note } : {}), runId: run.id, caseHash: run.caseHash, model: run.model };
  c.marks.push(mark);
  return mark;
}

/** The label that applies to the case as it stands: after evidence, the after-evidence label when the generator gave one. */
export function expectedNow(c: InvestigatorCase) {
  return c.evidence.length && c.expectedAfterEvidence ? c.expectedAfterEvidence : c.expected;
}
