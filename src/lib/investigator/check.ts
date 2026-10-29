// The citation check: code decides whether a briefing may be shown. Every claim
// must point at a record id, and every id must exist in the case file the model
// was given. A briefing that fails is rejected whole and the rejection counted;
// no one sees a briefing that rests on a record that isn't there.

import type { Briefing, CheckResult } from "./types";

export function checkBriefing(briefing: Briefing | null, citable: Set<string>, shapeErrors: string[] = []): CheckResult {
  const reasons: string[] = [...shapeErrors];
  if (!briefing) {
    return { accepted: false, claims: 0, uncited: 0, badIds: [], badClaims: 0, shapeErrors, reasons: reasons.length ? reasons : ["no briefing was parsed"] };
  }
  const claims: { where: string; ids: string[] }[] = [
    ...briefing.timeline.map((c, i) => ({ where: `timeline[${i}]`, ids: c.ids })),
    ...briefing.known_for_certain.map((c, i) => ({ where: `known_for_certain[${i}]`, ids: c.ids })),
    ...briefing.explanations.map((e, i) => ({ where: `explanations[${i}] (${e.diagnosis})`, ids: [...e.supporting_ids, ...e.against_ids] })),
    { where: "next_step", ids: briefing.next_step.ids },
  ];
  let uncited = 0;
  let badClaims = 0;
  const badIds = new Set<string>();
  for (const c of claims) {
    if (!c.ids.length) {
      uncited += 1;
      reasons.push(`${c.where}: cites no record`);
    }
    let bad = false;
    for (const id of c.ids) {
      if (!citable.has(id)) {
        bad = true;
        badIds.add(id);
        reasons.push(`${c.where}: cites ${id}, which is not in the case file`);
      }
    }
    if (bad) badClaims += 1;
  }
  const accepted = shapeErrors.length === 0 && uncited === 0 && badIds.size === 0;
  return { accepted, claims: claims.length, uncited, badIds: [...badIds], badClaims, shapeErrors, reasons };
}

/** Every id a briefing cites anywhere, for scoring "did it cite what it had to". */
export function citedIds(briefing: Briefing): Set<string> {
  const ids = new Set<string>();
  for (const c of [...briefing.timeline, ...briefing.known_for_certain]) c.ids.forEach((i) => ids.add(i));
  for (const e of briefing.explanations) [...e.supporting_ids, ...e.against_ids].forEach((i) => ids.add(i));
  briefing.next_step.ids.forEach((i) => ids.add(i));
  return ids;
}
