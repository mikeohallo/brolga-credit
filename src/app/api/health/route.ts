import { ok, fail } from "@/lib/api";
import { configuredMode, getZepto, withApiContext, ZeptoError } from "@/lib/zepto";
import { funding } from "@/lib/domain/loans";
import { loadDb, storeStatus } from "@/lib/db";

export const dynamic = "force-dynamic";

type Probe = { name: string; scope: string; ok: boolean; note?: string };
type Health = Record<string, unknown> & { checkedAt: string };

// Scope probes make real calls (one of them a CoP validation, which has daily
// quotas), so the result is cached per process and only re-run on demand.
const g = globalThis as unknown as { __brolgaHealth?: { at: number; mode: string; value: Health } };
const TTL_MS = 60 * 60 * 1000; // the CoP probe consumes validation quota, so it runs once an hour or on an explicit Re-check

export async function GET(req: Request) {
  const z = getZepto();
  const mode = configuredMode();
  const force = new URL(req.url).searchParams.get("force") === "1";
  const cached = g.__brolgaHealth;
  const db = loadDb();
  if (!force && cached && cached.mode === mode && Date.now() - cached.at < TTL_MS) {
    return ok({ ...cached.value, counts: { borrowers: db.borrowers.length, loans: db.loans.length, apiCalls: db.counters.apilog }, store: storeStatus(), cached: true });
  }
  try {
    const result = await withApiContext("dashboard · connection check", async () => {
      const user = await z.user();
      const f = await funding();
      const probes: Probe[] = [];
      // Each probe names the exact call it makes. A green result means "this read
      // (or this one validation) succeeded with this token" — not that every write
      // in the family will. Any auth failure, refusal or unresolved error is red.
      const probe = async (name: string, scope: string, endpoint: string, fn: () => Promise<unknown>) => {
        try {
          await fn();
          probes.push({ name, scope, ok: true, note: endpoint });
        } catch (err) {
          if (err instanceof ZeptoError && err.requiredScope) probes.push({ name, scope, ok: false, note: `${endpoint} — missing scope ${err.requiredScope}` });
          else if (err instanceof ZeptoError && (err.status === 401 || err.status === 403)) probes.push({ name, scope, ok: false, note: `${endpoint} — refused (${err.status}${err.detail ? `: ${err.detail}` : ""})` });
          else if (err instanceof ZeptoError) probes.push({ name, scope, ok: false, note: `${endpoint} — ${err.code ?? err.status} ${err.title}` });
          else probes.push({ name, scope, ok: false, note: `${endpoint} — ${(err as Error).message}` });
        }
      };
      await probe("Payouts", "payments", "GET /transactions", () => z.transactions({ per_page: "1" }));
      await probe("PayTo agreements", "pay_to_agreements", "GET /payto/payments", () => z.listPaytoPayments({ per_page: "1" }));
      await probe("Confirmation of Payee", "cop_account_validations", "POST /cop/account/validate (sandbox simulate)", () =>
        z.validateAccount({ uid: `probe-${Date.now().toString(36)}`, party_name: "Probe", bban: "062000-00000001", requester_id: "brolga-probe", simulate: "match" }),
      );
      await probe("Webhooks", "webhooks", "GET /webhooks", () => z.webhooks());
      return { user, funding: f, probes };
    });
    const value: Health = {
      mode,
      apiVersion: mode === "mock" ? "mock" : process.env.ZEPTO_API_VERSION ?? "20260101",
      baseUrl: mode === "mock" ? "in-memory mock" : process.env.ZEPTO_BASE_URL ?? "https://api.sandbox.zeptopayments.com",
      account: result.user.account,
      operator: `${result.user.first_name} ${result.user.last_name}`,
      funding: {
        label: result.funding.label,
        nppCapable: result.funding.nppCapable,
        channels: result.funding.channels,
        accountType: result.funding.account.account_type,
        availableBalance: result.funding.account.available_balance,
        accounts: result.funding.allAccounts,
      },
      probes: result.probes,
      probeNote: "Read probes plus one sandbox-simulated CoP validation; write capabilities (payouts, agreements, collections) are proven only by using them.",
      checkedAt: new Date().toISOString(),
    };
    g.__brolgaHealth = { at: Date.now(), mode, value };
    return ok({ ...value, counts: { borrowers: db.borrowers.length, loans: db.loans.length, apiCalls: db.counters.apilog }, store: storeStatus(), cached: false });
  } catch (err) {
    return fail(err, 502);
  }
}
