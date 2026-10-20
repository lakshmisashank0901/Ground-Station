// Typed REST client for the Ground Station API (docs/API.md).
import { API_BASE } from "./config";
import { formatErrorDetail } from "./formatters";
import type {
  Anomaly,
  AnomalyDetail,
  AnomalyStatus,
  BackendHealth,
  CommandDef,
  CommandRecord,
  FaultSeverity,
  HealthHistoryItem,
  Inference,
  ModelInfo,
  ModelMetrics,
  ParameterDef,
  Report,
  ReportSummaryItem,
  SatelliteInfo,
  SatelliteStatus,
  Scenario,
  Severity,
  SimulationRun,
  SimulationRunDetail,
  SimulationStatus,
  SubsystemDetail,
  SubsystemHealth,
  SystemEvent,
  SystemStatus,
  TelemetryHistory,
  TelemetryPacket,
} from "./types";

// ---------------------------------------------------------------- operator identity (X-Operator)

const OPERATOR_KEY = "gs.operator";
const API_KEY_KEY = "gs.apiKey";
let operatorName = "operator";
let apiKey: string | null = null;

export function loadOperator(): string {
  try {
    const v = window.localStorage.getItem(OPERATOR_KEY);
    if (v) operatorName = v;
    apiKey = window.localStorage.getItem(API_KEY_KEY);
  } catch {
    /* storage unavailable */
  }
  return operatorName;
}

export function setOperator(name: string): void {
  operatorName = name.trim() || "operator";
  try {
    window.localStorage.setItem(OPERATOR_KEY, operatorName);
  } catch {
    /* ignore */
  }
}

export function getOperator(): string {
  return operatorName;
}

// ---------------------------------------------------------------- core request

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

export function buildUrl(path: string, query?: Query): string {
  const url = `${API_BASE}${path}`;
  if (!query) return url;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `${url}?${s}` : url;
}

interface RequestOpts {
  query?: Query;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function request<T>(method: string, path: string, opts: RequestOpts = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", "X-Operator": operatorName };
  if (apiKey) headers["X-API-Key"] = apiKey;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15_000);
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener("abort", onAbort);

  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal,
      cache: "no-store",
    });
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    throw new ApiError(0, ctrl.signal.aborted ? "Request timed out" : "Backend unreachable");
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }

  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    throw new ApiError(res.status, formatErrorDetail(parsed, `${res.status} ${res.statusText}`), parsed);
  }
  return parsed as T;
}

const get = <T>(path: string, query?: Query, signal?: AbortSignal) => request<T>("GET", path, { query, signal });
const post = <T>(path: string, body?: unknown) => request<T>("POST", path, { body: body ?? {} });

// ---------------------------------------------------------------- endpoints

export interface HistoryQuery {
  start?: string;
  end?: string;
  fields?: string[];
  run_id?: string | null;
  limit?: number;
  max_points?: number;
}

export interface AnomalyQuery {
  status?: AnomalyStatus | "";
  severity?: Severity | "";
  subsystem?: string;
  start?: string;
  end?: string;
  run_id?: string | null;
  limit?: number;
}

export const api = {
  // system
  health: (signal?: AbortSignal) => request<BackendHealth>("GET", "/health", { signal, timeoutMs: 4000 }),
  systemStatus: (signal?: AbortSignal) => get<SystemStatus>("/system/status", undefined, signal),
  systemEvents: (limit = 100, signal?: AbortSignal) => get<SystemEvent[]>("/system/events", { limit }, signal),

  // satellite / health
  satellite: () => get<SatelliteInfo>("/satellite"),
  satelliteStatus: (signal?: AbortSignal) => get<SatelliteStatus>("/satellite/status", undefined, signal),
  healthHistory: (q: { start?: string; end?: string; max_points?: number } = {}, signal?: AbortSignal) =>
    get<{ items: HealthHistoryItem[] }>("/health/history", q, signal),
  subsystems: () => get<SubsystemHealth[]>("/subsystems"),
  subsystem: (id: string, signal?: AbortSignal) => get<SubsystemDetail>(`/subsystems/${encodeURIComponent(id)}`, undefined, signal),

  // telemetry
  schema: () => get<ParameterDef[]>("/telemetry/schema"),
  latest: () => get<TelemetryPacket>("/telemetry/latest"),
  history: (q: HistoryQuery, signal?: AbortSignal) =>
    get<TelemetryHistory>(
      "/telemetry/history",
      { start: q.start, end: q.end, fields: q.fields?.join(","), run_id: q.run_id, limit: q.limit, max_points: q.max_points },
      signal,
    ),

  // anomalies
  anomalies: (q: AnomalyQuery = {}, signal?: AbortSignal) => get<Anomaly[]>("/anomalies", { ...q }, signal),
  anomaly: (id: string, signal?: AbortSignal) => get<AnomalyDetail>(`/anomalies/${encodeURIComponent(id)}`, undefined, signal),
  acknowledge: (id: string, note?: string) =>
    post<Anomaly>(`/anomalies/${encodeURIComponent(id)}/acknowledge`, { user: operatorName, ...(note ? { note } : {}) }),
  resolve: (id: string, note?: string) =>
    post<Anomaly>(`/anomalies/${encodeURIComponent(id)}/resolve`, { user: operatorName, ...(note ? { note } : {}) }),

  // models
  models: () => get<ModelInfo[]>("/models"),
  modelMetrics: () => get<ModelMetrics>("/models/metrics"),
  latestInference: () => get<Inference>("/models/inference/latest"),
  retrain: () => post<{ status: string }>("/models/retrain"),

  // simulation
  scenarios: () => get<Scenario[]>("/simulation/scenarios"),
  simStatus: (signal?: AbortSignal) => get<SimulationStatus>("/simulation/status", undefined, signal),
  simStart: (body: { speed?: number; run_name?: string } = {}) => post<SimulationStatus>("/simulation/start", body),
  simStop: () => post<SimulationStatus>("/simulation/stop"),
  simPause: () => post<SimulationStatus>("/simulation/pause"),
  simResume: () => post<SimulationStatus>("/simulation/resume"),
  simReset: () => post<SimulationStatus>("/simulation/reset"),
  simSpeed: (speed: number) => post<SimulationStatus>("/simulation/speed", { speed }),
  simScenario: (body: { scenario: string; severity?: FaultSeverity; start_delay_s?: number; duration_s?: number | null }) =>
    post<SimulationStatus>("/simulation/scenario", body),
  simOverride: (body: { parameter: string; value: number | null; duration_s?: number }) =>
    post<SimulationStatus>("/simulation/override", body),
  runs: () => get<SimulationRun[]>("/simulation/runs"),
  run: (id: string) => get<SimulationRunDetail>(`/simulation/runs/${encodeURIComponent(id)}`),

  // replay
  replayStart: (body: { run_id: string; start?: string; end?: string; speed?: number }) => post<SimulationStatus>("/replay/start", body),
  replayPause: () => post<SimulationStatus>("/replay/pause"),
  replayResume: () => post<SimulationStatus>("/replay/resume"),
  replayStop: () => post<SimulationStatus>("/replay/stop"),
  replayStep: (steps: number) => post<SimulationStatus>("/replay/step", { steps }),
  replaySeek: (timestamp: string) => post<SimulationStatus>("/replay/seek", { timestamp }),
  replaySpeed: (speed: number) => post<SimulationStatus>("/replay/speed", { speed }),

  // commands
  commandCatalog: () => get<CommandDef[]>("/commands/catalog"),
  sendCommand: (body: { command: string; target?: string; parameters?: Record<string, unknown> }) => post<CommandRecord>("/commands", body),
  confirmCommand: (id: string) => post<CommandRecord>(`/commands/${encodeURIComponent(id)}/confirm`),
  cancelCommand: (id: string) => post<CommandRecord>(`/commands/${encodeURIComponent(id)}/cancel`),
  commandHistory: (limit = 100) => get<CommandRecord[]>("/commands/history", { limit }),

  // reports
  reports: () => get<ReportSummaryItem[]>("/reports"),
  report: (id: string) => get<Report>(`/reports/${encodeURIComponent(id)}`),
  generateReport: (body: { title?: string; start?: string; end?: string; run_id?: string }) => post<Report>("/reports/generate", body),
};

// ---------------------------------------------------------------- download URLs (plain links)

export function telemetryExportUrl(q: { start?: string; end?: string; fields?: string[]; run_id?: string | null }): string {
  return buildUrl("/telemetry/export", { start: q.start, end: q.end, fields: q.fields?.join(","), run_id: q.run_id });
}

export function reportDownloadUrl(id: string, format: "html" | "json" | "csv"): string {
  return buildUrl(`/reports/${encodeURIComponent(id)}/download`, { format });
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.status ? `${e.status}: ${e.message}` : e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
