"""Backend health, satellite metadata/status and health history."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select

from app.api.deps import get_gs, parse_time
from app.database import models as m
from app.database.repository import downsample, health_row
from app.services.ground_station import GroundStation
from app.simulation.spacecraft import ORBIT_PERIOD_S
from app.telemetry.processor import iso
from app.telemetry.schemas import SUBSYSTEMS

router = APIRouter(tags=["health"])


@router.get("/health")
def health(gs: GroundStation = Depends(get_gs)):
    return {"status": "ok", "version": gs.settings.version, "time": iso(datetime.now(timezone.utc)),
            "database": "ONLINE" if gs.db.ping() is not None else "OFFLINE", "ml": gs.ml.status}


@router.get("/satellite")
def satellite(gs: GroundStation = Depends(get_gs)):
    with gs.db.session() as s:
        sat = s.get(m.Satellite, gs.settings.satellite_id)
        created = iso(sat.created_at) if sat else None
    return {"id": gs.settings.satellite_id, "name": gs.settings.satellite_name, "mission": gs.settings.mission_id,
            "orbit": {"altitude_km": 520, "inclination_deg": 97.5, "period_s": ORBIT_PERIOD_S},
            "subsystems": list(SUBSYSTEMS), "mode": gs.mode(), "created_at": created}


@router.get("/satellite/status")
def satellite_status(gs: GroundStation = Depends(get_gs)):
    return gs.satellite_status()


@router.get("/health/history")
def health_history(start: str | None = None, end: str | None = None, run_id: str | None = None,
                   max_points: int = Query(1000, ge=2, le=20000), gs: GroundStation = Depends(get_gs)):
    s_, e_ = parse_time(start, "start"), parse_time(end, "end")
    with gs.db.session() as s:
        q = select(m.HealthScore)
        if run_id:
            q = q.where(m.HealthScore.run_id == run_id)
        if s_ is None and e_ is None and not run_id:
            latest = s.scalar(select(m.HealthScore.timestamp).order_by(m.HealthScore.timestamp.desc()).limit(1))
            if latest is not None:
                s_ = latest - timedelta(minutes=10)
        if s_:
            q = q.where(m.HealthScore.timestamp >= s_)
        if e_:
            q = q.where(m.HealthScore.timestamp <= e_)
        rows = list(reversed(s.scalars(q.order_by(m.HealthScore.timestamp.desc()).limit(50_000)).all()))
        return {"items": [health_row(h) for h in downsample(rows, max_points)]}
