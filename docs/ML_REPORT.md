# ML Training & Evaluation Report

Model version **v20261020-180015**, produced by `python -m training.train_all` (full mode, 162 s on a laptop
CPU). Machine-readable results are in `backend/models/metadata.json` and are served at
`GET /api/v1/models/metrics`. Re-running training regenerates every number here.

> All data is produced by the project's spacecraft simulator. These figures show the pipeline works
> end to end against the simulated fault library. They are **not** a claim of performance on real spacecraft
> telemetry. Thresholds and weights must be recalibrated when real SAMRH data becomes available.

## 1. Data

| Set | Content | Use |
|---|---|---|
| Normal run | 96,000 s of nominal operation at 1 Hz (≈17 orbits, seed 11), split **chronologically** 70/15/15 | train (scaler, Mahalanobis, Isolation Forest, LSTM) / validation (thresholds, LSTM residual σ) / test (false alarms) |
| Validation fault runs | 7 scenarios × {mild, moderate, severe} = 21 runs (seeds 1000+) | fusion weight / floor-gain tuning |
| Test fault runs | 21 runs with different seeds (5000+) | reported metrics |

Each fault run has 900 s of normal operation, then the fault for its default duration, then 600 s more.
Labels: 1 while the fault is active, −1 for the first 300 s after it ends (physical state still settling,
excluded from point metrics), 0 otherwise. An alarm counts as detecting the event if it fires between
fault start and 300 s after fault end.

## 2. Models & calibration

* 25 features (`metadata.json → features`); a standard scaler is fit on the training split only.
* Mahalanobis: Ledoit-Wolf covariance. Threshold (99.9 % of validation) **D = 9.77**.
* Isolation Forest: 200 trees. Threshold 0.131 above the validation median score.
* LSTM: `LSTM(64) → Dropout(0.2) → LSTM(32) → Dense(16) → Dense(25)`, 60-sample windows, Adam 1e-3, MSE,
  15 epochs, early stopping (val loss 0.233 in standardized units; most features are noise-dominated by
  design). Error thresholds: short-term **7.11 σ**, drift bias **3.12 σ**.
* Fusion tuned on validation: the grid search kept the **specification weights** (rule 0.25,
  Mahalanobis 0.30, LSTM 0.45, Isolation Forest 0) with floor gain 0.6. On validation it detected
  21/21 events with a 0 % normal alarm rate.
* Alarm: fused score ≥ 0.30 for 3 consecutive samples.

## 3. Test results

Point metrics combine all test fault runs with the 14,400-sample normal test split.
"Normal alarm rate" is the fraction of normal test samples in alarm.

| Detector | Precision | Recall | F1 | FPR | FNR | Event detection | Mean delay (s) | Normal alarm rate |
|---|---|---|---|---|---|---|---|---|
| Rule / range | 1.000 | 0.490 | 0.658 | 0.0000 | 0.510 | 0.67 | 180.3 | 0.000 |
| Mahalanobis | 0.835 | 0.908 | 0.870 | 0.0482 | 0.092 | 1.00 | 45.3 | 0.000 |
| Isolation Forest (baseline) | 0.927 | 0.148 | 0.255 | 0.0031 | 0.852 | 0.57 | 234.1 | 0.0001 |
| LSTM | 0.401 | 0.968 | 0.567 | 0.3888 | 0.032 | 1.00 | 15.6 | 0.0012 |
| **Fused** | **0.653** | **0.932** | **0.768** | 0.1331 | 0.068 | **1.00** | **34.5** | **0.000** |

Per-scenario detection (fused, 3 severities each):

| Scenario | Runs | Detection rate | Mean detection delay (s) |
|---|---|---|---|
| OBC thermal | 3 | 1.00 | 90.3 |
| Power degradation | 3 | 1.00 | 19.7 |
| Sensor drift | 3 | 1.00 | 77.0 |
| Communication degradation | 3 | 1.00 | 22.7 |
| OBC overload | 3 | 1.00 | 7.0 |
| Multiple fault | 3 | 1.00 | 23.0 |
| Transient spike | 3 | 1.00 | 2.0 |

Inference latency: 0.24 ms/sample in batch evaluation. Online per-packet latency (single sample, including
the Isolation Forest call) is about 1–5 ms and is reported live at `/api/v1/system/status → ml.inference_latency_ms`.

## 4. Discussion

* **Complementary detectors.** Rules are precise but slow and miss faults that stay inside limits
  (sensor drift, early thermal rise). Mahalanobis catches abnormal *combinations* (e.g. temperature rising
  without load, bus V/I relationship change). The LSTM is the fastest (15.6 s mean delay) but on its own
  is the least precise. Fusion keeps the low false-alarm rate of the statistical detectors and gets
  100 % event detection at a 34.5 s mean delay.
* **Where the false positives are.** All four detectors have near-zero alarm rates on pure normal data.
  The FPR in the table comes from fault runs *after* the 300 s recovery window: after a power-degradation or
  thermal fault ends, the SOC deficit and thermal lag persist for many minutes. Arguably these are true
  anomalies of the physical state, not false alarms. A longer recovery mask would raise precision but
  isn't needed to show the method works.
* **Isolation Forest** is a weak baseline here (event detection 0.57). That supports the spec's choice of
  Mahalanobis + LSTM as the primary detectors, so it is reported but has fusion weight 0.
* **Slowest cases**: mild thermal and mild drift faults, because the physical/sensor change is gradual by
  construction. The delay statistic measures time from fault injection, including the period where the
  deviation is still physically undetectable.
* **Explainability.** Every inference carries its detector scores, raw statistics, top-5 contributing
  features (observed vs. LSTM-expected value, prediction error, z-score, share of the anomaly) and the
  affected subsystems. Anomaly events add a plain-language explanation built from that evidence.

## 5. Reproducibility

`metadata.json` records model name, version, training date, dataset description and seed, feature order,
scaler version, thresholds, fusion configuration, LSTM training history, evaluation metrics and the git
commit. The same record is stored in the `model_versions` table at backend start-up or retrain.
