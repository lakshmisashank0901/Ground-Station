"""Anomaly listing, investigation and operator actions."""
from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import get_gs, parse_time
from app.core.security import Principal, require_operator
from app.database import models as m
from app.database.repository import anomaly_dict, as_utc, query_anomalies, telemetry_row
from app.services.ground_station import GroundStation
from app.telemetry.processor import iso

router = APIRouter(prefix="/anomalies", tags=["anomalies"])


class StatusChange(BaseModel):
    user: str | None = Field(default=None, max_length=64)
    note: str | None = Field(default=None, max_length=1000)


@router.get("")
def list_anomalies(status: str | None = None, severity: str | None = None, subsystem: str | None = None,
                   start: str | None = None, end: str | None = None, run_id: str | None = None,
                   limit: int = Query(200, ge=1, le=2000), gs: GroundStation = Depends(get_gs)):
    with gs.db.session() as s:
        rows = query_anomalies(s, status=status, severity=severity, subsystem=subsystem,
                               start=parse_time(start, "start"), end=parse_time(end, "end"), run_id=run_id, limit=limit)
        return [anomaly_dict(a) for a in rows]


@router.get("/{anomaly_id}")
def get_anomaly(anomaly_id: str, gs: GroundStation = Depends(get_gs)):
    with gs.db.session() as s:
        a = s.get(m.Anomaly, anomaly_id)
        if a is None:
            raise HTTPException(404, "anomaly not found")
        out = anomaly_dict(a)
        lo = as_utc(a.onset_time) - timedelta(seconds=120)
        hi = (as_utc(a.ended_at) if a.ended_at else as_utc(a.timestamp)) + timedelta(seconds=120)
        fields = [f["feature"] for f in (a.top_features or []) if f["feature"] != "payload_active"]
        tq = select(m.Telemetry).where(m.Telemetry.timestamp.between(lo, hi))
        hq = select(m.HealthScore).where(m.HealthScore.timestamp.between(lo, hi))
        if a.run_id:
            tq = tq.where(m.Telemetry.run_id == a.run_id)
            hq = hq.where(m.HealthScore.run_id == a.run_id)
        rows = s.scalars(tq.order_by(m.Telemetry.timestamp).limit(3000)).all()
        out["context"] = [telemetry_row(r, fields or None) for r in rows]
        out["score_trace"] = [{"timestamp": iso(h.timestamp), "anomaly_score": h.anomaly_score,
                               **{k: (h.detectors or {}).get(k) for k in ("rule", "mahalanobis", "isolation_forest", "lstm")}}
                              for h in s.scalars(hq.order_by(m.HealthScore.timestamp).limit(3000))]
        return out


@router.post("/{anomaly_id}/acknowledge")
async def acknowledge(anomaly_id: str, body: StatusChange | None = None,
                      principal: Principal = Depends(require_operator), gs: GroundStation = Depends(get_gs)):
    body = body or StatusChange()
    out = await gs.set_anomaly_status(anomaly_id, "ACKNOWLEDGED", body.user or principal.name, body.note)
    if out is None:
        raise HTTPException(404, "anomaly not found")
    return out


@router.post("/{anomaly_id}/resolve")
async def resolve(anomaly_id: str, body: StatusChange | None = None,
                  principal: Principal = Depends(require_operator), gs: GroundStation = Depends(get_gs)):
    body = body or StatusChange()
    out = await gs.set_anomaly_status(anomaly_id, "RESOLVED", body.user or principal.name, body.note)
    if out is None:
        raise HTTPException(404, "anomaly not found")
    return out
