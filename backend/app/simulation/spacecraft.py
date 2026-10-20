"""Coherent spacecraft state model.

Telemetry is derived from a physical state (orbit/eclipse → solar power → battery SOC/voltage;
CPU load + power → OBC temperature; ...) so variables are correlated the way real housekeeping
data is. This is what makes multivariate and temporal anomaly detection meaningful.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from app.simulation.faults import Effects, Fault

ORBIT_PERIOD_S = 5700.0      # ~95 min LEO
ECLIPSE_FRACTION = 0.36
BATTERY_CAPACITY_WH = 35.0

NOISE = {
    "battery_voltage": 0.008, "battery_current": 0.02, "battery_temperature": 0.08, "bus_voltage": 0.008,
    "bus_current": 0.02, "solar_input_power": 0.25, "obc_temperature": 0.12, "cpu_load": 1.5,
    "memory_usage": 0.4, "roll": 0.08, "pitch": 0.08, "yaw": 0.15, "gyro": 0.03, "rssi": 1.0,
    "snr": 0.4, "packet_loss": 0.08, "payload_temperature": 0.1, "payload_power": 0.05,
}


def _relax(value: float, target: float, tau_s: float, dt: float) -> float:
    return value + (target - value) * (1.0 - math.exp(-dt / tau_s))


@dataclass
class Spacecraft:
    seed: int = 1
    t: float = 0.0                      # simulation seconds since run epoch
    orbit_phase0: float = 0.1           # initial orbit phase (0..1)
    soc: float = 82.0
    battery_temp: float = 22.0
    obc_temp: float = 28.0
    payload_temp: float = 20.0
    roll: float = 0.0
    pitch: float = 0.0
    cpu_ar: float = 0.0                 # AR(1) component of CPU load
    mem_ar: float = 0.0
    uptime: int = 0
    payload_state: str = "IDLE"
    rng: np.random.Generator = field(init=False)

    def __post_init__(self) -> None:
        self.rng = np.random.default_rng(self.seed)

    # ----------------------------------------------------------------------------------- helpers
    def n(self, key: str, scale: float = 1.0) -> float:
        return float(self.rng.normal(0.0, NOISE[key] * scale))

    def orbit_phase(self) -> float:
        return (self.orbit_phase0 + self.t / ORBIT_PERIOD_S) % 1.0

    def sun_factor(self) -> float:
        """1 in sunlight, 0 in eclipse, with ~60 s penumbra transitions."""
        ph = self.orbit_phase()
        sunlit_end = 1.0 - ECLIPSE_FRACTION
        edge = 60.0 / ORBIT_PERIOD_S
        if ph < edge:
            return ph / edge
        if ph < sunlit_end - edge:
            return 1.0
        if ph < sunlit_end:
            return (sunlit_end - ph) / edge
        return 0.0

    # -------------------------------------------------------------------------------------- step
    def step(self, dt: float, faults: list[Fault], overrides: dict[str, float] | None = None) -> dict:
        self.t += dt
        self.uptime += int(round(dt))
        fx = Effects()
        for f in faults:
            f.apply(self.t, fx)

        sun = self.sun_factor()
        ph = self.orbit_phase()
        tt = self.t

        # Payload duty cycle: imaging window in sunlight, safe mode on low battery.
        if self.soc < 25:
            self.payload_state = "SAFE"
        elif 0.15 <= ph < 0.30:
            self.payload_state = "ACTIVE"
        else:
            self.payload_state = "IDLE"
        active = self.payload_state == "ACTIVE"
        payload_power = (6.0 if active else 0.5 if self.payload_state == "IDLE" else 0.2) + self.n("payload_power")

        # OBC load
        self.cpu_ar = 0.95 * self.cpu_ar + self.n("cpu_load", 0.6)
        cpu = 30.0 + 15.0 * active + 4.0 * math.sin(2 * math.pi * tt / 300.0) + self.cpu_ar + fx.cpu_extra
        cpu = min(100.0, max(0.0, cpu + self.n("cpu_load", 0.5)))
        self.mem_ar = 0.98 * self.mem_ar + self.n("memory_usage", 0.5)
        mem = 44.0 + 8.0 * active + 3.0 * ((tt % 900.0) / 900.0) + self.mem_ar + fx.memory_extra
        mem = min(100.0, max(0.0, mem + self.n("memory_usage", 0.5)))

        # Power system
        bus_current = 1.4 + 0.012 * cpu + payload_power / 5.0 + 0.15 + fx.bus_current_extra_a
        bus_voltage = 5.02 - 0.01 * bus_current - fx.bus_voltage_sag_v
        power_consumption = bus_voltage * bus_current
        solar = max(0.0, sun * 30.0 * (0.9 + 0.1 * math.sin(2 * math.pi * ph * 3)) * fx.solar_factor)
        net_w = solar * 0.92 - power_consumption / 0.9
        if self.soc >= 99.5 and net_w > 0:
            net_w = 1.0  # shunt regulation: trickle charge when full
        self.soc = min(100.0, max(0.0, self.soc + net_w * dt / (BATTERY_CAPACITY_WH * 3600.0) * 100.0))
        battery_voltage = 6.9 + 1.3 * self.soc / 100.0 + 0.012 * net_w
        battery_current = abs(net_w) / battery_voltage

        # Thermal
        self.battery_temp = _relax(self.battery_temp, 17.0 + 8.0 * sun + 0.8 * battery_current ** 2, 900.0, dt)
        obc_target = 12.0 + 6.0 * sun + 0.22 * cpu + 0.35 * power_consumption + fx.obc_heat_c
        self.obc_temp = _relax(self.obc_temp, obc_target, 240.0, dt)
        self.payload_temp = _relax(self.payload_temp, 14.0 + 9.0 * sun + 2.5 * payload_power, 600.0, dt)

        # Attitude (nadir pointing with small disturbances)
        prev_roll, prev_pitch = self.roll, self.pitch
        self.roll = 0.97 * self.roll + self.n("roll", 3.0)
        self.pitch = 0.97 * self.pitch + self.n("pitch", 3.0)
        roll = self.roll + fx.attitude_kick[0]
        pitch = self.pitch + fx.attitude_kick[1]
        yaw = 15.0 * math.sin(2 * math.pi * tt / ORBIT_PERIOD_S) + self.n("yaw")
        gyro_x = (self.roll - prev_roll) / dt + fx.gyro_kick[0] + self.n("gyro")
        gyro_y = (self.pitch - prev_pitch) / dt + fx.gyro_kick[1] + self.n("gyro")
        gyro_z = 15.0 * 2 * math.pi / ORBIT_PERIOD_S * math.cos(2 * math.pi * tt / ORBIT_PERIOD_S) \
            + fx.gyro_kick[2] + self.n("gyro")

        # Communication link
        rssi = -72.0 + 4.0 * math.sin(2 * math.pi * tt / 1800.0) - fx.rssi_drop_db + self.n("rssi")
        snr = rssi + 85.0 + self.n("snr")
        packet_loss = max(0.0, 0.3 + 25.0 * math.exp(-max(snr, -5.0) / 2.5) + fx.packet_loss_extra + self.n("packet_loss"))
        crc_rate = 0.15 + 3.0 * math.exp(-max(snr, -5.0) / 3.0) + fx.crc_rate_extra
        crc_errors = int(self.rng.poisson(crc_rate))

        data = {
            "battery_voltage": battery_voltage + self.n("battery_voltage") + fx.sensor_bias.get("battery_voltage", 0.0),
            "battery_current": max(0.0, battery_current + self.n("battery_current")),
            "battery_temperature": self.battery_temp + self.n("battery_temperature")
            + fx.sensor_bias.get("battery_temperature", 0.0),
            "bus_voltage": bus_voltage + self.n("bus_voltage"),
            "bus_current": bus_current + self.n("bus_current"),
            "power_consumption": power_consumption,
            "solar_input_power": max(0.0, solar + (self.n("solar_input_power") if solar > 0 else 0.0)),
            "battery_soc": self.soc,
            "obc_temperature": self.obc_temp + self.n("obc_temperature"),
            "cpu_load": cpu,
            "memory_usage": mem,
            "watchdog_status": "FAULT" if fx.watchdog_fault else "OK",
            "obc_uptime": self.uptime,
            "roll": roll,
            "pitch": pitch,
            "yaw": yaw,
            "gyro_x": gyro_x,
            "gyro_y": gyro_y,
            "gyro_z": gyro_z,
            "rssi": rssi,
            "snr": snr,
            "packet_loss": min(100.0, packet_loss),
            "crc_errors": crc_errors,
            "payload_temperature": self.payload_temp + self.n("payload_temperature"),
            "payload_power": max(0.0, payload_power),
            "payload_state": self.payload_state,
        }
        if overrides:
            data.update({k: v for k, v in overrides.items() if k in data})
        return {k: (round(v, 4) if isinstance(v, float) else v) for k, v in data.items()}
