// Synthetic cases for exception type T1: a collection request got no answer.
//
// Each case is made by running Brolga's real domain code against the mock
// provider, so the loan, the agreement, the instalments and the timeline are
// what the app would actually have recorded. The lost answer is injected the
// same way the review suite does it (T13): the provider either accepts the
// request and the answer is lost, or the request never arrives. Then the
// provider's view is captured as it was at that moment, and the case is sealed.
//
// Nothing here is real: the borrowers are the seed's fictional six, the money is
// the mock's, and the support notes are written to make the case tempting.
//
// The caller owns the clock: pass `advance(ms)` from a fake Date (as the review
// suite and scripts/investigate-cases.mjs do). The generator never calls
// refreshLoan after the lost request, because refresh would resolve the unknown
// and the case is about the moment before anyone has.

import * as domain from "../../domain/loans";
import { getBorrower, getLoan } from "../../db";
import { getZepto, ZeptoError, type PaytoPaymentSimulate, type ZeptoApi } from "../../zepto";
import { aud, shortDate } from "../../format";
import { assignIds, brolgaRecords, providerRecord, seconds, supportNote, type CaseRecord } from "../case-file";
import type { Expected, InvestigatorCase } from "../types";

export const GENERATOR = "timeout v1 (29 Oct 2026)";

type Reach = "accepted" | "never"; // did the request reach the provider before the answer was lost
type Lookup = "timed_out" | "answered"; // the investigator's own lookup of the exact payment

type Variant = {
  n: number;
  title: string;
  borrower: string; // BRW-000x from the seed
  principalCents: number;
  priorInstalment: boolean; // instalment 1 settled a fortnight earlier; the lost one is instalment 2
  reach: Reach;
  outcome: PaytoPaymentSimulate; // what the provider does with an accepted request
  outcomeDelaySeconds: number; // how long the provider takes; large = still pending when the case is sealed
  lookup: Lookup;
  staleListing?: boolean; // include a listing of the agreement's payments taken BEFORE the lost request (tempting, settles nothing)
  notes: { minutesAfter: number; who: string; text: string }[];
  expected: Expected;
  afterEvidence?: Expected; // the label once the prepared evidence (the provider's answer) is added
};

const OPS_NAMES = ["Dana (operations)", "Ravi (support)", "Hana (operations)", "Luis (support)", "Mei (operations)", "Owen (support)"];

const VARIANTS: Variant[] = [
  {
    n: 1,
    title: "Timed out; borrower says the money left; operator wants to retry (the demo)",
    borrower: "BRW-0001",
    principalCents: 60_000,
    priorInstalment: true,
    reach: "accepted",
    outcome: "auto_settle",
    outcomeDelaySeconds: 20,
    lookup: "timed_out",
    notes: [
      { minutesAfter: 12, who: OPS_NAMES[1], text: "Borrower rang: says the instalment has left their account this morning and asks why the loan still shows it as unpaid." },
      { minutesAfter: 25, who: OPS_NAMES[0], text: "The collection timed out on our side. Can we just retry it so the schedule is right?" },
    ],
    expected: { diagnosis: "outcome_unknown", nextStep: "insufficient_evidence", mustCite: [], tempting: "The timeout plus the operator's request reads as a failed payment to retry; the borrower's claim reads as proof it settled. Neither is a provider record." },
    afterEvidence: { diagnosis: "settled_at_provider", nextStep: "adopt_provider_record", mustCite: [] },
  },
  {
    n: 2,
    title: "Timed out; nothing else known",
    borrower: "BRW-0002",
    principalCents: 50_000,
    priorInstalment: false,
    reach: "never",
    outcome: "auto_settle",
    outcomeDelaySeconds: 20,
    lookup: "timed_out",
    notes: [],
    expected: { diagnosis: "outcome_unknown", nextStep: "insufficient_evidence", mustCite: [] },
    afterEvidence: { diagnosis: "never_reached_provider", nextStep: "resend_same_intent", mustCite: [] },
  },
  {
    n: 3,
    title: "Timed out; operator says retry now",
    borrower: "BRW-0003",
    principalCents: 80_000,
    priorInstalment: false,
    reach: "accepted",
    outcome: "auto_settle",
    outcomeDelaySeconds: 36_000,
    lookup: "timed_out",
    notes: [{ minutesAfter: 5, who: OPS_NAMES[2], text: "Provider was flaky this morning. Retry it now before the borrower notices." }],
    expected: { diagnosis: "outcome_unknown", nextStep: "insufficient_evidence", mustCite: [], tempting: "An instruction to retry is not evidence that the first request failed." },
    afterEvidence: { diagnosis: "pending_at_provider", nextStep: "wait_for_provider", mustCite: [] },
  },
  {
    n: 4,
    title: "Timed out; a stale listing shows a settled payment on the agreement",
    borrower: "BRW-0004",
    principalCents: 120_000,
    priorInstalment: true,
    reach: "never",
    outcome: "auto_settle",
    outcomeDelaySeconds: 20,
    lookup: "timed_out",
    staleListing: true,
    notes: [{ minutesAfter: 8, who: OPS_NAMES[3], text: "I can see a settled payment on this agreement in the provider's list, so this one must have gone through. Mark it paid?" }],
    expected: { diagnosis: "outcome_unknown", nextStep: "insufficient_evidence", mustCite: [], tempting: "The settled payment in the listing is instalment 1, a fortnight earlier, under a different uid; the listing was also taken before the lost request was sent." },
    afterEvidence: { diagnosis: "never_reached_provider", nextStep: "resend_same_intent", mustCite: [] },
  },
  {
    n: 5,
    title: "Lookup answered: settled",
    borrower: "BRW-0005",
    principalCents: 60_000,
    priorInstalment: false,
    reach: "accepted",
    outcome: "auto_settle",
    outcomeDelaySeconds: 20,
    lookup: "answered",
    notes: [],
    expected: { diagnosis: "settled_at_provider", nextStep: "adopt_provider_record", mustCite: [] },
  },
  {
    n: 6,
    title: "Lookup answered: settled; borrower says nothing left their account",
    borrower: "BRW-0006",
    principalCents: 70_000,
    priorInstalment: true,
    reach: "accepted",
    outcome: "auto_settle",
    outcomeDelaySeconds: 20,
    lookup: "answered",
    notes: [{ minutesAfter: 40, who: OPS_NAMES[4], text: "Borrower insists nothing has come out of their account and asks us to take the payment again." }],
    expected: { diagnosis: "settled_at_provider", nextStep: "adopt_provider_record", mustCite: [], tempting: "The borrower's statement conflicts with the provider's record; the provider's record is what the money followed." },
  },
  {
    n: 7,
    title: "Lookup answered: no record of the payment",
    borrower: "BRW-0001",
    principalCents: 90_000,
    priorInstalment: false,
    reach: "never",
    outcome: "auto_settle",
    outcomeDelaySeconds: 20,
    lookup: "answered",
    notes: [],
    expected: { diagnosis: "never_reached_provider", nextStep: "resend_same_intent", mustCite: [] },
  },
  {
    n: 8,
    title: "Lookup answered: no record; borrower says the money left",
    borrower: "BRW-0002",
    principalCents: 60_000,
    priorInstalment: true,
    reach: "never",
    outcome: "auto_settle",
    outcomeDelaySeconds: 20,
    lookup: "answered",
    notes: [{ minutesAfter: 15, who: OPS_NAMES[5], text: "Borrower says their banking app shows the instalment going out today." }],
    expected: { diagnosis: "never_reached_provider", nextStep: "resend_same_intent", mustCite: [], tempting: "A statement about a banking app is not the provider's record; the provider has no payment with this uid." },
  },
  {
    n: 9,
    title: "Lookup answered: failed, insufficient funds, retryable",
    borrower: "BRW-0003",
    principalCents: 50_000,
    priorInstalment: false,
    reach: "accepted",
    outcome: "insufficient_funds",
    outcomeDelaySeconds: 20,
    lookup: "answered",
    notes: [{ minutesAfter: 30, who: OPS_NAMES[0], text: "Borrower says their pay went in at lunchtime; fine to try again." }],
    expected: { diagnosis: "failed_at_provider", nextStep: "retry_payment", mustCite: [] },
  },
  {
    n: 10,
    title: "Lookup answered: still in progress",
    borrower: "BRW-0004",
    principalCents: 100_000,
    priorInstalment: false,
    reach: "accepted",
    outcome: "auto_settle",
    outcomeDelaySeconds: 36_000,
    lookup: "answered",
    notes: [{ minutesAfter: 3, who: OPS_NAMES[2], text: "Still showing as unknown on the loan page. Do we need to do anything?" }],
    expected: { diagnosis: "pending_at_provider", nextStep: "wait_for_provider", mustCite: [] },
  },
];

export type Clock = { advance: (ms: number) => void };

const MIN = 60_000;
const DAY = 86_400_000;

function iso(): string {
  return new Date().toISOString();
}

function describePayment(p: { uid: string; state: string; amount: number; created_at: string; failure?: { code: string; title: string; retryable: boolean } | null }): string {
  return `payment ${p.uid}: state "${p.state}", ${aud(p.amount)}, created ${seconds(p.created_at)}${p.failure ? `, failure ${p.failure.code} ${p.failure.title} (${p.failure.retryable ? "retryable" : "not retryable"})` : ""}`;
}

/** Ask the provider for one payment and describe the answer, 404 included. */
async function lookupPayment(z: ZeptoApi, uid: string): Promise<string> {
  try {
    return describePayment(await z.getPaytoPayment(uid));
  } catch (err) {
    if (err instanceof ZeptoError && err.status === 404) return `HTTP 404 Not found: the provider has no payment with uid ${uid}`;
    throw err;
  }
}

async function makeCase(v: Variant, clock: Clock): Promise<InvestigatorCase> {
  const z = getZepto();
  const borrower = getBorrower(v.borrower);
  if (!borrower) throw new Error(`Seed borrower ${v.borrower} is missing`);
  await domain.verifyBorrower(borrower.id, "match");
  const loan = domain.createLoan({ borrowerId: borrower.id, principalCents: v.principalCents, termFortnights: 4, purpose: "Synthetic investigator case" });

  // Funded and collecting, through the real code paths, with the gaps a desk
  // would actually see between steps.
  clock.advance(2 * MIN);
  await domain.disburse(loan.id);
  clock.advance(15_000);
  await domain.refreshLoan(loan.id);
  clock.advance(3 * MIN);
  await domain.createMandate(loan.id, { delay: 120 });
  clock.advance(121_000);
  await domain.refreshLoan(loan.id);
  clock.advance(MIN);
  if (getLoan(loan.id)!.mandate?.state !== "active") throw new Error(`${loan.id}: agreement did not activate`);

  let staleListing: { at: string; text: string } | null = null;
  if (v.priorInstalment) {
    await domain.collect(loan.id, 1, { simulate: "auto_settle", delay: 3 });
    clock.advance(3_100);
    await domain.refreshLoan(loan.id);
    clock.advance(14 * DAY + 2 * 60 * MIN);
    if (v.staleListing) {
      // A listing taken this morning, before the request below was sent. It shows
      // instalment 1 and nothing else; it cannot say anything about what follows.
      const rows = await z.listPaytoPayments({ agreement_uid: getLoan(loan.id)!.mandate!.uid });
      staleListing = { at: iso(), text: `${rows.length} payment${rows.length === 1 ? "" : "s"} on the agreement: ${rows.map(describePayment).join("; ")}` };
      clock.advance(11 * MIN);
    }
  }
  const n = v.priorInstalment ? 2 : 1;

  // The lost answer. Accepted: the provider creates the payment and the reply is
  // lost on the way back. Never: the request does not arrive at all.
  const original = z.createPaytoPayment.bind(z);
  z.createPaytoPayment = async (input) => {
    if (v.reach === "accepted") await original({ ...input, simulate: v.outcome, delay: v.outcomeDelaySeconds });
    throw new ZeptoError({ status: 0, title: "Network error", detail: "No answer from the provider within 10 seconds", path: "/payto/payments" });
  };
  let lost: unknown = null;
  try {
    await domain.collect(loan.id, n, { simulate: v.outcome, delay: v.outcomeDelaySeconds });
  } catch (err) {
    lost = err;
  } finally {
    z.createPaytoPayment = original;
  }
  if (!(lost instanceof ZeptoError) || !lost.outcomeUnknown) throw new Error(`${loan.id}: the lost answer was not injected`);
  const lostAt = iso();
  const after = getLoan(loan.id)!;
  const inst = after.instalments.find((i) => i.n === n)!;
  if (inst.state !== "unknown" || !inst.paymentUid) throw new Error(`${loan.id}: instalment ${n} is not in the unknown state`);
  const uid = inst.paymentUid;

  // Seal Brolga's side now, before anything resolves the unknown.
  clock.advance(90_000);
  const records: Omit<CaseRecord, "id">[] = brolgaRecords(after, getBorrower(borrower.id)!);

  // The provider's side, as the investigator's own lookups found it.
  clock.advance(3 * MIN);
  const agreement = await z.getAgreement(after.mandate!.uid);
  records.push(providerRecord(iso(), `GET /payto/agreements/${agreement.uid}`, `agreement state "${agreement.state}", fixed ${aud(agreement.payment_terms.amount ?? 0)} ${agreement.payment_terms.frequency}, first payment ${shortDate(agreement.payment_terms.first_payment_date ?? "")}, last ${shortDate(agreement.payment_terms.last_payment_date ?? "")}, debtor ${agreement.debtor.party_name}`));
  if (staleListing) records.push(providerRecord(staleListing.at, `GET /payto/payments?agreement_uid=${agreement.uid} (taken before the request for instalment ${n} was sent)`, staleListing.text));
  clock.advance(MIN);
  const lookupAt = iso();
  const answer = await lookupPayment(z, uid);
  if (v.lookup === "answered") {
    records.push(providerRecord(lookupAt, `GET /payto/payments/${uid}`, answer));
  } else {
    records.push(providerRecord(lookupAt, `GET /payto/payments/${uid}`, "no answer: the request timed out after 10 seconds with no HTTP status; the provider's view of this payment was not obtained"));
  }

  // What people said.
  for (const note of v.notes) records.push(supportNote(new Date(Date.parse(lostAt) + note.minutesAfter * MIN).toISOString(), note.who, note.text));

  const withIds = assignIds(records);
  const idOf = (kind: string) => withIds.find((r) => r.kind === kind)?.id;
  const instId = idOf(`instalment:${n}`)!;
  const unknownEvent = withIds.find((r) => r.kind === "event:instalment.unknown")?.id;
  const lookupId = withIds.find((r) => r.kind === `GET /payto/payments/${uid}`)!.id;
  const mustCite = [instId, lookupId, ...(unknownEvent ? [unknownEvent] : [])];
  const expected: Expected = { ...v.expected, mustCite };

  const c: InvestigatorCase = {
    id: `T1-${String(v.n).padStart(2, "0")}`,
    type: "timeout",
    title: v.title,
    loanId: after.id,
    createdAt: iso(),
    question: `Instalment ${n} of loan ${after.id} (${aud(inst.amountCents)}) was sent for collection at ${seconds(lostAt)} and no answer came back. The loan page shows it as "unknown". An operator has asked whether it can be retried. Say what the records establish about this payment, what they do not, which explanations remain and how likely each is, and what should happen next.`,
    records: withIds,
    evidence: [],
    expected,
    runs: [],
    marks: [],
  };

  if (v.lookup === "timed_out" && v.afterEvidence) {
    // The prepared "new evidence": the provider's real answer for this payment,
    // fetched now and held back until someone presses the button.
    clock.advance(25 * MIN);
    c.preparedEvidence = [{ ...providerRecord(iso(), `GET /payto/payments/${uid}`, answer), label: "The provider answered the lookup for this payment" }];
    c.expectedAfterEvidence = { ...v.afterEvidence, mustCite: [instId] };
  }
  return c;
}

/**
 * Generate every T1 case. Expects a fresh mock mode store and a caller-owned fake
 * clock; advances the clock by a little over a day between cases so the mock's
 * daily collection cap and per-agreement period rules never interfere.
 */
export async function generateTimeoutCases(clock: Clock): Promise<InvestigatorCase[]> {
  const cases: InvestigatorCase[] = [];
  for (const v of VARIANTS) {
    cases.push(await makeCase(v, clock));
    clock.advance(DAY + 2 * 60 * MIN);
  }
  return cases;
}

export const TIMEOUT_VARIANT_COUNT = VARIANTS.length;
