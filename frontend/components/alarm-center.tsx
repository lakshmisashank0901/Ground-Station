"use client";

import Link from "next/link";
import { severityRank, toMs } from "@/lib/formatters";
import { useLive } from "@/lib/live-data";
import { AnomalyCard } from "./anomaly-card";
import { EmptyState, Panel } from "./ui";

/** Active alarm panel: ACTIVE anomalies first (by severity, then time), then recently acknowledged. */
export function AlarmCenter({ limit = 8, className }: { limit?: number; className?: string }) {
  const live = useLive();
  const open = live.anomalies
    .filter((a) => a.status !== "RESOLVED")
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "ACTIVE" ? -1 : 1;
      const s = severityRank(b.severity) - severityRank(a.severity);
      return s !== 0 ? s : toMs(b.timestamp) - toMs(a.timestamp);
    });
  return (
    <Panel
      className={className}
      title={`Alarms · ${live.activeAlarms} active`}
      tone={live.activeAlarms ? open[0]?.severity : "NOMINAL"}
      actions={
        <Link href="/anomalies" className="text-[11px] text-accent hover:underline">
          All →
        </Link>
      }
      bodyClassName="max-h-[420px] overflow-auto space-y-1.5"
    >
      {open.length === 0 ? (
        <EmptyState>{live.backend.state === "OFFLINE" ? "Backend offline" : "No open alarms – all nominal"}</EmptyState>
      ) : (
        open.slice(0, limit).map((a) => <AnomalyCard key={a.id} anomaly={a} />)
      )}
      {open.length > limit ? <div className="text-center text-[11px] text-muted">+{open.length - limit} more</div> : null}
    </Panel>
  );
}
