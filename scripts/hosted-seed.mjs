// Writes the sixty sealed investigator cases to hosted/investigator.seed.txt, the file the
// hosted Worker starts from the first time it runs (it is bundled into the Worker as text).
// Same generator and same fixed clock as `scripts/investigate-cases.mjs`; this only points
// its output somewhere else. Cross-platform on purpose: it is run from Mike's PC.
//
//   node --disable-warning=ExperimentalWarning scripts/hosted-seed.mjs

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.BROLGA_INVESTIGATOR_STORE = path.join(root, 'hosted', 'investigator.seed.txt');
process.env.ZEPTO_MODE = 'mock';
await import('./investigate-cases.mjs');
