"""Train every model, calibrate thresholds, tune fusion and evaluate.

    python -m training.train_all            # full training (3 severities, larger dataset)
    python -m training.train_all --fast     # quick training (used automatically on first start-up)
"""
from __future__ import annotations

import argparse
import json
import logging

from app.core.config import get_settings
from app.ml.training import train_all


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--fast", action="store_true")
    ap.add_argument("--no-lstm", action="store_true", help="skip TensorFlow; use the ridge fallback predictor")
    ap.add_argument("--seed", type=int, default=11)
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    s = get_settings()
    meta = train_all(s.models_dir, s.datasets_dir, fast=args.fast, lstm_enabled=not args.no_lstm, seed=args.seed)
    print(json.dumps({"version": meta["version"], "thresholds": meta["thresholds"], "fusion": meta["fusion"],
                      "evaluation": meta["evaluation"]}, indent=2))


if __name__ == "__main__":
    main()
