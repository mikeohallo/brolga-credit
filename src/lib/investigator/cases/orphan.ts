// T3: the provider holds a record the app has no match for.
//
// Three ways that happens, each made through the real code: the app sent a
// payout, the answer was lost, and the app's record of the attempt was then lost
// too (a store restored from before the attempt), so the provider has a batch
// carrying this loan's reference and the app shows the loan undisbursed; a PayTo
// payment raised in the provider's portal on this loan's agreement with an
// identifier the app never minted; and a record that is simply another loan's.

import { getLoan, getBorrower, saveDb } from "../../db";
import * as domain from "../../domain/loans";
import { getZepto, ZeptoError } from "../../zepto";
import { aud } from "../../format";
import { providerRecord } from "../case-file";
import type { Diagnosis, NextStep } from "../labels";
import type { InvestigatorCase } from "../types";
import { DAY, MIN, OPS_NAMES, PAYOUT_LIST, TIMED_OUT, agreementRecord, describeBatch, fundedLoan, iso, listAgreementPayments, listPayoutBatches, lostAnswer, minutesAfter, nextCaseMorning, sealCase, withPatched, type Clock } from "./shared";

export const GENERATOR = "orphan v1 (29 Oct 2026)";

type Shape = "lost_payout_record" | "portal_payment" | "other_loan" | "lost_instalment_record" | "nothing_extra";

type Variant = {
  n: number;
  title: string;
  borrower: string;
  principalCents: number;
  shape: Shape;
  payoutOutcome?: "cleared" | "processing"; // for lost_payout_record: how far the lost payout had got when the list was read
  lookup: "answered" | "timed_out";
  notes: { minutesAfter: number; who: string; text: string }[];
  diagnosis: Diagnosis;
  nextStep: NextStep;
  tempting?: string;
  after?: { diagnosis: Diagnosis; nextStep: NextStep };
};

const V: Variant[] = [
  { n: 1, title: "A payout batch with this loan's reference; the app shows the loan undisbursed", borrower: "BRW-0003", principalCents: 60_000, shape: "lost_payout_record", payoutOutcome: "cleared", lookup: "answered", notes: [{ minutesAfter: 20, who: OPS_NAMES[2], text: "After this morning's store restore the loan went back to verified. Can I disburse it now?" }], diagnosis: "provider_record_is_ours", nextStep: "adopt_provider_record", tempting: "A loan that looks undisbursed invites a disbursement; the provider already holds one carrying this loan's reference and intent key." },
  { n: 2, title: "Same, and the provider's batch listing timed out", borrower: "BRW-0004", principalCents: 50_000, shape: "lost_payout_record", payoutOutcome: "cleared", lookup: "timed_out", notes: [{ minutesAfter: 20, who: OPS_NAMES[2], text: "Loan shows verified after the restore. Disburse?" }], diagnosis: "outcome_unknown", nextStep: "insufficient_evidence", after: { diagnosis: "provider_record_is_ours", nextStep: "adopt_provider_record" } },
  { n: 3, title: "A PayTo payment on the agreement the app never made", borrower: "BRW-0005", principalCents: 80_000, shape: "portal_payment", lookup: "answered", notes: [{ minutesAfter: 15, who: OPS_NAMES[0], text: "There's a settled payment on the agreement that isn't on the loan. Mark instalment 1 paid?" }], diagnosis: "unexplained_provider_record", nextStep: "escalate", tempting: "A settled payment for the instalment amount looks like instalment 1; nothing ties it to the app's request, and the app's instalment 1 was never sent." },
  { n: 4, title: "A record that belongs to another loan with the same amount", borrower: "BRW-0006", principalCents: 60_000, shape: "other_loan", lookup: "answered", notes: [{ minutesAfter: 10, who: OPS_NAMES[3], text: "The provider's list has a $600 payout I can't match to this loan." }], diagnosis: "record_belongs_elsewhere", nextStep: "no_action", tempting: "Same amount, same day, same desk; the batch carries a different loan's reference." },
  { n: 5, title: "Ours after a restore; borrower confirms receipt", borrower: "BRW-0001", principalCents: 70_000, shape: "lost_payout_record", payoutOutcome: "cleared", lookup: "answered", notes: [{ minutesAfter: 30, who: OPS_NAMES[1], text: "Borrower confirms $700 landed in their account yesterday." }], diagnosis: "provider_record_is_ours", nextStep: "adopt_provider_record" },
  { n: 6, title: "A portal payment; operator says it's obviously ours", borrower: "BRW-0002", principalCents: 90_000, shape: "portal_payment", lookup: "answered", notes: [{ minutesAfter: 15, who: OPS_NAMES[4], text: "It's obviously ours, same amount and same agreement. Adopt it as instalment 1." }], diagnosis: "unexplained_provider_record", nextStep: "escalate", tempting: "An operator's certainty is not a record; the identifier is not the app's and the app never sent instalment 1." },
  { n: 7, title: "An instalment settled at the provider under the app's own identifier; the app shows it scheduled", borrower: "BRW-0003", principalCents: 60_000, shape: "lost_instalment_record", lookup: "answered", notes: [], diagnosis: "provider_record_is_ours", nextStep: "adopt_provider_record" },
  { n: 8, title: "Support says a payout went out; the provider holds nothing extra", borrower: "BRW-0004", principalCents: 50_000, shape: "nothing_extra", lookup: "answered", notes: [{ minutesAfter: 5, who: OPS_NAMES[5], text: "Borrower says they were paid twice, once by us and once by 'the other system'." }], diagnosis: "records_agree", nextStep: "no_action", tempting: "The provider holds exactly the app's one payout; the second payment exists only in the claim." },
  { n: 9, title: "Support says the borrower got money; the app shows undisbursed; the listing timed out", borrower: "BRW-0005", principalCents: 60_000, shape: "lost_payout_record", payoutOutcome: "cleared", lookup: "timed_out", notes: [{ minutesAfter: 30, who: OPS_NAMES[1], text: "Borrower says the $600 arrived on Monday, but the loan shows verified, not disbursed." }], diagnosis: "outcome_unknown", nextStep: "insufficient_evidence", after: { diagnosis: "provider_record_is_ours", nextStep: "adopt_provider_record" } },
  { n: 10, title: "Ours, and the lost payout is still processing at the provider", borrower: "BRW-0006", principalCents: 70_000, shape: "lost_payout_record", payoutOutcome: "processing", lookup: "answered", notes: [{ minutesAfter: 2, who: OPS_NAMES[2], text: "Loan shows verified after the restore; the provider list shows a batch for it. What state is the loan really in?" }], diagnosis: "provider_record_is_ours", nextStep: "adopt_provider_record" },
];

async function makeCase(v: Variant, clock: Clock): Promise<InvestigatorCase> {
  const z = getZepto();
  let loanId: string;
  let question: string;
  const provider: ReturnType<typeof providerRecord>[] = [];
  let mustCiteKinds: string[];
  let listingKind = "";
  let listingText = "";
  let listingAt = "";

  if (v.shape === "lost_payout_record") {
    // Disburse with the answer lost after the provider accepted it, then lose the
    // app's record of the attempt (the store restored from before it).
    const borrower = getBorrower(v.borrower)!;
    await domain.verifyBorrower(borrower.id, "match");
    const loan = domain.createLoan({ borrowerId: borrower.id, principalCents: v.principalCents, termFortnights: 4, purpose: "Synthetic investigator case" });
    loanId = loan.id;
    clock.advance(2 * MIN);
    const original = (Object.getPrototypeOf(z) as typeof z).createPayment.bind(z);
    let lost: unknown = null;
    await withPatched(
      z,
      "createPayment",
      async (input) => {
        await original(input);
        throw lostAnswer("/payments");
      },
      async () => {
        try {
          await domain.disburse(loanId);
        } catch (err) {
          lost = err;
        }
      },
    );
    if (!(lost instanceof ZeptoError) || !lost.outcomeUnknown) throw new Error(`${loanId}: the lost payout answer was not injected`);
    // The restore: the app's record of the attempt is gone; the loan reads as verified.
    const l = getLoan(loanId)!;
    l.disbursementIntent = null;
    l.disbursementAttempts = 0;
    l.events = l.events.filter((e) => !e.type.startsWith("disbursement."));
    l.status = "verified";
    saveDb();
    // "processing": the list is read seconds later, before the payout cleared;
    // "cleared": the next day.
    clock.advance(v.payoutOutcome === "processing" ? 5_000 : DAY + 8 * MIN);
    listingAt = iso();
    listingText = await listPayoutBatches(z);
    listingKind = PAYOUT_LIST;
    provider.push(providerRecord(listingAt, listingKind, v.lookup === "answered" ? listingText : TIMED_OUT));
    question = `Loan ${loanId}: after the app's store was restored the loan reads "verified" with no disbursement recorded, and the provider's account shows payout batches. Say whether any of them is this loan's, what state the loan is really in, and what should happen next.`;
    mustCiteKinds = ["loan", listingKind];
  } else if (v.shape === "portal_payment") {
    loanId = await fundedLoan({ borrower: v.borrower, principalCents: v.principalCents, clock });
    const loan = getLoan(loanId)!;
    const uid = `portal-${loan.mandate!.uid.split("-")[1]}-${loanId.toLowerCase()}-a`;
    await z.createPaytoPayment({ uid, agreement_uid: loan.mandate!.uid, amount: loan.instalmentCents, reference: `Brolga Credit ${loanId}`, description: `Collection raised in the portal on ${loanId}`, creditor_reference: loanId, simulate: "auto_settle", delay: 3 });
    clock.advance(3_100);
    await z.getPaytoPayment(uid);
    clock.advance(DAY);
    provider.push(await agreementRecord(z, loan.mandate!.uid));
    clock.advance(MIN);
    listingAt = iso();
    listingKind = `GET /payto/payments?agreement_uid=${loan.mandate!.uid}`;
    listingText = await listAgreementPayments(z, loan.mandate!.uid);
    provider.push(providerRecord(listingAt, listingKind, listingText));
    question = `Loan ${loanId}: the provider lists a settled payment on this loan's PayTo agreement, and the app has no instalment in any state but "scheduled". Say what the records establish about that payment, whether it is the app's, and what should happen next.`;
    mustCiteKinds = ["instalment:1", listingKind];
  } else if (v.shape === "other_loan") {
    loanId = await fundedLoan({ borrower: v.borrower, principalCents: v.principalCents, clock, mandate: false });
    clock.advance(30 * MIN);
    // Another loan for the same amount, the same day, for a different borrower.
    const otherBorrower = v.borrower === "BRW-0006" ? "BRW-0002" : "BRW-0006";
    await fundedLoan({ borrower: otherBorrower, principalCents: v.principalCents, clock, mandate: false });
    clock.advance(2 * 60 * MIN);
    listingAt = iso();
    listingKind = PAYOUT_LIST;
    listingText = await listPayoutBatches(z);
    provider.push(providerRecord(listingAt, listingKind, listingText));
    const d = getLoan(loanId)!.disbursement!;
    clock.advance(MIN);
    provider.push(providerRecord(iso(), `GET /payments/${d.paymentRef}`, describeBatch(await z.getPayment(d.paymentRef))));
    question = `Loan ${loanId}: the provider's payout list shows two batches for ${aud(v.principalCents)} today and an operator cannot match the second to this loan. Say whether it belongs to this loan, whether this loan's records are complete, and what should happen next.`;
    mustCiteKinds = ["disbursement", listingKind];
  } else if (v.shape === "lost_instalment_record") {
    loanId = await fundedLoan({ borrower: v.borrower, principalCents: v.principalCents, clock });
    await domain.collect(loanId, 1, { simulate: "auto_settle", delay: 3 });
    clock.advance(3_100);
    await domain.refreshLoan(loanId);
    // The restore: the app forgets it ever sent instalment 1.
    const l = getLoan(loanId)!;
    const inst = l.instalments[0];
    const sentUid = inst.paymentUid!;
    inst.state = "scheduled";
    inst.paymentUid = undefined;
    inst.attempts = 0;
    l.events = l.events.filter((e) => !e.type.startsWith("instalment."));
    saveDb();
    clock.advance(DAY);
    provider.push(await agreementRecord(z, l.mandate!.uid));
    clock.advance(MIN);
    listingAt = iso();
    listingKind = `GET /payto/payments?agreement_uid=${l.mandate!.uid}`;
    listingText = await listAgreementPayments(z, l.mandate!.uid);
    provider.push(providerRecord(listingAt, listingKind, listingText));
    question = `Loan ${loanId}: after this morning's store restore instalment 1 reads "scheduled", and the provider lists a settled payment ${sentUid} on this loan's agreement. Say whether that payment is the app's, what the loan's position really is, and what should happen next.`;
    mustCiteKinds = ["instalment:1", listingKind];
  } else {
    loanId = await fundedLoan({ borrower: v.borrower, principalCents: v.principalCents, clock, mandate: false });
    clock.advance(DAY);
    listingAt = iso();
    listingKind = PAYOUT_LIST;
    listingText = await listPayoutBatches(z);
    provider.push(providerRecord(listingAt, listingKind, listingText));
    const d = getLoan(loanId)!.disbursement!;
    clock.advance(MIN);
    provider.push(providerRecord(iso(), `GET /payments/${d.paymentRef}`, describeBatch(await z.getPayment(d.paymentRef))));
    question = `Loan ${loanId}: a claim has been raised that the borrower was paid twice. Say what the provider holds for this loan, whether any payment exists beyond the app's, and what should happen next.`;
    mustCiteKinds = ["disbursement", listingKind];
  }

  return sealCase({
    type: "orphan_provider_record",
    n: v.n,
    title: v.title,
    loanId,
    question,
    providerRecords: provider,
    notes: v.notes.map((x) => ({ at: minutesAfter(listingAt, x.minutesAfter), who: x.who, text: x.text })),
    diagnosis: v.diagnosis,
    nextStep: v.nextStep,
    mustCiteKinds,
    tempting: v.tempting,
    preparedEvidence: v.lookup === "timed_out" && v.after ? { record: providerRecord(minutesAfter(listingAt, 25), listingKind, listingText), label: "The provider's listing arrived", diagnosis: v.after.diagnosis, nextStep: v.after.nextStep } : undefined,
  });
}

export async function generateOrphanCases(clock: Clock): Promise<InvestigatorCase[]> {
  const cases: InvestigatorCase[] = [];
  for (const v of V) {
    nextCaseMorning(clock);
    cases.push(await makeCase(v, clock));
  }
  return cases;
}
