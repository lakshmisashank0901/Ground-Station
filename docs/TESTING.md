# Test Plan & Results

Run: `cd backend && pytest` and `cd frontend && npm test && npm run lint && npm run build`.

## Backend (pytest — 54 tests, ~21 s)

The ML/API tests share a fast, TensorFlow-free training run (ridge fallback predictor) so they are
deterministic and don't need TensorFlow. The Keras↔numpy LSTM equivalence test runs when TensorFlow is
installed.

| Spec item (§13) | Tests |
|---|---|
| **13.1 Unit** — telemetry schema validation | `test_telemetry.py::test_schema_accepts_valid_packet`, `test_schema_rejects_invalid_packets` (7 cases) |
| derived telemetry calculations, packet sequence handling | `test_derived_values_and_sequence_gaps`, `test_missing_values_are_filled_for_ml`, `test_quality_classification`, `test_packet_quality_is_worst_field_and_staleness`, `test_frame_roundtrip_and_crc_detection` |
| Mahalanobis computation | `test_ml.py::test_mahalanobis_matches_definition_and_contributions_sum` |
| score normalization, score fusion | `test_score_normalisation_and_severity`, `test_fusion_weighting_floor_and_missing_detectors`, `test_rule_scores` |
| health-score calculation | `test_services.py::test_health_status_bands`, `test_health_score_calculation` |
| simulation fault generation | `test_simulation.py` (scenario catalogue, physical consistency/limits, determinism, each fault moves its parameter, severity scaling, composite faults, engine controls) |
| command validation | `test_services.py::test_command_validation` |
| **13.2 API** — ingestion valid/invalid | `test_api.py::test_ingestion_accepts_valid_and_rejects_invalid` |
| historical queries return correct ranges | `test_history_returns_correct_ranges` (range, field selection, downsampling, CSV export, health history) |
| anomaly acknowledgement | `test_anomaly_detected_acknowledged_and_resolved` |
| simulation start/stop/reset | `test_simulation_start_stop_reset` |
| command validation | `test_command_workflow_and_validation` (confirm step, cancel, double-confirm 409, unknown → 422 + audit) |
| authentication/authorization | `test_authorization_when_enabled` (401 without key, 403 for viewer, 201 for operator) |
| models, reports, WebSockets | `test_models_and_reports`, `test_websocket_streams_telemetry_and_health` |
| **13.3 ML** — normal mostly normal / false positives | `test_normal_telemetry_mostly_normal` (<1 % samples ≥ 0.30, ≤ 3 alarm samples) |
| injected anomalies elevated, missed anomalies, detection delay | `test_injected_faults_raise_scores_and_are_detected` × 7 scenarios (score elevation, alarm raised, delay < 300 s, explanation present) |
| thresholds calibrated on validation data, model/scaler versions persisted | `test_model_metadata_persisted`, `test_scaler_fit_on_train_only_and_chronological_split` |
| LSTM correctness | `test_numpy_lstm_matches_keras_forward_pass`, `test_ridge_predictor_learns_ar_process` |
| **13.4 End-to-end** | `test_e2e.py::test_end_to_end_obc_anomaly_flow`: start the real simulator at 10× → live telemetry over WS → inject OBC fault → temperature trend rises → ML score ≥ 0.30 and alarm → open detail (OBC attributed, detection delay, injected fault) → acknowledge → replay (REPLAY packets on WS, seek to onset) → generate report |

**Result (2026-10-20):** 54 passed, 0 failed.

## Frontend (Vitest — 33 tests)

`tests/formatters.test.ts`, `tests/buffer.test.ts`, `tests/chart-utils.test.ts` cover formatting,
severity/health mapping, the rolling telemetry buffer and chart downsampling/windowing.
`npm run lint` is clean and `npm run build` compiles with zero type errors.

**Result (2026-10-20):** 33 passed, lint clean, production build OK.

## Manual / system verification performed

* Backend and production frontend run together on SQLite. Live dashboard and anomaly-detail pages were
  checked in headless Chrome during a severe OBC-thermal injection. All 4 WebSockets connected, live charts
  updated, the alarm escalated, and the explanation, observed-vs-expected table and score trace (with
  fault/onset/detected markers) all rendered.
* Through the REST API: thermal demo (WARNING → HIGH → CRITICAL), command PING/confirm, unknown-command
  rejection, run report, replay start/progress/stop.

## Not verified in this environment

* `docker compose up` (Docker isn't installed on the development machine) and therefore PostgreSQL /
  TimescaleDB. The code paths are dialect-neutral SQLAlchemy, and the API tests run on SQLite.
* Browser click-through of operator actions (acknowledge/resolve buttons, command dialog, replay controls,
  report generation in the UI). The backend endpoints behind them are covered by API and E2E tests.
