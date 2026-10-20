"""Mission reports."""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import get_gs, parse_time
from app.database import models as m
from app.services import report_service
from app.services.ground_station import GroundStation

router = APIRouter(prefix="/reports", tags=["reports"])


class GenerateBody(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    start: str | None = None
    end: str | None = None
    run_id: str | None = None


@router.get("")
def list_reports(gs: GroundStation = Depends(get_gs)):
    with gs.db.session() as s:
        rows = s.scalars(select(m.Report).order_by(m.Report.created_at.desc()).limit(200)).all()
        return [report_service.report_summary_row(r) for r in rows]


@router.post("/generate", status_code=201)
def generate(body: GenerateBody | None = None, gs: GroundStation = Depends(get_gs)):
    body = body or GenerateBody()
    with gs.db.session() as s:
        try:
            r = report_service.generate_report(
                s, title=body.title, start=parse_time(body.start, "start"), end=parse_time(body.end, "end"),
                run_id=body.run_id, mission_id=gs.settings.mission_id, satellite_id=gs.settings.satellite_id,
                model_version=gs.ml.model_version, sample_interval_s=gs.settings.sample_interval_s)
        except LookupError as exc:
            raise HTTPException(404, str(exc))
        except ValueError as exc:
            raise HTTPException(422, str(exc))
        return r.content


@router.get("/{report_id}")
def get_report(report_id: str, gs: GroundStation = Depends(get_gs)):
    with gs.db.session() as s:
        r = s.get(m.Report, report_id)
        if r is None:
            raise HTTPException(404, "report not found")
        return r.content


@router.get("/{report_id}/download")
def download(report_id: str, format: str = Query("html", pattern="^(html|json|csv)$"),
             gs: GroundStation = Depends(get_gs)):
    with gs.db.session() as s:
        r = s.get(m.Report, report_id)
        if r is None:
            raise HTTPException(404, "report not found")
        content = r.content
    name = f"report-{report_id}.{format}"
    headers = {"Content-Disposition": f'attachment; filename="{name}"'}
    if format == "json":
        return Response(json.dumps(content, indent=2), media_type="application/json", headers=headers)
    if format == "csv":
        return Response(report_service.report_csv(content), media_type="text/csv", headers=headers)
    return Response(report_service.report_html(content), media_type="text/html", headers=headers)
