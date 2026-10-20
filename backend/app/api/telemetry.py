"""Telemetry ingestion and history."""
from __future__ import annotations

import csv
import io
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response

from app.api.deps import get_gs, parse_time
from app.core.security import require_operator
from app.database.repository import downsample, latest_telemetry_time, query_telemetry, telemetry_row
from app.services.ground_station import GroundStation
from app.telemetry.decoder import DecodeError, decode_json
from app.telemetry.schemas import PARAM_BY_NAME, PARAMETERS

router = APIRouter(prefix="/telemetry", tags=["telemetry"])


def _fields(fields: str | None) -> list[str] | None:
    if not fields:
        return None
    names = [f.strip() for f in fields.split(",") if f.strip()]
    unknown = [f for f in names if f not in PARAM_BY_NAME]
    if unknown:
        raise HTTPException(422, f"unknown fields: {', '.join(unknown)}")
    return names


@router.get("/schema")
def schema():
    return [p.to_dict() for p in PARAMETERS]


@router.post("", status_code=201, dependencies=[Depends(require_operator)])
async def ingest(request: Request, gs: GroundStation = Depends(get_gs)):
    """Ingest one telemetry packet (JSON). Same entry point for simulator, replay tools and future
    hardware gateways. Invalid packets are rejected with 422 and counted."""
    body = await request.body()
    try:
        packet = decode_json(body)
    except DecodeError as exc:
        gs.reject(str(exc))
        raise HTTPException(422, str(exc))
    return await gs.ingest(packet)


@router.post("/frame", status_code=201, dependencies=[Depends(require_operator)])
async def ingest_frame(request: Request, gs: GroundStation = Depends(get_gs)):
    """Ingest a framed binary packet (sync word + length + JSON + CRC-16), as a radio/serial gateway would."""
    result = await gs.ingest_frame(await request.body())
    if not result.get("accepted"):
        raise HTTPException(422, result.get("error", "corrupted frame"))
    return result


@router.get("/latest")
def latest(gs: GroundStation = Depends(get_gs)):
    if gs.latest_packet is None:
        raise HTTPException(404, "no telemetry received yet")
    return gs.latest_packet


def _window(gs: GroundStation, start: str | None, end: str | None, run_id: str | None):
    s, e = parse_time(start, "start"), parse_time(end, "end")
    if s is None and e is None:
        with gs.db.session() as sess:
            ref = latest_telemetry_time(sess, run_id)
        if ref is not None and not run_id:
            s = ref - timedelta(minutes=10)
    if s and e and e < s:
        raise HTTPException(422, "end must not be before start")
    return s, e


@router.get("/history")
def history(start: str | None = None, end: str | None = None, fields: str | None = None, run_id: str | None = None,
            limit: int = Query(5000, ge=1, le=200_000), max_points: int | None = Query(None, ge=2, le=50_000),
            gs: GroundStation = Depends(get_gs)):
    names = _fields(fields)
    s, e = _window(gs, start, end, run_id)
    with gs.db.session() as sess:
        rows = query_telemetry(sess, s, e, run_id, limit)
        items = [telemetry_row(r, names) for r in downsample(rows, max_points)]
    return {"count": len(items), "start": items[0]["timestamp"] if items else None,
            "end": items[-1]["timestamp"] if items else None, "items": items}


@router.get("/export")
def export(start: str | None = None, end: str | None = None, fields: str | None = None, run_id: str | None = None,
           gs: GroundStation = Depends(get_gs)):
    names = _fields(fields) or [p.name for p in PARAMETERS]
    s, e = _window(gs, start, end, run_id)
    with gs.db.session() as sess:
        rows = query_telemetry(sess, s, e, run_id, 200_000)
        out = io.StringIO()
        w = csv.writer(out)
        w.writerow(["timestamp", "sequence", "source", "quality", *names])
        for r in rows:
            d = telemetry_row(r, names)
            w.writerow([d["timestamp"], d["sequence"], d["source"], d["quality"], *[d["data"].get(n) for n in names]])
    return Response(out.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": 'attachment; filename="telemetry.csv"'})
