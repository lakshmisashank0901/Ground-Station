"""Telemetry processing: sequence tracking, derived values and gap filling for ML."""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from app.telemetry.schemas import NUMERIC_PARAMETERS, Quality, TelemetryPacketIn
from app.telemetry.validator import ValidationResult


@dataclass
class ProcessedTelemetry:
    packet: TelemetryPacketIn
    validation: ValidationResult
    derived: dict[str, float]
    # Numeric values with missing/corrupted fields filled from the last good value (for ML only).
    filled: dict[str, float]
    received_at: datetime

    def to_message(self) -> dict[str, Any]:
        p = self.packet
        return {
            "type": "telemetry",
            "satellite_id": p.satellite_id,
            "timestamp": iso(p.timestamp),
            "sequence": p.sequence,
            "source": p.source.value,
            "quality": self.validation.quality.value,
            "data": p.data,
            "derived": self.derived,
            "field_quality": {k: v.value for k, v in self.validation.field_quality.items()},
            "run_id": p.run_id,
        }


def iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def power(bus_voltage: float | None, bus_current: float | None) -> float | None:
    if bus_voltage is None or bus_current is None:
        return None
    return bus_voltage * bus_current


def rate(current: float | None, previous: float | None, dt_s: float) -> float:
    if current is None or previous is None or dt_s <= 0:
        return 0.0
    return (current - previous) / dt_s


@dataclass
class TelemetryProcessor:
    loss_window: int = 100
    last_sequence: int | None = None
    last_timestamp: datetime | None = None
    last_values: dict[str, float] = field(default_factory=dict)
    _gaps: deque = field(default_factory=lambda: deque(maxlen=100))
    # Last good values used to fill gaps for ML; seeded from training means when available.
    fill_defaults: dict[str, float] = field(default_factory=dict)

    def reset(self) -> None:
        self.last_sequence = None
        self.last_timestamp = None
        self.last_values.clear()
        self._gaps.clear()

    def sequence_gap(self, sequence: int) -> int:
        """Number of sequence numbers skipped before this packet (0 for in-order, restarts count as 0)."""
        if self.last_sequence is None or sequence <= self.last_sequence:
            return 0
        return sequence - self.last_sequence - 1

    def process(self, packet: TelemetryPacketIn, validation: ValidationResult,
                now: datetime | None = None) -> ProcessedTelemetry:
        now = now or datetime.now(timezone.utc)
        ts = packet.timestamp if packet.timestamp.tzinfo else packet.timestamp.replace(tzinfo=timezone.utc)
        dt_s = (ts - self.last_timestamp).total_seconds() if self.last_timestamp else 0.0

        gap = self.sequence_gap(packet.sequence)
        self._gaps.append((gap, 1))
        missing = sum(g for g, _ in self._gaps)
        received = sum(r for _, r in self._gaps)
        loss_rate = 100.0 * missing / (missing + received) if (missing + received) else 0.0

        good = {
            k: float(v) for k, v in packet.data.items()
            if k in NUMERIC_PARAMETERS and v is not None
            and validation.field_quality.get(k) not in (Quality.CORRUPTED, Quality.MISSING)
        }
        d = packet.data
        derived = {
            "power_calc": round(power(d.get("bus_voltage"), d.get("bus_current")) or 0.0, 4),
            "battery_temperature_rate": round(rate(good.get("battery_temperature"),
                                                   self.last_values.get("battery_temperature"), dt_s), 5),
            "obc_temperature_rate": round(rate(good.get("obc_temperature"),
                                               self.last_values.get("obc_temperature"), dt_s), 5),
            "sequence_gap": gap,
            "packet_loss_rate": round(loss_rate, 3),
            "freshness_s": round(max(0.0, (now - ts).total_seconds()), 3),
        }

        filled: dict[str, float] = {}
        for name in NUMERIC_PARAMETERS:
            if name in good:
                filled[name] = good[name]
            elif name in self.last_values:
                filled[name] = self.last_values[name]
            else:
                filled[name] = self.fill_defaults.get(name, 0.0)

        self.last_values.update(good)
        if self.last_sequence is None or packet.sequence > self.last_sequence:
            self.last_sequence = packet.sequence
        self.last_timestamp = ts
        return ProcessedTelemetry(packet, validation, derived, filled, now)
