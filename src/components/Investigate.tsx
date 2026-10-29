"use client";

// The Investigate tab: the Payments Exception Investigator's screen. An operator
// picks a case, reads the records beside the briefing, clicks a cited id to see
// the record behind it, adds the prepared evidence, writes again, and marks the
// briefing right, wrong or incomplete. Everything here talks to /api/investigate;
// the model is called only on the server, and nothing on this screen changes a
// loan, a payment or a state.

import { useState } from "react";
import { api, useAction, useResource } from "@/lib/client";
import { Card, Empty, ErrorBanner, Mono, Pill, Spinner, type Tone } from "@/components/ui";
import type { CaseView, ListResponse } from "@/lib/investigator/api";
import { DIAGNOSES, NEXT_STEPS } from "@/lib/investigator/labels";
import type { BriefingRun, Claim, Mark } from "@/lib/investigator/types";
import { dateTime } from "@/lib/format";

const usd = (n: number | null) => (n === null ? "cost unknown" : `$${n.toFixed(4)}`);
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const VERDICT: Record<Mark["verdict"], { label: string; tone: Tone }> = { right: { label: "Right", tone: "good" }, wrong: { label: "Wrong", tone: "critical" }, incomplete: { label: "Incomplete", tone: "warn" } };
const SOURCE: { key: "brolga" | "provider" | "support"; title: string; hint: string }[] = [
  { key: "brolga", title: "Brolga's own records", hint: "what the app did and recorded" },
  { key: "provider", title: "The provider's records", hint: "what Zepto's API returned when asked; the only evidence of what the provider holds" },
  { key: "support", title: "Support and operator notes", hint: "what people said; not evidence of what the provider holds" },
];
const NO_KEY = "No key configured: put BROLGA_INVESTIGATOR_KEY in .env.local (or point BROLGA_ENV_FILE at the file that holds it) and restart.";
const HELD_BACK = "Held back from development: this case is run only in the final comparison, by the eval script.";

export function Investigate() {
  const list = useResource<ListResponse>("/api/investigate");
  const [selected, setSelected] = useState<string | null>(null);
  if (selected && list.data) {
    return (
      <CaseScreen
        id={selected}
        models={list.data.models}
        keyPresent={list.data.keyPresent}
        onBack={() => {
          setSelected(null);
          list.reload();
        }}
      />
    );
  }
  return <CaseList list={list} onOpen={setSelected} />;
}

function CaseList({ list, onOpen }: { list: ReturnType<typeof useResource<ListResponse>>; onOpen: (id: string) => void }) {
  const { data, error, loading, reload } = list;
  return (
    <div className="space-y-4">
      {data && !data.keyPresent && (
        <div className="rise flex items-start gap-3 rounded-xl border border-warn/30 bg-warn-soft px-4 py-3 text-sm text-warn">
          <span aria-hidden>⚠</span>
          <div>
            <div className="font-semibold">Cases can be read; briefings can&rsquo;t be written</div>
            <div className="mt-0.5 opacity-90">{NO_KEY}</div>
          </div>
        </div>
      )}
      <Card
        title="Cases"
        subtitle={data ? `${data.cases.length} synthetic cases from ${data.generator}; ${data.cases.filter((c) => c.heldBack).length} held back from development. A case is a loan with something wrong on it: the records are captured when the case is made, and the briefing may cite only those.` : "Synthetic cases, six exception types"}
        actions={
          <button className="btn btn-ghost btn-sm" onClick={reload}>
            Refresh
          </button>
        }
        padded={false}
      >
        {error && (
          <div className="p-5">
            <ErrorBanner error={error} />
          </div>
        )}
        {loading ? (
          <div className="flex items-center gap-2 p-5 text-sm text-ink-3">
            <Spinner /> Loading
          </div>
        ) : !data?.cases.length ? (
          !error && (
            <div className="p-5">
              <Empty>No cases yet. Make them with the cases script, then refresh.</Empty>
            </div>
          )
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Case</th>
                <th>Type</th>
                <th>What&rsquo;s wrong</th>
                <th className="text-right">Briefings</th>
                <th>Last briefing</th>
                <th>Marks</th>
              </tr>
            </thead>
            <tbody>
              {data.cases.map((c) => (
                <tr key={c.id} className="cursor-pointer" onClick={() => onOpen(c.id)}>
                  <td>
                    <Mono>{c.id}</Mono>
                    {c.heldBack && (
                      <Pill tone="warn" className="ml-2">
                        held back
                      </Pill>
                    )}
                  </td>
                  <td className="text-xs">
                    <span className="mono">{c.typeCode}</span> {c.typeTitle}
                  </td>
                  <td>
                    <div>{c.title}</div>
                    <div className="text-[11px] text-ink-3">
                      loan {c.loanId} · {c.records} records{c.evidence ? ` + ${c.evidence} evidence` : ""}
                    </div>
                  </td>
                  <td className="text-right tnum">{c.briefings}</td>
                  <td className="text-xs">
                    {c.lastRun ? (
                      <>
                        <Pill tone={c.lastRun.accepted ? "good" : "critical"}>{c.lastRun.accepted ? "accepted" : "rejected"}</Pill>
                        {c.lastRun.diagnosis && (
                          <div className="mt-1 text-[11px] text-ink-3">
                            {c.lastRun.diagnosis} / {c.lastRun.nextStep}
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="text-ink-3">—</span>
                    )}
                  </td>
                  <td className="text-xs">
                    {c.lastMark ? (
                      <Pill tone={VERDICT[c.lastMark].tone}>
                        {VERDICT[c.lastMark].label}
                        {c.marks > 1 ? ` · ${c.marks}` : ""}
                      </Pill>
                    ) : (
                      <span className="text-ink-3">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function CaseScreen({ id, models, keyPresent, onBack }: { id: string; models: ListResponse["models"]; keyPresent: boolean; onBack: () => void }) {
  const res = useResource<{ case: CaseView }>(`/api/investigate/${id}`);
  const act = useAction();
  const [model, setModel] = useState(models.at(-1)?.id ?? "claude-opus-5-5");
  const [highlight, setHighlight] = useState<string | null>(null);
  const [showFile, setShowFile] = useState(false);
  const [by, setBy] = useState("");
  const c = res.data?.case;

  const post = (name: string, path: string, json?: unknown) =>
    act.run(name, async () => {
      const updated = await api<{ case: CaseView }>(`/api/investigate/${id}/${path}`, { method: "POST", json });
      res.setData(() => updated);
    });
  const jump = (recordId: string) => {
    setHighlight(recordId);
    document.getElementById(`record-${recordId}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  if (res.error && !c) return <ErrorBanner error={res.error} />;
  if (!c)
    return (
      <div className="flex items-center gap-2 text-sm text-ink-3">
        <Spinner /> Loading {id}
      </div>
    );

  const writeDisabled = !!act.busy || !keyPresent || c.heldBack;
  const writeTitle = c.heldBack ? HELD_BACK : !keyPresent ? NO_KEY : `One model call on ${models.find((m) => m.id === model)?.label ?? model}; the briefing is checked before it is shown`;
  const runs = [...c.runs].reverse();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <button className="btn btn-ghost btn-sm" onClick={onBack}>
            ← All cases
          </button>
          <Mono>{c.id}</Mono>
          <Pill tone="info">
            {c.typeCode} · {c.typeTitle}
          </Pill>
          {c.heldBack && <Pill tone="warn">held back</Pill>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select className="select !w-auto !py-1.5 !text-sm" value={model} onChange={(e) => setModel(e.target.value)} title="Which model writes the next briefing">
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <button className="btn btn-primary btn-sm" onClick={() => post("brief", "brief", { model })} disabled={writeDisabled} title={writeTitle}>
            {act.busy === "brief" ? (
              <>
                <Spinner className="mr-1.5 inline" /> Writing
              </>
            ) : (
              "Write briefing"
            )}
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => post("evidence", "evidence")} disabled={!!act.busy || !c.evidenceLeft} title={c.evidenceLeft ? `Append the next prepared record (${c.evidenceLeft} left); earlier ids do not change` : "No more prepared evidence for this case"}>
            New evidence arrived
          </button>
        </div>
      </div>
      <ErrorBanner error={act.error} onDismiss={act.clearError} />

      <Card
        title={c.title}
        subtitle={
          <>
            loan {c.loanId} · case file <span className="mono">{c.rendered.hash}</span> · {c.rendered.wordCount} words · {c.records.length} records
            {c.records.some((r) => r.evidence) ? ` (${c.records.filter((r) => r.evidence).length} added as evidence)` : ""}
          </>
        }
        actions={
          <button className="btn btn-ghost btn-sm" onClick={() => setShowFile((s) => !s)}>
            {showFile ? "Hide the file" : "Show the file the model reads"}
          </button>
        }
      >
        <p className="text-sm">
          <span className="label mr-2">Question</span>
          {c.question}
        </p>
        {showFile && <pre className="mt-3 max-h-96 overflow-auto rounded-xl bg-neutral-soft p-4 text-[12px] leading-5 whitespace-pre-wrap">{c.rendered.text}</pre>}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="The case file" subtitle="Every record has an id; a briefing may cite only these. Click an id in a briefing to find its record here." padded={false}>
          {SOURCE.map((s) => {
            const rows = c.records.filter((r) => r.source === s.key);
            return (
              <div key={s.key} className="border-b border-line last:border-b-0">
                <div className="bg-surface-2 px-5 py-2">
                  <div className="label">{s.title}</div>
                  <div className="text-[11px] text-ink-3">{s.hint}</div>
                </div>
                {!rows.length && <div className="px-5 py-3 text-xs text-ink-3">(none)</div>}
                {rows.map((r) => (
                  <div key={r.id} id={`record-${r.id}`} className={`px-5 py-2.5 text-sm transition ${highlight === r.id ? "bg-brand-soft" : ""}`}>
                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-3">
                      <button className="mono rounded bg-neutral-soft px-1.5 py-0.5 text-[11px] text-ink hover:bg-brand-soft" onClick={() => setHighlight(r.id)}>
                        {r.id}
                      </button>
                      <span>{dateTime(r.at)}</span>
                      <span className="mono">{r.kind}</span>
                      {r.evidence && <Pill tone="brand">new evidence · {r.evidence.label}</Pill>}
                    </div>
                    <div className="mt-1 leading-snug">{r.text}</div>
                  </div>
                ))}
              </div>
            );
          })}
        </Card>

        <div className="space-y-4">
          {!runs.length && (
            <Card title="Briefing">
              <Empty>No briefing yet. Pick a model and click Write briefing: the model reads the file on the left and nothing else.</Empty>
            </Card>
          )}
          {runs.map((run, i) => (
            <BriefingCard key={run.id} run={run} n={c.runs.length - i} c={c} models={models} busy={!!act.busy} onJump={jump} by={by} setBy={setBy} onMark={(verdict, note) => post(`mark-${run.id}`, "mark", { runId: run.id, verdict, note, by })} />
          ))}
        </div>
      </div>
    </div>
  );
}

function Ids({ ids, onJump }: { ids: string[]; onJump: (id: string) => void }) {
  if (!ids.length) return <span className="text-[11px] text-critical">cites nothing</span>;
  return (
    <span className="inline-flex flex-wrap gap-1 align-middle">
      {ids.map((id) => (
        <button key={id} className="mono rounded bg-neutral-soft px-1.5 py-0.5 text-[11px] text-ink hover:bg-brand-soft" onClick={() => onJump(id)} title={`Show record ${id}`}>
          {id}
        </button>
      ))}
    </span>
  );
}

function Claims({ claims, onJump }: { claims: Claim[]; onJump: (id: string) => void }) {
  return (
    <ul className="space-y-1.5 text-sm">
      {claims.map((cl, i) => (
        <li key={i} className="leading-snug">
          {cl.text} <Ids ids={cl.ids} onJump={onJump} />
        </li>
      ))}
    </ul>
  );
}

function BriefingCard({ run, n, c, models, busy, onJump, by, setBy, onMark }: { run: BriefingRun; n: number; c: CaseView; models: ListResponse["models"]; busy: boolean; onJump: (id: string) => void; by: string; setBy: (s: string) => void; onMark: (verdict: Mark["verdict"], note: string) => void }) {
  const [note, setNote] = useState("");
  const [showRaw, setShowRaw] = useState(false);
  const b = run.briefing;
  const accepted = run.check.accepted && !!b;
  const marks = c.marks.filter((m) => m.runId === run.id);
  const label = run.evidenceCount && c.expectedNow ? c.expectedNow : c.expected;
  const modelLabel = models.find((m) => m.id === run.model)?.label ?? run.model;
  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          Briefing {n}
          <Pill tone={run.error ? "critical" : accepted ? "good" : "critical"}>{run.error ? "model call failed" : accepted ? "accepted by the citation check" : "rejected by the citation check"}</Pill>
        </span>
      }
      subtitle={`${modelLabel} · ${dateTime(run.at)} · read case file ${run.caseHash} with ${run.evidenceCount} evidence record${run.evidenceCount === 1 ? "" : "s"}`}
    >
      {run.error && <div className="rounded-xl border border-critical/30 bg-critical-soft px-4 py-3 text-sm text-critical">Model call failed: {run.error}</div>}
      {!run.error && !accepted && (
        <div className="rounded-xl border border-critical/30 bg-critical-soft px-4 py-3 text-sm text-critical">
          <div className="font-semibold">Not shown to the operator. Code rejected it:</div>
          <ul className="mt-1 list-disc pl-5">
            {run.check.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      {b && (
        <div className={`space-y-4 ${accepted ? "" : "mt-4 opacity-60"}`}>
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone="brand">{b.diagnosis}</Pill>
            <Pill tone={b.next_step.action === "insufficient_evidence" ? "warn" : "info"}>{b.next_step.action}</Pill>
            <Pill tone="neutral">confidence {b.confidence.level}</Pill>
          </div>
          <div className="text-xs text-ink-3">
            <div>
              <span className="font-semibold text-ink-2">Diagnosis:</span> {DIAGNOSES[b.diagnosis] ?? b.diagnosis}
            </div>
            <div className="mt-0.5">
              <span className="font-semibold text-ink-2">Next step:</span> {NEXT_STEPS[b.next_step.action] ?? b.next_step.action}
            </div>
          </div>
          <section>
            <div className="label mb-1.5">Timeline</div>
            <Claims claims={b.timeline} onJump={onJump} />
          </section>
          <section>
            <div className="label mb-1.5">Known for certain</div>
            <Claims claims={b.known_for_certain} onJump={onJump} />
          </section>
          <section>
            <div className="label mb-1.5">Explanations, ranked</div>
            <ol className="space-y-2 text-sm">
              {b.explanations.map((e) => (
                <li key={e.rank} className="rounded-xl border border-line px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="tnum text-xs text-ink-3">{e.rank}.</span>
                    <Mono>{e.diagnosis}</Mono>
                  </div>
                  <div className="mt-1 leading-snug">{e.summary}</div>
                  <div className="mt-1 text-[11px] text-ink-3">
                    For: <Ids ids={e.supporting_ids} onJump={onJump} /> {e.against_ids.length > 0 && <>Against: <Ids ids={e.against_ids} onJump={onJump} /></>}
                  </div>
                </li>
              ))}
            </ol>
          </section>
          <section>
            <div className="label mb-1.5">Next step</div>
            <div className="text-sm leading-snug whitespace-pre-line">
              {b.next_step.detail} <Ids ids={b.next_step.ids} onJump={onJump} />
            </div>
            {b.next_step.would_settle_it && (
              <div className="mt-1.5 text-sm">
                <span className="font-semibold">Would settle it:</span> {b.next_step.would_settle_it}
              </div>
            )}
          </section>
          <section className="text-xs text-ink-3">
            <span className="font-semibold text-ink-2">Confidence {b.confidence.level}:</span> {b.confidence.reason}
          </section>
        </div>
      )}
      {!b && run.raw && (
        <div className="mt-3">
          <button className="btn btn-ghost btn-sm" onClick={() => setShowRaw((s) => !s)}>
            {showRaw ? "Hide what the model returned" : "Show what the model returned"}
          </button>
          {showRaw && <pre className="mt-2 max-h-64 overflow-auto rounded-xl bg-neutral-soft p-3 text-[11px] whitespace-pre-wrap">{run.raw}</pre>}
        </div>
      )}
      <div className="mt-4 border-t border-line pt-3 text-xs text-ink-3 tnum">
        {run.inputTokens} tokens in, {run.outputTokens} out · {usd(run.costUsd)} · {secs(run.ms)}
      </div>

      {marks.length > 0 && (
        <div className="mt-3 space-y-2">
          {marks.map((m, i) => (
            <div key={i} className="rounded-xl border border-line px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone={VERDICT[m.verdict].tone}>{VERDICT[m.verdict].label}</Pill>
                <span className="text-xs text-ink-3">
                  {m.by} · {dateTime(m.at)}
                </span>
              </div>
              {m.note && <div className="mt-1 leading-snug">{m.note}</div>}
            </div>
          ))}
          {label && b && (
            <div className="rounded-xl bg-surface-2 px-3 py-2 text-xs text-ink-2">
              <span className="font-semibold">The label on this case:</span> <Mono>{label.diagnosis}</Mono> / <Mono>{label.nextStep}</Mono>
              {" · "}
              {b.diagnosis === label.diagnosis && b.next_step.action === label.nextStep ? "the briefing agrees with it" : b.diagnosis === label.diagnosis ? "the briefing agrees on the diagnosis, not the next step" : "the briefing differs from it"}
              {label.tempting && (
                <div className="mt-1">
                  <span className="font-semibold">The tempting reading:</span> {label.tempting}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {accepted && (
        <div className="mt-3 space-y-2">
          <div className="label">Your verdict{marks.length ? " (another)" : ""}</div>
          <textarea className="input" rows={2} placeholder="A note, if the verdict needs one: what it got right, what it missed" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="flex flex-wrap items-center gap-2">
            <input className="input !w-40 !py-1 !text-xs" placeholder="your name (optional)" value={by} onChange={(e) => setBy(e.target.value)} />
            {(["right", "wrong", "incomplete"] as Mark["verdict"][]).map((v) => (
              <button key={v} className={`btn btn-sm ${v === "right" ? "btn-primary" : v === "wrong" ? "btn-danger" : "btn-secondary"}`} disabled={busy} onClick={() => { onMark(v, note); setNote(""); }}>
                {VERDICT[v].label}
              </button>
            ))}
            <span className="text-[11px] text-ink-3">Saved with the briefing, the file&rsquo;s hash and the model. The label is shown once you have marked.</span>
          </div>
        </div>
      )}
    </Card>
  );
}
