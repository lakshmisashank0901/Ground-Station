// Pure formatting / classification helpers. No React, no DOM – unit tested in tests/formatters.test.ts.
import type { HealthStatus, InferenceSeverity, Severity, TelemetryValue } from "./types";

export const DASH = "—";

// ---------------------------------------------------------------- numbers

export function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Format a number with a sensible number of decimals for its magnitude. */
export function fmtNum(v: TelemetryValue | undefined, digits?: number): string {
  if (v === null || v === undefined) return DASH;
  if (typeof v === "string") return v;
  if (!Number.isFinite(v)) return DASH;
  if (digits !== undefined) return v.toFixed(digits);
  const a = Math.abs(v);
  if (Number.isInteger(v) && a < 1e6) return String(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 100) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

/** Value + unit, e.g. "7.42 V". Enum/strings are returned as is. */
export function fmtValue(v: TelemetryValue | undefined, unit?: string, digits?: number): string {
  const s = fmtNum(v, digits);
  if (s === DASH || typeof v === "string" || !unit || unit === "–" || unit === "-") return s;
  if (unit === "%") return `${s}%`;
  return `${s} ${unit}`;
}

/** 0–1 → "87%" */
export function fmtPct01(v: number | null | undefined, digits = 0): string {
  if (!isNum(v)) return DASH;
  return `${(v * 100).toFixed(digits)}%`;
}

/** 0–1 score → "0.734" */
export function fmtScore(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  return v.toFixed(3);
}

export function fmtMs(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  return v < 10 ? `${v.toFixed(2)} ms` : `${v.toFixed(1)} ms`;
}

// ---------------------------------------------------------------- time

export type TimeInput = string | number | Date | null | undefined;

/** Parse an ISO timestamp / epoch ms / Date to epoch ms; NaN when invalid. */
export function toMs(t: TimeInput): number {
  if (t === null || t === undefined) return NaN;
  if (typeof t === "number") return t;
  if (t instanceof Date) return t.getTime();
  return Date.parse(t);
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

/** "14:31:27" (UTC). With ms → "14:31:27.123". */
export function fmtUtcTime(t: TimeInput, withMs = false): string {
  const ms = toMs(t);
  if (!Number.isFinite(ms)) return DASH;
  const d = new Date(ms);
  const base = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return withMs ? `${base}.${pad(d.getUTCMilliseconds(), 3)}` : base;
}

/** "2026-10-05" (UTC) */
export function fmtUtcDate(t: TimeInput): string {
  const ms = toMs(t);
  if (!Number.isFinite(ms)) return DASH;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** "2026-10-05 14:31:27Z" */
export function fmtUtc(t: TimeInput, withMs = false): string {
  const ms = toMs(t);
  if (!Number.isFinite(ms)) return DASH;
  return `${fmtUtcDate(ms)} ${fmtUtcTime(ms, withMs)}Z`;
}

/** Day-of-year mission clock, e.g. "2026-278 14:31:27". */
export function fmtDoy(t: TimeInput): string {
  const ms = toMs(t);
  if (!Number.isFinite(ms)) return DASH;
  const d = new Date(ms);
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  const doy = Math.floor((ms - start) / 86_400_000) + 1;
  return `${d.getUTCFullYear()}-${pad(doy, 3)} ${fmtUtcTime(ms)}`;
}

/** Age in seconds → "0.8s", "12s", "3m 04s", "2h 05m", "3d 04h". */
export function fmtAge(seconds: number | null | undefined): string {
  if (!isNum(seconds)) return DASH;
  const s = Math.max(0, seconds);
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad(Math.floor(s % 60))}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`;
  return `${Math.floor(s / 86400)}d ${pad(Math.floor((s % 86400) / 3600))}h`;
}

/** Duration in seconds → "3d 04:05:06" / "04:05:06". */
export function fmtDuration(seconds: number | null | undefined): string {
  if (!isNum(seconds)) return DASH;
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const hms = `${pad(Math.floor((s % 86400) / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  return d > 0 ? `${d}d ${hms}` : hms;
}

/** epoch ms → value for <input type="datetime-local"> interpreted as UTC ("2026-10-05T14:31:27"). */
export function toUtcInputValue(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toISOString().slice(0, 19);
}

/** <input type="datetime-local"> value (treated as UTC) → ISO string with Z, or null. */
export function fromUtcInputValue(v: string): string | null {
  if (!v) return null;
  const withSecs = v.length === 16 ? `${v}:00` : v;
  const ms = Date.parse(`${withSecs}Z`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// ---------------------------------------------------------------- status classification

/** Contract §1: anomaly score 0–1 → state. */
export function scoreToState(score: number | null | undefined): InferenceSeverity {
  if (!isNum(score)) return "NORMAL";
  if (score >= 0.8) return "CRITICAL";
  if (score >= 0.6) return "HIGH";
  if (score >= 0.3) return "WARNING";
  return "NORMAL";
}

/** Contract §1: health 0–100 → status, using the score bands on 1 - health/100. */
export function healthToStatus(health: number | null | undefined): HealthStatus {
  if (!isNum(health)) return "UNKNOWN";
  const st = scoreToState(1 - health / 100);
  return st === "NORMAL" ? "NOMINAL" : st;
}

export type Tone = "nominal" | "info" | "warning" | "high" | "critical" | "unknown" | "offline" | "accent";

/** Map any status-like string from the contract to a UI tone. */
export function statusTone(status: string | null | undefined): Tone {
  switch ((status ?? "").toUpperCase()) {
    case "NOMINAL":
    case "NORMAL":
    case "ONLINE":
    case "CONNECTED":
    case "LIVE":
    case "LOADED":
    case "VALID":
    case "OK":
    case "RUNNING":
    case "EXECUTED":
    case "RESOLVED":
    case "OPEN":
      return "nominal";
    case "INFO":
    case "REPLAY":
    case "ACKNOWLEDGED":
    case "TRAINING":
    case "PENDING":
    case "PENDING_CONFIRMATION":
    case "CONNECTING":
      return "info";
    case "WARNING":
    case "DEGRADED":
    case "STALE":
    case "SUSPECT":
    case "PAUSED":
    case "NOT_TRAINED":
    case "CANCELLED":
    case "MISSING":
      return "warning";
    case "HIGH":
    case "OUT_OF_RANGE":
    case "REJECTED":
      return "high";
    case "CRITICAL":
    case "ERROR":
    case "FAULT":
    case "FAILED":
    case "CORRUPTED":
    case "ACTIVE":
      return "critical";
    case "OFFLINE":
    case "DISCONNECTED":
    case "CLOSED":
    case "STOPPED":
    case "NO_DATA":
    case "DISABLED":
      return "offline";
    default:
      return "unknown";
  }
}

export const TONE_COLORS: Record<Tone, string> = {
  nominal: "#22c55e",
  info: "#60a5fa",
  warning: "#f5b014",
  high: "#f97316",
  critical: "#ef4444",
  unknown: "#64748b",
  offline: "#64748b",
  accent: "#38bdf8",
};

export function toneColor(status: string | null | undefined): string {
  return TONE_COLORS[statusTone(status)];
}

/** Colour for an anomaly score 0–1 by its band. */
export function scoreColor(score: number | null | undefined): string {
  return toneColor(scoreToState(score));
}

/** Colour for a 0–100 health score by its band. */
export function healthColor(health: number | null | undefined): string {
  return toneColor(healthToStatus(health));
}

const SEVERITY_RANK: Record<string, number> = { NORMAL: 0, NOMINAL: 0, INFO: 1, WARNING: 2, HIGH: 3, CRITICAL: 4 };

export function severityRank(sev: Severity | InferenceSeverity | HealthStatus | string): number {
  return SEVERITY_RANK[sev?.toUpperCase?.() ?? ""] ?? 0;
}

export function worstSeverity<T extends string>(list: T[]): T | null {
  let worst: T | null = null;
  for (const s of list) if (worst === null || severityRank(s) > severityRank(worst)) worst = s;
  return worst;
}

// ---------------------------------------------------------------- telemetry helpers

/** Trend over a numeric series: compares mean of last quarter vs previous quarter against a fraction of the series span. */
export function trendOf(values: number[], spanFrac = 0.1): "up" | "down" | "flat" {
  const v = values.filter(isNum);
  if (v.length < 4) return "flat";
  const q = Math.max(1, Math.floor(v.length / 4));
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  const recent = mean(v.slice(-q));
  const prior = mean(v.slice(-2 * q, -q));
  const span = Math.max(...v) - Math.min(...v);
  const tol = Math.max(span * spanFrac, 1e-9);
  if (recent - prior > tol) return "up";
  if (prior - recent > tol) return "down";
  return "flat";
}

export function trendArrow(t: "up" | "down" | "flat"): string {
  return t === "up" ? "▲" : t === "down" ? "▼" : "▶";
}

/** Range check for a value against nominal and hard limits. */
export function rangeState(
  v: TelemetryValue | undefined,
  def: { nominal_min: number | null; nominal_max: number | null; limit_min: number | null; limit_max: number | null } | undefined,
): "nominal" | "warning" | "critical" | "unknown" {
  if (!def || !isNum(v)) return "unknown";
  if ((def.limit_min !== null && v < def.limit_min) || (def.limit_max !== null && v > def.limit_max)) return "critical";
  if ((def.nominal_min !== null && v < def.nominal_min) || (def.nominal_max !== null && v > def.nominal_max)) return "warning";
  return "nominal";
}

export function fmtRange(min: number | null | undefined, max: number | null | undefined): string {
  const hasMin = isNum(min);
  const hasMax = isNum(max);
  if (!hasMin && !hasMax) return DASH;
  return `${hasMin ? fmtNum(min) : "−∞"} … ${hasMax ? fmtNum(max) : "+∞"}`;
}

/** Title-case a snake_case id: "obc_thermal" → "Obc Thermal". */
export function humanize(id: string | null | undefined): string {
  if (!id) return DASH;
  return id
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

export const DETECTOR_LABELS: Record<string, string> = {
  rule: "Rule",
  mahalanobis: "Mahalanobis",
  isolation_forest: "Isolation Forest",
  lstm: "LSTM",
  fusion: "Fusion",
};

/** Categorical colours for detectors (validated for CVD separation on the dark surface). */
export const DETECTOR_COLORS: Record<string, string> = {
  rule: "#3987e5",
  mahalanobis: "#d55181",
  isolation_forest: "#9085e9",
  lstm: "#199e70",
};

/** Turn a FastAPI error body into a readable message. */
export function formatErrorDetail(body: unknown, fallback = "Request failed"): string {
  if (body === null || body === undefined) return fallback;
  if (typeof body === "string") return body || fallback;
  if (typeof body === "object") {
    const detail = (body as { detail?: unknown }).detail ?? (body as { message?: unknown }).message;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      return detail
        .map((d) => {
          if (d && typeof d === "object") {
            const loc = Array.isArray((d as { loc?: unknown }).loc) ? (d as { loc: unknown[] }).loc.filter((x) => x !== "body").join(".") : "";
            const msg = String((d as { msg?: unknown }).msg ?? JSON.stringify(d));
            return loc ? `${loc}: ${msg}` : msg;
          }
          return String(d);
        })
        .join("; ");
    }
    if (detail && typeof detail === "object") return JSON.stringify(detail);
  }
  return fallback;
}
