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

export type ZeptoClientConfig = {
  token: string;
  baseUrl?: string;
  apiVersion?: string;
};

type Envelope<T> = { data: T; links?: Record<string, string> };

/**
 * Thin, honest wrapper over the Zepto REST API.
 *
 * Things learned the hard way and encoded here:
 *  - `Zepto-Api-Version` is mandatory for this account (409 "API Version Below
 *    Minimum" without it) even though the versioning docs call it optional.
 *  - A missing OAuth scope is a 403 with an EMPTY body; the only explanation is in
 *    the `WWW-Authenticate` header, so we parse it and surface the scope name.
 *  - Errors come in two shapes: `{errors: [{code,title,detail}]}` (PayTo, CoP, auth)
 *    and `{errors: "message"}` (legacy payments). Both are normalised to ZeptoError.
 *  - `Idempotency-Key` is required on POST /payments; PayTo uses caller `uid`s.
 */
export class ZeptoClient implements ZeptoApi {
  readonly mode = "sandbox" as const;
  private token: string;
  private baseUrl: string;
  private apiVersion: string;

  constructor(cfg: ZeptoClientConfig) {
    this.token = cfg.token;
    this.baseUrl = (cfg.baseUrl ?? "https://api.sandbox.zeptopayments.com").replace(/\/$/, "");
    this.apiVersion = cfg.apiVersion ?? "20260101";
  }

  private async request<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; body: T }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
      "Zepto-Api-Version": this.apiVersion,
      ...extraHeaders,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
      });
    } catch (err) {
      const ms = Date.now() - started;
      appendApiLog({
        at: new Date().toISOString(),
        method,
        path,
        status: 0,
        ms,
        ok: false,
        apiVersion: this.apiVersion,
        idempotencyKey: extraHeaders["Idempotency-Key"],
        error: `network: ${(err as Error).message}`,
        requestBody: body,
        mode: "sandbox",
        context: currentApiContext(),
      });
      throw new ZeptoError({ status: 0, title: "Network error", detail: (err as Error).message, path });
    }
    const ms = Date.now() - started;
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    const requestId = res.headers.get("x-request-id") ?? undefined;

    if (!res.ok) {
      const err = this.toError(res, path, parsed);
      appendApiLog({
        at: new Date().toISOString(),
        method,
        path,
        status: res.status,
        ms,
        ok: false,
        requestId,
        apiVersion: this.apiVersion,
        idempotencyKey: extraHeaders["Idempotency-Key"],
        error: `${err.code ? err.code + " " : ""}${err.title}: ${err.detail}`,
        requestBody: body,
        responseSnippet: text.slice(0, 600),
        mode: "sandbox",
        context: currentApiContext(),
      });
      throw err;
    }

    appendApiLog({
      at: new Date().toISOString(),
      method,
      path,
      status: res.status,
      ms,
      ok: true,
      requestId,
      apiVersion: this.apiVersion,
      idempotencyKey: extraHeaders["Idempotency-Key"],
      requestBody: body,
      responseSnippet: text.slice(0, 600),
      mode: "sandbox",
      context: currentApiContext(),
    });
    return { status: res.status, body: parsed as T };
  }

  private toError(res: Response, path: string, parsed: unknown): ZeptoError {
    const requestId = res.headers.get("x-request-id") ?? undefined;
    const wa = res.headers.get("www-authenticate") ?? "";
    const scope = wa.match(/requires scope _([a-z_]+)_/i)?.[1];
    if (res.status === 403 && scope) {
      return new ZeptoError({
        status: 403,
        title: "Missing OAuth scope",
        detail: `This token cannot call ${path}: the OAuth application needs the "${scope}" scope. Add it under Your applications and mint a new Personal Access Token.`,
        requiredScope: scope,
        requestId,
        path,
      });
    }
    const p = parsed as { errors?: unknown } | null;
    if (p && Array.isArray(p.errors) && p.errors.length) {
      const first = p.errors[0] as { code?: string; title?: string; detail?: string };
      const extra = p.errors.length > 1 ? ` (+${p.errors.length - 1} more: ${(p.errors as { detail?: string }[]).slice(1).map((e) => e.detail).join("; ")})` : "";
      return new ZeptoError({
        status: res.status,
        code: first.code,
        title: first.title ?? `HTTP ${res.status}`,
        detail: (first.detail ?? "") + extra,
        requestId,
        path,
      });
    }
    if (p && typeof p.errors === "string") {
      return new ZeptoError({ status: res.status, title: `HTTP ${res.status}`, detail: p.errors, requestId, path });
    }
    return new ZeptoError({
      status: res.status,
      title: `HTTP ${res.status}`,
      detail: typeof parsed === "string" && parsed ? parsed.slice(0, 200) : res.statusText || "Request failed",
      requestId,
      path,
    });
  }

  private qs(query?: Record<string, string>): string {
    if (!query) return "";
    const entries = Object.entries(query).filter(([, v]) => v !== undefined && v !== "");
    if (!entries.length) return "";
    return "?" + new URLSearchParams(entries).toString();
  }

  // ---- account ----------------------------------------------------------
  async user(): Promise<ZeptoUser> {
    const r = await this.request<Envelope<ZeptoUser>>("GET", "/user");
    return r.body.data;
  }

  async bankAccounts(): Promise<BankAccount[]> {
    const r = await this.request<Envelope<BankAccount[]>>("GET", "/bank_accounts");
    return r.body.data;
  }

  // ---- contacts ---------------------------------------------------------
  async createContact(input: CreateContactInput): Promise<Contact> {
    const r = await this.request<Envelope<Contact>>("POST", "/contacts/anyone", input);
    return r.body.data;
  }

  async findContacts(query: { branch_code: string; account_number: string }): Promise<Contact[]> {
    const r = await this.request<Envelope<Contact[]>>("GET", "/contacts" + this.qs({ bank_account_branch_code: query.branch_code, bank_account_account_number: query.account_number }));
    return r.body.data;
  }

  // ---- confirmation of payee -------------------------------------------
  async validateAccount(input: ValidateAccountInput): Promise<CopResult> {
    const body: Record<string, unknown> = {
      uid: input.uid,
      account_identifier: { type: "bban", value: input.bban },
      party_name: input.party_name,
      requester: { id: input.requester_id },
    };
    if (input.simulate) body.sandbox = { simulate: input.simulate };
    const r = await this.request<Envelope<CopResult>>("POST", "/cop/account/validate", body);
    return r.body.data;
  }

  // ---- payouts ----------------------------------------------------------
  async createPayment(input: CreatePaymentInput): Promise<PaymentBatch> {
    const { idempotency_key, ...body } = input;
    const r = await this.request<Envelope<PaymentBatch>>("POST", "/payments", body, { "Idempotency-Key": idempotency_key });
    return r.body.data;
  }

  async getPayment(ref: string): Promise<PaymentBatch> {
    const r = await this.request<Envelope<PaymentBatch>>("GET", `/payments/${encodeURIComponent(ref)}`);
    return r.body.data;
  }

  async transactions(query?: Record<string, string>): Promise<Transaction[]> {
    const r = await this.request<Envelope<Transaction[]>>("GET", "/transactions" + this.qs(query));
    return r.body.data;
  }

  // ---- PayTo agreements -------------------------------------------------
  async createAgreement(input: CreateAgreementInput): Promise<Agreement> {
    const { simulate, delay, ...rest } = input;
    const body: Record<string, unknown> = { ...rest };
    if (simulate) body.sandbox = { simulate, ...(delay !== undefined ? { delay } : {}) };
    const r = await this.request<Envelope<Agreement>>("POST", "/payto/agreements", body);
    return r.body.data;
  }

  async getAgreement(uid: string): Promise<Agreement> {
    const r = await this.request<Envelope<Agreement>>("GET", `/payto/agreements/${encodeURIComponent(uid)}`);
    return r.body.data;
  }

  async agreementHistory(uid: string): Promise<AgreementHistoryEvent[]> {
    const r = await this.request<Envelope<AgreementHistoryEvent[]>>("GET", `/payto/agreements/${encodeURIComponent(uid)}/history`);
    return r.body.data;
  }

  async amendAgreement(uid: string, changes: AmendmentChanges, simulate?: "debtor_accept" | "debtor_decline" | "expire", delay?: number): Promise<void> {
    const body: Record<string, unknown> = { changes };
    if (simulate) body.sandbox = { simulate, ...(delay !== undefined ? { delay } : {}) };
    await this.request("POST", `/payto/agreements/${encodeURIComponent(uid)}/amendment`, body);
  }

  async cancelAgreement(uid: string, reason: CancellationReason, narrative: string): Promise<void> {
    await this.request("POST", `/payto/agreements/${encodeURIComponent(uid)}/cancellation`, { reason, narrative });
  }

  async suspendAgreement(uid: string, reason: SuspensionReason, narrative: string): Promise<void> {
    await this.request("POST", `/payto/agreements/${encodeURIComponent(uid)}/suspension`, { reason, narrative });
  }

  async reactivateAgreement(uid: string): Promise<void> {
    await this.request("POST", `/payto/agreements/${encodeURIComponent(uid)}/reactivation`, {});
  }

  async simulateDebtorAction(uid: string, action: "cancellation" | "suspension" | "reactivation", narrative: string): Promise<void> {
    // The sandbox accepts reason/narrative for suspension and cancellation only;
    // a reactivation with either field is rejected as "not allowed".
    const body: Record<string, unknown> = { debtor_action: action };
    if (action !== "reactivation") {
      body.reason = "customer_requested";
      body.narrative = narrative;
    }
    await this.request("POST", `/payto/agreements/${encodeURIComponent(uid)}/simulate_debtor_action`, body);
  }

  // ---- PayTo payments ---------------------------------------------------
  async createPaytoPayment(input: CreatePaytoPaymentInput): Promise<PaytoPayment> {
    const { simulate, delay, ...rest } = input;
    const body: Record<string, unknown> = { ...rest, priority: "unattended" };
    if (simulate) body.sandbox = { simulate, ...(delay !== undefined ? { delay } : {}) };
    const r = await this.request<Envelope<PaytoPayment>>("POST", "/payto/payments", body);
    return r.body.data;
  }

  async getPaytoPayment(uid: string): Promise<PaytoPayment> {
    const r = await this.request<Envelope<PaytoPayment>>("GET", `/payto/payments/${encodeURIComponent(uid)}`);
    return r.body.data;
  }

  async retryPaytoPayment(uid: string, simulate?: PaytoPaymentSimulate, delay?: number): Promise<void> {
    const body: Record<string, unknown> = {};
    if (simulate) body.sandbox = { simulate, ...(delay !== undefined ? { delay } : {}) };
    await this.request("POST", `/payto/payments/${encodeURIComponent(uid)}/retry`, body);
  }

  async listPaytoPayments(query?: Record<string, string>): Promise<PaytoPayment[]> {
    const r = await this.request<Envelope<PaytoPayment[]>>("GET", "/payto/payments" + this.qs(query));
    return r.body.data;
  }

  // ---- webhooks (read-only by design: creation is portal-only) -----------
  async webhooks(): Promise<Webhook[]> {
    const r = await this.request<Envelope<Webhook[]>>("GET", "/webhooks");
    return r.body.data;
  }

  async webhookDeliveries(webhookId: string, query?: Record<string, string>): Promise<WebhookDelivery[]> {
    const r = await this.request<Envelope<WebhookDelivery[]>>("GET", `/webhooks/${encodeURIComponent(webhookId)}/deliveries` + this.qs(query));
    return r.body.data;
  }
}
