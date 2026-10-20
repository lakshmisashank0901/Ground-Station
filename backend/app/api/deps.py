"""Shared API dependencies."""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import HTTPException, Request

from app.services.ground_station import GroundStation


def get_gs(request: Request) -> GroundStation:
    return request.app.state.gs


def parse_time(value: str | None, name: str) -> datetime | None:
    if value is None or value == "":
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(422, f"{name} must be an ISO-8601 timestamp")
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)
