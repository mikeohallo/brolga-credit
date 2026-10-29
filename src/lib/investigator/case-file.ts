// The case file: everything the investigator is allowed to know about one loan,
// as plain text, every record carrying a short id. The model sees this file and
// nothing else; every claim it makes must point at one of these ids. Records are
// captured when the case is made (and appended when evidence arrives), never
// fetched at briefing time, so the same case file always produces the same hash.

import { createHash } from "node:crypto";
import { loadDb, type Borrower, type Loan } from "../db";
import { aud, shortDate } from "../format";
import { EXCEPTION_TYPES, type ExceptionType } from "./labels";

/** Where a record came from. The id prefix follows the source: B, P or S. */
export type RecordSource = "brolga" | "provider" | "support";

export type CaseRecord = {
  id: string; // B1, P2, S1 ... assigned by assignIds, stable for the life of the case
  source: RecordSource;
  at: string; // ISO time the record was made or captured
  kind: string; // a short machine label: "loan", "event:instalment.unknown", "GET /payto/payments/{uid}", "note"
  text: string; // what the record says, in one or a few sentences
};

export type CaseFileInput = {
  caseId: string;
  type: ExceptionType;
  loanId: string;
  question: string;
  records: CaseRecord[];
};

export type RenderedCaseFile = { text: string; hash: string; wordCount: number };

const PREFIX: Record<RecordSource, string> = { brolga: "B", provider: "P", support: "S" };
const SOURCE_TITLE: Record<RecordSource, string> = {
  brolga: "BROLGA'S OWN RECORDS (what the app did and recorded)",
  provider: "THE PROVIDER'S RECORDS (what Zepto's API returned when asked)",
  support: "SUPPORT AND OPERATOR NOTES (what people said; not evidence of what the provider holds)",
};

/**
 * Give ids to records that have none. Numbering continues from the highest id
 * already present for that source, so evidence appended later gets the next
 * number and nothing already cited ever changes.
 */
export function assignIds(records: (Omit<CaseRecord, "id"> & { id?: string })[]): CaseRecord[] {
  const next: Record<RecordSource, number> = { brolga: 0, provider: 0, support: 0 };
  for (const r of records) {
    if (!r.id) continue;
    const n = Number(r.id.slice(1));
    if (r.id[0] === PREFIX[r.source] && Number.isInteger(n) && n > next[r.source]) next[r.source] = n;
  }
  return records.map((r) => {
    if (r.id) return r as CaseRecord;
    next[r.source] += 1;
    return { ...r, id: `${PREFIX[r.source]}${next[r.source]}` };
  });
}

/** Mask an account number the way a desk would print it; the data is synthetic, the habit is not. */
export function maskAccount(bsb: string, accountNumber: string): string {
  return `BSB ${bsb}, account ending ${accountNumber.slice(-3)}`;
}

/** Brolga's own records for a loan, one per fact the investigator might need, in the order they happened. */
export function brolgaRecords(loan: Loan, borrower: Borrower): Omit<CaseRecord, "id">[] {
  const out: Omit<CaseRecord, "id">[] = [];
  out.push({
    source: "brolga",
    at: loan.createdAt,
    kind: "loan",
    text: `Loan ${loan.id} for ${borrower.name} (${borrower.id}): ${aud(loan.principalCents)} principal, ${aud(loan.feeCents)} fee, ${loan.termFortnights} fortnightly instalments of ${aud(loan.instalmentCents)}. Purpose: ${loan.purpose}. Status recorded by the app: ${loan.status}.`,
  });
  out.push({
    source: "brolga",
    at: borrower.createdAt,
    kind: "borrower",
    text: `Borrower ${borrower.id}: ${borrower.name}, ${maskAccount(borrower.bsb, borrower.accountNumber)}${borrower.bankName ? ` (${borrower.bankName})` : ""}. Confirmation of Payee: ${borrower.cop ? `${borrower.cop.result.replace("_", " ")} at ${seconds(borrower.cop.checkedAt)}` : "not run"}.`,
  });
  if (loan.disbursement) {
    const d = loan.disbursement;
    out.push({
      source: "brolga",
      at: d.createdAt,
      kind: "disbursement",
      text: `Disbursement: batch ${d.paymentRef}, payout ${d.payoutRef}, debit status "${d.status}", borrower-side credit ${d.creditRef ? `${d.creditRef} status "${d.creditStatus}"` : "not yet seen"}${d.clearedAt ? `, cleared at ${seconds(d.clearedAt)}` : ""}. Funding: ${d.fundingLabel}.`,
    });
  }
  if (loan.copHold || loan.copOverride) {
    out.push({
      source: "brolga",
      at: loan.copOverride?.at ?? loan.updatedAt,
      kind: "cop-hold",
      text: loan.copHold
        ? "Confirmation of Payee hold is in force on this loan: the app refuses to disburse until a named person records an override with a reason."
        : `Confirmation of Payee hold was overridden by ${loan.copOverride!.by} at ${seconds(loan.copOverride!.at)}: "${loan.copOverride!.reason}".`,
    });
  }
  if (loan.mandate) {
    const m = loan.mandate;
    out.push({
      source: "brolga",
      at: m.createdAt,
      kind: "mandate",
      text: `PayTo agreement ${m.uid}: state "${m.state}" as the app last saw it, ${aud(m.instalmentCents)} fortnightly from ${shortDate(m.firstPaymentDate)} to ${shortDate(m.lastPaymentDate)}${m.mmsAgreementId ? ", authorised by the borrower's bank" : ""}.${m.pendingAmendment ? ` An amendment to ${aud(m.pendingAmendment.plan.instalmentCents)} fortnightly (${m.pendingAmendment.plan.count} instalments) was requested at ${seconds(m.pendingAmendment.requestedAt)} and the app has not yet seen the borrower's answer.` : ""}`,
    });
  }
  for (const a of loan.adjustments ?? []) {
    out.push({ source: "brolga", at: a.at, kind: `adjustment:${a.type}`, text: `Adjustment (${a.type}) of ${a.cents} cents to the obligation: ${a.note}` });
  }
  for (const i of loan.instalments) {
    const bits = [`Instalment ${i.n} of ${loan.instalments.length}: due ${shortDate(i.dueDate)}, ${aud(i.amountCents)}, state "${i.state}"`];
    if (i.paymentUid) bits.push(`payment uid ${i.paymentUid}`);
    if (i.attempts) bits.push(`${i.attempts} attempt${i.attempts === 1 ? "" : "s"}`);
    if (i.failure) bits.push(`last failure ${i.failure.code} ${i.failure.title} (${i.failure.retryable ? "retryable" : "not retryable"})`);
    if (i.state === "unknown") bits.push("meaning: a request was sent and no answer came back; the app has not confirmed whether the provider holds this payment");
    out.push({ source: "brolga", at: i.updatedAt ?? loan.createdAt, kind: `instalment:${i.n}`, text: bits.join("; ") + "." });
  }
  for (const e of loan.events) {
    // The MMS id is minted at random by the provider and carries no meaning for a
    // reader; it is dropped so the same case always renders to the same text.
    const message = e.message.replace(/ · MMS id [0-9a-f]{32}/, "");
    out.push({ source: "brolga", at: e.at, kind: `event:${e.type}`, text: `${message}${e.ref ? ` [ref ${e.ref}]` : ""}` });
  }
  return out;
}

/**
 * The app's own API log for a loan, errors only: every request the app made for
 * this loan that came back with an error, as the console shows it. A refused
 * request is often the clue (one payment per period, amount mismatch), and it
 * never appears on the timeline because nothing happened.
 */
export function appLogErrorRecords(loanId: string): Omit<CaseRecord, "id">[] {
  return loadDb()
    .apilog.filter((e) => !e.ok && e.context?.startsWith(`${loanId} ·`))
    .map((e) => ({ source: "brolga" as const, at: e.at, kind: `api-log:${e.method} ${e.path.split("?")[0]}`, text: `App request ${e.method} ${e.path.split("?")[0]} (${e.context}) was refused: HTTP ${e.status}${e.error ? `, ${e.error}` : ""}. Nothing was created.` }));
}

/** The provider's answer to one request, as a record. Pass an Error (or a message) for a failed or missing answer. */
export function providerRecord(at: string, request: string, outcome: string): Omit<CaseRecord, "id"> {
  return { source: "provider", at, kind: request, text: outcome };
}

export function supportNote(at: string, who: string, text: string): Omit<CaseRecord, "id"> {
  return { source: "support", at, kind: "note", text: `${who}: ${text}` };
}

/** ISO time to the second; milliseconds add nothing for a reader and vary between runs of the mock. */
export function seconds(iso: string): string {
  return iso.replace(/\.\d{3}Z$/, "Z");
}

export function renderCaseFile(input: CaseFileInput): RenderedCaseFile {
  const t = EXCEPTION_TYPES[input.type];
  const lines: string[] = [];
  lines.push(`CASE ${input.caseId} · ${t.code} ${t.title} · loan ${input.loanId}`);
  lines.push("");
  lines.push("QUESTION");
  lines.push(input.question);
  lines.push("");
  lines.push("HOW TO READ THIS FILE");
  lines.push("Every record below has an id in square brackets. B records are what Brolga (the loan desk app) did and recorded; P records are what the payments provider's API returned when it was asked, exactly as returned; S records are what support staff, operators or the borrower said. Only P records show what the provider holds. A record that says a request got no answer is not a record of failure.");
  for (const source of ["brolga", "provider", "support"] as RecordSource[]) {
    const rows = input.records.filter((r) => r.source === source);
    lines.push("");
    lines.push(SOURCE_TITLE[source]);
    if (!rows.length) lines.push("(none)");
    for (const r of rows) lines.push(`[${r.id}] ${seconds(r.at)} · ${r.kind} · ${r.text}`);
  }
  lines.push("");
  lines.push("END OF CASE FILE");
  const text = lines.join("\n");
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  return { text, hash, wordCount };
}

/** The set of ids a briefing may cite for this file. */
export function citableIds(records: CaseRecord[]): Set<string> {
  return new Set(records.map((r) => r.id));
}
