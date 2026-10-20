"""Score normalisation, rule checks, fusion, severity and confidence."""
from __future__ import annotations

import math
from typing import Mapping

from app.telemetry.schemas import PARAM_BY_NAME, PARAMETERS

# Starting fusion weights from the specification (8.5). Isolation Forest is a comparison baseline and
# does not vote by default. Weights may be re-tuned on validation data by training/evaluate.py.
DEFAULT_WEIGHTS = {"rule": 0.25, "mahalanobis": 0.30, "lstm": 0.45, "isolation_forest": 0.0}
# A weighted average dilutes a single confident detector (e.g. a pure communication fault seen only by
# the rule detector). The fused score is therefore floored at FLOOR_GAIN × the strongest detector.
DEFAULT_FLOOR_GAIN = 0.75

SEVERITY_BANDS = [(0.80, "CRITICAL"), (0.60, "HIGH"), (0.30, "WARNING"), (0.0, "NORMAL")]
ALARM_THRESHOLD = 0.30
ALARM_PERSISTENCE = 3  # consecutive samples ≥ threshold before an alarm/event is raised

_K = -math.log(1 - ALARM_THRESHOLD)  # normalised score reaches the WARNING boundary at the calibrated threshold


def normalize(raw: float | None, threshold: float | None) -> float | None:
    """Map a raw detector statistic to 0–1 so that score(threshold) = 0.30 (WARNING boundary).

    s = 1 - exp(-k (x/t)^2): normal data (below the 99.9 % validation quantile) stays < 0.3,
    2× the threshold gives ≈ 0.76 (HIGH), 3× gives ≈ 0.96 (CRITICAL).
    """
    if raw is None or threshold is None or threshold <= 0:
        return None
    r = max(0.0, raw) / threshold
    return float(1.0 - math.exp(-_K * r * r))


def severity_of(score: float) -> str:
    for bound, label in SEVERITY_BANDS:
        if score >= bound:
            return label
    return "NORMAL"


def rule_score_for(name: str, value) -> float:
    """0 inside the nominal band, 0.15 → 1.0 between the nominal edge and the hard limit, 1 beyond."""
    p = PARAM_BY_NAME[name]
    if value is None:
        return 0.0
    if p.type == "enum":
        if name == "watchdog_status" and value == "FAULT":
            return 0.9
        if name == "payload_state" and value == "SAFE":
            return 0.35
        return 0.0
    v = float(value)
    if p.nominal_min is not None and v < p.nominal_min:
        edge, lim = p.nominal_min, p.limit_min
    elif p.nominal_max is not None and v > p.nominal_max:
        edge, lim = p.nominal_max, p.limit_max
    else:
        return 0.0
    if lim is None or lim == edge:
        return 0.5
    frac = abs(v - edge) / abs(lim - edge)
    if frac >= 1.0:
        return 1.0
    return 0.15 + 0.85 * frac ** 0.7


def rule_scores(data: Mapping[str, object]) -> dict[str, float]:
    return {p.name: rule_score_for(p.name, data.get(p.name)) for p in PARAMETERS}


def fuse(scores: Mapping[str, float | None], weights: Mapping[str, float] = DEFAULT_WEIGHTS,
         floor_gain: float = DEFAULT_FLOOR_GAIN) -> float:
    """Weighted fusion over the detectors that are available, re-normalising the weights."""
    avail = {k: v for k, v in scores.items() if v is not None and weights.get(k, 0.0) > 0}
    if not avail:
        return 0.0
    wsum = sum(weights[k] for k in avail)
    weighted = sum(weights[k] * v for k, v in avail.items()) / wsum
    return float(min(1.0, max(weighted, floor_gain * max(avail.values()))))


def confidence(fused: float, scores: Mapping[str, float | None], quality_factor: float = 1.0) -> float:
    """Agreement-based confidence in the current classification (anomalous or normal)."""
    vals = [v for v in scores.values() if v is not None]
    if not vals:
        return 0.0
    if fused >= ALARM_THRESHOLD:
        agree = sum(v >= ALARM_THRESHOLD for v in vals) / len(vals)
        margin = min(1.0, (fused - ALARM_THRESHOLD) / 0.5)
        c = 0.45 + 0.4 * agree + 0.15 * margin
    else:
        agree = sum(v < ALARM_THRESHOLD for v in vals) / len(vals)
        margin = 1.0 - fused / ALARM_THRESHOLD
        c = 0.5 + 0.3 * agree + 0.2 * margin
    return round(max(0.0, min(1.0, c * quality_factor)), 3)
