"""Telemetry schema: parameter definitions and packet models.

The schema is transport independent: the simulator today and a SAMRH/radio gateway in the future
both produce the same `TelemetryPacketIn`.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator


class Source(str, Enum):
    SIMULATION = "SIMULATION"
    REPLAY = "REPLAY"
    REAL = "REAL"


class Quality(str, Enum):
    VALID = "VALID"
    SUSPECT = "SUSPECT"
    STALE = "STALE"
    MISSING = "MISSING"
    OUT_OF_RANGE = "OUT_OF_RANGE"
    CORRUPTED = "CORRUPTED"


# Worst-first ordering used to roll field qualities up into a packet quality.
QUALITY_RANK = {
    Quality.VALID: 0, Quality.SUSPECT: 1, Quality.STALE: 2,
    Quality.MISSING: 3, Quality.OUT_OF_RANGE: 4, Quality.CORRUPTED: 5,
}


@dataclass(frozen=True)
class ParameterDef:
    name: str
    label: str
    unit: str
    subsystem: str
    type: Literal["float", "int", "enum"]
    nominal_min: float | None
    nominal_max: float | None
    limit_min: float | None
    limit_max: float | None
    description: str
    enum_values: tuple[str, ...] = field(default_factory=tuple)

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["enum_values"] = list(self.enum_values)
        if self.type != "enum":
            d.pop("enum_values")
        return d


P = ParameterDef
PARAMETERS: list[ParameterDef] = [
    # EPS
    P("battery_voltage", "Battery Voltage", "V", "EPS", "float", 6.8, 8.4, 6.0, 8.8,
      "2S Li-ion pack terminal voltage."),
    P("battery_current", "Battery Current", "A", "EPS", "float", 0.0, 4.0, 0.0, 6.0,
      "Magnitude of battery charge/discharge current."),
    P("battery_temperature", "Battery Temperature", "°C", "EPS", "float", 10, 45, 0, 60,
      "Battery pack temperature."),
    P("bus_voltage", "Bus Voltage", "V", "EPS", "float", 4.7, 5.3, 4.4, 5.6, "Regulated 5 V bus voltage."),
    P("bus_current", "Bus Current", "A", "EPS", "float", 0.2, 5.0, 0.0, 6.5, "Total 5 V bus load current."),
    P("power_consumption", "Power Consumption", "W", "EPS", "float", 1, 30, 0, 36, "Total platform power draw."),
    P("solar_input_power", "Solar Input Power", "W", "EPS", "float", 0, 35, 0, 40,
      "Solar array power (0 in eclipse)."),
    P("battery_soc", "Battery SOC", "%", "EPS", "float", 20, 100, 10, 100, "Battery state of charge."),
    # OBC
    P("obc_temperature", "OBC Temperature", "°C", "OBC", "float", 15, 50, 0, 70, "Onboard computer board temperature."),
    P("cpu_load", "CPU Load", "%", "OBC", "float", 5, 90, 0, 100, "OBC processor utilisation."),
    P("memory_usage", "Memory Usage", "%", "OBC", "float", 10, 85, 0, 100, "OBC RAM utilisation."),
    P("watchdog_status", "Watchdog", "", "OBC", "enum", None, None, None, None,
      "Hardware watchdog state.", ("OK", "FAULT")),
    P("obc_uptime", "OBC Uptime", "s", "OBC", "int", None, None, 0, None, "Seconds since last OBC reboot."),
    # ADCS
    P("roll", "Roll", "deg", "ADCS", "float", -10, 10, -180, 180, "Roll attitude error from nadir."),
    P("pitch", "Pitch", "deg", "ADCS", "float", -10, 10, -90, 90, "Pitch attitude error from nadir."),
    P("yaw", "Yaw", "deg", "ADCS", "float", -45, 45, -180, 180, "Yaw attitude."),
    P("gyro_x", "Gyro X", "deg/s", "ADCS", "float", -1.5, 1.5, -10, 10, "Body rate about X."),
    P("gyro_y", "Gyro Y", "deg/s", "ADCS", "float", -1.5, 1.5, -10, 10, "Body rate about Y."),
    P("gyro_z", "Gyro Z", "deg/s", "ADCS", "float", -1.5, 1.5, -10, 10, "Body rate about Z."),
    # COMM
    P("rssi", "RSSI", "dBm", "COMM", "float", -90, -50, -110, -30, "Received signal strength."),
    P("snr", "SNR", "dB", "COMM", "float", 3, 20, -5, 30, "Link signal-to-noise ratio."),
    P("packet_loss", "Packet Loss", "%", "COMM", "float", 0, 3, 0, 100, "Downlink frame loss."),
    P("crc_errors", "CRC Errors", "count", "COMM", "int", 0, 2, 0, 100, "CRC errors in the last interval."),
    # PAYLOAD
    P("payload_temperature", "Payload Temperature", "°C", "PAYLOAD", "float", 5, 40, -10, 60, "Payload sensor temperature."),
    P("payload_power", "Payload Power", "W", "PAYLOAD", "float", 0, 8, 0, 12, "Payload power draw."),
    P("payload_state", "Payload State", "", "PAYLOAD", "enum", None, None, None, None,
      "Payload operating state.", ("IDLE", "ACTIVE", "SAFE")),
]
del P

PARAM_BY_NAME: dict[str, ParameterDef] = {p.name: p for p in PARAMETERS}
NUMERIC_PARAMETERS = [p.name for p in PARAMETERS if p.type != "enum"]
ENUM_PARAMETERS = [p.name for p in PARAMETERS if p.type == "enum"]

SUBSYSTEMS: dict[str, dict[str, str]] = {
    "eps": {"name": "EPS", "description": "Electrical Power System: solar input, battery and regulated bus."},
    "obc": {"name": "OBC", "description": "Onboard Computer: processing, memory, watchdog and thermal state."},
    "adcs": {"name": "ADCS", "description": "Attitude Determination and Control: attitude and body rates."},
    "comm": {"name": "COMM", "description": "Communication subsystem: link budget and frame integrity."},
    "payload": {"name": "PAYLOAD", "description": "Mission payload: thermal, power and operating state."},
}
SUBSYSTEM_PARAMS: dict[str, list[str]] = {
    sid: [p.name for p in PARAMETERS if p.subsystem == meta["name"]] for sid, meta in SUBSYSTEMS.items()
}
SUBSYSTEM_KEY_VALUES: dict[str, list[str]] = {
    "eps": ["battery_voltage", "battery_current", "power_consumption", "battery_temperature", "battery_soc"],
    "obc": ["obc_temperature", "cpu_load", "memory_usage", "watchdog_status", "obc_uptime"],
    "adcs": ["roll", "pitch", "yaw", "gyro_x", "gyro_y", "gyro_z"],
    "comm": ["rssi", "snr", "packet_loss", "crc_errors"],
    "payload": ["payload_temperature", "payload_power", "payload_state"],
}


def subsystem_of(param: str) -> str:
    return PARAM_BY_NAME[param].subsystem


class TelemetryPacketIn(BaseModel):
    """Incoming telemetry packet (the transport-independent ingestion contract)."""

    type: Literal["telemetry"] | None = "telemetry"
    satellite_id: str = Field(min_length=1, max_length=32)
    timestamp: datetime
    sequence: int = Field(ge=0)
    source: Source = Source.SIMULATION
    data: dict[str, float | int | str | None]
    run_id: str | None = None

    @field_validator("data")
    @classmethod
    def _check_data(cls, v: dict[str, Any]) -> dict[str, Any]:
        unknown = [k for k in v if k not in PARAM_BY_NAME]
        if unknown:
            raise ValueError(f"unknown telemetry parameters: {', '.join(sorted(unknown))}")
        for name, value in v.items():
            if value is None:
                continue
            p = PARAM_BY_NAME[name]
            if p.type == "enum":
                if not isinstance(value, str) or value not in p.enum_values:
                    raise ValueError(f"{name} must be one of {list(p.enum_values)}")
            elif isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError(f"{name} must be numeric")
        if not v:
            raise ValueError("data must not be empty")
        return v
