import { getZepto, withApiContext, ZeptoError } from "../zepto";
import type { BankAccount, CopSimulate, AgreementSimulate, PaytoPaymentSimulate, PayoutChannel, SuspensionReason, CancellationReason } from "../zepto";
import { loadDb, saveDb, nextId, runId, pushEvent, getBorrower, getLoan, type Loan, type Borrower, type Instalment, type LoanStatus, type Disbursement } from "../db";
import { sydneyDate, addDays, nowIsoSeconds, aud, shortDate } from "../format";

export const LENDER_NAME = "Brolga Credit";
export const ESTABLISHMENT_FEE_BPS = 400; // 4% flat establishment fee, no interest — keeps the maths legible on screen
const FINAL_PAYOUT_STATES = new Set(["cleared", "returned", "rejected", "voided"]);
const FINAL_INSTALMENT_STATES = new Set(["settled", "failed"]);

// ---------------------------------------------------------------------------
// Funding source: prefer an NPP-capable float; otherwise the primary linked
// bank account (Direct Entry only). The choice is surfaced in the UI because it
// is the single biggest determinant of the borrower experience.
// ---------------------------------------------------------------------------
export type Funding = {
  account: BankAccount;
  channels: PayoutChannel[];
  nppCapable: boolean;
  label: string;
  allAccounts: BankAccount[];
};

export async function funding(): Promise<Funding> {
  const z = getZepto();
  const accounts = await z.bankAccounts();
  const float = accounts.find((a) => a.account_type === "float_account" && a.status === "active");
  if (float) {
    return {
      account: float,
      channels: ["new_payments_platform", "direct_entry"],
      nppCapable: true,
      label: `${float.title} · float ${float.branch_code} ${float.account_number}`,
      allAccounts: accounts,
    };
  }
  const primary = accounts.find((a) => a.status === "active") ?? accounts[0];
  return {
    account: primary,
    channels: ["direct_entry"],
    nppCapable: false,
    label: `${primary.bank_name} ${primary.branch_code} ····${primary.account_number.slice(-4)} (linked account, Direct Entry only)`,
    allAccounts: accounts,
  };
}

// ---------------------------------------------------------------------------
// Borrowers
// ---------------------------------------------------------------------------
export function addBorrower(input: { name: string; email: string; bsb: string; accountNumber: string }): Borrower {
  const db = loadDb();
  const b: Borrower = {
    id: nextId("borrower"),
    name: input.name.trim(),
    email: input.email.trim(),
    bsb: input.bsb.replace(/\D/g, ""),
    accountNumber: input.accountNumber.replace(/\D/g, ""),
    createdAt: new Date().toISOString(),
  };
  db.borrowers.push(b);
  saveDb();
  return b;
}

export async function ensureContact(borrower: Borrower): Promise<Borrower> {
  if (borrower.zeptoContactId) return borrower;
  const z = getZepto();
  // Reuse an existing Zepto contact for this account (a demo reset forgets local
  // state, but the sandbox remembers) rather than minting duplicates.
  const contact = await withApiContext(`${borrower.id} · register payee`, async () => {
    const existing = (await z.findContacts({ branch_code: borrower.bsb, account_number: borrower.accountNumber })).find((c) => c.bank_account.state === "active");
    if (existing) return existing;
    return z.createContact({
      name: borrower.name,
      email: borrower.email,
      branch_code: borrower.bsb,
      account_number: borrower.accountNumber,
      metadata: { borrower_id: borrower.id, app: "brolga-credit" },
    });
  });
  borrower.zeptoContactId = contact.id;
  borrower.zeptoContactRef = contact.ref;
  borrower.bankName = contact.bank_account.bank_name;
  saveDb();
  return borrower;
}

export async function verifyBorrower(borrowerId: string, simulate?: CopSimulate): Promise<Borrower> {
  const borrower = getBorrower(borrowerId);
  if (!borrower) throw new Error(`Unknown borrower ${borrowerId}`);
  const z = getZepto();
  const uid = `brolga-${runId()}-cop-${borrower.id.toLowerCase()}-${Date.now().toString(36)}`;
  try {
    const r = await withApiContext(`${borrower.id} · confirmation of payee`, () =>
      z.validateAccount({ uid, party_name: borrower.name, bban: `${borrower.bsb}-${borrower.accountNumber}`, requester_id: "brolga-loan-desk", simulate }),
    );
    borrower.cop = {
      uid,
      result: r.outcome.result,
      matchName: r.outcome.match_name ?? null,
      riskScore: r.insights?.risk_score,
      suggestedChannels: r.insights?.suggested_payment_channels,
      simulated: simulate,
      checkedAt: new Date().toISOString(),
    };
  } catch (err) {
    if (err instanceof ZeptoError) {
      const error = err.requiredScope
        ? `Scope "${err.requiredScope}" missing on this token`
        : err.status === 403
          ? "Confirmation of Payee (Zepto Validate) is not enabled on this sandbox account — Zepto switches it on per account"
          : `${err.code ?? err.status} ${err.title}: ${err.detail}`;
      borrower.cop = { uid, result: "error", simulated: simulate, checkedAt: new Date().toISOString(), error };
    } else throw err;
  }
  saveDb();
  return borrower;
}

// ---------------------------------------------------------------------------
// Loans
// ---------------------------------------------------------------------------
export function quote(principalCents: number, termFortnights: number) {
  const fee = Math.round((principalCents * ESTABLISHMENT_FEE_BPS) / 10_000);
  const instalment = Math.ceil((principalCents + fee) / termFortnights);
  const total = instalment * termFortnights;
  return { principalCents, feeCents: total - principalCents, instalmentCents: instalment, totalCents: total, termFortnights };
}

export function createLoan(input: { borrowerId: string; principalCents: number; termFortnights: number; purpose: string }): Loan {
  const db = loadDb();
  const borrower = getBorrower(input.borrowerId);
  if (!borrower) throw new Error(`Unknown borrower ${input.borrowerId}`);
  if (input.principalCents < 10_000 || input.principalCents > 5_000_000) throw new Error("Principal must be between $100 and $50,000");
  if (input.termFortnights < 1 || input.termFortnights > 26) throw new Error("Term must be between 1 and 26 fortnights");
  const q = quote(input.principalCents, input.termFortnights);
  const today = sydneyDate();
  const instalments: Instalment[] = Array.from({ length: q.termFortnights }, (_, i) => ({
    n: i + 1,
    dueDate: addDays(today, 14 * i),
    amountCents: q.instalmentCents,
    state: "scheduled",
    attempts: 0,
  }));
  const now = new Date().toISOString();
  const loan: Loan = {
    id: nextId("loan"),
    borrowerId: borrower.id,
    purpose: input.purpose,
    principalCents: q.principalCents,
    feeCents: q.feeCents,
    termFortnights: q.termFortnights,
    instalmentCents: q.instalmentCents,
    status: borrower.cop && borrower.cop.result !== "error" ? "verified" : "draft",
    instalments,
    events: [],
    createdAt: now,
    updatedAt: now,
  };
  pushEvent(loan, "loan.created", `Loan created for ${borrower.name}: ${aud(q.principalCents)} over ${q.termFortnights} fortnights, ${aud(q.instalmentCents)} per instalment`);
  db.loans.push(loan);
  saveDb();
  return loan;
}

export function disbursementSettled(d: Disbursement | null | undefined): "pending" | "cleared" | "failed" {
  if (!d) return "pending";
  if (["returned", "rejected", "voided"].includes(d.status) || d.creditStatus === "returned" || d.creditStatus === "rejected" || d.creditStatus === "voided") return "failed";
  // The debit clearing only means money left Brolga's account; funds have landed
  // when the borrower-side credit clears. NPP reports both within seconds; DE in
  // the sandbox takes a couple of one-minute cycles.
  if (d.status === "cleared" && d.creditStatus === "cleared") return "cleared";
  return "pending";
}

export function deriveStatus(loan: Loan): LoanStatus {
  if (loan.status === "cancelled") return "cancelled";
  const d = loan.disbursement;
  const m = loan.mandate;
  if (!d) return loan.status === "verified" ? "verified" : "draft";
  const settled = disbursementSettled(d);
  if (settled === "failed") return "disbursement_failed";
  if (settled === "pending") return "disbursing";
  if (!m) return "disbursed";
  if (m.state === "pending" || m.state === "created") return "mandate_pending";
  if (m.state === "declined" || m.state === "expired" || m.state === "failed") return "disbursed";
  if (m.state === "cancelled") return loan.instalments.every((i) => i.state === "settled") ? "closed" : "cancelled";
  if (m.state === "suspended") return "suspended";
  if (loan.instalments.every((i) => i.state === "settled")) return "closed";
  if (loan.instalments.some((i) => i.state === "failed")) return "in_arrears";
  return "active";
}

function settle(loan: Loan) {
  loan.status = deriveStatus(loan);
  loan.updatedAt = new Date().toISOString();
  saveDb();
}

export async function disburse(loanId: string, opts: { forceFailure?: "de_account_not_found" | "npp_not_enabled" } = {}): Promise<Loan> {
  const loan = getLoan(loanId);
  if (!loan) throw new Error(`Unknown loan ${loanId}`);
  if (loan.disbursement && disbursementSettled(loan.disbursement) !== "failed") throw new Error("This loan already has a disbursement in flight or completed");
  const borrower = await ensureContact(getBorrower(loan.borrowerId)!);
  const f = await withApiContext(`${loan.id} · choose funding account`, funding);
  const z = getZepto();

  // Sandbox failures are amount-driven ($1.05 → E105, $3.03 → E303). To demo a failed
  // disbursement we send the special amount and say so loudly in the event log.
  let amount = loan.principalCents;
  if (opts.forceFailure === "de_account_not_found") amount = 105;
  if (opts.forceFailure === "npp_not_enabled") amount = 303;
  const channels: PayoutChannel[] = opts.forceFailure === "npp_not_enabled" && f.nppCapable ? ["new_payments_platform", "direct_entry"] : f.channels;

  const key = `brolga-${runId()}-${loan.id.toLowerCase()}-disburse-${loan.disbursement ? Date.now().toString(36) : "1"}`;
  const batch = await withApiContext(`${loan.id} · disburse`, () =>
    z.createPayment({
      description: `${LENDER_NAME} loan ${loan.id} disbursement`,
      matures_at: nowIsoSeconds(),
      channels,
      your_bank_account_id: f.account.id,
      metadata: { loan_id: loan.id, borrower_id: borrower.id, app: "brolga-credit" },
      payouts: [
        {
          amount,
          description: `${LENDER_NAME} ${loan.id}`.slice(0, 280),
          recipient_contact_id: borrower.zeptoContactId!,
          metadata: { loan_id: loan.id },
        },
      ],
      idempotency_key: key,
    }),
  );
  const payout = batch.payouts[0];
  const now = new Date().toISOString();
  loan.disbursement = {
    paymentRef: batch.ref,
    payoutRef: payout.ref,
    status: payout.status,
    channels: batch.channels,
    currentChannel: batch.channels[0],
    fromBankAccountId: f.account.id,
    fundingLabel: f.label,
    failure: null,
    createdAt: now,
    updatedAt: now,
  };
  pushEvent(
    loan,
    "disbursement.created",
    `${aud(amount)} sent to ${borrower.name} via ${channels[0] === "new_payments_platform" ? "NPP (real-time), Direct Entry fallback" : "Direct Entry"} from ${f.account.bank_name} — batch ${batch.ref}, payout ${payout.ref}` +
      (opts.forceFailure ? ` (deliberate sandbox failure amount ${aud(amount)})` : ""),
    "info",
    batch.ref,
  );
  settle(loan);
  return loan;
}

export async function createMandate(loanId: string, opts: { simulate?: AgreementSimulate; delay?: number } = {}): Promise<Loan> {
  const loan = getLoan(loanId);
  if (!loan) throw new Error(`Unknown loan ${loanId}`);
  const borrower = getBorrower(loan.borrowerId)!;
  if (loan.mandate && ["pending", "created", "active", "suspended"].includes(loan.mandate.state)) throw new Error("This loan already has a live PayTo agreement");
  const f = await withApiContext(`${loan.id} · choose collection account`, funding);
  const z = getZepto();
  const first = loan.instalments[0].dueDate;
  const last = loan.instalments[loan.instalments.length - 1].dueDate;
  const validityEnd = addDays(last, 14);
  const attempt = loan.mandate ? Date.now().toString(36) : "1";
  const uid = `brolga-${runId()}-${loan.id.toLowerCase()}-agr-${attempt}`;
  const agreement = await withApiContext(`${loan.id} · create PayTo agreement`, () =>
    z.createAgreement({
      uid,
      purpose: "loan",
      description: `${LENDER_NAME} loan ${loan.id} repayments`,
      validity_start_date: sydneyDate(),
      validity_end_date: validityEnd,
      debtor: { party_name: borrower.name, account_identifier: { type: "bban", value: `${borrower.bsb}-${borrower.accountNumber}` } },
      creditor: {
        party_name: LENDER_NAME,
        ultimate_party_name: LENDER_NAME,
        account_identifier: { type: "bban", value: `${f.account.branch_code}-${f.account.account_number}` },
      },
      payment_terms: { type: "fixed", frequency: "fortnightly", amount: loan.instalmentCents, count: 1, first_payment_date: first, last_payment_date: last },
      metadata: { loan_id: loan.id, borrower_id: borrower.id, app: "brolga-credit" },
      simulate: opts.simulate ?? "debtor_accept",
      delay: opts.delay ?? 4,
    }),
  );
  const now = new Date().toISOString();
  loan.mandate = {
    uid: agreement.uid,
    state: agreement.state,
    stateReason: agreement.state_reason ?? null,
    stateCausedBy: agreement.state_caused_by ?? null,
    mmsAgreementId: agreement.mms_agreement_id,
    firstPaymentDate: first,
    lastPaymentDate: last,
    validityEndDate: validityEnd,
    instalmentCents: loan.instalmentCents,
    pendingAmendment: null,
    createdAt: now,
    updatedAt: now,
  };
  pushEvent(loan, "mandate.created", `PayTo agreement ${agreement.uid} sent to ${borrower.name}'s bank for authorisation: ${aud(loan.instalmentCents)} fortnightly, ${shortDate(first)} to ${shortDate(last)}`, "info", agreement.uid);
  settle(loan);
  return loan;
}

export async function collect(loanId: string, n: number, opts: { simulate?: PaytoPaymentSimulate; delay?: number } = {}): Promise<Loan> {
  const loan = getLoan(loanId);
  if (!loan) throw new Error(`Unknown loan ${loanId}`);
  const inst = loan.instalments.find((i) => i.n === n);
  if (!inst) throw new Error(`No instalment ${n}`);
  if (!loan.mandate || loan.mandate.state !== "active") throw new Error("The PayTo agreement is not active, so nothing can be collected");
  if (inst.state !== "scheduled" && inst.state !== "failed") throw new Error(`Instalment ${n} is ${inst.state}`);
  const z = getZepto();
  inst.attempts += 1;
  const uid = `brolga-${runId()}-${loan.id.toLowerCase()}-inst-${n}-${inst.attempts}`;
  const p = await withApiContext(`${loan.id} · collect instalment ${n}`, () =>
    z.createPaytoPayment({
      uid,
      agreement_uid: loan.mandate!.uid,
      amount: loan.mandate!.instalmentCents,
      reference: `${LENDER_NAME} ${loan.id} ${n}/${loan.termFortnights}`.slice(0, 35),
      description: `${LENDER_NAME} loan ${loan.id} instalment ${n} of ${loan.termFortnights}`,
      creditor_reference: `${loan.id}-${n}`,
      metadata: { loan_id: loan.id, instalment: String(n), app: "brolga-credit" },
      last_payment: n === loan.termFortnights ? true : undefined,
      simulate: opts.simulate ?? "auto_settle",
      delay: opts.delay ?? 3,
    }),
  );
  inst.paymentUid = p.uid;
  inst.state = p.state;
  inst.failure = p.failure ?? null;
  inst.updatedAt = new Date().toISOString();
  pushEvent(loan, "instalment.initiated", `Instalment ${n} (${aud(inst.amountCents)}) initiated via PayTo — payment ${p.uid}`, "info", p.uid);
  settle(loan);
  return loan;
}

export async function retryInstalment(loanId: string, n: number, opts: { simulate?: PaytoPaymentSimulate; delay?: number } = {}): Promise<Loan> {
  const loan = getLoan(loanId);
  if (!loan) throw new Error(`Unknown loan ${loanId}`);
  const inst = loan.instalments.find((i) => i.n === n);
  if (!inst?.paymentUid) throw new Error(`Instalment ${n} has no PayTo payment to retry`);
  if (inst.state !== "failed" || !inst.failure?.retryable) throw new Error(`Instalment ${n} is not retryable`);
  const z = getZepto();
  await withApiContext(`${loan.id} · retry instalment ${n}`, () => z.retryPaytoPayment(inst.paymentUid!, opts.simulate ?? "auto_settle", opts.delay ?? 3));
  inst.attempts += 1;
  inst.state = "created";
  inst.failure = null;
  inst.updatedAt = new Date().toISOString();
  pushEvent(loan, "instalment.retried", `Instalment ${n} retried (attempt ${inst.attempts})`, "info", inst.paymentUid);
  settle(loan);
  return loan;
}

export async function suspendMandate(loanId: string, narrative: string, reason: SuspensionReason = "customer_requested"): Promise<Loan> {
  const loan = getLoan(loanId);
  if (!loan?.mandate) throw new Error("No PayTo agreement on this loan");
  const z = getZepto();
  await withApiContext(`${loan.id} · suspend agreement`, () => z.suspendAgreement(loan.mandate!.uid, reason, narrative));
  pushEvent(loan, "mandate.suspension_requested", `Suspension requested (${reason}): ${narrative}`, "warning", loan.mandate.uid);
  return refreshLoan(loanId);
}

export async function reactivateMandate(loanId: string): Promise<Loan> {
  const loan = getLoan(loanId);
  if (!loan?.mandate) throw new Error("No PayTo agreement on this loan");
  const z = getZepto();
  await withApiContext(`${loan.id} · reactivate agreement`, () => z.reactivateAgreement(loan.mandate!.uid));
  pushEvent(loan, "mandate.reactivation_requested", "Reactivation requested", "info", loan.mandate.uid);
  return refreshLoan(loanId);
}

export async function debtorAction(loanId: string, action: "suspension" | "reactivation" | "cancellation", narrative: string): Promise<Loan> {
  const loan = getLoan(loanId);
  if (!loan?.mandate) throw new Error("No PayTo agreement on this loan");
  const z = getZepto();
  await withApiContext(`${loan.id} · simulate borrower ${action}`, () => z.simulateDebtorAction(loan.mandate!.uid, action, narrative));
  pushEvent(loan, `mandate.debtor_${action}`, `Borrower ${action} from their banking app: ${narrative}`, "warning", loan.mandate.uid);
  return refreshLoan(loanId);
}

export async function amendMandate(loanId: string, newInstalmentCents: number, opts: { simulate?: "debtor_accept" | "debtor_decline" | "expire"; delay?: number } = {}): Promise<Loan> {
  const loan = getLoan(loanId);
  if (!loan?.mandate) throw new Error("No PayTo agreement on this loan");
  if (newInstalmentCents < 100) throw new Error("Instalment must be at least $1");
  const z = getZepto();
  const changes = { payment_terms: { amount: newInstalmentCents } };
  await withApiContext(`${loan.id} · amend agreement`, () => z.amendAgreement(loan.mandate!.uid, changes, opts.simulate ?? "debtor_accept", opts.delay ?? 4));
  loan.mandate.pendingAmendment = { requestedAt: new Date().toISOString(), changes };
  pushEvent(loan, "mandate.amendment_requested", `Amendment sent for authorisation: instalment ${aud(loan.mandate.instalmentCents)} → ${aud(newInstalmentCents)}`, "info", loan.mandate.uid);
  settle(loan);
  return loan;
}

export async function cancelMandate(loanId: string, reason: CancellationReason, narrative: string): Promise<Loan> {
  const loan = getLoan(loanId);
  if (!loan?.mandate) throw new Error("No PayTo agreement on this loan");
  const z = getZepto();
  await withApiContext(`${loan.id} · cancel agreement`, () => z.cancelAgreement(loan.mandate!.uid, reason, narrative));
  pushEvent(loan, "mandate.cancellation_requested", `Cancellation requested (${reason}): ${narrative}`, "warning", loan.mandate.uid);
  return refreshLoan(loanId);
}

// ---------------------------------------------------------------------------
// Refresh: pull the latest state of everything in flight. Brolga polls rather
// than relying on webhooks so the demo needs no public URL; the same code path
// would be driven by webhook events in production.
// ---------------------------------------------------------------------------
export async function refreshLoan(loanId: string): Promise<Loan> {
  const loan = getLoan(loanId);
  if (!loan) throw new Error(`Unknown loan ${loanId}`);
  const z = getZepto();
  const borrower = getBorrower(loan.borrowerId)!;

  await withApiContext(`${loan.id} · refresh`, async () => {
    const d = loan.disbursement;
    if (d && disbursementSettled(d) === "pending") {
      // Debit side (money leaving Brolga's account).
      if (!FINAL_PAYOUT_STATES.has(d.status)) {
        const batch = await z.getPayment(d.paymentRef);
        const payout = batch.payouts.find((p) => p.ref === d.payoutRef) ?? batch.payouts[0];
        if (payout && payout.status !== d.status) {
          const prev = d.status;
          d.status = payout.status;
          d.updatedAt = new Date().toISOString();
          if (payout.status === "channel_switched") {
            d.currentChannel = "direct_entry";
            pushEvent(loan, "disbursement.channel_switched", "NPP payment failed; Zepto switched the payout to Direct Entry automatically", "warning", d.payoutRef);
          } else if (payout.status === "cleared") {
            pushEvent(loan, "disbursement.debit_cleared", `Debit ${d.payoutRef} cleared from ${LENDER_NAME}'s account — waiting for ${borrower.name}'s bank to confirm the credit`, "info", d.payoutRef);
          } else if (payout.status === "returned" || payout.status === "rejected" || payout.status === "voided") {
            d.failure = payout.reversal_details?.source_credit_failure ?? d.failure ?? null;
            pushEvent(loan, "disbursement.failed", `Payout ${payout.status}${d.failure ? `: ${d.failure.code} ${d.failure.title}` : ""}`, "error", d.payoutRef);
          } else {
            pushEvent(loan, "disbursement.status", `Payout ${d.payoutRef}: ${prev} → ${payout.status}`, "info", d.payoutRef);
          }
        }
      }
      // Credit side (money arriving in the borrower's account). Only visible with
      // both_parties=true; a returned credit is followed by a payout_reversal.
      if (disbursementSettled(d) === "pending") {
        const tx = await z.transactions({ parent_ref: d.paymentRef, both_parties: "true" });
        const credit = tx.find((t) => t.type === "credit" && t.category === "payout");
        const reversal = tx.find((t) => t.type === "credit" && t.category === "payout_reversal");
        if (credit) {
          if (credit.ref !== d.creditRef) d.creditRef = credit.ref;
          if (credit.status !== d.creditStatus) {
            const prev = d.creditStatus;
            d.creditStatus = credit.status;
            d.updatedAt = new Date().toISOString();
            if (credit.status === "cleared") {
              d.clearedAt = credit.cleared_at ?? d.updatedAt;
              pushEvent(loan, "disbursement.cleared", `Funds cleared to ${borrower.name}'s ${borrower.bankName ?? "bank"} account (credit ${credit.ref})`, "success", credit.ref);
            } else if (credit.status === "returned" || credit.status === "rejected") {
              d.failure = credit.failure ?? reversal?.reversal_details?.source_credit_failure ?? null;
              pushEvent(loan, "disbursement.failed", `${borrower.name}'s bank returned the payment${d.failure ? `: ${d.failure.code} ${d.failure.title}` : ""}${credit.failure_details ? ` (${credit.failure_details})` : ""}. Zepto will reverse the funds to ${LENDER_NAME}.`, "error", credit.ref);
            } else if (prev) {
              pushEvent(loan, "disbursement.credit_status", `Credit ${credit.ref}: ${prev} → ${credit.status}`, "info", credit.ref);
            }
          }
        }
        if (reversal && reversal.ref !== d.reversalRef) {
          d.reversalRef = reversal.ref;
          pushEvent(loan, "disbursement.reversed", `Reversal ${reversal.ref} (${aud(reversal.amount)}) ${reversal.status} back to ${LENDER_NAME}`, "warning", reversal.ref);
        }
      }
    }

    const m = loan.mandate;
    if (m && !["declined", "expired", "failed", "cancelled"].includes(m.state)) {
      const a = await z.getAgreement(m.uid);
      const changed = a.state !== m.state;
      const amendmentResolved = m.pendingAmendment && a.payment_terms.amount !== undefined && a.payment_terms.amount !== m.instalmentCents;
      if (changed) {
        const prev = m.state;
        m.state = a.state;
        m.stateReason = a.state_reason ?? null;
        m.stateCausedBy = a.state_caused_by ?? null;
        m.mmsAgreementId = a.mms_agreement_id;
        m.updatedAt = new Date().toISOString();
        const level = a.state === "active" ? "success" : ["declined", "expired", "failed", "cancelled"].includes(a.state) ? "error" : "warning";
        const who = a.state_caused_by === "debtor" ? "by the borrower" : a.state_caused_by === "initiator" ? `by ${LENDER_NAME}` : "by Zepto";
        pushEvent(loan, `mandate.${a.state}`, `PayTo agreement ${prev} → ${a.state} ${who}${a.state_reason ? ` (${a.state_reason.code} ${a.state_reason.title})` : ""}${a.mms_agreement_id && a.state === "active" ? ` · MMS id ${a.mms_agreement_id}` : ""}`, level, m.uid);
      }
      if (amendmentResolved) {
        const newAmt = a.payment_terms.amount!;
        pushEvent(loan, "mandate.amended", `Borrower authorised the amendment: instalment now ${aud(newAmt)}`, "success", m.uid);
        m.instalmentCents = newAmt;
        m.pendingAmendment = null;
        for (const i of loan.instalments) if (i.state === "scheduled" || i.state === "failed") i.amountCents = newAmt;
      } else if (m.pendingAmendment && Date.now() - Date.parse(m.pendingAmendment.requestedAt) > 20_000) {
        // Look at history to see whether it was declined/expired.
        const hist = await z.agreementHistory(m.uid);
        const after = hist.filter((h) => Date.parse(h.published_at) >= Date.parse(m.pendingAmendment!.requestedAt) - 1000);
        const bad = after.find((h) => /amendment_(declined|expired|failed|recalled)/.test(h.type));
        if (bad) {
          pushEvent(loan, "mandate.amendment_failed", `Amendment ${bad.type.replace("payto_agreement.", "").replace("_", " ")} — instalment stays at ${aud(m.instalmentCents)}`, "warning", m.uid);
          m.pendingAmendment = null;
        }
      }
    }

    for (const inst of loan.instalments) {
      if (inst.paymentUid && !FINAL_INSTALMENT_STATES.has(inst.state)) {
        const p = await z.getPaytoPayment(inst.paymentUid);
        if (p.state !== inst.state) {
          inst.state = p.state;
          inst.failure = p.failure ?? null;
          inst.updatedAt = new Date().toISOString();
          if (p.state === "settled") pushEvent(loan, "instalment.settled", `Instalment ${inst.n} settled — ${aud(inst.amountCents)} received in real time`, "success", p.uid);
          else if (p.state === "failed") pushEvent(loan, "instalment.failed", `Instalment ${inst.n} failed: ${p.failure?.code} ${p.failure?.title}${p.failure?.retryable ? " (retryable)" : " (not retryable)"}`, "error", p.uid);
          else if (p.state === "under_investigation") pushEvent(loan, "instalment.investigation", `Instalment ${inst.n} is under investigation by the borrower's bank`, "warning", p.uid);
        }
      }
    }
  });

  settle(loan);
  return loan;
}

export function hasInFlight(loan: Loan): boolean {
  const d = loan.disbursement;
  if (d && disbursementSettled(d) === "pending") return true;
  const m = loan.mandate;
  if (m && (m.state === "pending" || m.state === "created" || m.pendingAmendment)) return true;
  return loan.instalments.some((i) => i.paymentUid && !FINAL_INSTALMENT_STATES.has(i.state));
}

export function nextCollectable(loan: Loan): { instalment: Instalment; reason?: string } | { instalment: null; reason: string } {
  if (!loan.mandate || loan.mandate.state !== "active") return { instalment: null, reason: "PayTo agreement is not active" };
  const next = loan.instalments.find((i) => i.state === "scheduled" || i.state === "failed");
  if (!next) return { instalment: null, reason: "All instalments settled" };
  const today = sydneyDate();
  if (next.state === "failed") return { instalment: next };
  if (next.dueDate > today) return { instalment: next, reason: `Agreement permits one payment per fortnight; instalment ${next.n} opens on ${shortDate(next.dueDate)}` };
  return { instalment: next };
}
