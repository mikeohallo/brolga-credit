// One request at a time through the stored state, with a lease so a request that
// dies holding the lock cannot hold it forever. Pure logic (no Cloudflare types), so
// the offline suite can run it; the Durable Object in store-do.ts is a thin shell
// around it.

export class LockLostError extends Error {
  constructor() {
    super("The store lock was lost (the request took longer than its lease). Nothing was saved; try again.");
    this.name = "LockLostError";
  }
}

type Waiter = { token: string; leaseMs: number; grant: () => void };

export class LockQueue {
  private holder: { token: string; timer: ReturnType<typeof setTimeout> } | null = null;
  private waiting: Waiter[] = [];

  /** Resolves when the caller holds the lock. Callers are served in the order they asked. */
  acquire(token: string, leaseMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const waiter: Waiter = { token, leaseMs, grant: resolve };
      if (!this.holder) this.start(waiter);
      else this.waiting.push(waiter);
    });
  }

  holds(token: string): boolean {
    return this.holder?.token === token;
  }

  /** Throws LockLostError if the caller no longer holds the lock (its lease ran out). */
  release(token: string): void {
    if (!this.holds(token)) throw new LockLostError();
    this.next();
  }

  private start(w: Waiter): void {
    const timer = setTimeout(() => {
      // The lease ran out: whoever held it lost it, and the next in line goes.
      if (this.holder?.token === w.token) this.next();
    }, w.leaseMs);
    this.holder = { token: w.token, timer };
    w.grant();
  }

  private next(): void {
    if (this.holder) clearTimeout(this.holder.timer);
    this.holder = null;
    const w = this.waiting.shift();
    if (w) this.start(w);
  }
}
