"""Isolation Forest baseline (comparison model, excluded from fusion by default)."""
from __future__ import annotations

import numpy as np
from sklearn.ensemble import IsolationForest


class IsolationForestDetector:
    def __init__(self, n_estimators: int = 150, random_state: int = 7) -> None:
        self.model = IsolationForest(n_estimators=n_estimators, contamination="auto",
                                     random_state=random_state, n_jobs=1)
        self.threshold_: float | None = None

    def fit(self, z: np.ndarray) -> "IsolationForestDetector":
        self.model.fit(z)
        return self

    def raw_score(self, z: np.ndarray) -> np.ndarray:
        """Higher = more anomalous (negated sklearn score_samples, ~0.35–0.8)."""
        return -self.model.score_samples(np.atleast_2d(z))

    def calibrate(self, z_val: np.ndarray, quantile: float = 0.995) -> float:
        self.threshold_ = float(np.quantile(self.raw_score(z_val), quantile))
        return self.threshold_
