// All six generators in one run, and the held-back split: every third case
// (by position across the whole set) is held back from prompt work and run only
// in the final comparison. Position, not judgement, decides which, so the
// held-back twenty are spread across every type and every kind of difficulty.

import type { InvestigatorCase } from "../types";
import { generateAmountMismatchCases, GENERATOR as G6 } from "./amount-mismatch";
import { generateDuplicateCases, GENERATOR as G2 } from "./duplicate";
import { generateLateCopCases, GENERATOR as G4 } from "./late-cop";
import { generateOrphanCases, GENERATOR as G3 } from "./orphan";
import { generateReturnedPayoutCases, GENERATOR as G5 } from "./returned-payout";
import type { Clock } from "./shared";
import { generateTimeoutCases, GENERATOR as G1 } from "./timeout";

export const GENERATOR = `six types (29 Oct 2026): ${[G1, G2, G3, G4, G5, G6].join("; ")}`;

export const GENERATORS: { type: string; run: (clock: Clock) => Promise<InvestigatorCase[]> }[] = [
  { type: "timeout", run: generateTimeoutCases },
  { type: "duplicate", run: generateDuplicateCases },
  { type: "orphan_provider_record", run: generateOrphanCases },
  { type: "late_cop_failure", run: generateLateCopCases },
  { type: "returned_payout", run: generateReturnedPayoutCases },
  { type: "amount_mismatch", run: generateAmountMismatchCases },
];

export function markHeldBack(cases: InvestigatorCase[]): InvestigatorCase[] {
  cases.forEach((c, i) => {
    c.heldBack = i % 3 === 2;
  });
  return cases;
}

export async function generateAllCases(clock: Clock): Promise<InvestigatorCase[]> {
  const all: InvestigatorCase[] = [];
  for (const g of GENERATORS) {
    all.push(...(await g.run(clock)));
  }
  return markHeldBack(all);
}
