"""Ground-station orchestrator: ingestion pipeline, simulation/replay control and self-monitoring.

    packet → decode/validate → quality → derived values → persist → ML inference → health →
    anomaly events → WebSocket broadcast

Every telemetry source (simulator, REST, future hardware gateway) enters through `ingest()`/
`ingest_frame()`, so nothing downstream depends on where telemetry came from.
"""
from __future__ import annotations

import asyncio
import bisect
import logging
import time
from collections import Counter, deque
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func, select

from app.core.config import Settings
from app.database import models as m
from app.database.repository import (anomaly_dict, as_utc, log_system_event, run_dict, telemetry_packet)
from app.database.session import Database
from app.services import anomaly_service
from app.services.anomaly_service import AnomalyTracker
from app.services.health_service import HealthService, status_from_health
from app.services.ml_service import MLService
from app.simulation.engine import SimulationEngine
from app.telemetry.decoder import DecodeError, decode_frame
from app.telemetry.processor import TelemetryProcessor, iso
from app.telemetry.schemas import Quality, SUBSYSTEMS, TelemetryPacketIn
from app.telemetry.validator import validate_packet
from app.websocket.manager import ConnectionManager

log = logging.getLogger(__name__)

QUALITY_FACTOR = {"VALID": 1.0, "SUSPECT": 1.0, "OUT_OF_RANGE": 0.95, "STALE": 0.7, "MISSING": 0.8, "CORRUPTED": 0.5}


class GroundStation:
    def __init__(self, settings: Settings, db: Database, ws: ConnectionManager, ml: MLService) -> None:
        self.settings = settings
        self.db = db
        self.ws = ws
        self.ml = ml
        self.processor = TelemetryProcessor()
        self.health = HealthService()
        self.tracker = AnomalyTracker()
        self.sim = SimulationEngine(satellite_id=settings.satellite_id, sample_interval_s=settings.sample_interval_s,
                                    sink=self.ingest, frame_sink=self.ingest_frame, on_event=self._on_sim_event)
        self.replay = ReplayEngine(self)
        self._lock = asyncio.Lock()
        self.started_at = time.time()
        self.received_count = 0
        self.rejected_count = 0
        self._arrivals: deque[float] = deque(maxlen=2000)
        self.last_packet_wall: float | None = None
        self.last_packet_time: datetime | None = None
        self.last_source: str | None = None
        self.latest_packet: dict | None = None
        self.latest_inference: dict | None = None
        self._stale_reported = False
        self._last_reject_log = 0.0
        self._bg: list[asyncio.Task] = []
        self.api_latency_ms: deque[float] = deque(maxlen=200)

    # ------------------------------------------------------------------------------- lifecycle
    async def startup(self) -> None:
        if self.ml.bundle:
            self.tracker.thresholds = self.ml.bundle.thresholds
        self.ml.on_trained = self._on_trained
        with self.db.session() as s:
            if s.get(m.Satellite, self.settings.satellite_id) is None:
                s.add(m.Satellite(id=self.settings.satellite_id, name=self.settings.satellite_name))
            for sid, meta in SUBSYSTEMS.items():
                key = f"{self.settings.satellite_id}:{sid}"
                if s.get(m.Subsystem, key) is None:
                    s.add(m.Subsystem(id=key, satellite_id=self.settings.satellite_id, key=sid, name=meta["name"]))
            # Close runs left open by an unclean shutdown.
            for r in s.scalars(select(m.SimulationRun).where(m.SimulationRun.status == "RUNNING")):
                r.status = "INTERRUPTED"
                r.end_time = r.end_time or datetime.now(timezone.utc)
            if self.ml.bundle:
                self._record_model_version(s, self.ml.bundle.metadata)
            log_system_event(s, "INFO", "backend", f"ground station started (db={self.db.engine_name}, "
                                                    f"ml={self.ml.status})")
        self._bg.append(asyncio.create_task(self._system_loop(), name="system-status"))
        if self.settings.simulator_enabled and self.settings.simulator_autostart:
            await self.start_simulation(run_name="Live session")

    async def shutdown(self) -> None:
        await self.replay.stop(resume_sim=False)
        await self.sim.stop()
        for t in self._bg:
            t.cancel()

    # ------------------------------------------------------------------------------- ingestion
    async def ingest(self, packet: TelemetryPacketIn) -> dict[str, Any]:
        async with self._lock:
            result = await asyncio.to_thread(self._process, packet)
        await self.ws.broadcast("telemetry", result["telemetry"])
        await self.ws.broadcast("health", result["health"])
        for ev in result["anomaly_events"]:
            await self.ws.broadcast("anomalies", ev)
        return {"accepted": True, "sequence": packet.sequence, "quality": result["telemetry"]["quality"]}

    async def ingest_frame(self, frame: bytes) -> dict[str, Any]:
        try:
            packet = decode_frame(frame)
        except DecodeError as exc:
            self.reject(f"corrupted frame: {exc}")
            return {"accepted": False, "quality": Quality.CORRUPTED.value, "error": str(exc)}
        return await self.ingest(packet)

    def reject(self, reason: str) -> None:
        self.rejected_count += 1
        now = time.time()
        if now - self._last_reject_log > 10:  # rate-limit the audit log
            self._last_reject_log = now
            with self.db.session() as s:
                log_system_event(s, "WARNING", "telemetry", f"packet rejected ({self.rejected_count} total): {reason}"[:500])

    def _process(self, packet: TelemetryPacketIn) -> dict[str, Any]:
        now = datetime.now(timezone.utc)
        validation = validate_packet(packet, now=now, stale_after_s=self.settings.stale_after_s)
        if self.ml.bundle is not None and not self.processor.fill_defaults:
            b = self.ml.bundle
            self.processor.fill_defaults = {f: float(v) for f, v in zip(b.features, b.scaler.mean_)}
        processed = self.processor.process(packet, validation, now=now)
        message = processed.to_message()
        ts = as_utc(packet.timestamp)
        ts_iso = message["timestamp"]

        inference = self.ml.infer(processed.filled, packet.data, timestamp=ts_iso, sequence=packet.sequence,
                                  quality_factor=QUALITY_FACTOR.get(validation.quality.value, 1.0))

        with self.db.session() as s:
            row = m.Telemetry(timestamp=ts, received_at=now, satellite_id=packet.satellite_id,
                              sequence=packet.sequence, source=packet.source.value, quality=validation.quality.value,
                              run_id=packet.run_id, field_quality=message["field_quality"] or None,
                              derived=processed.derived, **packet.data)
            s.add(row)
            events = self.tracker.update(s, ts, inference, satellite_id=packet.satellite_id, run_id=packet.run_id,
                                         faults=self.fault_context())
            active = self._active_by_subsystem(s)
            health = self.health.compute(ts_iso, packet.data, inference, message["field_quality"],
                                         validation.quality.value, active)
            subs = {x["id"]: x["health_score"] for x in health["subsystems"]}
            s.add(m.HealthScore(timestamp=ts, sequence=packet.sequence, run_id=packet.run_id,
                                overall_score=health["overall_score"], status=health["status"],
                                anomaly_score=inference["anomaly_score"], severity=inference["severity"],
                                confidence=inference["confidence"], detectors=inference["detectors"], **subs))
            if packet.sequence % 10 == 0:
                for x in health["subsystems"]:
                    sub = s.get(m.Subsystem, f"{packet.satellite_id}:{x['id']}")
                    if sub:
                        sub.status, sub.health_score, sub.updated_at = x["status"], x["health_score"], now
                sat = s.get(m.Satellite, packet.satellite_id)
                if sat:
                    sat.status, sat.mode = health["status"], self.mode()

        self.received_count += 1
        self._arrivals.append(time.monotonic())
        self.last_packet_wall = time.time()
        self.last_packet_time = ts
        self.last_source = packet.source.value
        self.latest_packet = message
        self.latest_inference = health["inference"]
        self._stale_reported = False
        return {"telemetry": message, "health": health, "anomaly_events": events}

    def _active_by_subsystem(self, s) -> Counter:
        c: Counter = Counter()
        for subs in s.scalars(select(m.Anomaly.subsystems).where(m.Anomaly.status == "ACTIVE").limit(500)):
            for x in subs or []:
                c[x] += 1
        return c

    def fault_context(self) -> list[dict]:
        if self.sim.epoch is None:
            return []
        return [{"scenario": f.parent or f.scenario, "severity": f.severity, "duration_s": f.duration_s,
                 "start_dt": self.sim.time_at(f.start_t)} for f in self.sim.faults]

    # ----------------------------------------------------------------------------- simulation
    async def start_simulation(self, speed: float | None = None, run_name: str | None = None) -> None:
        if self.replay.active:
            await self.replay.stop(resume_sim=False)
        await self.sim.start(speed=speed, run_name=run_name, new_run_id=m.new_id)

    async def reset_simulation(self) -> None:
        await self.replay.stop(resume_sim=False)
        await self.sim.reset()
        async with self._lock:
            self.processor.reset()
            self.ml.reset_state()
            self.tracker.reset()
            self.health.reset()

    async def _on_sim_event(self, event_type: str, payload: dict) -> None:
        run_id = self.sim.run_id
        ts = self.sim.sim_time or datetime.now(timezone.utc)
        with self.db.session() as s:
            if event_type == "run_started" and run_id:
                s.add(m.SimulationRun(id=run_id, name=payload["name"], scenario="normal", speed=payload["speed"],
                                      seed=payload["seed"], start_time=payload["start_time"], status="RUNNING"))
                log_system_event(s, "INFO", "simulator", f"simulation run {run_id} started")
            run = s.get(m.SimulationRun, run_id) if run_id else None
            if run is not None:
                if event_type == "run_stopped":
                    run.status, run.end_time = "COMPLETED", payload["end_time"]
                    run.packet_count = self._run_packets(s, run_id)
                    log_system_event(s, "INFO", "simulator", f"simulation run {run_id} stopped")
                elif event_type == "speed_changed":
                    run.speed = max(run.speed, payload["speed"])
                elif event_type == "fault_injected":
                    run.scenario = ",".join(self.sim.scenarios_used) or "normal"
                params = {k: (iso(v) if isinstance(v, datetime) else v) for k, v in payload.items()}
                s.add(m.SimulationEvent(run_id=run_id, timestamp=payload.get("start_time") or ts,
                                        event_type=event_type, parameters=params))
        await self.broadcast_simulation()

    def _run_packets(self, s, run_id: str) -> int:
        return int(s.scalar(select(func.count(m.Telemetry.id)).where(m.Telemetry.run_id == run_id)) or 0)

    def simulation_status(self) -> dict[str, Any]:
        st = self.sim.status()
        st["replay"] = self.replay.status()
        st["mode"] = self.mode()
        return st

    async def broadcast_simulation(self) -> None:
        msg = {"type": "simulation", "status": self.simulation_status()}
        self.ws.set_snapshot("simulation", msg)
        await self.ws.broadcast("system", msg, snapshot=False)

    def mode(self) -> str:
        if self.replay.active:
            return "REPLAY"
        if self.last_source == "REAL" and self.packet_age() is not None and self.packet_age() < self.settings.stale_after_s:
            return "REAL"
        return self.sim.mode()

    # ------------------------------------------------------------------------- self-monitoring
    def packet_age(self) -> float | None:
        return None if self.last_packet_wall is None else round(time.time() - self.last_packet_wall, 2)

    def packet_rate(self) -> float:
        now = time.monotonic()
        return round(sum(1 for t in self._arrivals if now - t <= 10.0) / 10.0, 2)

    def connection(self) -> str:
        age = self.packet_age()
        if age is None or age > 3 * self.settings.stale_after_s:
            return "DISCONNECTED"
        if age > self.settings.stale_after_s or (self.latest_packet or {}).get("derived", {}).get("packet_loss_rate", 0) > 10:
            return "DEGRADED"
        return "CONNECTED"

    def system_status(self) -> dict[str, Any]:
        db_latency = self.db.ping()
        age = self.packet_age()
        if self.replay.active:
            sim_status = "REPLAY"
        elif self.sim.running:
            sim_status = "PAUSED" if self.sim.paused else "RUNNING"
        else:
            sim_status = "STOPPED"
        if age is None:
            tel_status = "NO_DATA"
        elif age > self.settings.stale_after_s:
            tel_status = "STALE"
        else:
            tel_status = "LIVE"
        lat = list(self.api_latency_ms)
        return {
            "type": "system",
            "timestamp": iso(datetime.now(timezone.utc)),
            "backend": {"status": "ONLINE", "version": self.settings.version,
                        "uptime_s": round(time.time() - self.started_at, 1),
                        "latency_ms": round(sum(lat) / len(lat), 2) if lat else 0.0},
            "database": {"status": "ONLINE" if db_latency is not None else "OFFLINE", "engine": self.db.engine_name,
                         "latency_ms": db_latency},
            "ml": {"status": self.ml.status, "models_loaded": self.ml.models_loaded(),
                   "inference_latency_ms": self.ml.latency_ms, "model_version": self.ml.model_version,
                   "message": self.ml.training_message or self.ml.error},
            "websocket": {"status": "ONLINE", "clients": self.ws.client_count, "message_rate": self.ws.message_rate()},
            "simulator": {"status": sim_status, "scenario": self.sim.scenario, "speed": self.sim.speed,
                          "mode": self.mode()},
            "telemetry": {"status": tel_status, "packet_rate": self.packet_rate(), "stale_age_s": age,
                          "received_count": self.received_count, "rejected_count": self.rejected_count,
                          "last_packet_time": iso(self.last_packet_time)},
        }

    async def _system_loop(self) -> None:
        while True:
            try:
                status = await asyncio.to_thread(self.system_status)
                await self.ws.broadcast("system", status)
                age = self.packet_age()
                if age is not None and age > self.settings.stale_after_s and not self._stale_reported \
                        and not self.replay.active and not (self.sim.running and self.sim.paused):
                    self._stale_reported = True
                    with self.db.session() as s:
                        log_system_event(s, "WARNING", "telemetry", f"telemetry stream stale ({age:.0f} s since last packet)")
                if status["database"]["status"] == "OFFLINE":
                    log.warning("database health check failed")
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("system status loop failed")
            await asyncio.sleep(2.0)

    def satellite_status(self) -> dict[str, Any]:
        health = self.health.latest or {
            "type": "health", "timestamp": None, "overall_score": None, "status": "UNKNOWN", "trend": "flat",
            "anomaly_score": 0.0, "inference": None,
            "subsystems": [{"id": sid, "name": meta["name"], "status": "UNKNOWN", "health_score": None,
                            "key_values": {}, "active_anomalies": 0} for sid, meta in SUBSYSTEMS.items()]}
        with self.db.session() as s:
            active = int(s.scalar(select(func.count(m.Anomaly.id)).where(m.Anomaly.status == "ACTIVE")) or 0)
        snr = (self.latest_packet or {}).get("data", {}).get("snr")
        loss = (self.latest_packet or {}).get("data", {}).get("packet_loss")
        comm_quality = None
        if snr is not None and loss is not None:
            comm_quality = round(max(0.0, min(100.0, (snr / 15.0) * 100.0 - loss * 5.0)), 1)
        return {**health, "mode": self.mode(), "connection": self.connection(),
                "last_packet_time": iso(self.last_packet_time), "last_packet_age_s": self.packet_age(),
                "packet_rate": self.packet_rate(), "active_alarms": active, "comm_quality": comm_quality}

    # ------------------------------------------------------------------------------- models
    def _on_trained(self, metadata: dict) -> None:
        self.tracker.thresholds = metadata.get("thresholds", {})
        self.processor.fill_defaults = {}
        with self.db.session() as s:
            self._record_model_version(s, metadata)
            log_system_event(s, "INFO", "ml", f"models trained: {metadata.get('version')}")

    def _record_model_version(self, s, metadata: dict) -> None:
        version = metadata.get("version")
        if s.scalar(select(m.ModelVersion).where(m.ModelVersion.version == version)) is not None:
            return
        for mv in s.scalars(select(m.ModelVersion).where(m.ModelVersion.active.is_(True))):
            mv.active = False
        s.add(m.ModelVersion(name=metadata.get("name", "hybrid"), version=version,
                             metrics=metadata.get("evaluation", {}), feature_set=metadata.get("features", []),
                             thresholds=metadata.get("thresholds", {}), active=True))

    # ------------------------------------------------------------------------------- anomalies
    async def set_anomaly_status(self, anomaly_id: str, status: str, user: str, note: str | None) -> dict | None:
        with self.db.session() as s:
            a = anomaly_service.set_status(s, anomaly_id, status, user, note)
            if a is None:
                return None
            log_system_event(s, "INFO", "operator", f"{user} set anomaly {anomaly_id} to {status}")
            out = anomaly_dict(a)
        await self.ws.broadcast("anomalies", {"type": "anomaly", "event": status.lower(), "anomaly": out})
        return out

    def run_list(self) -> list[dict]:
        with self.db.session() as s:
            runs = s.scalars(select(m.SimulationRun).order_by(m.SimulationRun.start_time.desc()).limit(100)).all()
            counts = dict(s.execute(select(m.Anomaly.run_id, func.count(m.Anomaly.id)).group_by(m.Anomaly.run_id)).all())
            out = []
            for r in runs:
                d = run_dict(r, counts.get(r.id, 0))
                if r.status == "RUNNING":
                    d["packet_count"] = self._run_packets(s, r.id)
                out.append(d)
            return out


class ReplayEngine:
    """Replays a recorded run over the same WebSocket channels with source=REPLAY."""

    def __init__(self, gs: GroundStation) -> None:
        self.gs = gs
        self.active = False
        self.paused = False
        self.finished = False
        self.speed = 1.0
        self.run_id: str | None = None
        self.rows: list[m.Telemetry] = []
        self.times: list[datetime] = []
        self.health: dict[int, m.HealthScore] = {}
        self.anomalies: list[dict] = []
        self.index = 0
        self._emitted: set[str] = set()
        self._task: asyncio.Task | None = None
        self._resume_sim = False

    def status(self) -> dict | None:
        if not self.active or not self.rows:
            return None
        pos = self.rows[min(self.index, len(self.rows) - 1)].timestamp
        return {"run_id": self.run_id, "start": iso(self.times[0]), "end": iso(self.times[-1]), "position": iso(pos),
                "speed": self.speed, "paused": self.paused, "finished": self.finished,
                "progress": round(self.index / max(1, len(self.rows) - 1), 4), "index": self.index,
                "count": len(self.rows)}

    async def start(self, run_id: str, start: datetime | None, end: datetime | None, speed: float) -> None:
        if speed <= 0 or speed > 50:
            raise ValueError("speed must be within (0, 50]")
        await self.stop(resume_sim=False)

        def load():
            with self.gs.db.session() as s:
                run = s.get(m.SimulationRun, run_id)
                if run is None:
                    raise LookupError(f"run {run_id} not found")
                q = select(m.Telemetry).where(m.Telemetry.run_id == run_id)
                if start:
                    q = q.where(m.Telemetry.timestamp >= start)
                if end:
                    q = q.where(m.Telemetry.timestamp <= end)
                rows = s.scalars(q.order_by(m.Telemetry.timestamp, m.Telemetry.id).limit(200_000)).all()
                hq = select(m.HealthScore).where(m.HealthScore.run_id == run_id)
                health = {h.sequence: h for h in s.scalars(hq)}
                anomalies = [anomaly_dict(a) for a in s.scalars(select(m.Anomaly).where(m.Anomaly.run_id == run_id))]
                return rows, health, anomalies

        rows, health, anomalies = await asyncio.to_thread(load)
        if not rows:
            raise LookupError("no telemetry recorded for that run/interval")
        self._resume_sim = self.gs.sim.running and not self.gs.sim.paused
        await self.gs.sim.pause()
        self.rows, self.health, self.anomalies = rows, health, anomalies
        self.times = [as_utc(r.timestamp) for r in rows]
        self.run_id, self.speed, self.index = run_id, float(speed), 0
        self.active, self.paused, self.finished = True, False, False
        self._emitted = set()
        with self.gs.db.session() as s:
            log_system_event(s, "INFO", "replay", f"replay of run {run_id} started ({len(rows)} packets)")
        self._task = asyncio.create_task(self._loop(), name="replay")
        await self.gs.broadcast_simulation()

    async def stop(self, resume_sim: bool = True) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None
        was_active = self.active
        self.active = False
        self.rows, self.health, self.anomalies = [], {}, []
        if was_active:
            if resume_sim and self._resume_sim:
                await self.gs.sim.resume()
            await self.gs.broadcast_simulation()

    async def pause(self) -> None:
        self.paused = True
        await self.gs.broadcast_simulation()

    async def resume(self) -> None:
        if self.finished:
            self.index, self.finished, self._emitted = 0, False, set()
        self.paused = False
        await self.gs.broadcast_simulation()

    async def set_speed(self, speed: float) -> None:
        if speed <= 0 or speed > 50:
            raise ValueError("speed must be within (0, 50]")
        self.speed = float(speed)
        await self.gs.broadcast_simulation()

    async def step(self, steps: int) -> None:
        self.paused = True
        self.index = max(0, min(len(self.rows) - 1, self.index + steps))
        await self._emit(self.index, include_past=True)
        await self.gs.broadcast_simulation()

    async def seek(self, ts: datetime) -> None:
        self.index = max(0, min(len(self.rows) - 1, bisect.bisect_left(self.times, as_utc(ts))))
        self.finished = False
        self._emitted = {a["id"] for a in self.anomalies if as_utc(datetime.fromisoformat(a["timestamp"].replace("Z", "+00:00"))) < self.times[self.index]}
        await self._emit(self.index)
        await self.gs.broadcast_simulation()

    async def _loop(self) -> None:
        last_status = 0.0
        while self.active:
            if self.paused or self.finished:
                await asyncio.sleep(0.1)
                continue
            await self._emit(self.index)
            if time.monotonic() - last_status > 1.0:
                last_status = time.monotonic()
                await self.gs.broadcast_simulation()
            if self.index >= len(self.rows) - 1:
                self.finished, self.paused = True, True
                await self.gs.broadcast_simulation()
                continue
            dt = (self.times[self.index + 1] - self.times[self.index]).total_seconds()
            self.index += 1
            await asyncio.sleep(max(0.01, min(dt, 5.0)) / self.speed)

    async def _emit(self, i: int, include_past: bool = False) -> None:
        row = self.rows[i]
        pkt = telemetry_packet(row)
        pkt["source"] = "REPLAY"
        await self.gs.ws.broadcast("telemetry", pkt)
        h = self.health.get(row.sequence)
        if h is not None:
            subs = []
            for sid, meta in SUBSYSTEMS.items():
                score = getattr(h, sid)
                subs.append({"id": sid, "name": meta["name"], "status": status_from_health(score),
                             "health_score": score, "key_values": {}, "active_anomalies": 0})
            await self.gs.ws.broadcast("health", {
                "type": "health", "timestamp": pkt["timestamp"], "overall_score": h.overall_score,
                "status": h.status, "trend": "flat", "anomaly_score": h.anomaly_score, "subsystems": subs,
                "inference": {"timestamp": pkt["timestamp"], "sequence": row.sequence,
                              "anomaly_score": h.anomaly_score, "severity": h.severity, "confidence": h.confidence,
                              "detectors": h.detectors, "raw": {}, "affected_subsystems": [], "top_features": [],
                              "model_version": "replay"}})
        now = self.times[i]
        for a in self.anomalies:
            ats = as_utc(datetime.fromisoformat(a["timestamp"].replace("Z", "+00:00")))
            if a["id"] not in self._emitted and ats <= now + timedelta(milliseconds=1):
                if include_past or ats >= now - timedelta(seconds=5) or not self._emitted:
                    await self.gs.ws.broadcast("anomalies", {"type": "anomaly", "event": "replay", "anomaly": a})
                self._emitted.add(a["id"])
