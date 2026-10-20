"use client";

import Link from "next/link";
import { useMemo } from "react";
import { AlarmCenter } from "@/components/alarm-center";
import { DetectorBars } from "@/components/ai-explanation";
import { AnomalyTimeline, type TimelineItem } from "@/components/anomaly-timeline";
import { OverallHealthCard, SubsystemHealthCard } from "@/components/health-card";
import { SatelliteSchematic } from "@/components/satellite-schematic";
import { HealthTrendChart, LiveScoreChart } from "@/components/score-chart";
import { TelemetryChart } from "@/components/telemetry-chart";
import { EmptyState, Panel, ScoreBar, Sparkline, Stat, StatusBadge } from "@/components/ui";
import { fmtAge, fmtValue, fmtPct01, fmtScore, fmtUtcTime, healthColor, scoreColor, scoreToState, TONE_COLORS } from "@/lib/formatters";
import { useNow } from "@/lib/hooks";
import { useLive } from "@/lib/live-data";
import { DASHBOARD_CHART_PARAMS, SUBSYSTEM_IDS } from "@/lib/params";

export default function DashboardPage() {
  const live = useLive();
  const now = useNow(1000);
  const h = live.latestHealth;
  const inf = h?.inference ?? null;
  const subs = h?.subsystems ?? live.satStatus?.subsystems ?? [];
  const data = live.latestTelemetry?.data;
  const healthHist = useMemo(() => live.health.slice(-120).map((p) => p.overall), [live.health]);
  const scoreHist = useMemo(() => live.health.slice(-120).map((p) => p.anomaly), [live.health]);
  const anomalyScore = h?.anomaly_score ?? live.satStatus?.anomaly_score ?? null;
  const packetRate = live.system?.telemetry.packet_rate ?? (live.packetRate || live.satStatus?.packet_rate) ?? 0;
  const age = live.lastPacketRecvAt && now ? (now - live.lastPacketRecvAt) / 1000 : (live.satStatus?.last_packet_age_s ?? null);
  const comm = live.satStatus?.comm_quality ?? null;

  const timeline: TimelineItem[] = useMemo(
    () => live.events.slice(0, 40).map((e) => ({ key: e.id, t: e.t, kind: e.kind, severity: e.severity, text: e.text, href: e.href })),
    [live.events],
  );

  return (
    <div className="space-y-3">
      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <div className="col-span-2 md:col-span-1 xl:col-span-2">
          <OverallHealthCard health={h} history={healthHist} />
        </div>
        <Panel bodyClassName="flex flex-col justify-between gap-1">
          <Stat label="Anomaly score" value={fmtScore(anomalyScore)} color={scoreColor(anomalyScore)} sub={scoreToState(anomalyScore)} />
          <Sparkline values={scoreHist} color={scoreColor(anomalyScore)} min={0} max={1} />
        </Panel>
        <Panel bodyClassName="flex flex-col justify-between gap-1">
          <Stat label="Packet rate" value={packetRate.toFixed(1)} unit="pkt/s" sub={`${live.latestTelemetry?.source ?? "—"} · seq ${live.latestTelemetry?.sequence ?? "—"}`} />
          <div className="num text-[10px] text-muted">rx {live.system?.telemetry.received_count ?? "—"} · rej {live.system?.telemetry.rejected_count ?? "—"}</div>
        </Panel>
        <Panel bodyClassName="flex flex-col justify-between gap-1">
          <Stat
            label="Last packet age"
            value={fmtAge(age)}
            color={age === null ? TONE_COLORS.unknown : age < 5 ? TONE_COLORS.nominal : age < 30 ? TONE_COLORS.warning : TONE_COLORS.critical}
            sub={fmtUtcTime(live.latestTelemetry?.timestamp ?? live.satStatus?.last_packet_time, true)}
          />
          <div className="num text-[10px] text-muted">quality {live.latestTelemetry?.quality ?? "—"}</div>
        </Panel>
        <Panel bodyClassName="flex flex-col justify-between gap-1">
          <Stat label="Comm quality" value={comm === null ? "—" : comm.toFixed(0)} unit={comm === null ? undefined : "/100"} color={comm === null ? undefined : healthColor(comm)} sub={`RSSI ${fmtValue(data?.rssi, "dBm", 1)} · SNR ${fmtValue(data?.snr, "dB", 1)}`} />
          <ScoreBar value={comm === null ? null : comm / 100} color={comm === null ? undefined : healthColor(comm)} />
        </Panel>
      </div>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-3">
          {/* schematic + subsystem cards */}
          <div className="grid gap-3 2xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
            <div className="min-w-0 space-y-3">
              <Panel title="Spacecraft schematic" actions={<span className="text-[10px] text-muted">click a node for details</span>}>
                <SatelliteSchematic subsystems={subs} data={data} />
              </Panel>
              <Panel title="Fused anomaly score · detector breakdown">
                <LiveScoreChart height={150} />
              </Panel>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {SUBSYSTEM_IDS.map((id) => (
                <SubsystemHealthCard key={id} id={id} sub={subs.find((s) => s.id === id)} telemetry={data} schema={live.schemaByName} compact />
              ))}
              <Panel title="Health trend · 15m" bodyClassName="p-1.5">
                <HealthTrendChart height={110} />
              </Panel>
            </div>
          </div>

          {/* live charts */}
          <div className="grid gap-3 lg:grid-cols-2">
            {DASHBOARD_CHART_PARAMS.map((p) => (
              <TelemetryChart key={p} param={p} defaultWindow="1m" height={140} />
            ))}
          </div>
        </div>

        {/* right rail */}
        <div className="min-w-0 space-y-3">
          <AlarmCenter limit={6} />
          <Panel
            title="AI health summary"
            actions={
              <Link href="/ai" className="text-[11px] text-accent hover:underline">
                Models →
              </Link>
            }
          >
            {!inf ? (
              <EmptyState>No inference yet</EmptyState>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="num text-[22px] font-bold" style={{ color: scoreColor(inf.anomaly_score) }}>
                    {fmtScore(inf.anomaly_score)}
                  </span>
                  <div className="flex flex-col items-end gap-0.5">
                    <StatusBadge status={inf.severity} />
                    <span className="num text-[10px] text-muted">conf {fmtPct01(inf.confidence)} · {inf.model_version}</span>
                  </div>
                </div>
                <DetectorBars detectors={inf.detectors} />
                <div>
                  <div className="label mb-1">Top features</div>
                  {inf.top_features.length ? (
                    <ul className="space-y-0.5">
                      {inf.top_features.slice(0, 5).map((f) => (
                        <li key={f.feature} className="num flex items-center justify-between gap-2 text-[11px]">
                          <span className="truncate text-ink">{f.feature}</span>
                          <span className="text-muted">
                            {f.z_score >= 0 ? "+" : ""}
                            {f.z_score.toFixed(1)}σ · {(f.contribution * 100).toFixed(0)}%
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="text-[11px] text-muted">—</div>
                  )}
                </div>
                {inf.affected_subsystems.length ? (
                  <div className="num text-[10px] text-muted">affected: {inf.affected_subsystems.join(", ")}</div>
                ) : null}
              </div>
            )}
          </Panel>
          <Panel title="Recent events" bodyClassName="p-1.5">
            <AnomalyTimeline items={timeline} empty="No events this session" maxHeight={340} />
          </Panel>
        </div>
      </div>
    </div>
  );
}
