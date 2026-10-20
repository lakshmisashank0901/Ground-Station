from datetime import datetime, timedelta, timezone

import pytest

from app.telemetry.decoder import DecodeError, crc16_ccitt, decode_frame, decode_json, encode_frame
from app.telemetry.processor import TelemetryProcessor, power, rate
from app.telemetry.schemas import Quality, TelemetryPacketIn
from app.telemetry.validator import classify_value, validate_packet
from tests.helpers import nominal_data, packet


def test_schema_accepts_valid_packet():
    p = TelemetryPacketIn.model_validate(packet())
    assert p.satellite_id == "SAT-01" and p.data["battery_voltage"] == 7.42


@pytest.mark.parametrize("mutate", [
    lambda d: d["data"].update(unknown_param=1.0),
    lambda d: d["data"].update(battery_voltage="high"),
    lambda d: d["data"].update(watchdog_status="MAYBE"),
    lambda d: d.update(sequence=-1),
    lambda d: d.update(timestamp="not-a-time"),
    lambda d: d.update(data={}),
    lambda d: d.pop("satellite_id"),
])
def test_schema_rejects_invalid_packets(mutate):
    d = packet()
    mutate(d)
    with pytest.raises(DecodeError):
        decode_json(d)


def test_quality_classification():
    assert classify_value("battery_voltage", 7.4) == Quality.VALID
    assert classify_value("battery_voltage", 6.5) == Quality.SUSPECT        # outside nominal, inside limits
    assert classify_value("battery_voltage", 12.0) == Quality.OUT_OF_RANGE  # outside hard limits
    assert classify_value("battery_voltage", None) == Quality.MISSING
    assert classify_value("battery_voltage", float("nan")) == Quality.CORRUPTED


def test_packet_quality_is_worst_field_and_staleness():
    now = datetime.now(timezone.utc)
    d = packet(timestamp=now)
    d["data"]["obc_temperature"] = 95.0
    v = validate_packet(TelemetryPacketIn.model_validate(d), now=now)
    assert v.quality == Quality.OUT_OF_RANGE and v.field_quality == {"obc_temperature": Quality.OUT_OF_RANGE}

    d = packet(timestamp=now - timedelta(seconds=60))
    d["data"].pop("rssi")
    v = validate_packet(TelemetryPacketIn.model_validate(d), now=now, stale_after_s=10)
    assert v.field_quality["rssi"] == Quality.MISSING
    assert v.quality == Quality.MISSING  # MISSING outranks STALE

    v = validate_packet(TelemetryPacketIn.model_validate(packet(timestamp=now - timedelta(seconds=60))), now=now)
    assert v.quality == Quality.STALE


def test_derived_values_and_sequence_gaps():
    assert power(5.0, 2.0) == 10.0 and power(None, 2.0) is None
    assert rate(30.0, 29.0, 2.0) == 0.5 and rate(30.0, None, 1.0) == 0.0
    proc = TelemetryProcessor()
    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    out = []
    for seq, dt, temp in [(1, 0, 30.0), (2, 1, 30.5), (5, 2, 31.5)]:
        p = TelemetryPacketIn.model_validate(packet(sequence=seq, timestamp=t0 + timedelta(seconds=dt),
                                                    data=nominal_data(obc_temperature=temp)))
        out.append(proc.process(p, validate_packet(p, check_staleness=False), now=t0 + timedelta(seconds=dt)))
    assert out[1].derived["obc_temperature_rate"] == pytest.approx(0.5)
    assert out[2].derived["sequence_gap"] == 2
    assert out[2].derived["packet_loss_rate"] == pytest.approx(100 * 2 / 5)
    assert out[0].derived["power_calc"] == pytest.approx(5.02 * 3.48, rel=1e-3)


def test_missing_values_are_filled_for_ml():
    proc = TelemetryProcessor(fill_defaults={"rssi": -70.0})
    p = TelemetryPacketIn.model_validate(packet(data={k: v for k, v in nominal_data().items() if k != "rssi"}))
    out = proc.process(p, validate_packet(p, check_staleness=False))
    assert out.filled["rssi"] == -70.0


def test_frame_roundtrip_and_crc_detection():
    frame = encode_frame(packet())
    assert decode_frame(frame).sequence == 128481
    bad = bytearray(frame)
    bad[20] ^= 0x01
    with pytest.raises(DecodeError, match="CRC"):
        decode_frame(bytes(bad))
    with pytest.raises(DecodeError):
        decode_frame(b"XXXX" + frame[4:])
    assert crc16_ccitt(b"123456789") == 0x29B1  # CRC-16/CCITT-FALSE check value
