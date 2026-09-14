"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useResource } from "@/lib/client";
import { Pill } from "./ui";

type Health = {
  mode: "sandbox" | "mock";
  apiVersion: string;
  account: { name: string; nickname: string };
  funding: { nppCapable: boolean; accountType: string; availableBalance: number | null; label: string };
  probes: { name: string; ok: boolean; note?: string }[];
};

const NAV = [
  { href: "/", label: "Overview", icon: "◫" },
  { href: "/loans", label: "Loans", icon: "▤" },
  { href: "/borrowers", label: "Borrowers", icon: "◯" },
  { href: "/operations", label: "Operations", icon: "≡" },
  { href: "/console", label: "API console", icon: ">_" },
];

export function Sidebar() {
  const pathname = usePathname();
  const { data: health } = useResource<Health>("/api/health", { poll: () => 60_000 });
  const missing = health?.probes.filter((p) => !p.ok) ?? [];

  return (
    <>
      {/* Narrow screens: navigation and the environment badge stay reachable. */}
      <div className="sticky top-0 z-10 flex items-center gap-2 overflow-x-auto border-b border-line bg-surface px-3 py-2 md:hidden">
        <Link href="/" className="mr-1 flex shrink-0 items-center gap-2 text-sm font-semibold">
          <BrolgaMark /> Brolga
        </Link>
        {NAV.map((n) => {
          const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
          return (
            <Link key={n.href} href={n.href} className="navlink !px-2 !py-1 text-xs" data-active={active}>
              {n.label}
            </Link>
          );
        })}
        <span className="ml-auto shrink-0">{health ? <Pill tone={health.mode === "sandbox" ? "brand" : "warn"}>{health.mode === "sandbox" ? "Sandbox" : "Mock"}</Pill> : <Pill tone="neutral" pulse>connecting</Pill>}</span>
      </div>
    <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-line bg-surface px-4 py-5 md:flex">
      <Link href="/" className="mb-6 flex items-center gap-2.5 px-2">
        <BrolgaMark />
        <div>
          <div className="text-[15px] font-semibold leading-tight tracking-tight">Brolga Credit</div>
          <div className="text-[11px] text-ink-3">Loan desk</div>
        </div>
      </Link>

      <nav className="flex flex-col gap-0.5">
        {NAV.map((n) => {
          const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
          return (
            <Link key={n.href} href={n.href} className="navlink" data-active={active}>
              <span className="w-5 text-center text-xs opacity-70 mono">{n.icon}</span>
              {n.label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto rounded-xl border border-line bg-surface-2 p-3 text-xs">
        <div className="mb-2 flex items-center justify-between">
          <span className="label">Zepto</span>
          {health ? (
            <Pill tone={health.mode === "sandbox" ? "brand" : "warn"}>{health.mode === "sandbox" ? "Sandbox" : "Mock"}</Pill>
          ) : (
            <Pill tone="neutral" pulse>
              connecting
            </Pill>
          )}
        </div>
        {health && (
          <div className="space-y-1.5 text-ink-2">
            <div className="truncate" title={health.account.name}>
              {health.account.name}
            </div>
            <div className="flex items-center gap-1.5">
              <span className={`h-1.5 w-1.5 rounded-full ${health.funding.nppCapable ? "bg-good" : "bg-warn"}`} />
              {health.funding.nppCapable ? "Float · NPP real-time" : "Linked account · DE only"}
            </div>
            {missing.length > 0 && (
              <div className="flex items-center gap-1.5 text-warn">
                <span className="h-1.5 w-1.5 rounded-full bg-warn" />
                {missing.length} capabilit{missing.length === 1 ? "y" : "ies"} unavailable
              </div>
            )}
            <div className="mono text-[11px] text-ink-3">{health.mode === "mock" ? "no network calls" : `Zepto-Api-Version ${health.apiVersion}`}</div>
          </div>
        )}
      </div>
    </aside>
    </>
  );
}

function BrolgaMark() {
  // An abstract crane silhouette — original artwork for a fictional lender.
  return (
    <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden>
      <rect width="34" height="34" rx="9" fill="#0f5c50" />
      <path d="M9 24c3.5 0 6-2.2 7-5.5.6-2 1.6-3.5 3.4-4.4l1.6-.8" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" fill="none" />
      <path d="M20.5 13.2c1.5-1 3-.9 4.2.2l1.3 1.3-3.2.5" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <circle cx="21.3" cy="12.6" r="1.6" fill="#c6432e" />
      <path d="M15 26v-3.5M12 26v-2" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
