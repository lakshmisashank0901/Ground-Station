"""FastAPI application entry point."""
from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from app.api import anomalies, commands, health, models, reports, simulation, subsystems, system, telemetry
from app.core.config import get_settings
from app.core.logging import setup_logging
from app.database.session import Database
from app.services.ground_station import GroundStation
from app.services.ml_service import MLService
from app.websocket.manager import CHANNELS, ConnectionManager

log = logging.getLogger("app")


def create_app(settings=None) -> FastAPI:
    settings = settings or get_settings()
    setup_logging(settings.log_level, settings.log_json)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        db = Database(settings.database_url, settings.timescale_enabled)
        db.init()
        ml = MLService(settings.models_dir, settings.datasets_dir, settings.lstm_enabled)
        if not ml.load() and settings.auto_train:
            log.info("no trained models found: training in the background (rules-only until ready)")
            ml.train_async(fast=True)
        gs = GroundStation(settings, db, ConnectionManager(), ml)
        app.state.gs = gs
        await gs.startup()
        try:
            yield
        finally:
            await gs.shutdown()
            db.engine.dispose()

    app = FastAPI(title=settings.app_name, version=settings.version, lifespan=lifespan,
                  description="AI-assisted satellite health monitoring ground station (simulation phase).")
    app.state.settings = settings
    app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origin_list, allow_credentials=True,
                       allow_methods=["*"], allow_headers=["*"])

    @app.middleware("http")
    async def timing(request: Request, call_next):
        t0 = time.perf_counter()
        response = await call_next(request)
        gs = getattr(request.app.state, "gs", None)
        if gs is not None and request.url.path.startswith("/api/"):
            gs.api_latency_ms.append((time.perf_counter() - t0) * 1000.0)
        return response

    for r in (health, telemetry, subsystems, anomalies, models, simulation, commands, reports, system):
        app.include_router(r.router, prefix="/api/v1")

    def make_ws(channel: str):
        async def endpoint(ws: WebSocket):
            manager: ConnectionManager = ws.app.state.gs.ws
            await manager.connect(channel, ws)
            try:
                while True:
                    msg = await ws.receive_text()
                    if msg.strip().lower() == "ping":
                        await ws.send_text('{"type":"pong"}')
            except WebSocketDisconnect:
                pass
            finally:
                manager.disconnect(channel, ws)
        return endpoint

    for ch in CHANNELS:
        app.add_api_websocket_route(f"/ws/{ch}", make_ws(ch))
    return app


app = create_app()
