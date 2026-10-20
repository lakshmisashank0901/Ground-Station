"use client";

import Link from "next/link";
import { use, useMemo } from "react";
import { AnomalyCard } from "@/components/anomaly-card";
import { TelemetryChart } from "@/components/telemetry-chart";
import { EmptyState, ErrorNote, PageHeader, Panel, StatusBadge } from "@/components/ui";
import { api } from "@/lib/api";
import { fmtRange, fmtValue, healthColor, rangeState, toMs, TONE_COLORS } from "@/lib/formatters";
import { useApi } from "@/lib/hooks";
import { useLive } from "@/lib/live-data";
import { SUBSYSTEM_NAMES, SUBSYSTEM_TITLES, subsystemIdFromName } from "@/lib/params";

export default function SubsystemDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = use(params);
  const id = subsystemIdFromName(decodeURIComponent(rawId));
  const live = useLive();
  const detail = useApi((signal) => api.subsystem(id ?? rawId, signal), [rawId], { intervalMs: 10_000, enabled: !!id });

  const name = id ? SUBSYSTEM_NAMES[id] : rawId.toUpperCase();
  const liveSub = live.latestHealth?.subsystems.find((s) => s.id === id);
  const status = liveSub?.status ?? detail.data?.status ?? "UNKNOWN";
  const score = liveSub?.health_score ?? detail.data?.health_score ?? null;
  const schemaParams = useMemo(() => live.schema.filter((p) => p.subsystem === name), [live.schema, name]);
  const rows = detail.data?.parameters?.length
    ? detail.data.parameters
    : schemaParams.map((p) => ({ ...p, value: null, quality: "MISSING" as const }));
  const pkt = live.latestTelemetry;

  const anomalies = useMemo(() => {
    const m = new Map<string, (typeof live.anomalies)[number]>();
    for (const a of detail.data?.anomalies ?? []) m.set(a.id, a);
    for (const a of live.anomalies) if (a.subsystems.some((s) => s.toUpperCase() === name)) m.set(a.id, a);
    return Array.from(m.values())
      .sort((a, b) => toMs(b.timestamp) - toMs(a.timestamp))
      .slice(0, 20);
  }, [detail.data, live, name]);

  if (!id) {
    return (
      <div>
        <PageHeader title="Unknown subsystem" />
        <EmptyState>
          No subsystem “{rawId}”. <Link href="/subsystems" className="ml-1 text-accent">Back to subsystems</Link>
        </EmptyState>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={`${name} · ${SUBSYSTEM_TITLES[id]}`}
        subtitle={detail.data?.description ?? (detail.error ? `Details unavailable: ${detail.error}` : "")}
        actions={
          <>
            <StatusBadge status={status} />
            <span className="num text-xl font-bold" style={{ color: score === null ? undefined : healthColor(score) }}>
              {score === null ? "—" : score.toFixed(0)}
            </span>
            <span className="num text-xs text-muted">/100 · {liveSub?.active_anomalies ?? detail.data?.active_anomalies ?? 0} active</span>
            <Link href="/subsystems" className="text-[11px] text-accent hover:underline">
              All subsystems
            </Link>
          </>
        }
      />
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-3">
          <Panel title="Parameters" bodyClassName="p-0 overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Parameter</th>
                  <th className="text-right!">Value</th>
                  <th>Quality</th>
                  <th>Nominal</th>
                  <th>Limits</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const v = pkt?.data?.[p.name] !== undefined ? pkt.data[p.name] : p.value;
                  const q = pkt ? (pkt.field_quality?.[p.name] ?? "VALID") : p.quality;
                  const rs = rangeState(v, p);
                  return (
                    <tr key={p.name}>
                      <td>
                        <span className="text-ink">{p.label}</span> <span className="num text-[10px] text-muted">{p.name}</span>
                      </td>
                      <td className="num text-right font-semibold" style={{ color: rs === "critical" ? TONE_COLORS.critical : rs === "warning" ? TONE_COLORS.warning : "#fff" }}>
                        {fmtValue(v, p.unit)}
                      </td>
                      <td>
                        <StatusBadge status={q} />
                      </td>
                      <td className="num text-ink-2">{fmtRange(p.nominal_min, p.nominal_max)}</td>
                      <td className="num text-ink-2">{fmtRange(p.limit_min, p.limit_max)}</td>
                      <td>
                        <StatusBadge status={rs === "nominal" ? "NOMINAL" : rs === "warning" ? "WARNING" : rs === "critical" ? "CRITICAL" : "UNKNOWN"} label={rs === "unknown" ? "n/a" : rs} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Panel>
          <div className="grid gap-3 lg:grid-cols-2">
            {schemaParams.map((p) => (
              <TelemetryChart key={p.name} param={p.name} defaultWindow="5m" height={150} />
            ))}
          </div>
        </div>
        <Panel title={`Anomalies · ${name}`} bodyClassName="space-y-1.5 max-h-[calc(100vh-170px)] overflow-auto">
          {detail.error && !anomalies.length ? <ErrorNote>{detail.error}</ErrorNote> : null}
          {anomalies.length ? anomalies.map((a) => <AnomalyCard key={a.id} anomaly={a} />) : <EmptyState>No anomalies recorded for {name}</EmptyState>}
        </Panel>
      </div>
    </div>
  );
}
