import { ok } from "@/lib/api";
import { resetDb } from "@/lib/db";
import { resetMock } from "@/lib/zepto/mock";
import { configuredMode } from "@/lib/zepto";

export const dynamic = "force-dynamic";

// Archives the current store beside itself, then clears Brolga's local state.
// Zepto-side objects (contacts, payments, agreements) stay in the sandbox — they
// are real API objects — but the app forgets them. In mock mode the mock
// provider is reset too, so the rehearsal starts from nothing.
export async function POST() {
  resetDb();
  if (configuredMode() === "mock") resetMock();
  (globalThis as unknown as { __brolgaHealth?: unknown }).__brolgaHealth = undefined;
  return ok({ ok: true });
}
