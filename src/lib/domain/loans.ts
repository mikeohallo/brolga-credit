import { getZepto, withApiContext, ZeptoError } from "../zepto";
import type { BankAccount, CopSimulate, AgreementSimulate, PaytoPaymentSimulate, PayoutChannel, SuspensionReason, CancellationReason } from "../zepto";
import { loadDb, saveDb, nextId, runId, pushEvent, getBorrower, getLoan, type Loan, type Borrower, type Instalment, type LoanStatus, type Disbursement } from "../db";
import { sydneyDate, addDays, nowIsoSeconds, aud, shortDate } from "../format";

export const LENDER_NAME = "Brolga Credit";
export const ESTABLISHMENT_FEE_BPS = 400; // 4% flat establishment fee, no interest — keeps the maths legible on screen
const FINAL_PAYOUT_STATES = new Set(["cleared", "returned", "rejected", "voided"]);
const FINAL_INSTALMENT_STATES = new Set(["settled", "failed"]);
const IN_FLIGHT_INSTALMENT_STATES = new Set(["unknown", "created", "submitting", "pending", "under_investigation"]);
const REVERSAL_WATCH_MS = 60 * 60 * 1000; // keep looking for the payout_reversal for an hour after a failure

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
      // A refusal is recorded as "unavailable", never as a pass and never as a
      // definite diagnosis: the usual cause on a sandbox is that Zepto Validate has
      // not been switched on for the account, but the API does not say so.
      const error =
        err.status === 403
          ? `Zepto refused the Confirmation of Payee request (403${err.detail ? `: ${err.detail}` : ""}). Recorded as unavailable; the cause is unconfirmed — account-level access to Zepto Validate is the usual reason on a sandbox.`
          : `${err.code ?? err.status} ${err.title}: ${err.detail}`;
      borrower.cop = { uid, result: "error", simulated: simulate, checkedAt: new Date().toISOString(), error };
    } else throw err;
  }
  saveDb();
  return borrower;
}

// ---------------------------------------------------------------------------
// Loans — quoting, creation, accounting
// ---------------------------------------------------------------------------
export function quote(principalCents: number, termFortnights: number) {
  const fee = Math.round((principalCents * ESTABLISHMENT_FEE_BPS) / 10_000);
  const instalment = Math.ceil((principalCents + fee) / termFortnights);
  const total = instalment * termFortnights;
  return { principalCents, feeCents: total - principalCents, instalmentCents: instalment, totalCents: total, termFortnights };
}

/** What the borrower owes in total: principal + fee ± recorded adjustments. */
export function obligationCents(loan: Loan): number {
  return loan.principalCents + loan.feeCents + (loan.adjustments ?? []).reduce((s, a) => s + a.cents, 0);
}

export function settledCents(loan: Loan): number {
  return loan.instalments.filter((i) => i.state === "settled").reduce((s, i) => s + i.amountCents, 0);
}

export function outstandingCents(loan: Loan): number {
  return obligationCents(loan) - settledCents(loan);
}

export function createLoan(input: { borrowerId: string; principalCents: number; termFortnights: number; purpose: string }): Loan {
  const db = loadDb();
  const borrower = getBorrower(input.borrowerId);
  if (!borrower) throw new Error(`Unknown borrower ${input.borrowerId}`);
  const principalCents = input.principalCents;
  const termFortnights = input.termFortnights;
  if (!Number.isInteger(principalCents) || principalCents < 10_000 || principalCents > 5_000_000) throw new Error("Principal must be a whole number of cents between $100 and $50,000");
  if (!Number.isInteger(termFortnights) || termFortnights < 1 || termFortnights > 26) throw new Error("Term must be a whole number of fortnights between 1 and 26");
  const q = quote(principalCents, termFortnights);
  const today = sydneyDate();
  const instalments: Instalment[] = Array.from({ length: q.termFortnights }, (_, i) => ({
    n: i + 1,
    dueDate: addDays(today, 14 * i),
    amountCents: q.instalmentCents,
    state: "scheduled",
    attempts: 0,
  }));
  const now = new Date().toISOString();
  const copVerified = !!borrower.cop && (borrower.cop.result === "match" || borrower.cop.result === "close_match");
  const copHold = !!borrower.cop && (borrower.cop.result === "no_match" || borrower.cop.result === "account_closed");
  const loan: Loan = {
    id: nextId("loan"),
    borrowerId: borrower.id,
    purpose: (input.purpose || "Personal loan").slice(0, 60),
    principalCents: q.principalCents,
    feeCents: q.feeCents,
    termFortnights: q.termFortnights,
    instalmentCents: q.instalmentCents,
    status: copVerified ? "verified" : "draft",
    copHold,
    copOverride: null,
    disbursementAttempts: 0,
    adjustments: [],
    instalments,
    events: [],
    createdAt: now,
    updatedAt: now,
  };
  pushEvent(loan, "loan.created", `Loan created for ${borrower.name}: ${aud(q.principalCents)} over ${q.termFortnights} fortnights, ${aud(q.instalmentCents)} per instalment`);
  if (copHold) pushEvent(loan, "loan.cop_hold", `Confirmation of Payee returned "${borrower.cop!.result.replace("_", " ")}" — disbursement is held until an override is recorded`, "warning");
  else if (!copVerified) pushEvent(loan, "loan.cop_unavailable", "Confirmation of Payee was not completed for this borrower; the loan is a draft, not verified", "warning");
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
  const d = loan.disbursement;
  const m = loan.mandate;
  if (!d) return loan.status === "verified" || (!loan.copHold && loan.copOverride) ? "verified" : "draft";
  const settled = disbursementSettled(d);
  if (settled === "failed") return "disbursement_failed";
  if (settled === "pending") return "disbursing";
  const repaid = outstandingCents(loan) <= 0 && loan.instalments.every((i) => !IN_FLIGHT_INSTALMENT_STATES.has(i.state));
  if (!m) return repaid ? "closed" : "disbursed";
  if (m.state === "pending" || m.state === "created") return "mandate_pending";
  if (m.state === "declined" || m.state === "expired" || m.state === "failed") return repaid ? "closed" : "disbursed";
  // A cancelled mandate is a cancelled *authority*, not a cancelled loan: the debt
  // is still owed until it is repaid, and a replacement mandate can revive collection.
  if (m.state === "cancelled") return repaid ? "closed" : "cancelled";
  if (m.state === "suspended") return "suspended";
  if (repaid) return "closed";
  if (loan.instalments.some((i) => i.state === "failed")) return "in_arrears";
  return "active";
}

function settle(loan: Loan) {
  loan.status = deriveStatus(loan);
  loan.updatedAt = new Date().toISOString();
  saveDb();
}

// ---------------------------------------------------------------------------
// Disbursement. The idempotency key is persisted as an "intent" BEFORE the request
// goes out and is reused until Zepto answers, so a lost response can never mint a
// second payout: replaying the key returns a 409 with the ref of the payout the
// first attempt created, and that ref is adopted.
// ---------------------------------------------------------------------------
export async function recordCopOverride(loanId: string, by: string, reason: string): Promise<Loan> {
  const loan = getLoan(loanId);
  if (!loan) throw new Error(`Unknown loan ${loanId}`);
  if (!loan.copHold) throw new Error("This loan is not on a Confirmation of Payee hold");
  if (!reason || reason.trim().length < 10) throw new Error("An override needs a reason of at least ten characters — it is audited");
  loan.copOverride = { by: by || "loan officer", reason: reason.trim(), at: new Date().toISOString() };
  loan.copHold = false;
  pushEvent(loan, "loan.cop_override", `Confirmation of Payee hold overridden by ${loan.copOverride.by}: ${loan.copOverride.reason}`, "warning");
  settle(loan);
  return loan;
}

export async function disburse(loanId: string, opts: { forceFailure?: "de_account_not_found" | "npp_not_enabled" } = {}): Promise<Loan> {
  const loan = getLoan(loanId);
  if (!loan) throw new Error(`Unknown loan ${loanId}`);
  if (loan.copHold) throw new Error("Confirmation of Payee did not match this account — disbursement is refused until an override is recorded with a reason");
  if (loan.disbursement && disbursementSettled(loan.disbursement) !== "failed") throw new Error("This loan already has a disbursement in flight or completed");
  const borrower = await ensureContact(getBorrower(loan.borrowerId)!);
  const z = getZepto();

  // Reuse an unresolved intent (the previous attempt got no answer); otherwise mint one.
  let intent = loan.disbursementIntent ?? null;
  if (!intent) {
    const f = await withApiContext(`${loan.id} · choose funding account`, funding);
    // Sandbox failures are amount-driven ($1.05 → E105, $3.03 → E303). To demo a failed
    // disbursement we send the special amount and say so loudly in the event log.
    let amount = loan.principalCents;
    if (opts.forceFailure === "de_account_not_found") amount = 105;
    if (opts.forceFailure === "npp_not_enabled") amount = 303;
    const channels: PayoutChannel[] = opts.forceFailure === "npp_not_enabled" && f.nppCapable ? ["new_payments_platform", "direct_entry"] : f.channels;
    const attempt = (loan.disbursementAttempts ?? 0) + 1;
    intent = {
      key: `brolga-${runId()}-${loan.id.toLowerCase()}-disburse-${attempt}`,
      attempt,
      amountCents: amount,
      channels,
      fromBankAccountId: f.account.id,
      fundingLabel: f.label,
      forceFailure: opts.forceFailure,
      createdAt: new Date().toISOString(),
      outcome: "sending",
    };
    loan.disbursementAttempts = attempt;
    loan.disbursementIntent = intent;
    saveDb();
  } else {
    pushEvent(loan, "disbursement.recovering", `Re-sending disbursement attempt ${intent.attempt} with the same idempotency key — the previous answer was lost`, "warning");
  }

  const adopt = (batch: { ref: string; channels: PayoutChannel[]; payouts: { ref: string; status: string }[] }) => {
    const payout = batch.payouts[0];
    const now = new Date().toISOString();
    loan.disbursement = {
      paymentRef: batch.ref,
      payoutRef: payout.ref,
      status: payout.status,
      channels: batch.channels,
      currentChannel: batch.channels[0],
      fromBankAccountId: intent!.fromBankAccountId,
      fundingLabel: intent!.fundingLabel,
      failure: null,
      attempt: intent!.attempt,
      createdAt: now,
      updatedAt: now,
    };
    loan.disbursementIntent = null;
    pushEvent(
      loan,
      "disbursement.created",
      `${aud(intent!.amountCents)} sent to ${borrower.name} via ${intent!.channels[0] === "new_payments_platform" ? "NPP (real-time), Direct Entry fallback" : "Direct Entry"} — batch ${batch.ref}, payout ${payout.ref}` +
        (intent!.forceFailure ? ` (deliberate sandbox failure amount ${aud(intent!.amountCents)})` : ""),
      "info",
      batch.ref,
    );
  };

  try {
    const batch = await withApiContext(`${loan.id} · disburse`, () =>
      z.createPayment({
        description: `${LENDER_NAME} loan ${loan.id} disbursement`,
        matures_at: nowIsoSeconds(),
        channels: intent!.channels as PayoutChannel[],
        your_bank_account_id: intent!.fromBankAccountId,
        metadata: { loan_id: loan.id, borrower_id: borrower.id, app: "brolga-credit" },
        payouts: [
          {
            amount: intent!.amountCents,
            description: `${LENDER_NAME} ${loan.id}`.slice(0, 280),
            recipient_contact_id: borrower.zeptoContactId!,
            metadata: { loan_id: loan.id },
          },
        ],
        idempotency_key: intent!.key,
      }),
    );
    adopt(batch);
  } catch (err) {
    if (err instanceof ZeptoError && err.status === 409 && typeof err.meta?.resource_ref === "string") {
      // Idempotent replay: Zepto already created this payout on an earlier attempt.
      const ref = err.meta.resource_ref;
      const batch = await withApiContext(`${loan.id} · recover payout ${ref}`, () => z.getPayment(ref));
      pushEvent(loan, "disbursement.recovered", `Zepto reported the payout already existed (${ref}); adopted it instead of paying twice`, "warning", ref);
      adopt(batch);
    } else if (err instanceof ZeptoError && err.outcomeUnknown) {
      intent.outcome = "unknown";
      pushEvent(loan, "disbursement.unknown", `No answer from Zepto for disbursement attempt ${intent.attempt} (${err.title}). The idempotency key is kept; the next attempt re-sends the same request.`, "error");
      settle(loan);
      throw err;
    } else {
      // A definite rejection: the intent is spent, a fresh one is minted next time.
      loan.disbursementIntent = null;
      settle(loan);
      throw err;
    }
  }
  settle(loan);
  return loan;
}

// ---------------------------------------------------------------------------
// PayTo agreement (the repayment mandate)
// ---------------------------------------------------------------------------
export async function createMandate(loanId: string, opts: { simulate?: AgreementSimulate; delay?: number } = {}): Promise<Loan> {
  const loan = getLoan(loanId);
  if (!loan) throw new Error(`Unknown loan ${loanId}`);
  const borrower = getBorrower(loan.borrowerId)!;
  if (loan.mandate && ["pending", "created", "active", "suspended"].includes(loan.mandate.state)) throw new Error("This loan already has a live PayTo agreement");
  if (outstandingCents(loan) <= 0) throw new Error("Nothing is owed on this loan");
  const f = await withApiContext(`${loan.id} · choose collection account`, funding);
  const z = getZepto();
  const open = loan.instalments.filter((i) => i.state !== "settled");
  const first = open[0]?.dueDate ?? loan.instalments[0].dueDate;
  const last = open[open.length - 1]?.dueDate ?? loan.instalments[loan.instalments.length - 1].dueDate;
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

// ---------------------------------------------------------------------------
// Collections. One place decides whether money may be pulled; the route, the UI
// and the retry path all ask it.
// ---------------------------------------------------------------------------
export type Eligibility = { ok: true; instalment: Instalment } | { ok: false; instalment: Instalment | null; reason: string; waiting?: boolean };

export function collectionEligibility(loan: Loan, n?: number): Eligibility {
  const inst = n === undefined ? (loan.instalments.find((i) => i.state === "scheduled" || i.state === "failed" || i.state === "unknown") ?? null) : (loan.instalments.find((i) => i.n === n) ?? null);
  if (n !== undefined && !inst) return { ok: false, instalment: null, reason: `No instalment ${n}` };
  if (loan.copHold) return { ok: false, instalment: inst, reason: "Confirmation of Payee hold — no money moves on this loan" };
  const funded = disbursementSettled(loan.disbursement);
  if (!loan.disbursement) return { ok: false, instalment: inst, reason: "The loan has not been disbursed" };
  if (funded === "failed") return { ok: false, instalment: inst, reason: "The disbursement failed — nothing can be collected on a loan the borrower never received" };
  if (funded === "pending") return { ok: false, instalment: inst, reason: "Waiting for the funds to land in the borrower's account before any repayment is collected", waiting: true };
  if (!loan.mandate || loan.mandate.state !== "active") return { ok: false, instalment: inst, reason: "PayTo agreement is not active" };
  if (loan.mandate.pendingAmendment) return { ok: false, instalment: inst, reason: "An amendment is awaiting the borrower's authorisation", waiting: true };
  if (!inst) return { ok: false, instalment: null, reason: outstandingCents(loan) <= 0 ? "All instalments settled" : "No instalment is open" };
  const inFlight = loan.instalments.find((i) => i.n !== inst.n && IN_FLIGHT_INSTALMENT_STATES.has(i.state));
  if (inFlight) return { ok: false, instalment: inst, reason: `Instalment ${inFlight.n} is still in flight (${inFlight.state.replace("_", " ")})`, waiting: true };
  if (inst.state === "unknown") return { ok: true, instalment: inst };
  if (inst.state !== "scheduled" && inst.state !== "failed") return { ok: false, instalment: inst, reason: `Instalment ${inst.n} is ${inst.state.replace("_", " ")}` };
  const earlierOpen = loan.instalments.find((i) => i.n < inst.n && (i.state === "scheduled" || i.state === "unknown"));
  if (earlierOpen) return { ok: false, instalment: inst, reason: `Instalment ${earlierOpen.n} comes first` };
  if (inst.state === "scheduled" && inst.dueDate > sydneyDate()) return { ok: false, instalment: inst, reason: `Agreement permits one payment per fortnight; instalment ${inst.n} opens on ${shortDate(inst.dueDate)}` };
  return { ok: true, instalment: inst };
}

export function nextCollectable(loan: Loan): { instalment: Instalment; reason?: string } | { instalment: null; reason: string } {
  const e = collectionEligibility(loan);
  if (e.ok) return { instalment: e.instalment };
  return e.instalment ? { instalment: e.instalment, reason: e.reason } : { instalment: null, reason: e.reason };
}

async function adoptPayment(loan: Loan, inst: Instalment, p: { uid: string; state: Instalment["state"]; failure?: Instalment["failure"] }, note: string) {
  inst.paymentUid = p.uid;
  inst.state = p.state;
  inst.failure = p.failure ?? null;
  inst.updatedAt = new Date().toISOString();
  pushEvent(loan, "instalment.initiated", note, "info", p.uid);
}

export async function collect(loanId: string, n: number, opts: { simulate?: PaytoPaymentSimulate; delay?: number } = {}): Promise<Loan> {
  const loan = getLoan(loanId);
  if (!loan) throw new Error(`Unknown loan ${loanId}`);
  const e = collectionEligibility(loan, n);
  if (!e.ok) throw new Error(e.reason);
  const inst = e.instalment;
  const z = getZepto();

  // A previous attempt got no answer: ask Zepto whether the intent went through
  // before creating anything.
  if (inst.state === "unknown" && inst.paymentUid) {
    const found = await withApiContext(`${loan.id} · recover instalment ${n}`, async () => {
      try {
        return await z.getPaytoPayment(inst.paymentUid!);
      } catch (err) {
        if (err instanceof ZeptoError && err.status === 404) return null;
        throw err;
      }
    });
    if (found) {
      await adoptPayment(loan, inst, found, `Instalment ${n}: the earlier request had gone through after all — adopted payment ${found.uid} (${found.state})`);
      settle(loan);
      return loan;
    }
    // Never created: fall through and send it again with the same uid.
  } else {
    inst.attempts += 1;
    inst.paymentUid = `brolga-${runId()}-${loan.id.toLowerCase()}-inst-${n}-${inst.attempts}`;
  }
  const uid = inst.paymentUid!;
  inst.state = "unknown"; // intent persisted before the request leaves
  inst.updatedAt = new Date().toISOString();
  saveDb();

  try {
    const p = await withApiContext(`${loan.id} · collect instalment ${n}`, () =>
      z.createPaytoPayment({
        uid,
        agreement_uid: loan.mandate!.uid,
        amount: inst.amountCents,
        reference: `${LENDER_NAME} ${loan.id} ${n}/${loan.instalments.length}`.slice(0, 35),
        description: `${LENDER_NAME} loan ${loan.id} instalment ${n} of ${loan.instalments.length}`,
        creditor_reference: `${loan.id}-${n}`,
        metadata: { loan_id: loan.id, instalment: String(n), app: "brolga-credit" },
        last_payment: n === loan.instalments.length ? true : undefined,
        simulate: opts.simulate ?? "auto_settle",
        delay: opts.delay ?? 3,
      }),
    );
    await adoptPayment(loan, inst, p, `Instalment ${n} (${aud(inst.amountCents)}) initiated via PayTo — payment ${p.uid}`);
  } catch (err) {
    if (err instanceof ZeptoError && err.outcomeUnknown) {
      pushEvent(loan, "instalment.unknown", `No answer from Zepto for instalment ${n} (${err.title}); payment ${uid} is kept as an open intent and checked on the next refresh`, "error", uid);
      settle(loan);
      throw err;
    }
    if (err instanceof ZeptoError && err.status === 422 && err.code === "ZPPAY00") {
      // Duplicate uid: it exists after all — adopt it.
      const found = await withApiContext(`${loan.id} · recover instalment ${n}`, () => z.getPaytoPayment(uid));
      await adoptPayment(loan, inst, found, `Instalment ${n}: Zepto already held payment ${uid}; adopted it`);
      settle(loan);
      return loan;
    }
    // Definite rejection: the intent is void.
    inst.state = "scheduled";
    inst.paymentUid = undefined;
    inst.updatedAt = new Date().toISOString();
    settle(loan);
    throw err;
  }
  settle(loan);
  return loan;
}

export async function retryInstalment(loanId: string, n: number, opts: { simulate?: PaytoPaymentSimulate; delay?: number } = {}): Promise<Loan> {
  const loan = getLoan(loanId);
  if (!loan) throw new Error(`Unknown loan ${loanId}`);
  const inst = loan.instalments.find((i) => i.n === n);
  if (!inst?.paymentUid) throw new Error(`Instalment ${n} has no PayTo payment to retry`);
  if (inst.state !== "failed" || !inst.failure?.retryable) throw new Error(`Instalment ${n} is not retryable`);
  const e = collectionEligibility(loan, n);
  if (!e.ok) throw new Error(e.reason);
  const z = getZepto();
  await withApiContext(`${loan.id} · retry instalment ${n}`, () => z.retryPaytoPayment(inst.paymentUid!, opts.simulate ?? "auto_settle", opts.delay ?? 3));
  inst.attempts += 1;
  inst.state = "created";
  inst.failure = null;
  inst.updatedAt = new Date().toISOString();
  pushEvent(loan, "instalment.retried", `Instalment ${n} retried (attempt ${inst.attempts}) for ${aud(inst.amountCents)} — the payment amount is the one on the original request`, "info", inst.paymentUid);
  settle(loan);
  return loan;
}

// ---------------------------------------------------------------------------
// Agreement lifecycle
// ---------------------------------------------------------------------------
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

/**
 * Plan a restructure. Money already settled, in flight, or sitting on a failed
 * payment that can still be retried is "committed" at its own amount and never
 * changes; only the remaining obligation is re-cut into N equal instalments at (or
 * just under) the requested amount, with the cents of rounding recorded as an
 * adjustment so the schedule always adds up to the debt.
 */
export function planRestructure(loan: Loan, requestedCents: number) {
  if (!Number.isInteger(requestedCents) || requestedCents < 100) throw new Error("Instalment must be a whole number of cents, at least $1");
  const committed = loan.instalments.filter((i) => i.state === "settled" || IN_FLIGHT_INSTALMENT_STATES.has(i.state) || (i.state === "failed" && i.failure?.retryable));
  const committedCents = committed.reduce((s, i) => s + i.amountCents, 0);
  const remainingCents = obligationCents(loan) - committedCents;
  if (remainingCents <= 0) throw new Error("Nothing remains to restructure — every dollar is settled or committed to a payment in flight");
  const count = Math.max(1, Math.ceil(remainingCents / requestedCents));
  const instalmentCents = Math.ceil(remainingCents / count);
  const roundingCents = instalmentCents * count - remainingCents;
  const open = loan.instalments.filter((i) => !committed.includes(i));
  const today = sydneyDate();
  const firstDueDate = open.length && open[0].dueDate >= today ? open[0].dueDate : today;
  const lastDueDate = addDays(firstDueDate, 14 * (count - 1));
  return { instalmentCents, count, roundingCents, remainingCents, firstDueDate, lastDueDate, committedCount: committed.length };
}

export async function amendMandate(loanId: string, newInstalmentCents: number, opts: { simulate?: "debtor_accept" | "debtor_decline" | "expire"; delay?: number } = {}): Promise<Loan> {
  const loan = getLoan(loanId);
  if (!loan?.mandate) throw new Error("No PayTo agreement on this loan");
  if (loan.mandate.state !== "active") throw new Error("Only an active agreement can be amended");
  if (loan.mandate.pendingAmendment) throw new Error("An amendment is already awaiting the borrower");
  const plan = planRestructure(loan, newInstalmentCents);
  const z = getZepto();
  const changes = { payment_terms: { amount: plan.instalmentCents, last_payment_date: plan.lastDueDate }, validity_end_date: addDays(plan.lastDueDate, 14) };
  await withApiContext(`${loan.id} · amend agreement`, () => z.amendAgreement(loan.mandate!.uid, changes, opts.simulate ?? "debtor_accept", opts.delay ?? 4));
  loan.mandate.pendingAmendment = { requestedAt: new Date().toISOString(), changes, plan: { instalmentCents: plan.instalmentCents, count: plan.count, firstDueDate: plan.firstDueDate, lastDueDate: plan.lastDueDate, roundingCents: plan.roundingCents, remainingCents: plan.remainingCents } };
  pushEvent(
    loan,
    "mandate.amendment_requested",
    `Restructure sent for authorisation: ${aud(plan.remainingCents)} remaining re-cut into ${plan.count} × ${aud(plan.instalmentCents)} fortnightly, ${shortDate(plan.firstDueDate)} to ${shortDate(plan.lastDueDate)}` +
      (plan.roundingCents ? ` (+${plan.roundingCents}c rounding on the final total)` : ""),
    "info",
    loan.mandate.uid,
  );
  settle(loan);
  return loan;
}

function applyRestructure(loan: Loan) {
  const m = loan.mandate!;
  const p = m.pendingAmendment!.plan;
  const committed = loan.instalments.filter((i) => i.state === "settled" || IN_FLIGHT_INSTALMENT_STATES.has(i.state) || (i.state === "failed" && i.failure?.retryable));
  const kept = committed.sort((a, b) => a.n - b.n);
  const rebuilt: Instalment[] = Array.from({ length: p.count }, (_, k) => ({
    n: kept.length + k + 1,
    dueDate: addDays(p.firstDueDate, 14 * k),
    amountCents: p.instalmentCents,
    state: "scheduled",
    attempts: 0,
  }));
  kept.forEach((i, idx) => (i.n = idx + 1));
  loan.instalments = [...kept, ...rebuilt];
  if (p.roundingCents) {
    loan.adjustments ??= [];
    loan.adjustments.push({ at: new Date().toISOString(), type: "rounding", cents: p.roundingCents, note: `Restructure rounding: ${p.count} × ${aud(p.instalmentCents)} exceeds the remaining ${aud(p.remainingCents)} by ${p.roundingCents}c` });
  }
  m.instalmentCents = p.instalmentCents;
  m.lastPaymentDate = p.lastDueDate;
  m.validityEndDate = addDays(p.lastDueDate, 14);
  m.pendingAmendment = null;
  m.updatedAt = new Date().toISOString();
  pushEvent(loan, "mandate.amended", `Borrower authorised the amendment: ${p.count} instalments of ${aud(p.instalmentCents)} from ${shortDate(p.firstDueDate)}; total obligation ${aud(obligationCents(loan))}`, "success", m.uid);
}

export async function cancelMandate(loanId: string, reason: CancellationReason, narrative: string): Promise<Loan> {
  const loan = getLoan(loanId);
  if (!loan?.mandate) throw new Error("No PayTo agreement on this loan");
  const z = getZepto();
  await withApiContext(`${loan.id} · cancel agreement`, () => z.cancelAgreement(loan.mandate!.uid, reason, narrative));
  const owed = outstandingCents(loan);
  pushEvent(loan, "mandate.cancellation_requested", `Cancellation requested (${reason}): ${narrative}${owed > 0 ? ` — ${aud(owed)} remains owing; only the repayment authority is cancelled` : ""}`, "warning", loan.mandate.uid);
  return refreshLoan(loanId);
}

// ---------------------------------------------------------------------------
// Refresh: pull the latest state of everything that can still change. Brolga
// polls rather than relying on webhooks so the demo needs no public URL; the
// same code path would be driven by webhook events in production.
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
            d.failedAt = d.updatedAt;
            pushEvent(loan, "disbursement.failed", `Payout ${payout.status}${d.failure ? `: ${d.failure.code} ${d.failure.title}` : ""}`, "error", d.payoutRef);
          } else {
            pushEvent(loan, "disbursement.status", `Payout ${d.payoutRef}: ${prev} → ${payout.status}`, "info", d.payoutRef);
          }
        }
      }
    }
    // Credit side (money arriving in the borrower's account) and, after a failure,
    // the reversal back to Brolga. Both are only visible with both_parties=true.
    const watchReversal = d && disbursementSettled(d) === "failed" && !d.reversalRef && Date.now() - Date.parse(d.failedAt ?? d.updatedAt) < REVERSAL_WATCH_MS;
    if (d && (disbursementSettled(d) === "pending" || watchReversal)) {
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
            d.failedAt = d.updatedAt;
            pushEvent(loan, "disbursement.failed", `${borrower.name}'s bank returned the payment${d.failure ? `: ${d.failure.code} ${d.failure.title}` : ""}${credit.failure_details ? ` (${credit.failure_details})` : ""}. Zepto will reverse the funds to ${LENDER_NAME}.`, "error", credit.ref);
          } else if (prev) {
            pushEvent(loan, "disbursement.credit_status", `Credit ${credit.ref}: ${prev} → ${credit.status}`, "info", credit.ref);
          }
        }
      }
      if (reversal && reversal.ref !== d.reversalRef) {
        d.reversalRef = reversal.ref;
        if (!d.failure && reversal.reversal_details?.source_credit_failure) d.failure = reversal.reversal_details.source_credit_failure;
        pushEvent(loan, "disbursement.reversed", `Reversal ${reversal.ref} (${aud(reversal.amount)}) ${reversal.status} back to ${LENDER_NAME}`, "warning", reversal.ref);
      }
    }

    const m = loan.mandate;
    if (m && !["declined", "expired", "failed", "cancelled"].includes(m.state)) {
      const a = await z.getAgreement(m.uid);
      if (a.state !== m.state) {
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
      if (m.pendingAmendment) {
        // The agreement's own history is the source of truth for how the
        // amendment ended — an unchanged amount still gets an "amended" event.
        const since = Date.parse(m.pendingAmendment.requestedAt) - 1000;
        const hist = await z.agreementHistory(m.uid);
        const after = hist.filter((h) => Date.parse(h.published_at) >= since);
        const done = after.find((h) => /payto_agreement\.amended$/.test(h.type));
        const bad = after.find((h) => /amendment_(declined|expired|failed|recalled)/.test(h.type));
        if (done) applyRestructure(loan);
        else if (bad) {
          pushEvent(loan, "mandate.amendment_failed", `Amendment ${bad.type.replace("payto_agreement.", "").replace("_", " ")} — schedule unchanged, instalment stays at ${aud(m.instalmentCents)}`, "warning", m.uid);
          m.pendingAmendment = null;
        } else if (a.payment_terms.amount !== undefined && a.payment_terms.amount === m.pendingAmendment.plan.instalmentCents && a.payment_terms.amount !== m.instalmentCents) {
          // History unavailable but the terms already show the new amount.
          applyRestructure(loan);
        }
      }
    }

    for (const inst of loan.instalments) {
      if (!inst.paymentUid || FINAL_INSTALMENT_STATES.has(inst.state)) continue;
      if (inst.state === "unknown") {
        // An intent with no answer: find out whether it exists.
        try {
          const p = await z.getPaytoPayment(inst.paymentUid);
          await adoptPayment(loan, inst, p, `Instalment ${inst.n}: recovered payment ${p.uid} (${p.state}) after a lost response`);
        } catch (err) {
          if (err instanceof ZeptoError && err.status === 404) {
            pushEvent(loan, "instalment.intent_void", `Instalment ${inst.n}: Zepto has no record of ${inst.paymentUid}; the intent is cleared and the instalment reopened`, "warning", inst.paymentUid);
            inst.paymentUid = undefined;
            inst.state = "scheduled";
          } else throw err;
        }
        continue;
      }
      const p = await z.getPaytoPayment(inst.paymentUid);
      if (p.state !== inst.state) {
        inst.state = p.state;
        inst.failure = p.failure ?? null;
        inst.updatedAt = new Date().toISOString();
        if (p.state === "settled") pushEvent(loan, "instalment.settled", `Instalment ${inst.n} settled — ${aud(p.amount)} received in real time`, "success", p.uid);
        else if (p.state === "failed") pushEvent(loan, "instalment.failed", `Instalment ${inst.n} failed: ${p.failure?.code} ${p.failure?.title}${p.failure?.retryable ? " (retryable)" : " (not retryable)"}`, "error", p.uid);
        else if (p.state === "under_investigation") pushEvent(loan, "instalment.investigation", `Instalment ${inst.n} is under investigation by the borrower's bank`, "warning", p.uid);
      }
      if (p.state === "settled" && p.amount !== inst.amountCents) {
        // The provider's amount is the truth; the schedule follows it.
        pushEvent(loan, "instalment.amount_corrected", `Instalment ${inst.n} booked at ${aud(p.amount)} (the payment's amount), not the scheduled ${aud(inst.amountCents)}`, "warning", p.uid);
        inst.amountCents = p.amount;
      }
    }
  });

  loan.lastRefreshedAt = new Date().toISOString();
  settle(loan);
  return loan;
}

export function hasInFlight(loan: Loan): boolean {
  const d = loan.disbursement;
  if (d && disbursementSettled(d) === "pending") return true;
  if (d && disbursementSettled(d) === "failed" && !d.reversalRef && Date.now() - Date.parse(d.failedAt ?? d.updatedAt) < REVERSAL_WATCH_MS) return true;
  if (loan.disbursementIntent?.outcome === "unknown") return true;
  const m = loan.mandate;
  if (m && (m.state === "pending" || m.state === "created" || m.pendingAmendment)) return true;
  return loan.instalments.some((i) => i.paymentUid && IN_FLIGHT_INSTALMENT_STATES.has(i.state));
}

/** Refresh every loan that can still change, skipping ones polled very recently. */
export async function refreshInFlight(maxAgeMs = 3000, limit = 10): Promise<number> {
  const db = loadDb();
  const due = db.loans.filter((l) => hasInFlight(l) && (!l.lastRefreshedAt || Date.now() - Date.parse(l.lastRefreshedAt) >= maxAgeMs)).slice(0, limit);
  for (const l of due) {
    try {
      await refreshLoan(l.id);
    } catch (err) {
      pushEvent(l, "refresh.failed", `Refresh failed: ${(err as Error).message}`, "error");
      l.lastRefreshedAt = new Date().toISOString();
      saveDb();
    }
  }
  return due.length;
}
