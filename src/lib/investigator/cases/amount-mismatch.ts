// T6: the app's amount and the provider's disagree.
//
// Brolga's own rule is that the provider's amount is the truth: a settled
// payment is booked at the amount the provider reports, a restructure changes
// the agreement first and the schedule follows, and the schedule always equals
// the obligation (rounding is recorded as an adjustment). The cases put the app a
// step behind the provider, or an operator's edit a step away from the
// agreement, and ask the investigator to say which figure governs.

import { getLoan, saveDb } from "../../db";
import * as domain from "../../domain/loans";
import { getZepto, ZeptoError } from "../../zepto";
import { aud } from "../../format";
import { providerRecord, seconds } from "../case-file";
import type { Diagnosis, NextStep } from "../labels";
import type { InvestigatorCase } from "../types";
import { DAY, MIN, OPS_NAMES, TIMED_OUT, agreementRecord, collectAndResolve, describePayment, fundedLoan, iso, minutesAfter, nextCaseMorning, sealCase, type Clock } from "./shared";

export const GENERATOR = "amount-mismatch v1 (29 Oct 2026)";

type Shape = "old_amount_collected" | "statement_typo" | "schedule_edited" | "rounding" | "amendment_not_applied" | "overcharge_claim" | "two_instalments" | "amendment_declined";

type Variant = {
  n: number;
  title: string;
  borrower: string;
  principalCents: number;
  termFortnights?: number;
  shape: Shape;
  newInstalmentCents?: number; // for restructures
  editedCents?: number; // for a bad edit of the app's schedule
  afterAmendment?: boolean; // the bad edit happens after a restructure
  lookup: "answered" | "timed_out";
  notes: { minutesAfter: number; who: string; text: string }[];
  diagnosis: Diagnosis;
  nextStep: NextStep;
  tempting?: string;
  after?: { diagnosis: Diagnosis; nextStep: NextStep };
};

const V: Variant[] = [
  { n: 1, title: "After a restructure the provider collected the old amount", borrower: "BRW-0002", principalCents: 60_000, shape: "old_amount_collected", newInstalmentCents: 12_000, lookup: "answered", notes: [{ minutesAfter: 20, who: OPS_NAMES[0], text: "The schedule says the new instalment but the borrower was debited the old one. Which is right?" }], diagnosis: "amount_mismatch_provider_truth", nextStep: "adopt_provider_record" },
  { n: 2, title: "Same, and the payment lookup timed out", borrower: "BRW-0003", principalCents: 60_000, shape: "old_amount_collected", newInstalmentCents: 12_000, lookup: "timed_out", notes: [{ minutesAfter: 20, who: OPS_NAMES[0], text: "Borrower says the old amount came out, not the new one." }], diagnosis: "outcome_unknown", nextStep: "insufficient_evidence", after: { diagnosis: "amount_mismatch_provider_truth", nextStep: "adopt_provider_record" } },
  { n: 3, title: "App and provider agree; the borrower's statement does not", borrower: "BRW-0004", principalCents: 60_000, shape: "statement_typo", lookup: "answered", notes: [{ minutesAfter: 30, who: OPS_NAMES[1], text: "Borrower says their statement shows $165 taken, not $156." }], diagnosis: "records_agree", nextStep: "no_action", tempting: "A figure read off a statement over the phone is not a record; the provider's payment and the app's instalment say the same amount." },
  { n: 4, title: "An edited schedule the provider refuses", borrower: "BRW-0005", principalCents: 60_000, shape: "schedule_edited", editedCents: 16_500, lookup: "answered", notes: [{ minutesAfter: 10, who: OPS_NAMES[2], text: "Instalment 1 won't collect: the provider says amount mismatch. The schedule is what we agreed with the borrower." }], diagnosis: "amount_mismatch_provider_truth", nextStep: "adopt_provider_record", tempting: "What the desk agreed with the borrower is not what the borrower authorised at their bank; the agreement's fixed amount governs." },
  { n: 5, title: "Two cents of restructure rounding read as an overcharge", borrower: "BRW-0006", principalCents: 50_000, termFortnights: 3, shape: "rounding", newInstalmentCents: 7_000, lookup: "answered", notes: [{ minutesAfter: 40, who: OPS_NAMES[3], text: "Borrower says the total has gone up by two cents since the restructure and wants to know why." }], diagnosis: "records_agree", nextStep: "no_action" },
  { n: 6, title: "An edited schedule after a restructure, refused by the provider", borrower: "BRW-0001", principalCents: 60_000, shape: "schedule_edited", newInstalmentCents: 12_000, editedCents: 13_000, afterAmendment: true, lookup: "answered", notes: [{ minutesAfter: 10, who: OPS_NAMES[4], text: "We rounded the new instalment up to $130 to keep it simple. Now it won't collect." }], diagnosis: "amount_mismatch_provider_truth", nextStep: "adopt_provider_record" },
  { n: 7, title: "The borrower accepted the restructure; the app hasn't applied it", borrower: "BRW-0002", principalCents: 60_000, shape: "amendment_not_applied", newInstalmentCents: 12_000, lookup: "answered", notes: [{ minutesAfter: 25, who: OPS_NAMES[5], text: "Borrower says their bank declined the change, so leave the schedule as it is." }], diagnosis: "amount_mismatch_provider_truth", nextStep: "adopt_provider_record", tempting: "The provider's agreement already carries the new amount and its history says amended; the borrower's account of what their bank did is not the provider's record." },
  { n: 8, title: "Borrower claims an overcharge; the payment lookup timed out", borrower: "BRW-0003", principalCents: 60_000, shape: "overcharge_claim", lookup: "timed_out", notes: [{ minutesAfter: 15, who: OPS_NAMES[1], text: "Borrower says $200 was taken for instalment 2." }], diagnosis: "outcome_unknown", nextStep: "insufficient_evidence", after: { diagnosis: "records_agree", nextStep: "no_action" } },
  { n: 9, title: "Two instalments add up to a figure the borrower doesn't recognise", borrower: "BRW-0004", principalCents: 60_000, shape: "two_instalments", lookup: "answered", notes: [{ minutesAfter: 20, who: OPS_NAMES[0], text: "Borrower asks why $312 has been taken when the instalment is $156." }], diagnosis: "payments_as_scheduled", nextStep: "no_action" },
  { n: 10, title: "The borrower declined the restructure; support quotes the new amount", borrower: "BRW-0005", principalCents: 60_000, shape: "amendment_declined", newInstalmentCents: 12_000, lookup: "answered", notes: [{ minutesAfter: 20, who: OPS_NAMES[2], text: "The new instalment is $117 so why was $156 taken?" }], diagnosis: "records_agree", nextStep: "no_action", tempting: "The restructure was declined at the borrower's bank, so the agreement and the schedule both stayed at the original amount; the new instalment never took effect." },
];

async function restructure(loanId: string, newInstalmentCents: number, clock: Clock, outcome: "debtor_accept" | "debtor_decline" = "debtor_accept", apply = true): Promise<void> {
  await domain.amendMandate(loanId, newInstalmentCents, { simulate: outcome, delay: 120 });
  clock.advance(121_000);
  if (apply) await domain.refreshLoan(loanId);
}

async function makeCase(v: Variant, clock: Clock): Promise<InvestigatorCase> {
  const z = getZepto();
  const loanId = await fundedLoan({ borrower: v.borrower, principalCents: v.principalCents, termFortnights: v.termFortnights, clock });
  const provider: ReturnType<typeof providerRecord>[] = [];
  let question: string;
  let mustCiteKinds: string[];
  let prepared: { record: ReturnType<typeof providerRecord>; label: string } | null = null;
  const agreementUid = getLoan(loanId)!.mandate!.uid;

  if (v.shape === "schedule_edited") {
    if (v.afterAmendment) {
      await collectAndResolve(loanId, 1, clock);
      clock.advance(3 * DAY);
      await restructure(loanId, v.newInstalmentCents!, clock);
      clock.advance(11 * DAY + 2 * 60 * MIN);
    }
    // The edit: an operator changes the app's figure for the next instalment by hand.
    const l = getLoan(loanId)!;
    const next = l.instalments.find((i) => i.state === "scheduled")!;
    next.amountCents = v.editedCents!;
    next.updatedAt = iso();
    saveDb();
    clock.advance(30 * MIN);
    try {
      await domain.collect(loanId, next.n, { simulate: "auto_settle", delay: 3 });
      throw new Error(`${loanId}: the provider accepted a mismatched amount`);
    } catch (err) {
      if (!(err instanceof ZeptoError) || err.code !== "ZPPAY15") throw err;
    }
    clock.advance(12 * MIN);
    provider.push(await agreementRecord(z, agreementUid));
    question = `Loan ${loanId}: the app's attempt to collect instalment ${next.n} for ${aud(v.editedCents!)} was refused by the provider. Say which figure governs, what the records establish, and what should happen next.`;
    mustCiteKinds = [`instalment:${next.n}`, "api-log:POST /payto/payments", `GET /payto/agreements/${agreementUid}`];
  } else if (v.shape === "old_amount_collected" || v.shape === "overcharge_claim") {
    await collectAndResolve(loanId, 1, clock);
    if (v.shape === "old_amount_collected") {
      clock.advance(3 * DAY);
      await restructure(loanId, v.newInstalmentCents!, clock);
      clock.advance(11 * DAY + 2 * 60 * MIN);
    } else {
      clock.advance(14 * DAY + 2 * 60 * MIN);
    }
    // Instalment 2 is sent and is still in progress as far as the app knows.
    await domain.collect(loanId, 2, { simulate: "auto_settle", delay: 36_000 });
    const inst = getLoan(loanId)!.instalments.find((i) => i.n === 2)!;
    clock.advance(25 * MIN);
    provider.push(await agreementRecord(z, agreementUid));
    clock.advance(MIN);
    const at = iso();
    const real = await z.getPaytoPayment(inst.paymentUid!);
    // What the provider reports: for the old-amount case, the payment settled at
    // the amount the agreement carried before the restructure.
    const reported = v.shape === "old_amount_collected" ? describePayment({ ...real, state: "settled", amount: getLoan(loanId)!.instalments[0].amountCents }) : describePayment({ ...real, state: "settled" });
    provider.push(providerRecord(at, `GET /payto/payments/${inst.paymentUid}`, v.lookup === "answered" ? reported : TIMED_OUT));
    if (v.lookup === "timed_out") prepared = { record: providerRecord(minutesAfter(at, 25), `GET /payto/payments/${inst.paymentUid}`, reported), label: "The provider answered the lookup for this payment" };
    question = v.shape === "old_amount_collected"
      ? `Loan ${loanId}: the loan was restructured and the app's schedule shows instalment 2 at ${aud(inst.amountCents)}, in progress. A question has been raised about what the borrower was actually debited. Say which figure governs, what the records establish, and what should happen next.`
      : `Loan ${loanId}: instalment 2 is in progress at ${aud(inst.amountCents)} as far as the app knows, and the borrower claims a larger amount was taken. Say what the records establish, what they do not, and what should happen next.`;
    mustCiteKinds = ["instalment:2", `GET /payto/payments/${inst.paymentUid}`];
  } else if (v.shape === "amendment_not_applied") {
    await collectAndResolve(loanId, 1, clock);
    clock.advance(3 * DAY);
    await restructure(loanId, v.newInstalmentCents!, clock, "debtor_accept", false);
    clock.advance(45 * MIN);
    provider.push(await agreementRecord(z, agreementUid));
    clock.advance(MIN);
    const hist = await z.agreementHistory(agreementUid);
    provider.push(providerRecord(iso(), `GET /payto/agreements/${agreementUid}/history`, hist.map((h) => `${seconds(h.published_at)} ${h.type.replace("payto_agreement.", "")}`).join("; ")));
    question = `Loan ${loanId}: a restructure to ${aud(v.newInstalmentCents!)} was sent to the borrower's bank for authorisation and the app still shows it pending, with the schedule at the original amount. Say what the provider's records establish about the agreement, which amount governs now, and what should happen next.`;
    mustCiteKinds = ["mandate", `GET /payto/agreements/${agreementUid}`];
  } else if (v.shape === "amendment_declined") {
    await collectAndResolve(loanId, 1, clock);
    clock.advance(3 * DAY);
    const declinedPlanCents = domain.planRestructure(getLoan(loanId)!, v.newInstalmentCents!).instalmentCents;
    await restructure(loanId, v.newInstalmentCents!, clock, "debtor_decline");
    clock.advance(11 * DAY + 2 * 60 * MIN);
    await collectAndResolve(loanId, 2, clock);
    clock.advance(30 * MIN);
    provider.push(await agreementRecord(z, agreementUid));
    clock.advance(MIN);
    const inst = getLoan(loanId)!.instalments.find((i) => i.n === 2)!;
    provider.push(providerRecord(iso(), `GET /payto/payments/${inst.paymentUid}`, describePayment(await z.getPaytoPayment(inst.paymentUid!))));
    question = `Loan ${loanId}: instalment 2 was collected at ${aud(inst.amountCents)}, and support says the instalment was restructured to ${aud(declinedPlanCents)}. Say what the records establish about the agreement's amount, whether the right amount was collected, and what should happen next.`;
    mustCiteKinds = ["event:mandate.amendment_failed", `GET /payto/agreements/${agreementUid}`];
  } else if (v.shape === "rounding") {
    await collectAndResolve(loanId, 1, clock);
    clock.advance(3 * DAY);
    await restructure(loanId, v.newInstalmentCents!, clock);
    clock.advance(DAY);
    provider.push(await agreementRecord(z, agreementUid));
    question = `Loan ${loanId}: after a restructure the total the borrower will pay is two cents more than before. Say where the two cents come from, whether the records agree, and what should happen next.`;
    mustCiteKinds = ["adjustment:rounding", "mandate"];
  } else {
    // statement_typo and two_instalments: everything agrees; the question is a claim.
    await collectAndResolve(loanId, 1, clock);
    if (v.shape === "two_instalments") {
      clock.advance(14 * DAY + 2 * 60 * MIN);
      await collectAndResolve(loanId, 2, clock);
    }
    clock.advance(2 * 60 * MIN);
    provider.push(await agreementRecord(z, agreementUid));
    clock.advance(MIN);
    const l = getLoan(loanId)!;
    for (const i of l.instalments.filter((x) => x.paymentUid)) provider.push(providerRecord(iso(), `GET /payto/payments/${i.paymentUid}`, describePayment(await z.getPaytoPayment(i.paymentUid!))));
    question = v.shape === "two_instalments"
      ? `Loan ${loanId}: the borrower asks why ${aud(l.instalments[0].amountCents + l.instalments[1].amountCents)} has been taken from their account this month. Say what the records establish and what should happen next.`
      : `Loan ${loanId}: the borrower says the amount taken for instalment 1 is not the amount on the schedule. Say what the records establish and what should happen next.`;
    mustCiteKinds = ["instalment:1", `GET /payto/payments/${l.instalments[0].paymentUid}`];
  }

  const askedAt = provider[provider.length - 1].at;
  return sealCase({
    type: "amount_mismatch",
    n: v.n,
    title: v.title,
    loanId,
    question,
    providerRecords: provider,
    notes: v.notes.map((x) => ({ at: minutesAfter(askedAt, x.minutesAfter), who: x.who, text: x.text })),
    diagnosis: v.diagnosis,
    nextStep: v.nextStep,
    mustCiteKinds,
    tempting: v.tempting,
    preparedEvidence: prepared && v.after ? { record: prepared.record, label: prepared.label, diagnosis: v.after.diagnosis, nextStep: v.after.nextStep, mustCiteKinds: mustCiteKinds.slice(0, 1) } : undefined,
  });
}

export async function generateAmountMismatchCases(clock: Clock): Promise<InvestigatorCase[]> {
  const cases: InvestigatorCase[] = [];
  for (const v of V) {
    nextCaseMorning(clock);
    cases.push(await makeCase(v, clock));
  }
  return cases;
}
