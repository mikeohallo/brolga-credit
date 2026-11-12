// The hosted build's entry: the OpenNext Worker for the Next app, with two things in front
// of it. First Cloudflare Access's token is checked (access.ts). Then, for the app's API,
// the stored state is loaded under a lock for the length of the request and saved at the
// end (scope.ts), so the app's synchronous code runs unchanged against the Durable Object.
// The briefing route is the exception: it calls the model between two short visits to the
// state, so it opens the scope itself, twice, and the lock is never held across the model.

import openNext from "../../.open-next/worker.js";
export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from "../../.open-next/worker.js";
import investigatorSeed from "../../hosted/investigator.seed.txt";
import { checkAccess, type AccessEnv } from "./access";
import { installScope, withStoreScope, type StoreStub } from "./scope";
import { LockLostError } from "./lock";
import { needsScope } from "./routes";

export { BrolgaStore } from "./store-do";

type Env = AccessEnv & {
  STORE: { idFromName(name: string): unknown; get(id: unknown): StoreStub };
  BROLGA_INVESTIGATOR_STORE?: string;
};

const worker = {
  async fetch(request: Request, env: Env, ctx: unknown): Promise<Response> {
    const denied = await checkAccess(request, env);
    if (denied) return denied;

    const storePath = env.BROLGA_INVESTIGATOR_STORE?.trim() || "/store/investigator.json";
    const seeds = { [storePath]: investigatorSeed as string };
    const stub = () => env.STORE.get(env.STORE.idFromName("brolga"));
    installScope(stub, seeds);

    try {
      if (!needsScope(new URL(request.url).pathname)) return await openNext.fetch(request, env, ctx);
      return await withStoreScope(stub(), seeds, () => openNext.fetch(request, env, ctx));
    } catch (err) {
      if (err instanceof LockLostError) return new Response(err.message, { status: 503 });
      throw err;
    }
  },
};

export default worker;
