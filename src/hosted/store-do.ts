// The hosted build's state: one Durable Object holding every stored file (the loans,
// the mock provider, the investigator's cases, briefings and marks), and a lock so one
// request at a time reads and writes them. SQLite-backed; a file is rows of chunks.
//
// acquire() waits for the lock and hands back every file; release() saves what the
// request changed in one transaction and lets the next request in. A request that
// holds the lock past its lease loses it and its release is refused (nothing saved).

import { DurableObject } from "cloudflare:workers";
import { joinChunks, splitChunks } from "./chunks";
import { LockLostError, LockQueue } from "./lock";
import type { Changes, Snapshot } from "./types";


export class BrolgaStore extends DurableObject {
  private lock = new LockQueue();

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS chunks (name TEXT NOT NULL, idx INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (name, idx))");
    });
  }

  async acquire(token: string, leaseMs: number): Promise<Snapshot> {
    await this.lock.acquire(token, leaseMs);
    const rows = this.ctx.storage.sql.exec("SELECT name, idx, body FROM chunks").toArray() as { name: string; idx: number; body: string }[];
    const byName = new Map<string, { idx: number; body: string }[]>();
    for (const r of rows) {
      const list = byName.get(r.name) ?? [];
      list.push({ idx: r.idx, body: r.body });
      byName.set(r.name, list);
    }
    const out: Snapshot = {};
    for (const [name, list] of byName) out[name] = joinChunks(list);
    return out;
  }

  async release(token: string, changes: Changes): Promise<void> {
    // Refuses (throws) if the lease ran out; nothing is written in that case.
    if (!this.lock.holds(token)) throw new LockLostError();
    this.ctx.storage.transactionSync(() => {
      for (const [name, text] of Object.entries(changes)) {
        this.ctx.storage.sql.exec("DELETE FROM chunks WHERE name = ?", name);
        if (text === null) continue;
        splitChunks(text).forEach((body, idx) => this.ctx.storage.sql.exec("INSERT INTO chunks (name, idx, body) VALUES (?, ?, ?)", name, idx, body));
      }
    });
    this.lock.release(token);
  }
}
