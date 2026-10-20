"use client";

import Link from "next/link";
import { useMemo } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { reportDownloadUrl } from "@/lib/api";
import { timeTick } from "@/lib/chart-utils";
import { fmtAge, fmtNum, fmtScore, fmtUtc, healthColor, scoreColor, toMs, TONE_COLORS } from "@/lib/formatters";
import { useLive } from "@/lib/live-data";
import { SUBSYSTEM_IDS, SUBSYSTEM_NAMES } from "@/lib/params";
import type { Report } from "@/lib/types";
import { AnomalyTimeline } from "./anomaly-timeline";
import { TooltipBox } from "./chart-parts";
import { EmptyState, KV, Panel, Stat, StatusBadge } from "./ui";

function MiniLine({
  data,
  color,
  domain,
  name,
  unit,
  refs = [],
  height = 120,
}: {
  data: { t: number; v: number | null }[];
  color: string;
  domain?: [number, number];
  name: string;
  unit?: string;
  refs?: { y: number; color: string }[];
  height?: number;
}) {
  if (data.length < 2) return <EmptyState className="h-[80px]">No data</EmptyState>;
  const span = data[data.length - 1].t - data[0].t;
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} strokeDasharray="2 4" />
          <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={(v: number) => timeTick(v, span)} minTickGap={40} tickLine={false} axisLine={{ stroke: "#2a3544" }} />
          <YAxis width={40} domain={domain ?? ["auto", "auto"]} tickLine={false} axisLine={false} tickCount={4} tickFormatter={(v: number) => fmtNum(v, Math.abs(v) >= 100 ? 0 : 1)} />
          {refs.map((r) => (
            <ReferenceLine key={r.y} y={r.y} stroke={r.color} strokeOpacity={0.5} strokeDasharray="3 3" />
          ))}
          <Tooltip
            isAnimationActive={false}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0].payload as { t: number; v: number | null };
              return <TooltipBox t={p.t} rows={[{ name, value: `${fmtNum(p.v)}${unit ? ` ${unit}` : ""}`, color }]} />;
            }}
          />
          <Line dataKey="v" stroke={color} strokeWidth={1.6} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function ReportView({ report }: { report: Report }) {
  const live = useLive();
  const r = report;
  const s = r.summary;
  const healthPts = useMemo(() => r.plots.health.map((p) => ({ t: toMs(p.timestamp), v: p.overall_score })), [r]);
  const scorePts = useMemo(() => r.plots.health.map((p) => ({ t: toMs(p.timestamp), v: p.anomaly_score })), [r]);
  const timeline = useMemo(
    () =>
      r.timeline
        .map((e, i) => ({
          key: `${i}`,
          t: toMs(e.timestamp),
          kind: e.kind,
          severity: e.severity,
          text: e.text,
          href: e.kind === "anomaly" && e.ref_id ? `/anomalies/${encodeURIComponent(e.ref_id)}` : undefined,
        }))
        .sort((a, b) => b.t - a.t),
    [r],
  );

  return (
    <div className="space-y-3">
      <Panel
        title={r.title}
        actions={
          <div className="flex gap-1">
            {(["html", "json", "csv"] as const).map((f) => (
              <a key={f} href={reportDownloadUrl(r.id, f)} download className="inline-flex h-[22px] items-center rounded-[3px] border border-line-2 bg-panel-2 px-2 text-[11px] text-ink uppercase hover:border-accent">
                ⤓ {f}
              </a>
            ))}
          </div>
        }
      >
        <KV
          cols={4}
          items={[
            ["Mission", r.mission_id],
            ["Interval start", fmtUtc(r.start)],
            ["Interval end", fmtUtc(r.end)],
            ["Run", r.run_id ?? "—"],
            ["Model version", r.model_version],
            ["Generated", fmtUtc(r.created_at)],
            ["Report id", r.id],
            ["Most affected", s.most_affected_subsystem ?? "—"],
          ]}
        />
      </Panel>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Panel>
          <Stat label="Overall health (mean)" value={s.overall_health.mean.toFixed(1)} color={healthColor(s.overall_health.mean)} sub={`min ${s.overall_health.min.toFixed(1)} · final ${s.overall_health.final.toFixed(1)}`} />
        </Panel>
        <Panel>
          <Stat label="Anomalies" value={s.anomaly_count} sub={`max score ${fmtScore(s.max_anomaly_score)}`} color={s.anomaly_count ? scoreColor(s.max_anomaly_score) : TONE_COLORS.nominal} />
          <div className="mt-1 flex flex-wrap gap-1">
            {(["CRITICAL", "HIGH", "WARNING", "INFO"] as const).map((k) => (
              <StatusBadge key={k} status={k} label={`${k[0]}${k.slice(1).toLowerCase()} ${s.severity_counts[k] ?? 0}`} />
            ))}
          </div>
        </Panel>
        <Panel>
          <Stat
            label="Detection delay (mean)"
            value={s.detection_delay_s.mean === null ? "—" : fmtAge(s.detection_delay_s.mean)}
            sub={`min ${fmtAge(s.detection_delay_s.min)} · max ${fmtAge(s.detection_delay_s.max)} · n=${s.detection_delay_s.count}`}
          />
        </Panel>
        <Panel>
          <Stat
            label="Telemetry availability"
            value={`${s.telemetry.availability_pct.toFixed(1)}%`}
            color={s.telemetry.availability_pct >= 95 ? TONE_COLORS.nominal : s.telemetry.availability_pct >= 80 ? TONE_COLORS.warning : TONE_COLORS.critical}
            sub={`valid ${s.telemetry.valid_pct.toFixed(1)}% · ${s.telemetry.packets}/${s.telemetry.expected} pkts`}
          />
        </Panel>
      </div>

      <div className="grid gap-3 xl:grid-cols-3">
        <Panel title="Subsystem health" bodyClassName="p-0">
          <table className="tbl">
            <thead>
              <tr>
                <th>Subsystem</th>
                <th className="text-right!">Mean</th>
                <th className="text-right!">Min</th>
              </tr>
            </thead>
            <tbody>
              {SUBSYSTEM_IDS.map((id) => {
                const h = s.subsystem_health[id];
                return (
                  <tr key={id}>
                    <td className="num text-ink">{SUBSYSTEM_NAMES[id]}</td>
                    <td className="num text-right" style={{ color: h ? healthColor(h.mean) : undefined }}>
                      {h ? h.mean.toFixed(1) : "—"}
                    </td>
                    <td className="num text-right" style={{ color: h ? healthColor(h.min) : undefined }}>
                      {h ? h.min.toFixed(1) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="border-t border-line p-2">
            <div className="label mb-1">Data quality</div>
            <div className="flex flex-wrap gap-1">
              {Object.entries(s.telemetry.quality_counts).map(([q, n]) => (
                <StatusBadge key={q} status={q} label={`${q} ${n}`} />
              ))}
            </div>
          </div>
        </Panel>
        <Panel title="Overall health" className="xl:col-span-2">
          <MiniLine data={healthPts} color="#22c55e" domain={[0, 100]} name="Overall health" refs={[{ y: 70, color: TONE_COLORS.warning }, { y: 40, color: TONE_COLORS.high }, { y: 20, color: TONE_COLORS.critical }]} />
          <div className="label mt-2 mb-1">Fused anomaly score</div>
          <MiniLine data={scorePts} color="#e6edf3" domain={[0, 1]} name="Anomaly score" refs={[{ y: 0.3, color: TONE_COLORS.warning }, { y: 0.6, color: TONE_COLORS.high }, { y: 0.8, color: TONE_COLORS.critical }]} />
        </Panel>
      </div>

      <Panel title="Key telemetry">
        {Object.keys(r.plots.telemetry).length === 0 ? (
          <EmptyState>No telemetry plots in report</EmptyState>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {Object.entries(r.plots.telemetry).map(([k, pts]) => {
              const def = live.schemaByName[k];
              return (
                <div key={k} className="rounded-[3px] border border-line bg-panel-2 p-1.5">
                  <div className="px-1 text-[11px] font-semibold text-ink-2">
                    {def?.label ?? k} <span className="num font-normal text-muted">{def?.unit}</span>
                  </div>
                  <MiniLine data={pts.map((p) => ({ t: toMs(p.timestamp), v: p.value }))} color="#4ea1ff" name={def?.label ?? k} unit={def?.unit} height={110} />
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      <div className="grid gap-3 xl:grid-cols-[380px_minmax(0,1fr)]">
        <Panel title="Event timeline" bodyClassName="p-1.5">
          <AnomalyTimeline items={timeline} showDate empty="No events in interval" maxHeight={420} />
        </Panel>
        <Panel title={`Anomalies · ${r.anomalies.length}`} bodyClassName="p-0 max-h-[460px] overflow-auto">
          {r.anomalies.length === 0 ? (
            <EmptyState>No anomalies in interval</EmptyState>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Detected</th>
                  <th>Subsystems</th>
                  <th>Description</th>
                  <th className="text-right!">Peak</th>
                  <th className="text-right!">Delay</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {r.anomalies.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <StatusBadge status={a.severity} />
                    </td>
                    <td className="num whitespace-nowrap">{fmtUtc(a.timestamp)}</td>
                    <td className="num">{a.subsystems.join(", ")}</td>
                    <td>
                      <Link href={`/anomalies/${encodeURIComponent(a.id)}`} className="text-ink hover:text-accent">
                        {a.description}
                      </Link>
                    </td>
                    <td className="num text-right" style={{ color: scoreColor(a.peak_score) }}>
                      {fmtScore(a.peak_score)}
                    </td>
                    <td className="num text-right">{a.detection_delay_s === null ? "—" : fmtAge(a.detection_delay_s)}</td>
                    <td>
                      <StatusBadge status={a.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </div>
  );
}
