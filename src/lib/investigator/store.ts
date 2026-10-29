// The investigator's own store: cases, briefing runs and marks, in a JSON file
// beside Brolga's loan store and separate from it. The money code and its tests
// never read this file; the investigator can be reset or removed without
// touching anything that moves money.

import fs from "node:fs";
import path from "node:path";
import { configuredMode } from "../zepto";
import { assignIds, renderCaseFile, type CaseRecord, type RenderedCaseFile } from "./case-file";
import type { InvestigatorCase, InvestigatorStore } from "./types";

export function storePath(root = process.cwd()): string {
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
