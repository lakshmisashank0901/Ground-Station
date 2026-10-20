from __future__ import annotations

from datetime import datetime, timezone


def nominal_data(**overrides) -> dict:
    d = {
        "battery_voltage": 7.42, "battery_current": 1.83, "battery_temperature": 29.4, "bus_voltage": 5.02,
        "bus_current": 3.48, "power_consumption": 17.43, "solar_input_power": 20.0, "battery_soc": 80.0,
        "obc_temperature": 31.7, "cpu_load": 42.1, "memory_usage": 51.3, "watchdog_status": "OK", "obc_uptime": 100,
        "roll": 2.31, "pitch": -0.81, "yaw": 14.22, "gyro_x": 0.1, "gyro_y": -0.1, "gyro_z": 0.02,
        "rssi": -71.0, "snr": 12.4, "packet_loss": 0.8, "crc_errors": 0, "payload_temperature": 22.0,
        "payload_power": 0.5, "payload_state": "IDLE",
    }
    d.update(overrides)
    return d


def packet(sequence: int = 128481, timestamp: datetime | None = None, data: dict | None = None, **kw) -> dict:
    ts = timestamp or datetime.now(timezone.utc)
    return {"type": "telemetry", "satellite_id": "SAT-01", "timestamp": ts.isoformat().replace("+00:00", "Z"),
            "sequence": sequence, "source": "SIMULATION", "data": data or nominal_data(), **kw}
