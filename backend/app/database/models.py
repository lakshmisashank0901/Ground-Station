"""SQLAlchemy ORM models (spec section 7)."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import JSON, BigInteger, Boolean, DateTime, Float, Index, Integer, String, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from app.telemetry.schemas import PARAMETERS


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_id() -> str:
    return uuid.uuid4().hex[:16]


TS = DateTime(timezone=True)
# SQLite only auto-increments INTEGER primary keys; PostgreSQL gets BIGINT.
BigId = BigInteger().with_variant(Integer, "sqlite")


class Base(DeclarativeBase):
    pass


class Satellite(Base):
    __tablename__ = "satellites"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    status: Mapped[str] = mapped_column(String(16), default="UNKNOWN")
    mode: Mapped[str] = mapped_column(String(16), default="IDLE")
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)


class Subsystem(Base):
    __tablename__ = "subsystems"
    id: Mapped[str] = mapped_column(String(48), primary_key=True)  # "<satellite>:<key>"
    satellite_id: Mapped[str] = mapped_column(String(32), index=True)
    key: Mapped[str] = mapped_column(String(16))
    name: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(16), default="UNKNOWN")
    health_score: Mapped[float] = mapped_column(Float, default=100.0)
    updated_at: Mapped[datetime] = mapped_column(TS, default=utcnow)


class Telemetry(Base):
    __tablename__ = "telemetry"
    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    timestamp: Mapped[datetime] = mapped_column(TS, index=True)
    received_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    satellite_id: Mapped[str] = mapped_column(String(32))
    sequence: Mapped[int] = mapped_column(BigInteger)
    source: Mapped[str] = mapped_column(String(16))
    quality: Mapped[str] = mapped_column(String(16))
    run_id: Mapped[str | None] = mapped_column(String(32), index=True, nullable=True)
    field_quality: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    derived: Mapped[dict | None] = mapped_column(JSON, nullable=True)


# One typed column per telemetry parameter ("telemetry columns" in the spec).
for _p in PARAMETERS:
    _col = String(16) if _p.type == "enum" else (BigInteger if _p.type == "int" else Float)
    setattr(Telemetry, _p.name, mapped_column(_col, nullable=True))
Index("ix_telemetry_sat_ts", Telemetry.satellite_id, Telemetry.timestamp)


class HealthScore(Base):
    __tablename__ = "health_scores"
    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    timestamp: Mapped[datetime] = mapped_column(TS, index=True)
    sequence: Mapped[int] = mapped_column(BigInteger, default=0)
    run_id: Mapped[str | None] = mapped_column(String(32), index=True, nullable=True)
    overall_score: Mapped[float] = mapped_column(Float)
    status: Mapped[str] = mapped_column(String(16))
    anomaly_score: Mapped[float] = mapped_column(Float)
    severity: Mapped[str] = mapped_column(String(16))
    confidence: Mapped[float] = mapped_column(Float, default=0.0)
    eps: Mapped[float] = mapped_column(Float)
    obc: Mapped[float] = mapped_column(Float)
    adcs: Mapped[float] = mapped_column(Float)
    comm: Mapped[float] = mapped_column(Float)
    payload: Mapped[float] = mapped_column(Float)
    detectors: Mapped[dict] = mapped_column(JSON)


class Anomaly(Base):
    __tablename__ = "anomalies"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    timestamp: Mapped[datetime] = mapped_column(TS, index=True)  # detection time
    onset_time: Mapped[datetime] = mapped_column(TS)
    ended_at: Mapped[datetime | None] = mapped_column(TS, nullable=True)
    last_updated: Mapped[datetime] = mapped_column(TS, default=utcnow)
    satellite_id: Mapped[str] = mapped_column(String(32), default="SAT-01")
    subsystems: Mapped[list] = mapped_column(JSON)
    severity: Mapped[str] = mapped_column(String(16), index=True)
    score: Mapped[float] = mapped_column(Float)
    peak_score: Mapped[float] = mapped_column(Float)
    confidence: Mapped[float] = mapped_column(Float)
    detectors: Mapped[dict] = mapped_column(JSON)
    raw: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    top_features: Mapped[list] = mapped_column(JSON)
    description: Mapped[str] = mapped_column(Text)
    explanation: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), default="ACTIVE", index=True)
    detection_delay_s: Mapped[float | None] = mapped_column(Float, nullable=True)
    injected_fault: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    acknowledged_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    acknowledged_at: Mapped[datetime | None] = mapped_column(TS, nullable=True)
    resolved_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(TS, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    run_id: Mapped[str | None] = mapped_column(String(32), index=True, nullable=True)
    sample_count: Mapped[int] = mapped_column(Integer, default=1)
    model_version: Mapped[str | None] = mapped_column(String(64), nullable=True)


class SimulationRun(Base):
    __tablename__ = "simulation_runs"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(128))
    scenario: Mapped[str] = mapped_column(String(64), default="normal")
    start_time: Mapped[datetime] = mapped_column(TS)
    end_time: Mapped[datetime | None] = mapped_column(TS, nullable=True)
    speed: Mapped[float] = mapped_column(Float, default=1.0)
    status: Mapped[str] = mapped_column(String(16), default="RUNNING")
    seed: Mapped[int] = mapped_column(Integer, default=1)
    packet_count: Mapped[int] = mapped_column(Integer, default=0)


class SimulationEvent(Base):
    __tablename__ = "simulation_events"
    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(String(32), index=True)
    timestamp: Mapped[datetime] = mapped_column(TS)
    event_type: Mapped[str] = mapped_column(String(32))
    parameters: Mapped[dict] = mapped_column(JSON, default=dict)


class Command(Base):
    __tablename__ = "commands"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    timestamp: Mapped[datetime] = mapped_column(TS, default=utcnow, index=True)
    user: Mapped[str] = mapped_column(String(64))
    command: Mapped[str] = mapped_column(String(64))
    target: Mapped[str] = mapped_column(String(32))
    parameters: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(24))
    result: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    confirmed_at: Mapped[datetime | None] = mapped_column(TS, nullable=True)


class ModelVersion(Base):
    __tablename__ = "model_versions"
    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(64))
    version: Mapped[str] = mapped_column(String(64), index=True)
    metrics: Mapped[dict] = mapped_column(JSON, default=dict)
    feature_set: Mapped[list] = mapped_column(JSON, default=list)
    thresholds: Mapped[dict] = mapped_column(JSON, default=dict)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)


class SystemEvent(Base):
    __tablename__ = "system_events"
    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    timestamp: Mapped[datetime] = mapped_column(TS, default=utcnow, index=True)
    level: Mapped[str] = mapped_column(String(16))
    component: Mapped[str] = mapped_column(String(32))
    message: Mapped[str] = mapped_column(Text)


class Report(Base):
    __tablename__ = "reports"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    title: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    start: Mapped[datetime] = mapped_column(TS)
    end: Mapped[datetime] = mapped_column(TS)
    run_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    anomaly_count: Mapped[int] = mapped_column(Integer, default=0)
    content: Mapped[dict] = mapped_column(JSON)
