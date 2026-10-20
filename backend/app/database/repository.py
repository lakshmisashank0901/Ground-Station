"""Query helpers and ORM → API serialisers."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Iterable

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.database import models as m
from app.telemetry.processor import iso
from app.telemetry.schemas import PARAMETERS, PARAM_BY_NAME

PARAM_NAMES = [p.name for p in PARAMETERS]


def as_utc(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


# ----------------------------------------------------------------------------------- telemetry
def telemetry_row(t: m.Telemetry, fields: Iterable[str] | None = None) -> dict[str, Any]:
    names = list(fields) if fields else PARAM_NAMES
    return {
        "timestamp": iso(t.timestamp),
        "sequence": t.sequence,
        "source": t.source,
        "quality": t.quality,
        "data": {n: getattr(t, n) for n in names if n in PARAM_BY_NAME},
    }


def telemetry_packet(t: m.Telemetry) -> dict[str, Any]:
    row = telemetry_row(t)
    return {"type": "telemetry", "satellite_id": t.satellite_id, **row, "derived": t.derived or {},
            "field_quality": t.field_quality or {}, "run_id": t.run_id}


def query_telemetry(s: Session, start: datetime | None, end: datetime | None, run_id: str | None = None,
                    limit: int = 5000, satellite_id: str | None = None) -> list[m.Telemetry]:
    q = select(m.Telemetry)
    if satellite_id:
        q = q.where(m.Telemetry.satellite_id == satellite_id)
    if run_id:
        q = q.where(m.Telemetry.run_id == run_id)
    if start:
        q = q.where(m.Telemetry.timestamp >= start)
    if end:
        q = q.where(m.Telemetry.timestamp <= end)
    # Take the most recent `limit` rows of the window, returned ascending.
    rows = s.scalars(q.order_by(m.Telemetry.timestamp.desc(), m.Telemetry.id.desc()).limit(limit)).all()
    return list(reversed(rows))


def latest_telemetry_time(s: Session, run_id: str | None = None) -> datetime | None:
    q = select(func.max(m.Telemetry.timestamp))
    if run_id:
        q = q.where(m.Telemetry.run_id == run_id)
    return as_utc(s.scalar(q))


def downsample(items: list, max_points: int | None) -> list:
    if not max_points or len(items) <= max_points or max_points < 2:
        return items
    step = (len(items) - 1) / (max_points - 1)
    return [items[round(i * step)] for i in range(max_points)]


# ------------------------------------------------------------------------------------ anomalies
def anomaly_dict(a: m.Anomaly) -> dict[str, Any]:
    return {
        "id": a.id,
        "timestamp": iso(a.timestamp),
        "onset_time": iso(a.onset_time),
        "ended_at": iso(a.ended_at),
        "subsystems": a.subsystems or [],
        "severity": a.severity,
        "score": round(a.score, 4),
        "peak_score": round(a.peak_score, 4),
        "confidence": round(a.confidence, 3),
        "detectors": a.detectors or {},
        "raw": a.raw or {},
        "top_features": a.top_features or [],
        "description": a.description,
        "explanation": a.explanation,
        "status": a.status,
        "detection_delay_s": a.detection_delay_s,
        "injected_fault": a.injected_fault,
        "acknowledged_by": a.acknowledged_by,
        "acknowledged_at": iso(a.acknowledged_at),
        "resolved_by": a.resolved_by,
        "resolved_at": iso(a.resolved_at),
        "note": a.note,
        "run_id": a.run_id,
        "sample_count": a.sample_count,
        "model_version": a.model_version,
    }


def query_anomalies(s: Session, *, status: str | None = None, severity: str | None = None,
                    subsystem: str | None = None, start: datetime | None = None, end: datetime | None = None,
                    run_id: str | None = None, limit: int = 200) -> list[m.Anomaly]:
    q = select(m.Anomaly)
    if status:
        q = q.where(m.Anomaly.status.in_([x.strip().upper() for x in status.split(",")]))
    if severity:
        q = q.where(m.Anomaly.severity.in_([x.strip().upper() for x in severity.split(",")]))
    if start:
        q = q.where(m.Anomaly.timestamp >= start)
    if end:
        q = q.where(m.Anomaly.timestamp <= end)
    if run_id:
        q = q.where(m.Anomaly.run_id == run_id)
    rows = s.scalars(q.order_by(m.Anomaly.timestamp.desc())).all()
    if subsystem:
        sub = subsystem.upper()
        rows = [r for r in rows if sub in [x.upper() for x in (r.subsystems or [])]]
    return rows[:limit]


# ---------------------------------------------------------------------------------- other rows
def health_row(h: m.HealthScore) -> dict[str, Any]:
    return {
        "timestamp": iso(h.timestamp),
        "overall_score": round(h.overall_score, 2),
        "anomaly_score": round(h.anomaly_score, 4),
        "severity": h.severity,
        "detectors": h.detectors or {},
        "subsystems": {"eps": h.eps, "obc": h.obc, "adcs": h.adcs, "comm": h.comm, "payload": h.payload},
    }


def command_dict(c: m.Command) -> dict[str, Any]:
    return {"id": c.id, "timestamp": iso(c.timestamp), "user": c.user, "command": c.command, "target": c.target,
            "parameters": c.parameters or {}, "status": c.status, "result": c.result,
            "confirmed_at": iso(c.confirmed_at)}


def run_dict(r: m.SimulationRun, anomaly_count: int = 0) -> dict[str, Any]:
    return {"id": r.id, "name": r.name, "scenario": r.scenario, "start_time": iso(r.start_time),
            "end_time": iso(r.end_time), "speed": r.speed, "status": r.status, "seed": r.seed,
            "packet_count": r.packet_count, "anomaly_count": anomaly_count}


def event_dict(e: m.SimulationEvent) -> dict[str, Any]:
    return {"timestamp": iso(e.timestamp), "event_type": e.event_type, "parameters": e.parameters or {}}


def system_event_dict(e: m.SystemEvent) -> dict[str, Any]:
    return {"timestamp": iso(e.timestamp), "level": e.level, "component": e.component, "message": e.message}


def log_system_event(s: Session, level: str, component: str, message: str) -> None:
    s.add(m.SystemEvent(level=level, component=component, message=message))
