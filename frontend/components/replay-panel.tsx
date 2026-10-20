"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "@/lib/api";
import { downsampleMinMax } from "@/lib/buffer";
import { computeYDomain, rowsToPoints, timeTick, valueTick, type ChartPoint } from "@/lib/chart-utils";
import { fmtPct01, fmtScore, fmtUtc, fmtUtcTime, fmtValue, fromUtcInputValue, humanize, toMs, toneColor, toUtcInputValue } from "@/lib/formatters";
import { useAction, useApi } from "@/lib/hooks";
import { useLive, useLiveStore } from "@/lib/live-data";
import type { SimulationStatus } from "@/lib/types";
import { AnomalyTimeline } from "./anomaly-timeline";
import { MarkerLabel, TooltipBox } from "./chart-parts";
import { SPEEDS } from "./simulation-control";
import { Button, EmptyState, ErrorNote, Field, Panel, Segmented, StatusBadge } from "./ui";

const REPLAY_SPEEDS = [...SPEEDS, 20];

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Replay of a recorded simulation run (spec 9.5). */
export function ReplayPanel() {
  const live = useLive();
  const store = useLiveStore();
  const router = useRouter();
  const replay = live.simulation?.replay ?? null;
  const online = live.backend.state === "ONLINE";
  const runs = useApi(() => api.runs(), [online], { intervalMs: 15_000 });
  const [runId, setRunId] = useState<string>("");
  const [param, setParam] = useState("obc_temperature");
  const [startIn, setStartIn] = useState("");
  const [endIn, setEndIn] = useState("");
  const [speed, setSpeed] = useState(1);
  const [drag, setDrag] = useState<number | null>(null);
  const { busy, error, run } = useAction();

  // follow an active replay (e.g. started from "Replay this event")
  useEffect(() => {
    if (replay?.run_id && replay.run_id !== runId) setRunId(replay.run_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replay?.run_id]);
  useEffect(() => {
    if (!runId && runs.data?.length) setRunId(runs.data[0].id);
  }, [runs.data, runId]);

  const runInfo = runs.data?.find((r) => r.id === runId) ?? null;
  const detail = useApi(() => (runId ? api.run(runId) : Promise.resolve(null)), [runId]);
  const anomalies = useApi(() => (runId ? api.anomalies({ run_id: runId, limit: 200 }) : Promise.resolve([])), [runId], { intervalMs: 20_000 });
  const history = useApi(
    (signal) => (runId ? api.history({ run_id: runId, fields: [param], max_points: 1500, limit: 100_000, start: runInfo?.start_time, end: runInfo?.end_time ?? undefined }, signal) : Promise.resolve(null)),
    [runId, param, runInfo?.start_time, runInfo?.end_time],
  );

  // default interval = full run
  useEffect(() => {
    if (!runInfo) return;
    setStartIn(toUtcInputValue(toMs(runInfo.start_time)));
    setEndIn(runInfo.end_time ? toUtcInputValue(toMs(runInfo.end_time)) : "");
  }, [runInfo?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const def = live.schemaByName[param];
  const pts: ChartPoint[] = useMemo(() => downsampleMinMax(rowsToPoints(history.data?.items ?? [], param, def), 800), [history.data, param, def]);
  const yDomain = useMemo(() => computeYDomain(pts.map((p) => p.v), def), [pts, def]);

  const r = replay && replay.run_id === runId ? replay : null;
  const active = r !== null;
  const rStart = active ? toMs(r!.start) : runInfo ? toMs(runInfo.start_time) : NaN;
  const rEnd = active ? toMs(r!.end) : runInfo?.end_time ? toMs(runInfo.end_time) : pts.length ? pts[pts.length - 1].t : NaN;
  const cursor = active ? toMs(r!.position) : null;
  const progress = drag ?? (active ? r!.progress : 0);
  const domain: [number, number] | null = Number.isFinite(rStart) && Number.isFinite(rEnd) && rEnd > rStart ? [rStart, rEnd] : null;
  const runAnoms = anomalies.data ?? [];

  const apply = async (fn: () => Promise<SimulationStatus>) => {
    const s = await run(fn);
    if (s) store?.setSimulation(s);
  };

  async function play() {
    if (active && r!.paused && !r!.finished) return apply(api.replayResume);
    const start = fromUtcInputValue(startIn) ?? undefined;
    const end = fromUtcInputValue(endIn) ?? undefined;
    return apply(() => api.replayStart({ run_id: runId, start, end, speed }));
  }

  async function seek(frac: number) {
    setDrag(null);
    if (!active || !domain) return;
    const t = domain[0] + frac * (domain[1] - domain[0]);
    await apply(() => api.replaySeek(new Date(t).toISOString()));
  }

  async function changeSpeed(s: number) {
    setSpeed(s);
    if (active) await apply(() => api.replaySpeed(s));
  }

  const events = (detail.data?.events ?? [])
    .map((e, i) => ({
      key: `e${i}`,
      t: toMs(e.timestamp),
      kind: "simulation",
      text: `${humanize(e.event_type)}${e.parameters && Object.keys(e.parameters).length ? ` ${truncate(JSON.stringify(e.parameters), 90)}` : ""}`,
    }))
    .concat(
      runAnoms.map((a) => ({
        key: a.id,
        t: toMs(a.onset_time),
        kind: "anomaly",
        severity: a.severity,
        text: `${a.severity} ${a.subsystems.join("/")} – ${a.description}`,
        href: `/anomalies/${encodeURIComponent(a.id)}`,
      })),
    )
    .sort((a, b) => b.t - a.t);

  return (
    <div id="replay" className="grid scroll-mt-3 gap-3 xl:grid-cols-[minmax(0,1fr)_340px]">
      <Panel
        title="Replay"
        tone={active ? "REPLAY" : undefined}
        actions={active ? <StatusBadge status="REPLAY" label={r!.finished ? "FINISHED" : r!.paused ? "REPLAY PAUSED" : `REPLAY ${r!.speed}×`} /> : null}
      >
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Run">
            <select className="field w-64" value={runId} onChange={(e) => setRunId(e.target.value)}>
              {!runs.data?.length ? <option value="">{runs.error ? "Runs unavailable" : "No recorded runs"}</option> : null}
              {runs.data?.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name || r.id} · {humanize(r.scenario)} · {fmtUtc(r.start_time)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Start (UTC)">
            <input type="datetime-local" step={1} className="field num" value={startIn} onChange={(e) => setStartIn(e.target.value)} />
          </Field>
          <Field label="End (UTC)">
            <input type="datetime-local" step={1} className="field num" value={endIn} onChange={(e) => setEndIn(e.target.value)} />
          </Field>
          <Field label="Parameter">
            <select className="field" value={param} onChange={(e) => setParam(e.target.value)}>
              {live.schema.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Button variant="primary" onClick={play} disabled={busy || !runId || (active && !r!.paused && !r!.finished)}>
            ▶ {active && r!.paused && !r!.finished ? "Resume" : "Play"}
          </Button>
          <Button onClick={() => apply(api.replayPause)} disabled={busy || !active || r!.paused}>
            ❚❚ Pause
          </Button>
          <Button variant="danger" onClick={() => apply(api.replayStop)} disabled={busy || !active}>
            ■ Stop
          </Button>
          <span className="mx-1 h-5 w-px bg-line" />
          <Button onClick={() => apply(() => api.replayStep(-1))} disabled={busy || !active || !r!.paused} title="Step back one packet (while paused)">
            ⏮ −1
          </Button>
          <Button onClick={() => apply(() => api.replayStep(1))} disabled={busy || !active || !r!.paused} title="Step forward one packet (while paused)">
            +1 ⏭
          </Button>
          <span className="mx-1 h-5 w-px bg-line" />
          <span className="label">Speed</span>
          <Segmented options={REPLAY_SPEEDS.map((s) => ({ value: s, label: `${s}×` }))} value={active ? r!.speed : speed} onChange={changeSpeed} disabled={busy} />
        </div>

        {/* timeline slider */}
        <div className="mt-3">
          <div className="num flex justify-between text-[10px] text-muted">
            <span>{domain ? fmtUtc(domain[0]) : "—"}</span>
            <span className="text-ink">{active ? `${fmtUtcTime(r!.position)} · ${fmtPct01(progress, 1)}` : "not playing"}</span>
            <span>{domain ? fmtUtc(domain[1]) : "—"}</span>
          </div>
          <div className="relative mt-1">
            <input
              type="range"
              min={0}
              max={1000}
              value={Math.round(progress * 1000)}
              disabled={!active || busy}
              onChange={(e) => setDrag(Number(e.target.value) / 1000)}
              onMouseUp={(e) => seek(Number((e.target as HTMLInputElement).value) / 1000)}
              onTouchEnd={(e) => seek(Number((e.target as HTMLInputElement).value) / 1000)}
              onKeyUp={(e) => seek(Number((e.target as HTMLInputElement).value) / 1000)}
              className="w-full"
              aria-label="Replay position"
            />
            {/* anomaly ticks on the slider */}
            {domain
              ? runAnoms.map((a) => {
                  const f = (toMs(a.onset_time) - domain[0]) / (domain[1] - domain[0]);
                  if (f < 0 || f > 1) return null;
                  return (
                    <Link
                      key={a.id}
                      href={`/anomalies/${encodeURIComponent(a.id)}`}
                      className="absolute -top-1.5 h-2 w-1.5 -translate-x-1/2 rounded-[1px]"
                      style={{ left: `${f * 100}%`, background: toneColor(a.severity) }}
                      title={`${a.severity} ${a.description}`}
                    />
                  );
                })
              : null}
          </div>
        </div>

        {/* run telemetry + anomaly markers + cursor */}
        <div className="mt-2" style={{ height: 240 }}>
          {pts.length < 2 ? (
            <EmptyState className="h-full">{!runId ? "Select a run" : history.loading ? "Loading run telemetry…" : "No telemetry for this run"}</EmptyState>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={pts} margin={{ top: 14, right: 10, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} strokeDasharray="2 4" />
                <XAxis
                  dataKey="t"
                  type="number"
                  scale="time"
                  domain={domain ?? ["dataMin", "dataMax"]}
                  allowDataOverflow
                  tickFormatter={(v: number) => timeTick(v, domain ? domain[1] - domain[0] : 0)}
                  minTickGap={50}
                  tickLine={false}
                  axisLine={{ stroke: "#2a3544" }}
                />
                <YAxis width={48} domain={yDomain} allowDataOverflow tickLine={false} axisLine={false} tickCount={5} tickFormatter={(v: number) => (def?.type === "enum" ? (def.enum_values?.[Math.round(v)] ?? "") : valueTick(v))} />
                {runAnoms.map((a) => (
                  <ReferenceLine
                    key={a.id}
                    x={toMs(a.onset_time)}
                    stroke={toneColor(a.severity)}
                    strokeDasharray="3 2"
                    ifOverflow="hidden"
                    label={
                      <MarkerLabel
                        color={toneColor(a.severity)}
                        text={a.severity[0]}
                        title={`${a.severity} – ${a.description}`}
                        onClick={() => router.push(`/anomalies/${encodeURIComponent(a.id)}`)}
                      />
                    }
                  />
                ))}
                {cursor !== null ? <ReferenceLine x={cursor} stroke="#a78bfa" strokeWidth={2} ifOverflow="hidden" /> : null}
                <Tooltip
                  isAnimationActive={false}
                  content={({ active: a, payload }) => {
                    if (!a || !payload?.length) return null;
                    const p = payload[0].payload as ChartPoint;
                    return <TooltipBox t={p.t} rows={[{ name: def?.label ?? param, value: fmtValue(p.raw, def?.unit), color: "#4ea1ff" }]} />;
                  }}
                />
                <Line dataKey="v" type={def?.type === "enum" ? "stepAfter" : "linear"} stroke="#4ea1ff" strokeWidth={1.5} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
        {runInfo ? (
          <div className="num mt-1 flex flex-wrap gap-x-4 text-[10px] text-muted">
            <span>run {runInfo.id}</span>
            <span>status {runInfo.status}</span>
            <span>{runInfo.packet_count} packets</span>
            <span>{runInfo.anomaly_count} anomalies</span>
            <span>recorded at {runInfo.speed}×</span>
          </div>
        ) : null}
        <div className="mt-2">
          <ErrorNote>{error}</ErrorNote>
        </div>
      </Panel>

      <Panel title="Run events & anomalies" bodyClassName="p-1.5">
        <AnomalyTimeline items={events} showDate empty={runId ? "No events recorded for this run" : "Select a run"} maxHeight={430} />
        {runAnoms.length ? (
          <div className="mt-2 border-t border-line pt-2">
            <div className="label mb-1 px-1">Anomalies (click to investigate)</div>
            <ul className="space-y-0.5">
              {runAnoms.map((a) => (
                <li key={a.id}>
                  <Link href={`/anomalies/${encodeURIComponent(a.id)}`} className="flex items-center gap-2 rounded-[2px] px-1 py-0.5 text-[11px] hover:bg-panel-2">
                    <StatusBadge status={a.severity} />
                    <span className="num text-muted">{fmtUtcTime(a.onset_time)}</span>
                    <span className="truncate text-ink">{a.subsystems.join("/")}</span>
                    <span className="num ml-auto" style={{ color: toneColor(a.severity) }}>
                      {fmtScore(a.peak_score)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Panel>
    </div>
  );
}
