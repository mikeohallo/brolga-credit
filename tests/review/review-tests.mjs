// Offline invariant suite for Brolga. Adapted from the independent review harness
// of 12 September 2026 (T01–T36), with T24 strengthened to assert the enforced
// Confirmation of Payee policy and T37–T45 added for the invariants introduced in
// the stabilisation pass. Runs the real TypeScript modules with Node's type
// stripping, a fake clock and the in-memory mock; no server, browser or network.
//
//   node --disable-warning=ExperimentalWarning tests/review/review-tests.mjs . tests/review/results.json
//
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installSourceLoader, prohibitNetwork } from './runtime.mjs';

const evidenceDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.argv[2] || path.join(evidenceDir, '../..'));
const resultsFile = path.resolve(process.argv[3] || path.join(evidenceDir, 'results.json'));
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brolga-review-state-'));
process.chdir(stateDir);
process.env.ZEPTO_MODE = 'mock';
process.env.MOCK_FLOAT = '0';
delete process.env.ZEPTO_TOKEN;
delete process.env.ZEPTO_BASE_URL;
installSourceLoader(root);
const blockedNetworkAttempts = prohibitNetwork();
const blockedFetch = globalThis.fetch;
const RealDate = Date;
const baseTime = RealDate.parse('2026-09-12T02:00:00Z');
let time = baseTime;
class ReviewDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [time])); }
  static now() { return time; }
}
globalThis.Date = ReviewDate;
const advance = (ms) => { time += ms; };
const source = (name) => import(pathToFileURL(path.join(root, name)));
const db = await source('src/lib/db.ts');
const domain = await source('src/lib/domain/loans.ts');
const { resetMock } = await source('src/lib/zepto/mock.ts');
const { getZepto, ZeptoError, configuredMode } = await source('src/lib/zepto/index.ts');
const { ZeptoClient } = await source('src/lib/zepto/client.ts');
const z = getZepto();
const nativeMethods = Object.fromEntries(Object.getOwnPropertyNames(Object.getPrototypeOf(z)).filter(k => k !== 'constructor').map(k => [k, z[k]]));
const routes = {
  loans: await source('src/app/api/loans/route.ts'),
  loan: await source('src/app/api/loans/[id]/route.ts'),
  collect: await source('src/app/api/loans/[id]/collect/route.ts'),
  health: await source('src/app/api/health/route.ts'),
  transactions: await source('src/app/api/ops/transactions/route.ts'),
  console: await source('src/app/api/console/route.ts'),
};
const request = (url, body) => new Request('https://review.invalid' + url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const params = (id) => ({ params: Promise.resolve({ id }) });
const results = [];
let facts;
function note(value) { Object.assign(facts, value); }
function reset() {
  time = baseTime + results.length * 1000;
  globalThis.fetch = blockedFetch;
  process.env.MOCK_FLOAT = '0';
  for (const [key, fn] of Object.entries(nativeMethods)) z[key] = fn;
  globalThis.__brolgaHealth = undefined;
  resetMock();
  db.resetDb();
  facts = {};
}
function loan(principalCents = 60000, termFortnights = 4) {
  return domain.createLoan({ borrowerId: 'BRW-0001', principalCents, termFortnights, purpose: 'Synthetic independent review' });
}
async function funded() {
  const l = loan();
  await domain.disburse(l.id);
  advance(15000);
  await domain.refreshLoan(l.id);
  assert.equal(l.status, 'disbursed');
  return l;
}
async function active() {
  const l = await funded();
  await domain.createMandate(l.id, { delay: 1 });
  advance(1100);
  await domain.refreshLoan(l.id);
  assert.equal(l.mandate.state, 'active');
  return l;
}
async function payment(l, simulation = 'auto_settle', n = 1) {
  await domain.collect(l.id, n, { simulate: simulation, delay: 1 });
  advance(1100);
  await domain.refreshLoan(l.id);
}
async function test(id, name, expectation, fn) {
  reset();
  try {
    await fn();
    results.push({ id, name, expectation, result: 'PASS', observations: facts });
  } catch (error) {
    results.push({ id, name, expectation, result: 'FAIL', observations: facts, failure: error.message, assertion: error.code === 'ERR_ASSERTION' });
  }
  console.log(`${results.at(-1).result} ${id} ${name}`);
}

try {
  await test('T01', 'Valid quote and fortnightly schedule', 'A $600 loan over four fortnights totals $624 in four $156 instalments.', async () => {
    const l = loan();
    note({ principal: l.principalCents, fee: l.feeCents, scheduledTotal: l.instalments.reduce((s, i) => s + i.amountCents, 0), dates: l.instalments.map(i => i.dueDate) });
    assert.equal(l.feeCents, 2400);
    assert.deepEqual(l.instalments.map(i => i.amountCents), [15600, 15600, 15600, 15600]);
    assert.deepEqual(l.instalments.map(i => i.dueDate), ['2026-09-12', '2026-09-26', '2026-10-10', '2026-10-24']);
  });
  await test('T02', 'Insufficient funds, then retry', 'A retryable failed payment settles using the same payment UID.', async () => {
    const l = await active();
    await payment(l, 'insufficient_funds');
    assert.equal(l.status, 'in_arrears');
    const uid = l.instalments[0].paymentUid;
    assert.equal(l.instalments[0].failure.code, 'AM04');
    await domain.retryInstalment(l.id, 1, { delay: 1 });
    advance(1100);
    await domain.refreshLoan(l.id);
    note({ status: l.status, paymentUidUnchanged: uid === l.instalments[0].paymentUid, attempts: l.instalments[0].attempts });
    assert.equal(l.instalments[0].paymentUid, uid);
    assert.equal(l.instalments[0].state, 'settled');
    assert.equal(l.status, 'active');
  });
  await test('T03', 'Non-retryable collection', 'Account-closed failure is not accepted by retryInstalment.', async () => {
    const l = await active();
    await payment(l, 'debtor_account_closed');
    await assert.rejects(domain.retryInstalment(l.id, 1), /not retryable/);
    note({ failureCode: l.instalments[0].failure.code, retryable: l.instalments[0].failure.retryable });
  });
  await test('T04', 'Borrower controls their suspension', 'Initiator reactivation is refused until the borrower reactivates.', async () => {
    const l = await active();
    await domain.debtorAction(l.id, 'suspension', 'Synthetic borrower pause');
    await assert.rejects(domain.reactivateMandate(l.id), /only be lifted by the debtor/);
    await domain.debtorAction(l.id, 'reactivation', 'Synthetic borrower resume');
    note({ mandateState: l.mandate.state, causedBy: l.mandate.stateCausedBy });
    assert.equal(l.mandate.state, 'active');
  });
  await test('T05', 'Initiator hardship pause and resume', 'New collection is blocked while suspended; initiator can resume its own pause.', async () => {
    const l = await active();
    await domain.suspendMandate(l.id, 'Synthetic hardship');
    await assert.rejects(domain.collect(l.id, 1), /not active/);
    await domain.reactivateMandate(l.id);
    assert.equal(l.status, 'active');
    note({ status: l.status });
  });
  await test('T06', 'Declined agreement can be reissued', 'A declined agreement can be replaced with a distinct UID.', async () => {
    const l = await funded();
    await domain.createMandate(l.id, { simulate: 'debtor_decline', delay: 1 });
    advance(1100);
    await domain.refreshLoan(l.id);
    assert.equal(l.mandate.state, 'declined');
    const oldUid = l.mandate.uid;
    await domain.createMandate(l.id, { delay: 1 });
    advance(1100);
    await domain.refreshLoan(l.id);
    note({ mandateState: l.mandate.state, distinctUid: oldUid !== l.mandate.uid });
    assert.notEqual(l.mandate.uid, oldUid);
    assert.equal(l.mandate.state, 'active');
  });
  await test('T07', 'Credit-side disbursement truth', 'Cleared debit alone is pending, and returned borrower credit is failure.', async () => {
    assert.equal(domain.disbursementSettled({ status: 'cleared' }), 'pending');
    assert.equal(domain.disbursementSettled({ status: 'cleared', creditStatus: 'cleared' }), 'cleared');
    assert.equal(domain.disbursementSettled({ status: 'cleared', creditStatus: 'returned' }), 'failed');
    note({ debitOnly: 'pending', bothCleared: 'cleared', returnedCredit: 'failed' });
  });
  await test('T08', 'Returned Direct Entry payout', 'A returned credit produces disbursement_failed even though the debit cleared.', async () => {
    const l = loan();
    await domain.disburse(l.id, { forceFailure: 'de_account_not_found' });
    advance(9500);
    await domain.refreshLoan(l.id);
    note({ status: l.status, debitStatus: l.disbursement.status, creditStatus: l.disbursement.creditStatus, code: l.disbursement.failure.code });
    assert.equal(l.status, 'disbursement_failed');
    assert.equal(l.disbursement.failure.code, 'E105');
  });
  await test('T09', 'Collection before disbursement clears', 'The collection route must reject repayment before funds clear to the borrower.', async () => {
    const l = loan();
    await domain.disburse(l.id);
    await domain.createMandate(l.id, { delay: 1 });
    advance(1100);
    await domain.refreshLoan(l.id);
    const offered = domain.nextCollectable(l);
    const r = await routes.collect.POST(request('/api/loans/' + l.id + '/collect', { n: 1, delay: 1 }), params(l.id));
    advance(1100);
    await domain.refreshLoan(l.id);
    note({ httpStatus: r.status, disbursement: domain.disbursementSettled(l.disbursement), loanStatus: l.status, instalmentState: l.instalments[0].state, uiOffersCollection: !!offered.instalment && !offered.reason });
    assert.ok(r.status >= 400, 'Repayment was accepted while borrower funding was still pending.');
  });
  await test('T10', 'Collection after disbursement failure', 'A failed disbursement must block repayment even if its mandate is active.', async () => {
    const l = loan();
    await domain.disburse(l.id, { forceFailure: 'de_account_not_found' });
    await domain.createMandate(l.id, { delay: 1 });
    advance(9500);
    await domain.refreshLoan(l.id);
    const offered = domain.nextCollectable(l);
    const r = await routes.collect.POST(request('/collect', { n: 1, delay: 1 }), params(l.id));
    advance(1100);
    await domain.refreshLoan(l.id);
    note({ httpStatus: r.status, loanStatus: l.status, collectionOffered: !!offered.instalment && !offered.reason, instalmentState: l.instalments[0].state });
    assert.ok(r.status >= 400, 'Repayment was accepted after the loan disbursement had failed.');
  });
  await test('T11', 'Restructure reconciles the debt', 'Completing the amended schedule must not close a loan with an unexplained outstanding balance.', async () => {
    const l = await active();
    await payment(l);
    await domain.amendMandate(l.id, 10000, { delay: 1 });
    advance(1100);
    await domain.refreshLoan(l.id);
    const amendedScheduleTotal = l.instalments.reduce((s, i) => s + i.amountCents, 0);
    for (let n = 2; n <= 4; n++) { advance(14 * 86400000 + 2000); await payment(l, 'auto_settle', n); }
    const collected = l.instalments.filter(i => i.state === 'settled').reduce((s, i) => s + i.amountCents, 0);
    const outstanding = l.principalCents + l.feeCents - collected;
    note({ originalDebtCents: l.principalCents + l.feeCents, amendedScheduleTotal, collectedCents: collected, outstandingCents: outstanding, status: l.status, mandateState: l.mandate.state });
    assert.ok(l.status !== 'closed' || outstanding === 0, 'Loan is closed with $168 still outstanding and no recorded write-off.');
  });
  await test('T12', 'Amendment after a failed payment', 'The amount credited by Brolga must match the amount on the retried payment.', async () => {
    const l = await active();
    await payment(l, 'insufficient_funds');
    await domain.amendMandate(l.id, 10000, { delay: 1 });
    advance(1100);
    await domain.refreshLoan(l.id);
    await domain.retryInstalment(l.id, 1, { delay: 1 });
    advance(1100);
    await domain.refreshLoan(l.id);
    const p = await z.getPaytoPayment(l.instalments[0].paymentUid);
    note({ providerMockSettledAmount: p.amount, appCreditedAmount: l.instalments[0].amountCents, state: p.state });
    assert.equal(l.instalments[0].amountCents, p.amount, 'App books the new schedule amount against the old, larger payment.');
  });
  await test('T13', 'Unknown collection response and later retry', 'A lost response must preserve the original intent and avoid a second payment for the same instalment.', async () => {
    const l = await active();
    const original = z.createPaytoPayment.bind(z);
    const accepted = [];
    z.createPaytoPayment = async (input) => { const p = await original(input); accepted.push(p.uid); throw new ZeptoError({ status: 0, title: 'Network error', detail: 'Synthetic lost response after provider acceptance', path: '/payto/payments' }); };
    await assert.rejects(domain.collect(l.id, 1, { delay: 1 }));
    const uidAfterLoss = l.instalments[0].paymentUid ?? null;
    z.createPaytoPayment = original;
    advance(14 * 86400000 + 2000);
    await payment(l);
    const ledger = await z.listPaytoPayments({ agreement_uid: l.mandate.uid });
    note({ uidSavedAfterLoss: uidAfterLoss, providerPaymentCount: ledger.length, providerUids: ledger.map(p => p.uid), locallyTrackedUid: l.instalments[0].paymentUid, localAttempts: l.instalments[0].attempts });
    assert.equal(ledger.length, 1, 'Lost response led to a second payment for the same instalment after the period restriction elapsed.');
  });
  await test('T14', 'Unknown disbursement retry after a return', 'A retry after a lost response must reuse the accepted retry intent.', async () => {
    const l = loan();
    await domain.disburse(l.id, { forceFailure: 'de_account_not_found' });
    advance(9500);
    await domain.refreshLoan(l.id);
    const original = z.createPayment.bind(z);
    const inputs = [];
    z.createPayment = async (input) => { inputs.push(input); await original(input); throw new ZeptoError({ status: 0, title: 'Network error', detail: 'Synthetic lost retry response', path: '/payments' }); };
    await assert.rejects(domain.disburse(l.id));
    advance(1000);
    z.createPayment = async (input) => { inputs.push(input); return original(input); };
    await domain.disburse(l.id);
    note({ retryKeys: inputs.map(i => i.idempotency_key), distinctRetryIntents: new Set(inputs.map(i => i.idempotency_key)).size });
    assert.equal(inputs[0].idempotency_key, inputs[1].idempotency_key, 'Retry after unknown acceptance minted a different idempotency key.');
  });
  await test('T15', 'Delayed payout reversal remains tracked', 'A reversal arriving after the returned credit must attach to the failed loan.', async () => {
    const l = loan();
    await domain.disburse(l.id, { forceFailure: 'de_account_not_found' });
    advance(9500);
    await domain.refreshLoan(l.id);
    advance(4000);
    await domain.refreshLoan(l.id);
    const rows = await z.transactions({ parent_ref: l.disbursement.paymentRef, both_parties: 'true' });
    const reversal = rows.find(t => t.category === 'payout_reversal');
    note({ reversalExistsInProviderMock: !!reversal, localReversalRef: l.disbursement.reversalRef ?? null, inFlight: domain.hasInFlight(l) });
    assert.equal(l.disbursement.reversalRef, reversal.ref, 'Loan refresh stops checking before the delayed reversal arrives.');
  });
  await test('T16', 'Overview polling advances pending loans', 'Polling the overview loan route after settlement should provide fresh status.', async () => {
    const l = loan();
    await domain.disburse(l.id);
    advance(15000);
    const before = db.loadDb().counters.apilog;
    const r = await routes.loans.GET();
    const body = await r.json();
    const returnedStatus = body.loans[0].status;
    const extraCalls = db.loadDb().counters.apilog - before;
    await domain.refreshLoan(l.id);
    note({ overviewStatus: returnedStatus, statusAfterDetailRefresh: l.status, providerCallsByOverview: extraCalls });
    assert.equal(returnedStatus, 'disbursed', 'Overview polls the local store but never advances the pending provider state.');
  });
  await test('T17', 'Operations includes returned borrower credits', 'The payout ledger should show the recipient-side return described in the briefing.', async () => {
    const l = loan();
    await domain.disburse(l.id, { forceFailure: 'de_account_not_found' });
    advance(14000);
    const r = await routes.transactions.GET();
    const body = await r.json();
    note({ operationsRows: body.transactions.map(t => ({ type: t.type, category: t.category, status: t.status })) });
    assert.ok(body.transactions.some(t => t.type === 'credit' && t.category === 'payout' && t.status === 'returned'), 'Operations omits the borrower-side credit by not requesting both_parties=true.');
  });
  for (const [id, label, data] of [
    ['T18', 'Non-numeric principal validation', { borrowerId: 'BRW-0001', principalCents: 'invalid', termFortnights: 4 }],
    ['T19', 'Missing loan term validation', { borrowerId: 'BRW-0001', principalCents: 60000 }],
    ['T20', 'Fractional loan term validation', { borrowerId: 'BRW-0001', principalCents: 60000, termFortnights: 1.5 }],
  ]) {
    await test(id, label, 'Invalid monetary or term input must return 4xx without creating a loan.', async () => {
      const r = await routes.loans.POST(request('/api/loans', data));
      const body = await r.json();
      note({ httpStatus: r.status, loanCount: db.loadDb().loans.length, principalCents: body.principalCents, term: body.termFortnights, instalmentCount: body.instalments?.length });
      assert.ok(r.status >= 400, 'Invalid input created a loan.');
    });
  }
  await test('T21', 'Same-amount amendment resolves', 'An accepted unchanged amount must not leave the loan stuck in pending amendment.', async () => {
    const l = await active();
    await domain.amendMandate(l.id, l.mandate.instalmentCents, { delay: 1 });
    advance(22000);
    await domain.refreshLoan(l.id);
    const history = await z.agreementHistory(l.mandate.uid);
    note({ providerHistory: history.map(h => h.type), stillPending: !!l.mandate.pendingAmendment, inFlight: domain.hasInFlight(l) });
    assert.equal(l.mandate.pendingAmendment, null, 'Accepted same-amount amendment remains pending indefinitely.');
  });
  await test('T22', 'Reissued mandate does not leave a sticky cancelled loan', 'A live replacement mandate should not coexist with an irreversibly cancelled loan state.', async () => {
    const l = await active();
    await domain.cancelMandate(l.id, 'contract_expired', 'Synthetic cancellation with debt outstanding');
    advance(1000);
    await domain.createMandate(l.id, { delay: 1 });
    advance(1100);
    await domain.refreshLoan(l.id);
    const n = domain.nextCollectable(l);
    note({ loanStatus: l.status, mandateState: l.mandate.state, repaymentOffered: !!n.instalment && !n.reason, debtCents: l.principalCents + l.feeCents });
    assert.notEqual(l.status, 'cancelled', 'Loan remains cancelled while its replacement mandate offers collection.');
  });
  await test('T23', 'Health probe treats authentication failure as unavailable', 'A 401 must not display a green capability result.', async () => {
    z.listPaytoPayments = async () => { throw new ZeptoError({ status: 401, title: 'Unauthorized', detail: 'Synthetic probe denial' }); };
    const r = await routes.health.GET(request('/api/health'));
    const body = await r.json();
    const probe = body.probes.find(p => p.name === 'PayTo agreements');
    note({ probe });
    assert.equal(probe.ok, false, 'Health displays an unauthorized request as an available capability.');
  });
  await test('T24', 'CoP no-match is not verified and cannot be paid without a recorded override', 'Product decision (12 Sep 2026): a no-match borrower yields a draft loan on hold; disbursement is refused until a named override with a reason is recorded, and the override is written to the timeline.', async () => {
    await domain.verifyBorrower('BRW-0001', 'individual_no_match');
    const l = loan();
    const initialStatus = l.status;
    await assert.rejects(domain.disburse(l.id), /refused/);
    await assert.rejects(domain.recordCopOverride(l.id, 'reviewer', 'short'), /reason/);
    await domain.recordCopOverride(l.id, 'reviewer', 'Synthetic override: borrower provided a bank statement in person');
    await domain.disburse(l.id);
    note({ cop: db.getBorrower('BRW-0001').cop.result, initialLoanStatus: initialStatus, copHold: l.copHold, overrideRecorded: !!l.copOverride, payoutAfterOverride: !!l.disbursement, overrideEvent: l.events.some(e => e.type === 'loan.cop_override') });
    assert.notEqual(initialStatus, 'verified');
    assert.ok(l.disbursement, 'Override did not permit disbursement.');
  });
  await test('T25', 'Generic CoP 403 does not invent enablement cause', 'An unexplained 403 should preserve uncertainty about its cause.', async () => {
    z.validateAccount = async () => { throw new ZeptoError({ status: 403, title: 'Forbidden', detail: 'Synthetic unrelated account policy denial' }); };
    const b = await domain.verifyBorrower('BRW-0001');
    note({ userFacingError: b.cop.error });
    assert.ok(!b.cop.error.includes('not enabled'), 'A generic 403 was converted into a definite product-enablement diagnosis.');
  });
  await test('T26', 'Authorization header is omitted from normal logs', 'The normal authorization token is sent only to the stub and absent from app logs.', async () => {
    const sentinel = 'SYNTHETIC_REVIEW_TOKEN_NO_AUTHORITY';
    let authorization;
    globalThis.fetch = async (_url, init) => { authorization = init.headers.Authorization; return Response.json({ data: { first_name: 'Synthetic' } }); };
    const c = new ZeptoClient({ token: sentinel, baseUrl: 'https://review.invalid' });
    await c.user();
    assert.equal(authorization, 'Bearer ' + sentinel);
    const payload = JSON.stringify(await (await routes.console.GET(request('/api/console'))).json());
    note({ authorizationReachedStub: true, tokenInConsole: payload.includes(sentinel) });
    assert.ok(!payload.includes(sentinel));
  });
  await test('T27', 'Payload log sanitization', 'Sensitive values in a provider response must be sanitized before appearing in the console.', async () => {
    const sentinel = 'SYNTHETIC_RESPONSE_SECRET_NOT_A_REAL_TOKEN';
    globalThis.fetch = async () => Response.json({ data: { token: sentinel, account_number: '999990001', name: 'Synthetic Person' } });
    const c = new ZeptoClient({ token: 'dummy', baseUrl: 'https://review.invalid' });
    await c.user();
    const payload = JSON.stringify(await (await routes.console.GET(request('/api/console'))).json());
    note({ syntheticSecretInConsole: payload.includes(sentinel), syntheticAccountInConsole: payload.includes('999990001'), realCredentialUsed: false });
    assert.ok(!payload.includes(sentinel), 'Response snippets are copied into the console without secret-value sanitization.');
  });
  await test('T28', 'Client maps payout idempotency and API version', 'The client uses the correct configured headers and removes the internal idempotency field from the JSON body.', async () => {
    let sent;
    globalThis.fetch = async (url, init) => { sent = { url, ...init }; return Response.json({ data: { ref: 'PB.synthetic', payouts: [] } }, { status: 201 }); };
    const c = new ZeptoClient({ token: 'dummy', baseUrl: 'https://review.invalid', apiVersion: '20260101' });
    await c.createPayment({ idempotency_key: 'synthetic-key', payouts: [], channels: ['direct_entry'], matures_at: new Date().toISOString() });
    assert.equal(sent.headers['Idempotency-Key'], 'synthetic-key');
    assert.equal(sent.headers['Zepto-Api-Version'], '20260101');
    assert.equal(JSON.parse(sent.body).idempotency_key, undefined);
    note({ headersCorrect: true, idempotencyFieldRemovedFromBody: true });
  });
  await test('T29', 'Client normalizes legacy and structured errors', 'Both supplied error formats and the supported scope-header pattern preserve useful diagnostics.', async () => {
    const c = new ZeptoClient({ token: 'dummy', baseUrl: 'https://review.invalid' });
    globalThis.fetch = async () => Response.json({ errors: 'Synthetic legacy error' }, { status: 422 });
    await assert.rejects(c.user(), e => e.detail === 'Synthetic legacy error' && e.status === 422);
    globalThis.fetch = async () => Response.json({ errors: [{ code: 'SYNTHETIC', title: 'Rejected', detail: 'Synthetic structured error' }] }, { status: 422, headers: { 'x-request-id': 'synthetic-request-id' } });
    await assert.rejects(c.user(), e => e.code === 'SYNTHETIC' && e.requestId === 'synthetic-request-id');
    globalThis.fetch = async () => new Response(null, { status: 403, headers: { 'www-authenticate': 'Bearer error="insufficient_scope", error_description="requires scope _contacts_"' } });
    await assert.rejects(c.user(), e => e.requiredScope === 'contacts');
    note({ errorFormats: ['legacy string', 'structured array', 'supported scope header'] });
  });
  await test('T30', 'Mock state survives a process restart', 'A saved mock loan should remain refreshable after starting a fresh process.', async () => {
    const l = await active();
    const output = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(evidenceDir, 'restart-probe.mjs'), root, stateDir, l.id], { encoding: 'utf8', timeout: 10000, env: { ...process.env, ZEPTO_MODE: 'mock' } });
    const observation = JSON.parse(output);
    note(observation);
    assert.equal(observation.refreshed, true, 'Saved local loan exists but the in-memory mock provider has forgotten its agreement.');
  });
  await test('T31', 'Corrupt store is preserved for recovery', 'An unreadable store must not be silently overwritten with an empty one.', async () => {
    const corruptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brolga-corrupt-test-'));
    try {
      fs.mkdirSync(path.join(corruptDir, 'data'));
      fs.writeFileSync(path.join(corruptDir, 'data/brolga.json'), '{"loans":[{"id":"SYNTHETIC-IN-FLIGHT"}');
      const output = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(evidenceDir, 'restart-probe.mjs'), root, corruptDir, 'corruption'], { encoding: 'utf8', timeout: 10000, env: { ...process.env, ZEPTO_MODE: 'mock' } });
      const observation = JSON.parse(output);
      note(observation);
      assert.equal(observation.originalFilePreserved, true, 'Unreadable data file was replaced with an empty seeded database.');
    } finally { fs.rmSync(corruptDir, { recursive: true, force: true }); }
  });
  await test('T32', 'Mock implements payout idempotency', 'Replaying an identical payout key must not create another batch; a recoverable conflict may identify the original.', async () => {
    const l = loan();
    await domain.disburse(l.id);
    const input = db.loadDb().apilog.find(e => e.method === 'POST' && e.path === '/payments').requestBody;
    let replay, conflict;
    try { replay = await z.createPayment(input); } catch (e) { conflict = e; }
    note({ firstBatch: l.disbursement.paymentRef, replayBatch: replay?.ref, conflictStatus: conflict?.status, sameKey: input.idempotency_key });
    assert.ok(replay?.ref === l.disbursement.paymentRef || (conflict?.status === 409 && JSON.stringify(conflict).includes(l.disbursement.paymentRef)), 'Mock created a second payout for an identical idempotency key.');
  });
  await test('T33', 'Rejected amendment leaves original schedule', 'A declined amendment clears pending state and keeps original amounts.', async () => {
    const l = await active();
    await domain.amendMandate(l.id, 10000, { simulate: 'debtor_decline', delay: 1 });
    advance(22000);
    await domain.refreshLoan(l.id);
    assert.equal(l.mandate.pendingAmendment, null);
    assert.equal(l.mandate.instalmentCents, 15600);
    note({ pending: false, instalmentCents: l.mandate.instalmentCents });
  });
  await test('T34', 'Collection under investigation is not settled', 'Unresolved investigation remains in flight and is not booked as money received.', async () => {
    const l = await active();
    await payment(l, 'requires_investigation');
    const credited = l.instalments.filter(i => i.state === 'settled').reduce((s, i) => s + i.amountCents, 0);
    note({ state: l.instalments[0].state, inFlight: domain.hasInFlight(l), creditedCents: credited });
    assert.equal(l.instalments[0].state, 'under_investigation');
    assert.equal(credited, 0);
    assert.equal(domain.hasInFlight(l), true);
  });
  await test('T35', 'Collection does not switch silently out of mock mode', 'All domain tests use mock mode with no token and no attempted fetch.', async () => {
    note({ configuredMode: configuredMode(), tokenPresent: !!process.env.ZEPTO_TOKEN, blockedNetworkAttempts: blockedNetworkAttempts() });
    assert.equal(configuredMode(), 'mock');
    assert.equal(process.env.ZEPTO_TOKEN, undefined);
    assert.equal(blockedNetworkAttempts(), 0);
  });
  await test('T36', 'Idempotency conflict preserves recovery reference', 'The documented 409 meta.resource_ref must remain available for recovering an already-created payment.', async () => {
    const ref = 'PB.synthetic-existing';
    globalThis.fetch = async () => Response.json({ errors: 'Synthetic idempotency conflict', meta: { resource_ref: ref } }, { status: 409 });
    const c = new ZeptoClient({ token: 'dummy', baseUrl: 'https://review.invalid' });
    let error;
    try { await c.createPayment({ idempotency_key: 'synthetic-key', payouts: [], channels: ['direct_entry'] }); } catch (e) { error = e; }
    note({ errorStatus: error?.status, recoveryReferencePreserved: JSON.stringify(error).includes(ref), referenceOnlyInRawLogSnippet: db.loadDb().apilog.some(e => e.responseSnippet?.includes(ref)) });
    assert.ok(JSON.stringify(error).includes(ref), 'The normalized error discards meta.resource_ref; the domain has no automatic conflict recovery.');
  });
  await test('T37', 'Restructure keeps the schedule equal to the obligation', 'After a settled instalment and a lower requested amount, remaining instalments plus settled money equal the recorded obligation, and the loan only closes when everything is settled.', async () => {
    const l = await active();
    await payment(l);
    await domain.amendMandate(l.id, 10000, { delay: 1 });
    advance(1100);
    await domain.refreshLoan(l.id);
    const scheduleTotal = l.instalments.reduce((s, i) => s + i.amountCents, 0);
    const obligation = domain.obligationCents(l);
    note({ obligation, scheduleTotal, instalments: l.instalments.map(i => [i.n, i.amountCents, i.state]), mandateAmount: l.mandate.instalmentCents, lastPaymentDate: l.mandate.lastPaymentDate });
    assert.equal(scheduleTotal, obligation, 'Schedule does not add up to the obligation after restructure.');
    for (let n = 2; n <= l.instalments.length; n++) { advance(14 * 86400000 + 2000); await payment(l, 'auto_settle', n); }
    note({ finalStatus: l.status, outstanding: domain.outstandingCents(l) });
    assert.equal(domain.outstandingCents(l), 0);
    assert.equal(l.status, 'closed');
  });
  await test('T38', 'Restructure rounding is recorded as an adjustment', 'When the remaining debt does not divide evenly, the cents of rounding are written as an adjustment rather than silently added or forgiven.', async () => {
    const l = loan(60000, 4);
    await domain.disburse(l.id); advance(15000); await domain.refreshLoan(l.id);
    await domain.createMandate(l.id, { delay: 1 }); advance(1100); await domain.refreshLoan(l.id);
    await payment(l);
    await domain.amendMandate(l.id, 10001, { delay: 1 });
    advance(1100);
    await domain.refreshLoan(l.id);
    const adj = (l.adjustments ?? []).find(a => a.type === 'rounding');
    note({ remaining: l.mandate.instalmentCents * (l.instalments.length - 1), adjustment: adj, obligation: domain.obligationCents(l), scheduleTotal: l.instalments.reduce((s, i) => s + i.amountCents, 0) });
    assert.equal(l.instalments.reduce((s, i) => s + i.amountCents, 0), domain.obligationCents(l));
    assert.ok(!adj || adj.cents < l.instalments.length, 'Rounding adjustment larger than one cent per instalment.');
  });
  await test('T39', 'Lost disbursement response is recovered through the idempotency conflict', 'A retry after a lost answer replays the same key, receives 409 with the original ref, and adopts it instead of paying twice.', async () => {
    const l = loan();
    const original = z.createPayment.bind(z);
    z.createPayment = async (input) => { await original(input); throw new ZeptoError({ status: 0, title: 'Network error', detail: 'Synthetic lost response', path: '/payments' }); };
    await assert.rejects(domain.disburse(l.id));
    assert.equal(l.disbursementIntent?.outcome, 'unknown');
    z.createPayment = original;
    await domain.disburse(l.id);
    const batches = (await z.transactions({})).filter(t => t.type === 'debit').length;
    note({ paymentRef: l.disbursement?.paymentRef, batchesInProvider: batches, recovered: l.events.some(e => e.type === 'disbursement.recovered'), intentCleared: l.disbursementIntent == null });
    assert.equal(batches, 1, 'Two payouts exist for one loan.');
    assert.ok(l.disbursement?.paymentRef);
  });
  await test('T40', 'Mock enforces the sandbox daily PayTo limit', 'A collection that would exceed $1,000 in a day is refused with ZPPAY01, as the sandbox does.', async () => {
    const l = loan(200000, 2);
    await domain.disburse(l.id); advance(15000); await domain.refreshLoan(l.id);
    await domain.createMandate(l.id, { delay: 1 }); advance(1100); await domain.refreshLoan(l.id);
    let err;
    try { await domain.collect(l.id, 1, { delay: 1 }); } catch (e) { err = e; }
    note({ instalmentCents: l.instalmentCents, code: err?.code, state: l.instalments[0].state, paymentUid: l.instalments[0].paymentUid ?? null });
    assert.equal(err?.code, 'ZPPAY01');
    assert.equal(l.instalments[0].state, 'scheduled', 'A definite rejection must reopen the instalment.');
  });
  await test('T41', 'Console masks account identifiers as well as secrets', 'Account numbers in logged payloads are masked to their last three digits.', async () => {
    globalThis.fetch = async () => Response.json({ data: { token: 'SYNTHETIC_SECRET_X', account_number: '999990001', bban: '062000-999990001' } });
    const c = new ZeptoClient({ token: 'dummy', baseUrl: 'https://review.invalid' });
    await c.user();
    const payload = JSON.stringify(await (await routes.console.GET(request('/api/console'))).json());
    note({ secretPresent: payload.includes('SYNTHETIC_SECRET_X'), fullAccountPresent: payload.includes('999990001'), maskedPresent: payload.includes('001') });
    assert.ok(!payload.includes('SYNTHETIC_SECRET_X'));
    assert.ok(!payload.includes('999990001'));
  });
  await test('T42', 'An unreadable active store is preserved and writes are refused', 'The active mode store is never overwritten when it cannot be parsed; the app reports it and refuses to write.', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brolga-corrupt-active-'));
    try {
      fs.mkdirSync(path.join(dir, 'data'));
      const file = path.join(dir, 'data/brolga.mock.json');
      fs.writeFileSync(file, '{"loans":[{"id":"SYNTHETIC"}');
      const before = fs.readFileSync(file, 'utf8');
      const output = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(evidenceDir, 'store-probe.mjs'), root, dir], { encoding: 'utf8', timeout: 10000, env: { ...process.env, ZEPTO_MODE: 'mock' } });
      const o = JSON.parse(output);
      note({ ...o, filePreserved: before === fs.readFileSync(file, 'utf8') });
      assert.equal(o.readable, false);
      assert.equal(o.writeRefused, true);
      assert.equal(before, fs.readFileSync(file, 'utf8'));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await test('T43', 'Collection waits while an amendment is pending', 'No money is pulled while the borrower is deciding on a restructure.', async () => {
    const l = await active();
    await domain.amendMandate(l.id, 10000, { delay: 5 });
    const e = domain.collectionEligibility(l, 1);
    note({ ok: e.ok, reason: e.reason, waiting: e.waiting });
    assert.equal(e.ok, false);
    await assert.rejects(domain.collect(l.id, 1), /amendment/);
  });
  await test('T44', 'Refresh failures surface next to retained data', 'When the provider errors during refresh, the loan route still returns the last known loan and names the error.', async () => {
    const l = await active();
    z.getAgreement = async () => { throw new ZeptoError({ status: 503, title: 'Service unavailable', detail: 'Synthetic outage', path: '/payto/agreements/x' }); };
    const r = await routes.loan.GET(request('/api/loans/' + l.id + '?refresh=1'), params(l.id));
    const body = await r.json();
    note({ httpStatus: r.status, refreshError: body.refreshError, loanReturned: !!body.loan });
    assert.equal(r.status, 200);
    assert.ok(body.loan);
    assert.match(body.refreshError ?? '', /Synthetic outage/);
  });
  await test('T45', 'Cancelled mandate with a balance is not "repaid"', 'Cancelling repayment authority with money owing leaves the loan cancelled, not closed; paying the balance later closes it.', async () => {
    const l = await active();
    await payment(l);
    await domain.cancelMandate(l.id, 'initiating_party_requested', 'Synthetic withdrawal with balance owing');
    note({ status: l.status, outstanding: domain.outstandingCents(l) });
    assert.equal(l.status, 'cancelled');
    assert.ok(domain.outstandingCents(l) > 0);
  });
} finally {
  globalThis.Date = RealDate;
  globalThis.fetch = blockedFetch;
  const report = {
    assessment: 'Brolga offline invariant suite (review harness v2)',
    executedAt: new RealDate().toISOString(),
    runtime: process.version,
    sourceCodeModified: false,
    method: 'Direct calls into original TypeScript domain, mock, client and route modules; fake clock; selected in-memory fault injection; no HTTP server, browser automation, npm installs or Zepto traffic.',
    network: { mode: 'mock', credentialUsed: false, blockedRealFetchAttempts: blockedNetworkAttempts(), clientTests: 'Injected in-memory fetch responses at review.invalid; no requests sent' },
    total: results.length, passed: results.filter(r => r.result === 'PASS').length, failed: results.filter(r => r.result === 'FAIL').length,
    results,
  };
  fs.writeFileSync(resultsFile, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ total: report.total, passed: report.passed, failed: report.failed, blockedNetworkAttempts: report.network.blockedRealFetchAttempts }));
  fs.rmSync(stateDir, { recursive: true, force: true });
}
process.exitCode = results.some(r => r.result === 'FAIL') ? 1 : 0;
