"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { fmtAge, fmtUtc, humanize, toneColor } from "@/lib/formatters";
import { useAction, useApi } from "@/lib/hooks";
import { useLive, useLiveStore } from "@/lib/live-data";
import type { FaultSeverity, Scenario, SimulationStatus } from "@/lib/types";
import { Button, cx, EmptyState, ErrorNote, Field, KV, Panel, Segmented, StatusBadge } from "./ui";

export const SPEEDS = [1, 2, 5, 10];
const SEVERITIES: FaultSeverity[] = ["mild", "moderate", "severe"];
const SEVERITY_TONE: Record<FaultSeverity, string> = { mild: "WARNING", moderate: "HIGH", severe: "CRITICAL" };

function useSimAction() {
  const store = useLiveStore();
  const act = useAction();
  const exec = async (fn: () => Promise<SimulationStatus>) => {
    const s = await act.run(fn);
    if (s) store?.setSimulation(s);
    return s;
  };
  return { ...act, exec };
}

/** Start / pause / resume / stop / reset + speed. */
export function SimulationRunControls() {
  const live = useLive();
  const sim = live.simulation;
  const { busy, error, exec } = useSimAction();
  const [runName, setRunName] = useState("");
  const running = !!sim?.running;
  const paused = !!sim?.paused;
  const isReplay = sim?.mode === "REPLAY";
  const state = isReplay ? "REPLAY" : running ? (paused ? "PAUSED" : "RUNNING") : "STOPPED";

  return (
    <Panel title="Simulator" tone={state} actions={<StatusBadge status={state} />}>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Run name (optional)">
          <input className="field w-44" value={runName} onChange={(e) => setRunName(e.target.value)} placeholder="e.g. demo-obc-thermal" disabled={running} />
        </Field>
        <Button variant="primary" disabled={busy || (running && !paused)} onClick={() => exec(() => (running && paused ? api.simResume() : api.simStart({ speed: sim?.speed ?? 1, run_name: runName || undefined })))}>
          ▶ {running && paused ? "Resume" : "Start"}
        </Button>
        <Button disabled={busy || !running || paused} onClick={() => exec(api.simPause)}>
          ❚❚ Pause
        </Button>
        <Button disabled={busy || !running || !paused} onClick={() => exec(api.simResume)}>
          ↻ Resume
        </Button>
        <Button variant="danger" disabled={busy || !running} onClick={() => exec(api.simStop)}>
          ■ Stop
        </Button>
        <Button variant="warning" disabled={busy} onClick={() => exec(api.simReset)} title="Clear faults/overrides, new spacecraft state, stopped">
          ⟲ Reset
        </Button>
        <div className="ml-auto flex flex-col gap-1">
          <span className="label">Speed</span>
          <Segmented options={SPEEDS.map((s) => ({ value: s, label: `${s}×` }))} value={sim?.speed ?? 1} onChange={(s) => exec(() => api.simSpeed(s))} disabled={busy || isReplay} />
        </div>
      </div>
      {isReplay ? <div className="mt-2 text-[11px] text-info">Live simulation is paused while a replay is active.</div> : null}
      <div className="mt-3">
        <KV
          cols={4}
          items={[
            ["Mode", sim?.mode ?? "—"],
            ["Run", sim?.run_id ?? "—"],
            ["Scenario", humanize(sim?.scenario)],
            ["Sim time", sim?.sim_time ? fmtUtc(sim.sim_time) : "—"],
            ["Sequence", sim?.sequence ?? "—"],
            ["Packets sent", sim?.packets_sent ?? "—"],
            ["Active faults", sim?.active_faults.length ?? 0],
            ["Overrides", sim ? Object.keys(sim.overrides).length : 0],
          ]}
        />
      </div>
      <div className="mt-2">
        <ErrorNote>{error}</ErrorNote>
      </div>
    </Panel>
  );
}

/** Scenario picker + fault injection (spec 9.4). */
export function FaultInjection() {
  const live = useLive();
  const scenarios = useApi(() => api.scenarios(), [live.backend.state === "ONLINE"]);
  const [selected, setSelected] = useState<string>("obc_thermal");
  const [severity, setSeverity] = useState<FaultSeverity>("moderate");
  const [delay, setDelay] = useState("0");
  const [duration, setDuration] = useState("");
  const { busy, error, exec } = useSimAction();
  const list: Scenario[] = scenarios.data ?? [];
  const sel = list.find((s) => s.id === selected);

  async function inject() {
    const d = duration.trim() === "" ? null : Number(duration);
    await exec(() =>
      api.simScenario({ scenario: selected, severity, start_delay_s: Math.max(0, Number(delay) || 0), duration_s: d !== null && Number.isFinite(d) && d > 0 ? d : null }),
    );
  }

  return (
    <Panel title="Fault injection" actions={<Button size="xs" variant="ghost" onClick={() => exec(() => api.simScenario({ scenario: "normal" }))} disabled={busy}>Clear all faults</Button>}>
      {scenarios.error && !list.length ? <EmptyState>Scenarios unavailable ({scenarios.error})</EmptyState> : null}
      <div className="grid gap-1.5 sm:grid-cols-2">
        {list.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setSelected(s.id)}
            className={cx(
              "rounded-[3px] border p-2 text-left transition-colors",
              selected === s.id ? "border-accent bg-accent/10" : "border-line bg-panel-2 hover:border-line-2",
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px] font-semibold text-ink">{s.name}</span>
              <span className="num text-[9px] text-muted">{s.id}</span>
            </div>
            <div className="mt-0.5 line-clamp-2 text-[11px] text-ink-2">{s.description}</div>
            {s.affected?.length ? <div className="num mt-1 text-[10px] text-muted">affects {s.affected.join(", ")}</div> : null}
          </button>
        ))}
      </div>
      {sel ? (
        <div className="mt-2 rounded-[3px] border border-line bg-panel-2 p-2 text-[11px]">
          <div className="label mb-0.5">Expected evidence</div>
          <div className="text-ink-2">{sel.expected_evidence || "—"}</div>
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <span className="label">Severity</span>
          <div className="flex gap-1">
            {SEVERITIES.map((s) => (
              <Button key={s} size="xs" active={severity === s} onClick={() => setSeverity(s)} style={severity === s ? undefined : { color: toneColor(SEVERITY_TONE[s]) }}>
                {s}
              </Button>
            ))}
          </div>
        </div>
        <Field label="Start delay (s)">
          <input type="number" min={0} className="field num w-24" value={delay} onChange={(e) => setDelay(e.target.value)} />
        </Field>
        <Field label="Duration (s, blank = until cleared)">
          <input type="number" min={1} className="field num w-32" value={duration} onChange={(e) => setDuration(e.target.value)} placeholder="∞" />
        </Field>
        <Button variant="danger" onClick={inject} disabled={busy || !selected}>
          ⚡ Inject {sel?.name ?? selected}
        </Button>
      </div>
      <div className="mt-2">
        <ErrorNote>{error}</ErrorNote>
      </div>
    </Panel>
  );
}

export function ActiveFaults() {
  const live = useLive();
  const faults = live.simulation?.active_faults ?? [];
  return (
    <Panel title={`Active faults · ${faults.filter((f) => f.status !== "ENDED").length}`}>
      {faults.length === 0 ? (
        <EmptyState>No injected faults – nominal scenario</EmptyState>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>Scenario</th>
              <th>Severity</th>
              <th>Start</th>
              <th>Elapsed</th>
              <th>Duration</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {faults.map((f) => (
              <tr key={f.id}>
                <td className="text-ink">{humanize(f.scenario)}</td>
                <td>
                  <StatusBadge status={SEVERITY_TONE[f.severity]} label={f.severity} />
                </td>
                <td className="num">{fmtUtc(f.start_time)}</td>
                <td className="num">{fmtAge(f.elapsed_s)}</td>
                <td className="num">{f.duration_s ? fmtAge(f.duration_s) : "∞"}</td>
                <td>
                  <StatusBadge status={f.status === "ACTIVE" ? "CRITICAL" : f.status === "PENDING" ? "PENDING" : "OFFLINE"} label={f.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

/** Manual parameter override for demonstrations. */
export function ParameterOverride() {
  const live = useLive();
  const numeric = live.schema.filter((p) => p.type !== "enum");
  const [param, setParam] = useState("obc_temperature");
  const [value, setValue] = useState("");
  const [duration, setDuration] = useState("");
  const { busy, error, setError, exec } = useSimAction();
  const overrides = live.simulation?.overrides ?? {};
  const def = live.schemaByName[param];

  async function apply() {
    const v = Number(value);
    if (value.trim() === "" || !Number.isFinite(v)) {
      setError("Enter a numeric value");
      return;
    }
    const d = Number(duration);
    await exec(() => api.simOverride({ parameter: param, value: v, ...(duration && d > 0 ? { duration_s: d } : {}) }));
  }

  return (
    <Panel title="Manual parameter override">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Parameter">
          <select className="field w-48" value={param} onChange={(e) => setParam(e.target.value)}>
            {numeric.map((p) => (
              <option key={p.name} value={p.name}>
                {p.label} ({p.unit || "–"})
              </option>
            ))}
          </select>
        </Field>
        <Field label={`Value${def?.unit ? ` (${def.unit})` : ""}`}>
          <input type="number" step="any" className="field num w-24" value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
        <Field label="Duration (s)">
          <input type="number" min={1} className="field num w-24" value={duration} onChange={(e) => setDuration(e.target.value)} placeholder="∞" />
        </Field>
        <Button variant="warning" onClick={apply} disabled={busy}>
          Apply override
        </Button>
      </div>
      {def && (def.nominal_min !== null || def.limit_max !== null) ? (
        <div className="num mt-1 text-[10px] text-muted">
          nominal {def.nominal_min ?? "−∞"} … {def.nominal_max ?? "+∞"} · limits {def.limit_min ?? "−∞"} … {def.limit_max ?? "+∞"}
        </div>
      ) : null}
      <div className="mt-2">
        <ErrorNote>{error}</ErrorNote>
      </div>
      <div className="mt-2">
        {Object.keys(overrides).length === 0 ? (
          <div className="text-[11px] text-muted">No active overrides.</div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Parameter</th>
                <th className="text-right!">Value</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {Object.entries(overrides).map(([k, v]) => (
                <tr key={k}>
                  <td className="num text-ink">{k}</td>
                  <td className="num text-right text-warning">
                    {v} {live.schemaByName[k]?.unit}
                  </td>
                  <td className="text-right">
                    <Button size="xs" onClick={() => exec(() => api.simOverride({ parameter: k, value: null }))} disabled={busy}>
                      Clear
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Panel>
  );
}

/** Composite simulation control (spec 9.4). */
export function SimulationControl() {
  return (
    <div className="grid gap-3 xl:grid-cols-2">
      <div className="space-y-3">
        <SimulationRunControls />
        <ActiveFaults />
        <ParameterOverride />
      </div>
      <FaultInjection />
    </div>
  );
}
