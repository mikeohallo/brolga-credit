// A stored file is kept as rows of at most CHUNK characters, so no single row nears a
// Durable Object's per-row size limit however large the investigator's store grows.

export const CHUNK = 200_000;

export function splitChunks(text: string, size = CHUNK): string[] {
  if (text.length === 0) return [""];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

export function joinChunks(rows: { idx: number; body: string }[]): string {
  return [...rows].sort((a, b) => a.idx - b.idx).map((r) => r.body).join("");
}
