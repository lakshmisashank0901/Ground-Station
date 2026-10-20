from __future__ import annotations

from pathlib import Path

import pytest

from app.ml.inference import ModelBundle
from app.ml.training import train_all


@pytest.fixture(scope="session")
def trained_models(tmp_path_factory) -> Path:
    """Fast, TensorFlow-free training run shared by the ML and API tests."""
    d = tmp_path_factory.mktemp("models")
    train_all(d, None, fast=True, lstm_enabled=False, progress=lambda _m: None)
    return d


@pytest.fixture(scope="session")
def bundle(trained_models) -> ModelBundle:
    return ModelBundle.load(trained_models)


@pytest.fixture()
def settings(tmp_path, trained_models):
    from app.core.config import Settings
    return Settings(database_url=f"sqlite:///{tmp_path / 'test.db'}", models_dir=trained_models,
                    datasets_dir=tmp_path / "datasets", auto_train=False, simulator_autostart=False,
                    log_json=False, log_level="WARNING")


@pytest.fixture()
def client(settings):
    from fastapi.testclient import TestClient

    from app.main import create_app
    with TestClient(create_app(settings)) as c:
        yield c
