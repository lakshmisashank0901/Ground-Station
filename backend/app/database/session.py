"""Database engine/session management."""
from __future__ import annotations

import logging
import time
from contextlib import contextmanager
from typing import Iterator

from sqlalchemy import create_engine, event, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.database.models import Base

log = logging.getLogger(__name__)


class Database:
    def __init__(self, url: str, timescale: bool = False) -> None:
        self.url = url
        self.is_sqlite = url.startswith("sqlite")
        kwargs: dict = {"pool_pre_ping": True, "future": True}
        if self.is_sqlite:
            kwargs["connect_args"] = {"check_same_thread": False, "timeout": 30}
        else:
            kwargs.update(pool_size=10, max_overflow=10)
        self.engine: Engine = create_engine(url, **kwargs)
        if self.is_sqlite:
            @event.listens_for(self.engine, "connect")
            def _pragmas(dbapi_conn, _):  # pragma: no cover - trivial
                cur = dbapi_conn.cursor()
                cur.execute("PRAGMA journal_mode=WAL")
                cur.execute("PRAGMA synchronous=NORMAL")
                cur.close()
        self.SessionLocal = sessionmaker(self.engine, expire_on_commit=False, future=True)
        self.timescale = timescale and not self.is_sqlite

    @property
    def engine_name(self) -> str:
        return "timescaledb" if self.timescale else self.engine.dialect.name

    def init(self, retries: int = 20, delay_s: float = 1.5) -> None:
        for attempt in range(1, retries + 1):
            try:
                Base.metadata.create_all(self.engine)
                break
            except Exception as exc:  # database container may still be starting
                if attempt == retries:
                    raise
                log.warning("database not ready (%s), retry %d/%d", exc.__class__.__name__, attempt, retries)
                time.sleep(delay_s)
        if self.timescale:
            try:
                with self.engine.begin() as conn:
                    conn.execute(text("CREATE EXTENSION IF NOT EXISTS timescaledb"))
                    for table in ("telemetry", "health_scores"):
                        # Hypertable unique keys must include the time column.
                        conn.execute(text(f"ALTER TABLE {table} DROP CONSTRAINT IF EXISTS {table}_pkey"))
                        conn.execute(text(f"ALTER TABLE {table} ADD PRIMARY KEY (id, timestamp)"))
                        conn.execute(text(f"SELECT create_hypertable('{table}', 'timestamp', "
                                          "if_not_exists => TRUE, migrate_data => TRUE)"))
                log.info("TimescaleDB hypertables enabled")
            except Exception as exc:
                log.warning("TimescaleDB unavailable, continuing with plain PostgreSQL: %s", exc)
                self.timescale = False

    @contextmanager
    def session(self) -> Iterator[Session]:
        s = self.SessionLocal()
        try:
            yield s
            s.commit()
        except Exception:
            s.rollback()
            raise
        finally:
            s.close()

    def ping(self) -> float | None:
        """Round-trip latency in ms, or None if the database is unreachable."""
        t0 = time.perf_counter()
        try:
            with self.engine.connect() as conn:
                conn.execute(text("SELECT 1"))
            return round((time.perf_counter() - t0) * 1000.0, 2)
        except Exception:
            return None
