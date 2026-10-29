import type { CaseRecord } from "./case-file";
import type { Diagnosis, ExceptionType, NextStep } from "./labels";

/** One claim in a briefing: a sentence and the record ids that support it. */
export type Claim = { text: string; ids: string[] };

/** One candidate explanation, ranked by the model. */
export type Explanation = {
  rank: number;
  diagnosis: Diagnosis;
  summary: string;
  supporting_ids: string[]; // records that make this explanation more likely
  against_ids: string[]; // records that count against it (may be empty)
};

/**
 * The fixed shape of a briefing. The model returns exactly this as JSON; the
 * citation check reads it; the screen renders it. Nothing in it changes a loan.
 */
export type Briefing = {
  timeline: Claim[];
  known_for_certain: Claim[];
  explanations: Explanation[];
  diagnosis: Diagnosis; // the model's single best label; equals explanations[0].diagnosis
  next_step: { action: NextStep; detail: string; ids: string[]; would_settle_it?: string };
  confidence: { level: "high" | "medium" | "low"; reason: string };
};

export type CheckResult = {
  accepted: boolean;
  claims: number; // every cited sentence counted: timeline, known_for_certain, explanations, next step
  uncited: number; // claims with no id at all
  badIds: string[]; // ids that do not exist in the case file
  badClaims: number; // claims that cite at least one id that does not exist
  shapeErrors: string[]; // the JSON was not the briefing shape (missing field, unknown label...)
  reasons: string[]; // human-readable, one per problem
};

export type BriefingRun = {
  id: string; // run id, unique within the case
  at: string;
  model: string; // the exact model id the API was asked for
  caseHash: string; // hash of the case file text the model saw
  evidenceCount: number; // how many appended evidence records were in that file
  inputTokens: number;
  outputTokens: number;
  ms: number;
  costUsd: number | null; // null when the price table has no entry for the model
  raw: string; // the model's text, kept for the record (synthetic data only)
  briefing: Briefing | null; // null when the JSON could not be parsed
  check: CheckResult;
  error?: string; // an API or network error, when the run produced nothing
};

export type Mark = {
  at: string;
  by: string;
  verdict: "right" | "wrong" | "incomplete";
  note?: string;
  runId: string;
  caseHash: string;
  model: string;
};

/** The labels a generated case carries, so a briefing on it can be scored. */
export type Expected = {
  diagnosis: Diagnosis;
  nextStep: NextStep;
  mustCite: string[]; // ids a correct briefing has to cite somewhere
  tempting?: string; // what a hasty reading would conclude, and why it is wrong (for the report)
};

export type InvestigatorCase = {
  id: string; // T1-01 ...
  type: ExceptionType;
  title: string; // one line, for the case list
  loanId: string;
  createdAt: string;
  question: string;
  records: CaseRecord[]; // captured when the case was made
  evidence: (CaseRecord & { addedAt: string; label: string })[]; // appended later, ids continuing the numbering
  expected?: Expected; // the label on a generated case, as created (before any evidence)
  expectedAfterEvidence?: Expected; // for the demo: the label once the prepared evidence is added
  preparedEvidence?: (Omit<CaseRecord, "id"> & { label: string })[]; // what "new evidence arrived" will append, in order
  heldBack?: boolean; // never looked at while developing the prompt
  runs: BriefingRun[];
  marks: Mark[];
};

export type InvestigatorStore = {
  version: 1;
  generatedAt: string;
  generator: string; // which generator and version made the cases
  cases: InvestigatorCase[];
};
