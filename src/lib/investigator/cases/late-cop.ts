// T4: the name check (Confirmation of Payee) fails after the loan was written.
//
// Brolga's policy is already in the code: the borrower's latest result governs
// at the moment money is about to move; a no-match or closed account puts an
// undisbursed loan on hold until a named person records an override; a check
// that could not be performed is recorded as unavailable, never as a pass or a
// fail; money that has already moved keeps its record. The cases run that code
// and ask the investigator to read what it recorded.

import { getBorrower, getLoan, type Borrower } from "../../db";
import * as domain from "../../domain/loans";
import { getZepto, ZeptoError, type CopSimulate } from "../../zepto";
import { aud } from "../../format";
import { maskAccount, providerRecord, seconds } from "../case-file";
import type { Diagnosis, NextStep } from "../labels";
import type { InvestigatorCase } from "../types";
import { DAY, MIN, OPS_NAMES, PAYOUT_LIST, TIMED_OUT, fundedLoan, iso, listPayoutBatches, lostAnswer, minutesAfter, nextCaseMorning, sealCase, withPatched, type Clock } from "./shared";

export const GENERATOR = "late-cop v1 (29 Oct 2026)";

type Shape = "before_money" | "after_money" | "unavailable" | "overridden" | "close_match" | "lost_payout_then_no_match" | "unavailable_then_match";

type Variant = {
  n: number;
  title: string;
  borrower: string;
  principalCents: number;
  shape: Shape;
  result?: CopSimulate; // the late check's result
  lookup?: "answered" | "timed_out";
  notes: { minutesAfter: number; who: string; text: string }[];
  diagnosis: Diagnosis;
  nextStep: NextStep;
  tempting?: string;
  after?: { diagnosis: Diagnosis; nextStep: NextStep };
};

const V: Variant[] = [
  { n: 1, title: "No match before any money moved; borrower says the name is right", borrower: "BRW-0001", principalCents: 60_000, shape: "before_money", result: "individual_no_match", notes: [{ minutesAfter: 20, who: OPS_NAMES[1], text: "Borrower rang: says the name on the account is theirs and asks us to pay today." }], diagnosis: "payee_check_failed_before_money", nextStep: "hold_disbursement", tempting: "The borrower's assurance is a statement; the hold needs a named override or an account that passes." },
  { n: 2, title: "No match after the money had cleared; operator wants a hold", borrower: "BRW-0002", principalCents: 50_000, shape: "after_money", result: "individual_no_match", notes: [{ minutesAfter: 15, who: OPS_NAMES[0], text: "The re-check says no match. Put the loan on hold." }], diagnosis: "payee_check_failed_after_money", nextStep: "escalate", tempting: "A hold stops money that has not moved; this money cleared two days ago, so the question is where it went." },
  { n: 3, title: "The check could not be performed; operator reads it as failed", borrower: "BRW-0003", principalCents: 80_000, shape: "unavailable", result: "unable_to_confirm", notes: [{ minutesAfter: 10, who: OPS_NAMES[2], text: "CoP failed on the re-check. Hold the loan until the borrower gives us a new account." }], diagnosis: "payee_check_unavailable", nextStep: "reverify_payee", tempting: "\"Unable to confirm\" is not \"no match\"; the app recorded it as unavailable and the loan is a draft, not held." },
  { n: 4, title: "No match, then a recorded override by a named person", borrower: "BRW-0004", principalCents: 60_000, shape: "overridden", result: "individual_no_match", notes: [{ minutesAfter: 30, who: OPS_NAMES[3], text: "This loan was on hold yesterday. Is it safe to disburse now?" }], diagnosis: "payee_check_overridden", nextStep: "no_action" },
  { n: 5, title: "A close match; support says it isn't exact so hold it", borrower: "BRW-0005", principalCents: 70_000, shape: "close_match", result: "close_match", notes: [{ minutesAfter: 10, who: OPS_NAMES[5], text: "The name came back as a close match, not exact. Shouldn't this be held?" }], diagnosis: "payee_check_passed", nextStep: "no_action", tempting: "The desk's policy treats a close match as verified; the app did not hold it and nothing in the records says it should." },
  { n: 6, title: "Account closed before any money moved", borrower: "BRW-0006", principalCents: 90_000, shape: "before_money", result: "account_closed", notes: [], diagnosis: "payee_check_failed_before_money", nextStep: "hold_disbursement" },
  { n: 7, title: "A payout answer was lost, then the check failed; the payout lookup timed out", borrower: "BRW-0001", principalCents: 60_000, shape: "lost_payout_then_no_match", result: "individual_no_match", lookup: "timed_out", notes: [{ minutesAfter: 12, who: OPS_NAMES[4], text: "The loan is on hold and the disbursement shows unknown. Did the money go or not?" }], diagnosis: "outcome_unknown", nextStep: "insufficient_evidence", after: { diagnosis: "payee_check_failed_after_money", nextStep: "escalate" } },
  { n: 8, title: "No match after the money had cleared; operator wants the payout reversed", borrower: "BRW-0002", principalCents: 50_000, shape: "after_money", result: "individual_no_match", notes: [{ minutesAfter: 25, who: OPS_NAMES[0], text: "Reverse the payout: it went to the wrong account." }], diagnosis: "payee_check_failed_after_money", nextStep: "escalate", tempting: "A cleared payout cannot be reversed from the desk; whether it was misdirected is a decision for a person with the provider's recovery process." },
  { n: 9, title: "Unavailable, then a match on the re-run; operator confused", borrower: "BRW-0003", principalCents: 60_000, shape: "unavailable_then_match", result: "match", notes: [{ minutesAfter: 5, who: OPS_NAMES[2], text: "First it said unavailable, now it says match. Which one counts?" }], diagnosis: "payee_check_passed", nextStep: "no_action" },
  { n: 10, title: "No match before any money moved; support pushes for an override now", borrower: "BRW-0004", principalCents: 70_000, shape: "before_money", result: "individual_no_match", notes: [{ minutesAfter: 40, who: OPS_NAMES[1], text: "Borrower is furious. Can you just override the hold so we can pay them?" }], diagnosis: "payee_check_failed_before_money", nextStep: "hold_disbursement", tempting: "An override needs a named person and a recorded reason; pressure from a call is neither." },
];

function copRecord(b: Borrower): ReturnType<typeof providerRecord> {
  const c = b.cop!;
  const request = `POST /cop/account/validate (party name "${b.name}", ${maskAccount(b.bsb, b.accountNumber)})`;
  if (c.result === "error") return providerRecord(c.checkedAt, request, `no usable result: ${c.error ?? "the provider returned an error"}`);
  return providerRecord(c.checkedAt, request, `result "${c.result.replace("_", " ")}"${c.matchName ? `, matched name "${c.matchName}"` : ", no matched name"}${c.riskScore !== undefined ? `, risk score ${c.riskScore}` : ""}`);
}

async function makeCase(v: Variant, clock: Clock): Promise<InvestigatorCase> {
  const z = getZepto();
  const borrower = getBorrower(v.borrower)!;
  let loanId: string;
  const provider: ReturnType<typeof providerRecord>[] = [];
  let mustCiteKinds: string[] = ["borrower", "POST /cop/account/validate"];
  let question: string;
  let askedAt: string;
  let prepared: InvestigatorCase["preparedEvidence"] | undefined;
  let after: Variant["after"];

  if (v.shape === "after_money") {
    loanId = await fundedLoan({ borrower: v.borrower, principalCents: v.principalCents, clock, mandate: false });
    clock.advance(2 * DAY);
    await domain.verifyBorrower(borrower.id, v.result);
    provider.push(copRecord(getBorrower(borrower.id)!));
    clock.advance(MIN);
    const d = getLoan(loanId)!.disbursement!;
    const tx = await z.transactions({ parent_ref: d.paymentRef, both_parties: "true" });
    const credit = tx.find((t) => t.type === "credit" && t.category === "payout");
    provider.push(providerRecord(iso(), `GET /transactions?parent_ref=${d.paymentRef}&both_parties=true`, credit ? `borrower-side credit ${credit.ref}: status "${credit.status}", ${aud(credit.amount)}, cleared ${credit.cleared_at ? seconds(credit.cleared_at) : "?"}` : "no credit row"));
    askedAt = iso();
    question = `Loan ${loanId}: the borrower's name check was re-run today and came back "no match", two days after the loan was paid out. Say what the records establish, what the app's own rules make of it, and what should happen next.`;
    mustCiteKinds = ["disbursement", "POST /cop/account/validate"];
  } else if (v.shape === "lost_payout_then_no_match") {
    await domain.verifyBorrower(borrower.id, "match");
    const loan = domain.createLoan({ borrowerId: borrower.id, principalCents: v.principalCents, termFortnights: 4, purpose: "Synthetic investigator case" });
    loanId = loan.id;
    clock.advance(2 * MIN);
    const original = (Object.getPrototypeOf(z) as typeof z).createPayment.bind(z);
    let lost: unknown = null;
    await withPatched(z, "createPayment", async (input) => { await original(input); throw lostAnswer("/payments"); }, async () => {
      try { await domain.disburse(loanId); } catch (err) { lost = err; }
    });
    if (!(lost instanceof ZeptoError) || !lost.outcomeUnknown) throw new Error(`${loanId}: the lost payout answer was not injected`);
    clock.advance(25 * MIN);
    await domain.verifyBorrower(borrower.id, v.result);
    provider.push(copRecord(getBorrower(borrower.id)!));
    clock.advance(6 * MIN);
    const listingAt = iso();
    const listing = await listPayoutBatches(z);
    provider.push(providerRecord(listingAt, PAYOUT_LIST, v.lookup === "answered" ? listing : TIMED_OUT));
    askedAt = iso();
    question = `Loan ${loanId}: the disbursement request got no answer, and the borrower's name check then came back "no match", so the app holds the loan and shows the disbursement as unknown. Say whether the money moved, what the hold means in that light, and what should happen next.`;
    mustCiteKinds = ["event:disbursement.unknown", PAYOUT_LIST, "POST /cop/account/validate"];
    after = v.after;
    prepared = after ? [{ ...providerRecord(minutesAfter(listingAt, 25), PAYOUT_LIST, listing), label: "The provider's payout list arrived" }] : undefined;
  } else {
    // The loan written on a match (or a close match), the late check run before any money moved.
    await domain.verifyBorrower(borrower.id, v.shape === "unavailable_then_match" ? "unable_to_confirm" : "match");
    const loan = domain.createLoan({ borrowerId: borrower.id, principalCents: v.principalCents, termFortnights: 4, purpose: "Synthetic investigator case" });
    loanId = loan.id;
    const firstCheck = copRecord(getBorrower(borrower.id)!);
    clock.advance(DAY + 3 * 60 * MIN);
    await domain.verifyBorrower(borrower.id, v.result);
    provider.push(firstCheck, copRecord(getBorrower(borrower.id)!));
    if (v.shape === "overridden") {
      clock.advance(2 * 60 * MIN);
      await domain.recordCopOverride(loanId, OPS_NAMES[2], "Borrower produced a bank statement at the branch; account holder confirmed in person");
      clock.advance(DAY);
      mustCiteKinds = ["cop-hold", "POST /cop/account/validate"];
    }
    askedAt = iso();
    const latest = getBorrower(borrower.id)!.cop!;
    question = `Loan ${loanId} has not been paid out. The borrower's name check was ${v.shape === "unavailable_then_match" ? "re-run today after an earlier attempt could not be performed" : "re-run today"} and the app recorded "${latest.result.replace("_", " ")}". Say what that means for the loan under the app's own rules, what the records establish, and what should happen next.`;
  }

  return sealCase({
    type: "late_cop_failure",
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
    preparedEvidence: prepared && after ? { record: prepared[0], label: prepared[0].label, diagnosis: after.diagnosis, nextStep: after.nextStep, mustCiteKinds: ["event:disbursement.unknown"] } : undefined,
  });
}

export async function generateLateCopCases(clock: Clock): Promise<InvestigatorCase[]> {
  const cases: InvestigatorCase[] = [];
  for (const v of V) {
    nextCaseMorning(clock);
    cases.push(await makeCase(v, clock));
  }
  return cases;
}
