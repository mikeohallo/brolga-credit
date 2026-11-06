// One briefing run, start to finish: render the case file, ask the model, parse,
// check, cost, record. The model call is a parameter so the offline suite can
// drive the whole pipeline with a canned answer and never touch the network.

import { parseBriefing, SYSTEM_PROMPT, userPrompt } from "./briefing";
import { citableIds } from "./case-file";
import { checkBriefing, citedIds } from "./check";
import { callModel, costUsd, DEFAULT_MAX_TOKENS, type ModelRequest, type ModelResponse } from "./model";
import { caseRecords, renderCase } from "./store";
import type { BriefingRun, Expected, InvestigatorCase } from "./types";

export type RunOptions = {
  model: string;
  apiKey?: string; // required for the real call; ignored when `call` is supplied
  effort?: ModelRequest["effort"];
  call?: (req: ModelRequest) => Promise<ModelResponse>;
  maxTokens?: number;
};

let runCounter = 0;

/**
 * Produce one briefing on the case as it stands, without recording it: render
 * the file, ask the model, parse, check, cost. The run carries the hash of the
 * file it read, what the call was allowed (cap, effort) and why the model
 * stopped. The server calls this outside its load–save window and records the
 * run afterwards (the fourth review, 6 Nov 2026, F1); the scripts use
 * runBriefing, which records in place.
 */
export async function produceBriefing(c: InvestigatorCase, opts: RunOptions): Promise<BriefingRun> {
  const rendered = renderCase(c);
  const citable = citableIds(caseRecords(c));
  const at = new Date().toISOString();
  const id = `${c.id}-run-${++runCounter}-${at.replace(/\D/g, "").slice(0, 14)}`;
  const call = opts.call ?? callModel;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const base = { id, at, model: opts.model, caseHash: rendered.hash, evidenceCount: c.evidence.length, maxTokens, effort: opts.effort ?? null };
  const started = Date.now();
  let res: ModelResponse;
  try {
    res = await call({ model: opts.model, system: SYSTEM_PROMPT, user: userPrompt(rendered.text), apiKey: opts.apiKey ?? "", effort: opts.effort, maxTokens });
  } catch (err) {
    // A failed call still took its time (a timeout is the slowest run there is); its cost is unknown, not nil.
    return { ...base, inputTokens: 0, outputTokens: 0, ms: Date.now() - started, costUsd: null, stopReason: null, raw: "", briefing: null, check: checkBriefing(null, citable, ["the model call failed"]), error: (err as Error).message };
  }
  const parsed = parseBriefing(res.text);
  const check = checkBriefing(parsed.briefing, citable, parsed.shapeErrors);
  return {
    ...base,
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
    ms: res.ms,
    costUsd: costUsd(opts.model, res.inputTokens, res.outputTokens),
    stopReason: res.stopReason,
    raw: res.text,
    briefing: parsed.briefing,
    check,
  };
}

/** Produce a briefing and record it on the case. For the scripts, which hold the store in memory. */
export async function runBriefing(c: InvestigatorCase, opts: RunOptions): Promise<BriefingRun> {
  const run = await produceBriefing(c, opts);
  c.runs.push(run);
  return run;
}

/** How a run did against a labelled case. Only an accepted briefing can be right. */
export type Score = {
  accepted: boolean;
  rejectedForShape: boolean; // the JSON was not the briefing shape
  rejectedForCitations: boolean; // uncited claims or ids that do not exist
  diagnosisCorrect: boolean;
  nextStepCorrect: boolean;
  citedMustCite: boolean; // every id the label requires appears somewhere in the briefing
  saidInsufficient: boolean; // the briefing's next step is insufficient_evidence
  expectedInsufficient: boolean;
  unsupportedClaims: number; // claims with no id or a bad id
  claims: number;
};

export function scoreRun(run: BriefingRun, expected: Expected): Score {
  const b = run.briefing;
  const accepted = run.check.accepted && !!b;
  const cited = b ? citedIds(b) : new Set<string>();
  return {
    accepted,
    rejectedForShape: !run.error && run.check.shapeErrors.length > 0,
    rejectedForCitations: !run.error && run.check.shapeErrors.length === 0 && !run.check.accepted,
    diagnosisCorrect: accepted && b!.diagnosis === expected.diagnosis,
    nextStepCorrect: accepted && b!.next_step.action === expected.nextStep,
    citedMustCite: accepted && expected.mustCite.every((id) => cited.has(id)),
    saidInsufficient: !!b && b.next_step.action === "insufficient_evidence",
    expectedInsufficient: expected.nextStep === "insufficient_evidence",
    unsupportedClaims: run.check.uncited + run.check.badClaims,
    claims: run.check.claims,
  };
}
