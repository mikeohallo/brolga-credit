import { appendApiLog } from "../db";
import { currentApiContext } from "./context";
import {
  ZeptoError,
  type Agreement,
  type AgreementHistoryEvent,
  type AmendmentChanges,
  type BankAccount,
  type CancellationReason,
  type Contact,
  type CopResult,
  type CreateAgreementInput,
  type CreateContactInput,
  type CreatePaymentInput,
  type CreatePaytoPaymentInput,
  type PaymentBatch,
  type Payout,
  type PayoutStatus,
  type PaytoPayment,
  type PaytoPaymentSimulate,
  type SuspensionReason,
  type Transaction,
  type ValidateAccountInput,
  type Webhook,
  type WebhookDelivery,
  type ZeptoApi,
  type ZeptoUser,
} from "./types";

/**
 * An in-memory stand-in for the Zepto sandbox.
 *
 * It exists for two reasons: so the app can be developed and tested where the real
 * sandbox is unreachable, and so a demo can still run if the sandbox is down on the
 * day. It reproduces the behaviours that matter — the payout state machine, PayTo
 * agreement authorisation with a delay, amount-driven failures, the agreement rules
 * that reject out-of-terms payments — without pretending to be exhaustive.
 *
 * State is derived from timestamps rather than timers, so it survives hot reloads.
 */

type MockPayout = Payout & { channels: string[]; failAt?: number; switchAt?: number; failure?: { code: string; title: string; detail: string } };
type MockAgreement = Agreement & { activateAt?: number; outcome: "active" | "declined" | "expired"; history: AgreementHistoryEvent[]; amendment?: { changes: AmendmentChanges; resolveAt: number; outcome: "amended" | "amendment_declined" | "amendment_expired" } | null };
type MockPaytoPayment = PaytoPayment & { resolveAt: number; outcome: PaytoPaymentSimulate };

type MockState = {
  bankAccounts: BankAccount[];
  contacts: Contact[];
  payments: (Omit<PaymentBatch, "payouts"> & { payouts: MockPayout[]; createdAt: number })[];
  agreements: MockAgreement[];
  paytoPayments: MockPaytoPayment[];
  seq: number;
};

const g = globalThis as unknown as { __brolgaMock?: MockState };

function bankNameFor(bsb: string): string {
  const p = bsb.slice(0, 2);
  const map: Record<string, string> = {
    "06": "Commonwealth Bank of Australia",
    "08": "National Australia Bank",
    "03": "Westpac Banking Corporation",
    "01": "ANZ Banking Group",
    "48": "Suncorp-Metway",
    "80": "Cuscal Limited",
    "18": "Macquarie Bank Limited",
  };
  return map[p] ?? "Zepto SANDBOX Bank";
}

function initialState(): MockState {
  const withFloat = process.env.MOCK_FLOAT !== "0";
  const bankAccounts: BankAccount[] = [
    {
      id: "mock-bank-macquarie",
      account_type: "bank_account",
      branch_code: "182600",
      account_number: "123456789",
      bank_name: "Macquarie Bank Limited",
      status: "active",
      title: "AU.182600.123456789",
      available_balance: null,
    },
  ];
  if (withFloat) {
    bankAccounts.push({
      id: "mock-float-npp",
      account_type: "float_account",
      branch_code: "802919",
      account_number: "700004821",
      bank_name: "Zepto Float Account",
      status: "active",
      title: "Brolga operating float",
      available_balance: 2_500_000,
    });
  }
  return { bankAccounts, contacts: [], payments: [], agreements: [], paytoPayments: [], seq: 100 };
}

function state(): MockState {
  if (!g.__brolgaMock) g.__brolgaMock = initialState();
  return g.__brolgaMock;
}

export function resetMock(): void {
  g.__brolgaMock = initialState();
}

function ref(prefix: string): string {
  const s = state();
  s.seq += 1;
  return `${prefix}.${s.seq.toString(36)}`;
}

function iso(ms = Date.now()): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function sydneyDate(ms = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

// Payout state machine timing (ms after creation). Sandbox runs a ~1 minute cycle;
// the mock is quicker so demos keep moving.
const PAYOUT_STEPS: [number, PayoutStatus][] = [
  [0, "matured"],
  [4000, "processing"],
  [8000, "clearing"],
  [14000, "cleared"],
];

const DE_FAILURES: Record<number, [string, string]> = {
  101: ["E101", "Invalid BSB Number"],
  102: ["E102", "Payment Stopped"],
  103: ["E103", "Account Closed"],
  104: ["E104", "Customer Deceased"],
  105: ["E105", "Account Not Found"],
  106: ["E106", "Refer To Customer"],
  108: ["E108", "Invalid User Id Number"],
  109: ["E109", "Technically Invalid"],
};
const NPP_FAILURES: Record<number, [string, string]> = {
  301: ["E301", "Invalid Account"],
  302: ["E302", "BSB Not NPP Enabled"],
  303: ["E303", "Account Not NPP Enabled"],
  304: ["E304", "Account Closed"],
  305: ["E305", "Account Blocked"],
  306: ["E306", "Customer Deceased"],
  307: ["E307", "Payment Rejected By Receiving Bank"],
  308: ["E308", "Payment Blocked"],
};

function payoutView(p: MockPayout, createdAt: number): Payout {
  const elapsed = Date.now() - createdAt;
  if (p.failure && p.failAt !== undefined && elapsed >= p.failAt) return { ...p, status: "cleared" };
  if (p.switchAt !== undefined && elapsed >= p.switchAt) return { ...p, status: "channel_switched" };
  let status: PayoutStatus = "matured";
  for (const [at, s] of PAYOUT_STEPS) if (elapsed >= at) status = s;
  return { ...p, status };
}

function log(method: string, path: string, status: number, body?: unknown, error?: string) {
  appendApiLog({
    at: new Date().toISOString(),
    method,
    path,
    status,
    ms: 12 + Math.floor(Math.random() * 40),
    ok: status < 400,
    apiVersion: "mock",
    requestBody: body,
    error,
    mode: "mock",
    context: currentApiContext(),
  });
}

function fail(method: string, path: string, status: number, title: string, detail: string, code?: string, body?: unknown): never {
  log(method, path, status, body, `${code ? code + " " : ""}${title}: ${detail}`);
  throw new ZeptoError({ status, code, title, detail, path });
}

export class MockZepto implements ZeptoApi {
  readonly mode = "mock" as const;

  async user(): Promise<ZeptoUser> {
    log("GET", "/user", 200);
    return {
      first_name: "Mike",
      last_name: "O'Halloran",
      email: "ops@brolga.example",
      account: { name: "Brolga Credit Pty Ltd (mock)", nickname: "Brolga", abn: "01234567890", state: "NSW", suburb: "Sydney", postcode: "2000" },
    };
  }

  async bankAccounts(): Promise<BankAccount[]> {
    log("GET", "/bank_accounts", 200);
    return state().bankAccounts.map((b) => ({ ...b }));
  }

  async createContact(input: CreateContactInput): Promise<Contact> {
    const s = state();
    const c: Contact = {
      id: crypto.randomUUID(),
      ref: ref("CNT"),
      name: input.name,
      email: input.email,
      type: "anyone",
      bank_account: {
        id: crypto.randomUUID(),
        branch_code: input.branch_code,
        account_number: input.account_number,
        bank_name: bankNameFor(input.branch_code),
        state: "active",
        blocks: { credits_blocked: false, debits_blocked: false },
      },
      metadata: input.metadata,
    };
    s.contacts.push(c);
    log("POST", "/contacts/anyone", 201, input);
    return c;
  }

  async findContacts(query: { branch_code: string; account_number: string }): Promise<Contact[]> {
    log("GET", `/contacts?bank_account_branch_code=${query.branch_code}&bank_account_account_number=${query.account_number}`, 200);
    return state().contacts.filter((c) => c.bank_account.branch_code === query.branch_code && c.bank_account.account_number === query.account_number);
  }

  async validateAccount(input: ValidateAccountInput): Promise<CopResult> {
    const sim = input.simulate ?? "match";
    const path = "/cop/account/validate";
    if (sim === "no_account_found") fail("POST", path, 404, "No account found", "No account could be found for the supplied BSB and account number", "ZCOPR02", input);
    if (sim === "unable_to_confirm") fail("POST", path, 422, "Unable to confirm", "The account holder's bank could not confirm the account name", "ZCOPR00", input);
    const result: CopResult["outcome"]["result"] =
      sim === "match" ? "match" : sim === "close_match" ? "close_match" : sim === "account_closed" ? "account_closed" : "no_match";
    const risk = result === "match" ? 8 : result === "close_match" ? 34 : 81;
    log("POST", path, 200, input);
    return {
      uid: input.uid,
      outcome: {
        result,
        match_name: result === "close_match" ? input.party_name.replace(/^(\w)\w+/, "$1.") : result === "match" ? input.party_name : null,
        message: result === "match" ? "Account name matches" : result === "close_match" ? "Account name is a close match" : "Account name does not match",
      },
      insights: { risk_score: risk, is_joint: false, suggested_payment_channels: input.bban.startsWith("802") ? ["de.dc"] : ["npp.sct", "de.dc"] },
    };
  }

  async createPayment(input: CreatePaymentInput): Promise<PaymentBatch> {
    const s = state();
    const path = "/payments";
    const from = input.your_bank_account_id ? s.bankAccounts.find((b) => b.id === input.your_bank_account_id) : s.bankAccounts[0];
    if (!from) fail("POST", path, 400, "HTTP 400", "Your bank account could not be found", undefined, input);
    if (input.channels.includes("new_payments_platform") && from.account_type !== "float_account") {
      fail("POST", path, 400, "HTTP 400", "Channels new_payments_platform is not supported by your bank account. Please contact us for assistance", undefined, input);
    }
    if (!input.matures_at) fail("POST", path, 400, "HTTP 400", "Matures at can't be blank", undefined, input);
    const createdAt = Date.now();
    const payouts: MockPayout[] = input.payouts.map((po) => {
      const contact = s.contacts.find((c) => c.id === po.recipient_contact_id);
      if (!contact) fail("POST", path, 400, "HTTP 400", "Recipient contact could not be found", undefined, input);
      const cents = po.amount % 1000; // last three digits drive sandbox-style failures ($1.05 → 105)
      const de = DE_FAILURES[cents];
      const npp = NPP_FAILURES[cents];
      const nppFirst = input.channels[0] === "new_payments_platform";
      // Sandbox rules: $3.xx fails NPP; $1.xx fails DE. On an NPP-first float with
      // channel switching, a $1.xx amount fails NPP (E303), switches to DE, then
      // fails DE with the matching E1xx — so the caller sees channel_switched first.
      let failure: MockPayout["failure"];
      let switchAt: number | undefined;
      if (nppFirst && npp) failure = { code: npp[0], title: npp[1], detail: npp[1] };
      else if (nppFirst && de) { failure = { code: de[0], title: de[1], detail: de[1] }; switchAt = 5000; }
      else if (!nppFirst && de) failure = { code: de[0], title: de[1], detail: de[1] };
      return {
        ref: ref("D"),
        status: "matured",
        amount: po.amount,
        description: po.description,
        batch_description: input.description,
        recipient_contact_id: po.recipient_contact_id,
        from_id: from.id,
        to_id: contact.bank_account.id,
        matures_at: input.matures_at,
        created_at: iso(createdAt),
        metadata: po.metadata,
        channels: input.channels,
        failure,
        switchAt,
        failAt: failure ? (switchAt ? 12000 : 9000) : undefined,
      };
    });
    if (from.account_type === "float_account" && from.available_balance !== null) {
      const total = payouts.reduce((a, p) => a + p.amount, 0);
      if (total > from.available_balance) fail("POST", path, 400, "HTTP 400", "Insufficient funds in your bank account", undefined, input);
      from.available_balance -= total;
    }
    const batch = { ref: ref("PB"), channels: input.channels, your_bank_account_id: from.id, metadata: input.metadata, payouts, createdAt };
    s.payments.push(batch);
    log("POST", path, 201, input);
    return { ref: batch.ref, channels: batch.channels, your_bank_account_id: batch.your_bank_account_id, metadata: batch.metadata, payouts: payouts.map((p) => payoutView(p, createdAt)) };
  }

  async getPayment(refStr: string): Promise<PaymentBatch> {
    const b = state().payments.find((p) => p.ref === refStr);
    if (!b) fail("GET", `/payments/${refStr}`, 404, "Not found", "Payment not found");
    log("GET", `/payments/${refStr}`, 200);
    return { ref: b.ref, channels: b.channels, your_bank_account_id: b.your_bank_account_id, metadata: b.metadata, payouts: b.payouts.map((p) => payoutView(p, b.createdAt)) };
  }

  async transactions(query?: Record<string, string>): Promise<Transaction[]> {
    // Mirrors the sandbox: the debit (D.*) is Brolga's side; the borrower-side
    // credit (C.*) only appears with both_parties=true, and a failed credit shows
    // as `returned` followed by a `payout_reversal` credit back to Brolga.
    const s = state();
    const bothParties = query?.both_parties === "true";
    const rows: Transaction[] = [];
    for (const b of s.payments) {
      for (const p of b.payouts) {
        const v = payoutView(p, b.createdAt);
        const contact = s.contacts.find((c) => c.id === p.recipient_contact_id);
        const elapsed = Date.now() - b.createdAt;
        const failed = !!(p.failure && p.failAt !== undefined && elapsed >= p.failAt);
        const channel = (p.switchAt !== undefined && elapsed >= p.switchAt ? "direct_entry" : b.channels[0]) as Transaction["current_channel"];
        // Debit: in the sandbox the debit clears even when the credit later fails.
        const debitStatus: Transaction["status"] = failed ? "cleared" : v.status === "channel_switched" ? "channel_switched" : v.status;
        rows.push({
          ref: v.ref,
          parent_ref: b.ref,
          type: "debit",
          category: "payout",
          status: debitStatus,
          created_at: v.created_at,
          matures_at: v.matures_at,
          cleared_at: debitStatus === "cleared" ? iso(b.createdAt + Math.min(14000, p.failAt ?? 14000)) : null,
          party_contact_id: p.recipient_contact_id,
          party_name: contact?.name,
          description: p.description,
          amount: p.amount,
          bank_account_id: b.your_bank_account_id,
          channels: b.channels as Transaction["channels"],
          current_channel: channel,
          metadata: p.metadata,
        });
        if (bothParties) {
          const creditStatus: Transaction["status"] = failed ? "returned" : debitStatus === "channel_switched" ? "processing" : debitStatus;
          rows.push({
            ref: v.ref.replace(/^D\./, "C."),
            parent_ref: b.ref,
            type: "credit",
            category: "payout",
            status: creditStatus,
            created_at: v.created_at,
            matures_at: v.matures_at,
            cleared_at: creditStatus === "cleared" ? iso(b.createdAt + 14000) : null,
            failure: failed ? p.failure : null,
            failure_details: failed ? p.failure?.title : null,
            party_contact_id: null,
            party_name: "Brolga Credit Pty Ltd (mock)",
            description: p.description,
            amount: p.amount,
            channels: b.channels as Transaction["channels"],
            current_channel: channel,
            metadata: p.metadata,
          });
        }
        if (failed && elapsed >= (p.failAt ?? 0) + 3000) {
          rows.push({
            ref: v.ref.replace(/^D\./, "C.") + "r",
            parent_ref: b.ref,
            type: "credit",
            category: "payout_reversal",
            status: "cleared",
            created_at: iso(b.createdAt + (p.failAt ?? 0) + 3000),
            cleared_at: iso(b.createdAt + (p.failAt ?? 0) + 3000),
            party_contact_id: null,
            party_name: "Brolga Credit Pty Ltd (mock)",
            description: `Payout reversal of ${v.ref} for ${contact?.name ?? "recipient"} due to ${p.failure?.title}`,
            amount: p.amount,
            bank_account_id: b.your_bank_account_id,
            current_channel: channel,
            reversal_details: { source_debit_ref: v.ref, source_credit_failure: p.failure ? { ...p.failure } : undefined },
            metadata: p.metadata,
          });
        }
      }
    }
    const filtered = query?.parent_ref ? rows.filter((r) => r.parent_ref === query.parent_ref) : rows;
    log("GET", "/transactions" + (query ? "?" + new URLSearchParams(query).toString() : ""), 200);
    return filtered.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }

  private agreementView(a: MockAgreement): Agreement {
    const now = Date.now();
    if (a.state === "pending" && a.activateAt !== undefined && now >= a.activateAt) {
      a.state = a.outcome;
      a.state_caused_by = a.outcome === "expired" ? "zepto_system" : "debtor";
      if (a.outcome === "active") {
        a.mms_agreement_id = crypto.randomUUID().replace(/-/g, "");
        a.history.push({ id: crypto.randomUUID(), type: "payto_agreement.activated", published_at: new Date().toISOString(), resource_uid: a.uid, body: { mms_agreement_id: a.mms_agreement_id } });
      } else if (a.outcome === "declined") {
        a.state_reason = { code: "MD01", title: "Declined by debtor", detail: "The debtor declined the agreement in their banking app" };
        a.history.push({ id: crypto.randomUUID(), type: "payto_agreement.declined", published_at: new Date().toISOString(), resource_uid: a.uid, body: { caused_by: "debtor" } });
      } else {
        a.state_reason = { code: "MD20", title: "Expired", detail: "The debtor did not respond within the authorisation window" };
        a.history.push({ id: crypto.randomUUID(), type: "payto_agreement.expired", published_at: new Date().toISOString(), resource_uid: a.uid, body: { caused_by: "zepto_system" } });
      }
    }
    if (a.amendment && now >= a.amendment.resolveAt) {
      const am = a.amendment;
      a.amendment = null;
      if (am.outcome === "amended") {
        if (am.changes.payment_terms) a.payment_terms = { ...a.payment_terms, ...am.changes.payment_terms };
        if (am.changes.validity_end_date) a.validity_end_date = am.changes.validity_end_date;
        if (am.changes.description) a.description = am.changes.description;
      }
      a.history.push({ id: crypto.randomUUID(), type: `payto_agreement.${am.outcome}`, published_at: new Date().toISOString(), resource_uid: a.uid, body: { changes: am.changes } });
    }
    const { activateAt: _a, outcome: _o, history: _h, amendment: _m, ...view } = a;
    void _a; void _o; void _h; void _m;
    return { ...view };
  }

  async createAgreement(input: CreateAgreementInput): Promise<Agreement> {
    const s = state();
    const path = "/payto/agreements";
    if (s.agreements.some((a) => a.uid === input.uid)) fail("POST", path, 422, "Duplicate uid", "An agreement with this uid already exists", "ZPAGR02", input);
    if (!input.creditor?.ultimate_party_name) fail("POST", path, 422, "One or more fields violate the relevant schema", "params.creditor.ultimate_party_name is missing", "ZPUNP00", input);
    if (input.debtor.account_identifier.value.startsWith("100001")) fail("POST", path, 422, "Debtor account type not supported", "The debtor's financial institution does not support PayTo", "ZPAGR12", input);
    const attempts = s.agreements.filter((a) => a.debtor.account_identifier.value === input.debtor.account_identifier.value && Date.now() - Date.parse(a.created_at) < 86_400_000).length;
    if (attempts >= 6) fail("POST", path, 422, "Too many agreement attempts", "No more than 6 agreement creation attempts per debtor account per 24 hours", "ZPAGR15", input);
    const sim = input.simulate ?? "debtor_accept";
    const delay = (input.delay ?? 3) * 1000;
    const a: MockAgreement = {
      uid: input.uid,
      state: "pending",
      state_reason: null,
      state_caused_by: "initiator",
      mms_agreement_id: null,
      created_at: new Date().toISOString(),
      purpose: input.purpose,
      description: input.description,
      payment_terms: input.payment_terms,
      debtor: { ...input.debtor, ultimate_party_name: input.debtor.ultimate_party_name ?? input.debtor.party_name },
      creditor: input.creditor,
      initiator: { name: "Brolga Credit Pty Ltd (mock)", legal_name: "Brolga Credit Pty Ltd", abn: "01234567890" },
      validity_start_date: input.validity_start_date,
      validity_end_date: input.validity_end_date,
      metadata: input.metadata,
      activateAt: Date.now() + delay,
      outcome: sim === "debtor_accept" ? "active" : sim === "debtor_decline" ? "declined" : sim === "expire" ? "expired" : "declined",
      history: [{ id: crypto.randomUUID(), type: "payto_agreement.created", published_at: new Date().toISOString(), resource_uid: input.uid, body: {} }],
      amendment: null,
    };
    s.agreements.push(a);
    log("POST", path, 201, input);
    return this.agreementView(a);
  }

  private findAgreement(uid: string, method: string, path: string): MockAgreement {
    const a = state().agreements.find((x) => x.uid === uid);
    if (!a) fail(method, path, 404, "Not found", "Agreement not found");
    this.agreementView(a); // advance state
    return a;
  }

  async getAgreement(uid: string): Promise<Agreement> {
    const a = this.findAgreement(uid, "GET", `/payto/agreements/${uid}`);
    log("GET", `/payto/agreements/${uid}`, 200);
    return this.agreementView(a);
  }

  async agreementHistory(uid: string): Promise<AgreementHistoryEvent[]> {
    const a = this.findAgreement(uid, "GET", `/payto/agreements/${uid}/history`);
    log("GET", `/payto/agreements/${uid}/history`, 200);
    return [...a.history].reverse();
  }

  async amendAgreement(uid: string, changes: AmendmentChanges, simulate: "debtor_accept" | "debtor_decline" | "expire" = "debtor_accept", delay = 3): Promise<void> {
    const path = `/payto/agreements/${uid}/amendment`;
    const a = this.findAgreement(uid, "POST", path);
    if (a.state !== "active") fail("POST", path, 422, "Agreement not active", `An agreement in state "${a.state}" cannot be amended`, "ZPAMD01", changes);
    if (a.amendment) fail("POST", path, 422, "Amendment pending", "Only one amendment can be pending at a time", "ZPAMD02", changes);
    a.amendment = { changes, resolveAt: Date.now() + delay * 1000, outcome: simulate === "debtor_accept" ? "amended" : simulate === "debtor_decline" ? "amendment_declined" : "amendment_expired" };
    a.history.push({ id: crypto.randomUUID(), type: "payto_agreement.amendment_requested", published_at: new Date().toISOString(), resource_uid: uid, body: { changes } });
    log("POST", path, 202, { changes, sandbox: { simulate, delay } });
  }

  async cancelAgreement(uid: string, reason: CancellationReason, narrative: string): Promise<void> {
    const path = `/payto/agreements/${uid}/cancellation`;
    const a = this.findAgreement(uid, "POST", path);
    if (a.state === "cancelled") fail("POST", path, 422, "Already cancelled", "The agreement is already cancelled", "ZPCAN01", { reason, narrative });
    a.state = "cancelled";
    a.state_caused_by = "initiator";
    a.state_reason = { code: "MD16", title: reason, detail: narrative };
    a.history.push({ id: crypto.randomUUID(), type: "payto_agreement.cancelled", published_at: new Date().toISOString(), resource_uid: uid, body: { caused_by: "initiator", reason: { code: "MD16", title: reason, detail: narrative } } });
    log("POST", path, 202, { reason, narrative });
  }

  async suspendAgreement(uid: string, reason: SuspensionReason, narrative: string): Promise<void> {
    const path = `/payto/agreements/${uid}/suspension`;
    const a = this.findAgreement(uid, "POST", path);
    if (a.state !== "active") fail("POST", path, 422, "Agreement not active", `An agreement in state "${a.state}" cannot be suspended`, "ZPSUS01", { reason, narrative });
    a.state = "suspended";
    a.state_caused_by = "initiator";
    a.state_reason = { code: "MD16", title: reason, detail: narrative };
    a.history.push({ id: crypto.randomUUID(), type: "payto_agreement.suspended", published_at: new Date().toISOString(), resource_uid: uid, body: { caused_by: "initiator", reason: { code: "MD16", title: reason, detail: narrative } } });
    log("POST", path, 202, { reason, narrative });
  }

  async reactivateAgreement(uid: string): Promise<void> {
    const path = `/payto/agreements/${uid}/reactivation`;
    const a = this.findAgreement(uid, "POST", path);
    if (a.state !== "suspended") fail("POST", path, 422, "Agreement not suspended", "Only a suspended agreement can be reactivated", "ZPREA01", {});
    if (a.state_caused_by === "debtor") fail("POST", path, 422, "Reactivation not permitted", "A suspension initiated by the debtor can only be lifted by the debtor", "ZPREA02", {});
    a.state = "active";
    a.state_caused_by = "initiator";
    a.state_reason = null;
    a.history.push({ id: crypto.randomUUID(), type: "payto_agreement.reactivated", published_at: new Date().toISOString(), resource_uid: uid, body: { caused_by: "initiator" } });
    log("POST", path, 202, {});
  }

  async simulateDebtorAction(uid: string, action: "cancellation" | "suspension" | "reactivation", narrative: string): Promise<void> {
    const path = `/payto/agreements/${uid}/simulate_debtor_action`;
    const a = this.findAgreement(uid, "POST", path);
    if (action === "suspension") { a.state = "suspended"; a.state_caused_by = "debtor"; a.state_reason = { code: "MD16", title: "customer_requested", detail: narrative }; }
    if (action === "reactivation") { a.state = "active"; a.state_caused_by = "debtor"; a.state_reason = null; }
    if (action === "cancellation") { a.state = "cancelled"; a.state_caused_by = "debtor"; a.state_reason = { code: "MD16", title: "customer_requested", detail: narrative }; }
    a.history.push({ id: crypto.randomUUID(), type: `payto_agreement.${action === "cancellation" ? "cancelled" : action === "suspension" ? "suspended" : "reactivated"}`, published_at: new Date().toISOString(), resource_uid: uid, body: { caused_by: "debtor", narrative } });
    log("POST", path, 202, { debtor_action: action, reason: "customer_requested", narrative });
  }

  private paymentView(p: MockPaytoPayment): PaytoPayment {
    const now = Date.now();
    if ((p.state === "created" || p.state === "submitting" || p.state === "under_investigation") && now >= p.resolveAt) {
      switch (p.outcome) {
        case "auto_settle":
        case "investigate_and_settle":
          p.state = "settled";
          p.failure = null;
          break;
        case "requires_investigation":
          p.state = "under_investigation";
          p.resolveAt = Number.MAX_SAFE_INTEGER;
          break;
        case "insufficient_funds":
          p.state = "failed";
          p.failure = { code: "AM04", title: "Insufficient funds", detail: "The debtor's account has insufficient funds for this payment", retryable: true };
          break;
        case "debtor_account_closed":
          p.state = "failed";
          p.failure = { code: "AC04", title: "Account closed", detail: "The debtor's account is closed", retryable: false };
          break;
        case "financial_infrastructure_unavailable":
          p.state = "failed";
          p.failure = { code: "ZPPAY24", title: "Participant unavailable", detail: "The debtor's financial institution is currently unavailable", retryable: true };
          break;
        case "investigate_and_fail":
          p.state = "failed";
          p.failure = { code: "NARR", title: "Rejected after investigation", detail: "The payment was rejected after investigation", retryable: false };
          break;
      }
    } else if (p.state === "created" && now >= p.resolveAt - 1500) {
      p.state = "submitting";
    }
    const { resolveAt: _r, outcome: _o, ...view } = p;
    void _r; void _o;
    return { ...view };
  }

  async createPaytoPayment(input: CreatePaytoPaymentInput): Promise<PaytoPayment> {
    const s = state();
    const path = "/payto/payments";
    if (s.paytoPayments.some((p) => p.uid === input.uid)) fail("POST", path, 422, "Duplicate uid", "A payment with this uid already exists", "ZPPAY00", input);
    const a = s.agreements.find((x) => x.uid === input.agreement_uid);
    if (!a) fail("POST", path, 422, "Agreement not found", "No agreement could be found for the given agreement UID", "ZPPAY22", input);
    this.agreementView(a);
    if (a.state !== "active") fail("POST", path, 422, "Agreement not active", `Payments cannot be initiated against an agreement in state "${a.state}"`, "ZPPAY23", input);
    const terms = a.payment_terms;
    const today = sydneyDate();
    if (terms.type === "fixed" && terms.amount !== undefined && input.amount !== terms.amount) {
      fail("POST", path, 422, "Amount mismatch", "The payment amount does not match the fixed amount specified in the agreement", "ZPPAY15", input);
    }
    const priorSettledOrPending = s.paytoPayments.filter((p) => p.agreement_uid === a.uid && this.paymentView(p).state !== "failed");
    if (priorSettledOrPending.length === 0 && terms.first_payment_date && today !== terms.first_payment_date) {
      fail("POST", path, 422, "First payment date mismatch", "The payment date does not match the first payment date specified in the agreement", "ZPPAY14", input);
    }
    if (terms.frequency === "fortnightly" && terms.count) {
      const periodStart = Date.now() - 14 * 86_400_000;
      const inPeriod = priorSettledOrPending.filter((p) => Date.parse(p.created_at) > periodStart).length;
      if (inPeriod >= terms.count) fail("POST", path, 422, "Maximum payments in period reached", `The agreement permits ${terms.count} payment per fortnight`, "ZPPAY17", input);
    }
    const sim = input.simulate ?? "auto_settle";
    const delay = (input.delay ?? 2) * 1000;
    const p: MockPaytoPayment = {
      uid: input.uid,
      agreement_uid: input.agreement_uid,
      state: "created",
      amount: input.amount,
      priority: "unattended",
      reference: input.reference,
      description: input.description,
      creditor_reference: input.creditor_reference,
      failure: null,
      metadata: input.metadata,
      created_at: new Date().toISOString(),
      last_payment: input.last_payment ?? null,
      resolveAt: Date.now() + delay,
      outcome: sim,
    };
    s.paytoPayments.push(p);
    log("POST", path, 201, input);
    return this.paymentView(p);
  }

  async getPaytoPayment(uid: string): Promise<PaytoPayment> {
    const p = state().paytoPayments.find((x) => x.uid === uid);
    if (!p) fail("GET", `/payto/payments/${uid}`, 404, "Not found", "Payment not found");
    log("GET", `/payto/payments/${uid}`, 200);
    return this.paymentView(p);
  }

  async retryPaytoPayment(uid: string, simulate: PaytoPaymentSimulate = "auto_settle", delay = 2): Promise<void> {
    const path = `/payto/payments/${uid}/retry`;
    const p = state().paytoPayments.find((x) => x.uid === uid);
    if (!p) fail("POST", path, 404, "Not found", "Payment not found");
    const v = this.paymentView(p);
    if (v.state !== "failed" || !v.failure?.retryable) fail("POST", path, 422, "Payment not retryable", "Only failed payments with a retryable failure can be retried", "ZPPRY00", { sandbox: { simulate } });
    p.state = "created";
    p.failure = null;
    p.outcome = simulate;
    p.resolveAt = Date.now() + delay * 1000;
    log("POST", path, 202, { sandbox: { simulate, delay } });
  }

  async listPaytoPayments(query?: Record<string, string>): Promise<PaytoPayment[]> {
    log("GET", "/payto/payments" + (query ? "?" + new URLSearchParams(query).toString() : ""), 200);
    return state()
      .paytoPayments.map((p) => this.paymentView(p))
      .filter((p) => !query?.agreement_uid || p.agreement_uid === query.agreement_uid)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }

  async webhooks(): Promise<Webhook[]> {
    log("GET", "/webhooks", 200);
    return [];
  }

  async webhookDeliveries(): Promise<WebhookDelivery[]> {
    return [];
  }
}
