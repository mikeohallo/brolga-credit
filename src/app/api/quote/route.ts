import { ok } from "@/lib/api";
import { quote } from "@/lib/domain/loans";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const u = new URL(req.url);
  const principal = Number(u.searchParams.get("principal") ?? 0);
  const term = Number(u.searchParams.get("term") ?? 0);
  if (!principal || !term) return ok({ error: "principal and term required" }, { status: 400 });
  return ok(quote(principal, term));
}
