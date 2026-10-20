"""Anomaly event lifecycle and plain-language explanations.

Per-sample inference results are turned into persistent anomaly *events*:

* an event opens when the fused score stays ≥ 0.30 for ALARM_PERSISTENCE consecutive samples;
* while open it tracks the peak score, escalates severity and keeps the explanation from the peak;
* it closes (``ended_at``) after CLEAR_SAMPLES consecutive normal samples.

Operator state (ACTIVE → ACKNOWLEDGED → RESOLVED) is independent of whether the event has ended.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.database import models as m
from app.database.repository import anomaly_dict, as_utc
from app.ml.fusion import ALARM_PERSISTENCE, ALARM_THRESHOLD, severity_of
from app.telemetry.processor import iso
from app.telemetry.schemas import PARAM_BY_NAME

CLEAR_SAMPLES = 15
SEVERITY_ORDER = {"INFO": 0, "WARNING": 1, "HIGH": 2, "CRITICAL": 3}
DETECTOR_LABEL = {"rule": "rule/range check", "mahalanobis": "Mahalanobis multivariate detector",
                  "isolation_forest": "Isolation Forest baseline", "lstm": "LSTM temporal predictor"}


def event_severity(score: float) -> str:
    s = severity_of(score)
    return "INFO" if s == "NORMAL" else s


def _label(name: str) -> str:
    return PARAM_BY_NAME[name].label if name in PARAM_BY_NAME else name.replace("_", " ")


def _fmt(v: float | None, unit: str) -> str:
    if v is None:
        return "n/a"
    return f"{v:.2f} {unit}".strip()


def interpret(features: list[str], top: list[dict]) -> str:
    """Heuristic engineering interpretation of the contributing-feature pattern."""
    f = set(features[:4])
    z = {t["feature"]: (t.get("z_score") or 0.0) for t in top}
    if "watchdog_status" in f:
        return "The OBC watchdog reports a fault, indicating the processor stopped servicing its watchdog."
    if {"cpu_load", "memory_usage"} & f and ({"bus_current", "power_consumption", "obc_temperature"} & f):
        return ("Processing load and power draw are rising together with board temperature, which matches an "
                "OBC overload pattern.")
    if "obc_temperature" in f and z.get("cpu_load", 0.0) < 2.0:
        return ("OBC temperature is rising without a matching increase in CPU load or power, which points to a "
                "thermal-path problem rather than a workload change.")
    if {"snr", "rssi", "packet_loss", "crc_errors"} & f:
        return "Link quality is degrading: signal strength/SNR fall while frame loss and CRC errors rise."
    if {"solar_input_power", "bus_voltage"} & f or ("bus_current" in f and z.get("bus_voltage", 0.0) < -2.0):
        return ("Power generation or regulation is degrading: the solar input and bus voltage/current "
                "relationship no longer matches nominal behaviour.")
    if {"battery_temperature", "battery_voltage"} & f:
        return ("A battery measurement is diverging from the value implied by correlated parameters while the "
                "rest of the power system looks nominal, consistent with sensor drift or a battery fault.")
    if {"gyro_x", "gyro_y", "gyro_z", "roll", "pitch"} & f:
        return "A sudden attitude-rate disturbance was observed, consistent with a transient spike."
    return "The combination of parameter values deviates from learned normal operation."


def build_explanation(inf: dict[str, Any], thresholds: dict[str, float]) -> tuple[str, str]:
    top = inf.get("top_features", [])
    subs = ", ".join(inf.get("affected_subsystems") or sorted({t["subsystem"] for t in top}) or ["unknown"])
    sev = event_severity(inf["anomaly_score"])
    names = [t["feature"] for t in top]
    # Name only the features that carry a meaningful share of the anomaly (always at least the top one).
    named = [t["feature"] for t in top[:3] if t["contribution"] >= 0.10] or names[:1]
    description = f"{sev} {subs} anomaly: " + (", ".join(_label(n) for n in named) or "multivariate deviation")

    parts = [interpret(names, top)]
    for t in top[:3]:
        if t.get("observed") is None or t["feature"] not in PARAM_BY_NAME or PARAM_BY_NAME[t["feature"]].type == "enum":
            continue
        unit = t.get("unit", "")
        err = t["prediction_error"]
        parts.append(f"{_label(t['feature'])} is {_fmt(t['observed'], unit)} versus an expected {_fmt(t['expected'], unit)} "
                     f"({'+' if err >= 0 else ''}{err:.2f} {unit}, z = {t['z_score']:+.1f}; "
                     f"{t['contribution'] * 100:.0f}% of the anomaly).".replace(" ;", ";"))
    det = inf.get("detectors", {})
    raw = inf.get("raw", {})
    dbits = []
    if raw.get("mahalanobis_distance") is not None:
        dbits.append(f"Mahalanobis distance {raw['mahalanobis_distance']:.1f} "
                     f"(normal ≤ {thresholds.get('mahalanobis', 0):.1f})")
    if det.get("lstm") is not None:
        dbits.append(f"LSTM prediction-error score {det['lstm']:.2f}")
    if det.get("rule"):
        dbits.append(f"rule score {det['rule']:.2f}")
    agreeing = [DETECTOR_LABEL[k] for k, v in det.items() if v is not None and v >= ALARM_THRESHOLD]
    if dbits:
        parts.append("Evidence: " + "; ".join(dbits) + ".")
    if agreeing:
        parts.append(f"Detectors above threshold: {', '.join(agreeing)}.")
    parts.append(f"Fused anomaly score {inf['anomaly_score']:.2f} ({sev}), confidence {inf['confidence']:.2f}; "
                 f"affected subsystem(s): {subs}.")
    return description, " ".join(parts)


@dataclass
class _Open:
    id: str
    above_since: datetime
    below: int = 0


@dataclass
class AnomalyTracker:
    thresholds: dict[str, float] = field(default_factory=dict)
    above: int = 0
    onset: datetime | None = None
    current: _Open | None = None

    def reset(self) -> None:
        self.above = 0
        self.onset = None
        self.current = None

    def update(self, s: Session, ts: datetime, inf: dict[str, Any], *, satellite_id: str, run_id: str | None,
               faults: list[dict]) -> list[dict]:
        """Advance the event state machine with one inference. Returns WS events to broadcast."""
        score = inf["anomaly_score"]
        events: list[dict] = []
        if self.current is None:
            if score >= ALARM_THRESHOLD:
                self.above += 1
                if self.onset is None:
                    self.onset = ts
                if self.above >= ALARM_PERSISTENCE:
                    events.append(self._open(s, ts, inf, satellite_id, run_id, faults))
            else:
                self.above = 0
                self.onset = None
            return events

        a = s.get(m.Anomaly, self.current.id)
        if a is None:  # deleted underneath us (e.g. DB reset)
            self.reset()
            return events
        a.score = score
        a.sample_count += 1
        a.last_updated = datetime.now(timezone.utc)
        changed = False
        if score >= ALARM_THRESHOLD:
            self.current.below = 0
            if score > a.peak_score:
                # Attribution follows the peak, where the contributing-feature pattern is clearest.
                subs = inf.get("affected_subsystems") or list(a.subsystems or [])
                if subs != (a.subsystems or []):
                    a.subsystems = subs
                    changed = True
                new_sev = event_severity(score)
                if SEVERITY_ORDER[new_sev] > SEVERITY_ORDER[a.severity]:
                    a.severity = new_sev
                    changed = True
                a.peak_score = score
                a.confidence = inf["confidence"]
                a.detectors = inf["detectors"]
                a.raw = inf.get("raw")
                a.top_features = inf["top_features"]
                a.description, a.explanation = build_explanation(inf, self.thresholds)
                changed = changed or a.sample_count % 5 == 0
        else:
            self.current.below += 1
            if self.current.below >= CLEAR_SAMPLES:
                a.ended_at = ts
                self.current = None
                self.above = 0
                self.onset = None
                changed = True
        if changed:
            events.append({"type": "anomaly", "event": "updated", "anomaly": anomaly_dict(a)})
        return events

    def _open(self, s: Session, ts: datetime, inf: dict, satellite_id: str, run_id: str | None,
              faults: list[dict]) -> dict:
        description, explanation = build_explanation(inf, self.thresholds)
        onset = self.onset or ts
        injected = _match_fault(faults, onset)
        delay = None
        if injected is not None:
            delay = round((ts - injected["start_dt"]).total_seconds(), 1)
            injected = {k: v for k, v in injected.items() if k != "start_dt"}
        a = m.Anomaly(
            timestamp=ts, onset_time=onset, satellite_id=satellite_id,
            subsystems=inf.get("affected_subsystems") or [],
            severity=event_severity(inf["anomaly_score"]), score=inf["anomaly_score"],
            peak_score=inf["anomaly_score"], confidence=inf["confidence"], detectors=inf["detectors"],
            raw=inf.get("raw"), top_features=inf["top_features"], description=description,
            explanation=explanation, status="ACTIVE", detection_delay_s=delay, injected_fault=injected,
            run_id=run_id, sample_count=1, model_version=inf.get("model_version"),
        )
        s.add(a)
        s.flush()
        self.current = _Open(a.id, onset)
        return {"type": "anomaly", "event": "created", "anomaly": anomaly_dict(a)}


def _match_fault(faults: list[dict], onset: datetime) -> dict | None:
    """Most recent injected fault that started before the onset and is active or recently ended."""
    best = None
    for f in faults:
        start = f["start_dt"]
        end = start + timedelta(seconds=(f.get("duration_s") or 0) + 300)
        if start <= onset + timedelta(seconds=5) and onset <= end:
            if best is None or start > best["start_dt"]:
                best = f
    if best is None:
        return None
    return {"scenario": best["scenario"], "severity": best["severity"], "start_time": iso(best["start_dt"]),
            "start_dt": as_utc(best["start_dt"])}


def set_status(s: Session, anomaly_id: str, status: str, user: str, note: str | None) -> m.Anomaly | None:
    a = s.get(m.Anomaly, anomaly_id)
    if a is None:
        return None
    now = datetime.now(timezone.utc)
    if status == "ACKNOWLEDGED":
        if a.status == "RESOLVED":
            return a
        a.status, a.acknowledged_by, a.acknowledged_at = "ACKNOWLEDGED", user, now
    elif status == "RESOLVED":
        if a.acknowledged_at is None:
            a.acknowledged_by, a.acknowledged_at = user, now
        a.status, a.resolved_by, a.resolved_at = "RESOLVED", user, now
    if note:
        a.note = (a.note + "\n" if a.note else "") + f"[{user}] {note}"
    a.last_updated = now
    return a
