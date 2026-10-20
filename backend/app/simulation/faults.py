"""Fault injection engine.

Each active fault contributes *effects* that the spacecraft model applies to its physical state
(e.g. extra OBC heat) or to the reported sensor values only (e.g. sensor drift). Effects are computed
from the fault's elapsed time so behaviour is deterministic and reproducible.
"""
from __future__ import annotations

import math
import uuid
from dataclasses import dataclass, field

SEVERITY_GAIN = {"mild": 0.5, "moderate": 1.0, "severe": 1.6}

DEFAULT_DURATION_S = {
    "obc_thermal": 600, "power_degradation": 600, "sensor_drift": 900, "comm_degradation": 420,
    "obc_overload": 420, "multiple_fault": 600, "transient_spike": 6,
}

# A composite scenario expands into several primitive faults.
COMPOSITES = {"multiple_fault": ["obc_thermal", "comm_degradation"]}


def ramp(elapsed: float, rise_s: float) -> float:
    """0→1 linear ramp over rise_s seconds."""
    if rise_s <= 0:
        return 1.0
    return max(0.0, min(1.0, elapsed / rise_s))


@dataclass
class Effects:
    """Aggregated effects of all active faults for one simulation step."""

    obc_heat_c: float = 0.0          # added to OBC equilibrium temperature
    solar_factor: float = 1.0        # multiplier on solar array output
    bus_voltage_sag_v: float = 0.0
    bus_current_extra_a: float = 0.0
    cpu_extra: float = 0.0
    memory_extra: float = 0.0
    rssi_drop_db: float = 0.0
    crc_rate_extra: float = 0.0
    packet_loss_extra: float = 0.0
    gyro_kick: tuple[float, float, float] = (0.0, 0.0, 0.0)
    attitude_kick: tuple[float, float] = (0.0, 0.0)
    watchdog_fault: bool = False
    # Biases applied only to reported values (sensor faults), not the true physical state.
    sensor_bias: dict[str, float] = field(default_factory=dict)


@dataclass
class Fault:
    scenario: str
    severity: str
    start_t: float                    # simulation seconds
    duration_s: float
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    parent: str | None = None         # composite scenario that spawned this fault

    @property
    def gain(self) -> float:
        return SEVERITY_GAIN[self.severity]

    def status(self, t: float) -> str:
        if t < self.start_t:
            return "PENDING"
        if t >= self.start_t + self.duration_s:
            return "ENDED"
        return "ACTIVE"

    def apply(self, t: float, fx: Effects) -> None:
        if self.status(t) != "ACTIVE":
            return
        e = t - self.start_t
        g = self.gain
        s = self.scenario
        if s == "obc_thermal":
            # Progressive heating from a failing thermal path (e.g. degraded heat sink contact).
            fx.obc_heat_c += g * 32.0 * ramp(e, 240)
        elif s == "power_degradation":
            fx.solar_factor *= 1.0 - min(0.85, g * 0.45) * ramp(e, 90)
            fx.bus_voltage_sag_v += g * 0.22 * ramp(e, 120)
            fx.bus_current_extra_a += g * 0.35 * ramp(e, 120)
        elif s == "sensor_drift":
            fx.sensor_bias["battery_temperature"] = fx.sensor_bias.get("battery_temperature", 0.0) + g * 0.03 * e
            fx.sensor_bias["battery_voltage"] = fx.sensor_bias.get("battery_voltage", 0.0) + g * 0.0009 * e
        elif s == "comm_degradation":
            r = ramp(e, 60)
            fx.rssi_drop_db += g * 18.0 * r
            fx.crc_rate_extra += g * 4.0 * r
            fx.packet_loss_extra += g * 4.0 * r
        elif s == "obc_overload":
            r = ramp(e, 30)
            fx.cpu_extra += g * 42.0 * r
            fx.memory_extra += g * 22.0 * r
            fx.bus_current_extra_a += g * 0.45 * r
            if g >= 1.5 and e > 120:
                fx.watchdog_fault = True
        elif s == "transient_spike":
            decay = math.exp(-e / 2.0)
            fx.gyro_kick = tuple(a + b for a, b in zip(fx.gyro_kick, (g * 6.0 * decay, -g * 4.5 * decay, g * 2.0 * decay)))
            fx.attitude_kick = (fx.attitude_kick[0] + g * 9.0 * decay, fx.attitude_kick[1] - g * 6.0 * decay)
            fx.bus_current_extra_a += g * 1.6 * decay

    def to_dict(self, t: float, epoch) -> dict:
        from datetime import timedelta

        from app.telemetry.processor import iso
        return {
            "id": self.id,
            "scenario": self.parent or self.scenario,
            "component": self.scenario,
            "severity": self.severity,
            "start_time": iso(epoch + timedelta(seconds=self.start_t)),
            "duration_s": self.duration_s,
            "elapsed_s": round(max(0.0, t - self.start_t), 1),
            "status": self.status(t),
        }


def build_faults(scenario: str, severity: str, start_t: float, duration_s: float | None) -> list[Fault]:
    if severity not in SEVERITY_GAIN:
        raise ValueError(f"unknown severity {severity!r}")
    duration = float(duration_s) if duration_s else float(DEFAULT_DURATION_S[scenario])
    parts = COMPOSITES.get(scenario)
    if parts:
        return [Fault(p, severity, start_t, duration, parent=scenario) for p in parts]
    return [Fault(scenario, severity, start_t, duration)]
