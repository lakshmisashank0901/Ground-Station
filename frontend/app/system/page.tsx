"use client";

import { EmptyState, KV, PageHeader, Panel, StatusBadge } from "@/components/ui";
import { api } from "@/lib/api";
import { fmtAge, fmtDuration, fmtMs, fmtUtc, toneColor } from "@/lib/formatters";
import { useApi } from "@/lib/hooks";
import { useLive } from "@/lib/live-data";
import { WS_CHANNELS } from "@/lib/websocket";
import type { ReactNode } from "react";

function Tile({ title, status, children }: { title: string; status: string; children: ReactNode }) {
  return (
    <Panel title={title} tone={status} actions={<StatusBadge status={status} />}>
      {children}
    </Panel>
  );
}

export default function SystemPage() {
  const live = useLive();
  const online = live.backend.state === "ONLINE";
  // REST fallback when the system WebSocket isn't delivering
  const rest = useApi((signal) => api.systemStatus(signal), [online], { enabled: !live.system, intervalMs: 5000 });
  const events = useApi((signal) => api.systemEvents(200, signal), [online], { intervalMs: 5000 });
  const sys = live.system ?? rest.data;
  const backendStatus = live.backend.state === "OFFLINE" ? "OFFLINE" : (sys?.backend.status ?? live.backend.state);

  return (
    <div className="space-y-3">
      <PageHeader
        title="Ground-station system"
        subtitle={sys ? `Status snapshot ${fmtUtc(sys.timestamp)}` : live.backend.state === "OFFLINE" ? "Backend unreachable" : "Waiting for status…"}
      />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <Tile title="Backend" status={backendStatus}>
          <KV
            items={[
              ["Version", sys?.backend.version ?? live.backend.version ?? "—"],
              ["Uptime", fmtDuration(sys?.backend.uptime_s)],
              ["Server latency", fmtMs(sys?.backend.latency_ms)],
              ["Round-trip (UI)", fmtMs(live.backend.latencyMs)],
            ]}
          />
        </Tile>
        <Tile title="Database" status={sys?.database.status ?? "UNKNOWN"}>
          <KV
            items={[
              ["Engine", sys?.database.engine ?? "—"],
              ["Query latency", fmtMs(sys?.database.latency_ms)],
            ]}
          />
        </Tile>
        <Tile title="ML engine" status={sys?.ml.status ?? "UNKNOWN"}>
          <KV
            items={[
              ["Model version", sys?.ml.model_version ?? "—"],
              ["Inference latency", fmtMs(sys?.ml.inference_latency_ms)],
              ["Models loaded", sys?.ml.models_loaded.join(", ") || "—"],
            ]}
            cols={1}
          />
        </Tile>
        <Tile title="WebSocket" status={sys?.websocket.status ?? "UNKNOWN"}>
          <KV
            items={[
              ["Server clients", sys?.websocket.clients ?? "—"],
              ["Message rate", sys ? `${sys.websocket.message_rate.toFixed(1)} msg/s` : "—"],
            ]}
          />
          <div className="mt-2 border-t border-line pt-2">
            <div className="label mb-1">This console</div>
            {WS_CHANNELS.map((c) => {
              const ch = live.channels[c];
              return (
                <div key={c} className="num flex items-center justify-between text-[11px]">
                  <span className="text-ink">/ws/{c}</span>
                  <span className="flex items-center gap-2">
                    <span className="text-muted">{ch.messages} msgs</span>
                    <span style={{ color: toneColor(ch.state) }}>{ch.state}</span>
                  </span>
                </div>
              );
            })}
          </div>
        </Tile>
        <Tile title="Simulator" status={sys?.simulator.status ?? "UNKNOWN"}>
          <KV
            items={[
              ["Mode", sys?.simulator.mode ?? "—"],
              ["Scenario", sys?.simulator.scenario ?? "—"],
              ["Speed", sys ? `${sys.simulator.speed}×` : "—"],
            ]}
          />
        </Tile>
        <Tile title="Telemetry" status={sys?.telemetry.status ?? "UNKNOWN"}>
          <KV
            items={[
              ["Packet rate", sys ? `${sys.telemetry.packet_rate.toFixed(2)} pkt/s` : "—"],
              ["Stale age", fmtAge(sys?.telemetry.stale_age_s)],
              ["Received", sys?.telemetry.received_count ?? "—"],
              ["Rejected", sys?.telemetry.rejected_count ?? "—"],
              ["Last packet", fmtUtc(sys?.telemetry.last_packet_time)],
            ]}
          />
        </Tile>
      </div>

      <Panel title="System events" bodyClassName="p-0 max-h-[50vh] overflow-auto">
        {!events.data?.length ? (
          <EmptyState>{events.error ? `Events unavailable (${events.error})` : events.loading ? "Loading…" : "No events"}</EmptyState>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Time (UTC)</th>
                <th>Level</th>
                <th>Component</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {events.data.map((e, i) => (
                <tr key={`${e.timestamp}-${i}`}>
                  <td className="num whitespace-nowrap">{fmtUtc(e.timestamp, true)}</td>
                  <td>
                    <StatusBadge status={e.level.toUpperCase() === "ERROR" ? "CRITICAL" : e.level.toUpperCase() === "WARNING" ? "WARNING" : "INFO"} label={e.level} />
                  </td>
                  <td className="num text-ink-2">{e.component}</td>
                  <td className="text-ink">{e.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
