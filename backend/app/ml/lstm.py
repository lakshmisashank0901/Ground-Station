"""LSTM temporal predictor.

Architecture (spec 8.4):  input 60 × N → LSTM(64) → Dropout(0.2) → LSTM(32) → Dense(16) → Dense(N)

Training uses Keras/TensorFlow (training-only dependency). The trained weights are exported to an
`.npz` file and inference runs in plain numpy (`NumpyLSTMPredictor`), so the API server neither needs
TensorFlow nor pays its latency/threading costs. If TensorFlow is not installed, a ridge
autoregressive predictor over the same window (`RidgeWindowPredictor`) is used instead and is
reported as such in the model status.
"""
from __future__ import annotations

import time
from pathlib import Path

import numpy as np

WINDOW = 60


def tensorflow_available() -> bool:
    try:
        import tensorflow  # noqa: F401
        return True
    except Exception:  # pragma: no cover - depends on environment
        return False


def build_keras_model(n_features: int, window: int = WINDOW):
    import keras
    from keras import layers

    model = keras.Sequential([
        keras.Input(shape=(window, n_features)),
        layers.LSTM(64, return_sequences=True),
        layers.Dropout(0.2),
        layers.LSTM(32),
        layers.Dense(16, activation="relu"),
        layers.Dense(n_features),
    ])
    model.compile(optimizer=keras.optimizers.Adam(1e-3), loss="mse")
    return model


def train_keras(x: np.ndarray, y: np.ndarray, x_val: np.ndarray, y_val: np.ndarray,
                epochs: int = 8, batch_size: int = 256, seed: int = 7, verbose: int = 0):
    import keras

    keras.utils.set_random_seed(seed)
    model = build_keras_model(x.shape[2], x.shape[1])
    t0 = time.time()
    hist = model.fit(
        x, y, validation_data=(x_val, y_val), epochs=epochs, batch_size=batch_size, verbose=verbose,
        callbacks=[keras.callbacks.EarlyStopping(patience=2, restore_best_weights=True)],
    )
    return model, {"epochs": len(hist.history["loss"]), "train_loss": float(hist.history["loss"][-1]),
                   "val_loss": float(min(hist.history["val_loss"])), "train_time_s": round(time.time() - t0, 1)}


def export_keras_weights(model) -> dict[str, np.ndarray]:
    """Extract weights by layer type into a flat dict for NumpyLSTMPredictor."""
    out: dict[str, np.ndarray] = {}
    lstm_i = dense_i = 0
    for layer in model.layers:
        cls = layer.__class__.__name__
        w = layer.get_weights()
        if cls == "LSTM":
            out[f"lstm{lstm_i}_kernel"], out[f"lstm{lstm_i}_recurrent"], out[f"lstm{lstm_i}_bias"] = w
            lstm_i += 1
        elif cls == "Dense":
            out[f"dense{dense_i}_kernel"], out[f"dense{dense_i}_bias"] = w
            dense_i += 1
    return out


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-x))


class NumpyLSTMPredictor:
    """Exact numpy re-implementation of the Keras forward pass (gate order i, f, c, o)."""

    backend = "keras-lstm (numpy inference)"

    def __init__(self, weights: dict[str, np.ndarray]) -> None:
        self.w = {k: np.asarray(v, dtype=np.float64) for k, v in weights.items()}

    @classmethod
    def load(cls, path: Path) -> "NumpyLSTMPredictor":
        with np.load(path) as f:
            return cls({k: f[k] for k in f.files})

    def save(self, path: Path) -> None:
        np.savez(path, **self.w)

    def _lstm(self, x: np.ndarray, idx: int, return_sequences: bool) -> np.ndarray:
        k, r, b = self.w[f"lstm{idx}_kernel"], self.w[f"lstm{idx}_recurrent"], self.w[f"lstm{idx}_bias"]
        units = r.shape[0]
        batch, steps, _ = x.shape
        h = np.zeros((batch, units))
        c = np.zeros((batch, units))
        xk = x @ k + b  # precompute input projection for all steps
        seq = []
        for t in range(steps):
            z = xk[:, t] + h @ r
            i = _sigmoid(z[:, :units])
            f = _sigmoid(z[:, units:2 * units])
            g = np.tanh(z[:, 2 * units:3 * units])
            o = _sigmoid(z[:, 3 * units:])
            c = f * c + i * g
            h = o * np.tanh(c)
            if return_sequences:
                seq.append(h)
        return np.stack(seq, axis=1) if return_sequences else h

    def predict(self, windows: np.ndarray, chunk: int = 1024) -> np.ndarray:
        x = windows if windows.ndim == 3 else windows[None]
        if len(x) > chunk:
            return np.vstack([self.predict(x[i:i + chunk]) for i in range(0, len(x), chunk)])
        # errstate: numpy 2.0 + macOS Accelerate emits spurious FP warnings from matmul.
        with np.errstate(all="ignore"):
            h = self._lstm(x, 0, True)
            h = self._lstm(h, 1, False)
            h = np.maximum(0.0, h @ self.w["dense0_kernel"] + self.w["dense0_bias"])
            return h @ self.w["dense1_kernel"] + self.w["dense1_bias"]


class RidgeWindowPredictor:
    """Fallback temporal predictor when TensorFlow is unavailable: ridge regression on the last
    `lags` samples of the window."""

    backend = "ridge-ar (fallback, TensorFlow unavailable)"

    def __init__(self, lags: int = 10, alpha: float = 1.0) -> None:
        self.lags = lags
        self.alpha = alpha
        self.coef_: np.ndarray | None = None

    def _design(self, windows: np.ndarray) -> np.ndarray:
        x = windows[:, -self.lags:, :].reshape(len(windows), -1)
        return np.hstack([x, np.ones((len(x), 1))])

    def fit(self, windows: np.ndarray, y: np.ndarray) -> "RidgeWindowPredictor":
        a = self._design(windows)
        reg = self.alpha * np.eye(a.shape[1])
        reg[-1, -1] = 0.0
        self.coef_ = np.linalg.solve(a.T @ a + reg, a.T @ y)
        return self

    def predict(self, windows: np.ndarray) -> np.ndarray:
        x = windows if windows.ndim == 3 else windows[None]
        return self._design(x) @ self.coef_

    def save(self, path: Path) -> None:
        np.savez(path, coef=self.coef_, lags=self.lags, alpha=self.alpha)

    @classmethod
    def load(cls, path: Path) -> "RidgeWindowPredictor":
        with np.load(path) as f:
            obj = cls(int(f["lags"]), float(f["alpha"]))
            obj.coef_ = f["coef"]
        return obj


def load_predictor(models_dir: Path):
    if (models_dir / "lstm_weights.npz").exists():
        return NumpyLSTMPredictor.load(models_dir / "lstm_weights.npz")
    if (models_dir / "ridge_predictor.npz").exists():
        return RidgeWindowPredictor.load(models_dir / "ridge_predictor.npz")
    return None
