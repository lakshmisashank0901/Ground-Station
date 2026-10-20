"use client";

import { useMemo } from "react";
import { CartesianGrid, Line, LineChart, ReferenceArea, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { computeYDomain, rowsToPoints, timeTick, type ChartPoint } from "@/lib/chart-utils";
import {
  DETECTOR_COLORS,
  DETECTOR_LABELS,
  fmtAge,
  fmtNum,
  fmtPct01,
  fmtScore,
  fmtUtc,
  fmtValue,
  humanize,
  scoreColor,
  toMs,
  toneColor,
  TONE_COLORS,
} from "@/lib/formatters";
import { useLive } from "@/lib/live-data";
import type { AnomalyDetail, DetectorScores, FeatureContribution, ParameterDef } from "@/lib/types";
import { TooltipBox } from "./chart-parts";
import { ScoreLines, type ScorePoint } from "./score-chart";
import { EmptyState, KV, Panel, ScoreBar, StatusBadge } from "./ui";

const DET_KEYS = ["rule", "mahalanobis", "isolation_forest", "lstm"] as const;

export function DetectorBars({ detectors, weights }: { detectors: DetectorScores | null | undefined; weights?: Record<string, number> }) {
  if (!detectors) return <EmptyState>No detector output</EmptyState>;
  return (
    <div className="space-y-1.5">
      {DET_KEYS.map((k) => (
        <ScoreBar
          key={k}
          value={detectors[k]}
          color={DETECTOR_COLORS[k]}
          label={
            <span>
              {DETECTOR_LABELS[k]}
              {weights?.[k] !== undefined ? <span className="num text-muted"> ·w{weights[k].toFixed(2)}</span> : null}
            </span>
          }
        />
      ))}
    </div>
  );
}

export function FeatureTable({ features }: { features: FeatureContribution[] }) {
  if (!features.length) return <EmptyState>No feature attribution</EmptyState>;
  return (
    <div className="overflow-x-auto">
      <table className="tbl">
        <thead>
          <tr>
            <th>Feature</th>
            <th>Subsys</th>
            <th className="text-right!">Observed</th>
            <th className="text-right!">Expected</th>
            <th className="text-right!">Pred. error</th>
            <th className="text-right!">z</th>
            <th>Contribution</th>
          </tr>
        </thead>
        <tbody>
          {features.map((f) => (
            <tr key={f.feature}>
              <td className="num text-ink">{f.feature}</td>
              <td className="num text-muted">{f.subsystem}</td>
              <td className="num text-right font-semibold text-white">{fmtValue(f.observed, f.unit)}</td>
              <td className="num text-right text-ink-2">{fmtValue(f.expected, f.unit)}</td>
              <td className="num text-right" style={{ color: Math.abs(f.z_score) >= 3 ? TONE_COLORS.high : undefined }}>
                {f.prediction_error >= 0 ? "+" : ""}
                {fmtNum(f.prediction_error)}
              </td>
              <td className="num text-right" style={{ color: Math.abs(f.z_score) >= 3 ? TONE_COLORS.high : Math.abs(f.z_score) >= 2 ? TONE_COLORS.warning : undefined }}>
                {f.z_score >= 0 ? "+" : ""}
                {f.z_score.toFixed(2)}σ
              </td>
              <td className="w-40">
                <ScoreBar value={f.contribution} color="#38bdf8" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Context chart for one top feature: ±120 s of telemetry, expected value, onset/detection lines. */
function FeatureContextChart({
  feature,
  points,
  def,
  onset,
  detected,
}: {
  feature: FeatureContribution;
  points: ChartPoint[];
  def?: ParameterDef;
  onset: number;
  detected: number;
}) {
  const yDomain = useMemo(() => computeYDomain([...points.map((p) => p.v), feature.expected, feature.observed], def), [points, feature, def]);
  if (points.length < 2) return <EmptyState className="h-[120px]">No context for {feature.feature}</EmptyState>;
  const span = points[points.length - 1].t - points[0].t;
  return (
    <div className="rounded-[3px] border border-line bg-panel-2 p-1.5">
      <div className="flex items-baseline justify-between px-1 text-[11px]">
        <span className="font-semibold text-ink-2">{def?.label ?? feature.feature}</span>
        <span className="num text-[10px] text-muted">
          obs <span className="text-white">{fmtValue(feature.observed, feature.unit)}</span> · exp {fmtValue(feature.expected, feature.unit)}
        </span>
      </div>
      <div style={{ height: 120 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} strokeDasharray="2 4" />
            <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={(v: number) => timeTick(v, span)} minTickGap={36} tickLine={false} axisLine={{ stroke: "#2a3544" }} />
            <YAxis width={40} domain={yDomain} allowDataOverflow tickLine={false} axisLine={false} tickCount={4} tickFormatter={(v: number) => fmtNum(v, Math.abs(v) >= 100 ? 0 : 1)} />
            {def && def.nominal_min !== null && def.nominal_max !== null ? (
              <ReferenceArea y1={def.nominal_min} y2={def.nominal_max} fill="#22c55e" fillOpacity={0.07} ifOverflow="hidden" />
            ) : null}
            <ReferenceLine y={feature.expected} stroke="#9ba8b8" strokeDasharray="4 3" label={{ value: "expected", position: "insideTopRight", fill: "#9ba8b8", fontSize: 9 }} ifOverflow="hidden" />
            <ReferenceLine x={onset} stroke={TONE_COLORS.warning} strokeDasharray="3 2" label={{ value: "onset", position: "insideTopLeft", fill: TONE_COLORS.warning, fontSize: 9 }} />
            <ReferenceLine x={detected} stroke={TONE_COLORS.critical} strokeDasharray="3 2" label={{ value: "detect", position: "insideBottomLeft", fill: TONE_COLORS.critical, fontSize: 9 }} />
            <ReferenceDot x={detected} y={feature.observed} r={4} fill={TONE_COLORS.critical} stroke="#06080b" ifOverflow="hidden" />
            <Tooltip
              isAnimationActive={false}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload as ChartPoint;
                return <TooltipBox t={p.t} rows={[{ name: feature.feature, value: fmtValue(p.raw, feature.unit), color: "#4ea1ff" }]} />;
              }}
            />
            <Line dataKey="v" stroke="#4ea1ff" strokeWidth={1.6} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/** Full AI explanation view for one anomaly (spec 4.8). */
export function AIExplanation({ anomaly }: { anomaly: AnomalyDetail }) {
  const live = useLive();
  const a = anomaly;
  const onset = toMs(a.onset_time);
  const detected = toMs(a.timestamp);
  const scorePts: ScorePoint[] = useMemo(
    () =>
      (a.score_trace ?? []).map((s) => ({
        t: toMs(s.timestamp),
        fused: s.anomaly_score,
        rule: s.rule,
        mahalanobis: s.mahalanobis,
        isolation_forest: s.isolation_forest,
        lstm: s.lstm,
      })),
    [a.score_trace],
  );
  const context = useMemo(() => a.context ?? [], [a.context]);
  const topFeatures = a.top_features.slice(0, 4);

  return (
    <div className="grid gap-3 xl:grid-cols-3">
      <Panel title="Assessment" tone={a.severity} className="xl:col-span-1">
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <StatusBadge status={a.severity} />
          <StatusBadge status={a.status} />
          {a.subsystems.map((s) => (
            <span key={s} className="num rounded-[2px] border border-line-2 px-1.5 text-[10px] text-ink">
              {s}
            </span>
          ))}
        </div>
        <KV
          items={[
            ["Score (last)", <span key="s" style={{ color: scoreColor(a.score) }}>{fmtScore(a.score)}</span>],
            ["Peak score", <span key="p" style={{ color: scoreColor(a.peak_score) }}>{fmtScore(a.peak_score)}</span>],
            ["Confidence", fmtPct01(a.confidence)],
            ["Mahalanobis distance", a.raw?.mahalanobis_distance != null ? a.raw.mahalanobis_distance.toFixed(2) : "n/a"],
            ["Mahalanobis (norm.)", fmtScore(a.detectors.mahalanobis)],
            ["LSTM prediction error", a.raw?.lstm_error != null ? `${a.raw.lstm_error.toFixed(2)} σ` : "n/a"],
            ["Onset", fmtUtc(a.onset_time)],
            ["Detected", fmtUtc(a.timestamp)],
            ["Detection delay", a.detection_delay_s !== null ? fmtAge(a.detection_delay_s) : "n/a"],
            ["Ended", a.ended_at ? fmtUtc(a.ended_at) : "ongoing"],
            ["Samples", a.sample_count],
            ["Run", a.run_id ?? "—"],
            ["Injected fault", a.injected_fault ? `${humanize(a.injected_fault.scenario)} (${a.injected_fault.severity})` : "none / real"],
            ["Fault start", a.injected_fault ? fmtUtc(a.injected_fault.start_time) : "—"],
          ]}
        />
        {a.acknowledged_by || a.resolved_by || a.note ? (
          <div className="mt-2 space-y-0.5 border-t border-line pt-2 text-[11px] text-ink-2">
            {a.acknowledged_by ? (
              <div>
                Acknowledged by <span className="num text-ink">{a.acknowledged_by}</span> {fmtUtc(a.acknowledged_at)}
              </div>
            ) : null}
            {a.resolved_by ? (
              <div>
                Resolved by <span className="num text-ink">{a.resolved_by}</span> {fmtUtc(a.resolved_at)}
              </div>
            ) : null}
            {a.note ? <div className="text-muted">Note: {a.note}</div> : null}
          </div>
        ) : null}
      </Panel>

      <Panel title="Explanation" className="xl:col-span-2">
        <p className="text-[13px] leading-relaxed text-ink">{a.explanation || a.description || "No explanation provided."}</p>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div>
            <div className="label mb-1.5">Detector scores</div>
            <DetectorBars detectors={a.detectors} />
          </div>
          <div>
            <div className="label mb-1.5">Contributing features</div>
            <div className="space-y-1.5">
              {a.top_features.length ? (
                a.top_features.map((f) => <ScoreBar key={f.feature} label={f.feature} value={f.contribution} color={toneColor(a.severity)} />)
              ) : (
                <EmptyState>None reported</EmptyState>
              )}
            </div>
          </div>
        </div>
      </Panel>

      <Panel title="Observed vs expected" className="xl:col-span-3">
        <FeatureTable features={a.top_features} />
      </Panel>

      <Panel title="Anomaly score trace" className="xl:col-span-3">
        <ScoreLines
          points={scorePts}
          height={200}
          vlines={[
            { t: onset, color: TONE_COLORS.warning, label: "onset", position: "insideTopRight" },
            { t: detected, color: TONE_COLORS.critical, label: "detected", position: "insideBottomLeft" },
            ...(a.injected_fault ? [{ t: toMs(a.injected_fault.start_time), color: "#a78bfa", label: "fault", position: "insideTopRight" as const }] : []),
          ]}
        />
      </Panel>

      <Panel title="Telemetry context (±120 s)" className="xl:col-span-3">
        {context.length < 2 ? (
          <EmptyState>No context telemetry returned</EmptyState>
        ) : (
          <div className="grid gap-2 md:grid-cols-2">
            {topFeatures.map((f) => (
              <FeatureContextChart
                key={f.feature}
                feature={f}
                def={live.schemaByName[f.feature]}
                points={rowsToPoints(context, f.feature, live.schemaByName[f.feature])}
                onset={onset}
                detected={detected}
              />
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
