"""Fit the Mahalanobis detector on the processed training split and report its calibrated threshold and
false-alarm rate on the test split. The deployed artefacts are produced by `training.train_all`."""
from __future__ import annotations

import numpy as np

from app.ml.mahalanobis import MahalanobisDetector
from training._common import load_processed


def main() -> None:
    tr, va, te, _ = load_processed()
    det = MahalanobisDetector().fit(tr)
    thr = det.calibrate(va, 0.999)
    print(f"threshold (99.9% of validation): {thr:.3f}; test exceedance: {np.mean(det.distance(te) > thr):.4%}")


if __name__ == "__main__":
    main()
