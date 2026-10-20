"""Online hybrid anomaly inference: rules + Mahalanobis + Isolation Forest + LSTM → fused score."""
from __future__ import annotations

import json
import logging
import pickle
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

import numpy as np

from app.ml import fusion
from app.ml.isolation_forest import IsolationForestDetector
from app.ml.lstm import WINDOW, load_predictor
from app.ml.mahalanobis import MahalanobisDetector
from app.ml.preprocessing import FEATURES, StandardScaler, feature_vector
from app.telemetry.schemas import PARAM_BY_NAME

log = logging.getLogger(__name__)

# LSTM error statistics: short-term error energy (EWMA of r²) and persistent bias (EWMA of r).
SHORT_ALPHA = 0.2
BIAS_ALPHA = 0.02
# Features that are model inputs but excluded from the LSTM error (discrete mode flag).
LSTM_ERROR_EXCLUDE = {"payload_active"}
# Commanded payload mode changes cause step changes that no telemetry-only predictor can anticipate;
# residuals are clipped for a few samples after a transition (mode-transition masking).
MODE_MASK_SAMPLES = 5
MODE_MASK_CLIP = 2.0
# Residual clipping keeps a single huge spike (already caught by rule/Mahalanobis) from saturating the
# EWMA statistics for minutes; the bias statistic targets slow drifts so it is clipped harder.
SHORT_CLIP = 10.0
BIAS_CLIP = 4.0


def _update_stats(sq: np.ndarray, bias: np.ndarray, r: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    rs = np.clip(r, -SHORT_CLIP, SHORT_CLIP)
    rb = np.clip(r, -BIAS_CLIP, BIAS_CLIP)
    return (1 - SHORT_ALPHA) * sq + SHORT_ALPHA * rs * rs, (1 - BIAS_ALPHA) * bias + BIAS_ALPHA * rb


def lstm_error_stats(r: np.ndarray, mask: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Run the EWMA error statistics over a sequence of standardized residuals r (T × F).

    Returns per-time (e_short, e_bias) and the final per-feature (sq_ewma, bias_ewma) state. The online
    scorer uses exactly the same recurrence one step at a time.
    """
    sq = np.ones(r.shape[1])
    bias = np.zeros(r.shape[1])
    e_short = np.empty(len(r))
    e_bias = np.empty(len(r))
    for t in range(len(r)):
        rt = r[t]
        if mask is not None and mask[t]:
            rt = np.clip(rt, -MODE_MASK_CLIP, MODE_MASK_CLIP)
        sq, bias = _update_stats(sq, bias, rt)
        e_short[t] = np.sqrt(sq.max())
        e_bias[t] = np.abs(bias).max()
    return e_short, e_bias, sq, bias


@dataclass
class ModelBundle:
    scaler: StandardScaler
    mahalanobis: MahalanobisDetector
    iforest: IsolationForestDetector | None
    predictor: Any | None
    metadata: dict
    features: list[str] = field(default_factory=lambda: list(FEATURES))

    @property
    def version(self) -> str:
        return self.metadata.get("version", "unversioned")

    @property
    def thresholds(self) -> dict[str, float]:
        return self.metadata.get("thresholds", {})

    @property
    def weights(self) -> dict[str, float]:
        return self.metadata.get("fusion", {}).get("weights", fusion.DEFAULT_WEIGHTS)

    @property
    def floor_gain(self) -> float:
        return self.metadata.get("fusion", {}).get("floor_gain", fusion.DEFAULT_FLOOR_GAIN)

    @property
    def residual_std(self) -> np.ndarray | None:
        rs = self.metadata.get("lstm", {}).get("residual_std")
        return np.asarray(rs) if rs is not None else None

    @property
    def lstm_error_index(self) -> np.ndarray:
        return np.array([i for i, f in enumerate(self.features) if f not in LSTM_ERROR_EXCLUDE])

    @classmethod
    def load(cls, models_dir: Path) -> "ModelBundle | None":
        meta_path = models_dir / "metadata.json"
        if not meta_path.exists():
            return None
        metadata = json.loads(meta_path.read_text())
        with open(models_dir / "scaler.pkl", "rb") as f:
            scaler = pickle.load(f)
        with open(models_dir / "mahalanobis.pkl", "rb") as f:
            maha = pickle.load(f)
        iforest = None
        if (models_dir / "isolation_forest.pkl").exists():
            with open(models_dir / "isolation_forest.pkl", "rb") as f:
                iforest = pickle.load(f)
        predictor = load_predictor(models_dir)
        return cls(scaler, maha, iforest, predictor, metadata, metadata.get("features", list(FEATURES)))


class OnlineScorer:
    """Stateful per-sample scorer. One instance per telemetry stream."""

    def __init__(self, bundle: ModelBundle) -> None:
        self.b = bundle
        self.err_idx = bundle.lstm_error_index
        self.reset()

    def reset(self) -> None:
        self.window: deque[np.ndarray] = deque(maxlen=WINDOW)
        n = len(self.err_idx)
        self.sq = np.ones(n)
        self.bias = np.zeros(n)
        self.mask_left = 0
        self.last_payload_state: str | None = None
        self.latencies: deque[float] = deque(maxlen=500)

    # ------------------------------------------------------------------------------------------
    def step(self, values: Mapping[str, float], data: Mapping[str, Any], *, timestamp: str, sequence: int,
             quality_factor: float = 1.0, prediction: np.ndarray | None = None,
             if_raw: float | None = None) -> dict:
        t0 = time.perf_counter()
        b = self.b
        payload_state = data.get("payload_state")
        x = feature_vector(values, payload_state, b.features)
        z = b.scaler.transform(x)

        # Rule checks (raw engineering values)
        rules = fusion.rule_scores(data)
        rule_score = max(rules.values()) if rules else 0.0

        # Mahalanobis
        d = float(b.mahalanobis.distance(z)[0])
        maha_score = fusion.normalize(d, b.thresholds.get("mahalanobis"))
        contrib = b.mahalanobis.contributions(z)

        # Isolation Forest (comparison)
        if_score = None
        if b.iforest is not None:
            if if_raw is None:
                if_raw = float(b.iforest.raw_score(z)[0])
            if_score = fusion.normalize(max(0.0, if_raw - b.thresholds.get("isolation_forest_base", 0.0)),
                                        b.thresholds.get("isolation_forest"))

        # LSTM temporal prediction
        lstm_raw = lstm_score = None
        expected_z = None
        lstm_feat = np.zeros(len(b.features))
        if payload_state != self.last_payload_state and self.last_payload_state is not None:
            self.mask_left = MODE_MASK_SAMPLES
        self.last_payload_state = payload_state
        rs = b.residual_std
        if b.predictor is not None and rs is not None and len(self.window) == WINDOW:
            pred = prediction if prediction is not None else b.predictor.predict(np.stack(self.window)[None])[0]
            expected_z = pred
            r = ((z - pred) / rs)[self.err_idx]
            if self.mask_left > 0:
                r = np.clip(r, -MODE_MASK_CLIP, MODE_MASK_CLIP)
                self.mask_left -= 1
            self.sq, self.bias = _update_stats(self.sq, self.bias, r)
            e_short = float(np.sqrt(self.sq.max()))
            e_bias = float(np.abs(self.bias).max())
            ts, tb = b.thresholds.get("lstm_short", 1.0), b.thresholds.get("lstm_bias", 1.0)
            ratio = max(e_short / ts, e_bias / tb)
            lstm_raw = e_short
            lstm_score = fusion.normalize(ratio, 1.0)
            per = np.maximum(np.sqrt(self.sq) / ts, np.abs(self.bias) / tb)
            lstm_feat[self.err_idx] = per
        elif self.mask_left > 0:
            self.mask_left -= 1
        self.window.append(z)

        scores = {"rule": rule_score, "mahalanobis": maha_score, "isolation_forest": if_score, "lstm": lstm_score}
        fused = fusion.fuse(scores, b.weights, b.floor_gain)
        conf = fusion.confidence(fused, {k: v for k, v in scores.items()
                                         if v is not None and (b.weights.get(k, 0) > 0 or k == "rule")},
                                 quality_factor)

        top = self._explain(x, z, expected_z, rules, contrib, d, maha_score, lstm_feat, lstm_score, scores)
        affected: list[str] = []
        for f in top:
            if f["contribution"] >= 0.15 or not affected:
                if f["subsystem"] not in affected:
                    affected.append(f["subsystem"])
        if fused < fusion.ALARM_THRESHOLD:
            affected = affected if rule_score >= fusion.ALARM_THRESHOLD else []

        self.latencies.append((time.perf_counter() - t0) * 1000.0)
        r3 = lambda v: None if v is None else round(float(v), 4)  # noqa: E731
        return {
            "timestamp": timestamp,
            "sequence": sequence,
            "anomaly_score": round(fused, 4),
            "severity": fusion.severity_of(fused),
            "confidence": conf,
            "detectors": {k: r3(v) for k, v in scores.items()},
            "raw": {"mahalanobis_distance": r3(d), "lstm_error": r3(lstm_raw), "isolation_forest_raw": r3(if_raw)},
            "affected_subsystems": affected,
            "top_features": top,
            "model_version": b.version,
            "rule_by_feature": {k: round(v, 3) for k, v in rules.items() if v > 0},
        }

    # ------------------------------------------------------------------------------------------
    def _explain(self, x, z, expected_z, rules, contrib, d, maha_score, lstm_feat, lstm_score, scores) -> list[dict]:
        """Rank features by their combined contribution across detectors."""
        b = self.b
        w = b.weights
        d2 = max(d * d, 1e-9)
        # D² cross-terms can blame a variable that is itself normal but correlated with the culprit
        # (e.g. payload power when bus current rises). Weight by each feature's own marginal deviation.
        marginal = np.clip(np.abs(z) / 2.0, 0.1, 1.0)
        maha_raw = np.maximum(contrib, 0.0) * marginal
        maha_share = maha_raw / max(maha_raw.sum(), 1e-9)
        lstm_share = lstm_feat / max(lstm_feat.sum(), 1e-9)
        total = np.zeros(len(b.features))
        for i, name in enumerate(b.features):
            rule_i = rules.get(name, 0.0)
            total[i] = (w.get("rule", 0.25) * rule_i
                        + w.get("mahalanobis", 0.3) * (maha_score or 0.0) * maha_share[i]
                        + w.get("lstm", 0.45) * (lstm_score or 0.0) * lstm_share[i])
        # Enum rule hits (e.g. watchdog) are not model features but must be explainable too.
        extra = {k: v for k, v in rules.items() if k not in b.features and v > 0}
        s = total.sum() + sum(w.get("rule", 0.25) * v for v in extra.values())
        if s <= 1e-9:
            return []
        expected = b.scaler.inverse_transform(expected_z) if expected_z is not None else b.scaler.mean_
        items = []
        for i in np.argsort(-total)[:5]:
            if total[i] <= 0:
                continue
            name = b.features[i]
            unit = PARAM_BY_NAME[name].unit if name in PARAM_BY_NAME else ""
            sub = PARAM_BY_NAME[name].subsystem if name in PARAM_BY_NAME else "PAYLOAD"
            items.append({
                "feature": name, "subsystem": sub, "unit": unit,
                "contribution": round(float(total[i] / s), 4),
                "observed": round(float(x[i]), 4), "expected": round(float(expected[i]), 4),
                "prediction_error": round(float(x[i] - expected[i]), 4),
                "z_score": round(float(z[i]), 3),
            })
        for name, v in extra.items():
            p = PARAM_BY_NAME[name]
            # Enum states are encoded as 1 = abnormal state observed, 0 = expected nominal state.
            items.append({"feature": name, "subsystem": p.subsystem, "unit": "", "contribution":
                          round(w.get("rule", 0.25) * v / s, 4), "observed": 1.0, "expected": 0.0,
                          "prediction_error": 1.0, "z_score": 0.0})
        items.sort(key=lambda it: -it["contribution"])
        return items[:5]

    @property
    def mean_latency_ms(self) -> float | None:
        return round(float(np.mean(self.latencies)), 3) if self.latencies else None
