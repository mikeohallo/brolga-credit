"use client";

import { useState } from "react";
import { useResource } from "@/lib/client";
import { Card, PageHeader, Pill, Mono, Spinner, Empty } from "@/components/ui";
import type { ApiLogEntry } from "@/lib/db";
import { clock } from "@/lib/format";

export default function Console() {
  const { data, loading } = useResource<{ entries: ApiLogEntry[]; total: number }>("/api/console", { poll: () => 3000 });
  const [open, setOpen] = useState<number | null>(null);
  const [filter, setFilter] = useState<"all" | "writes" | "errors">("all");
  const entries = [...(data?.entries ?? [])].reverse().filter((e) => (filter === "writes" ? e.method !== "GET" : filter === "errors" ? !e.ok : true));

  return (
    <>
      <PageHeader
        kicker="Developer view"
        title="API console"
        actions={
          <div className="flex gap-1 rounded-xl bg-neutral-soft p-1 text-sm">
            {(["all", "writes", "errors"] as const).map((f) => (
              <button key={f} onClick={() => setFilter(f)} className={`rounded-lg px-3 py-1 font-medium capitalize transition ${filter === f ? "bg-surface shadow-sm" : "text-ink-2"}`}>
                {f}
              </button>
            ))}
          </div>
        }
      >
        Every request Brolga has made to Zepto, with the version header, idempotency key, request id and latency. Click a row for the payload. {data && <span className="text-ink-3">{data.total} calls this session.</span>}
      </PageHeader>

      <Card padded={false}>
        {loading ? (
          <div className="flex items-center gap-2 p-5 text-sm text-ink-3">
            <Spinner /> Loading
          </div>
        ) : entries.length === 0 ? (
          <div className="p-5">
            <Empty>No API calls logged yet.</Empty>
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Request</th>
                <th>Why</th>
                <th>Status</th>
                <th className="text-right">Latency</th>
                <th>Request id</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <>
                  <tr key={e.id} className="cursor-pointer" onClick={() => setOpen(open === e.id ? null : e.id)}>
                    <td className="mono text-xs text-ink-3">{clock(e.at)}</td>
                    <td>
                      <span className={`mono mr-2 text-[11px] font-bold ${e.method === "GET" ? "text-ink-3" : "text-brand"}`}>{e.method}</span>
                      <span className="mono text-[13px]">{e.path}</span>
                    </td>
                    <td className="text-xs text-ink-2">{e.context ?? "—"}</td>
                    <td>
                      <Pill tone={e.ok ? (e.status === 201 || e.status === 202 ? "brand" : "good") : e.status === 403 ? "warn" : "critical"}>{e.status || "ERR"}</Pill>
                    </td>
                    <td className="mono text-right text-xs text-ink-3">{e.ms} ms</td>
                    <td className="mono text-[11px] text-ink-3">{e.requestId ? e.requestId.slice(0, 8) : e.mode === "mock" ? "mock" : "—"}</td>
                  </tr>
                  {open === e.id && (
                    <tr key={`${e.id}-detail`}>
                      <td colSpan={6} className="!bg-surface-2">
                        <div className="grid gap-3 text-xs md:grid-cols-2">
                          <div>
                            <div className="label mb-1">Headers</div>
                            <div className="space-y-0.5">
                              <div>
                                <Mono>Authorization: Bearer ••••••••</Mono>
                              </div>
                              <div>
                                <Mono>Zepto-Api-Version: {e.apiVersion}</Mono>
                              </div>
                              {e.idempotencyKey && (
                                <div>
                                  <Mono>Idempotency-Key: {e.idempotencyKey}</Mono>
                                </div>
                              )}
                            </div>
                            {e.requestBody !== undefined && e.requestBody !== null && (
                              <>
                                <div className="label mb-1 mt-3">Request body</div>
                                <pre className="mono max-h-72 overflow-auto rounded-lg bg-ink p-3 text-[11px] leading-relaxed text-paper">{JSON.stringify(e.requestBody, null, 2)}</pre>
                              </>
                            )}
                          </div>
                          <div>
                            <div className="label mb-1">Response</div>
                            {e.error && <div className="mb-2 rounded-lg bg-critical-soft px-2 py-1 text-critical">{e.error}</div>}
                            {e.responseSnippet ? <pre className="mono max-h-72 overflow-auto rounded-lg bg-ink p-3 text-[11px] leading-relaxed text-paper">{pretty(e.responseSnippet)}</pre> : <div className="text-ink-3">{e.mode === "mock" ? "mock response" : "no body"}</div>}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}

function pretty(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}
