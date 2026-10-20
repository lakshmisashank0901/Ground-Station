"use client";

import Link from "next/link";
import { fmtPct01, fmtScore, fmtUtc, scoreColor, toneColor } from "@/lib/formatters";
import type { Anomaly } from "@/lib/types";
import { AnomalyActions } from "./anomaly-actions";
import { StatusBadge } from "./ui";

/** Compact anomaly summary used in the alarm center and subsystem pages. */
export function AnomalyCard({ anomaly, actions = true }: { anomaly: Anomaly; actions?: boolean }) {
  const a = anomaly;
  return (
    <div className="rounded-[3px] border border-line bg-panel-2 p-2" style={{ borderLeft: `3px solid ${toneColor(a.severity)}` }}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <StatusBadge status={a.severity} />
          <span className="num truncate text-[11px] font-semibold text-ink">{a.subsystems.join(" · ")}</span>
        </div>
        <StatusBadge status={a.status} />
      </div>
      <Link href={`/anomalies/${encodeURIComponent(a.id)}`} className="mt-1 block truncate text-[12px] text-ink hover:text-accent" title={a.description}>
        {a.description || "Anomaly"}
      </Link>
      <div className="num mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-muted">
        <span>{fmtUtc(a.timestamp)}</span>
        <span>
          score <span style={{ color: scoreColor(a.score) }}>{fmtScore(a.score)}</span> / peak{" "}
          <span style={{ color: scoreColor(a.peak_score) }}>{fmtScore(a.peak_score)}</span>
        </span>
        <span>conf {fmtPct01(a.confidence)}</span>
        {a.top_features[0] ? <span className="text-ink-2">↳ {a.top_features[0].feature}</span> : null}
      </div>
      {actions ? (
        <div className="mt-1.5 flex items-center justify-between">
          <Link href={`/anomalies/${encodeURIComponent(a.id)}`} className="text-[11px] text-accent hover:underline">
            View →
          </Link>
          <AnomalyActions anomaly={a} />
        </div>
      ) : null}
    </div>
  );
}
