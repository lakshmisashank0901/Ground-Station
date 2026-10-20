"""Safe command simulation (spec section 10).

Commands are validated against a fixed catalogue (no arbitrary execution), require a confirmation
step, and every attempt — including rejected ones — is written to the command audit log. The schema
(command, target, parameters) is the one a future physical uplink would reuse.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from app.simulation.faults import SEVERITY_GAIN
from app.simulation.scenarios import SCENARIO_IDS

CATALOG: list[dict[str, Any]] = [
    {"command": "PING", "description": "Verify the simulated link (round-trip echo).", "parameters": []},
    {"command": "REQUEST_STATUS", "description": "Request the latest health snapshot.", "parameters": []},
    {"command": "REQUEST_TELEMETRY", "description": "Request a burst of the most recent telemetry packets.",
     "parameters": [{"name": "count", "type": "int", "required": False, "min": 1, "max": 100}]},
    {"command": "REQUEST_HEALTH", "description": "Request the current health assessment.", "parameters": []},
    {"command": "RESET_SIMULATOR", "description": "Reset the simulation state (stops the current run).",
     "parameters": []},
    {"command": "SET_SIMULATION_SCENARIO", "description": "Change the simulator scenario / inject a fault.",
     "parameters": [{"name": "scenario", "type": "enum", "required": True, "enum": sorted(SCENARIO_IDS)},
                    {"name": "severity", "type": "enum", "required": False, "enum": list(SEVERITY_GAIN)}]},
]
for _c in CATALOG:
    _c["requires_confirmation"] = True
BY_NAME = {c["command"]: c for c in CATALOG}


class CommandValidationError(ValueError):
    pass


def validate_command(command: str, target: str, parameters: dict[str, Any], satellite_id: str) -> dict[str, Any]:
    """Return normalised parameters or raise CommandValidationError."""
    spec = BY_NAME.get(command)
    if spec is None:
        raise CommandValidationError(f"unknown command {command!r}")
    if target != satellite_id:
        raise CommandValidationError(f"unknown target {target!r}")
    allowed = {p["name"]: p for p in spec["parameters"]}
    extra = set(parameters) - set(allowed)
    if extra:
        raise CommandValidationError(f"unexpected parameter(s): {', '.join(sorted(extra))}")
    out: dict[str, Any] = {}
    for name, p in allowed.items():
        if name not in parameters or parameters[name] is None:
            if p["required"]:
                raise CommandValidationError(f"missing required parameter {name!r}")
            continue
        v = parameters[name]
        if p["type"] == "int":
            if isinstance(v, bool) or not isinstance(v, int):
                raise CommandValidationError(f"{name} must be an integer")
            if not (p["min"] <= v <= p["max"]):
                raise CommandValidationError(f"{name} must be within {p['min']}–{p['max']}")
        elif p["type"] == "enum" and v not in p["enum"]:
            raise CommandValidationError(f"{name} must be one of {p['enum']}")
        out[name] = v
    return out


async def execute(gs, command: str, parameters: dict[str, Any]) -> dict[str, Any]:
    """Execute a validated, confirmed command against the simulated spacecraft/ground station."""
    from app.telemetry.processor import iso

    now = iso(datetime.now(timezone.utc))
    if command == "PING":
        age = gs.packet_age()
        return {"reply": "PONG", "link": gs.connection(), "last_packet_age_s": age, "time": now}
    if command == "REQUEST_STATUS":
        st = gs.satellite_status()
        return {"overall_score": st["overall_score"], "status": st["status"], "mode": st["mode"],
                "connection": st["connection"], "active_alarms": st["active_alarms"]}
    if command == "REQUEST_TELEMETRY":
        from sqlalchemy import select

        from app.database import models as m
        from app.database.repository import telemetry_row
        count = parameters.get("count", 10)
        with gs.db.session() as s:
            rows = s.scalars(select(m.Telemetry).order_by(m.Telemetry.timestamp.desc()).limit(count)).all()
            return {"count": len(rows), "packets": [telemetry_row(r) for r in reversed(rows)]}
    if command == "REQUEST_HEALTH":
        st = gs.satellite_status()
        return {"overall_score": st["overall_score"], "status": st["status"], "trend": st["trend"],
                "anomaly_score": st["anomaly_score"],
                "subsystems": {x["name"]: {"score": x["health_score"], "status": x["status"]} for x in st["subsystems"]}}
    if command == "RESET_SIMULATOR":
        await gs.reset_simulation()
        return {"reset": True, "simulation": gs.simulation_status()}
    if command == "SET_SIMULATION_SCENARIO":
        await gs.sim.inject(parameters["scenario"], parameters.get("severity", "moderate"))
        return {"scenario": parameters["scenario"], "simulation": gs.simulation_status()}
    raise CommandValidationError(f"no executor for {command}")
