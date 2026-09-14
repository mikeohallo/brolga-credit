import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installSourceLoader, prohibitNetwork } from './runtime.mjs';
const [root, stateDir, loanId] = process.argv.slice(2);
process.env.ZEPTO_MODE = 'mock';
delete process.env.ZEPTO_TOKEN;
delete process.env.ZEPTO_BASE_URL;
process.chdir(stateDir);
installSourceLoader(root);
const blocked = prohibitNetwork();
const db = await import(pathToFileURL(path.join(root, 'src/lib/db.ts')));
const domain = await import(pathToFileURL(path.join(root, 'src/lib/domain/loans.ts')));
let result;
if (loanId === 'corruption') {
  const filename = path.join(stateDir, 'data/brolga.json');
  const before = fs.readFileSync(filename, 'utf8');
  console.warn = () => {};
  const loaded = db.loadDb();
  result = { originalFilePreserved: before === fs.readFileSync(filename, 'utf8'), loans: loaded.loans.length };
} else {
  const loan = db.getLoan(loanId);
  try {
    await domain.refreshLoan(loanId);
    result = { localLoanExists: !!loan, refreshed: true };
  } catch (e) {
    result = { localLoanExists: !!loan, refreshed: false, status: e.status, error: e.message };
  }
}
console.log(JSON.stringify({ ...result, blockedNetworkAttempts: blocked() }));
