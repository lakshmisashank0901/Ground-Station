"use client";

import Link from "next/link";
import { fmtDuration, fmtNum, healthColor, rangeState, toneColor, trendArrow, TONE_COLORS } from "@/lib/formatters";
import { CARD_PARAMS, SHORT_LABELS, SUBSYSTEM_NAMES, SUBSYSTEM_TITLES } from "@/lib/params";
import type { HealthStatus, HealthUpdate, ParameterDef, SubsystemHealth, SubsystemId, TelemetryValue } from "@/lib/types";
import { cx, Sparkline, StatusBadge } from "./ui";

/** Big overall-health tile: 0–100 score, status, trend. */
export function OverallHealthCard({ health, history }: { health: HealthUpdate | null; history: number[] }) {
  const score = health?.overall_score ?? null;
  const status: HealthStatus = health?.status ?? "UNKNOWN";
  const color = score === null ? TONE_COLORS.unknown : healthColor(score);
  const trend = health?.trend ?? "flat";
  return (
    <div className="flex h-full flex-col justify-between rounded-[4px] border border-line bg-panel p-2.5" style={{ borderTop: `2px solid ${toneColor(status)}` }}>
      <div className="flex items-center justify-between">
        <span className="label">Overall health</span>
        <StatusBadge status={status} />
      </div>
      <div className="flex items-end gap-2">
        <span className="num text-[40px] leading-none font-bold" style={{ color }}>
          {score === null ? "—" : score.toFixed(0)}
        </span>
        <span className="num mb-1 text-xs text-muted">/100</span>
        <span className="num mb-1 ml-auto text-sm" style={{ color: trend === "down" ? TONE_COLORS.high : trend === "up" ? TONE_COLORS.nominal : "#66748a" }} title={`Trend ${trend}`}>
          {trendArrow(trend)} {trend.toUpperCase()}
        </span>
      </div>
      <Sparkline values={history} color={color} min={0} max={100} height={24} />
    </div>
  );
}

function fmtCardValue(name: string, v: TelemetryValue | undefined, def?: ParameterDef): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  if (name === "obc_uptime") return fmtDuration(v);
  const unit = def?.unit && def.unit !== "–" && def.unit !== "count" ? def.unit.replace("deg/s", "°/s").replace("deg", "°") : "";
  if (unit === "°" || unit === "°/s") return `${fmtNum(v)}${unit}`;
  return `${fmtNum(v)}${unit === "%" ? "%" : unit ? ` ${unit}` : ""}`;
}

/** Subsystem health card (spec 4.4) — key values come from the health update, falling back to live telemetry. */
export function SubsystemHealthCard({
  id,
  sub,
  telemetry,
  schema,
  compact,
}: {
  id: SubsystemId;
  sub: SubsystemHealth | undefined;
  telemetry: Record<string, TelemetryValue> | undefined;
  schema: Record<string, ParameterDef>;
  compact?: boolean;
}) {
  const status = sub?.status ?? "UNKNOWN";
  const score = sub?.health_score ?? null;
  const params = CARD_PARAMS[id];
  return (
    <Link
      href={`/subsystems/${id}`}
      className="group flex min-w-0 flex-col rounded-[4px] border border-line bg-panel p-2.5 transition-colors hover:border-line-2 hover:bg-panel-2"
      style={{ borderTop: `2px solid ${toneColor(status)}` }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="num text-[13px] font-bold tracking-wider text-ink">{sub?.name ?? SUBSYSTEM_NAMES[id]}</div>
          {!compact ? <div className="truncate text-[10px] text-muted">{SUBSYSTEM_TITLES[id]}</div> : null}
        </div>
        <div className="flex flex-col items-end">
          <span className="num text-[20px] leading-none font-bold" style={{ color: score === null ? TONE_COLORS.unknown : healthColor(score) }}>
            {score === null ? "—" : score.toFixed(0)}
          </span>
          <StatusBadge status={status} className="mt-1" />
        </div>
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
        {params.map((p) => {
          const def = schema[p];
          const v = sub?.key_values?.[p] !== undefined ? sub.key_values[p] : telemetry?.[p];
          const rs = rangeState(v, def);
          const isAlarmEnum = p === "watchdog_status" && v === "FAULT";
          const color = rs === "critical" || isAlarmEnum ? TONE_COLORS.critical : rs === "warning" ? TONE_COLORS.warning : undefined;
          return (
            <div key={p} className="flex min-w-0 items-baseline justify-between gap-1">
              <dt className="truncate text-[10px] text-muted" title={def?.label ?? p}>{SHORT_LABELS[p] ?? def?.label ?? p}</dt>
              <dd className={cx("num truncate text-[11px]", !color && "text-ink")} style={color ? { color } : undefined}>
                {fmtCardValue(p, v, def)}
              </dd>
            </div>
          );
        })}
      </dl>
      <div className="mt-2 flex items-center justify-between border-t border-line pt-1.5 text-[10px]">
        <span className="text-muted">Active anomalies</span>
        <span className="num font-semibold" style={{ color: sub?.active_anomalies ? TONE_COLORS.critical : TONE_COLORS.nominal }}>
          {sub?.active_anomalies ?? 0}
        </span>
      </div>
    </Link>
  );
}
