import { ok, fail, readJson } from "@/lib/api";
import { loadDb } from "@/lib/db";
import { addBorrower } from "@/lib/domain/loans";

export const dynamic = "force-dynamic";

export async function GET() {
  const db = loadDb();
  return ok({ borrowers: db.borrowers, loans: db.loans.map((l) => ({ id: l.id, borrowerId: l.borrowerId, status: l.status, principalCents: l.principalCents })) });
}

export async function POST(req: Request) {
  try {
    const body = await readJson<{ name: string; email: string; bsb: string; accountNumber: string }>(req);
    if (!body.name || !body.email || !body.bsb || !body.accountNumber) throw new Error("name, email, bsb and accountNumber are required");
    if (!/^\d{6}$/.test(body.bsb.replace(/\D/g, ""))) throw new Error("BSB must be 6 digits");
    if (!/^\d{5,9}$/.test(body.accountNumber.replace(/\D/g, ""))) throw new Error("Account number must be 5–9 digits");
    return ok(addBorrower(body), { status: 201 });
  } catch (err) {
    return fail(err);
  }
}
