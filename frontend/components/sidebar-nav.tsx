"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLive } from "@/lib/live-data";
import { worstActiveSeverity } from "@/lib/live-store";
import { toneColor } from "@/lib/formatters";
import { cx } from "./ui";

const NAV: { href: string; label: string; code: string }[] = [
  { href: "/dashboard", label: "Dashboard", code: "DSH" },
  { href: "/telemetry", label: "Telemetry", code: "TLM" },
  { href: "/subsystems", label: "Subsystems", code: "SUB" },
  { href: "/anomalies", label: "Anomalies", code: "ANM" },
  { href: "/ai", label: "AI / Models", code: "AI" },
  { href: "/simulation", label: "Simulation", code: "SIM" },
  { href: "/commands", label: "Commands", code: "CMD" },
  { href: "/reports", label: "Reports", code: "RPT" },
  { href: "/system", label: "System", code: "SYS" },
];

export function SidebarNav() {
  const pathname = usePathname();
  const live = useLive();
  const worst = worstActiveSeverity(live.anomalies);
  return (
    <nav className="flex w-[52px] shrink-0 flex-col border-r border-line bg-panel md:w-[168px]" aria-label="Primary">
      <div className="flex h-[42px] items-center gap-2 border-b border-line px-3">
        <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0 text-accent" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
          <path d="M4 18a10 10 0 0 1 16 0" />
          <path d="M8 18a6 6 0 0 1 8 0" />
          <circle cx="12" cy="18" r="1.4" fill="currentColor" />
          <path d="M12 16.5V4m0 0 3 3m-3-3-3 3" />
        </svg>
        <div className="hidden leading-tight md:block">
          <div className="text-[11px] font-bold tracking-[0.18em] text-ink">GROUND</div>
          <div className="text-[9px] tracking-[0.2em] text-muted">STATION · AI</div>
        </div>
      </div>
      <ul className="flex-1 py-1.5">
        {NAV.map((n) => {
          const active = pathname === n.href || pathname.startsWith(`${n.href}/`);
          return (
            <li key={n.href}>
              <Link
                href={n.href}
                className={cx(
                  "group relative flex h-8 items-center gap-2.5 px-3 text-[12px] transition-colors",
                  active ? "bg-accent/10 text-accent" : "text-ink-2 hover:bg-panel-2 hover:text-ink",
                )}
                title={n.label}
              >
                {active ? <span className="absolute top-0 left-0 h-full w-[2px] bg-accent" /> : null}
                <span className="num w-7 shrink-0 text-[10px] font-semibold tracking-wider opacity-80">{n.code}</span>
                <span className="hidden truncate md:inline">{n.label}</span>
                {n.href === "/anomalies" && live.activeAlarms > 0 ? (
                  <span
                    className="num ml-auto hidden rounded-[2px] px-1 text-[10px] font-bold text-black md:inline"
                    style={{ background: toneColor(worst) }}
                  >
                    {live.activeAlarms}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="hidden border-t border-line px-3 py-2 text-[10px] text-muted md:block">
        <div className="num">API v1 · contract</div>
      </div>
    </nav>
  );
}
