"""Overall and per-subsystem health scoring."""
from __future__ import annotations

from collections import deque
from typing import Any, Mapping

from app.telemetry.schemas import PARAM_BY_NAME, SUBSYSTEM_KEY_VALUES, SUBSYSTEM_PARAMS, SUBSYSTEMS, Quality

# Data-quality penalties (0–1 risk) applied per subsystem when its fields are degraded.
QUALITY_RISK = {Quality.MISSING.value: 0.35, Quality.CORRUPTED.value: 0.5, Quality.STALE.value: 0.3,
                Quality.OUT_OF_RANGE.value: 0.0, Quality.SUSPECT.value: 0.0}


def status_from_health(score: float | None) -> str:
    """Health 0–100 → status, using the anomaly-score bands on (1 - health/100)."""
    if score is None:
        return "UNKNOWN"
    risk = 1.0 - score / 100.0
    if risk >= 0.80:
        return "CRITICAL"
    if risk >= 0.60:
        return "HIGH"
    if risk >= 0.30:
        return "WARNING"
    return "NOMINAL"


def subsystem_risks(inference: Mapping[str, Any] | None, field_quality: Mapping[str, str],
                    packet_quality: str) -> dict[str, float]:
    """Risk 0–1 per subsystem from rule exceedances, the fused ML score attributed through the top
    contributing features, and data quality."""
    risks = {sid: 0.0 for sid in SUBSYSTEMS}
    rule_by_feature = (inference or {}).get("rule_by_feature", {})
    fused = (inference or {}).get("anomaly_score", 0.0) or 0.0
    share: dict[str, float] = {sid: 0.0 for sid in SUBSYSTEMS}
    for f in (inference or {}).get("top_features", []):
        sid = f["subsystem"].lower()
        if sid in share:
            share[sid] += f["contribution"]
    top_share = max(share.values()) if share else 0.0
    for sid, params in SUBSYSTEM_PARAMS.items():
        rule_risk = max((rule_by_feature.get(p, 0.0) for p in params), default=0.0)
        # The subsystem carrying most of the explanation inherits the fused score; others proportionally.
        ml_risk = fused * (share[sid] / top_share) if top_share > 0 else 0.0
        q_risk = max((QUALITY_RISK.get(field_quality.get(p, "VALID"), 0.0) for p in params), default=0.0)
        risks[sid] = min(1.0, max(rule_risk, ml_risk, q_risk))
    if packet_quality in (Quality.STALE.value, Quality.CORRUPTED.value):
        for sid in risks:
            risks[sid] = max(risks[sid], QUALITY_RISK[packet_quality])
    return risks


class HealthService:
    def __init__(self) -> None:
        self.history: deque[float] = deque(maxlen=120)
        self.latest: dict[str, Any] | None = None

    def reset(self) -> None:
        self.history.clear()

    def trend(self) -> str:
        if len(self.history) < 20:
            return "flat"
        h = list(self.history)
        recent = sum(h[-10:]) / 10
        older = sum(h[:10]) / 10
        if recent - older > 3:
            return "up"
        if older - recent > 3:
            return "down"
        return "flat"

    def compute(self, timestamp: str, data: Mapping[str, Any], inference: Mapping[str, Any] | None,
                field_quality: Mapping[str, str], packet_quality: str,
                active_by_subsystem: Mapping[str, int]) -> dict[str, Any]:
        risks = subsystem_risks(inference, field_quality, packet_quality)
        subsystems = []
        for sid, meta in SUBSYSTEMS.items():
            score = round(100.0 * (1.0 - risks[sid]), 1)
            subsystems.append({
                "id": sid, "name": meta["name"], "status": status_from_health(score), "health_score": score,
                "key_values": {k: data.get(k) for k in SUBSYSTEM_KEY_VALUES[sid]},
                "active_anomalies": int(active_by_subsystem.get(meta["name"], 0)),
            })
        scores = [s["health_score"] for s in subsystems]
        fused = (inference or {}).get("anomaly_score", 0.0) or 0.0
        overall = min(0.5 * min(scores) + 0.5 * sum(scores) / len(scores), 100.0 * (1.0 - fused))
        overall = round(overall, 1)
        self.history.append(overall)
        self.latest = {
            "type": "health",
            "timestamp": timestamp,
            "overall_score": overall,
            "status": status_from_health(overall),
            "trend": self.trend(),
            "anomaly_score": round(fused, 4),
            "subsystems": subsystems,
            "inference": _public_inference(inference),
        }
        return self.latest


def _public_inference(inference: Mapping[str, Any] | None) -> dict | None:
    if inference is None:
        return None
    return {k: v for k, v in inference.items() if k != "rule_by_feature"}


def parameter_label(name: str) -> str:
    return PARAM_BY_NAME[name].label if name in PARAM_BY_NAME else name
