"""Multivariate Mahalanobis-distance detector.

D_M(x) = sqrt((x - μ)^T Σ^-1 (x - μ)), with μ, Σ estimated from normal operation (on scaled features).
A shrinkage covariance estimate keeps Σ well conditioned.
"""
from __future__ import annotations

import numpy as np
from sklearn.covariance import LedoitWolf


class MahalanobisDetector:
    def __init__(self) -> None:
        self.mean_: np.ndarray | None = None
        self.precision_: np.ndarray | None = None
        self.threshold_: float | None = None

    def fit(self, z: np.ndarray) -> "MahalanobisDetector":
        lw = LedoitWolf().fit(z)
        self.mean_ = lw.location_
        self.precision_ = np.linalg.inv(lw.covariance_)
        return self

    def distance(self, z: np.ndarray) -> np.ndarray:
        d = np.atleast_2d(z) - self.mean_
        d2 = np.einsum("ij,jk,ik->i", d, self.precision_, d)
        return np.sqrt(np.maximum(d2, 0.0))

    def contributions(self, z: np.ndarray) -> np.ndarray:
        """Per-feature additive decomposition of D²: c_i = d_i (Σ^-1 d)_i (sums to D²)."""
        d = np.asarray(z) - self.mean_
        return d * (self.precision_ @ d)

    def calibrate(self, z_val: np.ndarray, quantile: float = 0.995) -> float:
        self.threshold_ = float(np.quantile(self.distance(z_val), quantile))
        return self.threshold_
