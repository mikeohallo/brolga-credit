// A deliberately small JSON-file store. Brolga is a demo: one process, one operator,
// no concurrency to speak of. Everything the app knows lives in data/brolga.json so
// that a technical reviewer can open it and see exactly what state the app holds and
// which Zepto references it is tracking.

import fs from "node:fs";
import path from "node:path";
import { seedBorrowers } from "./seed";

export type CopCheck = {
  uid: string;
  result: "match" | "close_match" | "no_match" | "account_closed" | "error";
  matchName?: string | null;
  riskScore?: number;
  suggestedChannels?: string[];
  simulated?: string;
  checkedAt: string;
  error?: string;
};

export type Borrower = {
  id: string; // BRW-0001
  name: string;
  email: string;
  bsb: string;
  accountNumber: string;
  zeptoContactId?: string;
  zeptoContactRef?: string;
  bankName?: string;
  cop?: CopCheck;
  createdAt: string;
};

export type LoanStatus =
  | "draft"
  | "verified"
  | "disbursing"
  | "disbursed"
  | "disbursement_failed"
  | "mandate_pending"
  | "active"
  | "in_arrears"
  | "suspended"
  | "closed"
  | "cancelled";

export type InstalmentState =
  | "scheduled"
  | "unknown" // an intent was sent but no answer came back; recovered on the next refresh
  | "created"
  | "submitting"
  | "pending"
  | "under_investigation"
  | "settled"
  | "failed";

export type Instalment = {
  n: number;
  dueDate: string; // YYYY-MM-DD (Sydney)
  amountCents: number;
  paymentUid?: string;
  state: InstalmentState;
  failure?: { code: string; title: string; detail: string; retryable: boolean } | null;
  attempts: number;
  updatedAt?: string;
};

export type LoanEvent = {
  at: string;
  type: string;
  message: string;
  level: "info" | "success" | "warning" | "error";
  ref?: string;
};

export type DisbursementIntent = {
  key: string; // the Idempotency-Key — the same key is reused until Zepto answers, so a lost response can never mint a second payout
  attempt: number;
  amountCents: number;
  channels: string[];
  fromBankAccountId: string;
  fundingLabel: string;
  forceFailure?: string;
  createdAt: string;
  outcome: "sending" | "unknown";
};

export type Adjustment = {
  at: string;
  type: "rounding" | "override" | "write_off";
  cents: number; // signed change to the obligation (fee)
  note: string;
};

export type Disbursement = {
  paymentRef: string; // PB.*
  payoutRef: string; // D.* — the debit from Brolga's account
  status: string; // debit status
  creditRef?: string; // C.* — the credit to the borrower (visible via both_parties=true)
  creditStatus?: string; // the status that actually matters: cleared = funds landed, returned = failed
  reversalRef?: string; // C.* payout_reversal, when the credit is returned
  channels: string[];
  currentChannel?: string;
  fromBankAccountId?: string;
  fundingLabel: string;
  failure?: { code: string; title: string; detail: string } | null;
  attempt?: number;
  failedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  clearedAt?: string | null;
};

export type Mandate = {
  uid: string;
  state: string;
  stateReason?: { code: string; title: string; detail: string } | null;
  stateCausedBy?: string | null;
  mmsAgreementId?: string | null;
  firstPaymentDate: string;
  lastPaymentDate: string;
  validityEndDate: string;
  instalmentCents: number;
  pendingAmendment?: {
    requestedAt: string;
    changes: Record<string, unknown>;
    // The revised schedule Brolga will apply if the borrower authorises: it is
    // computed from the remaining obligation, never from the mandate amount alone.
    plan: { instalmentCents: number; count: number; firstDueDate: string; lastDueDate: string; roundingCents: number; remainingCents: number };
  } | null;
  createdAt: string;
  updatedAt: string;
};

export type Loan = {
  id: string; // LN-0001
  borrowerId: string;
  purpose: string;
  principalCents: number;
  feeCents: number;
  termFortnights: number;
  instalmentCents: number;
  status: LoanStatus;
  copHold?: boolean; // Confirmation of Payee said no match / account closed; disbursement needs a recorded override
  copOverride?: { by: string; reason: string; at: string } | null;
  disbursement?: Disbursement | null;
  disbursementIntent?: DisbursementIntent | null;
  disbursementAttempts?: number;
  adjustments?: Adjustment[];
  mandate?: Mandate | null;
  instalments: Instalment[];
  events: LoanEvent[];
  lastRefreshedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type ApiLogEntry = {
  id: number;
  at: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  ok: boolean;
  requestId?: string;
  apiVersion?: string;
  idempotencyKey?: string;
  error?: string;
  requestBody?: unknown;
  responseSnippet?: string;
  mode: "sandbox" | "mock";
  context?: string; // e.g. "LN-0001 disburse"
};

export type Db = {
  version: 1;
  seededAt: string;
  runId: string; // short id minted on every reset; namespaces Zepto-facing uids and idempotency keys so demo resets never collide with objects the sandbox still remembers
  counters: { borrower: number; loan: number; apilog: number };
  borrowers: Borrower[];
  loans: Loan[];
  apilog: ApiLogEntry[];
};

const DATA_DIR = path.join(process.cwd(), "data");

// Sandbox and mock runs never share a store: a mock rehearsal must not overwrite
// the references from a real sandbox run, and vice versa.
function storeFile(): string {
  const mode = (process.env.ZEPTO_MODE ?? "").toLowerCase() === "mock" || (!process.env.ZEPTO_TOKEN && (process.env.ZEPTO_MODE ?? "").toLowerCase() !== "sandbox") ? "mock" : "sandbox";
  return path.join(DATA_DIR, mode === "mock" ? "brolga.mock.json" : "brolga.json");
}

export type StoreStatus = { file: string; readable: boolean; error?: string };

type Cache = { db: Db | null; file: string | null; error: string | null };
const g = globalThis as unknown as { __brolgaDb?: Cache };
if (!g.__brolgaDb) g.__brolgaDb = { db: null, file: null, error: null };

export function storeStatus(): StoreStatus {
  loadDb();
  const c = g.__brolgaDb!;
  return { file: c.file ?? storeFile(), readable: !c.error, error: c.error ?? undefined };
}

export function freshDb(): Db {
  const now = new Date().toISOString();
  const borrowers = seedBorrowers(now);
  return {
    version: 1,
    seededAt: now,
    runId: Date.now().toString(36).slice(-5),
    counters: { borrower: borrowers.length, loan: 0, apilog: 0 },
    borrowers,
    loans: [],
    apilog: [],
  };
}

export function loadDb(): Db {
  const cache = g.__brolgaDb!;
  const file = storeFile();
  if (cache.db && cache.file === file) return cache.db;
  cache.file = file;
  cache.error = null;
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Db;
      if (!parsed || !Array.isArray(parsed.loans) || !Array.isArray(parsed.borrowers)) throw new Error("not a Brolga store");
      parsed.loans.forEach((l) => {
        l.adjustments ??= [];
      });
      cache.db = parsed;
      return parsed;
    } catch (err) {
      // An unreadable store is never overwritten: the file is left exactly as it is
      // (it may hold references to real money movements), the app runs read-only on
      // an empty in-memory store, and every write fails loudly until someone moves
      // the file aside.
      cache.error = `${path.relative(process.cwd(), file)} is unreadable (${(err as Error).message}). It has been left untouched; move it aside to start fresh.`;
      console.warn("[brolga] " + cache.error);
      cache.db = freshDb();
      return cache.db;
    }
  }
  const db = freshDb();
  cache.db = db;
  saveDb();
  return db;
}

export function saveDb(): void {
  const cache = g.__brolgaDb!;
  const db = cache.db;
  if (!db) return;
  if (cache.error) throw new Error(`Refusing to write: ${cache.error}`);
  const file = cache.file ?? storeFile();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, file);
}

/** Archive the current store (if any) beside itself, then start clean. */
export function resetDb(): Db {
  const cache = g.__brolgaDb!;
  const file = storeFile();
  if (fs.existsSync(file) && !cache.error) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    try {
      fs.copyFileSync(file, file.replace(/\.json$/, `.archive-${stamp}.json`));
    } catch {
      /* archiving is best effort */
    }
  }
  const db = freshDb();
  cache.db = db;
  cache.file = file;
  cache.error = null;
  saveDb();
  return db;
}

export function runId(): string {
  const db = loadDb();
  if (!db.runId) {
    db.runId = Date.now().toString(36).slice(-5);
    saveDb();
  }
  return db.runId;
}

export function nextId(kind: "borrower" | "loan"): string {
  const db = loadDb();
  db.counters[kind] += 1;
  const n = db.counters[kind].toString().padStart(4, "0");
  return kind === "borrower" ? `BRW-${n}` : `LN-${n}`;
}

export function appendApiLog(entry: Omit<ApiLogEntry, "id">): ApiLogEntry {
  const db = loadDb();
  db.counters.apilog += 1;
  const full: ApiLogEntry = { id: db.counters.apilog, ...entry };
  db.apilog.push(full);
  if (db.apilog.length > 400) db.apilog.splice(0, db.apilog.length - 400);
  try {
    saveDb();
  } catch {
    /* the log is best effort; an unreadable store already surfaces elsewhere */
  }
  return full;
}

export function getBorrower(id: string): Borrower | undefined {
  return loadDb().borrowers.find((b) => b.id === id);
}

export function getLoan(id: string): Loan | undefined {
  return loadDb().loans.find((l) => l.id === id);
}

export function pushEvent(loan: Loan, type: string, message: string, level: LoanEvent["level"] = "info", ref?: string): void {
  loan.events.push({ at: new Date().toISOString(), type, message, level, ref });
  loan.updatedAt = new Date().toISOString();
}
