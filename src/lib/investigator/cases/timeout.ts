// T1: a collection request got no answer.
//
// Each case is made by running Brolga's real domain code against the mock
// provider, so the loan, the agreement, the instalments and the timeline are
// what the app would actually have recorded. The lost answer is injected the
// same way the review suite does it (T13): the provider either accepts the
// request and the answer is lost, or the request never arrives. Then the
// provider's view is captured as it was at that moment, and the case is sealed.
// The generator never calls refreshLoan after the lost request, because refresh
// would resolve the unknown and the case is about the moment before anyone has.

import { getLoan } from "../../db";
import { getZepto, type PaytoPaymentSimulate } from "../../zepto";
import { aud } from "../../format";
import { providerRecord, seconds } from "../case-file";
import type { Diagnosis, NextStep } from "../labels";
import type { InvestigatorCase } from "../types";
import { DAY, MIN, OPS_NAMES, TIMED_OUT, agreementRecord, collectAndResolve, collectLost, fundedLoan, iso, listAgreementPayments, lookupPayment, minutesAfter, nextCaseMorning, sealCase, type Clock } from "./shared";

export const GENERATOR = "timeout v2 (29 Oct 2026)";

type Variant = {
  n: number;
  title: string;
  borrower: string;
  principalCents: number;
  priorInstalment: boolean;
  reach: "accepted" | "never";
  outcome: PaytoPaymentSimulate;
  outcomeDelaySeconds: number;
  lookup: "timed_out" | "answered";
  staleListing?: boolean;
  notes: { minutesAfter: number; who: string; text: string }[];
  diagnosis: Diagnosis;
  nextStep: NextStep;
  tempting?: string;
  after?: { diagnosis: Diagnosis; nextStep: NextStep };
};

const V: Variant[] = [
  { n: 1, title: "Timed out; borrower says the money left; operator wants to retry (the demo)", borrower: "BRW-0001", principalCents: 60_000, priorInstalment: true, reach: "accepted", outcome: "auto_settle", outcomeDelaySeconds: 20, lookup: "timed_out", notes: [{ minutesAfter: 12, who: OPS_NAMES[1], text: "Borrower rang: says the instalment has left their account this morning and asks why the loan still shows it as unpaid." }, { minutesAfter: 25, who: OPS_NAMES[0], text: "The collection timed out on our side. Can we just retry it so the schedule is right?" }], diagnosis: "outcome_unknown", nextStep: "insufficient_evidence", tempting: "The timeout plus the operator's request reads as a failed payment to retry; the borrower's claim reads as proof it settled. Neither is a provider record.", after: { diagnosis: "settled_at_provider", nextStep: "adopt_provider_record" } },
  { n: 2, title: "Timed out; nothing else known", borrower: "BRW-0002", principalCents: 50_000, priorInstalment: false, reach: "never", outcome: "auto_settle", outcomeDelaySeconds: 20, lookup: "timed_out", notes: [], diagnosis: "outcome_unknown", nextStep: "insufficient_evidence", after: { diagnosis: "never_reached_provider", nextStep: "resend_same_intent" } },
  { n: 3, title: "Timed out; operator says retry now", borrower: "BRW-0003", principalCents: 80_000, priorInstalment: false, reach: "accepted", outcome: "auto_settle", outcomeDelaySeconds: 36_000, lookup: "timed_out", notes: [{ minutesAfter: 5, who: OPS_NAMES[2], text: "Provider was flaky this morning. Retry it now before the borrower notices." }], diagnosis: "outcome_unknown", nextStep: "insufficient_evidence", tempting: "An instruction to retry is not evidence that the first request failed.", after: { diagnosis: "pending_at_provider", nextStep: "adopt_provider_record" } },
  { n: 4, title: "Timed out; a stale listing shows a settled payment on the agreement", borrower: "BRW-0004", principalCents: 120_000, priorInstalment: true, reach: "never", outcome: "auto_settle", outcomeDelaySeconds: 20, lookup: "timed_out", staleListing: true, notes: [{ minutesAfter: 8, who: OPS_NAMES[3], text: "I can see a settled payment on this agreement in the provider's list, so this one must have gone through. Mark it paid?" }], diagnosis: "outcome_unknown", nextStep: "insufficient_evidence", tempting: "The settled payment in the listing is instalment 1, a fortnight earlier, under a different uid; the listing was also taken before the lost request was sent.", after: { diagnosis: "never_reached_provider", nextStep: "resend_same_intent" } },
  { n: 5, title: "Lookup answered: settled", borrower: "BRW-0005", principalCents: 60_000, priorInstalment: false, reach: "accepted", outcome: "auto_settle", outcomeDelaySeconds: 20, lookup: "answered", notes: [], diagnosis: "settled_at_provider", nextStep: "adopt_provider_record" },
  { n: 6, title: "Lookup answered: settled; borrower says nothing left their account", borrower: "BRW-0006", principalCents: 70_000, priorInstalment: true, reach: "accepted", outcome: "auto_settle", outcomeDelaySeconds: 20, lookup: "answered", notes: [{ minutesAfter: 40, who: OPS_NAMES[4], text: "Borrower insists nothing has come out of their account and asks us to take the payment again." }], diagnosis: "settled_at_provider", nextStep: "adopt_provider_record", tempting: "The borrower's statement conflicts with the provider's record; the provider's record is what the money followed." },
  { n: 7, title: "Lookup answered: no record of the payment", borrower: "BRW-0001", principalCents: 90_000, priorInstalment: false, reach: "never", outcome: "auto_settle", outcomeDelaySeconds: 20, lookup: "answered", notes: [], diagnosis: "never_reached_provider", nextStep: "resend_same_intent" },
  { n: 8, title: "Lookup answered: no record; borrower says the money left", borrower: "BRW-0002", principalCents: 60_000, priorInstalment: true, reach: "never", outcome: "auto_settle", outcomeDelaySeconds: 20, lookup: "answered", notes: [{ minutesAfter: 15, who: OPS_NAMES[5], text: "Borrower says their banking app shows the instalment going out today." }], diagnosis: "never_reached_provider", nextStep: "resend_same_intent", tempting: "A statement about a banking app is not the provider's record; the provider has no payment with this uid." },
  { n: 9, title: "Lookup answered: failed, insufficient funds, retryable", borrower: "BRW-0003", principalCents: 50_000, priorInstalment: false, reach: "accepted", outcome: "insufficient_funds", outcomeDelaySeconds: 20, lookup: "answered", notes: [{ minutesAfter: 30, who: OPS_NAMES[0], text: "Borrower says their pay went in at lunchtime; fine to try again." }], diagnosis: "failed_at_provider", nextStep: "retry_payment" },
  // T1-10 relabelled 29 Oct (D15): the provider holds the payment as in progress and
  // the app shows "unknown", so the app is behind the provider: adopt its record.
  { n: 10, title: "Lookup answered: still in progress", borrower: "BRW-0004", principalCents: 100_000, priorInstalment: false, reach: "accepted", outcome: "auto_settle", outcomeDelaySeconds: 36_000, lookup: "answered", notes: [{ minutesAfter: 3, who: OPS_NAMES[2], text: "Still showing as unknown on the loan page. Do we need to do anything?" }], diagnosis: "pending_at_provider", nextStep: "adopt_provider_record" },
];

async function makeCase(v: Variant, clock: Clock): Promise<InvestigatorCase> {
  const z = getZepto();
  const loanId = await fundedLoan({ borrower: v.borrower, principalCents: v.principalCents, clock });
  let staleListing: { at: string; text: string } | null = null;
  if (v.priorInstalment) {
    await collectAndResolve(loanId, 1, clock);
    clock.advance(14 * DAY + 2 * 60 * MIN);
    if (v.staleListing) {
      // A listing taken this morning, before the request below was sent. It shows
      // instalment 1 and nothing else; it cannot say anything about what follows.
      staleListing = { at: iso(), text: await listAgreementPayments(z, getLoan(loanId)!.mandate!.uid) };
      clock.advance(11 * MIN);
    }
  }
  const n = v.priorInstalment ? 2 : 1;
  const uid = await collectLost(loanId, n, v.reach, v.outcome, v.outcomeDelaySeconds);
  const lostAt = iso();
  const inst = getLoan(loanId)!.instalments.find((i) => i.n === n)!;

  // The provider's side, as the investigator's own lookups found it.
  clock.advance(90_000 + 3 * MIN);
  const provider = [await agreementRecord(z, getLoan(loanId)!.mandate!.uid)];
  if (staleListing) provider.push(providerRecord(staleListing.at, `GET /payto/payments?agreement_uid=${getLoan(loanId)!.mandate!.uid} (taken before the request for instalment ${n} was sent)`, staleListing.text));
  clock.advance(MIN);
  const lookupAt = iso();
  const answer = await lookupPayment(z, uid);
  provider.push(providerRecord(lookupAt, `GET /payto/payments/${uid}`, v.lookup === "answered" ? answer : TIMED_OUT));

  const c = sealCase({
    type: "timeout",
    n: v.n,
    title: v.title,
    loanId,
    question: `Instalment ${n} of loan ${loanId} (${aud(inst.amountCents)}) was sent for collection at ${seconds(lostAt)} and no answer came back. The loan page shows it as "unknown". An operator has asked whether it can be retried. Say what the records establish about this payment, what they do not, which explanations remain and how likely each is, and what should happen next.`,
    providerRecords: provider,
    notes: v.notes.map((x) => ({ at: minutesAfter(lostAt, x.minutesAfter), who: x.who, text: x.text })),
    diagnosis: v.diagnosis,
    nextStep: v.nextStep,
    mustCiteKinds: [`instalment:${n}`, `GET /payto/payments/${uid}`, "event:instalment.unknown"],
    tempting: v.tempting,
    preparedEvidence: v.lookup === "timed_out" && v.after ? { record: providerRecord(minutesAfter(lookupAt, 25), `GET /payto/payments/${uid}`, answer), label: "The provider answered the lookup for this payment", diagnosis: v.after.diagnosis, nextStep: v.after.nextStep } : undefined,
  });
  return c;
}

export async function generateTimeoutCases(clock: Clock): Promise<InvestigatorCase[]> {
  const cases: InvestigatorCase[] = [];
  for (const v of V) {
    nextCaseMorning(clock);
    cases.push(await makeCase(v, clock));
  }
  return cases;
}

export const TIMEOUT_VARIANT_COUNT = V.length;
