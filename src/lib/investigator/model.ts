// The one place the investigator talks to a model. A single HTTPS request to the
// Messages API, no SDK, no tools, no streaming: the case file goes in, text comes
// back, and the token counts the API reports are what the cost is computed from.
// The key is read from the environment on the server (or by a script from
// .env.local) and never logged, returned or written anywhere.

export const KEY_VARIABLE = "BROLGA_INVESTIGATOR_KEY";
export const API_VERSION = "2026-10-21";
const DEFAULT_BASE_URL = "https://api.anthropic.com";

/**
 * Published list prices in USD per million tokens (base input / output), from
 * https://platform.claude.com/docs/en/about-claude/pricing on 29 October 2026.
 * Thinking tokens are billed as output tokens and are already in the API's
 * output_tokens count. A model missing from this table reports cost as unknown
 * rather than a guess.
 */
export const PRICES_USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 }, // prompts up to 100,000 tokens; the case file is a few thousand
};

export function costUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const p = PRICES_USD_PER_MTOK[model];
  if (!p) return null;
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

export type ModelRequest = {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  /** The API's effort setting; omitted means the model's own default, which the report names. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
};

export type ModelResponse = {
  text: string; // every text block, joined; thinking blocks are not returned to the caller
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
  ms: number;
  requestId?: string;
};

export class ModelError extends Error {
  status: number;
  type?: string;
  constructor(status: number, type: string | undefined, message: string) {
    super(message);
    this.name = "ModelError";
    this.status = status;
    this.type = type;
  }
}

export async function callModel(req: ModelRequest): Promise<ModelResponse> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? 180_000);
  try {
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? 4_000,
      system: req.system,
      messages: [{ role: "user", content: req.user }],
    };
    if (req.effort) body.output_config = { effort: req.effort };
    const res = await fetch(`${(req.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": req.apiKey, "anthropic-version": API_VERSION },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const requestId = res.headers.get("request-id") ?? undefined;
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const err = (json?.error ?? {}) as { type?: string; message?: string };
      throw new ModelError(res.status, err.type, `${res.status} ${err.type ?? "error"}: ${err.message ?? "no detail"}${requestId ? ` (request ${requestId})` : ""}`);
    }
    const content = (json?.content ?? []) as { type: string; text?: string }[];
    const usage = (json?.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
    return {
      text: content.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text!).join("\n"),
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      stopReason: typeof json?.stop_reason === "string" ? (json.stop_reason as string) : null,
      ms: Date.now() - started,
      requestId,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** The key, if the environment has it; the value is never returned anywhere else. */
export function keyFromEnv(): string | null {
  const k = process.env[KEY_VARIABLE];
  return k && k.trim() ? k.trim() : null;
}
