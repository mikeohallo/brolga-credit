import { ok } from "@/lib/api";
import { loadDb } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const u = new URL(req.url);
  const since = Number(u.searchParams.get("since") ?? 0);
  const db = loadDb();
  const entries = db.apilog.filter((e) => e.id > since).slice(-150);
  return ok({ entries, total: db.counters.apilog });
}
