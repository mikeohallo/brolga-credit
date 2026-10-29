// The briefing: what the model is asked, the shape it must answer in, and how
// its text is turned back into that shape. The prompt is deliberately plain, a
// desk's standing instructions rather than a trick; the policing is done by the
// citation check, not by the wording here.

import { DIAGNOSES, NEXT_STEPS, isDiagnosis, isNextStep } from "./labels";
import type { Briefing, Claim, Explanation } from "./types";

export const PROMPT_VERSION = "briefing v1 (29 Oct 2026)";

export const SYSTEM_PROMPT = `You are the payments exception investigator at Brolga Credit, a small lender. An operator gives you a case file about one loan and one payment that something is wrong with. You write a briefing the operator will read before deciding what to do. You do not act; you have no tools; you know only what is in the case file.

Rules of the desk:
1. Every statement you make must cite the ids of the records it rests on, in square-bracket form, like B6 or P2. A statement with no record behind it does not belong in the briefing.
2. Only P records (the provider's API answers) establish what the provider holds. B records establish what the app did and recorded. S records establish only that someone said something.
3. A request that got no answer has an unknown outcome. It is not a failure and not a success. Do not call a payment failed, settled or absent unless a P record for that exact payment (the same uid) says so.
4. When the records do not establish what happened to the payment, say so: the diagnosis is outcome_unknown and the next step is insufficient_evidence, naming the exact record that would settle it. That is a correct answer, not a weak one.
5. Never recommend sending, resending or retrying a payment unless a P record for that exact payment shows a state that makes it safe (no record of it at all, or a failed state marked retryable).
6. Rank the explanations that remain. For each, cite the records that support it and the records that count against it.

Diagnosis labels (choose exactly one):
${Object.entries(DIAGNOSES)
  .map(([k, v]) => `- ${k}: ${v}`)
  .join("\n")}

Next-step labels (choose exactly one):
${Object.entries(NEXT_STEPS)
  .map(([k, v]) => `- ${k}: ${v}`)
  .join("\n")}

Answer with a single JSON object and nothing else, no prose before or after, no code fence, in exactly this shape:
{
  "timeline": [ { "text": "what happened, in order, one event per entry", "ids": ["B9"] } ],
  "known_for_certain": [ { "text": "a fact the records establish", "ids": ["B6", "P2"] } ],
  "explanations": [
    { "rank": 1, "diagnosis": "<label>", "summary": "one or two sentences", "supporting_ids": ["..."], "against_ids": ["..."] }
  ],
  "diagnosis": "<the rank-1 label>",
  "next_step": { "action": "<label>", "detail": "what to do, concretely", "ids": ["..."], "would_settle_it": "only when action is insufficient_evidence: the exact record to obtain" },
  "confidence": { "level": "high" | "medium" | "low", "reason": "one sentence" }
}`;

export function userPrompt(caseFileText: string): string {
  return `Here is the case file. Write the briefing.\n\n${caseFileText}`;
}

export type ParsedBriefing = { briefing: Briefing | null; shapeErrors: string[] };

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((s) => typeof s === "string");
}

function claim(x: unknown, where: string, errors: string[]): Claim | null {
  if (!x || typeof x !== "object") {
    errors.push(`${where}: not an object`);
    return null;
  }
  const o = x as Record<string, unknown>;
  if (typeof o.text !== "string" || !o.text.trim()) errors.push(`${where}: missing text`);
  if (!isStringArray(o.ids)) errors.push(`${where}: ids is not a list of strings`);
  return { text: String(o.text ?? ""), ids: isStringArray(o.ids) ? o.ids : [] };
}

/** Find the JSON object in the model's text, tolerating a code fence or a stray sentence around it. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function parseBriefing(text: string): ParsedBriefing {
  const errors: string[] = [];
  const raw = extractJson(text);
  if (!raw || typeof raw !== "object") return { briefing: null, shapeErrors: ["the answer is not a JSON object"] };
  const o = raw as Record<string, unknown>;

  const timeline = Array.isArray(o.timeline) ? o.timeline.map((c, i) => claim(c, `timeline[${i}]`, errors)).filter((c): c is Claim => !!c) : (errors.push("timeline is not a list"), []);
  const known = Array.isArray(o.known_for_certain) ? o.known_for_certain.map((c, i) => claim(c, `known_for_certain[${i}]`, errors)).filter((c): c is Claim => !!c) : (errors.push("known_for_certain is not a list"), []);

  const explanations: Explanation[] = [];
  if (!Array.isArray(o.explanations) || !o.explanations.length) errors.push("explanations is missing or empty");
  else
    o.explanations.forEach((e, i) => {
      const x = (e ?? {}) as Record<string, unknown>;
      if (!isDiagnosis(x.diagnosis)) errors.push(`explanations[${i}]: unknown diagnosis label "${String(x.diagnosis)}"`);
      if (typeof x.summary !== "string" || !x.summary.trim()) errors.push(`explanations[${i}]: missing summary`);
      if (!isStringArray(x.supporting_ids)) errors.push(`explanations[${i}]: supporting_ids is not a list of strings`);
      if (x.against_ids !== undefined && !isStringArray(x.against_ids)) errors.push(`explanations[${i}]: against_ids is not a list of strings`);
      explanations.push({
        rank: typeof x.rank === "number" ? x.rank : i + 1,
        diagnosis: isDiagnosis(x.diagnosis) ? x.diagnosis : "outcome_unknown",
        summary: String(x.summary ?? ""),
        supporting_ids: isStringArray(x.supporting_ids) ? x.supporting_ids : [],
        against_ids: isStringArray(x.against_ids) ? x.against_ids : [],
      });
    });
  explanations.sort((a, b) => a.rank - b.rank);

  if (!isDiagnosis(o.diagnosis)) errors.push(`unknown diagnosis label "${String(o.diagnosis)}"`);
  else if (explanations.length && explanations[0].diagnosis !== o.diagnosis) errors.push(`diagnosis "${o.diagnosis}" is not the rank-1 explanation "${explanations[0].diagnosis}"`);

  const ns = (o.next_step ?? {}) as Record<string, unknown>;
  if (!isNextStep(ns.action)) errors.push(`unknown next-step label "${String(ns.action)}"`);
  if (typeof ns.detail !== "string" || !ns.detail.trim()) errors.push("next_step.detail is missing");
  if (!isStringArray(ns.ids)) errors.push("next_step.ids is not a list of strings");
  if (ns.action === "insufficient_evidence" && (typeof ns.would_settle_it !== "string" || !ns.would_settle_it.trim())) errors.push("next_step.would_settle_it is missing for insufficient_evidence");

  const conf = (o.confidence ?? {}) as Record<string, unknown>;
  const level = conf.level === "high" || conf.level === "medium" || conf.level === "low" ? conf.level : null;
  if (!level) errors.push(`confidence.level "${String(conf.level)}" is not high, medium or low`);

  const briefing: Briefing = {
    timeline,
    known_for_certain: known,
    explanations,
    diagnosis: isDiagnosis(o.diagnosis) ? o.diagnosis : explanations[0]?.diagnosis ?? "outcome_unknown",
    next_step: {
      action: isNextStep(ns.action) ? ns.action : "insufficient_evidence",
      detail: String(ns.detail ?? ""),
      ids: isStringArray(ns.ids) ? ns.ids : [],
      would_settle_it: typeof ns.would_settle_it === "string" ? ns.would_settle_it : undefined,
    },
    confidence: { level: level ?? "low", reason: String(conf.reason ?? "") },
  };
  return { briefing, shapeErrors: errors };
}
