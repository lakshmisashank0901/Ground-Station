"""Data-quality classification for decoded telemetry packets."""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timezone

from app.telemetry.schemas import (
    PARAM_BY_NAME,
    PARAMETERS,
    QUALITY_RANK,
    Quality,
    TelemetryPacketIn,
)


@dataclass
class ValidationResult:
    quality: Quality
    field_quality: dict[str, Quality]  # only fields that are not VALID

    @property
    def is_usable(self) -> bool:
        return self.quality != Quality.CORRUPTED


def classify_value(name: str, value) -> Quality:
    p = PARAM_BY_NAME[name]
    if value is None:
        return Quality.MISSING
    if p.type == "enum":
        return Quality.VALID if value in p.enum_values else Quality.CORRUPTED
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return Quality.CORRUPTED
    if (p.limit_min is not None and value < p.limit_min) or (p.limit_max is not None and value > p.limit_max):
        return Quality.OUT_OF_RANGE
    if (p.nominal_min is not None and value < p.nominal_min) or (p.nominal_max is not None and value > p.nominal_max):
        return Quality.SUSPECT
    return Quality.VALID


def validate_packet(packet: TelemetryPacketIn, now: datetime | None = None,
                    stale_after_s: float = 10.0, check_staleness: bool = True) -> ValidationResult:
    field_quality: dict[str, Quality] = {}
    for p in PARAMETERS:
        q = classify_value(p.name, packet.data.get(p.name))
        if q != Quality.VALID:
            field_quality[p.name] = q

    worst = Quality.VALID
    for q in field_quality.values():
        if QUALITY_RANK[q] > QUALITY_RANK[worst]:
            worst = q

    if check_staleness:
        now = now or datetime.now(timezone.utc)
        ts = packet.timestamp if packet.timestamp.tzinfo else packet.timestamp.replace(tzinfo=timezone.utc)
        if (now - ts).total_seconds() > stale_after_s and QUALITY_RANK[worst] < QUALITY_RANK[Quality.STALE]:
            worst = Quality.STALE
    return ValidationResult(quality=worst, field_quality=field_quality)
