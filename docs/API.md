# Ground Station API Contract (v1)

Base URL: `http://localhost:8000`. All REST endpoints are under `/api/v1`. All timestamps are
ISO-8601 UTC strings with a `Z` suffix (e.g. `2026-10-05T14:31:27.000Z`). All JSON keys are snake_case.

Optional auth: when the backend runs with `AUTH_ENABLED=true`, clients send `X-API-Key`. Keys map to
roles `viewer` (read-only) or `operator` (may ack/resolve, send commands, control simulation).
Clients may always send `X-Operator: <name>` to identify the operator (used in audit logs).

---------------------------------------------------------------------------------------------------
## 1. Shared enums

```
Source        = "SIMULATION" | "REPLAY" | "REAL"
Quality       = "VALID" | "SUSPECT" | "STALE" | "MISSING" | "OUT_OF_RANGE" | "CORRUPTED"
Severity      = "INFO" | "WARNING" | "HIGH" | "CRITICAL"          // anomaly events
HealthStatus  = "NOMINAL" | "WARNING" | "HIGH" | "CRITICAL" | "UNKNOWN"
AnomalyStatus = "ACTIVE" | "ACKNOWLEDGED" | "RESOLVED"
SubsystemId   = "eps" | "obc" | "adcs" | "comm" | "payload"
Mode          = "SIMULATION" | "REPLAY" | "REAL" | "IDLE"
FaultSeverity = "mild" | "moderate" | "severe"
```

Score → state mapping (anomaly score 0–1): `<0.30 NORMAL`, `0.30–0.60 WARNING`, `0.60–0.80 HIGH`,
`>=0.80 CRITICAL`. Health score is `0–100` (100 = perfect); health status uses the same bands applied to
`1 - health/100`.

---------------------------------------------------------------------------------------------------
## 2. Telemetry parameters

`GET /api/v1/telemetry/schema` → `ParameterDef[]`

```ts
interface ParameterDef {
  name: string;            // e.g. "battery_voltage"
  label: string;           // "Battery Voltage"
  unit: string;            // "V", "°C", "%", "deg", "deg/s", "dBm", "dB", "count", "W", "A", "s", ""
  subsystem: "EPS" | "OBC" | "ADCS" | "COMM" | "PAYLOAD";
  type: "float" | "int" | "enum";
  nominal_min: number | null;   // normal range (draw as reference band)
  nominal_max: number | null;
  limit_min: number | null;     // hard physical/software limits (red lines)
  limit_max: number | null;
  enum_values?: string[];       // for enums
  description: string;
}
```

Parameters (`data` keys):

| name | unit | subsystem | type |
|---|---|---|---|
| battery_voltage | V | EPS | float |
| battery_current | A | EPS | float |
| battery_temperature | °C | EPS | float |
| bus_voltage | V | EPS | float |
| bus_current | A | EPS | float |
| power_consumption | W | EPS | float |
| solar_input_power | W | EPS | float |
| battery_soc | % | EPS | float |
| obc_temperature | °C | OBC | float |
| cpu_load | % | OBC | float |
| memory_usage | % | OBC | float |
| watchdog_status | – | OBC | enum OK/FAULT |
| obc_uptime | s | OBC | int |
| roll | deg | ADCS | float |
| pitch | deg | ADCS | float |
| yaw | deg | ADCS | float |
| gyro_x | deg/s | ADCS | float |
| gyro_y | deg/s | ADCS | float |
| gyro_z | deg/s | ADCS | float |
| rssi | dBm | COMM | float |
| snr | dB | COMM | float |
| packet_loss | % | COMM | float |
| crc_errors | count | COMM | int |
| payload_temperature | °C | PAYLOAD | float |
| payload_power | W | PAYLOAD | float |
| payload_state | – | PAYLOAD | enum IDLE/ACTIVE/SAFE |

---------------------------------------------------------------------------------------------------
## 3. Telemetry

```ts
interface TelemetryPacket {
  type: "telemetry";
  satellite_id: string;           // "SAT-01"
  timestamp: string;
  sequence: number;
  source: Source;
  quality: Quality;               // packet-level quality (worst of field qualities, roughly)
  data: Record<string, number | string | null>;
  derived?: {
    power_calc: number;           // bus_voltage * bus_current
    battery_temperature_rate: number;   // °C/s
    obc_temperature_rate: number;       // °C/s
    sequence_gap: number;               // missing sequences before this packet
    packet_loss_rate: number;           // % over sliding window, from sequence numbers
    freshness_s: number;                // now - timestamp at ingestion
  };
  field_quality?: Record<string, Quality>;  // only fields that are not VALID
  run_id?: string | null;
}
```

- `POST /api/v1/telemetry/frame` raw body: `b"SATF" | uint16 len | JSON | uint16 CRC-16/CCITT` (gateway framing) → as above, bad CRC → `422` + counted as CORRUPTED.
- `POST /api/v1/telemetry` body: `{satellite_id, timestamp, sequence, source, data}` (same as packet;
  `type`/`quality`/`derived` optional and ignored). Returns `201 {accepted: true, sequence, quality}`.
  Schema-invalid packets → `422`. Packets are processed through the full pipeline (store → ML → WS).
- `GET /api/v1/telemetry/latest` → `TelemetryPacket` (404 if none yet).
- `GET /api/v1/telemetry/history?start=&end=&fields=a,b,c&run_id=&limit=5000&max_points=2000`
  → `{count: number, start: string|null, end: string|null, items: TelemetryRow[]}` ascending by time.
  `max_points` downsamples evenly (anomaly-relevant rows are never dropped from the DB, only from the
  response). Default window when no `start`: last 10 minutes.
  ```ts
  interface TelemetryRow { timestamp: string; sequence: number; source: Source; quality: Quality;
                           data: Record<string, number|string|null>; }
  ```
- `GET /api/v1/telemetry/export?start=&end=&fields=&run_id=` → `text/csv` download.

---------------------------------------------------------------------------------------------------
## 4. ML inference & health

```ts
interface FeatureContribution {
  feature: string; subsystem: string; unit: string;
  contribution: number;           // 0–1, share of the anomaly attributed to this feature
  observed: number; expected: number;    // expected = LSTM prediction (or training mean)
  prediction_error: number;       // observed - expected
  z_score: number;                // deviation in std units
}
interface Inference {
  timestamp: string;
  sequence: number;
  anomaly_score: number;          // fused 0–1
  severity: "NORMAL" | "WARNING" | "HIGH" | "CRITICAL";
  confidence: number;             // 0–1
  detectors: { rule: number; mahalanobis: number; isolation_forest: number | null; lstm: number | null };
  raw: { mahalanobis_distance: number; lstm_error: number | null; isolation_forest_raw: number | null };
  affected_subsystems: string[];  // ["OBC","EPS"]
  top_features: FeatureContribution[];  // up to 5
  model_version: string;
}
interface SubsystemHealth {
  id: SubsystemId; name: string;  // "EPS"
  status: HealthStatus; health_score: number;  // 0–100
  key_values: Record<string, number | string | null>;
  active_anomalies: number;
}
interface HealthUpdate {
  type: "health";
  timestamp: string;
  overall_score: number;          // 0–100
  status: HealthStatus;
  trend: "up" | "down" | "flat";
  anomaly_score: number;
  subsystems: SubsystemHealth[];
  inference: Inference | null;
}
```

- `GET /api/v1/satellite` → `{id:"SAT-01", name, mission, orbit:{altitude_km, inclination_deg, period_s}, subsystems: SubsystemId[], mode: Mode, created_at}`
- `GET /api/v1/satellite/status` → `HealthUpdate & { mode: Mode, connection: "CONNECTED"|"DEGRADED"|"DISCONNECTED", last_packet_time: string|null, last_packet_age_s: number|null, packet_rate: number, active_alarms: number, comm_quality: number /*0-100*/ }`
- `GET /api/v1/health/history?start=&end=&max_points=1000` → `{items: {timestamp, overall_score, anomaly_score, detectors:{rule,mahalanobis,isolation_forest,lstm}, subsystems: Record<SubsystemId, number>}[]}`
- `GET /api/v1/subsystems` → `SubsystemHealth[]`
- `GET /api/v1/subsystems/{id}` → `SubsystemHealth & { description: string, parameters: {name,label,unit,value,quality,nominal_min,nominal_max,limit_min,limit_max}[], anomalies: Anomaly[] /*recent 20*/ }`

---------------------------------------------------------------------------------------------------
## 5. Anomalies

```ts
interface Anomaly {
  id: string;
  timestamp: string;              // detection time
  onset_time: string;             // first sample above threshold
  ended_at: string | null;        // score fell back to normal (event cleared)
  subsystems: string[];           // ["OBC","EPS"]
  severity: Severity;
  score: number;                  // current/last fused score 0–1
  peak_score: number;
  confidence: number;
  detectors: { rule: number; mahalanobis: number; isolation_forest: number | null; lstm: number | null };
  top_features: FeatureContribution[];
  description: string;            // one line
  explanation: string;            // plain-language paragraph
  status: AnomalyStatus;
  detection_delay_s: number | null;   // vs injected fault start (simulation), null if unknown
  injected_fault: { scenario: string; severity: FaultSeverity; start_time: string } | null;
  acknowledged_by: string | null; acknowledged_at: string | null;
  resolved_by: string | null; resolved_at: string | null; note: string | null;
  run_id: string | null;
  sample_count: number;
  raw: { mahalanobis_distance: number|null; lstm_error: number|null; isolation_forest_raw: number|null };  // at peak
  model_version: string | null;
}
```

- `GET /api/v1/anomalies?status=&severity=&subsystem=&start=&end=&run_id=&limit=200` → `Anomaly[]` newest first
- `GET /api/v1/anomalies/{id}` → `Anomaly & { context: TelemetryRow[] /* ±120 s around event, top features + score */, score_trace: {timestamp, anomaly_score, rule, mahalanobis, isolation_forest, lstm}[] }`
- `POST /api/v1/anomalies/{id}/acknowledge` body `{user?: string, note?: string}` → `Anomaly`
- `POST /api/v1/anomalies/{id}/resolve` body `{user?: string, note?: string}` → `Anomaly`

---------------------------------------------------------------------------------------------------
## 6. Models

- `GET /api/v1/models` → `ModelInfo[]`
  ```ts
  interface ModelInfo { name: "rule"|"mahalanobis"|"isolation_forest"|"lstm"|"fusion"; version: string;
    status: "LOADED"|"TRAINING"|"NOT_TRAINED"|"DISABLED"|"ERROR"; backend: string;
    trained_at: string|null; training_dataset: string|null; feature_set: string[];
    thresholds: Record<string, number>; metrics: Record<string, number>; fusion_weight: number; }
  ```
- `GET /api/v1/models/metrics` → `{ evaluated_at: string|null, dataset: string|null,
    detectors: Record<string, {precision, recall, f1, false_positive_rate, false_negative_rate, mean_detection_delay_s}>,
    per_scenario: Record<string, {detection_rate: number, mean_detection_delay_s: number|null, runs: number}>,
    inference_latency_ms: {mean: number, p95: number},
    fusion: {weights: Record<string, number>, floor_gain: number}, thresholds: Record<string,number> }`
- `GET /api/v1/models/inference/latest` → `Inference` (404 if none)
- `POST /api/v1/models/retrain` → `202 {status:"TRAINING"}` (operator)

---------------------------------------------------------------------------------------------------
## 7. Simulation & replay

```ts
interface Scenario { id: string; name: string; description: string; expected_evidence: string; affected: string[] }
interface ActiveFault { id: string; scenario: string; severity: FaultSeverity; start_time: string;
                        duration_s: number | null; elapsed_s: number; status: "PENDING"|"ACTIVE"|"ENDED" }
interface SimulationStatus {
  mode: Mode; running: boolean; paused: boolean; speed: number;     // 1,2,5,10
  run_id: string | null; scenario: string;                          // "normal" or last injected
  sim_time: string | null; sequence: number; packets_sent: number;
  active_faults: ActiveFault[]; overrides: Record<string, number>;
  replay: ReplayStatus | null;
}
interface ReplayStatus { run_id: string; start: string; end: string; position: string; speed: number;
                         paused: boolean; finished: boolean; progress: number /*0-1*/ }
```

Scenario ids: `normal`, `obc_thermal`, `power_degradation`, `sensor_drift`, `comm_degradation`,
`obc_overload`, `multiple_fault`, `transient_spike`.

- `GET  /api/v1/simulation/scenarios` → `Scenario[]`
- `GET  /api/v1/simulation/status` → `SimulationStatus`
- `POST /api/v1/simulation/start` `{speed?: number, run_name?: string}` → `SimulationStatus` (also resumes)
- `POST /api/v1/simulation/stop` → `SimulationStatus` (ends the run)
- `POST /api/v1/simulation/pause` / `POST /api/v1/simulation/resume` → `SimulationStatus`
- `POST /api/v1/simulation/reset` → `SimulationStatus` (clears faults/overrides, new spacecraft state, stopped)
- `POST /api/v1/simulation/speed` `{speed: 1|2|5|10}` → `SimulationStatus`
- `POST /api/v1/simulation/scenario` `{scenario: string, severity?: FaultSeverity="moderate", start_delay_s?: number=0, duration_s?: number|null}` → `SimulationStatus`. `scenario:"normal"` clears all faults.
- `POST /api/v1/simulation/override` `{parameter: string, value: number|null, duration_s?: number}` → `SimulationStatus` (`value:null` removes override)
- `GET  /api/v1/simulation/runs` → `{id, name, scenario, start_time, end_time, speed, status, packet_count, anomaly_count}[]`
- `GET  /api/v1/simulation/runs/{id}` → run + `events: {timestamp, event_type, parameters}[]`
- `POST /api/v1/replay/start` `{run_id: string, start?: string, end?: string, speed?: number=1}` → `SimulationStatus` (live sim is paused; packets streamed on `/ws/telemetry` with `source:"REPLAY"`, health on `/ws/health`; stored anomalies re-emitted on `/ws/anomalies` with `event:"replay"` when the cursor passes them)
- `POST /api/v1/replay/pause` / `resume` / `stop` → `SimulationStatus`
- `POST /api/v1/replay/step` `{steps?: number=1}` → `SimulationStatus` (while paused; negative allowed)
- `POST /api/v1/replay/seek` `{timestamp: string}` → `SimulationStatus`
- `POST /api/v1/replay/speed` `{speed: number}` → `SimulationStatus`

---------------------------------------------------------------------------------------------------
## 8. Commands

```ts
interface CommandDef { command: string; description: string; parameters: {name, type, required, enum?: string[]}[]; requires_confirmation: true }
interface CommandRecord { id: string; timestamp: string; user: string; command: string; target: string;
  parameters: Record<string, any>; status: "PENDING_CONFIRMATION"|"EXECUTED"|"REJECTED"|"CANCELLED"|"FAILED";
  result: any; confirmed_at: string | null; }
```

Commands: `PING`, `REQUEST_STATUS`, `REQUEST_TELEMETRY` (params `count` 1–100), `REQUEST_HEALTH`,
`RESET_SIMULATOR`, `SET_SIMULATION_SCENARIO` (params `scenario`, `severity`).

- `GET  /api/v1/commands/catalog` → `CommandDef[]`
- `POST /api/v1/commands` `{command, target?: "SAT-01", parameters?: {}}` → `201 CommandRecord` with status `PENDING_CONFIRMATION`. Unknown command / invalid params → `422` (the rejection is still logged).
- `POST /api/v1/commands/{id}/confirm` → `CommandRecord` (EXECUTED/FAILED with `result`)
- `POST /api/v1/commands/{id}/cancel` → `CommandRecord`
- `GET  /api/v1/commands/history?limit=100` → `CommandRecord[]` newest first

---------------------------------------------------------------------------------------------------
## 9. Reports

```ts
interface Report {
  id: string; title: string; created_at: string; mission_id: string; run_id: string | null;
  start: string; end: string; model_version: string;
  summary: {
    overall_health: {mean: number, min: number, final: number};
    subsystem_health: Record<SubsystemId, {mean: number, min: number}>;
    anomaly_count: number; severity_counts: Record<Severity, number>;
    most_affected_subsystem: string | null; max_anomaly_score: number;
    detection_delay_s: {mean: number|null, min: number|null, max: number|null, count: number};
    telemetry: {packets: number, expected: number, availability_pct: number, valid_pct: number,
                quality_counts: Record<Quality, number>};
  };
  plots: { health: {timestamp, overall_score, anomaly_score}[];       // ≤ 300 points each
           telemetry: Record<string, {timestamp, value}[]> };         // key params
  timeline: {timestamp: string, kind: "anomaly"|"command"|"simulation"|"system", severity?: string, text: string, ref_id?: string}[];
  anomalies: Anomaly[];
}
```

- `GET  /api/v1/reports` → `{id, title, created_at, start, end, anomaly_count, run_id}[]`
- `POST /api/v1/reports/generate` `{title?, start?, end?, run_id?}` (default: last 1 h) → `201 Report`
- `GET  /api/v1/reports/{id}` → `Report`
- `GET  /api/v1/reports/{id}/download?format=html|json|csv` → file

---------------------------------------------------------------------------------------------------
## 10. System

```ts
interface SystemStatus {
  type: "system"; timestamp: string;
  backend:   { status: "ONLINE"; version: string; uptime_s: number; latency_ms: number };
  database:  { status: "ONLINE"|"OFFLINE"; engine: string; latency_ms: number|null };
  ml:        { status: "ONLINE"|"TRAINING"|"DEGRADED"|"OFFLINE"; models_loaded: string[]; inference_latency_ms: number|null; model_version: string };
  websocket: { status: "ONLINE"; clients: number; message_rate: number };
  simulator: { status: "RUNNING"|"PAUSED"|"STOPPED"|"REPLAY"; scenario: string; speed: number; mode: Mode };
  telemetry: { status: "LIVE"|"STALE"|"NO_DATA"; packet_rate: number; stale_age_s: number|null;
               received_count: number; rejected_count: number; last_packet_time: string|null };
}
```

- `GET /api/v1/health` → `{status:"ok", version, time}`
- `GET /api/v1/system/status` → `SystemStatus`
- `GET /api/v1/system/events?limit=100` → `{timestamp, level, component, message}[]`

---------------------------------------------------------------------------------------------------
## 11. WebSockets

Base: `ws://localhost:8000`. Server sends JSON text frames; the client never needs to send anything
(server ignores client messages; `"ping"` text is answered with `{"type":"pong"}`).

| Channel | Frames |
|---|---|
| `/ws/telemetry` | `TelemetryPacket` |
| `/ws/health` | `HealthUpdate` |
| `/ws/anomalies` | `{type:"anomaly", event:"created"\|"updated"\|"acknowledged"\|"resolved"\|"replay", anomaly: Anomaly}` |
| `/ws/system` | `SystemStatus` (every 2 s) and `{type:"simulation", status: SimulationStatus}` on every simulation state change |

On connect, each channel immediately sends its latest snapshot if available.
