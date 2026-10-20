# Operator Guide & UI Screen Specification

Primary workflow: **identify mission state → inspect health → inspect telemetry → respond to alarms →
investigate the AI explanation → replay or report.**

## Persistent top bar
Satellite ID (SAT-01), connection (Connected / Degraded / Disconnected), mode (SIMULATION / REPLAY / REAL /
IDLE), live UTC mission time, last packet time and age, WebSocket status, backend status, active alarm
count, and operator name. Click the operator name to change it. It is stored in the browser and sent as
`X-Operator` with every action, so acknowledgements and commands are attributed in the audit log.

## Screens

| Route | What it shows / what you can do |
|---|---|
| `/dashboard` | Overall health score (0–100, status, trend), subsystem health cards (EPS, OBC, ADCS, COMM, Payload), current anomaly score, packet rate, last packet age, comm quality, clickable satellite schematic (node colour = status → opens subsystem), live charts, active alarm panel, AI health summary, recent event timeline. |
| `/telemetry` | Every parameter grouped as Electrical / Thermal / Computing / Attitude / Communication / Payload. Each chart shows current value, unit, nominal band, trend and timestamp. Windows: 10 s, 1 m, 5 m, 30 m, 1 h, custom. Live/Pause, hover inspection, anomaly markers, CSV export. |
| `/subsystems`, `/subsystems/[id]` | Subsystem health list; detail with parameter table (value, quality, ranges), charts and that subsystem's anomalies. |
| `/anomalies` | Anomaly center: filter by status/severity/subsystem. Each row shows severity, UTC time, subsystems, score, confidence, detector scores, top features, status, plus actions (view, acknowledge, resolve with optional note). |
| `/anomalies/[id]` | AI explanation: observed vs expected value, prediction error, Mahalanobis distance, detector scores, top contributing features, affected subsystems, severity, confidence, detection time and delay, plain-language explanation, context chart and score trace, and "Replay this event". |
| `/ai` | Model status/versions, evaluation metrics (precision, recall, F1, FPR, FNR, detection delay, per-scenario detection rate, inference latency), fusion weights, thresholds, live fused score with detector breakdown, retrain. |
| `/simulation` | Start/pause/resume/stop/reset, speed, scenario + severity + delay + duration injection, active faults, manual overrides. Replay section: choose a run and interval, play/pause/stop, speed, step ±1, seek on the timeline, anomaly markers that open the anomaly detail. |
| `/commands` | Catalogue-driven command form → confirmation dialog → confirm/cancel → result. Command history/audit table. Unknown or invalid commands are rejected (and logged). |
| `/reports` | Generate a mission health report for a run or time range; view summary, subsystem health, severity counts, detection delays, data availability/quality, key plots, event timeline, anomalies. Download HTML/JSON/CSV. |
| `/system` | Ground-station self-monitoring: backend, database, ML engine, WebSocket, simulator and telemetry tiles, and the system event log. |

## Alarm handling
1. A new alarm appears in the top-bar count, the dashboard alarm panel and the anomaly center (ACTIVE).
2. Open it to read the explanation and the evidence from each detector.
3. **Acknowledge** to show it is being handled (optional note). **Resolve** when closed out.
   Both actions are logged with your operator name. An event can still be ongoing (score above
   threshold) while acknowledged. `ended_at` shows when the score returned to normal.

## Demonstration script (spec §19)
1. `docker compose up --build` (or run backend and frontend locally, see README).
2. Open http://localhost:3000/dashboard. On `/system`, check that backend, database, ML engine and simulator
   are ONLINE/RUNNING.
3. Show normal telemetry and health. Then use `/telemetry` to inspect electrical, thermal, attitude and
   communication data.
4. Open `/ai` to show the loaded models and evaluation metrics.
5. On `/simulation`, set speed 10× and inject **OBC thermal anomaly** (moderate or severe).
6. On the dashboard/telemetry, OBC temperature rises while CPU load and power stay flat. The anomaly
   score rises through WARNING into HIGH/CRITICAL and an alarm appears.
7. Open the anomaly: compare observed and expected temperature, review the detector scores and the
   explanation, then acknowledge.
8. Click **Replay this event** (or use the replay section) to replay the run with synchronised markers.
9. On `/reports`, generate the mission health report for the run and download it.
10. Use docs/ARCHITECTURE.md to explain that the simulator feeds the same ingestion endpoint a future
    SAMRH gateway will use.

`OBC overload`, `multiple fault` and `transient spike` give faster, more dramatic demos.
`sensor drift` and `power degradation` show the multivariate and temporal detectors catching what
fixed thresholds miss.
