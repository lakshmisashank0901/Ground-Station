"""Generate simulator datasets: datasets/raw (normal run), datasets/processed (scaled 70/15/15 split)
and datasets/cleaned (labelled fault-injection runs).

    python -m training.preprocessing [--samples 96000]
"""
from __future__ import annotations

import argparse
import itertools

import numpy as np

from app.core.config import get_settings
from app.ml.preprocessing import FEATURES, StandardScaler, chronological_split, rows_to_matrix
from app.ml.training import generate_fault_run, generate_normal, save_csv
from app.simulation.scenarios import FAULT_SCENARIOS


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--samples", type=int, default=96_000)
    ap.add_argument("--seed", type=int, default=11)
    args = ap.parse_args()
    d = get_settings().datasets_dir
    normal = generate_normal(args.samples, args.seed)
    save_csv(d / "raw" / "normal.csv", normal)
    x = rows_to_matrix(normal)
    tr, va, te = chronological_split(len(x))
    z = StandardScaler().fit(x[tr]).transform(x)
    (d / "processed").mkdir(parents=True, exist_ok=True)
    np.savez_compressed(d / "processed" / "normal_scaled.npz", train=z[tr], val=z[va], test=z[te],
                        features=np.array(FEATURES))
    for i, (s, sev) in enumerate(itertools.product(FAULT_SCENARIOS, ["mild", "moderate", "severe"])):
        rows, labels, meta = generate_fault_run(s, sev, seed=5000 + i)
        save_csv(d / "cleaned" / f"test_{s}_{sev}.csv", rows, labels)
    print(f"wrote {len(normal)} normal samples and {len(FAULT_SCENARIOS) * 3} labelled fault runs to {d}")


if __name__ == "__main__":
    main()
