"""Application configuration, loaded from environment variables / .env."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "SAT-01 Ground Station"
    version: str = "1.0.0"
    satellite_id: str = "SAT-01"
    satellite_name: str = "SAT-01 Demonstrator"
    mission_id: str = "AISHM-2026"

    # Defaults to a local SQLite file so the backend runs without Docker; Docker Compose sets
    # a PostgreSQL URL (postgresql+psycopg2://...).
    database_url: str = f"sqlite:///{BACKEND_DIR / 'groundstation.db'}"
    timescale_enabled: bool = False

    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"

    # Optional auth: comma separated "key:role" pairs, roles are viewer|operator.
    auth_enabled: bool = False
    api_keys: str = ""

    models_dir: Path = BACKEND_DIR / "models"
    datasets_dir: Path = BACKEND_DIR / "datasets"
    # Train models automatically at startup when no trained artefacts exist.
    auto_train: bool = True
    # Train the LSTM with TensorFlow if available (otherwise a numpy fallback predictor is used).
    lstm_enabled: bool = True

    # Simulator
    simulator_enabled: bool = True  # run the in-process simulator source adapter
    simulator_autostart: bool = True
    sample_interval_s: float = 1.0  # simulated seconds between packets
    stale_after_s: float = 10.0

    log_level: str = "INFO"
    log_json: bool = True

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def api_key_roles(self) -> dict[str, str]:
        out: dict[str, str] = {}
        for pair in self.api_keys.split(","):
            if ":" in pair:
                key, role = pair.split(":", 1)
                out[key.strip()] = role.strip()
        return out


@lru_cache
def get_settings() -> Settings:
    return Settings()
