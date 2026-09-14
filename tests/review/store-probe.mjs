import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installSourceLoader, prohibitNetwork } from './runtime.mjs';
// Fresh process: is the active store readable, and are writes refused when it is not?
const [root, stateDir] = process.argv.slice(2);
process.env.ZEPTO_MODE = 'mock';
delete process.env.ZEPTO_TOKEN;
process.chdir(stateDir);
installSourceLoader(root);
prohibitNetwork();
console.warn = () => {};
const db = await import(pathToFileURL(path.join(root, 'src/lib/db.ts')));
const status = db.storeStatus();
let writeRefused = false;
try { db.saveDb(); } catch { writeRefused = true; }
console.log(JSON.stringify({ readable: status.readable, error: status.error ?? null, writeRefused, loans: db.loadDb().loans.length }));
