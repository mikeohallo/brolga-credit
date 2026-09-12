"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiError } from "@/components/ui";

export class RequestError extends Error {
  api: ApiError;
  constructor(api: ApiError) {
    super(api.detail);
    this.api = api;
  }
}

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(path, {
    ...rest,
    headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    cache: "no-store",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err: ApiError = body?.error ?? { source: "brolga", title: `HTTP ${res.status}`, detail: res.statusText };
    throw new RequestError(err);
  }
  return body as T;
}

type State<T> = { data: T | null; error: ApiError | null };

/** Fetch-on-mount with optional polling. `poll` is re-evaluated after every load. */
export function useResource<T>(path: string | null, opts: { poll?: (data: T | null) => number | false } = {}) {
  const [state, setState] = useState<State<T>>({ data: null, error: null });
  const [tick, setTick] = useState(0);
  const pollRef = useRef(opts.poll);
  useEffect(() => {
    pollRef.current = opts.poll;
  });

  useEffect(() => {
    if (!path) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = async () => {
      let next: number | false | undefined;
      try {
        const d = await api<T>(path);
        if (!alive) return;
        setState({ data: d, error: null });
        next = pollRef.current?.(d);
      } catch (e) {
        if (!alive) return;
        const err = e instanceof RequestError ? e.api : { source: "brolga" as const, title: "Request failed", detail: String(e) };
        setState((s) => ({ data: s.data, error: err }));
        const n = pollRef.current?.(null);
        next = n ? Math.max(n, 4000) : n;
      }
      if (alive && next) timer = setTimeout(run, next);
    };
    run();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [path, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const setData = useCallback((updater: (d: T | null) => T | null) => setState((s) => ({ ...s, data: updater(s.data) })), []);
  const loading = !!path && state.data === null && state.error === null;
  return { data: state.data, error: state.error, loading, reload, setData };
}

/** Wraps a mutating call: tracks busy state and surfaces API errors. */
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const run = useCallback(async <T,>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(name);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof RequestError ? e.api : { source: "brolga", title: "Request failed", detail: String(e) });
      return undefined;
    } finally {
      setBusy(null);
    }
  }, []);
  const clearError = useCallback(() => setError(null), []);
  return { busy, error, run, clearError };
}
