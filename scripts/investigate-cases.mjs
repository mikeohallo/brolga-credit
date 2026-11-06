// Generate the investigator's synthetic cases into the file the server will read
// (BROLGA_INVESTIGATOR_STORE, else data/investigator.mock.json or data/investigator.json
// for the mode .env.local configures; the app's Investigate tab and the other
// scripts resolve it the same way, so they all agree on where the cases are).
//
//   node --disable-warning=ExperimentalWarning scripts/investigate-cases.mjs [--render [dir]] [--carry-from <store>] [--update-manifest]
//
// --render alone writes each case file to reports/cases (or BROLGA_REPORTS_DIR/cases).
// --carry-from copies the briefings, appended evidence and marks from an earlier store
// into the new one, case by case, where the sealed file and the prepared evidence are
// identical (they are, unless a generator changed), so regenerating for new labels
// keeps what operators have done.
//
// The sealed hashes are published in tests/review/investigator-hashes.json. Every run
// checks the sixty it made against that file and says loudly which moved; a generator
// change that moves one is a new sealed set, recorded with --update-manifest and said
// in the decisions log, never a quiet drift. The eval refuses a store that differs.
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
import { MANIFEST, movedHashes, readManifest, reportsDir, storeFile } from './investigate-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const after = (flag) => { const v = args[args.indexOf(flag) + 1]; return v && !v.startsWith('--') ? v : undefined; };
const renderDir = args.includes('--render') ? path.resolve(root, after('--render') ?? path.join(reportsDir(), 'cases')) : null;
const carryFrom = args.includes('--carry-from') ? path.resolve(root, after('--carry-from') ?? '') : null;
if (args.includes('--carry-from') && !after('--carry-from')) { console.error('--carry-from needs the path of the earlier store'); process.exit(2); }
const updateManifest = args.includes('--update-manifest');

// The output file is decided as the server decides it, before the generator's own
// mode is forced to mock below (the fourth review, 6 Nov 2026, F9).
const outFile = storeFile();

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
const { saveStore, loadStore, renderCase, sealedHash, carryState } = await source('src/lib/investigator/store.ts');

try {
  resetMock();
  db.resetDb();
  const cases = await generateAllCases(clock);
  globalThis.Date = RealDate;
  const store = { version: 1, generatedAt: new RealDate().toISOString(), generator: GENERATOR, cases };
  console.log(`${cases.length} cases (${cases.filter((c) => c.heldBack).length} held back) → ${path.relative(root, outFile)}`);
  // The hashes printed and the files rendered are the sealed cases: no evidence, as the eval sees them.
  for (const c of cases) {
    const r = renderCase(c);
    console.log(`  ${c.id}  ${c.loanId}  ${r.hash}  ${String(r.wordCount).padStart(4)} words  ${String(c.records.length).padStart(2)} records  ${c.heldBack ? 'held back' : 'dev      '}  ${c.expected.diagnosis} / ${c.expected.nextStep}  · ${c.title}`);
    if (renderDir) {
      fs.mkdirSync(renderDir, { recursive: true });
      fs.writeFileSync(path.join(renderDir, `${c.id}.txt`), r.text + '\n');
    }
  }
  if (renderDir) console.log(`case files rendered to ${renderDir}`);
  const manifest = readManifest();
  const moved = movedHashes(store, sealedHash, manifest);
  if (updateManifest) {
    fs.writeFileSync(MANIFEST, JSON.stringify(Object.fromEntries(cases.map((c) => [c.id, sealedHash(c)])), null, 2) + '\n');
    console.log(`${moved.length ? `${moved.length} hash${moved.length === 1 ? '' : 'es'} moved; ` : ''}manifest written to ${path.relative(root, MANIFEST)} (a new sealed set: say so in the decisions log)`);
  } else if (!manifest) {
    console.warn(`WARNING: no manifest at ${path.relative(root, MANIFEST)}; the sealed set is not pinned. Write it with --update-manifest.`);
  } else if (moved.length) {
    console.warn(`WARNING: ${moved.length} of ${cases.length} sealed hashes differ from ${path.relative(root, MANIFEST)}: ${moved.map((m) => `${m.id} ${m.expected ?? '(absent)'} → ${m.actual}`).join(', ')}. A generator changed; the eval will refuse this store unless --allow-moved-hashes is given, and the published numbers do not describe it.`);
  } else {
    console.log(`all ${cases.length} sealed hashes match ${path.relative(root, MANIFEST)}`);
  }
  if (carryFrom) {
    const earlier = loadStore(carryFrom);
    if (!earlier) throw new Error(`--carry-from: no store at ${carryFrom}`);
    const carried = carryState(store, earlier);
    console.log(`carried from ${path.relative(root, carryFrom)}: ${carried.runs} briefings, ${carried.evidence} evidence records and ${carried.marks} marks on ${carried.cases} cases`);
  }
  saveStore(store, outFile);
  if (blockedAttempts()) throw new Error(`${blockedAttempts()} network attempt(s) were blocked; the generator must not reach the network`);
} finally {
  globalThis.Date = RealDate;
  process.chdir(root); // Windows will not delete the current directory
  fs.rmSync(stateDir, { recursive: true, force: true });
}
