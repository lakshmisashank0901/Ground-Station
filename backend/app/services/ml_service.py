"""ML engine service: model loading, (re)training in the background and per-sample inference."""
from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Any, Mapping

from app.ml import fusion
from app.ml.inference import ModelBundle, OnlineScorer
from app.telemetry.schemas import PARAM_BY_NAME

log = logging.getLogger(__name__)


class MLService:
    def __init__(self, models_dir: Path, datasets_dir: Path, lstm_enabled: bool = True) -> None:
        self.models_dir = models_dir
        self.datasets_dir = datasets_dir
        self.lstm_enabled = lstm_enabled
        self.bundle: ModelBundle | None = None
        self.scorer: OnlineScorer | None = None
        self.status = "OFFLINE"
        self.training_message: str | None = None
        self.error: str | None = None
        self._lock = threading.Lock()
        self._train_thread: threading.Thread | None = None
        self.on_trained = None  # callback(metadata) after a successful training run

    # -------------------------------------------------------------------------------- loading
    def load(self) -> bool:
        try:
            bundle = ModelBundle.load(self.models_dir)
        except Exception as exc:
            log.exception("failed to load models")
            self.status, self.error = "DEGRADED", str(exc)
            return False
        if bundle is None:
            self.status = "DEGRADED"
            return False
        with self._lock:
            self.bundle = bundle
            self.scorer = OnlineScorer(bundle)
        self.status, self.error = "ONLINE", None
        log.info("models loaded: %s (%s)", bundle.version, getattr(bundle.predictor, "backend", "no predictor"))
        return True

    @property
    def is_training(self) -> bool:
        return self._train_thread is not None and self._train_thread.is_alive()

    def train_async(self, fast: bool = True) -> bool:
        if self.is_training:
            return False
        self._train_thread = threading.Thread(target=self._train, args=(fast,), daemon=True, name="ml-train")
        self._train_thread.start()
        return True

    def _train(self, fast: bool) -> None:
        from app.ml.training import train_all

        prev = self.status
        self.status = "TRAINING"
        try:
            meta = train_all(self.models_dir, self.datasets_dir, fast=fast, lstm_enabled=self.lstm_enabled,
                             progress=self._progress)
            self.load()
            if self.on_trained:
                self.on_trained(meta)
        except Exception as exc:
            log.exception("training failed")
            self.error = str(exc)
            self.status = prev if prev != "TRAINING" else "DEGRADED"
        finally:
            self.training_message = None

    def _progress(self, msg: str) -> None:
        self.training_message = msg
        log.info("training: %s", msg)

    def reset_state(self) -> None:
        with self._lock:
            if self.scorer:
                self.scorer.reset()

    # ------------------------------------------------------------------------------ inference
    def infer(self, values: Mapping[str, float], data: Mapping[str, Any], *, timestamp: str, sequence: int,
              quality_factor: float) -> dict[str, Any]:
        with self._lock:
            scorer = self.scorer
            if scorer is not None:
                return scorer.step(values, data, timestamp=timestamp, sequence=sequence, quality_factor=quality_factor)
        return rule_only_inference(data, timestamp, sequence, quality_factor)

    @property
    def model_version(self) -> str:
        return self.bundle.version if self.bundle else "rules-only"

    @property
    def latency_ms(self) -> float | None:
        return self.scorer.mean_latency_ms if self.scorer else None

    def models_loaded(self) -> list[str]:
        out = ["rule"]
        if self.bundle:
            out.append("mahalanobis")
            if self.bundle.iforest is not None:
                out.append("isolation_forest")
            if self.bundle.predictor is not None:
                out.append("lstm")
        return out


def rule_only_inference(data: Mapping[str, Any], timestamp: str, sequence: int, quality_factor: float) -> dict:
    """Fallback while no trained models exist (e.g. first start-up while auto-training runs)."""
    rules = fusion.rule_scores(data)
    score = max(rules.values()) if rules else 0.0
    ranked = sorted(((k, v) for k, v in rules.items() if v > 0), key=lambda kv: -kv[1])[:5]
    total = sum(v for _, v in ranked) or 1.0
    top = []
    for k, v in ranked:
        p = PARAM_BY_NAME[k]
        val = data.get(k)
        numeric = isinstance(val, (int, float))
        mid = ((p.nominal_min or 0) + (p.nominal_max or 0)) / 2 if numeric else 0.0
        top.append({"feature": k, "subsystem": p.subsystem, "unit": p.unit, "contribution": round(v / total, 4),
                    "observed": float(val) if numeric else 1.0, "expected": mid,
                    "prediction_error": (float(val) - mid) if numeric else 1.0, "z_score": 0.0})
    subs = []
    for t in top:
        if t["subsystem"] not in subs:
            subs.append(t["subsystem"])
    return {
        "timestamp": timestamp, "sequence": sequence, "anomaly_score": round(score, 4),
        "severity": fusion.severity_of(score),
        "confidence": fusion.confidence(score, {"rule": score}, quality_factor),
        "detectors": {"rule": round(score, 4), "mahalanobis": None, "isolation_forest": None, "lstm": None},
        "raw": {"mahalanobis_distance": None, "lstm_error": None, "isolation_forest_raw": None},
        "affected_subsystems": subs if score >= fusion.ALARM_THRESHOLD else [],
        "top_features": top, "model_version": "rules-only",
        "rule_by_feature": {k: round(v, 3) for k, v in rules.items() if v > 0},
    }
