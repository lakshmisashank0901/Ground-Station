"""Helpers for the per-model training scripts (they operate on datasets/processed)."""
from __future__ import annotations

import numpy as np

from app.core.config import get_settings


def load_processed():
    path = get_settings().datasets_dir / "processed" / "normal_scaled.npz"
    if not path.exists():
        raise SystemExit(f"{path} missing - run `python -m training.preprocessing` first")
    with np.load(path) as f:
        return f["train"], f["val"], f["test"], list(f["features"])
