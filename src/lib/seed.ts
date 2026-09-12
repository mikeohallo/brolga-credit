import type { Borrower } from "./db";

// Six fictional borrowers. Account numbers are deliberately unusual: in Zepto's
// shared sandbox, common test numbers such as 062000 / 12345678 already belong to
// other sandbox accounts, and a contact created against them resolves to that
// account holder rather than to a fresh "anyone" contact.
export function seedBorrowers(now: string): Borrower[] {
  const rows: [string, string, string, string][] = [
    ["Priya Nair", "priya.nair@example.com", "062000", "31877204"],
    ["Tom Whitlock", "tom.whitlock@example.com", "083004", "44192067"],
    ["Amara Okafor", "amara.okafor@example.com", "032002", "57730118"],
    ["Liam Nguyen", "liam.nguyen@example.com", "013006", "62051993"],
    ["Sofia Rossi", "sofia.rossi@example.com", "484799", "78320415"],
    ["Jack Carter", "jack.carter@example.com", "802985", "89610327"],
  ];
  return rows.map(([name, email, bsb, accountNumber], i) => ({
    id: `BRW-${String(i + 1).padStart(4, "0")}`,
    name,
    email,
    bsb,
    accountNumber,
    createdAt: now,
  }));
}
