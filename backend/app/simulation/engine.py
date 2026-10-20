"""Simulation runtime: mission clock, scenario manager, packet generator and source adapter.

The engine is deliberately decoupled from the ground-station pipeline: it hands finished packets to a
`sink` coroutine. In-process the sink is the ingestion pipeline; the standalone simulator service
(`python -m app.simulation.standalone`) uses an HTTP sink that POSTs to /api/v1/telemetry, exactly like
a future SAMRH/radio gateway would.
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable

import numpy as np

from app.simulation.faults import Fault, build_faults
from app.simulation.scenarios import SCENARIO_IDS
from app.simulation.spacecraft import Spacecraft
from app.telemetry.decoder import encode_frame
from app.telemetry.processor import iso
from app.telemetry.schemas import PARAM_BY_NAME, Source, TelemetryPacketIn

log = logging.getLogger(__name__)

ALLOWED_SPEEDS = (1, 2, 5, 10)

PacketSink = Callable[[TelemetryPacketIn], Awaitable[Any]]
FrameSink = Callable[[bytes], Awaitable[Any]]
EventHook = Callable[[str, dict], Awaitable[None]]


@dataclass
class SimulationEngine:
    satellite_id: str = "SAT-01"
    sample_interval_s: float = 1.0
    seed: int = 42
    sink: PacketSink | None = None
    frame_sink: FrameSink | None = None
    on_event: EventHook | None = None       # (event_type, payload) → persistence / broadcast
    link_effects: bool = True               # drop/corrupt packets according to simulated link quality

    spacecraft: Spacecraft = field(init=False)
    faults: list[Fault] = field(default_factory=list)
    overrides: dict[str, tuple[float, float | None]] = field(default_factory=dict)  # param → (value, until_t)
    running: bool = False
    paused: bool = False
    speed: float = 1.0
    run_id: str | None = None
    run_name: str | None = None
    epoch: datetime | None = None
    sequence: int = 0
    packets_sent: int = 0
    scenario: str = "normal"
    scenarios_used: list[str] = field(default_factory=list)
    last_timestamp: datetime | None = None
    _task: asyncio.Task | None = field(default=None, init=False, repr=False)
    _rng: np.random.Generator = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self._new_spacecraft()

    def _new_spacecraft(self) -> None:
        self.spacecraft = Spacecraft(seed=self.seed)
        self._rng = np.random.default_rng(self.seed + 1)

    # ---------------------------------------------------------------------------------- clock
    @property
    def sim_time(self) -> datetime | None:
        if self.epoch is None:
            return None
        return self.epoch + timedelta(seconds=self.spacecraft.t)

    def time_at(self, t: float) -> datetime:
        assert self.epoch is not None
        return self.epoch + timedelta(seconds=t)

    def mode(self) -> str:
        return "SIMULATION" if self.running else "IDLE"

    # -------------------------------------------------------------------------------- control
    async def start(self, speed: float | None = None, run_name: str | None = None,
                    new_run_id: Callable[[], str] | None = None) -> None:
        if speed is not None:
            self._check_speed(speed)
            self.speed = float(speed)
        if self.running:
            self.paused = False
            await self._emit("resumed", {})
            return
        now = datetime.now(timezone.utc)
        # Mission clock continues monotonically across runs, never behind wall-clock time.
        base = max(now, (self.last_timestamp or now) + timedelta(seconds=self.sample_interval_s))
        self.epoch = base - timedelta(seconds=self.spacecraft.t)
        self.running, self.paused = True, False
        self.run_id = new_run_id() if new_run_id else f"run-{int(time.time())}"
        self.run_name = run_name or f"Session {iso(base)}"
        self.scenarios_used = [self.scenario] if self.scenario != "normal" else []
        await self._emit("run_started", {"name": self.run_name, "speed": self.speed, "seed": self.seed,
                                         "start_time": base})
        self._task = asyncio.create_task(self._loop(), name="simulator")

    async def stop(self) -> None:
        if not self.running:
            return
        self.running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None
        await self._emit("run_stopped", {"end_time": self.last_timestamp or datetime.now(timezone.utc)})
        self.run_id = None

    async def pause(self) -> None:
        if self.running and not self.paused:
            self.paused = True
            await self._emit("paused", {})

    async def resume(self) -> None:
        if self.running and self.paused:
            self.paused = False
            await self._emit("resumed", {})

    async def reset(self) -> None:
        await self.stop()
        self.faults.clear()
        self.overrides.clear()
        self.scenario = "normal"
        self.sequence = 0
        self.packets_sent = 0
        self.seed += 1
        self._new_spacecraft()
        await self._emit("reset", {})

    async def set_speed(self, speed: float) -> None:
        self._check_speed(speed)
        self.speed = float(speed)
        await self._emit("speed_changed", {"speed": self.speed})

    async def inject(self, scenario: str, severity: str = "moderate", start_delay_s: float = 0.0,
                     duration_s: float | None = None) -> list[Fault]:
        if scenario not in SCENARIO_IDS:
            raise ValueError(f"unknown scenario {scenario!r}")
        if scenario == "normal":
            self.faults.clear()
            self.scenario = "normal"
            await self._emit("scenario_cleared", {"scenario": "normal"})
            return []
        if start_delay_s < 0 or start_delay_s > 3600:
            raise ValueError("start_delay_s must be within 0–3600 s")
        if duration_s is not None and not (1 <= duration_s <= 7200):
            raise ValueError("duration_s must be within 1–7200 s")
        start_t = self.spacecraft.t + float(start_delay_s)
        new = build_faults(scenario, severity, start_t, duration_s)
        # drop faults that have ended to keep the list short
        self.faults = [f for f in self.faults if f.status(self.spacecraft.t) != "ENDED"] + new
        self.scenario = scenario
        if scenario not in self.scenarios_used:
            self.scenarios_used.append(scenario)
        await self._emit("fault_injected", {
            "scenario": scenario, "severity": severity, "start_time": self.time_at(start_t) if self.epoch else None,
            "duration_s": new[0].duration_s, "fault_ids": [f.id for f in new]})
        return new

    async def set_override(self, parameter: str, value: float | None, duration_s: float | None = None) -> None:
        if parameter not in PARAM_BY_NAME or PARAM_BY_NAME[parameter].type == "enum":
            raise ValueError(f"cannot override parameter {parameter!r}")
        if value is None:
            self.overrides.pop(parameter, None)
            await self._emit("override_cleared", {"parameter": parameter})
            return
        until = self.spacecraft.t + duration_s if duration_s else None
        self.overrides[parameter] = (float(value), until)
        await self._emit("override_set", {"parameter": parameter, "value": value, "duration_s": duration_s})

    def _check_speed(self, speed: float) -> None:
        if speed not in ALLOWED_SPEEDS:
            raise ValueError(f"speed must be one of {ALLOWED_SPEEDS}")

    # ----------------------------------------------------------------------------------- loop
    def active_overrides(self) -> dict[str, float]:
        t = self.spacecraft.t
        expired = [k for k, (_, until) in self.overrides.items() if until is not None and t >= until]
        for k in expired:
            self.overrides.pop(k, None)
        return {k: v for k, (v, _) in self.overrides.items()}

    def next_packet(self) -> TelemetryPacketIn:
        """Advance the spacecraft by one sample and build its telemetry packet."""
        data = self.spacecraft.step(self.sample_interval_s, self.faults, self.active_overrides())
        self.sequence += 1
        ts = self.sim_time or datetime.now(timezone.utc)
        self.last_timestamp = ts
        return TelemetryPacketIn(satellite_id=self.satellite_id, timestamp=ts, sequence=self.sequence,
                                 source=Source.SIMULATION, data=data, run_id=self.run_id)

    async def _loop(self) -> None:
        next_tick = time.monotonic()
        while self.running:
            if self.paused:
                await asyncio.sleep(0.1)
                next_tick = time.monotonic()
                continue
            packet = self.next_packet()
            try:
                await self._deliver(packet)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("simulator sink failed")
            next_tick += self.sample_interval_s / self.speed
            delay = next_tick - time.monotonic()
            if delay < -1.0:  # fell far behind (e.g. heavy load): don't try to catch up in a burst
                next_tick = time.monotonic()
                delay = 0
            await asyncio.sleep(max(0.0, delay))

    async def _deliver(self, packet: TelemetryPacketIn) -> None:
        if self.link_effects:
            loss = float(packet.data.get("packet_loss") or 0.0)
            # Frames lost on the simulated downlink never arrive (seen as sequence gaps).
            if self._rng.random() < loss / 100.0 * 0.5:
                return
            # Severe CRC error bursts occasionally corrupt a whole frame.
            if self.frame_sink and (packet.data.get("crc_errors") or 0) >= 4 and self._rng.random() < 0.15:
                frame = bytearray(encode_frame(packet.model_dump(mode="json")))
                frame[len(frame) // 2] ^= 0xFF
                await self.frame_sink(bytes(frame))
                return
        if self.sink:
            await self.sink(packet)
        self.packets_sent += 1

    async def _emit(self, event_type: str, payload: dict) -> None:
        if self.on_event:
            try:
                await self.on_event(event_type, payload)
            except Exception:
                log.exception("simulation event hook failed")

    # --------------------------------------------------------------------------------- status
    def fault_dicts(self) -> list[dict]:
        if self.epoch is None:
            return []
        return [f.to_dict(self.spacecraft.t, self.epoch) for f in self.faults]

    def status(self) -> dict[str, Any]:
        seen: dict[str, dict] = {}
        for f in self.fault_dicts():  # collapse composite faults to one entry
            seen.setdefault(f"{f['scenario']}:{f['start_time']}", f)
        return {
            "mode": self.mode(),
            "running": self.running,
            "paused": self.paused,
            "speed": self.speed,
            "run_id": self.run_id,
            "scenario": self.scenario,
            "sim_time": iso(self.sim_time) if self.running else iso(self.last_timestamp),
            "sequence": self.sequence,
            "packets_sent": self.packets_sent,
            "active_faults": [f for f in seen.values() if f["status"] != "ENDED"],
            "overrides": self.active_overrides(),
            "replay": None,
        }
