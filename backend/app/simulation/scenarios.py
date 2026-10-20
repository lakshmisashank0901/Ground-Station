"""Scenario catalogue (spec section 9.3)."""
from __future__ import annotations

SCENARIOS: list[dict] = [
    {"id": "normal", "name": "Normal operation",
     "description": "Nominal orbit: eclipse cycles, payload duty cycle, small sensor noise. Clears injected faults.",
     "expected_evidence": "All detectors low; health nominal.", "affected": []},
    {"id": "obc_thermal", "name": "OBC thermal anomaly",
     "description": "OBC temperature rises progressively although CPU load and power stay normal.",
     "expected_evidence": "LSTM prediction error + multivariate deviation.", "affected": ["OBC"]},
    {"id": "power_degradation", "name": "Power degradation",
     "description": "Solar input falls; the bus voltage sags while bus current rises.",
     "expected_evidence": "Mahalanobis + LSTM.", "affected": ["EPS"]},
    {"id": "sensor_drift", "name": "Sensor drift",
     "description": "Reported battery temperature and voltage slowly bias away from the true values.",
     "expected_evidence": "Temporal model.", "affected": ["EPS"]},
    {"id": "comm_degradation", "name": "Communication degradation",
     "description": "RSSI and SNR worsen; packet loss and CRC errors rise.",
     "expected_evidence": "Rule + trend anomaly.", "affected": ["COMM"]},
    {"id": "obc_overload", "name": "OBC overload",
     "description": "CPU load, memory and power rise together; temperature follows.",
     "expected_evidence": "Multivariate correlation.", "affected": ["OBC", "EPS"]},
    {"id": "multiple_fault", "name": "Multiple fault",
     "description": "OBC thermal anomaly and communication degradation at the same time.",
     "expected_evidence": "Fusion model.", "affected": ["OBC", "COMM"]},
    {"id": "transient_spike", "name": "Transient spike",
     "description": "Short high-amplitude attitude-rate and bus-current disturbance.",
     "expected_evidence": "Rule + statistical detector.", "affected": ["ADCS", "EPS"]},
]

SCENARIO_IDS = {s["id"] for s in SCENARIOS}
FAULT_SCENARIOS = [s["id"] for s in SCENARIOS if s["id"] != "normal"]
