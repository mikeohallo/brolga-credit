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
  pendingAmendment?: { requestedAt: string; changes: Record<string, unknown> } | null;
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
  disbursement?: Disbursement | null;
  mandate?: Mandate | null;
  instalments: Instalment[];
  events: LoanEvent[];
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
const DB_FILE = path.join(DATA_DIR, "brolga.json");

type Cache = { db: Db | null };
const g = globalThis as unknown as { __brolgaDb?: Cache };
if (!g.__brolgaDb) g.__brolgaDb = { db: null };

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
  if (cache.db) return cache.db;
  try {
    if (fs.existsSync(DB_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DB_FILE, "utf8")) as Db;
      cache.db = parsed;
      return parsed;
    }
  } catch (err) {
    console.warn("[brolga] could not read data/brolga.json, starting fresh:", err);
  }
  const db = freshDb();
  cache.db = db;
  saveDb();
  return db;
}

export function saveDb(): void {
  const db = g.__brolgaDb!.db;
  if (!db) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

export function resetDb(): Db {
  const db = freshDb();
  g.__brolgaDb!.db = db;
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
  saveDb();
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
