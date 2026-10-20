"""Ground-station self-monitoring."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select

from app.api.deps import get_gs
from app.database import models as m
from app.database.repository import system_event_dict
from app.services.ground_station import GroundStation

router = APIRouter(prefix="/system", tags=["system"])


@router.get("/status")
def status(gs: GroundStation = Depends(get_gs)):
    return gs.system_status()


@router.get("/events")
def events(limit: int = Query(100, ge=1, le=1000), level: str | None = None, gs: GroundStation = Depends(get_gs)):
    with gs.db.session() as s:
        q = select(m.SystemEvent)
        if level:
            q = q.where(m.SystemEvent.level == level.upper())
        rows = s.scalars(q.order_by(m.SystemEvent.timestamp.desc()).limit(limit)).all()
        return [system_event_dict(e) for e in rows]
