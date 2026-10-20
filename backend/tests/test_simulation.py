import asyncio

import numpy as np
import pytest

from app.simulation.engine import SimulationEngine
from app.simulation.faults import Effects, build_faults
from app.simulation.scenarios import FAULT_SCENARIOS, SCENARIOS
from app.simulation.spacecraft import Spacecraft
from app.telemetry.schemas import PARAMETERS
from app.telemetry.validator import classify_value


def run(sc_seed: int, n: int, faults=None) -> list[dict]:
    sc = Spacecraft(seed=sc_seed)
    return [sc.step(1.0, faults or []) for _ in range(n)]


def test_required_scenarios_exist():
    ids = {s["id"] for s in SCENARIOS}
    assert {"normal", "obc_thermal", "power_degradation", "sensor_drift", "comm_degradation", "obc_overload",
            "multiple_fault", "transient_spike"} <= ids
    assert len(FAULT_SCENARIOS) >= 5


def test_normal_telemetry_is_complete_correlated_and_in_limits():
    rows = run(5, 3000)
    assert set(rows[0]) == {p.name for p in PARAMETERS}
    for r in rows:
        for p in PARAMETERS:
            assert classify_value(p.name, r[p.name]).value in ("VALID", "SUSPECT"), (p.name, r[p.name])
    # power = V × I relationship holds exactly (before noise on the reported V/I)
    a = np.array([[r["power_consumption"], r["bus_voltage"] * r["bus_current"]] for r in rows])
    assert np.corrcoef(a.T)[0, 1] > 0.95
    # eclipse: solar input drops to zero for part of the orbit
    solar = np.array([r["solar_input_power"] for r in run(5, 5700)])
    assert (solar == 0).mean() > 0.25 and solar.max() > 25


def test_simulation_is_deterministic():
    assert run(9, 200) == run(9, 200)


@pytest.mark.parametrize("scenario,param,direction", [
    ("obc_thermal", "obc_temperature", 1), ("power_degradation", "bus_voltage", -1),
    ("sensor_drift", "battery_temperature", 1), ("comm_degradation", "snr", -1),
    ("obc_overload", "cpu_load", 1), ("transient_spike", "gyro_x", 1),
])
def test_fault_generation_moves_expected_parameter(scenario, param, direction):
    n, start = 900, 300
    base = run(3, n)
    faulty = run(3, n, build_faults(scenario, "severe", start_t=start, duration_s=None))
    assert base[:start - 1] == faulty[:start - 1]  # no effect before injection
    window = slice(start, start + (10 if scenario == "transient_spike" else 500))
    delta = np.mean([f[param] - b[param] for f, b in zip(faulty[window], base[window])])
    assert direction * delta > 0
    assert abs(delta) > (0.5 if scenario == "transient_spike" else 1.0) or param == "bus_voltage"


def test_severity_scales_effect_and_composite_expands():
    fx_mild, fx_severe = Effects(), Effects()
    build_faults("obc_thermal", "mild", 0, None)[0].apply(500, fx_mild)
    build_faults("obc_thermal", "severe", 0, None)[0].apply(500, fx_severe)
    assert fx_severe.obc_heat_c > fx_mild.obc_heat_c > 0
    multi = build_faults("multiple_fault", "moderate", 0, None)
    assert {f.scenario for f in multi} == {"obc_thermal", "comm_degradation"}
    with pytest.raises(ValueError):
        build_faults("obc_thermal", "extreme", 0, None)


def test_engine_controls_and_packets():
    async def main():
        got = []

        async def sink(p):
            got.append(p)

        eng = SimulationEngine(sink=sink, link_effects=False)
        await eng.start(speed=10)
        await asyncio.sleep(0.35)
        await eng.pause()
        n = len(got)
        await asyncio.sleep(0.25)
        assert len(got) == n  # paused: no packets
        await eng.inject("obc_overload", "moderate", start_delay_s=5)
        assert eng.status()["active_faults"][0]["status"] == "PENDING"
        with pytest.raises(ValueError):
            await eng.set_speed(3)
        with pytest.raises(ValueError):
            await eng.inject("meteor_strike")
        await eng.set_override("cpu_load", 99.0)
        p = eng.next_packet()
        assert p.data["cpu_load"] == 99.0 and p.sequence == eng.sequence
        await eng.reset()
        assert not eng.running and eng.faults == [] and eng.sequence == 0
        seqs = [x.sequence for x in got]
        assert seqs == sorted(seqs) and len(got) >= 2
    asyncio.run(main())
