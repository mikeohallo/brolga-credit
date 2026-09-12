import { AsyncLocalStorage } from "node:async_hooks";

// Lets the domain layer label a group of Zepto calls ("LN-0003 · collect instalment 1")
// so the API console can show why each request was made, without threading a
// context argument through every client method.
const als = new AsyncLocalStorage<{ context: string }>();

export function withApiContext<T>(context: string, fn: () => Promise<T>): Promise<T> {
  return als.run({ context }, fn);
}

export function currentApiContext(): string | undefined {
  return als.getStore()?.context;
}
