"""Standalone simulator / gateway source adapter.

Runs the spacecraft simulator outside the backend and delivers packets to the ingestion API exactly
as a future SAMRH serial/CAN/RS-422/radio gateway would:

    python -m app.simulation.standalone --url http://localhost:8000 --speed 5 --scenario obc_thermal --at 120

`--framed` sends CRC-framed binary packets to /api/v1/telemetry/frame instead of JSON.
"""
from __future__ import annotations

import argparse
import asyncio
import logging

import httpx

from app.simulation.engine import ALLOWED_SPEEDS, SimulationEngine
from app.simulation.scenarios import SCENARIO_IDS
from app.telemetry.decoder import encode_frame
from app.telemetry.schemas import TelemetryPacketIn

log = logging.getLogger("simulator")


async def run(args: argparse.Namespace) -> None:
    headers = {"X-Operator": "simulator-gateway"}
    if args.api_key:
        headers["X-API-Key"] = args.api_key
    async with httpx.AsyncClient(base_url=args.url, headers=headers, timeout=10) as client:
        async def sink(p: TelemetryPacketIn) -> None:
            body = p.model_dump(mode="json")
            if args.framed:
                r = await client.post("/api/v1/telemetry/frame", content=encode_frame(body))
            else:
                r = await client.post("/api/v1/telemetry", json=body)
            if r.status_code >= 400:
                log.warning("packet %s rejected: %s %s", p.sequence, r.status_code, r.text[:200])

        async def frame_sink(frame: bytes) -> None:
            await client.post("/api/v1/telemetry/frame", content=frame)

        eng = SimulationEngine(satellite_id=args.satellite, sink=sink, frame_sink=frame_sink, seed=args.seed)
        await eng.start(speed=args.speed, run_name="standalone")
        eng.run_id = None  # runs are owned by the backend; external sources are not tied to one
        if args.scenario:
            await eng.inject(args.scenario, args.severity, start_delay_s=args.at)
        log.info("streaming to %s at %sx", args.url, args.speed)
        try:
            while True:
                await asyncio.sleep(3600)
        finally:
            await eng.stop()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default="http://localhost:8000")
    ap.add_argument("--satellite", default="SAT-01")
    ap.add_argument("--speed", type=int, default=1, choices=ALLOWED_SPEEDS)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--scenario", choices=sorted(SCENARIO_IDS - {"normal"}))
    ap.add_argument("--severity", default="moderate", choices=["mild", "moderate", "severe"])
    ap.add_argument("--at", type=float, default=120.0, help="inject the scenario after N simulated seconds")
    ap.add_argument("--framed", action="store_true", help="send CRC-framed packets (gateway wire format)")
    ap.add_argument("--api-key")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        asyncio.run(run(args))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
