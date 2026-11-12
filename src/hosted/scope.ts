// One request's view of the stored files. The hosted entry wraps a request that touches
// state in withStoreScope(): it takes the lock, loads every file into memory, lets the
// app's synchronous code read and write them through lib/files.ts, then saves whatever
// changed and lets the next request in. Concurrent requests in one Worker each get
// their own copy (AsyncLocalStorage), and are serialised by the Durable Object's lock.

import { AsyncLocalStorage } from "node:async_hooks";
import { installHost, resetMemory, type Files } from "../lib/files";
import type { Changes, Snapshot } from "./types";

export const LEASE_MS = 45_000;

export type StoreStub = {
  acquire(token: string, leaseMs: number): Promise<Snapshot>;
  release(token: string, changes: Changes): Promise<void>;
};

/** The stored files as one request sees them. Changes are tracked and saved at the end. */
export class MemoryFiles implements Files {
  private map = new Map<string, string>();
  private changed = new Set<string>();
  private removed = new Set<string>();

  constructor(snapshot: Snapshot) {
    for (const [name, text] of Object.entries(snapshot)) this.map.set(name, text);
  }

  /** A file that has no stored copy yet (the investigator's cases, the first time) starts from its seed. */
  seed(name: string, text: string): void {
    if (this.map.has(name)) return;
    this.map.set(name, text);
    this.changed.add(name);
  }

  exists(file: string): boolean {
    return this.map.has(file);
  }
  read(file: string): string {
    const text = this.map.get(file);
    if (text === undefined) throw new Error(`ENOENT: no such stored file, ${file}`);
    return text;
  }
  writeAtomic(file: string, text: string): void {
    this.map.set(file, text);
    this.changed.add(file);
    this.removed.delete(file);
  }
  remove(file: string): void {
    if (!this.map.delete(file)) return;
    this.changed.delete(file);
    this.removed.add(file);
  }
  copy(from: string, to: string): void {
    this.writeAtomic(to, this.read(from));
  }

  changes(): Changes {
    const out: Changes = {};
    for (const name of this.changed) out[name] = this.map.get(name) ?? null;
    for (const name of this.removed) out[name] = null;
    return out;
  }
}

const als = new AsyncLocalStorage<MemoryFiles>();

/** Tell lib/files.ts how to find the current request's files and how to open a scope. */
export function installScope(stub: () => StoreStub, seeds: Record<string, string>): void {
  installHost({
    files: () => {
      const f = als.getStore();
      if (!f) throw new Error("Stored state was read outside a request scope.");
      return f;
    },
    inStore: (fn) => withStoreScope(stub(), seeds, fn),
  });
}

export async function withStoreScope<T>(stub: StoreStub, seeds: Record<string, string>, fn: () => Promise<T> | T): Promise<T> {
  if (als.getStore()) return fn(); // already inside a scope: the lock is held
  const token = crypto.randomUUID();
  const snapshot = await stub.acquire(token, LEASE_MS);
  const mem = new MemoryFiles(snapshot);
  for (const [name, text] of Object.entries(seeds)) mem.seed(name, text);
  resetMemory();
  let result: T;
  try {
    result = await als.run(mem, async () => fn());
  } catch (err) {
    // What a handler wrote before it failed is kept, as it is on a machine where each write lands at once.
    // The caches are dropped before the lock is let go: after it, the next request may already be loading its own.
    resetMemory();
    await stub.release(token, mem.changes()).catch(() => undefined);
    throw err;
  }
  resetMemory();
  await stub.release(token, mem.changes());
  return result;
}
