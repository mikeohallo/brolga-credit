const SYDNEY = "Australia/Sydney";

export function sydneyDate(ms: number = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: SYDNEY, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

/** Add whole days to a YYYY-MM-DD string (calendar arithmetic, timezone-free). */
export function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export function aud(cents: number): string {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(cents / 100);
}

export function shortDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}

export function timeAgo(isoStr: string): string {
  const diff = Date.now() - Date.parse(isoStr);
  const s = Math.max(0, Math.round(diff / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function clock(isoStr: string): string {
  return new Intl.DateTimeFormat("en-AU", { timeZone: SYDNEY, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(isoStr));
}

export function dateTime(isoStr: string): string {
  return new Intl.DateTimeFormat("en-AU", { timeZone: SYDNEY, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(isoStr));
}

export function nowIsoSeconds(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
