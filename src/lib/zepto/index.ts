import { ZeptoClient } from "./client";
import { MockZepto } from "./mock";
import type { ZeptoApi } from "./types";

export * from "./types";
export { withApiContext } from "./context";

export type ZeptoMode = "sandbox" | "mock";

export function configuredMode(): ZeptoMode {
  const m = (process.env.ZEPTO_MODE ?? "").toLowerCase();
  if (m === "mock") return "mock";
  if (m === "sandbox") return "sandbox";
  return process.env.ZEPTO_TOKEN ? "sandbox" : "mock";
}

let cached: { mode: ZeptoMode; api: ZeptoApi } | null = null;

export function getZepto(): ZeptoApi {
  const mode = configuredMode();
  if (cached && cached.mode === mode) return cached.api;
  const api: ZeptoApi =
    mode === "mock"
      ? new MockZepto()
      : new ZeptoClient({
          token: process.env.ZEPTO_TOKEN!,
          baseUrl: process.env.ZEPTO_BASE_URL,
          apiVersion: process.env.ZEPTO_API_VERSION,
        });
  cached = { mode, api };
  return api;
}
