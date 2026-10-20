"""WebSocket channel manager (/ws/telemetry, /ws/health, /ws/anomalies, /ws/system)."""
from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import deque
from typing import Any

from fastapi import WebSocket

log = logging.getLogger(__name__)

CHANNELS = ("telemetry", "health", "anomalies", "system")


class ConnectionManager:
    def __init__(self) -> None:
        self.clients: dict[str, set[WebSocket]] = {c: set() for c in CHANNELS}
        self.snapshots: dict[str, Any] = {}
        self._sent: deque[float] = deque(maxlen=5000)

    @property
    def client_count(self) -> int:
        return sum(len(s) for s in self.clients.values())

    def message_rate(self) -> float:
        """Messages sent per second over the last 10 s."""
        now = time.monotonic()
        return round(sum(1 for t in self._sent if now - t <= 10.0) / 10.0, 2)

    async def connect(self, channel: str, ws: WebSocket) -> None:
        await ws.accept()
        self.clients[channel].add(ws)
        keys = [channel] + (["simulation"] if channel == "system" else [])
        for key in keys:
            snap = self.snapshots.get(key)
            if snap is not None:
                await ws.send_text(json.dumps(snap, default=str))

    def disconnect(self, channel: str, ws: WebSocket) -> None:
        self.clients[channel].discard(ws)

    def set_snapshot(self, channel: str, message: Any) -> None:
        self.snapshots[channel] = message

    async def broadcast(self, channel: str, message: dict[str, Any], snapshot: bool = True) -> None:
        if snapshot and channel != "anomalies":
            self.snapshots[channel] = message
        clients = list(self.clients[channel])
        if not clients:
            return
        text = json.dumps(message, default=str)
        results = await asyncio.gather(*(self._send(ws, text) for ws in clients), return_exceptions=True)
        for ws, ok in zip(clients, results):
            if ok is not True:
                self.clients[channel].discard(ws)

    async def _send(self, ws: WebSocket, text: str) -> bool:
        try:
            await asyncio.wait_for(ws.send_text(text), timeout=2.0)
            self._sent.append(time.monotonic())
            return True
        except Exception:
            return False
