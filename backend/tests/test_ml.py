import math

import numpy as np
import pytest

from app.ml import fusion
from app.ml.lstm import NumpyLSTMPredictor, RidgeWindowPredictor, tensorflow_available
from app.ml.mahalanobis import MahalanobisDetector
from app.ml.preprocessing import FEATURES, StandardScaler, chronological_split, make_windows
from app.ml.training import alarms, generate_fault_run, generate_normal, point_metrics, score_rows


def test_mahalanobis_matches_definition_and_contributions_sum():
    rng = np.random.default_rng(0)
    x = rng.multivariate_normal([0, 0, 0], [[1, 0.8, 0], [0.8, 1, 0], [0, 0, 1]], size=4000)
    det = MahalanobisDetector().fit(x)
    v = np.array([1.0, -1.0, 0.0])  # individually normal, jointly unusual (breaks the correlation)
    d = v - det.mean_
    expected = math.sqrt(d @ det.precision_ @ d)
    assert det.distance(v)[0] == pytest.approx(expected)
    assert det.contributions(v).sum() == pytest.approx(expected ** 2)
    assert det.distance(v)[0] > det.distance(np.array([1.0, 1.0, 0.0]))[0] * 2


def test_score_normalisation_and_severity():
    assert fusion.normalize(0.0, 5.0) == 0.0
    assert fusion.normalize(5.0, 5.0) == pytest.approx(fusion.ALARM_THRESHOLD)
    assert 0.6 < fusion.normalize(10.0, 5.0) < 0.8
    assert fusion.normalize(30.0, 5.0) > 0.99
    assert fusion.normalize(None, 5.0) is None and fusion.normalize(1.0, None) is None
    assert [fusion.severity_of(s) for s in (0.1, 0.3, 0.65, 0.95)] == ["NORMAL", "WARNING", "HIGH", "CRITICAL"]


def test_fusion_weighting_floor_and_missing_detectors():
    w = fusion.DEFAULT_WEIGHTS
    scores = {"rule": 0.2, "mahalanobis": 0.4, "lstm": 0.6, "isolation_forest": 0.9}
    assert fusion.fuse(scores, w, floor_gain=0.0) == pytest.approx(0.25 * 0.2 + 0.30 * 0.4 + 0.45 * 0.6)
    # A single confident detector is not diluted below floor_gain × its score.
    assert fusion.fuse({"rule": 1.0, "mahalanobis": 0.0, "lstm": 0.0}, w, 0.75) == pytest.approx(0.75)
    # Missing detectors re-normalise the remaining weights.
    assert fusion.fuse({"rule": 0.5, "mahalanobis": 0.5, "lstm": None}, w, 0.0) == pytest.approx(0.5)


def test_rule_scores():
    assert fusion.rule_score_for("obc_temperature", 30.0) == 0.0
    assert 0.15 <= fusion.rule_score_for("obc_temperature", 51.0) < 0.3
    assert fusion.rule_score_for("obc_temperature", 75.0) == 1.0
    assert fusion.rule_score_for("watchdog_status", "FAULT") == 0.9


def test_scaler_fit_on_train_only_and_chronological_split():
    tr, va, te = chronological_split(100)
    assert (tr.stop, va.stop, te.stop) == (70, 85, 100)
    x = np.arange(100, dtype=float)[:, None]
    sc = StandardScaler().fit(x[tr])
    assert sc.mean_[0] == pytest.approx(34.5)
    assert sc.inverse_transform(sc.transform(x))[:, 0] == pytest.approx(x[:, 0])
    w, y = make_windows(np.arange(10.0)[:, None], 3)
    assert w.shape == (7, 3, 1) and y[0, 0] == 3.0


def test_ridge_predictor_learns_ar_process():
    rng = np.random.default_rng(1)
    z = np.zeros((3000, 2))
    for t in range(1, 3000):
        z[t] = 0.9 * z[t - 1] + rng.normal(0, 0.1, 2)
    w, y = make_windows(z, 60)
    p = RidgeWindowPredictor().fit(w, y)
    assert np.mean((p.predict(w) - y) ** 2) < 0.012


@pytest.mark.skipif(not tensorflow_available(), reason="TensorFlow not installed")
def test_numpy_lstm_matches_keras_forward_pass():
    from app.ml.lstm import build_keras_model, export_keras_weights
    model = build_keras_model(5, window=12)
    x = np.random.default_rng(2).normal(size=(4, 12, 5)).astype("float32")
    ref = model(x, training=False).numpy()
    ours = NumpyLSTMPredictor(export_keras_weights(model)).predict(x.astype(np.float64))
    assert ours == pytest.approx(ref, abs=1e-4)


def test_model_metadata_persisted(bundle):
    meta = bundle.metadata
    assert meta["features"] == FEATURES
    for k in ("version", "trained_at", "training_dataset", "scaler_version", "thresholds", "evaluation",
              "software_version", "fusion"):
        assert k in meta
    assert {"mahalanobis", "lstm_short", "lstm_bias", "isolation_forest"} <= set(meta["thresholds"])


def test_normal_telemetry_mostly_normal(bundle):
    rows = generate_normal(3000, seed=777)
    fused = np.array([r["anomaly_score"] for r in score_rows(bundle, rows)])
    assert np.mean(fused >= fusion.ALARM_THRESHOLD) < 0.01      # false-positive check
    assert alarms(fused).sum() <= 3


@pytest.mark.parametrize("scenario", ["obc_thermal", "power_degradation", "sensor_drift", "comm_degradation",
                                      "obc_overload", "multiple_fault", "transient_spike"])
def test_injected_faults_raise_scores_and_are_detected(bundle, scenario):
    rows, labels, meta = generate_fault_run(scenario, "severe", seed=4242, pre_s=300, post_s=120)
    res = score_rows(bundle, rows)
    fused = np.array([r["anomaly_score"] for r in res])
    pre = fused[60:meta["start_idx"]]
    during = fused[meta["start_idx"]:meta["end_idx"] + 60]
    assert during.max() > max(0.6, pre.max())                    # elevated score
    al = alarms(fused)
    hits = np.flatnonzero(al[meta["start_idx"]:])
    assert len(hits) > 0, "missed anomaly"
    delay = hits[0]
    assert delay < 300                                           # detection delay bound
    peak = res[meta["start_idx"] + int(np.argmax(during))]
    assert peak["top_features"] and peak["affected_subsystems"]  # explainability


def test_point_metrics_ignore_recovery_labels():
    al = np.array([1, 1, 0, 1], dtype=bool)
    lab = np.array([1, 0, 1, -1])
    m = point_metrics(al, lab)
    assert (m["tp"], m["fp"], m["fn"]) == (1, 1, 1)
