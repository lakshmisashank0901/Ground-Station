"""Fit the Isolation Forest baseline on the processed training split and report test exceedance."""
from __future__ import annotations

import numpy as np

from app.ml.isolation_forest import IsolationForestDetector
from training._common import load_processed


def main() -> None:
    tr, va, te, _ = load_processed()
    det = IsolationForestDetector().fit(tr)
    thr = det.calibrate(va, 0.999)
    print(f"threshold: {thr:.4f}; test exceedance: {np.mean(det.raw_score(te) > thr):.4%}")


if __name__ == "__main__":
    main()
