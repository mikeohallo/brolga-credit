import { ZeptoError } from "./zepto";

export function ok(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, { ...init, headers: { "Cache-Control": "no-store", ...(init?.headers ?? {}) } });
}

export function fail(err: unknown, status = 400): Response {
  if (err instanceof ZeptoError) {
    return Response.json(
      { error: { source: "zepto", status: err.status, code: err.code, title: err.title, detail: err.detail, requiredScope: err.requiredScope, requestId: err.requestId, path: err.path } },
      { status: err.status >= 500 ? 502 : 422, headers: { "Cache-Control": "no-store" } },
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return Response.json({ error: { source: "brolga", title: "Request failed", detail: message } }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}
