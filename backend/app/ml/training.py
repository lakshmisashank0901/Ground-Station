"""Training and evaluation pipeline (used by backend/training/*.py and by auto-train at startup).

Datasets come from the spacecraft simulator: long normal-operation runs for fitting, plus labelled
fault-injection runs for threshold/fusion calibration (validation) and for reporting (test).
"""
from __future__ import annotations

import csv
import itertools
import json
import logging
import pickle
import platform
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from app.ml import fusion
from app.ml.inference import LSTM_ERROR_EXCLUDE, MODE_MASK_SAMPLES, ModelBundle, OnlineScorer, lstm_error_stats
from app.ml.isolation_forest import IsolationForestDetector
from app.ml.lstm import WINDOW, NumpyLSTMPredictor, RidgeWindowPredictor, tensorflow_available
from app.ml.mahalanobis import MahalanobisDetector
from app.ml.preprocessing import FEATURES, StandardScaler, chronological_split, make_windows, rows_to_matrix
from app.simulation.faults import build_faults
from app.simulation.scenarios import FAULT_SCENARIOS
from app.simulation.spacecraft import Spacecraft
from app.telemetry.schemas import NUMERIC_PARAMETERS

log = logging.getLogger(__name__)

ALARM_PERSISTENCE = fusion.ALARM_PERSISTENCE
DETECTION_GRACE_S = 300    # an alarm up to this long after the fault ends still counts as detected
RECOVERY_S = 300


# --------------------------------------------------------------------------------------- datasets
def generate_normal(n: int, seed: int) -> list[dict]:
    sc = Spacecraft(seed=seed, orbit_phase0=(seed * 0.137) % 1.0)
    return [sc.step(1.0, []) for _ in range(n)]


def generate_fault_run(scenario: str, severity: str, seed: int, pre_s: int = 900,
                       post_s: int = 600) -> tuple[list[dict], np.ndarray, dict]:
    sc = Spacecraft(seed=seed, orbit_phase0=(seed * 0.291) % 1.0)
    faults = build_faults(scenario, severity, start_t=float(pre_s), duration_s=None)
    dur = int(faults[0].duration_s)
    total = pre_s + dur + post_s
    rows = [sc.step(1.0, faults) for _ in range(total)]
    # 1 = fault active, 0 = normal, -1 = recovery tail (physical state still settling; excluded from
    # point metrics, but an alarm there still counts as detecting the event).
    # Row i is produced at sim time t = i + 1 and the fault is active for start ≤ t < start + dur.
    s0 = pre_s - 1
    labels = np.zeros(total, dtype=np.int8)
    labels[s0:s0 + dur] = 1
    labels[s0 + dur:s0 + dur + RECOVERY_S] = -1
    meta = {"scenario": scenario, "severity": severity, "seed": seed, "start_idx": s0, "end_idx": s0 + dur}
    return rows, labels, meta


def save_csv(path: Path, rows: list[dict], labels: np.ndarray | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    keys = list(rows[0].keys())
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["t"] + keys + (["label"] if labels is not None else []))
        for i, r in enumerate(rows):
            w.writerow([i + 1] + [r[k] for k in keys] + ([int(labels[i])] if labels is not None else []))


# -------------------------------------------------------------------------------------- scoring
def score_rows(bundle: ModelBundle, rows: list[dict]) -> list[dict]:
    """Score a chronological run with the exact online scorer (LSTM predictions batched)."""
    scorer = OnlineScorer(bundle)
    z = bundle.scaler.transform(rows_to_matrix(rows, bundle.features))
    preds = None
    if bundle.predictor is not None:
        windows, _ = make_windows(z, WINDOW)
        preds = bundle.predictor.predict(windows) if len(windows) else None
    if_raw = bundle.iforest.raw_score(z) if bundle.iforest is not None else None
    out = []
    for i, r in enumerate(rows):
        values = {k: r[k] for k in NUMERIC_PARAMETERS}
        pred = preds[i - WINDOW] if preds is not None and i >= WINDOW else None
        out.append(scorer.step(values, r, timestamp=str(i), sequence=i, prediction=pred,
                               if_raw=None if if_raw is None else float(if_raw[i])))
    return out


def detector_matrix(results: list[dict]) -> dict[str, np.ndarray]:
    keys = ["rule", "mahalanobis", "isolation_forest", "lstm"]
    return {k: np.array([np.nan if r["detectors"][k] is None else r["detectors"][k] for r in results]) for k in keys}


def fuse_matrix(det: dict[str, np.ndarray], weights: dict, floor_gain: float) -> np.ndarray:
    """Vectorised equivalent of fusion.fuse over a whole run."""
    keys = [k for k in det if weights.get(k, 0.0) > 0]
    if not keys:
        return np.zeros(len(next(iter(det.values()))))
    v = np.column_stack([det[k] for k in keys])
    w = np.array([weights[k] for k in keys])
    avail = ~np.isnan(v)
    v0 = np.where(avail, v, 0.0)
    wsum = (avail * w).sum(axis=1)
    weighted = np.divide((v0 * w).sum(axis=1), wsum, out=np.zeros(len(v)), where=wsum > 0)
    vmax = np.where(avail, v, -np.inf).max(axis=1)
    out = np.maximum(weighted, floor_gain * np.where(np.isfinite(vmax), vmax, 0.0))
    return np.clip(np.where(wsum > 0, out, 0.0), 0.0, 1.0)


def alarms(scores: np.ndarray, threshold: float = fusion.ALARM_THRESHOLD, persistence: int = ALARM_PERSISTENCE) -> np.ndarray:
    """True where the score has been ≥ threshold for `persistence` consecutive samples."""
    above = (scores >= threshold).astype(int)
    c = np.convolve(above, np.ones(persistence, dtype=int))[:len(above)]
    return c >= persistence


def event_detection(alarm: np.ndarray, meta: dict) -> tuple[bool, float | None]:
    s, e = meta["start_idx"], meta["end_idx"]
    hits = np.flatnonzero(alarm[s:min(len(alarm), e + DETECTION_GRACE_S)])
    if len(hits) == 0:
        return False, None
    return True, float(hits[0])


def point_metrics(alarm: np.ndarray, labels: np.ndarray) -> dict:
    keep = labels >= 0
    alarm, labels = alarm[keep].astype(bool), labels[keep].astype(bool)
    tp = int(np.sum(alarm & labels))
    fp = int(np.sum(alarm & ~labels))
    fn = int(np.sum(~alarm & labels))
    tn = int(np.sum(~alarm & ~labels))
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {"tp": tp, "fp": fp, "fn": fn, "tn": tn, "precision": round(precision, 4), "recall": round(recall, 4),
            "f1": round(f1, 4), "false_positive_rate": round(fp / (fp + tn) if fp + tn else 0.0, 5),
            "false_negative_rate": round(fn / (fn + tp) if fn + tp else 0.0, 4)}


# ------------------------------------------------------------------------------------- training
def _git_version() -> str:
    try:
        return subprocess.run(["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True,
                              timeout=3).stdout.strip() or "unknown"
    except Exception:
        return "unknown"


def train_all(models_dir: Path, datasets_dir: Path | None = None, *, fast: bool = False,
              lstm_enabled: bool = True, seed: int = 11, progress=None) -> dict:
    """Generate data, fit scaler + detectors, calibrate thresholds, tune fusion, evaluate, persist."""
    say = progress or (lambda msg: log.info(msg))
    t_start = time.time()
    models_dir.mkdir(parents=True, exist_ok=True)
    n_normal = 48_000 if fast else 96_000
    severities = ["moderate"] if fast else ["mild", "moderate", "severe"]

    say(f"generating {n_normal} normal samples")
    normal = generate_normal(n_normal, seed)
    if datasets_dir is not None:
        save_csv(datasets_dir / "raw" / "normal.csv", normal)
    x = rows_to_matrix(normal)
    tr, va, te = chronological_split(len(x))

    scaler = StandardScaler().fit(x[tr])  # fit on training split only
    z = scaler.transform(x)
    if datasets_dir is not None:
        (datasets_dir / "processed").mkdir(parents=True, exist_ok=True)
        np.savez_compressed(datasets_dir / "processed" / "normal_scaled.npz", train=z[tr], val=z[va], test=z[te],
                            features=np.array(FEATURES))

    say("fitting Mahalanobis detector")
    maha = MahalanobisDetector().fit(z[tr])
    say("fitting Isolation Forest baseline")
    iforest = IsolationForestDetector(n_estimators=100 if fast else 200).fit(z[tr][:: 2 if fast else 1])

    # Temporal predictor
    lstm_info: dict = {}
    predictor = None
    xw_tr, yw_tr = make_windows(z[tr], WINDOW)
    xw_va, yw_va = make_windows(z[va], WINDOW)
    if lstm_enabled and tensorflow_available():
        from app.ml.lstm import export_keras_weights, train_keras
        stride = 4 if fast else 2
        say(f"training LSTM on {len(xw_tr[::stride])} windows")
        model, hist = train_keras(xw_tr[::stride], yw_tr[::stride], xw_va[::4], yw_va[::4], epochs=6 if fast else 15)
        model.save(models_dir / "lstm.keras")
        predictor = NumpyLSTMPredictor(export_keras_weights(model))
        predictor.save(models_dir / "lstm_weights.npz")
        (models_dir / "ridge_predictor.npz").unlink(missing_ok=True)
        lstm_info = {"backend": NumpyLSTMPredictor.backend, "architecture":
                     "LSTM(64)->Dropout(0.2)->LSTM(32)->Dense(16)->Dense(N)", **hist}
    else:
        say("TensorFlow unavailable or LSTM disabled: fitting ridge fallback predictor")
        predictor = RidgeWindowPredictor().fit(xw_tr, yw_tr)
        predictor.save(models_dir / "ridge_predictor.npz")
        (models_dir / "lstm_weights.npz").unlink(missing_ok=True)
        lstm_info = {"backend": RidgeWindowPredictor.backend}

    # Calibration on the validation split (normal data)
    say("calibrating thresholds on validation data")
    thresholds = {
        "mahalanobis": round(float(np.quantile(maha.distance(z[va]), 0.999)), 4),
    }
    if_raw = iforest.raw_score(z[va])
    base = float(np.median(if_raw))
    thresholds["isolation_forest_base"] = round(base, 5)
    thresholds["isolation_forest"] = round(float(np.quantile(if_raw, 0.999)) - base, 5)

    pred_va = predictor.predict(xw_va)
    err_idx = np.array([i for i, f in enumerate(FEATURES) if f not in LSTM_ERROR_EXCLUDE])
    resid = yw_va - pred_va
    residual_std = np.maximum(resid.std(axis=0), 1e-3)
    r = (resid / residual_std)[:, err_idx]
    pa = x[va][WINDOW:, FEATURES.index("payload_active")]
    change = np.r_[False, pa[1:] != pa[:-1]]
    mask = np.zeros(len(change), dtype=bool)
    for i in np.flatnonzero(change):
        mask[i:i + MODE_MASK_SAMPLES] = True
    e_short, e_bias, _, _ = lstm_error_stats(r, mask)
    thresholds["lstm_short"] = round(float(np.quantile(e_short[WINDOW:], 0.999)), 4)
    thresholds["lstm_bias"] = round(float(np.quantile(e_bias[WINDOW:], 0.999)), 4)
    thresholds["alarm"] = fusion.ALARM_THRESHOLD

    version = datetime.now(timezone.utc).strftime("v%Y%m%d-%H%M%S")
    metadata = {
        "name": "sat01-hybrid-anomaly",
        "version": version,
        "trained_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "training_dataset": f"simulator normal operation, {n_normal} samples @1 Hz, seed {seed}, "
                            f"chronological split 70/15/15",
        "features": FEATURES,
        "scaler_version": version,
        "thresholds": thresholds,
        "fusion": {"weights": dict(fusion.DEFAULT_WEIGHTS), "floor_gain": fusion.DEFAULT_FLOOR_GAIN},
        "lstm": {**lstm_info, "window": WINDOW, "residual_std": [round(float(v), 6) for v in residual_std]},
        "software_version": _git_version(),
        "platform": platform.platform(),
    }

    with open(models_dir / "scaler.pkl", "wb") as f:
        pickle.dump(scaler, f)
    with open(models_dir / "mahalanobis.pkl", "wb") as f:
        pickle.dump(maha, f)
    with open(models_dir / "isolation_forest.pkl", "wb") as f:
        pickle.dump(iforest, f)
    bundle = ModelBundle(scaler, maha, iforest, predictor, metadata)

    # Normal-test false-alarm check + labelled fault runs (validation: tune fusion; test: report).
    say("generating labelled fault-injection runs")
    val_runs = [generate_fault_run(s, sev, seed=1000 + i) for i, (s, sev) in
                enumerate(itertools.product(FAULT_SCENARIOS, severities))]
    test_runs = [generate_fault_run(s, sev, seed=5000 + i) for i, (s, sev) in
                 enumerate(itertools.product(FAULT_SCENARIOS, severities))]
    if datasets_dir is not None:
        for rows, labels, meta in test_runs:
            save_csv(datasets_dir / "cleaned" / f"test_{meta['scenario']}_{meta['severity']}.csv", rows, labels)

    say("scoring validation runs and tuning fusion weights")
    normal_val_rows = normal[va.start:va.stop]
    val_scored = [(detector_matrix(score_rows(bundle, rows)), labels, meta) for rows, labels, meta in val_runs]
    normal_val_det = detector_matrix(score_rows(bundle, normal_val_rows))
    metadata["fusion"] = tune_fusion(val_scored, normal_val_det)

    say("evaluating on test runs")
    normal_test_rows = normal[te.start:te.stop]
    metadata["evaluation"] = evaluate(bundle, test_runs, normal_test_rows)
    metadata["evaluation"]["dataset"] = (f"test split: {len(normal_test_rows)} normal samples + "
                                         f"{len(test_runs)} fault runs ({', '.join(severities)})")
    metadata["training_time_s"] = round(time.time() - t_start, 1)
    (models_dir / "metadata.json").write_text(json.dumps(metadata, indent=2))
    say(f"training complete: {version} in {metadata['training_time_s']} s")
    return metadata


def tune_fusion(val_scored, normal_det, max_alarm_rate: float = 0.002) -> dict:
    """Grid-search fusion weights/floor gain on validation runs: maximise event detection and point F1
    subject to a normal-operation alarm-rate budget. Spec 8.5 weights are the starting point."""
    best = None
    grid = [w / 20 for w in range(1, 20)]
    candidates = [dict(fusion.DEFAULT_WEIGHTS)]
    for wr in grid:
        for wm in grid:
            wl = round(1 - wr - wm, 4)
            if wl >= 0.05:
                candidates.append({"rule": wr, "mahalanobis": wm, "lstm": wl, "isolation_forest": 0.0})
    for weights in candidates:
        for fg in (0.6, 0.7, 0.75, 0.8):
            fa = alarms(fuse_matrix(normal_det, weights, fg)).mean()
            if fa > max_alarm_rate:
                continue
            detected = 0
            all_al, all_lab = [], []
            for det, labels, meta in val_scored:
                al = alarms(fuse_matrix(det, weights, fg))
                detected += event_detection(al, meta)[0]
                all_al.append(al)
                all_lab.append(labels)
            f1 = point_metrics(np.concatenate(all_al), np.concatenate(all_lab))["f1"]
            # Ties (to 2 d.p. F1) prefer the specification's starting weights.
            dist = sum(abs(weights[k] - fusion.DEFAULT_WEIGHTS[k]) for k in weights) + abs(fg - fusion.DEFAULT_FLOOR_GAIN)
            key = (detected, round(f1, 2), -dist)
            if best is None or key > best[0]:
                best = (key, weights, fg, fa)
    if best is None:
        return {"weights": dict(fusion.DEFAULT_WEIGHTS), "floor_gain": fusion.DEFAULT_FLOOR_GAIN, "tuned": False}
    (detected, f1, _), weights, fg, fa = best
    return {"weights": weights, "floor_gain": fg, "tuned": True, "validation": {
        "events_detected": int(detected), "events": len(val_scored), "point_f1": f1, "normal_alarm_rate": round(float(fa), 5)}}


def evaluate(bundle: ModelBundle, runs, normal_rows: list[dict]) -> dict:
    """Per-detector and fused metrics on labelled test runs + a normal-only run (false alarms)."""
    fusion_cfg = bundle.metadata.get("fusion", {})
    weights, fg = fusion_cfg.get("weights", fusion.DEFAULT_WEIGHTS), fusion_cfg.get("floor_gain", fusion.DEFAULT_FLOOR_GAIN)
    t0 = time.perf_counter()
    scored = [(detector_matrix(score_rows(bundle, rows)), labels, meta) for rows, labels, meta in runs]
    normal_det = detector_matrix(score_rows(bundle, normal_rows))
    n_samples = sum(len(l) for _, l, _ in runs) + len(normal_rows)
    latency_ms = (time.perf_counter() - t0) * 1000.0 / max(1, n_samples)

    def series(det, name):
        if name == "fused":
            return fuse_matrix(det, weights, fg)
        v = det[name]
        return np.nan_to_num(v, nan=0.0)

    detectors = {}
    per_scenario: dict[str, dict] = {}
    for name in ["rule", "mahalanobis", "isolation_forest", "lstm", "fused"]:
        all_al, all_lab, delays = [], [], []
        for det, labels, meta in scored:
            al = alarms(series(det, name))
            hit, delay = event_detection(al, meta)
            all_al.append(al)
            all_lab.append(labels)
            if hit:
                delays.append(delay)
            if name == "fused":
                ps = per_scenario.setdefault(meta["scenario"], {"runs": 0, "detected": 0, "delays": []})
                ps["runs"] += 1
                ps["detected"] += int(hit)
                if hit:
                    ps["delays"].append(delay)
        n_al = alarms(series(normal_det, name))
        all_al.append(n_al)
        all_lab.append(np.zeros(len(n_al), dtype=np.int8))
        m = point_metrics(np.concatenate(all_al), np.concatenate(all_lab))
        m["event_detection_rate"] = round(len(delays) / len(scored), 4) if scored else 0.0
        m["mean_detection_delay_s"] = round(float(np.mean(delays)), 1) if delays else None
        m["normal_alarm_rate"] = round(float(n_al.mean()), 5)
        detectors[name] = m

    return {
        "evaluated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "detectors": detectors,
        "per_scenario": {k: {"runs": v["runs"], "detection_rate": round(v["detected"] / v["runs"], 4),
                             "mean_detection_delay_s": round(float(np.mean(v["delays"])), 1) if v["delays"] else None}
                         for k, v in per_scenario.items()},
        "inference_latency_ms": {"mean": round(latency_ms, 3)},
    }
