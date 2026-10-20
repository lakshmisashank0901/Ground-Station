"use client";

import { useEffect } from "react";
import { ReplayPanel } from "@/components/replay-panel";
import { SimulationControl } from "@/components/simulation-control";
import { TelemetryChart } from "@/components/telemetry-chart";
import { PageHeader } from "@/components/ui";
import { useLive } from "@/lib/live-data";

export default function SimulationPage() {
  const live = useLive();
  useEffect(() => {
    if (window.location.hash === "#replay") {
      const t = setTimeout(() => document.getElementById("replay")?.scrollIntoView({ behavior: "smooth", block: "start" }), 150);
      return () => clearTimeout(t);
    }
  }, []);

  return (
    <div className="space-y-3">
      <PageHeader
        title="Simulation & replay"
        subtitle={`Mode ${live.mode} · the simulator feeds the same ingestion → ML → WebSocket pipeline as real telemetry`}
      />
      <SimulationControl />
      <div className="grid gap-3 lg:grid-cols-3">
        <TelemetryChart param="obc_temperature" defaultWindow="1m" height={130} />
        <TelemetryChart param="cpu_load" defaultWindow="1m" height={130} />
        <TelemetryChart param="power_consumption" defaultWindow="1m" height={130} />
      </div>
      <h2 className="pt-2 text-[13px] font-semibold tracking-wide text-ink uppercase">Replay</h2>
      <ReplayPanel />
    </div>
  );
}
