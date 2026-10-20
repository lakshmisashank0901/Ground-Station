"""Safe simulated command & control."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import get_gs
from app.core.security import Principal, require_operator
from app.database import models as m
from app.database.repository import command_dict, log_system_event
from app.services import command_service
from app.services.ground_station import GroundStation

router = APIRouter(prefix="/commands", tags=["commands"])


class CommandBody(BaseModel):
    command: str = Field(min_length=1, max_length=64)
    target: str | None = Field(default=None, max_length=32)
    parameters: dict[str, Any] = Field(default_factory=dict)


@router.get("/catalog")
def catalog():
    return command_service.CATALOG


@router.post("", status_code=201)
def submit(body: CommandBody, principal: Principal = Depends(require_operator), gs: GroundStation = Depends(get_gs)):
    """Validate and queue a command; it only executes after POST /commands/{id}/confirm."""
    target = body.target or gs.settings.satellite_id
    command = body.command.strip().upper()
    with gs.db.session() as s:
        try:
            params = command_service.validate_command(command, target, body.parameters, gs.settings.satellite_id)
        except command_service.CommandValidationError as exc:
            s.add(m.Command(user=principal.name, command=command[:64], target=target, parameters=body.parameters,
                            status="REJECTED", result={"error": str(exc)}))
            log_system_event(s, "WARNING", "commands", f"{principal.name} command {command!r} rejected: {exc}")
            s.commit()
            raise HTTPException(422, str(exc))
        c = m.Command(user=principal.name, command=command, target=target, parameters=params,
                      status="PENDING_CONFIRMATION")
        s.add(c)
        s.flush()
        return command_dict(c)


@router.post("/{command_id}/confirm")
async def confirm(command_id: str, principal: Principal = Depends(require_operator), gs: GroundStation = Depends(get_gs)):
    with gs.db.session() as s:
        c = s.get(m.Command, command_id)
        if c is None:
            raise HTTPException(404, "command not found")
        if c.status != "PENDING_CONFIRMATION":
            raise HTTPException(409, f"command is {c.status}")
        command, params = c.command, dict(c.parameters or {})
        c.status, c.confirmed_at = "EXECUTING", datetime.now(timezone.utc)
    try:
        result, status = await command_service.execute(gs, command, params), "EXECUTED"
    except Exception as exc:
        result, status = {"error": str(exc)}, "FAILED"
    with gs.db.session() as s:
        c = s.get(m.Command, command_id)
        c.status, c.result = status, result
        log_system_event(s, "INFO" if status == "EXECUTED" else "WARNING", "commands",
                         f"{principal.name} executed {command}: {status}")
        return command_dict(c)


@router.post("/{command_id}/cancel")
def cancel(command_id: str, principal: Principal = Depends(require_operator), gs: GroundStation = Depends(get_gs)):
    with gs.db.session() as s:
        c = s.get(m.Command, command_id)
        if c is None:
            raise HTTPException(404, "command not found")
        if c.status != "PENDING_CONFIRMATION":
            raise HTTPException(409, f"command is {c.status}")
        c.status = "CANCELLED"
        return command_dict(c)


@router.get("/history")
def history(limit: int = Query(100, ge=1, le=1000), gs: GroundStation = Depends(get_gs)):
    with gs.db.session() as s:
        rows = s.scalars(select(m.Command).order_by(m.Command.timestamp.desc()).limit(limit)).all()
        return [command_dict(c) for c in rows]
