// Just enough of the Workers runtime's types for the Durable Object to typecheck here.
// (The runtime provides the real ones; wrangler bundles this file's users.)
declare module "cloudflare:workers" {
  export class DurableObject<Env = unknown> {
    ctx: DurableObjectState;
    env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }
}
interface DurableObjectState {
  storage: {
    sql: { exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] } };
    transactionSync<T>(fn: () => T): T;
  };
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}
