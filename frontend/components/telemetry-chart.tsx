"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api, errorMessage, telemetryExportUrl } from "@/lib/api";
import { downsampleMinMax, mergeBackfill, sliceByTime } from "@/lib/buffer";
import { computeYDomain, markersFor, rowsToPoints, timeTick, WINDOWS, windowMs, type ChartPoint, type WindowKey } from "@/lib/chart-utils";
import {
  fmtRange,
  fmtUtc,
  fmtUtcTime,
  fmtValue,
  fromUtcInputValue,
  rangeState,
  toMs,
  toneColor,
  toUtcInputValue,
  trendArrow,
  trendOf,
  TONE_COLORS,
} from "@/lib/formatters";
import { useLive } from "@/lib/live-data";
import type { Anomaly } from "@/lib/types";
import { MarkerLabel, TooltipBox } from "./chart-parts";
import { Button, cx, Segmented, StatusBadge } from "./ui";

const LINE_COLOR = "#4ea1ff";
const MAX_RENDER_POINTS = 600;

interface Props {
  param: string;
  height?: number;
  defaultWindow?: WindowKey;
  /** Overrides anomaly markers (default: live anomalies relevant to this parameter). */
  anomalies?: Anomaly[];
  className?: string;
}

export function TelemetryChart({ param, height = 150, defaultWindow = "1m", anomalies, className }: Props) {
  const live = useLive();
  const router = useRouter();
  const def = live.schemaByName[param];
  const [win, setWin] = useState<WindowKey>(defaultWindow);
  const [paused, setPaused] = useState(false);
  const [frozen, setFrozen] = useState<{ pts: ChartPoint[]; start: number; end: number } | null>(null);
  const [backfill, setBackfill] = useState<{ key: string; pts: ChartPoint[] } | null>(null);
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [custom, setCustom] = useState<{ pts: ChartPoint[]; start: number; end: number } | null>(null);
  const [loadingCustom, setLoadingCustom] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // ---- live points from the shared buffer
  const bufferPts = useMemo(() => rowsToPoints(live.telemetry, param, def), [live.telemetry, param, def]);
  const latest = live.latestTelemetry;
  const runId = latest?.source === "REPLAY" ? (latest.run_id ?? null) : null;
  const wMs = windowMs(win);
  const liveEnd = bufferPts.length ? bufferPts[bufferPts.length - 1].t : 0;
  const liveStart = liveEnd - wMs;
  const bufferFirst = bufferPts.length ? bufferPts[0].t : null;

  // ---- backfill from /telemetry/history when the window is longer than the live buffer covers
  const needsBackfill = win !== "custom" && liveEnd > 0 && bufferFirst !== null && bufferFirst - liveStart > 2000;
  const backfillKey = `${param}|${win}|${live.epoch}|${runId ?? ""}`;
  useEffect(() => {
    if (!needsBackfill || backfill?.key === backfillKey || liveEnd === 0 || bufferFirst === null) return;
    const ctrl = new AbortController();
    const start = new Date(liveEnd - wMs).toISOString();
    const end = new Date(bufferFirst).toISOString();
    api
      .history({ start, end, fields: [param], run_id: runId, max_points: 800 }, ctrl.signal)
      .then((h) => setBackfill({ key: backfillKey, pts: rowsToPoints(h.items ?? [], param, def) }))
      .catch(() => setBackfill({ key: backfillKey, pts: [] }));
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsBackfill, backfillKey]);

  const livePts = useMemo(() => {
    if (!bufferPts.length) return [];
    const inWin = sliceByTime(bufferPts, liveStart, liveEnd, (p) => p.t);
    if (backfill?.key === backfillKey && backfill.pts.length) {
      return mergeBackfill(
        backfill.pts.filter((p) => p.t >= liveStart),
        inWin,
      );
    }
    return inWin;
  }, [bufferPts, liveStart, liveEnd, backfill, backfillKey]);

  // ---- view selection
  let view: { pts: ChartPoint[]; start: number; end: number };
  if (win === "custom") view = custom ?? { pts: [], start: 0, end: 0 };
  else if (paused && frozen) view = frozen;
  else view = { pts: livePts, start: liveStart, end: liveEnd };

  const display = useMemo(() => downsampleMinMax(view.pts, MAX_RENDER_POINTS), [view.pts]);
  const yDomain = useMemo(() => computeYDomain(display.map((p) => p.v), def), [display, def]);
  const markerSource = anomalies ?? live.anomalies;
  const markers = useMemo(() => (view.end ? markersFor(markerSource, view.start, view.end, def) : []), [markerSource, view.start, view.end, def]);

  const lastPt = view.pts.length ? view.pts[view.pts.length - 1] : null;
  const current = win === "custom" || paused ? (lastPt?.raw ?? null) : (latest?.data?.[param] ?? lastPt?.raw ?? null);
  const currentTs = win === "custom" || paused ? lastPt?.t : latest ? toMs(latest.timestamp) : lastPt?.t;
  const trend = trendOf(view.pts.slice(-120).map((p) => p.v ?? NaN));
  const quality = win !== "custom" && !paused ? (latest?.field_quality?.[param] ?? (latest ? "VALID" : null)) : null;
  const rs = rangeState(current, def);
  const valueColor = rs === "critical" ? TONE_COLORS.critical : rs === "warning" ? TONE_COLORS.warning : "#ffffff";
  const isEnum = def?.type === "enum";
  const span = view.end - view.start;

  function togglePause() {
    if (paused) {
      setPaused(false);
      setFrozen(null);
    } else {
      setFrozen({ pts: livePts, start: liveStart, end: liveEnd });
      setPaused(true);
    }
  }

  async function loadCustom() {
    const s = fromUtcInputValue(customStart);
    const e = fromUtcInputValue(customEnd);
    if (!s || !e || toMs(e) <= toMs(s)) {
      setErr("Enter a valid UTC start and end (end after start).");
      return;
    }
    setErr(null);
    setLoadingCustom(true);
    try {
      const h = await api.history({ start: s, end: e, fields: [param], max_points: 1500 });
      setCustom({ pts: rowsToPoints(h.items ?? [], param, def), start: toMs(s), end: toMs(e) });
    } catch (ex) {
      setErr(errorMessage(ex));
    } finally {
      setLoadingCustom(false);
    }
  }

  function selectWindow(k: WindowKey) {
    setWin(k);
    setFrozen(null);
    setPaused(false);
    if (k === "custom" && !customStart) {
      const end = liveEnd || Date.now();
      setCustomStart(toUtcInputValue(end - 15 * 60_000));
      setCustomEnd(toUtcInputValue(end));
    }
  }

  const exportHref = view.end
    ? telemetryExportUrl({ start: new Date(view.start).toISOString(), end: new Date(view.end).toISOString(), fields: [param], run_id: win === "custom" ? null : runId })
    : telemetryExportUrl({ fields: [param] });

  return (
    <section className={cx("flex min-w-0 flex-col rounded-[4px] border border-line bg-panel", className)}>
      {/* header: label, current value, unit, trend, timestamp */}
      <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 border-b border-line px-2.5 py-1.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-[11px] font-semibold tracking-[0.06em] text-ink-2 uppercase">{def?.label ?? param}</span>
            <span className="num text-[10px] text-muted">{def?.subsystem}</span>
            {quality && quality !== "VALID" ? <StatusBadge status={quality} /> : null}
          </div>
          <div className="mt-0.5 flex items-baseline gap-2">
            <span className="num text-[18px] leading-none font-semibold" style={{ color: valueColor }}>
              {fmtValue(current, isEnum ? undefined : def?.unit)}
            </span>
            {!isEnum ? (
              <span className="num text-[11px]" style={{ color: trend === "flat" ? "#66748a" : "#9ba8b8" }} title={`Trend: ${trend}`}>
                {trendArrow(trend)}
              </span>
            ) : null}
            <span className="num text-[10px] text-muted">{currentTs ? fmtUtcTime(currentTs, true) : "—"}</span>
          </div>
          <div className="num text-[10px] text-muted">
            nominal {fmtRange(def?.nominal_min, def?.nominal_max)}
            {def?.limit_min !== null || def?.limit_max !== null ? ` · limit ${fmtRange(def?.limit_min, def?.limit_max)}` : ""}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Segmented options={WINDOWS.map((w) => ({ value: w.key, label: w.label }))} value={win} onChange={selectWindow} />
          {win !== "custom" ? (
            <Button size="xs" onClick={togglePause} active={paused} title={paused ? "Resume live updates" : "Freeze the chart"}>
              {paused ? "▶ Live" : "❚❚ Pause"}
            </Button>
          ) : null}
          <a href={exportHref} download className="inline-flex h-[22px] items-center rounded-[3px] border border-line-2 bg-panel-2 px-1.5 text-[11px] text-ink-2 hover:text-ink" title="Export the visible range as CSV">
            CSV
          </a>
        </div>
      </header>
      {win === "custom" ? (
        <div className="flex flex-wrap items-end gap-2 border-b border-line px-2.5 py-1.5">
          <label className="flex flex-col gap-0.5">
            <span className="label">Start (UTC)</span>
            <input type="datetime-local" step={1} className="field num" value={customStart} onChange={(e) => setCustomStart(e.target.value)} />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="label">End (UTC)</span>
            <input type="datetime-local" step={1} className="field num" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} />
          </label>
          <Button size="sm" variant="primary" onClick={loadCustom} disabled={loadingCustom}>
            {loadingCustom ? "Loading…" : "Load"}
          </Button>
          {err ? <span className="text-[11px] text-critical">{err}</span> : null}
        </div>
      ) : null}
      <div className="relative px-1 pt-1.5" style={{ height }}>
        {display.length < 2 ? (
          <div className="flex h-full items-center justify-center text-[11px] text-muted">
            {win === "custom" ? (custom ? "No data in range" : "Pick a range and Load") : live.backend.state === "OFFLINE" ? "Backend offline – no telemetry" : "Waiting for telemetry…"}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={display} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} strokeDasharray="2 4" />
              <XAxis
                dataKey="t"
                type="number"
                scale="time"
                domain={[view.start || "dataMin", view.end || "dataMax"]}
                allowDataOverflow
                tickFormatter={(v: number) => timeTick(v, span)}
                minTickGap={40}
                tickLine={false}
                axisLine={{ stroke: "#2a3544" }}
              />
              <YAxis
                width={isEnum ? 52 : 44}
                domain={yDomain}
                allowDataOverflow
                tickLine={false}
                axisLine={false}
                tickCount={4}
                ticks={isEnum ? def?.enum_values?.map((_, i) => i) : undefined}
                interval={isEnum ? 0 : undefined}
                tickFormatter={(v: number) => (isEnum ? (def?.enum_values?.[Math.round(v)] ?? "") : Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(Math.abs(v) >= 10 ? 1 : 2))}
              />
              {def?.nominal_min !== null && def?.nominal_max !== null && def ? (
                <ReferenceArea y1={def.nominal_min ?? undefined} y2={def.nominal_max ?? undefined} fill="#22c55e" fillOpacity={0.07} stroke="#22c55e" strokeOpacity={0.25} strokeDasharray="3 3" ifOverflow="hidden" />
              ) : null}
              {def?.limit_min !== null && def?.limit_min !== undefined ? (
                <ReferenceLine y={def.limit_min} stroke={TONE_COLORS.critical} strokeDasharray="4 3" strokeOpacity={0.7} ifOverflow="hidden" />
              ) : null}
              {def?.limit_max !== null && def?.limit_max !== undefined ? (
                <ReferenceLine y={def.limit_max} stroke={TONE_COLORS.critical} strokeDasharray="4 3" strokeOpacity={0.7} ifOverflow="hidden" />
              ) : null}
              {markers.map((a) => (
                <ReferenceLine
                  key={a.id}
                  x={toMs(a.onset_time || a.timestamp)}
                  stroke={toneColor(a.severity)}
                  strokeDasharray="3 2"
                  label={
                    <MarkerLabel
                      color={toneColor(a.severity)}
                      text={a.severity[0]}
                      title={`${a.severity} ${a.subsystems.join("/")} – ${a.description} (${fmtUtc(a.onset_time)})`}
                      onClick={() => router.push(`/anomalies/${encodeURIComponent(a.id)}`)}
                    />
                  }
                />
              ))}
              <Tooltip
                isAnimationActive={false}
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const p = payload[0].payload as ChartPoint;
                  return <TooltipBox t={p.t} rows={[{ name: def?.label ?? param, value: fmtValue(p.raw, isEnum ? undefined : def?.unit), color: LINE_COLOR }]} />;
                }}
              />
              <Line
                type={isEnum ? "stepAfter" : "linear"}
                dataKey="v"
                stroke={LINE_COLOR}
                strokeWidth={1.6}
                dot={false}
                isAnimationActive={false}
                connectNulls={false}
                activeDot={{ r: 3, stroke: "#06080b", strokeWidth: 1 }}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
        {paused ? <span className="num absolute top-2 right-3 rounded-[2px] bg-warning/20 px-1 text-[9px] font-bold text-warning">PAUSED</span> : null}
      </div>
    </section>
  );
}
