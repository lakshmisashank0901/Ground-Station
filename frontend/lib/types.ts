// Mirrors docs/API.md (Ground Station API Contract v1). Keep in sync with the backend.

// ---------------------------------------------------------------- 1. Shared enums
export type Source = "SIMULATION" | "REPLAY" | "REAL";
export type Quality = "VALID" | "SUSPECT" | "STALE" | "MISSING" | "OUT_OF_RANGE" | "CORRUPTED";
export type Severity = "INFO" | "WARNING" | "HIGH" | "CRITICAL";
export type HealthStatus = "NOMINAL" | "WARNING" | "HIGH" | "CRITICAL" | "UNKNOWN";
export type AnomalyStatus = "ACTIVE" | "ACKNOWLEDGED" | "RESOLVED";
export type SubsystemId = "eps" | "obc" | "adcs" | "comm" | "payload";
export type Mode = "SIMULATION" | "REPLAY" | "REAL" | "IDLE";
export type FaultSeverity = "mild" | "moderate" | "severe";
export type InferenceSeverity = "NORMAL" | "WARNING" | "HIGH" | "CRITICAL";
export type SubsystemName = "EPS" | "OBC" | "ADCS" | "COMM" | "PAYLOAD";
export type ConnectionState = "CONNECTED" | "DEGRADED" | "DISCONNECTED";

export type TelemetryValue = number | string | null;

// ---------------------------------------------------------------- 2. Telemetry parameters
export interface ParameterDef {
  name: string;
  label: string;
  unit: string;
  subsystem: SubsystemName;
  type: "float" | "int" | "enum";
  nominal_min: number | null;
  nominal_max: number | null;
  limit_min: number | null;
  limit_max: number | null;
  enum_values?: string[];
  description: string;
}

// ---------------------------------------------------------------- 3. Telemetry
export interface DerivedTelemetry {
  power_calc: number;
  battery_temperature_rate: number;
  obc_temperature_rate: number;
  sequence_gap: number;
  packet_loss_rate: number;
  freshness_s: number;
}

export interface TelemetryPacket {
  type: "telemetry";
  satellite_id: string;
  timestamp: string;
  sequence: number;
  source: Source;
  quality: Quality;
  data: Record<string, TelemetryValue>;
  derived?: DerivedTelemetry;
  field_quality?: Record<string, Quality>;
  run_id?: string | null;
}

export interface TelemetryRow {
  timestamp: string;
  sequence: number;
  source: Source;
  quality: Quality;
  data: Record<string, TelemetryValue>;
}

export interface TelemetryHistory {
  count: number;
  start: string | null;
  end: string | null;
  items: TelemetryRow[];
}

// ---------------------------------------------------------------- 4. ML inference & health
export interface FeatureContribution {
  feature: string;
  subsystem: string;
  unit: string;
  contribution: number;
  observed: number;
  expected: number;
  prediction_error: number;
  z_score: number;
}

export interface DetectorScores {
  rule: number;
  mahalanobis: number;
  isolation_forest: number | null;
  lstm: number | null;
}

export interface Inference {
  timestamp: string;
  sequence: number;
  anomaly_score: number;
  severity: InferenceSeverity;
  confidence: number;
  detectors: DetectorScores;
  raw: { mahalanobis_distance: number; lstm_error: number | null; isolation_forest_raw: number | null };
  affected_subsystems: string[];
  top_features: FeatureContribution[];
  model_version: string;
}

export interface SubsystemHealth {
  id: SubsystemId;
  name: string;
  status: HealthStatus;
  health_score: number;
  key_values: Record<string, TelemetryValue>;
  active_anomalies: number;
}

export interface HealthUpdate {
  type: "health";
  timestamp: string;
  overall_score: number;
  status: HealthStatus;
  trend: "up" | "down" | "flat";
  anomaly_score: number;
  subsystems: SubsystemHealth[];
  inference: Inference | null;
}

export interface SatelliteInfo {
  id: string;
  name: string;
  mission: string;
  orbit: { altitude_km: number; inclination_deg: number; period_s: number };
  subsystems: SubsystemId[];
  mode: Mode;
  created_at: string;
}

export type SatelliteStatus = HealthUpdate & {
  mode: Mode;
  connection: ConnectionState;
  last_packet_time: string | null;
  last_packet_age_s: number | null;
  packet_rate: number;
  active_alarms: number;
  comm_quality: number;
};

export interface HealthHistoryItem {
  timestamp: string;
  overall_score: number;
  anomaly_score: number;
  detectors: DetectorScores;
  subsystems: Partial<Record<SubsystemId, number>>;
}

export interface SubsystemParameter {
  name: string;
  label: string;
  unit: string;
  value: TelemetryValue;
  quality: Quality;
  nominal_min: number | null;
  nominal_max: number | null;
  limit_min: number | null;
  limit_max: number | null;
}

export type SubsystemDetail = SubsystemHealth & {
  description: string;
  parameters: SubsystemParameter[];
  anomalies: Anomaly[];
};

// ---------------------------------------------------------------- 5. Anomalies
export interface Anomaly {
  id: string;
  timestamp: string;
  onset_time: string;
  ended_at: string | null;
  subsystems: string[];
  severity: Severity;
  score: number;
  peak_score: number;
  confidence: number;
  detectors: DetectorScores;
  top_features: FeatureContribution[];
  description: string;
  explanation: string;
  status: AnomalyStatus;
  detection_delay_s: number | null;
  injected_fault: { scenario: string; severity: FaultSeverity; start_time: string } | null;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  note: string | null;
  run_id: string | null;
  sample_count: number;
  raw?: { mahalanobis_distance: number | null; lstm_error: number | null; isolation_forest_raw: number | null };
  model_version?: string | null;
}

export interface ScoreTracePoint {
  timestamp: string;
  anomaly_score: number;
  rule: number;
  mahalanobis: number;
  isolation_forest: number | null;
  lstm: number | null;
}

export type AnomalyDetail = Anomaly & {
  context: TelemetryRow[];
  score_trace: ScoreTracePoint[];
};

export type AnomalyEvent = "created" | "updated" | "acknowledged" | "resolved" | "replay";

export interface AnomalyMessage {
  type: "anomaly";
  event: AnomalyEvent;
  anomaly: Anomaly;
}

// ---------------------------------------------------------------- 6. Models
export type ModelName = "rule" | "mahalanobis" | "isolation_forest" | "lstm" | "fusion";

export interface ModelInfo {
  name: ModelName;
  version: string;
  status: "LOADED" | "TRAINING" | "NOT_TRAINED" | "DISABLED" | "ERROR";
  backend: string;
  trained_at: string | null;
  training_dataset: string | null;
  feature_set: string[];
  thresholds: Record<string, number>;
  metrics: Record<string, number>;
  fusion_weight: number;
}

export interface DetectorMetrics {
  precision: number;
  recall: number;
  f1: number;
  false_positive_rate: number;
  false_negative_rate: number;
  mean_detection_delay_s: number;
}

export interface ModelMetrics {
  evaluated_at: string | null;
  dataset: string | null;
  detectors: Record<string, DetectorMetrics>;
  per_scenario: Record<string, { detection_rate: number; mean_detection_delay_s: number | null; runs: number }>;
  inference_latency_ms: { mean: number; p95: number };
  fusion: { weights: Record<string, number>; floor_gain: number };
  thresholds: Record<string, number>;
}

// ---------------------------------------------------------------- 7. Simulation & replay
export interface Scenario {
  id: string;
  name: string;
  description: string;
  expected_evidence: string;
  affected: string[];
}

export interface ActiveFault {
  id: string;
  scenario: string;
  severity: FaultSeverity;
  start_time: string;
  duration_s: number | null;
  elapsed_s: number;
  status: "PENDING" | "ACTIVE" | "ENDED";
}

export interface ReplayStatus {
  run_id: string;
  start: string;
  end: string;
  position: string;
  speed: number;
  paused: boolean;
  finished: boolean;
  progress: number;
}

export interface SimulationStatus {
  mode: Mode;
  running: boolean;
  paused: boolean;
  speed: number;
  run_id: string | null;
  scenario: string;
  sim_time: string | null;
  sequence: number;
  packets_sent: number;
  active_faults: ActiveFault[];
  overrides: Record<string, number>;
  replay: ReplayStatus | null;
}

export interface SimulationRun {
  id: string;
  name: string;
  scenario: string;
  start_time: string;
  end_time: string | null;
  speed: number;
  status: string;
  packet_count: number;
  anomaly_count: number;
}

export type SimulationRunDetail = SimulationRun & {
  events: { timestamp: string; event_type: string; parameters: Record<string, unknown> }[];
};

export interface SimulationMessage {
  type: "simulation";
  status: SimulationStatus;
}

// ---------------------------------------------------------------- 8. Commands
export interface CommandParamDef {
  name: string;
  type: string;
  required: boolean;
  enum?: string[];
  min?: number; // not in the contract; some backends include numeric bounds
  max?: number;
}

export interface CommandDef {
  command: string;
  description: string;
  parameters: CommandParamDef[];
  requires_confirmation: true;
}

export type CommandStatus = "PENDING_CONFIRMATION" | "EXECUTED" | "REJECTED" | "CANCELLED" | "FAILED";

export interface CommandRecord {
  id: string;
  timestamp: string;
  user: string;
  command: string;
  target: string;
  parameters: Record<string, unknown>;
  status: CommandStatus;
  result: unknown;
  confirmed_at: string | null;
}

// ---------------------------------------------------------------- 9. Reports
export interface ReportTimelineItem {
  timestamp: string;
  kind: "anomaly" | "command" | "simulation" | "system";
  severity?: string;
  text: string;
  ref_id?: string;
}

export interface Report {
  id: string;
  title: string;
  created_at: string;
  mission_id: string;
  run_id: string | null;
  start: string;
  end: string;
  model_version: string;
  summary: {
    overall_health: { mean: number; min: number; final: number };
    subsystem_health: Partial<Record<SubsystemId, { mean: number; min: number }>>;
    anomaly_count: number;
    severity_counts: Partial<Record<Severity, number>>;
    most_affected_subsystem: string | null;
    max_anomaly_score: number;
    detection_delay_s: { mean: number | null; min: number | null; max: number | null; count: number };
    telemetry: {
      packets: number;
      expected: number;
      availability_pct: number;
      valid_pct: number;
      quality_counts: Partial<Record<Quality, number>>;
    };
  };
  plots: {
    health: { timestamp: string; overall_score: number; anomaly_score: number }[];
    telemetry: Record<string, { timestamp: string; value: number | null }[]>;
  };
  timeline: ReportTimelineItem[];
  anomalies: Anomaly[];
}

export interface ReportSummaryItem {
  id: string;
  title: string;
  created_at: string;
  start: string;
  end: string;
  anomaly_count: number;
  run_id: string | null;
}

// ---------------------------------------------------------------- 10. System
export interface SystemStatus {
  type: "system";
  timestamp: string;
  backend: { status: "ONLINE"; version: string; uptime_s: number; latency_ms: number };
  database: { status: "ONLINE" | "OFFLINE"; engine: string; latency_ms: number | null };
  ml: {
    status: "ONLINE" | "TRAINING" | "DEGRADED" | "OFFLINE";
    models_loaded: string[];
    inference_latency_ms: number | null;
    model_version: string;
  };
  websocket: { status: "ONLINE"; clients: number; message_rate: number };
  simulator: { status: "RUNNING" | "PAUSED" | "STOPPED" | "REPLAY"; scenario: string; speed: number; mode: Mode };
  telemetry: {
    status: "LIVE" | "STALE" | "NO_DATA";
    packet_rate: number;
    stale_age_s: number | null;
    received_count: number;
    rejected_count: number;
    last_packet_time: string | null;
  };
}

export interface SystemEvent {
  timestamp: string;
  level: string;
  component: string;
  message: string;
}

export interface BackendHealth {
  status: "ok";
  version: string;
  time: string;
}
