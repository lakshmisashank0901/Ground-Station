"""Train the LSTM predictor (Keras) on processed windows and report train/validation loss."""
from __future__ import annotations

import argparse

from app.ml.lstm import WINDOW, tensorflow_available, train_keras
from app.ml.preprocessing import make_windows
from training._common import load_processed


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--epochs", type=int, default=15)
    ap.add_argument("--stride", type=int, default=2)
    args = ap.parse_args()
    if not tensorflow_available():
        raise SystemExit("TensorFlow is not installed: pip install -r requirements-ml.txt")
    tr, va, _, _ = load_processed()
    x, y = make_windows(tr, WINDOW)
    xv, yv = make_windows(va, WINDOW)
    _, hist = train_keras(x[::args.stride], y[::args.stride], xv[::4], yv[::4], epochs=args.epochs, verbose=2)
    print(hist)


if __name__ == "__main__":
    main()
