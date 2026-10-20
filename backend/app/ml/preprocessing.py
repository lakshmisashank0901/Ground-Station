"""Feature preparation shared by training and online inference.

The feature order is persisted in models/metadata.json and must not change between training and
inference.
"""
from __future__ import annotations

from typing import Iterable, Mapping

import numpy as np

from app.telemetry.schemas import NUMERIC_PARAMETERS

# Continuous features used by the statistical/temporal models. obc_uptime is monotonic and carries no
# health information; payload_state is encoded as a 0/1 activity flag because it drives load/thermal
# correlations.
FEATURES: list[str] = [p for p in NUMERIC_PARAMETERS if p != "obc_uptime"] + ["payload_active"]


def feature_vector(values: Mapping[str, float], payload_state: str | None,
                   features: list[str] = FEATURES) -> np.ndarray:
    out = np.empty(len(features), dtype=np.float64)
    for i, name in enumerate(features):
        if name == "payload_active":
            out[i] = 1.0 if payload_state == "ACTIVE" else 0.0
        else:
            out[i] = float(values[name])
    return out


def rows_to_matrix(rows: Iterable[Mapping], features: list[str] = FEATURES) -> np.ndarray:
    """Build a feature matrix from telemetry dicts (chronologically sorted by the caller)."""
    return np.vstack([feature_vector(r, r.get("payload_state"), features) for r in rows])


class StandardScaler:
    """Minimal standard scaler (fit on training data only) with a stable pickle format."""

    def __init__(self) -> None:
        self.mean_: np.ndarray | None = None
        self.scale_: np.ndarray | None = None

    def fit(self, x: np.ndarray) -> "StandardScaler":
        self.mean_ = x.mean(axis=0)
        std = x.std(axis=0)
        self.scale_ = np.where(std < 1e-6, 1.0, std)
        return self

    def transform(self, x: np.ndarray) -> np.ndarray:
        return (x - self.mean_) / self.scale_

    def inverse_transform(self, z: np.ndarray) -> np.ndarray:
        return z * self.scale_ + self.mean_


def chronological_split(n: int, train: float = 0.70, val: float = 0.15) -> tuple[slice, slice, slice]:
    """70/15/15 chronological split (never random for time series)."""
    a = int(n * train)
    b = int(n * (train + val))
    return slice(0, a), slice(a, b), slice(b, n)


def make_windows(z: np.ndarray, window: int) -> tuple[np.ndarray, np.ndarray]:
    """Sliding windows of `window` samples predicting the next sample."""
    n = len(z) - window
    if n <= 0:
        return np.empty((0, window, z.shape[1])), np.empty((0, z.shape[1]))
    idx = np.arange(window)[None, :] + np.arange(n)[:, None]
    return z[idx], z[window:]
