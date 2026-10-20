"use client";

import { fmtUtc } from "@/lib/formatters";
import type { ReactNode } from "react";

/** Clickable flag drawn at the top of an anomaly ReferenceLine. Recharts injects `viewBox`. */
export function MarkerLabel({
  viewBox,
  color,
  text,
  onClick,
  title,
}: {
  viewBox?: { x?: number; y?: number };
  color: string;
  text: string;
  onClick?: () => void;
  title?: string;
}) {
  const x = viewBox?.x ?? 0;
  const y = viewBox?.y ?? 0;
  return (
    <g
      onClick={onClick}
      style={{ cursor: onClick ? "pointer" : "default" }}
      role={onClick ? "link" : undefined}
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      <path d={`M${x},${y} l7,0 l-2,4 l2,4 l-7,0 z`} fill={color} />
      <text x={x + 9} y={y + 7.5} fontSize={9} fill={color} fontFamily="var(--font-mono)" fontWeight={700}>
        {text}
      </text>
      {/* generous invisible hit target */}
      <rect x={x - 6} y={y - 2} width={30} height={14} fill="transparent" />
    </g>
  );
}

interface TooltipRow {
  name: ReactNode;
  value: ReactNode;
  color?: string;
}

/** Shared dark tooltip body. */
export function TooltipBox({ t, rows }: { t: number | undefined; rows: TooltipRow[] }) {
  return (
    <div className="rounded-[3px] border border-line-2 bg-panel/95 px-2 py-1.5 text-[11px] shadow-lg">
      <div className="num mb-1 text-muted">{t !== undefined ? fmtUtc(t, true) : ""}</div>
      {rows.map((r, i) => (
        <div key={i} className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5 text-ink-2">
            {r.color ? <span className="inline-block h-[2px] w-3" style={{ background: r.color }} /> : null}
            {r.name}
          </span>
          <span className="num text-ink">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

/** Legend row for multi-series charts (identity never by colour alone: swatch + name). */
export function Legend({ items }: { items: { name: string; color: string; dashed?: boolean }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-ink-2">
      {items.map((i) => (
        <span key={i.name} className="flex items-center gap-1.5">
          <svg width="14" height="4" aria-hidden>
            <line x1="0" y1="2" x2="14" y2="2" stroke={i.color} strokeWidth="2" strokeDasharray={i.dashed ? "3 2" : undefined} />
          </svg>
          {i.name}
        </span>
      ))}
    </div>
  );
}
