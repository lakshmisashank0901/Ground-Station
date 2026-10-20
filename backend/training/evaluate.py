"""Evaluate the saved models (models/) on freshly generated labelled fault runs and normal data."""
from __future__ import annotations

import argparse
import itertools
import json

from app.core.config import get_settings
from app.ml.inference import ModelBundle
from app.ml.training import evaluate, generate_fault_run, generate_normal
from app.simulation.scenarios import FAULT_SCENARIOS


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--seed", type=int, default=9000)
    args = ap.parse_args()
    bundle = ModelBundle.load(get_settings().models_dir)
    if bundle is None:
        raise SystemExit("no trained models - run `python -m training.train_all` first")
    runs = [generate_fault_run(s, sev, seed=args.seed + i)
            for i, (s, sev) in enumerate(itertools.product(FAULT_SCENARIOS, ["mild", "moderate", "severe"]))]
    result = evaluate(bundle, runs, generate_normal(14_400, args.seed))
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
