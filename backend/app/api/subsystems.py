"""Subsystem health."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.api.deps import get_gs
from app.database.repository import anomaly_dict, query_anomalies
from app.services.ground_station import GroundStation
from app.telemetry.schemas import PARAM_BY_NAME, SUBSYSTEM_PARAMS, SUBSYSTEMS

router = APIRouter(prefix="/subsystems", tags=["subsystems"])


@router.get("")
def list_subsystems(gs: GroundStation = Depends(get_gs)):
    return gs.satellite_status()["subsystems"]


@router.get("/{subsystem_id}")
def subsystem(subsystem_id: str, gs: GroundStation = Depends(get_gs)):
    sid = subsystem_id.lower()
    if sid not in SUBSYSTEMS:
        raise HTTPException(404, f"unknown subsystem {subsystem_id!r}")
    base = next(x for x in gs.satellite_status()["subsystems"] if x["id"] == sid)
    pkt = gs.latest_packet or {}
    data, fq = pkt.get("data", {}), pkt.get("field_quality", {})
    params = []
    for name in SUBSYSTEM_PARAMS[sid]:
        p = PARAM_BY_NAME[name]
        params.append({"name": name, "label": p.label, "unit": p.unit, "value": data.get(name),
                       "quality": fq.get(name, "VALID" if name in data else "MISSING"),
                       "nominal_min": p.nominal_min, "nominal_max": p.nominal_max,
                       "limit_min": p.limit_min, "limit_max": p.limit_max})
    with gs.db.session() as s:
        anomalies = [anomaly_dict(a) for a in query_anomalies(s, subsystem=SUBSYSTEMS[sid]["name"], limit=20)]
    return {**base, "description": SUBSYSTEMS[sid]["description"], "parameters": params, "anomalies": anomalies}
