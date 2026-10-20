"""End-to-end flow (spec 13.4) through the real simulator, pipeline, ML, API and WebSocket."""
import time

API = "/api/v1"


def wait_for(fn, timeout=60.0, interval=0.25):
    deadline = time.time() + timeout
    while time.time() < deadline:
        v = fn()
        if v:
            return v
        time.sleep(interval)
    raise AssertionError("condition not met in time")


def test_end_to_end_obc_anomaly_flow(client):
    assert client.get(f"{API}/system/status").json()["ml"]["status"] == "ONLINE"
    run_id = client.post(f"{API}/simulation/start", json={"speed": 10, "run_name": "e2e"}).json()["run_id"]

    # live telemetry appears (and streams over the WebSocket)
    with client.websocket_connect("/ws/telemetry") as ws:
        pkt = ws.receive_json()
        assert pkt["source"] == "SIMULATION" and pkt["run_id"] == run_id
    wait_for(lambda: client.get(f"{API}/telemetry/latest").json()["sequence"] > 70)  # LSTM window warm
    before = client.get(f"{API}/telemetry/latest").json()["data"]["obc_temperature"]

    # inject the OBC overload/thermal anomaly → trend changes, ML score rises, alarm appears
    client.post(f"{API}/simulation/scenario", json={"scenario": "obc_overload", "severity": "severe"})
    anomaly = wait_for(lambda: (client.get(f"{API}/anomalies", params={"run_id": run_id}).json() or [None])[0])
    status = client.get(f"{API}/satellite/status").json()
    assert status["anomaly_score"] >= 0.3 and status["active_alarms"] >= 1
    wait_for(lambda: client.get(f"{API}/telemetry/latest").json()["data"]["obc_temperature"] > before + 1, 30)

    # open detail, acknowledge
    def obc_attributed():
        d = client.get(f"{API}/anomalies/{anomaly['id']}").json()
        return d if "OBC" in d["subsystems"] else None

    detail = wait_for(obc_attributed, 30)
    assert detail["detection_delay_s"] is not None and detail["context"]
    assert detail["injected_fault"]["scenario"] == "obc_overload"
    assert client.post(f"{API}/anomalies/{anomaly['id']}/acknowledge").json()["status"] == "ACKNOWLEDGED"

    # replay the event
    st = client.post(f"{API}/replay/start", json={"run_id": run_id, "speed": 50}).json()
    assert st["mode"] == "REPLAY" and st["replay"]["count"] > 70
    with client.websocket_connect("/ws/telemetry") as ws:
        assert ws.receive_json()["source"] == "REPLAY"
    client.post(f"{API}/replay/pause")
    st = client.post(f"{API}/replay/seek", json={"timestamp": detail["onset_time"]}).json()
    assert st["replay"]["position"] <= detail["timestamp"]
    client.post(f"{API}/replay/stop")
    client.post(f"{API}/simulation/stop")

    # generate the report
    report = client.post(f"{API}/reports/generate", json={"run_id": run_id}).json()
    s = report["summary"]
    assert s["anomaly_count"] >= 1 and s["most_affected_subsystem"] in ("OBC", "EPS")  # overload hits both
    assert s["detection_delay_s"]["count"] >= 1 and s["telemetry"]["packets"] > 70
