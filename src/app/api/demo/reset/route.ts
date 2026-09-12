import { ok } from "@/lib/api";
import { resetDb } from "@/lib/db";
import { resetMock } from "@/lib/zepto/mock";

export const dynamic = "force-dynamic";

// Clears Brolga's local state. Zepto-side objects (contacts, payments, agreements)
// stay in the sandbox — they are real API objects — but the app forgets them.
export async function POST() {
  resetDb();
  resetMock();
  (globalThis as unknown as { __brolgaHealth?: unknown }).__brolgaHealth = undefined;
  return ok({ ok: true });
}
