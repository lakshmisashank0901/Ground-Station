from datetime import datetime, timedelta, timezone

import pytest

from tests.helpers import nominal_data, packet

API = "/api/v1"


def post_packets(client, n, t0=None, start_seq=1, **data_overrides):
    t0 = t0 or datetime.now(timezone.utc)
    for i in range(n):
        r = client.post(f"{API}/telemetry", json=packet(sequence=start_seq + i, timestamp=t0 + timedelta(seconds=i),
                                                        data=nominal_data(**data_overrides)))
        assert r.status_code == 201, r.text
    return t0


def test_health_and_metadata(client):
    assert client.get(f"{API}/health").json()["status"] == "ok"
    sat = client.get(f"{API}/satellite").json()
    assert sat["id"] == "SAT-01" and set(sat["subsystems"]) == {"eps", "obc", "adcs", "comm", "payload"}
    schema = client.get(f"{API}/telemetry/schema").json()
    assert len(schema) >= 15 and {"name", "unit", "subsystem", "nominal_min"} <= set(schema[0])


def test_ingestion_accepts_valid_and_rejects_invalid(client):
    r = client.post(f"{API}/telemetry", json=packet())
    assert r.status_code == 201 and r.json()["accepted"] is True
    latest = client.get(f"{API}/telemetry/latest").json()
    assert latest["sequence"] == 128481 and latest["derived"]["power_calc"] > 0
    bad = packet()
    bad["data"]["battery_voltage"] = "lots"
    assert client.post(f"{API}/telemetry", json=bad).status_code == 422
    assert client.post(f"{API}/telemetry", content=b"{not json").status_code == 422
    assert client.post(f"{API}/telemetry/frame", content=b"SATF\x00\x01x\x00\x00").status_code == 422
    assert client.get(f"{API}/system/status").json()["telemetry"]["rejected_count"] == 3


def test_history_returns_correct_ranges(client):
    t0 = post_packets(client, 30, t0=datetime(2026, 5, 1, 12, 0, 0, tzinfo=timezone.utc))
    start, end = (t0 + timedelta(seconds=10)).isoformat(), (t0 + timedelta(seconds=19)).isoformat()
    h = client.get(f"{API}/telemetry/history", params={"start": start, "end": end, "fields": "cpu_load,rssi"}).json()
    assert h["count"] == 10
    assert h["items"][0]["timestamp"] == "2026-05-01T12:00:10.000Z"
    assert set(h["items"][0]["data"]) == {"cpu_load", "rssi"}
    ds = client.get(f"{API}/telemetry/history", params={"start": t0.isoformat(), "max_points": 5}).json()
    assert ds["count"] == 5
    assert client.get(f"{API}/telemetry/history", params={"fields": "nope"}).status_code == 422
    csv = client.get(f"{API}/telemetry/export", params={"start": start, "end": end, "fields": "cpu_load"})
    assert csv.status_code == 200 and csv.text.splitlines()[0] == "timestamp,sequence,source,quality,cpu_load"
    assert len(csv.text.strip().splitlines()) == 11
    hh = client.get(f"{API}/health/history", params={"start": start, "end": end}).json()
    assert len(hh["items"]) == 10


def test_anomaly_detected_acknowledged_and_resolved(client):
    t0 = post_packets(client, 70)
    post_packets(client, 8, t0=t0 + timedelta(seconds=70), start_seq=71, obc_temperature=68.0, cpu_load=97.0,
                 watchdog_status="FAULT")
    anomalies = client.get(f"{API}/anomalies", params={"status": "ACTIVE"}).json()
    assert len(anomalies) == 1
    a = anomalies[0]
    assert a["severity"] in ("HIGH", "CRITICAL") and "OBC" in a["subsystems"]
    assert a["top_features"] and a["explanation"] and 0 <= a["confidence"] <= 1
    detail = client.get(f"{API}/anomalies/{a['id']}").json()
    assert detail["context"] and detail["score_trace"]
    r = client.post(f"{API}/anomalies/{a['id']}/acknowledge", json={"user": "alice", "note": "looking"})
    assert r.json()["status"] == "ACKNOWLEDGED" and r.json()["acknowledged_by"] == "alice"
    r = client.post(f"{API}/anomalies/{a['id']}/resolve", json={"note": "fixed"}, headers={"X-Operator": "bob"})
    assert r.json()["status"] == "RESOLVED" and r.json()["resolved_by"] == "bob"
    assert client.post(f"{API}/anomalies/missing/acknowledge").status_code == 404
    sub = client.get(f"{API}/subsystems/obc").json()
    assert sub["anomalies"] and {p["name"] for p in sub["parameters"]} >= {"obc_temperature", "cpu_load"}
    assert client.get(f"{API}/subsystems/warp_drive").status_code == 404


def test_simulation_start_stop_reset(client):
    st = client.post(f"{API}/simulation/start", json={"speed": 10}).json()
    assert st["running"] and st["speed"] == 10 and st["run_id"] and st["mode"] == "SIMULATION"
    st = client.post(f"{API}/simulation/scenario", json={"scenario": "obc_thermal", "severity": "mild"}).json()
    assert st["active_faults"][0]["scenario"] == "obc_thermal"
    assert client.post(f"{API}/simulation/scenario", json={"scenario": "nope"}).status_code == 422
    assert client.post(f"{API}/simulation/speed", json={"speed": 3}).status_code == 422
    assert client.post(f"{API}/simulation/pause").json()["paused"] is True
    assert client.post(f"{API}/simulation/resume").json()["paused"] is False
    run_id = st["run_id"]
    st = client.post(f"{API}/simulation/stop").json()
    assert not st["running"]
    runs = client.get(f"{API}/simulation/runs").json()
    assert runs[0]["id"] == run_id and runs[0]["status"] == "COMPLETED"
    events = client.get(f"{API}/simulation/runs/{run_id}").json()["events"]
    assert {"run_started", "fault_injected", "run_stopped"} <= {e["event_type"] for e in events}
    st = client.post(f"{API}/simulation/reset").json()
    assert not st["running"] and st["active_faults"] == [] and st["scenario"] == "normal"


def test_command_workflow_and_validation(client):
    cat = client.get(f"{API}/commands/catalog").json()
    assert {c["command"] for c in cat} == {"PING", "REQUEST_STATUS", "REQUEST_TELEMETRY", "REQUEST_HEALTH",
                                           "RESET_SIMULATOR", "SET_SIMULATION_SCENARIO"}
    c = client.post(f"{API}/commands", json={"command": "PING"}).json()
    assert c["status"] == "PENDING_CONFIRMATION"
    done = client.post(f"{API}/commands/{c['id']}/confirm").json()
    assert done["status"] == "EXECUTED" and done["result"]["reply"] == "PONG"
    assert client.post(f"{API}/commands/{c['id']}/confirm").status_code == 409
    c2 = client.post(f"{API}/commands", json={"command": "REQUEST_HEALTH"}).json()
    assert client.post(f"{API}/commands/{c2['id']}/cancel").json()["status"] == "CANCELLED"
    assert client.post(f"{API}/commands", json={"command": "SELF_DESTRUCT"}).status_code == 422
    assert client.post(f"{API}/commands", json={"command": "REQUEST_TELEMETRY",
                                                "parameters": {"count": 9999}}).status_code == 422
    hist = client.get(f"{API}/commands/history").json()
    assert [h["status"] for h in hist][:4] == ["REJECTED", "REJECTED", "CANCELLED", "EXECUTED"]


def test_models_and_reports(client):
    models = {m["name"]: m for m in client.get(f"{API}/models").json()}
    assert models["mahalanobis"]["status"] == "LOADED" and models["lstm"]["status"] == "LOADED"
    metrics = client.get(f"{API}/models/metrics").json()
    assert "fused" in metrics["detectors"] and metrics["per_scenario"]
    post_packets(client, 20)
    rep = client.post(f"{API}/reports/generate", json={"title": "Test report"})
    assert rep.status_code == 201
    r = rep.json()
    assert r["summary"]["telemetry"]["packets"] == 20 and r["model_version"]
    assert client.get(f"{API}/reports").json()[0]["id"] == r["id"]
    for fmt, needle in [("html", "<html"), ("json", '"summary"'), ("csv", "section,key,value")]:
        d = client.get(f"{API}/reports/{r['id']}/download", params={"format": fmt})
        assert d.status_code == 200 and needle in d.text


def test_websocket_streams_telemetry_and_health(client):
    with client.websocket_connect("/ws/telemetry") as wt, client.websocket_connect("/ws/health") as wh:
        client.post(f"{API}/telemetry", json=packet(sequence=7))
        assert wt.receive_json()["sequence"] == 7
        h = wh.receive_json()
        assert h["type"] == "health" and 0 <= h["overall_score"] <= 100
    with client.websocket_connect("/ws/system") as ws:
        ws.send_text("ping")
        msgs = [ws.receive_json() for _ in range(2)]
        assert any(m.get("type") in ("pong", "system", "simulation") for m in msgs)


@pytest.fixture()
def auth_client(settings):
    from fastapi.testclient import TestClient

    from app.main import create_app
    settings.auth_enabled = True
    settings.api_keys = "op-key:operator,view-key:viewer"
    with TestClient(create_app(settings)) as c:
        yield c


def test_authorization_when_enabled(auth_client):
    c = auth_client
    assert c.post(f"{API}/commands", json={"command": "PING"}).status_code == 401
    assert c.post(f"{API}/commands", json={"command": "PING"}, headers={"X-API-Key": "view-key"}).status_code == 403
    assert c.post(f"{API}/commands", json={"command": "PING"}, headers={"X-API-Key": "op-key"}).status_code == 201
    assert c.post(f"{API}/simulation/start", headers={"X-API-Key": "view-key"}).status_code == 403
