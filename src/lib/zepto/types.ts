// Subset of the Zepto API surface used by Brolga Credit.
// Shapes were captured from live sandbox responses on 12 Sep 2026 and cross-checked
// against docs.zeptopayments.com. Amounts are integer cents throughout.

export type BankAccount = {
  id: string;
  account_type: "bank_account" | "float_account";
  branch_code: string;
  account_number: string;
  bank_name: string;
  status: "active" | "removed";
  title: string;
  available_balance: number | null;
  payid_configs?: unknown[];
};

export type ZeptoUser = {
  first_name: string;
  last_name: string;
  email: string;
  mobile_phone?: string;
  account: {
    name: string;
    nickname: string;
    abn: string;
    phone?: string;
    street_address?: string;
    suburb?: string;
    state?: string;
    postcode?: string;
  };
};

export type Contact = {
  id: string;
  ref: string;
  name: string;
  email: string;
  type: "anyone" | "Zepto account";
  bank_account: {
    id: string;
    branch_code: string;
    account_number: string;
    bank_name: string;
    state: "active" | "removed";
    blocks?: { credits_blocked: boolean; debits_blocked: boolean };
  };
  metadata?: Record<string, string>;
};

export type CopSimulate =
  | "match"
  | "close_match"
  | "individual_no_match"
  | "non_individual_no_match"
  | "account_closed"
  | "no_account_found"
  | "unable_to_confirm";

export type CopResult = {
  uid: string;
  outcome: {
    result: "match" | "close_match" | "no_match" | "account_closed";
    match_name?: string | null;
    message?: string;
  };
  insights?: {
    risk_score?: number;
    is_joint?: boolean;
    suggested_payment_channels?: string[];
  };
};

export type PayoutChannel = "new_payments_platform" | "direct_entry";

export type PayoutStatus =
  | "scheduled"
  | "maturing"
  | "matured"
  | "preprocessing"
  | "processing"
  | "clearing"
  | "cleared"
  | "rejected"
  | "returned"
  | "voided"
  | "pending_verification"
  | "paused"
  | "channel_switched";

export type Payout = {
  ref: string; // D.*
  status: PayoutStatus;
  amount: number;
  description: string;
  batch_description?: string;
  recipient_contact_id: string;
  from_id?: string;
  to_id?: string;
  matures_at: string;
  created_at: string;
  metadata?: Record<string, string>;
  reversal_details?: {
    source_debit_ref?: string;
    source_credit_failure?: { code: string; title: string; detail: string };
  };
};

export type PaymentBatch = {
  ref: string; // PB.*
  channels: PayoutChannel[];
  your_bank_account_id?: string;
  metadata?: Record<string, string>;
  payouts: Payout[];
};

export type Transaction = {
  ref: string;
  parent_ref?: string;
  type: "debit" | "credit";
  category: string;
  status: PayoutStatus | string;
  status_changed_at?: string;
  created_at: string;
  matures_at?: string;
  cleared_at?: string | null;
  failure?: { code: string; title: string; detail: string } | null;
  failure_details?: string | null;
  party_contact_id?: string | null;
  party_name?: string;
  party_nickname?: string;
  description?: string;
  amount: number;
  bank_account_id?: string;
  bank_ref?: string;
  party_bank_ref?: string;
  channels?: PayoutChannel[];
  current_channel?: "direct_entry" | "float_account" | "new_payments_platform";
  reversal_details?: {
    source_debit_ref?: string;
    source_credit_failure?: { code: string; title: string; detail: string };
    source_credit_failure_reason?: string;
  } | null;
  metadata?: Record<string, string>;
};

export type AgreementState =
  | "pending"
  | "created"
  | "active"
  | "declined"
  | "expired"
  | "failed"
  | "suspended"
  | "cancelled";

export type AgreementSimulate =
  | "debtor_accept"
  | "debtor_decline"
  | "expire"
  | "debtor_account_type_not_supported"
  | "debtor_alias_not_found";

export type AccountIdentifier = { type: "bban" | "alias_email" | "alias_phone" | "alias_abn"; value: string };

export type Party = {
  party_name: string;
  ultimate_party_name?: string;
  account_identifier: AccountIdentifier;
};

export type PaymentTerms = {
  type: "fixed" | "variable" | "usage_based" | "balloon";
  frequency: "adhoc" | "daily" | "weekly" | "fortnightly" | "monthly" | "quarterly" | "semi_annual" | "annual";
  amount?: number;
  max_amount?: number;
  count?: number;
  first_payment_date?: string;
  last_payment_date?: string;
  first_payment_amount?: number | null;
  last_payment_amount?: number | null;
};

export type Agreement = {
  uid: string;
  state: AgreementState;
  state_reason?: { code: string; title: string; detail: string } | null;
  state_caused_by?: "debtor" | "initiator" | "zepto_admin" | "zepto_system" | null;
  mms_agreement_id: string | null;
  created_at: string;
  purpose: string;
  description: string;
  payment_terms: PaymentTerms;
  debtor: Party;
  creditor: Party | null;
  initiator?: { name: string; legal_name?: string; abn?: string | null; client_id?: string | null };
  validity_start_date: string;
  validity_end_date: string;
  metadata?: Record<string, string>;
};

export type AgreementHistoryEvent = {
  id: string;
  type: string; // payto_agreement.activated etc.
  published_at: string;
  resource_uid: string;
  body?: Record<string, unknown>;
};

export type PaytoPaymentState = "created" | "submitting" | "pending" | "under_investigation" | "failed" | "settled";

export type PaytoPaymentSimulate =
  | "auto_settle"
  | "requires_investigation"
  | "investigate_and_settle"
  | "investigate_and_fail"
  | "insufficient_funds"
  | "debtor_account_closed"
  | "financial_infrastructure_unavailable";

export type PaytoPayment = {
  uid: string;
  agreement_uid: string;
  state: PaytoPaymentState;
  amount: number;
  priority: "attended" | "unattended";
  reference?: string;
  description?: string;
  creditor_reference?: string;
  failure?: { title: string; detail: string; code: string; retryable: boolean } | null;
  metadata?: Record<string, string>;
  created_at: string;
  last_payment?: boolean | null;
};

export type Webhook = { id: string; url: string; events: string[] };

export type WebhookDelivery = {
  id: string;
  event_type?: string;
  state?: string;
  response_status_code?: number | null;
  created_at?: string;
  payload_data_summary?: { ref: string }[];
};

// ---- request inputs -------------------------------------------------------

export type CreateContactInput = {
  name: string;
  email: string;
  branch_code: string;
  account_number: string;
  metadata?: Record<string, string>;
};

export type ValidateAccountInput = {
  uid: string;
  party_name: string;
  bban: string; // "062000-12345678"
  requester_id: string;
  simulate?: CopSimulate;
};

export type CreatePaymentInput = {
  description: string;
  matures_at: string;
  channels: PayoutChannel[];
  your_bank_account_id?: string;
  metadata?: Record<string, string>;
  payouts: {
    amount: number;
    description: string;
    recipient_contact_id: string;
    metadata?: Record<string, string>;
  }[];
  idempotency_key: string;
};

export type CreateAgreementInput = {
  uid: string;
  purpose: "loan";
  description: string;
  validity_start_date: string;
  validity_end_date: string;
  debtor: Party;
  creditor: Party;
  payment_terms: PaymentTerms;
  metadata?: Record<string, string>;
  simulate?: AgreementSimulate;
  delay?: number;
};

export type CreatePaytoPaymentInput = {
  uid: string;
  agreement_uid: string;
  amount: number;
  reference: string;
  description: string;
  creditor_reference: string;
  metadata?: Record<string, string>;
  last_payment?: boolean;
  simulate?: PaytoPaymentSimulate;
  delay?: number;
};

export type SuspensionReason = "customer_requested" | "suspected_fraudulent" | "regulatory" | "initiating_party_requested";
export type CancellationReason = "suspected_fraudulent" | "contract_expired" | "regulatory" | "no_answer" | "initiating_party_requested";

export type AmendmentChanges = {
  description?: string;
  validity_end_date?: string;
  payment_terms?: Partial<PaymentTerms>;
};

// ---- the interface both the live client and the mock implement -----------

export interface ZeptoApi {
  readonly mode: "sandbox" | "mock";
  user(): Promise<ZeptoUser>;
  bankAccounts(): Promise<BankAccount[]>;
  createContact(input: CreateContactInput): Promise<Contact>;
  findContacts(query: { branch_code: string; account_number: string }): Promise<Contact[]>;
  validateAccount(input: ValidateAccountInput): Promise<CopResult>;
  createPayment(input: CreatePaymentInput): Promise<PaymentBatch>;
  getPayment(ref: string): Promise<PaymentBatch>;
  transactions(query?: Record<string, string>): Promise<Transaction[]>;
  createAgreement(input: CreateAgreementInput): Promise<Agreement>;
  getAgreement(uid: string): Promise<Agreement>;
  agreementHistory(uid: string): Promise<AgreementHistoryEvent[]>;
  amendAgreement(uid: string, changes: AmendmentChanges, simulate?: "debtor_accept" | "debtor_decline" | "expire", delay?: number): Promise<void>;
  cancelAgreement(uid: string, reason: CancellationReason, narrative: string): Promise<void>;
  suspendAgreement(uid: string, reason: SuspensionReason, narrative: string): Promise<void>;
  reactivateAgreement(uid: string): Promise<void>;
  simulateDebtorAction(uid: string, action: "cancellation" | "suspension" | "reactivation", narrative: string): Promise<void>;
  createPaytoPayment(input: CreatePaytoPaymentInput): Promise<PaytoPayment>;
  getPaytoPayment(uid: string): Promise<PaytoPayment>;
  retryPaytoPayment(uid: string, simulate?: PaytoPaymentSimulate, delay?: number): Promise<void>;
  listPaytoPayments(query?: Record<string, string>): Promise<PaytoPayment[]>;
  webhooks(): Promise<Webhook[]>;
  webhookDeliveries(webhookId: string, query?: Record<string, string>): Promise<WebhookDelivery[]>;
}

export class ZeptoError extends Error {
  status: number;
  code?: string;
  title: string;
  detail: string;
  requiredScope?: string;
  requestId?: string;
  path: string;
  /** Extra data Zepto attaches to some errors — e.g. `resource_ref` on a 409 idempotency replay. */
  meta?: Record<string, unknown>;
  retryAfterSeconds?: number;
  constructor(args: {
    status: number;
    code?: string;
    title: string;
    detail: string;
    requiredScope?: string;
    requestId?: string;
    path: string;
    meta?: Record<string, unknown>;
    retryAfterSeconds?: number;
  }) {
    super(`${args.status} ${args.title}: ${args.detail}`);
    this.name = "ZeptoError";
    this.status = args.status;
    this.code = args.code;
    this.title = args.title;
    this.detail = args.detail;
    this.requiredScope = args.requiredScope;
    this.requestId = args.requestId;
    this.path = args.path;
    this.meta = args.meta;
    this.retryAfterSeconds = args.retryAfterSeconds;
  }
  /** True when we cannot know whether Zepto acted on the request (no response, or a 5xx). */
  get outcomeUnknown(): boolean {
    return this.status === 0 || this.status >= 500;
  }
  toJSON() {
    return {
      status: this.status,
      code: this.code,
      title: this.title,
      detail: this.detail,
      requiredScope: this.requiredScope,
      requestId: this.requestId,
      path: this.path,
      meta: this.meta,
      retryAfterSeconds: this.retryAfterSeconds,
    };
  }
}
