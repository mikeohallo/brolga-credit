import { ok, fail } from "@/lib/api";
import { configuredMode, getZepto, withApiContext, ZeptoError } from "@/lib/zepto";
import { funding } from "@/lib/domain/loans";
import { loadDb } from "@/lib/db";

export const dynamic = "force-dynamic";

type Probe = { name: string; scope: string; ok: boolean; note?: string };
type Health = Record<string, unknown> & { checkedAt: string };

// Scope probes make real calls (one of them a CoP validation, which has daily
// quotas), so the result is cached per process and only re-run on demand.
const g = globalThis as unknown as { __brolgaHealth?: { at: number; mode: string; value: Health } };
const TTL_MS = 10 * 60 * 1000;

export async function GET(req: Request) {
  const z = getZepto();
  const mode = configuredMode();
  const force = new URL(req.url).searchParams.get("force") === "1";
  const cached = g.__brolgaHealth;
  const db = loadDb();
  if (!force && cached && cached.mode === mode && Date.now() - cached.at < TTL_MS) {
    return ok({ ...cached.value, counts: { borrowers: db.borrowers.length, loans: db.loans.length, apiCalls: db.counters.apilog }, cached: true });
  }
  try {
    const result = await withApiContext("dashboard · connection check", async () => {
      const user = await z.user();
      const f = await funding();
      const probes: Probe[] = [];
      const probe = async (name: string, scope: string, fn: () => Promise<unknown>) => {
        try {
          await fn();
          probes.push({ name, scope, ok: true });
        } catch (err) {
          if (err instanceof ZeptoError && err.requiredScope) probes.push({ name, scope, ok: false, note: `missing scope ${err.requiredScope}` });
          else if (err instanceof ZeptoError) probes.push({ name, scope, ok: err.status < 500 && err.status !== 403, note: `${err.code ?? err.status} ${err.title}` });
          else probes.push({ name, scope, ok: false, note: (err as Error).message });
        }
      };
      await probe("Payouts", "payments", () => z.transactions({ per_page: "1" }));
      await probe("PayTo agreements", "pay_to_agreements", () => z.listPaytoPayments({ per_page: "1" }));
      await probe("Confirmation of Payee", "cop_account_validations", () =>
        z.validateAccount({ uid: `probe-${Date.now().toString(36)}`, party_name: "Probe", bban: "062000-00000001", requester_id: "brolga-probe", simulate: "match" }),
      );
      await probe("Webhooks", "webhooks", () => z.webhooks());
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
      checkedAt: new Date().toISOString(),
    };
    g.__brolgaHealth = { at: Date.now(), mode, value };
    return ok({ ...value, counts: { borrowers: db.borrowers.length, loans: db.loans.length, apiCalls: db.counters.apilog }, cached: false });
  } catch (err) {
    return fail(err, 502);
  }
}
