"""Packet decoding.

Two wire formats are supported so the ingestion path is independent of the transport:

* JSON packets (REST ingestion, simulator).
* Framed packets for a future serial/CAN/RS-422/radio gateway:
      b"SATF" | uint16 big-endian payload length | JSON payload | uint16 CRC-16/CCITT-FALSE
  The CRC covers the length field and payload. A bad sync word, length or CRC raises
  `DecodeError` and the packet is counted as CORRUPTED.
"""
from __future__ import annotations

import json
import struct
from typing import Any

from pydantic import ValidationError

from app.telemetry.schemas import TelemetryPacketIn

SYNC = b"SATF"


class DecodeError(ValueError):
    pass


def crc16_ccitt(data: bytes, crc: int = 0xFFFF) -> int:
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) if crc & 0x8000 else (crc << 1)
            crc &= 0xFFFF
    return crc


def encode_frame(packet: dict[str, Any]) -> bytes:
    payload = json.dumps(packet, separators=(",", ":"), default=str).encode()
    body = struct.pack(">H", len(payload)) + payload
    return SYNC + body + struct.pack(">H", crc16_ccitt(body))


def decode_frame(frame: bytes) -> TelemetryPacketIn:
    if len(frame) < 8 or not frame.startswith(SYNC):
        raise DecodeError("bad sync word or short frame")
    (length,) = struct.unpack(">H", frame[4:6])
    if len(frame) != 4 + 2 + length + 2:
        raise DecodeError("frame length mismatch")
    body = frame[4:6 + length]
    (crc,) = struct.unpack(">H", frame[6 + length:])
    if crc16_ccitt(body) != crc:
        raise DecodeError("CRC mismatch")
    return decode_json(frame[6:6 + length])


def decode_json(raw: bytes | str | dict[str, Any]) -> TelemetryPacketIn:
    try:
        obj = json.loads(raw) if isinstance(raw, (bytes, str)) else raw
    except json.JSONDecodeError as exc:
        raise DecodeError(f"invalid JSON: {exc}") from exc
    try:
        return TelemetryPacketIn.model_validate(obj)
    except ValidationError as exc:
        raise DecodeError(f"schema validation failed: {exc.errors(include_url=False)}") from exc
