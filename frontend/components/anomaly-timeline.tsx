"use client";

import Link from "next/link";
import { fmtUtcDate, fmtUtcTime, toneColor } from "@/lib/formatters";
import { EmptyState } from "./ui";

export interface TimelineItem {
  key: string | number;
  t: number;
  kind: string;
  severity?: string;
  text: string;
  href?: string;
}

const KIND_LABEL: Record<string, string> = {
  anomaly: "ANM",
  simulation: "SIM",
  system: "SYS",
  health: "HLT",
  replay: "RPL",
  command: "CMD",
};

/** Vertical event timeline (newest first). */
export function AnomalyTimeline({ items, showDate, empty = "No events yet", maxHeight = 360 }: { items: TimelineItem[]; showDate?: boolean; empty?: string; maxHeight?: number }) {
  if (!items.length) return <EmptyState>{empty}</EmptyState>;
  return (
    <ol className="relative overflow-auto pr-1" style={{ maxHeight }}>
      <span className="absolute top-1 bottom-1 left-[63px] w-px bg-line" aria-hidden />
      {items.map((i) => {
        const color = i.severity ? toneColor(i.severity) : "#66748a";
        const body = (
          <>
            <span className="num w-[56px] shrink-0 text-right text-[10px] text-muted">
              {showDate ? <span className="block text-[9px]">{fmtUtcDate(i.t)}</span> : null}
              {fmtUtcTime(i.t)}
            </span>
            <span className="relative z-[1] mt-[3px] h-[9px] w-[9px] shrink-0 rounded-full border-2 border-panel" style={{ background: color }} />
            <span className="num w-7 shrink-0 text-[9px] font-semibold text-muted">{KIND_LABEL[i.kind] ?? i.kind.slice(0, 3).toUpperCase()}</span>
            <span className="min-w-0 flex-1 text-[11px] break-words text-ink">{i.text}</span>
          </>
        );
        return (
          <li key={i.key}>
            {i.href ? (
              <Link href={i.href} className="flex items-start gap-1.5 rounded-[2px] px-0.5 py-1 hover:bg-panel-2">
                {body}
              </Link>
            ) : (
              <div className="flex items-start gap-1.5 px-0.5 py-1">{body}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
