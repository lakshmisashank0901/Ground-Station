"use client";

import { useState } from "react";
import { SATELLITE_ID } from "@/lib/config";
import { fmtAge, fmtDoy, fmtUtcTime, statusTone, toMs, TONE_COLORS } from "@/lib/formatters";
import { useNow } from "@/lib/hooks";
import { useLive, useOperator } from "@/lib/live-data";
import { worstActiveSeverity } from "@/lib/live-store";
import { WS_CHANNELS } from "@/lib/websocket";
import Link from "next/link";
import { cx, StatusDot } from "./ui";

function Cell({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cx("flex min-w-0 flex-col justify-center border-r border-line px-3", className)}>
      <span className="label leading-none">{label}</span>
      <span className="num mt-1 flex items-center gap-1.5 truncate text-[12px] leading-none text-ink">{children}</span>
    </div>
  );
}

const MODE_TONE: Record<string, string> = { SIMULATION: "#38bdf8", REPLAY: "#a78bfa", REAL: "#22c55e", IDLE: "#64748b" };

export function MissionHeader() {
  const live = useLive();
  const now = useNow(1000);
  const [operator, setOperator] = useOperator();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const pkt = live.latestTelemetry;
  const age = live.lastPacketRecvAt && now ? (now - live.lastPacketRecvAt) / 1000 : (live.satStatus?.last_packet_age_s ?? null);
  const lastPacketTime = pkt?.timestamp ?? live.satStatus?.last_packet_time ?? null;
  const ageTone = age === null ? "offline" : age < 5 ? "nominal" : age < 30 ? "warning" : "critical";
  const wsOpen = WS_CHANNELS.filter((c) => live.channels[c].state === "OPEN").length;
  const wsTone = wsOpen === 4 ? "nominal" : wsOpen === 0 ? "critical" : "warning";
  const conn = live.connection;
  const worst = worstActiveSeverity(live.anomalies);
  const simTime = live.simulation?.sim_time;

  return (
    <header className="flex h-[42px] shrink-0 items-stretch overflow-x-auto border-b border-line bg-panel text-ink">
      <div className="flex items-center gap-2 border-r border-line px-3">
        <span className="num text-[13px] font-bold tracking-[0.14em] text-white">{pkt?.satellite_id ?? SATELLITE_ID}</span>
      </div>
      <Cell label="Link">
        <StatusDot status={conn} pulse={conn !== "CONNECTED"} />
        <span style={{ color: TONE_COLORS[statusTone(conn)] }}>{conn === "CONNECTED" ? "Connected" : conn === "DEGRADED" ? "Degraded" : "Disconnected"}</span>
      </Cell>
      <Cell label="Mode">
        <span
          className="rounded-[2px] px-1.5 py-[1px] text-[11px] font-bold tracking-wider"
          style={{ color: MODE_TONE[live.mode], background: `${MODE_TONE[live.mode]}1f` }}
        >
          {live.mode}
        </span>
        {live.simulation?.paused ? <span className="text-[10px] text-warning">PAUSED</span> : null}
        {live.mode !== "IDLE" && live.simulation ? <span className="text-[10px] text-muted">{live.simulation.replay?.speed ?? live.simulation.speed}×</span> : null}
      </Cell>
      <Cell label="UTC mission time">
        <span className="text-white">{now ? fmtDoy(now) : "—"}</span>
        {simTime && Math.abs(toMs(simTime) - now) > 5000 ? <span className="text-[10px] text-muted">SIM {fmtUtcTime(simTime)}</span> : null}
      </Cell>
      <Cell label="Last packet">
        <span>{fmtUtcTime(lastPacketTime)}</span>
        <span style={{ color: TONE_COLORS[ageTone] }}>+{fmtAge(age)}</span>
      </Cell>
      <Cell label="WebSocket">
        <StatusDot tone={wsTone} />
        <span>{wsOpen}/4</span>
        <span className="text-[10px] text-muted">{(live.packetRate || 0).toFixed(1)} pkt/s</span>
      </Cell>
      <Cell label="Backend">
        <StatusDot status={live.backend.state === "UNKNOWN" ? "PENDING" : live.backend.state} />
        <span>{live.backend.state}</span>
        {live.backend.latencyMs !== null ? <span className="text-[10px] text-muted">{live.backend.latencyMs.toFixed(0)}ms</span> : null}
      </Cell>
      <Link href="/anomalies?status=ACTIVE" className="flex min-w-0 flex-col justify-center border-r border-line px-3 hover:bg-panel-2">
        <span className="label leading-none">Active alarms</span>
        <span className="num mt-1 flex items-center gap-1.5 text-[12px] leading-none">
          <span
            className={cx("rounded-[2px] px-1.5 font-bold", live.activeAlarms > 0 && "blink")}
            style={
              live.activeAlarms > 0
                ? { background: TONE_COLORS[statusTone(worst)], color: "#000" }
                : { color: TONE_COLORS.nominal }
            }
          >
            {live.activeAlarms}
          </span>
          {worst ? <span className="text-[10px]" style={{ color: TONE_COLORS[statusTone(worst)] }}>{worst}</span> : <span className="text-[10px] text-muted">none</span>}
        </span>
      </Link>
      <div className="ml-auto flex items-center gap-2 border-l border-line px-3">
        <span className="label">Operator</span>
        {editing ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setOperator(draft);
              setEditing(false);
            }}
          >
            <input
              autoFocus
              className="field num w-28"
              value={draft}
              maxLength={40}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => {
                setOperator(draft);
                setEditing(false);
              }}
              aria-label="Operator name"
            />
          </form>
        ) : (
          <button
            type="button"
            className="num rounded-[3px] border border-line-2 px-2 py-[2px] text-[12px] text-ink hover:border-accent"
            onClick={() => {
              setDraft(operator);
              setEditing(true);
            }}
            title="Click to change operator (sent as X-Operator header)"
          >
            {operator}
          </button>
        )}
      </div>
    </header>
  );
}
