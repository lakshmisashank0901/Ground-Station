"""ML model status, metrics and retraining."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy import select

from app.api.deps import get_gs
from app.core.security import require_operator
from app.database import models as m
from app.ml import fusion
from app.services.ground_station import GroundStation

router = APIRouter(prefix="/models", tags=["models"])


@router.get("")
def list_models(gs: GroundStation = Depends(get_gs)):
    b = gs.ml.bundle
    meta = b.metadata if b else {}
    ev = meta.get("evaluation", {}).get("detectors", {})
    weights = b.weights if b else {"rule": 1.0}
    th = b.thresholds if b else {}
    training = gs.ml.is_training
    feats = meta.get("features", [])

    def status(loaded: bool) -> str:
        if training and not loaded:
            return "TRAINING"
        return "LOADED" if loaded else "NOT_TRAINED"

    def metrics(name: str) -> dict:
        d = ev.get(name, {})
        return {k: d[k] for k in ("precision", "recall", "f1", "false_positive_rate", "event_detection_rate",
                                  "mean_detection_delay_s") if k in d and d[k] is not None}

    common = {"version": meta.get("version", "rules-only"), "trained_at": meta.get("trained_at"),
              "training_dataset": meta.get("training_dataset"), "feature_set": feats}
    lstm_meta = meta.get("lstm", {})
    return [
        {"name": "rule", **common, "version": "1.0", "status": "LOADED", "backend": "range/limit checks",
         "trained_at": None, "training_dataset": None, "feature_set": [],
         "thresholds": {"alarm": fusion.ALARM_THRESHOLD}, "metrics": metrics("rule"),
         "fusion_weight": weights.get("rule", 0.0)},
        {"name": "mahalanobis", **common, "status": status(b is not None), "backend": "numpy (Ledoit-Wolf covariance)",
         "thresholds": {"distance": th.get("mahalanobis")} if th else {}, "metrics": metrics("mahalanobis"),
         "fusion_weight": weights.get("mahalanobis", 0.0)},
        {"name": "isolation_forest", **common,
         "status": status(b is not None and b.iforest is not None), "backend": "scikit-learn IsolationForest",
         "thresholds": {"score": th.get("isolation_forest")} if th else {}, "metrics": metrics("isolation_forest"),
         "fusion_weight": weights.get("isolation_forest", 0.0)},
        {"name": "lstm", **common, "status": status(b is not None and b.predictor is not None),
         "backend": lstm_meta.get("backend", "keras-lstm"),
         "thresholds": {"short_term": th.get("lstm_short"), "bias": th.get("lstm_bias")} if th else {},
         "metrics": {**metrics("lstm"), **{k: lstm_meta[k] for k in ("val_loss", "epochs") if k in lstm_meta}},
         "fusion_weight": weights.get("lstm", 0.0)},
        {"name": "fusion", **common, "status": "LOADED", "backend": "weighted fusion with max-floor",
         "thresholds": {"warning": 0.3, "high": 0.6, "critical": 0.8}, "metrics": metrics("fused"),
         "fusion_weight": 1.0},
    ]


@router.get("/metrics")
def model_metrics(gs: GroundStation = Depends(get_gs)):
    b = gs.ml.bundle
    if b is None:
        return {"evaluated_at": None, "dataset": None, "detectors": {}, "per_scenario": {},
                "inference_latency_ms": {"mean": gs.ml.latency_ms, "p95": None},
                "fusion": {"weights": {"rule": 1.0}, "floor_gain": 1.0}, "thresholds": {}}
    ev = b.metadata.get("evaluation", {})
    lat = sorted(gs.ml.scorer.latencies) if gs.ml.scorer and gs.ml.scorer.latencies else []
    return {
        "evaluated_at": ev.get("evaluated_at"), "dataset": ev.get("dataset"),
        "detectors": ev.get("detectors", {}), "per_scenario": ev.get("per_scenario", {}),
        "inference_latency_ms": {"mean": gs.ml.latency_ms if lat else ev.get("inference_latency_ms", {}).get("mean"),
                                 "p95": round(lat[int(0.95 * (len(lat) - 1))], 3) if lat else None,
                                 "offline_mean": ev.get("inference_latency_ms", {}).get("mean")},
        "fusion": b.metadata.get("fusion", {}), "thresholds": b.thresholds,
        "model_version": b.version, "training_time_s": b.metadata.get("training_time_s"),
    }


@router.get("/versions")
def versions(gs: GroundStation = Depends(get_gs)):
    with gs.db.session() as s:
        rows = s.scalars(select(m.ModelVersion).order_by(m.ModelVersion.created_at.desc()).limit(50)).all()
        return [{"name": r.name, "version": r.version, "active": r.active, "created_at": r.created_at,
                 "feature_set": r.feature_set, "thresholds": r.thresholds} for r in rows]


@router.get("/inference/latest")
def latest_inference(gs: GroundStation = Depends(get_gs)):
    if gs.latest_inference is None:
        raise HTTPException(404, "no inference yet")
    return gs.latest_inference


@router.post("/retrain", status_code=202, dependencies=[Depends(require_operator)])
def retrain(full: bool = False, gs: GroundStation = Depends(get_gs)):
    if not gs.ml.train_async(fast=not full):
        return JSONResponse({"status": "TRAINING", "detail": "training already in progress"}, status_code=409)
    return {"status": "TRAINING"}
