"""Simulation control, fault injection and replay."""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import get_gs, parse_time
from app.core.security import require_operator
from app.database import models as m
from app.database.repository import event_dict, run_dict
from app.services.ground_station import GroundStation
from app.simulation.scenarios import SCENARIOS

router = APIRouter(tags=["simulation"])
op = [Depends(require_operator)]


class StartBody(BaseModel):
    speed: float | None = None
    run_name: str | None = Field(default=None, max_length=128)


class SpeedBody(BaseModel):
    speed: float


class ScenarioBody(BaseModel):
    scenario: str
    severity: Literal["mild", "moderate", "severe"] = "moderate"
    start_delay_s: float = 0.0
    duration_s: float | None = None


class OverrideBody(BaseModel):
    parameter: str
    value: float | None
    duration_s: float | None = Field(default=None, gt=0, le=7200)


class ReplayBody(BaseModel):
    run_id: str
    start: str | None = None
    end: str | None = None
    speed: float = 1.0


class StepBody(BaseModel):
    steps: int = Field(default=1, ge=-10_000, le=10_000)


class SeekBody(BaseModel):
    timestamp: str


def _bad(exc: Exception):
    raise HTTPException(422, str(exc))


@router.get("/simulation/scenarios")
def scenarios():
    return SCENARIOS


@router.get("/simulation/status")
def status(gs: GroundStation = Depends(get_gs)):
    return gs.simulation_status()


@router.post("/simulation/start", dependencies=op)
async def start(body: StartBody | None = None, gs: GroundStation = Depends(get_gs)):
    body = body or StartBody()
    try:
        await gs.start_simulation(speed=body.speed, run_name=body.run_name)
    except ValueError as exc:
        _bad(exc)
    return gs.simulation_status()


@router.post("/simulation/stop", dependencies=op)
async def stop(gs: GroundStation = Depends(get_gs)):
    await gs.replay.stop(resume_sim=False)
    await gs.sim.stop()
    return gs.simulation_status()


@router.post("/simulation/pause", dependencies=op)
async def pause(gs: GroundStation = Depends(get_gs)):
    await gs.sim.pause()
    return gs.simulation_status()


@router.post("/simulation/resume", dependencies=op)
async def resume(gs: GroundStation = Depends(get_gs)):
    if gs.replay.active:
        await gs.replay.stop(resume_sim=False)
    await gs.sim.resume()
    return gs.simulation_status()


@router.post("/simulation/reset", dependencies=op)
async def reset(gs: GroundStation = Depends(get_gs)):
    await gs.reset_simulation()
    return gs.simulation_status()


@router.post("/simulation/speed", dependencies=op)
async def speed(body: SpeedBody, gs: GroundStation = Depends(get_gs)):
    try:
        await gs.sim.set_speed(body.speed)
    except ValueError as exc:
        _bad(exc)
    return gs.simulation_status()


@router.post("/simulation/scenario", dependencies=op)
async def scenario(body: ScenarioBody, gs: GroundStation = Depends(get_gs)):
    try:
        await gs.sim.inject(body.scenario, body.severity, body.start_delay_s, body.duration_s)
    except ValueError as exc:
        _bad(exc)
    return gs.simulation_status()


@router.post("/simulation/override", dependencies=op)
async def override(body: OverrideBody, gs: GroundStation = Depends(get_gs)):
    try:
        await gs.sim.set_override(body.parameter, body.value, body.duration_s)
    except ValueError as exc:
        _bad(exc)
    return gs.simulation_status()


@router.get("/simulation/runs")
def runs(gs: GroundStation = Depends(get_gs)):
    return gs.run_list()


@router.get("/simulation/runs/{run_id}")
def run_detail(run_id: str, gs: GroundStation = Depends(get_gs)):
    with gs.db.session() as s:
        r = s.get(m.SimulationRun, run_id)
        if r is None:
            raise HTTPException(404, "run not found")
        events = s.scalars(select(m.SimulationEvent).where(m.SimulationEvent.run_id == run_id)
                           .order_by(m.SimulationEvent.timestamp)).all()
        out = run_dict(r)
        out["events"] = [event_dict(e) for e in events]
    for x in gs.run_list():
        if x["id"] == run_id:
            out["packet_count"], out["anomaly_count"] = x["packet_count"], x["anomaly_count"]
    return out


# ------------------------------------------------------------------------------------- replay
@router.post("/replay/start", dependencies=op)
async def replay_start(body: ReplayBody, gs: GroundStation = Depends(get_gs)):
    try:
        await gs.replay.start(body.run_id, parse_time(body.start, "start"), parse_time(body.end, "end"), body.speed)
    except LookupError as exc:
        raise HTTPException(404, str(exc))
    except ValueError as exc:
        _bad(exc)
    return gs.simulation_status()


def _need_replay(gs: GroundStation):
    if not gs.replay.active:
        raise HTTPException(409, "no replay active")


@router.post("/replay/pause", dependencies=op)
async def replay_pause(gs: GroundStation = Depends(get_gs)):
    _need_replay(gs)
    await gs.replay.pause()
    return gs.simulation_status()


@router.post("/replay/resume", dependencies=op)
async def replay_resume(gs: GroundStation = Depends(get_gs)):
    _need_replay(gs)
    await gs.replay.resume()
    return gs.simulation_status()


@router.post("/replay/stop", dependencies=op)
async def replay_stop(gs: GroundStation = Depends(get_gs)):
    await gs.replay.stop()
    return gs.simulation_status()


@router.post("/replay/step", dependencies=op)
async def replay_step(body: StepBody | None = None, gs: GroundStation = Depends(get_gs)):
    _need_replay(gs)
    await gs.replay.step((body or StepBody()).steps)
    return gs.simulation_status()


@router.post("/replay/seek", dependencies=op)
async def replay_seek(body: SeekBody, gs: GroundStation = Depends(get_gs)):
    _need_replay(gs)
    await gs.replay.seek(parse_time(body.timestamp, "timestamp"))
    return gs.simulation_status()


@router.post("/replay/speed", dependencies=op)
async def replay_speed(body: SpeedBody, gs: GroundStation = Depends(get_gs)):
    _need_replay(gs)
    try:
        await gs.replay.set_speed(body.speed)
    except ValueError as exc:
        _bad(exc)
    return gs.simulation_status()
