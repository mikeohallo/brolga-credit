// Run the labelled cases against a model and write the report.
//
//   node --disable-warning=ExperimentalWarning scripts/investigate-eval.mjs --type all --set dev --model claude-opus-5-5 --trials 3 [--effort medium] [--cases T1-01,T1-04] [--concurrency 3]
//
// --type: one exception type, or "all" (default). --set: "dev" (default; the 40
// development cases), "heldback" (the 20 held back from prompt work; run them only
// for a final comparison) or "all". Every case is run from its sealed state (no
// evidence) `trials` times. Each run is scored against the case's label. Failed
// and rejected runs count in the cost and in the accuracy denominator: a briefing
// that was thrown out is a briefing the operator did not get. Writes eval-<type>-<model>-<time>.json and .md to
// reports/ (or BROLGA_REPORTS_DIR); the key comes from .env.local or BROLGA_ENV_FILE.

import fs from 'node:fs';
import path from 'node:path';
import { arg, readKey, reportsDir, root, secs, sourceLoader, stamp, usd } from './investigate-lib.mjs';

const source = sourceLoader();
const { KEY_VARIABLE, PRICES_USD_PER_MTOK } = await source('src/lib/investigator/model.ts');
const { loadStore, storePath } = await source('src/lib/investigator/store.ts');
const { runBriefing, scoreRun } = await source('src/lib/investigator/run.ts');
const { PROMPT_VERSION } = await source('src/lib/investigator/briefing.ts');

process.env.ZEPTO_MODE ??= 'mock';
const type = arg('--type', 'all');
const set = arg('--set', 'dev');
if (!['dev', 'heldback', 'all'].includes(set)) { console.error('--set must be dev, heldback or all'); process.exit(2); }
const model = arg('--model', 'claude-opus-5-5');
const trials = Number(arg('--trials', '3'));
const effort = arg('--effort', undefined);
const only = arg('--cases', '').split(',').map((s) => s.trim()).filter(Boolean);
const concurrency = Math.max(1, Number(arg('--concurrency', '3')));

const store = loadStore(storePath(root));
if (!store) {
  console.error('No cases yet. Run: node --disable-warning=ExperimentalWarning scripts/investigate-cases.mjs');
  process.exit(2);
}
const cases = store.cases.filter((c) => (type === 'all' || c.type === type) && c.expected && (set === 'all' || (set === 'heldback') === !!c.heldBack) && (!only.length || only.includes(c.id)));
if (!cases.length) {
  console.error(`No labelled cases of type ${type} in the ${set} set`);
  process.exit(2);
}
const apiKey = readKey(KEY_VARIABLE);
if (!apiKey) {
  console.error(`No key. Put it in .env.local as ${KEY_VARIABLE}=... (git ignores that file).`);
  process.exit(2);
}
if (!PRICES_USD_PER_MTOK[model]) console.warn(`No price on file for ${model}; cost will be reported as unknown.`);

// Each trial starts from the sealed case: no evidence, no earlier runs.
const jobs = [];
for (const c of cases) for (let t = 1; t <= trials; t++) jobs.push({ c, t });
const results = [];
const startedAt = new Date();
console.log(`${cases.length} ${set} cases × ${trials} trials = ${jobs.length} runs on ${model}${effort ? ` (effort ${effort})` : ''}, ${concurrency} at a time`);
let next = 0;
async function worker() {
  while (next < jobs.length) {
    const { c, t } = jobs[next++];
    const fresh = { ...c, evidence: [], runs: [] };
    const run = await runBriefing(fresh, { model, apiKey, effort });
    const score = scoreRun(run, c.expected);
    results.push({ caseId: c.id, title: c.title, trial: t, expected: c.expected, run, score });
    const b = run.briefing;
    console.log(`  ${c.id} #${t}  ${run.error ? 'ERROR ' + run.error : (run.check.accepted ? 'accepted' : 'REJECTED') + `  ${b ? `${b.diagnosis} / ${b.next_step.action}` : '-'}  ${score.diagnosisCorrect ? '✓' : '✗'}`}  ${usd(run.costUsd)}  ${secs(run.ms)}`);
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
results.sort((a, b) => a.caseId.localeCompare(b.caseId) || a.trial - b.trial);

// Aggregates. Rates are over all runs unless named otherwise.
const n = results.length;
const count = (f) => results.filter(f).length;
const sum = (f) => results.reduce((s, r) => s + f(r), 0);
const errors = count((r) => !!r.run.error);
const accepted = count((r) => r.score.accepted);
const rejectedShape = count((r) => r.score.rejectedForShape);
const rejectedCitations = count((r) => r.score.rejectedForCitations);
const diagnosisCorrect = count((r) => r.score.diagnosisCorrect);
const nextStepCorrect = count((r) => r.score.nextStepCorrect);
const citedMustCite = count((r) => r.score.citedMustCite);
const expInsufficient = results.filter((r) => r.score.expectedInsufficient);
const correctInsufficient = expInsufficient.filter((r) => r.score.accepted && r.score.saidInsufficient).length;
const notExpInsufficient = results.filter((r) => !r.score.expectedInsufficient);
const overCautious = notExpInsufficient.filter((r) => r.score.saidInsufficient).length;
const claims = sum((r) => r.score.claims);
const unsupported = sum((r) => r.score.unsupportedClaims);
const cost = sum((r) => r.run.costUsd ?? 0);
const costKnown = results.every((r) => r.run.costUsd !== null);
const msList = results.map((r) => r.run.ms).filter((m) => m > 0).sort((a, b) => a - b);
const median = msList.length ? msList[Math.floor(msList.length / 2)] : 0;
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(0)}% (${a}/${b})` : 'n/a');

const byType = {};
for (const r of results) {
  const t = store.cases.find((c) => c.id === r.caseId).type;
  byType[t] ??= { runs: 0, diagnosisCorrect: 0, nextStepCorrect: 0, accepted: 0 };
  byType[t].runs += 1;
  if (r.score.diagnosisCorrect) byType[t].diagnosisCorrect += 1;
  if (r.score.nextStepCorrect) byType[t].nextStepCorrect += 1;
  if (r.score.accepted) byType[t].accepted += 1;
}

const summary = {
  type, set, model, effort: effort ?? 'API default', prompt: PROMPT_VERSION, generator: store.generator, startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), byType,
  cases: cases.length, trials, runs: n, errors, accepted, rejectedShape, rejectedCitations,
  diagnosisAccuracy: diagnosisCorrect / n, nextStepAccuracy: nextStepCorrect / n, requiredRecordsCited: citedMustCite / n,
  correctInsufficientEvidence: expInsufficient.length ? correctInsufficient / expInsufficient.length : null,
  overCaution: notExpInsufficient.length ? overCautious / notExpInsufficient.length : null,
  unsupportedClaimRate: claims ? unsupported / claims : null, claims, unsupported,
  costUsdTotal: costKnown ? cost : null, costUsdPerCaseTrial: costKnown ? cost / n : null, medianMs: median, meanMs: msList.length ? msList.reduce((a, b) => a + b, 0) / msList.length : 0,
  inputTokens: sum((r) => r.run.inputTokens), outputTokens: sum((r) => r.run.outputTokens),
};

const md = [];
md.push(`# Investigator evaluation: ${type === 'all' ? 'all types' : type}, ${set} set, ${model}`);
md.push('');
md.push(`${cases.length} cases × ${trials} trials = ${n} runs · effort ${summary.effort} · ${PROMPT_VERSION} · cases from "${store.generator}" · ${summary.finishedAt}`);
md.push('');
md.push('| Measure | Result |');
md.push('|---|---|');
md.push(`| Diagnosis right (rejected and failed runs count as wrong) | ${pct(diagnosisCorrect, n)} |`);
md.push(`| Next step right | ${pct(nextStepCorrect, n)} |`);
md.push(`| Required records cited | ${pct(citedMustCite, n)} |`);
md.push(`| Correctly said "insufficient evidence" when that was the answer | ${pct(correctInsufficient, expInsufficient.length)} |`);
md.push(`| Said "insufficient evidence" when the records were enough (over-caution) | ${pct(overCautious, notExpInsufficient.length)} |`);
md.push(`| Unsupported claims (no record, or a record that isn't there) | ${pct(unsupported, claims)} of all claims |`);
md.push(`| Briefings rejected by the citation check | ${pct(rejectedCitations, n)} |`);
md.push(`| Briefings rejected for shape (not the JSON asked for) | ${pct(rejectedShape, n)} |`);
md.push(`| Model calls that failed | ${pct(errors, n)} |`);
md.push(`| Cost per case (all ${n} runs, failed and rejected included) | ${costKnown ? usd(cost / n) : 'unknown: no price on file'} |`);
md.push(`| Cost, whole run | ${costKnown ? usd(cost) : 'unknown'} (${summary.inputTokens} tokens in, ${summary.outputTokens} out) |`);
md.push(`| Time per case, median / mean | ${secs(median)} / ${secs(summary.meanMs)} |`);
md.push('');
if (Object.keys(byType).length > 1) {
  md.push('## By type');
  md.push('');
  md.push('| Type | Runs | Diagnosis right | Next step right | Accepted |');
  md.push('|---|---|---|---|---|');
  for (const [t, v] of Object.entries(byType)) md.push(`| ${t} | ${v.runs} | ${pct(v.diagnosisCorrect, v.runs)} | ${pct(v.nextStepCorrect, v.runs)} | ${pct(v.accepted, v.runs)} |`);
  md.push('');
}
md.push('## Per case');
md.push('');
md.push('| Case | Expected | Trials right | What the model chose | Title |');
md.push('|---|---|---|---|---|');
for (const c of cases) {
  const rs = results.filter((r) => r.caseId === c.id);
  const chosen = rs.map((r) => (r.run.error ? 'error' : !r.score.accepted ? 'rejected' : `${r.run.briefing.diagnosis}/${r.run.briefing.next_step.action}`));
  md.push(`| ${c.id} | ${c.expected.diagnosis} / ${c.expected.nextStep} | ${rs.filter((r) => r.score.diagnosisCorrect && r.score.nextStepCorrect).length}/${rs.length} | ${chosen.join('; ')} | ${c.title} |`);
}
md.push('');
md.push('## Rejections and errors');
md.push('');
const bad = results.filter((r) => !r.score.accepted);
if (!bad.length) md.push('None.');
for (const r of bad) md.push(`- ${r.caseId} #${r.trial}: ${r.run.error ?? r.run.check.reasons.join('; ')}`);

const base = path.join(reportsDir(), `eval-${type}-${set}-${model}-${stamp()}`);
fs.writeFileSync(base + '.json', JSON.stringify({ summary, results }, null, 2) + '\n');
fs.writeFileSync(base + '.md', md.join('\n') + '\n');
console.log('\n' + md.slice(0, md.indexOf('## Per case')).join('\n'));
console.log(`\nWritten: ${base}.md and .json`);
