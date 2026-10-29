// Generate the investigator's synthetic cases into data/investigator.mock.json
// (or the file BROLGA_INVESTIGATOR_STORE names; the app's Investigate tab and the
// other scripts read the same variable, so they all agree on where the cases are).
//
//   node --disable-warning=ExperimentalWarning scripts/investigate-cases.mjs [--render [dir]]
//
// --render alone writes each case file to reports/cases (or BROLGA_REPORTS_DIR/cases).
//
// Runs Brolga's real domain code against the mock provider under a fake clock,
// in a temporary state directory, so nothing touches the app's own store. The
// clock starts at a fixed moment and every id, uid and timestamp follows from it,
// so two machines generate byte-identical cases (the printed hashes should match).
// No network: fetch is disabled for the whole run, as in the review suite.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installSourceLoader, prohibitNetwork } from '../tests/review/runtime.mjs';
import { reportsDir } from './investigate-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const renderDir = args.includes('--render') ? path.resolve(root, args[args.indexOf('--render') + 1] ?? path.join(reportsDir(), 'cases')) : null;

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brolga-investigator-gen-'));
process.chdir(stateDir);
process.env.ZEPTO_MODE = 'mock';
process.env.MOCK_FLOAT = '0';
delete process.env.ZEPTO_TOKEN;
delete process.env.ZEPTO_BASE_URL;
installSourceLoader(root);
const blockedAttempts = prohibitNetwork();

// A fixed clock: Tuesday 13 October 2026, 09:30 Sydney.
const RealDate = Date;
let time = RealDate.parse('2026-10-12T22:30:00Z');
class GenDate extends RealDate {
  constructor(...a) { super(...(a.length ? a : [time])); }
  static now() { return time; }
}
globalThis.Date = GenDate;
const clock = { advance: (ms) => { time += ms; } };

const source = (name) => import(pathToFileURL(path.join(root, name)));
const db = await source('src/lib/db.ts');
const { resetMock } = await source('src/lib/zepto/mock.ts');
const { generateAllCases, GENERATOR } = await source('src/lib/investigator/cases/index.ts');
const { saveStore, renderCase, storePath } = await source('src/lib/investigator/store.ts');
const outFile = storePath(root);

try {
  resetMock();
  db.resetDb();
  const cases = await generateAllCases(clock);
  globalThis.Date = RealDate;
  const store = { version: 1, generatedAt: new RealDate().toISOString(), generator: GENERATOR, cases };
  saveStore(store, outFile);
  console.log(`${cases.length} cases (${cases.filter((c) => c.heldBack).length} held back) → ${path.relative(root, outFile)}`);
  for (const c of cases) {
    const r = renderCase(c);
    console.log(`  ${c.id}  ${c.loanId}  ${r.hash}  ${String(r.wordCount).padStart(4)} words  ${String(c.records.length).padStart(2)} records  ${c.heldBack ? 'held back' : 'dev      '}  ${c.expected.diagnosis} / ${c.expected.nextStep}  · ${c.title}`);
    if (renderDir) {
      fs.mkdirSync(renderDir, { recursive: true });
      fs.writeFileSync(path.join(renderDir, `${c.id}.txt`), r.text + '\n');
    }
  }
  if (renderDir) console.log(`case files rendered to ${renderDir}`);
  if (blockedAttempts()) throw new Error(`${blockedAttempts()} network attempt(s) were blocked; the generator must not reach the network`);
} finally {
  globalThis.Date = RealDate;
  process.chdir(root); // Windows will not delete the current directory
  fs.rmSync(stateDir, { recursive: true, force: true });
}
