"use client";

import { useState } from "react";
import { TelemetryChart } from "@/components/telemetry-chart";
import { Button, cx, PageHeader, Panel, StatusBadge } from "@/components/ui";
import { telemetryExportUrl } from "@/lib/api";
import { fmtRange, fmtValue, fmtUtcTime, rangeState, TONE_COLORS } from "@/lib/formatters";
import { useLive } from "@/lib/live-data";
import { TELEMETRY_GROUPS } from "@/lib/params";

export default function TelemetryPage() {
  const live = useLive();
  const [groupId, setGroupId] = useState(TELEMETRY_GROUPS[0].id);
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const [cols, setCols] = useState<1 | 2 | 3>(2);
  const group = TELEMETRY_GROUPS.find((g) => g.id === groupId) ?? TELEMETRY_GROUPS[0];
  const visible = group.params.filter((p) => !hidden[p]);
  const pkt = live.latestTelemetry;

  return (
    <div>
      <PageHeader
        title="Telemetry"
        subtitle={
          <span className="num">
            {pkt ? `seq ${pkt.sequence} · ${pkt.source} · ${fmtUtcTime(pkt.timestamp, true)}Z · packet ${pkt.quality}` : "No telemetry received yet"} · buffer {live.telemetry.length} packets
          </span>
        }
        actions={
          <>
            <span className="label">Columns</span>
            {[1, 2, 3].map((c) => (
              <Button key={c} size="xs" active={cols === c} onClick={() => setCols(c as 1 | 2 | 3)}>
                {c}
              </Button>
            ))}
            <a className="inline-flex h-[26px] items-center rounded-[3px] border border-line-2 bg-panel-2 px-2.5 text-xs text-ink hover:border-accent" href={telemetryExportUrl({ fields: group.params })} download>
              Export group CSV (last 10 min)
            </a>
          </>
        }
      />

      {/* group tabs */}
      <div className="mb-2 flex flex-wrap gap-1 border-b border-line" role="tablist">
        {TELEMETRY_GROUPS.map((g) => (
          <button
            key={g.id}
            role="tab"
            aria-selected={g.id === groupId}
            type="button"
            onClick={() => setGroupId(g.id)}
            className={cx(
              "-mb-px border-b-2 px-3 py-1.5 text-[12px] font-medium tracking-wide uppercase",
              g.id === groupId ? "border-accent text-accent" : "border-transparent text-ink-2 hover:text-ink",
            )}
          >
            {g.label}
          </button>
        ))}
      </div>

      {/* parameter picker */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <span className="label mr-1">Parameters</span>
        {group.params.map((p) => {
          const def = live.schemaByName[p];
          const on = !hidden[p];
          return (
            <button
              key={p}
              type="button"
              onClick={() => setHidden({ ...hidden, [p]: on })}
              aria-pressed={on}
              className={cx(
                "rounded-[3px] border px-2 py-[2px] text-[11px]",
                on ? "border-accent/60 bg-accent/10 text-accent" : "border-line-2 bg-panel-2 text-muted hover:text-ink",
              )}
            >
              {on ? "☑" : "☐"} {def?.label ?? p}
            </button>
          );
        })}
      </div>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_330px]">
        <div className={cx("grid min-w-0 items-start gap-3", cols === 2 && "lg:grid-cols-2", cols === 3 && "lg:grid-cols-2 2xl:grid-cols-3")}>
          {visible.map((p) => (
            <TelemetryChart key={p} param={p} defaultWindow="5m" height={cols === 1 ? 220 : 160} />
          ))}
          {!visible.length ? <div className="text-xs text-muted">Select at least one parameter.</div> : null}
        </div>

        <Panel title="All parameters · live" bodyClassName="p-0 max-h-[calc(100vh-190px)] overflow-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Parameter</th>
                <th className="text-right!">Value</th>
                <th>Q</th>
              </tr>
            </thead>
            <tbody>
              {live.schema.map((d) => {
                const v = pkt?.data?.[d.name];
                const q = pkt?.field_quality?.[d.name] ?? (pkt ? "VALID" : null);
                const rs = rangeState(v, d);
                return (
                  <tr key={d.name} title={`${d.description || d.label} · nominal ${fmtRange(d.nominal_min, d.nominal_max)}`}>
                    <td>
                      <div className="text-[11px] text-ink">{d.label}</div>
                      <div className="num text-[9px] text-muted">
                        {d.subsystem} · {fmtRange(d.nominal_min, d.nominal_max)}
                      </div>
                    </td>
                    <td className="num text-right whitespace-nowrap" style={{ color: rs === "critical" ? TONE_COLORS.critical : rs === "warning" ? TONE_COLORS.warning : undefined }}>
                      {fmtValue(v, d.type === "enum" ? undefined : d.unit)}
                    </td>
                    <td>{q ? <StatusBadge status={q} label={q === "VALID" ? "OK" : q} /> : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>
      </div>
    </div>
  );
}
