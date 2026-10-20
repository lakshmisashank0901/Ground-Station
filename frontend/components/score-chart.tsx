"use client";

import { useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { downsampleMinMax, sliceByTime, strideSample } from "@/lib/buffer";
import { timeTick } from "@/lib/chart-utils";
import { DETECTOR_COLORS, DETECTOR_LABELS, fmtScore, healthColor, isNum, scoreToState, toneColor, TONE_COLORS } from "@/lib/formatters";
import { useLive } from "@/lib/live-data";
import type { HealthPoint } from "@/lib/live-store";
import { Legend, TooltipBox } from "./chart-parts";
import { EmptyState, Segmented } from "./ui";

export interface ScorePoint {
  t: number;
  fused: number | null;
  rule: number | null;
  mahalanobis: number | null;
  isolation_forest: number | null;
  lstm: number | null;
}

const DETECTORS = ["rule", "mahalanobis", "isolation_forest", "lstm"] as const;
const FUSED_COLOR = "#e6edf3";

export interface VLine {
  t: number;
  color: string;
  label?: string;
  position?: "insideTopLeft" | "insideTopRight" | "insideBottomLeft" | "insideBottomRight";
}

/** Fused anomaly score with per-detector breakdown, on a fixed 0–1 axis with severity thresholds. */
export function ScoreLines({
  points,
  height = 180,
  showDetectors = true,
  vlines = [],
  domain,
}: {
  points: ScorePoint[];
  height?: number;
  showDetectors?: boolean;
  vlines?: VLine[];
  domain?: [number, number];
}) {
  const data = useMemo(() => strideSample(points, 500), [points]);
  const present = DETECTORS.filter((d) => data.some((p) => isNum(p[d])));
  const span = data.length ? data[data.length - 1].t - data[0].t : 0;
  if (data.length < 2) return <EmptyState className="h-full">No score data yet</EmptyState>;
  return (
    <div className="flex h-full flex-col gap-1">
      <Legend
        items={[
          { name: "Fused", color: FUSED_COLOR },
          ...(showDetectors ? present.map((d) => ({ name: DETECTOR_LABELS[d], color: DETECTOR_COLORS[d] })) : []),
        ]}
      />
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 6, right: 10, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} strokeDasharray="2 4" />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={domain ?? ["dataMin", "dataMax"]}
              allowDataOverflow
              tickFormatter={(v: number) => timeTick(v, span)}
              minTickGap={40}
              tickLine={false}
              axisLine={{ stroke: "#2a3544" }}
            />
            <YAxis width={34} domain={[0, 1]} ticks={[0, 0.3, 0.6, 0.8, 1]} tickLine={false} axisLine={false} />
            <ReferenceArea y1={0.3} y2={0.6} fill={TONE_COLORS.warning} fillOpacity={0.04} />
            <ReferenceArea y1={0.6} y2={0.8} fill={TONE_COLORS.high} fillOpacity={0.05} />
            <ReferenceArea y1={0.8} y2={1} fill={TONE_COLORS.critical} fillOpacity={0.06} />
            <ReferenceLine y={0.3} stroke={TONE_COLORS.warning} strokeOpacity={0.5} strokeDasharray="3 3" />
            <ReferenceLine y={0.6} stroke={TONE_COLORS.high} strokeOpacity={0.5} strokeDasharray="3 3" />
            <ReferenceLine y={0.8} stroke={TONE_COLORS.critical} strokeOpacity={0.5} strokeDasharray="3 3" />
            {vlines.map((v, i) => (
              <ReferenceLine key={i} x={v.t} stroke={v.color} strokeDasharray="3 2" label={v.label ? { value: v.label, fill: v.color, fontSize: 9, position: v.position ?? "insideTopLeft" } : undefined} />
            ))}
            <Tooltip
              isAnimationActive={false}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload as ScorePoint;
                return (
                  <TooltipBox
                    t={p.t}
                    rows={[
                      { name: `Fused · ${scoreToState(p.fused)}`, value: fmtScore(p.fused), color: FUSED_COLOR },
                      ...(showDetectors ? present.map((d) => ({ name: DETECTOR_LABELS[d], value: fmtScore(p[d]), color: DETECTOR_COLORS[d] })) : []),
                    ]}
                  />
                );
              }}
            />
            {showDetectors
              ? present.map((d) => (
                  <Line key={d} dataKey={d} stroke={DETECTOR_COLORS[d]} strokeWidth={1.2} strokeOpacity={0.85} dot={false} isAnimationActive={false} connectNulls />
                ))
              : null}
            <Line dataKey="fused" stroke={FUSED_COLOR} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function healthToScorePoints(h: HealthPoint[]): ScorePoint[] {
  return h.map((p) => ({
    t: p.t,
    fused: p.anomaly,
    rule: p.rule,
    mahalanobis: p.mahalanobis,
    isolation_forest: p.isolation_forest,
    lstm: p.lstm,
  }));
}

const SCORE_WINDOWS = [
  { value: 60_000, label: "1m" },
  { value: 300_000, label: "5m" },
  { value: 900_000, label: "15m" },
  { value: 3_600_000, label: "1h" },
];

/** Live fused anomaly score from the shared health buffer. */
export function LiveScoreChart({ height = 180, showDetectors = true, defaultWindow = 300_000 }: { height?: number; showDetectors?: boolean; defaultWindow?: number }) {
  const live = useLive();
  const [win, setWin] = useState(defaultWindow);
  const pts = useMemo(() => {
    const h = live.health;
    if (!h.length) return [];
    const end = h[h.length - 1].t;
    return healthToScorePoints(sliceByTime(h, end - win, end, (p) => p.t));
  }, [live.health, win]);
  const cur = live.latestHealth?.anomaly_score;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="num text-[11px]">
          <span className="text-muted">fused </span>
          <span className="font-semibold" style={{ color: toneColor(scoreToState(cur)) }}>
            {fmtScore(cur)} {scoreToState(cur)}
          </span>
        </span>
        <Segmented options={SCORE_WINDOWS} value={win} onChange={setWin} />
      </div>
      {pts.length < 2 ? <EmptyState className="h-[120px]">Waiting for health/inference updates…</EmptyState> : <ScoreLines points={pts} height={height} showDetectors={showDetectors} />}
    </div>
  );
}

/** Overall health (0–100) trend from the shared health buffer. */
export function HealthTrendChart({ height = 120, windowMs = 900_000 }: { height?: number; windowMs?: number }) {
  const live = useLive();
  const data = useMemo(() => {
    const h = live.health;
    if (!h.length) return [];
    const end = h[h.length - 1].t;
    return downsampleMinMax(
      sliceByTime(h, end - windowMs, end, (p) => p.t).map((p) => ({ t: p.t, v: p.overall })),
      400,
    );
  }, [live.health, windowMs]);
  if (data.length < 2) return <EmptyState className="h-full" >No health history yet</EmptyState>;
  const span = data[data.length - 1].t - data[0].t;
  const color = healthColor(data[data.length - 1].v);
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 6, right: 10, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} strokeDasharray="2 4" />
          <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={(v: number) => timeTick(v, span)} minTickGap={40} tickLine={false} axisLine={{ stroke: "#2a3544" }} />
          <YAxis width={30} domain={[0, 100]} ticks={[0, 20, 40, 70, 100]} tickLine={false} axisLine={false} />
          <ReferenceLine y={70} stroke={TONE_COLORS.warning} strokeOpacity={0.4} strokeDasharray="3 3" />
          <ReferenceLine y={40} stroke={TONE_COLORS.high} strokeOpacity={0.4} strokeDasharray="3 3" />
          <ReferenceLine y={20} stroke={TONE_COLORS.critical} strokeOpacity={0.4} strokeDasharray="3 3" />
          <Tooltip
            isAnimationActive={false}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0].payload as { t: number; v: number };
              return <TooltipBox t={p.t} rows={[{ name: "Overall health", value: p.v?.toFixed(1), color }]} />;
            }}
          />
          <Line dataKey="v" stroke={color} strokeWidth={1.8} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
