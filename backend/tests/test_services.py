import pytest

from app.services.command_service import CommandValidationError, validate_command
from app.services.health_service import HealthService, status_from_health, subsystem_risks


def test_health_status_bands():
    assert status_from_health(95) == "NOMINAL"
    assert status_from_health(65) == "WARNING"
    assert status_from_health(30) == "HIGH"
    assert status_from_health(10) == "CRITICAL"
    assert status_from_health(None) == "UNKNOWN"


def test_health_score_calculation():
    inf = {"anomaly_score": 0.7, "rule_by_feature": {"snr": 0.5},
           "top_features": [{"feature": "obc_temperature", "subsystem": "OBC", "contribution": 0.8},
                            {"feature": "cpu_load", "subsystem": "OBC", "contribution": 0.1},
                            {"feature": "bus_current", "subsystem": "EPS", "contribution": 0.1}]}
    risks = subsystem_risks(inf, {"payload_power": "MISSING"}, "VALID")
    assert risks["obc"] == pytest.approx(0.7)          # carries the fused score
    assert risks["eps"] == pytest.approx(0.7 * 0.1 / 0.9)
    assert risks["comm"] == pytest.approx(0.5)         # rule exceedance
    assert risks["payload"] == pytest.approx(0.35)     # data-quality penalty
    assert risks["adcs"] == 0.0
    h = HealthService().compute("t", {}, inf, {}, "VALID", {})
    assert h["overall_score"] <= 30.0 + 1e-6           # capped by 100 × (1 − fused)
    assert {s["id"] for s in h["subsystems"]} == {"eps", "obc", "adcs", "comm", "payload"}
    healthy = HealthService().compute("t", {}, {"anomaly_score": 0.05, "top_features": []}, {}, "VALID", {})
    assert healthy["overall_score"] == pytest.approx(95.0) and healthy["status"] == "NOMINAL"


def test_command_validation():
    assert validate_command("PING", "SAT-01", {}, "SAT-01") == {}
    assert validate_command("REQUEST_TELEMETRY", "SAT-01", {"count": 5}, "SAT-01") == {"count": 5}
    assert validate_command("SET_SIMULATION_SCENARIO", "SAT-01", {"scenario": "obc_thermal"}, "SAT-01")
    for cmd, target, params in [("FORMAT_DISK", "SAT-01", {}), ("PING", "SAT-99", {}),
                                ("PING", "SAT-01", {"x": 1}), ("REQUEST_TELEMETRY", "SAT-01", {"count": 1000}),
                                ("REQUEST_TELEMETRY", "SAT-01", {"count": "5"}),
                                ("SET_SIMULATION_SCENARIO", "SAT-01", {}),
                                ("SET_SIMULATION_SCENARIO", "SAT-01", {"scenario": "rm -rf"})]:
        with pytest.raises(CommandValidationError):
            validate_command(cmd, target, params, "SAT-01")
