"use client";

import { SubsystemHealthCard } from "@/components/health-card";
import { PageHeader, Panel, StatusBadge } from "@/components/ui";
import { api } from "@/lib/api";
import { fmtUtcTime, healthColor } from "@/lib/formatters";
import { useApi } from "@/lib/hooks";
import { useLive } from "@/lib/live-data";
import { SUBSYSTEM_IDS, SUBSYSTEM_TITLES } from "@/lib/params";
import Link from "next/link";

export default function SubsystemsPage() {
  const live = useLive();
  // REST fallback when no health frames have arrived over the WebSocket yet
  const rest = useApi(() => api.subsystems(), [], { enabled: !live.latestHealth });
  const subs = live.latestHealth?.subsystems ?? rest.data ?? [];

  return (
    <div>
      <PageHeader
        title="Subsystems"
        subtitle={live.latestHealth ? `Live health · ${fmtUtcTime(live.latestHealth.timestamp)}Z` : rest.error ? `Unavailable: ${rest.error}` : "Loading…"}
      />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
        {SUBSYSTEM_IDS.map((id) => (
          <SubsystemHealthCard key={id} id={id} sub={subs.find((s) => s.id === id)} telemetry={live.latestTelemetry?.data} schema={live.schemaByName} />
        ))}
      </div>
      <Panel title="Summary" className="mt-3" bodyClassName="p-0">
        <table className="tbl">
          <thead>
            <tr>
              <th>Subsystem</th>
              <th>Description</th>
              <th>Status</th>
              <th className="text-right!">Health</th>
              <th className="text-right!">Active anomalies</th>
            </tr>
          </thead>
          <tbody>
            {SUBSYSTEM_IDS.map((id) => {
              const s = subs.find((x) => x.id === id);
              return (
                <tr key={id}>
                  <td>
                    <Link href={`/subsystems/${id}`} className="num font-semibold text-accent hover:underline">
                      {s?.name ?? id.toUpperCase()}
                    </Link>
                  </td>
                  <td className="text-ink-2">{SUBSYSTEM_TITLES[id]}</td>
                  <td>
                    <StatusBadge status={s?.status ?? "UNKNOWN"} />
                  </td>
                  <td className="num text-right" style={{ color: s ? healthColor(s.health_score) : undefined }}>
                    {s ? s.health_score.toFixed(1) : "—"}
                  </td>
                  <td className="num text-right">{s?.active_anomalies ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
