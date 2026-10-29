// The prepared demo: one case, one briefing, new evidence, a second briefing.
//
//   node --disable-warning=ExperimentalWarning scripts/investigate-demo.mjs [--case T1-01] [--model claude-opus-5-5] [--effort medium]
//
// Needs data/investigator.mock.json (scripts/investigate-cases.mjs makes it) and
// the key in .env.local as BROLGA_INVESTIGATOR_KEY (or in the file BROLGA_ENV_FILE
// names). Writes one Markdown file to reports/ (or BROLGA_REPORTS_DIR) with
// everything the operator would have seen, and records the runs on the case in
// the store. The model is called twice; nothing else leaves the machine.

import fs from 'node:fs';
import path from 'node:path';
import { arg, briefingMarkdown, readKey, reportsDir, root, secs, sourceLoader, stamp, usd } from './investigate-lib.mjs';

const source = sourceLoader();
const { KEY_VARIABLE } = await source('src/lib/investigator/model.ts');
const { loadStore, saveStore, storePath, addEvidence, renderCase } = await source('src/lib/investigator/store.ts');
const { runBriefing, scoreRun } = await source('src/lib/investigator/run.ts');
const { PROMPT_VERSION } = await source('src/lib/investigator/briefing.ts');

process.env.ZEPTO_MODE ??= 'mock';
const caseId = arg('--case', 'T1-01');
const model = arg('--model', 'claude-opus-5-5');
const effort = arg('--effort', undefined);

const file = storePath(root);
const store = loadStore(file);
if (!store) {
  console.error(`No cases yet. Run: node --disable-warning=ExperimentalWarning scripts/investigate-cases.mjs`);
  process.exit(2);
}
const c = store.cases.find((x) => x.id === caseId);
if (!c) {
  console.error(`No case ${caseId}. Cases: ${store.cases.map((x) => x.id).join(', ')}`);
  process.exit(2);
}
const apiKey = readKey(KEY_VARIABLE);
if (!apiKey) {
  console.error(`No key. Put it in .env.local as ${KEY_VARIABLE}=... (git ignores that file).`);
  process.exit(2);
}
// The demo always starts from the case as made: any evidence from an earlier demo is cleared.
c.evidence = [];

const lines = [];
const say = (s = '') => { console.log(s); lines.push(s); };

say(`# Investigator demo: ${c.id}, ${c.title}`);
say();
say(`Model \`${model}\`${effort ? `, effort ${effort}` : ', effort: the API default'} · ${PROMPT_VERSION} · ${new Date().toISOString()} · loan ${c.loanId}`);
say();
say('## The question');
say();
say(c.question);
say();
say('## The case file the model read');
say();
say('```');
lines.push(renderCase(c).text);
say('```');
say();
say('## First briefing: the case as it stands');
say();
console.log('Calling the model for the first briefing...');
const run1 = await runBriefing(c, { model, apiKey, effort });
const score1 = scoreRun(run1, c.expected);
say(briefingMarkdown(run1, c.expected));
say();
say(`Score against the label: diagnosis ${score1.diagnosisCorrect ? 'right' : 'wrong'}, next step ${score1.nextStepCorrect ? 'right' : 'wrong'}, required records ${score1.citedMustCite ? 'cited' : 'not all cited'}, unsupported claims ${score1.unsupportedClaims} of ${score1.claims}.`);

let run2 = null;
if (c.preparedEvidence?.length) {
  say();
  say('## New evidence arrived');
  say();
  const added = addEvidence(c);
  say(`Added to the case file as **[${added.id}]** (${c.evidence[c.evidence.length - 1].label}): ${added.kind} · ${added.text}`);
  say();
  say('## Second briefing: with the evidence');
  say();
  console.log('Calling the model for the second briefing...');
  run2 = await runBriefing(c, { model, apiKey, effort });
  const score2 = scoreRun(run2, c.expectedAfterEvidence ?? c.expected);
  say(briefingMarkdown(run2, c.expectedAfterEvidence));
  say();
  say(`Score against the label: diagnosis ${score2.diagnosisCorrect ? 'right' : 'wrong'}, next step ${score2.nextStepCorrect ? 'right' : 'wrong'}, required records ${score2.citedMustCite ? 'cited' : 'not all cited'}, unsupported claims ${score2.unsupportedClaims} of ${score2.claims}.`);
  say();
  const changed = run1.briefing && run2.briefing && (run1.briefing.diagnosis !== run2.briefing.diagnosis || run1.briefing.next_step.action !== run2.briefing.next_step.action);
  say(`**Did the conclusion change with the evidence?** ${changed ? `Yes: \`${run1.briefing.diagnosis}\` / \`${run1.briefing.next_step.action}\` → \`${run2.briefing.diagnosis}\` / \`${run2.briefing.next_step.action}\`.` : 'No.'}`);
}

const total = (run1.costUsd ?? 0) + (run2?.costUsd ?? 0);
say();
say(`## Totals: ${run2 ? 'two' : 'one'} model call${run2 ? 's' : ''}, ${usd(total)}, ${secs(run1.ms + (run2?.ms ?? 0))}`);

const out = path.join(reportsDir(), `demo-${c.id}-${model}-${stamp()}.md`);
fs.writeFileSync(out, lines.join('\n') + '\n');
saveStore(store, file);
console.log(`\nWritten: ${out}`);
