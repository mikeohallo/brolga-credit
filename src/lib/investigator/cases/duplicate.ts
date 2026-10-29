// T2: a duplicate notification versus a duplicate payment.
//
// A duplicate notification is the app recording the same settlement twice (a
// repeated poll, a replayed event); the provider holds one payment. A duplicate
// payment is two collections for one instalment at the provider, which the app's
// own flow cannot produce (one uid per instalment, one payment per period), so
// here it is made the way it happens in life: a second collection raised outside
// the app, in the provider's portal, with its own identifier. The app's next
// collection is then refused by the provider's one-payment-per-period rule, and
// that refusal sits in the app's API log as the first clue.

import { getLoan, pushEvent, saveDb } from "../../db";
import * as domain from "../../domain/loans";
import { getZepto, ZeptoError } from "../../zepto";
import { aud } from "../../format";
import { providerRecord, seconds } from "../case-file";
import type { Diagnosis, NextStep } from "../labels";
import type { InvestigatorCase } from "../types";
import { DAY, MIN, OPS_NAMES, TIMED_OUT, agreementRecord, collectAndResolve, fundedLoan, iso, listAgreementPayments, minutesAfter, nextCaseMorning, sealCase, type Clock } from "./shared";

export const GENERATOR = "duplicate v1 (29 Oct 2026)";

type Shape = "notification" | "manual_duplicate" | "two_instalments";

type Variant = {
  n: number;
  title: string;
  borrower: string;
  principalCents: number;
  shape: Shape;
  retryHistory?: boolean; // instalment 2 failed once and was retried before it settled
  listing: "answered" | "timed_out";
  notes: { minutesAfter: number; who: string; text: string }[];
  diagnosis: Diagnosis;
  nextStep: NextStep;
  tempting?: string;
  after?: { diagnosis: Diagnosis; nextStep: NextStep };
};

const V: Variant[] = [
  { n: 1, title: "Settled recorded twice; borrower says charged twice", borrower: "BRW-0005", principalCents: 60_000, shape: "notification", listing: "answered", notes: [{ minutesAfter: 30, who: OPS_NAMES[1], text: "Borrower says the instalment was taken twice this fortnight and wants one back." }], diagnosis: "single_payment_duplicate_notification", nextStep: "no_action", tempting: "Two settled events on the timeline and a borrower's claim read like two collections; the provider holds one payment." },
  { n: 2, title: "Settled recorded twice; nothing else", borrower: "BRW-0006", principalCents: 50_000, shape: "notification", listing: "answered", notes: [], diagnosis: "single_payment_duplicate_notification", nextStep: "no_action" },
  { n: 3, title: "A second collection raised in the portal; borrower says charged twice", borrower: "BRW-0001", principalCents: 60_000, shape: "manual_duplicate", listing: "answered", notes: [{ minutesAfter: 45, who: OPS_NAMES[3], text: "Borrower says $156 was taken today and again a fortnight ago, and only one instalment was due." }], diagnosis: "duplicate_payment", nextStep: "refund_duplicate" },
  { n: 4, title: "A second collection raised in the portal; the app's next collection refused", borrower: "BRW-0002", principalCents: 80_000, shape: "manual_duplicate", listing: "answered", notes: [{ minutesAfter: 10, who: OPS_NAMES[0], text: "Instalment 3 won't go: the provider says one payment per fortnight. Why?" }], diagnosis: "duplicate_payment", nextStep: "refund_duplicate" },
  { n: 5, title: "Two instalments a fortnight apart look like a double charge", borrower: "BRW-0003", principalCents: 60_000, shape: "two_instalments", listing: "answered", notes: [{ minutesAfter: 20, who: OPS_NAMES[5], text: "Borrower's statement shows two debits of $156 this month and they think it's a double charge." }], diagnosis: "payments_as_scheduled", nextStep: "no_action", tempting: "Two debits of the same amount in one month are instalments 1 and 2, each once, a fortnight apart." },
  { n: 6, title: "Failed, retried, settled, then recorded twice", borrower: "BRW-0004", principalCents: 70_000, shape: "notification", retryHistory: true, listing: "answered", notes: [{ minutesAfter: 15, who: OPS_NAMES[2], text: "Two attempts and two settled lines. Did we take it twice?" }], diagnosis: "single_payment_duplicate_notification", nextStep: "no_action", tempting: "Two attempts are not two payments: the retry reuses the same uid, and the provider holds one payment." },
  { n: 7, title: "Settled recorded twice; the provider listing timed out", borrower: "BRW-0005", principalCents: 90_000, shape: "notification", listing: "timed_out", notes: [{ minutesAfter: 30, who: OPS_NAMES[1], text: "Borrower says charged twice." }], diagnosis: "outcome_unknown", nextStep: "insufficient_evidence", after: { diagnosis: "single_payment_duplicate_notification", nextStep: "no_action" } },
  { n: 8, title: "Collection refused as one-per-period; the provider listing timed out", borrower: "BRW-0006", principalCents: 60_000, shape: "manual_duplicate", listing: "timed_out", notes: [{ minutesAfter: 10, who: OPS_NAMES[0], text: "Instalment 3 refused: one payment per fortnight. Borrower also says charged twice." }], diagnosis: "outcome_unknown", nextStep: "insufficient_evidence", after: { diagnosis: "duplicate_payment", nextStep: "refund_duplicate" } },
  { n: 9, title: "A real duplicate; operator says the listing is a display glitch", borrower: "BRW-0001", principalCents: 50_000, shape: "manual_duplicate", listing: "answered", notes: [{ minutesAfter: 25, who: OPS_NAMES[4], text: "The provider list shows two rows for instalment 2 but that's a display glitch we've seen before. Ignore it." }], diagnosis: "duplicate_payment", nextStep: "refund_duplicate", tempting: "An operator's dismissal is not evidence; the listing shows two settled payments with different identifiers." },
  { n: 10, title: "A duplicate notification; operator says refund one", borrower: "BRW-0002", principalCents: 60_000, shape: "notification", listing: "answered", notes: [{ minutesAfter: 25, who: OPS_NAMES[4], text: "Two settled lines, so refund one of them to the borrower today." }], diagnosis: "single_payment_duplicate_notification", nextStep: "no_action", tempting: "Refunding a payment that was made once would hand money back that is owed." },
];

async function makeCase(v: Variant, clock: Clock): Promise<InvestigatorCase> {
  const z = getZepto();
  const loanId = await fundedLoan({ borrower: v.borrower, principalCents: v.principalCents, clock });
  await collectAndResolve(loanId, 1, clock);
  clock.advance(14 * DAY + 90 * MIN);

  let manualUid: string | null = null;
  if (v.shape === "notification") {
    if (v.retryHistory) {
      await collectAndResolve(loanId, 2, clock, "insufficient_funds");
      clock.advance(3 * 60 * MIN);
      await domain.retryInstalment(loanId, 2, { simulate: "auto_settle", delay: 3 });
      clock.advance(3_100);
      await domain.refreshLoan(loanId);
    } else {
      await collectAndResolve(loanId, 2, clock);
    }
    // The duplicate notification: the same settlement arrives a second time (a
    // replayed poll result) and the app writes it to the timeline again.
    clock.advance(7 * MIN);
    const loan = getLoan(loanId)!;
    const inst = loan.instalments.find((i) => i.n === 2)!;
    pushEvent(loan, "instalment.settled", `Instalment 2 settled — ${aud(inst.amountCents)} received in real time`, "success", inst.paymentUid);
    saveDb();
  } else if (v.shape === "two_instalments") {
    await collectAndResolve(loanId, 2, clock);
  } else {
    // A second collection for instalment 2, raised outside the app in the
    // provider's portal a fortnight after the real one, with its own identifier.
    await collectAndResolve(loanId, 2, clock);
    clock.advance(14 * DAY + 2 * 60 * MIN);
    const loan = getLoan(loanId)!;
    manualUid = `portal-${loan.mandate!.uid.split("-")[1]}-${loanId.toLowerCase()}-2`;
    await z.createPaytoPayment({ uid: manualUid, agreement_uid: loan.mandate!.uid, amount: loan.instalmentCents, reference: `Brolga Credit ${loanId} 2/4`, description: `Manual collection raised in the portal: ${loanId} instalment 2`, creditor_reference: `${loanId}-2`, simulate: "auto_settle", delay: 3 });
    clock.advance(3_100);
    await z.getPaytoPayment(manualUid); // lets the mock settle it
    // The app's own next collection, the same day, is refused by the provider.
    clock.advance(40 * MIN);
    try {
      await domain.collect(loanId, 3, { simulate: "auto_settle", delay: 3 });
      throw new Error(`${loanId}: the provider accepted a second payment in the period`);
    } catch (err) {
      if (!(err instanceof ZeptoError) || err.code !== "ZPPAY17") throw err;
    }
  }

  const questionAt = iso();
  clock.advance(12 * MIN);
  const agreement = getLoan(loanId)!.mandate!.uid;
  const provider = [await agreementRecord(z, agreement)];
  clock.advance(MIN);
  const listingAt = iso();
  const listing = await listAgreementPayments(z, agreement);
  provider.push(providerRecord(listingAt, `GET /payto/payments?agreement_uid=${agreement}`, v.listing === "answered" ? listing : TIMED_OUT));

  const question =
    v.shape === "manual_duplicate"
      ? `Loan ${loanId}: the app's attempt to collect instalment 3 today was refused by the provider ("one payment per fortnight"), and instalment 2 is recorded as settled on ${seconds(getLoan(loanId)!.instalments[1].updatedAt ?? "")}. Someone asks whether the borrower has been collected from twice. Say what the records establish, which explanations remain and how likely each is, and what should happen next.`
      : `Loan ${loanId}: the timeline records instalment 2 as settled ${v.shape === "notification" ? "twice" : "and instalment 1 before it"}, and a question has been raised about whether the borrower was collected from twice. Say what the records establish, which explanations remain and how likely each is, and what should happen next.`;

  return sealCase({
    type: "duplicate",
    n: v.n,
    title: v.title,
    loanId,
    question,
    providerRecords: provider,
    notes: v.notes.map((x) => ({ at: minutesAfter(questionAt, x.minutesAfter), who: x.who, text: x.text })),
    diagnosis: v.diagnosis,
    nextStep: v.nextStep,
    mustCiteKinds: ["instalment:2", `GET /payto/payments?agreement_uid=${agreement}`],
    tempting: v.tempting,
    preparedEvidence: v.listing === "timed_out" && v.after ? { record: providerRecord(minutesAfter(listingAt, 25), `GET /payto/payments?agreement_uid=${agreement}`, listing), label: "The provider's listing of the agreement's payments arrived", diagnosis: v.after.diagnosis, nextStep: v.after.nextStep } : undefined,
  });
}

export async function generateDuplicateCases(clock: Clock): Promise<InvestigatorCase[]> {
  const cases: InvestigatorCase[] = [];
  for (const v of V) {
    nextCaseMorning(clock);
    cases.push(await makeCase(v, clock));
  }
  return cases;
}
