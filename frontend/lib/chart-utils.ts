// Pure helpers for telemetry charts. Unit tested in tests/chart-utils.test.ts.
import { fmtUtcTime, isNum, toMs } from "./formatters";
import type { Anomaly, ParameterDef, TelemetryRow, TelemetryValue } from "./types";

export type WindowKey = "10s" | "1m" | "5m" | "30m" | "1h" | "custom";

export const WINDOWS: { key: WindowKey; label: string; ms: number }[] = [
  { key: "10s", label: "10s", ms: 10_000 },
  { key: "1m", label: "1m", ms: 60_000 },
  { key: "5m", label: "5m", ms: 300_000 },
  { key: "30m", label: "30m", ms: 1_800_000 },
  { key: "1h", label: "1h", ms: 3_600_000 },
  { key: "custom", label: "Custom", ms: 0 },
];

export function windowMs(key: WindowKey): number {
  return WINDOWS.find((w) => w.key === key)?.ms ?? 60_000;
}

export interface ChartPoint {
  t: number;
  v: number | null;
  raw: TelemetryValue;
}

/** Numeric plotting value for a telemetry value: enums become their index in enum_values. */
export function plotValue(raw: TelemetryValue | undefined, def?: Pick<ParameterDef, "type" | "enum_values">): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (def?.type === "enum" && def.enum_values) {
    const i = def.enum_values.indexOf(raw);
    return i >= 0 ? i : null;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Convert packets/rows to chart points for one parameter (ascending time assumed). */
export function rowsToPoints(rows: readonly Pick<TelemetryRow, "timestamp" | "data">[], param: string, def?: Pick<ParameterDef, "type" | "enum_values">): ChartPoint[] {
  const out: ChartPoint[] = [];
  for (const r of rows) {
    const t = toMs(r.timestamp);
    if (!Number.isFinite(t)) continue;
    const raw = r.data?.[param] ?? null;
    out.push({ t, v: plotValue(raw, def), raw });
  }
  return out;
}

/**
 * Y domain from the data with padding. Nominal range bounds are pulled into the domain when they lie
 * reasonably close to the data, so the normal band is visible without flattening the signal.
 */
export function computeYDomain(
  values: readonly (number | null)[],
  def?: Pick<ParameterDef, "nominal_min" | "nominal_max" | "type" | "enum_values">,
): [number, number] {
  if (def?.type === "enum" && def.enum_values?.length) return [-0.5, def.enum_values.length - 0.5];
  const v = values.filter(isNum);
  let lo = v.length ? Math.min(...v) : NaN;
  let hi = v.length ? Math.max(...v) : NaN;
  const nmin = def?.nominal_min ?? null;
  const nmax = def?.nominal_max ?? null;
  if (!v.length) {
    if (isNum(nmin) && isNum(nmax)) return [nmin, nmax];
    return [0, 1];
  }
  const span = Math.max(hi - lo, Math.abs(hi) * 0.02, 1e-6);
  if (isNum(nmin) && nmin < lo && lo - nmin <= span * 1.5) lo = nmin;
  if (isNum(nmax) && nmax > hi && nmax - hi <= span * 1.5) hi = nmax;
  const pad = Math.max((hi - lo) * 0.08, 1e-6);
  return [lo - pad, hi + pad];
}

/** Compact numeric axis tick: 1234 → "1234", 12.34 → "12.3", 0.1234 → "0.12". */
export function valueTick(v: number): string {
  if (!Number.isFinite(v)) return "";
  const a = Math.abs(v);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

/** Tick label for a time axis given the visible span. */
export function timeTick(ms: number, spanMs: number): string {
  if (!Number.isFinite(ms)) return "";
  const s = fmtUtcTime(ms);
  return spanMs > 2 * 3_600_000 ? s.slice(0, 5) : s;
}

/** Anomalies whose onset falls inside [start, end] and which concern this parameter's subsystem or feature. */
export function markersFor(anomalies: readonly Anomaly[], start: number, end: number, def?: Pick<ParameterDef, "name" | "subsystem">): Anomaly[] {
  return anomalies.filter((a) => {
    const t = toMs(a.onset_time || a.timestamp);
    if (!(t >= start && t <= end)) return false;
    if (!def) return true;
    const sub = def.subsystem.toUpperCase();
    return a.subsystems.some((s) => s.toUpperCase() === sub) || a.top_features.some((f) => f.feature === def.name);
  });
}

/** Mean step between consecutive timestamps (ms), or null. */
export function medianStep(points: readonly { t: number }[]): number | null {
  if (points.length < 2) return null;
  const d: number[] = [];
  for (let i = 1; i < points.length; i++) d.push(points[i].t - points[i - 1].t);
  d.sort((a, b) => a - b);
  return d[Math.floor(d.length / 2)];
}
