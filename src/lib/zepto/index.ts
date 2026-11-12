import { ZeptoClient } from "./client";
import { MockZepto } from "./mock";
import type { ZeptoApi } from "./types";

export * from "./types";
export { withApiContext } from "./context";

export type ZeptoMode = "sandbox" | "mock";

export function configuredMode(): ZeptoMode {
  const m = (process.env.ZEPTO_MODE ?? "").toLowerCase();
  // The hosted build is mock only. No Zepto token is ever read there, and asking for the
  // sandbox is an error rather than a quiet fallback, so a mistake cannot go unnoticed.
  if (process.env.BROLGA_HOSTED === "1") {
    if (m === "sandbox") throw new Error("The hosted build runs on the mock provider only; ZEPTO_MODE=sandbox is refused.");
    return "mock";
  }
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
