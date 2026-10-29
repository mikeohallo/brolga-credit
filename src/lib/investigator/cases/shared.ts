// What every case generator needs: a loan brought to a known state through
// Brolga's real code, the provider's answers captured as records, faults injected
// the way the review suite injects them (by replacing one provider method for one
// call), and the case sealed with its label. The caller owns the clock.

import * as domain from "../../domain/loans";
import { getBorrower, getLoan, type Loan } from "../../db";
import { getZepto, ZeptoError, type PaymentBatch, type PaytoPayment, type PaytoPaymentSimulate, type Transaction, type ZeptoApi } from "../../zepto";
import { aud, shortDate } from "../../format";
import { appLogErrorRecords, assignIds, brolgaRecords, providerRecord, seconds, supportNote, type CaseRecord } from "../case-file";
import type { Diagnosis, ExceptionType, NextStep } from "../labels";
import type { Expected, InvestigatorCase } from "../types";

export type Clock = { advance: (ms: number) => void };
export const MIN = 60_000;
export const DAY = 86_400_000;

export const OPS_NAMES = ["Dana (operations)", "Ravi (support)", "Hana (operations)", "Luis (support)", "Mei (operations)", "Owen (support)"];

export function iso(): string {
  return new Date().toISOString();
}

/**
 * Move the clock to 09:30 Sydney (22:30 UTC) on a later day, at least a day on.
 * Every case starts there, so a first collection never straddles a Sydney
 * midnight (the agreement's first payment date is the day it was made) and the
 * cases come out the same whatever time the caller's clock started at.
 */
export function nextCaseMorning(clock: Clock): void {
  clock.advance(DAY);
  let guard = 0;
  while (!(new Date().getUTCHours() === 22 && new Date().getUTCMinutes() === 30) && guard++ < 1500) clock.advance(MIN);
}

export function describePayment(p: PaytoPayment): string {
  return `payment ${p.uid}: state "${p.state}", ${aud(p.amount)}, created ${seconds(p.created_at)}${p.reference ? `, reference "${p.reference}"` : ""}${p.creditor_reference ? `, creditor reference ${p.creditor_reference}` : ""}${p.failure ? `, failure ${p.failure.code} ${p.failure.title} (${p.failure.retryable ? "retryable" : "not retryable"})` : ""}`;
}

export function describeTransaction(t: Transaction): string {
  return `${t.ref} (${t.type}, ${t.category.replace("_", " ")}) in batch ${t.parent_ref ?? "?"}: status "${t.status}", ${aud(t.amount)}, created ${seconds(t.created_at)}${t.cleared_at ? `, cleared ${seconds(t.cleared_at)}` : ""}${t.failure ? `, failure ${t.failure.code} ${t.failure.title}` : ""}${t.party_name ? `, counterparty ${t.party_name}` : ""}${t.metadata?.loan_id ? `, loan ${t.metadata.loan_id}` : ""}`;
}

export const TIMED_OUT = "no answer: the request timed out after 10 seconds with no HTTP status; the provider's view was not obtained";

/** Ask the provider for one PayTo payment and describe the answer, 404 included. */
export async function lookupPayment(z: ZeptoApi, uid: string): Promise<string> {
  try {
    return describePayment(await z.getPaytoPayment(uid));
  } catch (err) {
    if (err instanceof ZeptoError && err.status === 404) return `HTTP 404 Not found: the provider has no payment with uid ${uid}`;
    throw err;
  }
}

export async function listAgreementPayments(z: ZeptoApi, agreementUid: string): Promise<string> {
  const rows = await z.listPaytoPayments({ agreement_uid: agreementUid });
  return rows.length ? `${rows.length} payment${rows.length === 1 ? "" : "s"} on the agreement, newest first: ${rows.map(describePayment).join("; ")}` : "no payments on the agreement";
}

export function describeBatch(b: PaymentBatch): string {
  const p = b.payouts[0];
  return `batch ${b.ref}${b.metadata?.loan_id ? ` carrying loan reference ${b.metadata.loan_id}` : ""}${b.metadata?.intent_key ? ` and intent key ${b.metadata.intent_key}` : ""}: payout ${p?.ref}, status "${p?.status}", ${aud(p?.amount ?? 0)}, created ${p?.created_at ? seconds(p.created_at) : "?"}`;
}

/** The newest few payout batches on the account, as the desk's list shows them. */
export async function listPayoutBatches(z: ZeptoApi, perPage = 6): Promise<string> {
  const batches = await z.listPayments({ page: 1, per_page: perPage });
  if (!batches.length) return "no payout batches on the account";
  return `the ${batches.length} newest payout batch${batches.length === 1 ? "" : "es"} on the account, newest first: ${batches.map(describeBatch).join("; ")}`;
}

export const PAYOUT_LIST = "GET /payments?page=1&per_page=6";

export async function listTransactions(z: ZeptoApi, parentRef: string): Promise<string> {
  const rows = await z.transactions({ parent_ref: parentRef, both_parties: "true" });
  return rows.length ? `${rows.length} transaction${rows.length === 1 ? "" : "s"} for batch ${parentRef}, newest first: ${rows.map(describeTransaction).join("; ")}` : `no transactions for batch ${parentRef}`;
}

export async function agreementRecord(z: ZeptoApi, uid: string): Promise<Omit<CaseRecord, "id">> {
  const a = await z.getAgreement(uid);
  const t = a.payment_terms;
  return providerRecord(iso(), `GET /payto/agreements/${uid}`, `agreement state "${a.state}", ${t.type} ${aud(t.amount ?? 0)} ${t.frequency}, first payment ${shortDate(t.first_payment_date ?? "")}, last ${shortDate(t.last_payment_date ?? "")}, debtor ${a.debtor.party_name}${a.state_reason ? `, state reason ${a.state_reason.code} ${a.state_reason.title}` : ""}`);
}

/**
 * Replace one provider method for the duration of fn, the way the review suite
 * injects a lost answer or a shaped response, then put it back whatever happens.
 */
export async function withPatched<K extends keyof ZeptoApi>(z: ZeptoApi, method: K, replacement: ZeptoApi[K], fn: () => Promise<void>): Promise<void> {
  const original = z[method];
  (z as unknown as Record<K, ZeptoApi[K]>)[method] = replacement;
  try {
    await fn();
  } finally {
    (z as unknown as Record<K, ZeptoApi[K]>)[method] = original;
  }
}

export const lostAnswer = (path: string) => new ZeptoError({ status: 0, title: "Network error", detail: "No answer from the provider within 10 seconds", path });

/**
 * A loan brought to "funded, agreement active" through the real code paths, with
 * the gaps a desk would see between steps. Returns the loan id.
 */
export async function fundedLoan(opts: { borrower: string; principalCents: number; termFortnights?: number; clock: Clock; mandate?: boolean; verify?: "match" | "close_match" }): Promise<string> {
  const borrower = getBorrower(opts.borrower);
  if (!borrower) throw new Error(`Seed borrower ${opts.borrower} is missing`);
  await domain.verifyBorrower(borrower.id, opts.verify ?? "match");
  const loan = domain.createLoan({ borrowerId: borrower.id, principalCents: opts.principalCents, termFortnights: opts.termFortnights ?? 4, purpose: "Synthetic investigator case" });
  opts.clock.advance(2 * MIN);
  await domain.disburse(loan.id);
  opts.clock.advance(15_000);
  await domain.refreshLoan(loan.id);
  if (getLoan(loan.id)!.status !== "disbursed") throw new Error(`${loan.id}: not disbursed (${getLoan(loan.id)!.status})`);
  if (opts.mandate !== false) {
    opts.clock.advance(3 * MIN);
    await domain.createMandate(loan.id, { delay: 120 });
    opts.clock.advance(121_000);
    await domain.refreshLoan(loan.id);
    if (getLoan(loan.id)!.mandate?.state !== "active") throw new Error(`${loan.id}: agreement did not activate`);
    opts.clock.advance(MIN);
  }
  return loan.id;
}

/** Collect instalment n and let it resolve (settled by default), through the real code. */
export async function collectAndResolve(loanId: string, n: number, clock: Clock, simulate: PaytoPaymentSimulate = "auto_settle"): Promise<void> {
  await domain.collect(loanId, n, { simulate, delay: 3 });
  clock.advance(3_100);
  await domain.refreshLoan(loanId);
}

/** Send instalment n and lose the answer; the provider accepts it (or never sees it). */
export async function collectLost(loanId: string, n: number, reach: "accepted" | "never", outcome: PaytoPaymentSimulate, outcomeDelaySeconds: number): Promise<string> {
  const z = getZepto();
  const original = (Object.getPrototypeOf(z) as ZeptoApi).createPaytoPayment.bind(z);
  let lost: unknown = null;
  await withPatched(
    z,
    "createPaytoPayment",
    async (input) => {
      if (reach === "accepted") await original({ ...input, simulate: outcome, delay: outcomeDelaySeconds });
      throw lostAnswer("/payto/payments");
    },
    async () => {
      try {
        await domain.collect(loanId, n, { simulate: outcome, delay: outcomeDelaySeconds });
      } catch (err) {
        lost = err;
      }
    },
  );
  if (!(lost instanceof ZeptoError) || !lost.outcomeUnknown) throw new Error(`${loanId}: the lost answer was not injected`);
  const inst = getLoan(loanId)!.instalments.find((i) => i.n === n)!;
  if (inst.state !== "unknown" || !inst.paymentUid) throw new Error(`${loanId}: instalment ${n} is not in the unknown state`);
  return inst.paymentUid;
}

export type SealInput = {
  type: ExceptionType;
  n: number;
  title: string;
  loanId: string;
  question: string;
  providerRecords: Omit<CaseRecord, "id">[];
  notes: { at: string; who: string; text: string }[];
  diagnosis: Diagnosis;
  nextStep: NextStep;
  /** Kinds (or kind prefixes) of the records a correct briefing has to cite; resolved to ids after numbering. */
  mustCiteKinds: string[];
  tempting?: string;
  preparedEvidence?: { record: Omit<CaseRecord, "id">; label: string; diagnosis: Diagnosis; nextStep: NextStep; mustCiteKinds?: string[] };
  includeAppLog?: boolean;
};

const CODE: Record<ExceptionType, string> = { timeout: "T1", duplicate: "T2", orphan_provider_record: "T3", late_cop_failure: "T4", returned_payout: "T5", amount_mismatch: "T6" };

/** Capture Brolga's side, add the provider's and people's records, number everything, resolve the label's ids. */
export function sealCase(input: SealInput): InvestigatorCase {
  const loan: Loan = getLoan(input.loanId)!;
  const borrower = getBorrower(loan.borrowerId)!;
  const records: Omit<CaseRecord, "id">[] = [...brolgaRecords(loan, borrower)];
  if (input.includeAppLog !== false) records.push(...appLogErrorRecords(loan.id));
  records.push(...input.providerRecords);
  for (const note of input.notes) records.push(supportNote(note.at, note.who, note.text));
  const withIds = assignIds(records);
  const resolve = (kinds: string[]) => {
    const ids = kinds.map((k) => withIds.find((r) => r.kind === k || r.kind.startsWith(k))?.id);
    const missing = kinds.filter((_, i) => !ids[i]);
    if (missing.length) throw new Error(`${CODE[input.type]}-${input.n}: required record kind(s) not in the file: ${missing.join(", ")}`);
    return [...new Set(ids as string[])];
  };
  const expected: Expected = { diagnosis: input.diagnosis, nextStep: input.nextStep, mustCite: resolve(input.mustCiteKinds), tempting: input.tempting };
  const c: InvestigatorCase = {
    id: `${CODE[input.type]}-${String(input.n).padStart(2, "0")}`,
    type: input.type,
    title: input.title,
    loanId: loan.id,
    createdAt: iso(),
    question: input.question,
    records: withIds,
    evidence: [],
    expected,
    runs: [],
    marks: [],
  };
  if (input.preparedEvidence) {
    const pe = input.preparedEvidence;
    c.preparedEvidence = [{ ...pe.record, label: pe.label }];
    c.expectedAfterEvidence = { diagnosis: pe.diagnosis, nextStep: pe.nextStep, mustCite: resolve(pe.mustCiteKinds ?? input.mustCiteKinds.slice(0, 1)) };
  }
  return c;
}

export function minutesAfter(at: string, minutes: number): string {
  return new Date(Date.parse(at) + minutes * MIN).toISOString();
}
