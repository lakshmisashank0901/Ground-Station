# Telemetry Schema & Simulation Scenario Specification

## 1. Telemetry schema

Source of truth: `backend/app/telemetry/schemas.py` (served at `GET /api/v1/telemetry/schema`).
Values outside the *nominal* band are flagged `SUSPECT`; outside the *hard limits* `OUT_OF_RANGE`.

| Parameter | Unit | Subsystem | Nominal | Hard limits |
|---|---|---|---|---|
| battery_voltage | V | EPS | 6.8–8.4 | 6.0–8.8 |
| battery_current | A | EPS | 0.0–4.0 | 0–6 |
| battery_temperature | °C | EPS | 10–45 | 0–60 |
| bus_voltage | V | EPS | 4.7–5.3 | 4.4–5.6 |
| bus_current | A | EPS | 0.2–5.0 | 0–6.5 |
| power_consumption | W | EPS | 1–30 | 0–36 |
| solar_input_power | W | EPS | 0–35 | 0–40 |
| battery_soc | % | EPS | 20–100 | 10–100 |
| obc_temperature | °C | OBC | 15–50 | 0–70 |
| cpu_load | % | OBC | 5–90 | 0–100 |
| memory_usage | % | OBC | 10–85 | 0–100 |
| watchdog_status | enum | OBC | OK | OK/FAULT |
| obc_uptime | s | OBC | – | ≥ 0 |
| roll / pitch | deg | ADCS | −10–10 | ±180 / ±90 |
| yaw | deg | ADCS | −45–45 | ±180 |
| gyro_x / gyro_y / gyro_z | deg/s | ADCS | −1.5–1.5 | ±10 |
| rssi | dBm | COMM | −90 to −50 | −110 to −30 |
| snr | dB | COMM | 3–20 | −5–30 |
| packet_loss | % | COMM | 0–3 | 0–100 |
| crc_errors | count | COMM | 0–2 | 0–100 |
| payload_temperature | °C | PAYLOAD | 5–40 | −10–60 |
| payload_power | W | PAYLOAD | 0–8 | 0–12 |
| payload_state | enum | PAYLOAD | IDLE/ACTIVE | IDLE/ACTIVE/SAFE |

The spec's example ranges (e.g. roll −180–180) are used as hard limits; tighter nominal bands for
attitude and link parameters make the range checks meaningful.

**Derived values** (sent in `derived` on every packet): `power_calc = bus_voltage × bus_current`,
`battery_temperature_rate`, `obc_temperature_rate` (°C/s), `sequence_gap`, `packet_loss_rate` (from
missing sequence numbers over the last 100 packets), and `freshness_s`.

**Data quality**: VALID, SUSPECT (outside nominal), STALE (timestamp older than `STALE_AFTER_S`, 10 s by
default), MISSING (absent/null), OUT_OF_RANGE (outside hard limits), CORRUPTED (NaN/inf, bad enum, or a
frame that fails sync/length/CRC). Packet quality is the worst field quality. Schema-invalid packets are
rejected with HTTP 422 and counted in `rejected_count`.

**Wire formats**: JSON (spec §6.2) on `POST /api/v1/telemetry`, and CRC-framed packets on
`POST /api/v1/telemetry/frame`: `b"SATF" | uint16 BE length | JSON payload | uint16 CRC-16/CCITT-FALSE`.

## 2. Spacecraft model (`backend/app/simulation/spacecraft.py`)

The simulator integrates one coherent state at 1 sample per simulated second. It does not draw
independent random numbers per parameter.

* **Orbit**: 5700 s period (≈95 min LEO), 36 % eclipse with 60 s penumbra ramps.
* **EPS**: solar array ≈30 W in sunlight, 0 W in eclipse. Bus load = base + CPU-dependent + payload + radio.
  Battery energy balance (35 Wh) drives SOC; terminal voltage follows SOC and charge/discharge power.
  Battery current is |net power| / V. Shunt regulation applies when full.
* **Thermal**: first-order relaxation. The battery tracks sun + I²R heating (τ 900 s). The OBC tracks
  sun + CPU load + power draw (τ 240 s). The payload tracks sun + payload power (τ 600 s).
* **OBC**: CPU load = base + payload activity + 300 s periodic component + AR(1) noise. Memory has a 900 s
  sawtooth.
* **Payload**: ACTIVE during the imaging window (orbit phase 0.15–0.30), SAFE when SOC < 25 %.
* **ADCS**: nadir pointing with AR(1) roll/pitch jitter. Gyro rates are the attitude derivatives plus
  noise; yaw follows a slow orbital oscillation.
* **COMM**: RSSI with a 30-minute pass-like variation; SNR = RSSI + 85 dB. Packet loss and the CRC-error
  rate (Poisson) rise exponentially as SNR falls.
* **Link effects** (live simulator only): packets are dropped with probability ½·packet_loss, creating real
  sequence gaps. During CRC-error bursts (≥4) a frame is occasionally sent with a corrupted CRC.
* Runs are seeded and reproducible. The seed is stored with each simulation run.

## 3. Fault scenarios (`backend/app/simulation/faults.py`)

Severity gain: mild ×0.5, moderate ×1.0, severe ×1.6. Each injection has a start delay and a duration
(scenario default if omitted). Effects ramp in deterministically from the fault's elapsed time.

| id | Injected behaviour | Default duration | Expected evidence |
|---|---|---|---|
| `obc_thermal` | +32 °C × gain to the OBC equilibrium temperature, ramped over 240 s; CPU and power unchanged | 600 s | LSTM + Mahalanobis (temperature inconsistent with load) |
| `power_degradation` | solar output −45 % × gain (ramp 90 s); bus voltage sags 0.22 V × gain while bus current rises 0.35 A × gain | 600 s | Mahalanobis + LSTM |
| `sensor_drift` | *reported* battery temperature +0.03 °C/s × gain and voltage +0.9 mV/s × gain; physical state unchanged | 900 s | temporal bias statistic + Mahalanobis |
| `comm_degradation` | RSSI −18 dB × gain (ramp 60 s); extra CRC errors and packet loss | 420 s | rule (SNR/RSSI) + LSTM trend |
| `obc_overload` | CPU +42 % × gain, memory +22 % × gain, bus current +0.45 A × gain (ramp 30 s); temperature follows physically; watchdog FAULT after 120 s at severe | 420 s | multivariate correlation |
| `multiple_fault` | `obc_thermal` + `comm_degradation` at once | 600 s | fusion |
| `transient_spike` | gyro kick (6/−4.5/2 deg/s × gain), attitude kick and bus-current spike, decaying with τ = 2 s | 6 s | rule + Mahalanobis |

Controls (`/simulation` page, `POST /api/v1/simulation/*`): start/pause/resume/stop/reset, speed
1×/2×/5×/10×, scenario + severity + delay + duration, and manual per-parameter overrides with optional expiry.
At N× speed the simulator emits N packets per wall-clock second, each covering 1 simulated second. Packet
timestamps follow the mission clock, so they run ahead of wall time while accelerated.

## 4. Replay

`POST /api/v1/replay/start {run_id, start?, end?, speed}` pauses the live simulator and streams the stored
run over the same WebSocket channels with `source: "REPLAY"`. It sends stored health/score history on
`/ws/health` and re-emits each anomaly (`event: "replay"`) when the cursor passes its detection time.
Pause/resume/step(±n)/seek/speed are supported. Stopping replay resumes the live simulator if it was
running before.
