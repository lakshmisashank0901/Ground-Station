"""Mission health report generation (spec section 11)."""
from __future__ import annotations

import csv
import html
import io
import json
from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Any

import numpy as np
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.database import models as m
from app.database.repository import anomaly_dict, as_utc, downsample, latest_telemetry_time
from app.telemetry.processor import iso
from app.telemetry.schemas import Quality, SUBSYSTEMS

KEY_PLOT_PARAMS = ["battery_voltage", "power_consumption", "obc_temperature", "cpu_load", "snr", "battery_soc"]
SEVERITIES = ["INFO", "WARNING", "HIGH", "CRITICAL"]


def generate_report(s: Session, *, title: str | None, start: datetime | None, end: datetime | None,
                    run_id: str | None, mission_id: str, satellite_id: str, model_version: str,
                    sample_interval_s: float) -> m.Report:
    if run_id:
        run = s.get(m.SimulationRun, run_id)
        if run is None:
            raise LookupError(f"run {run_id} not found")
        start = start or as_utc(run.start_time)
        end = end or as_utc(run.end_time) or latest_telemetry_time(s, run_id) or datetime.now(timezone.utc)
    else:
        # Default window: the hour leading up to the newest telemetry (the mission clock may run ahead of
        # wall time when the simulator is accelerated).
        end = end or latest_telemetry_time(s) or datetime.now(timezone.utc)
        start = start or end - timedelta(hours=1)
    if end <= start:
        raise ValueError("end must be after start")

    tq = select(m.Telemetry.timestamp, m.Telemetry.quality).where(m.Telemetry.timestamp.between(start, end))
    hq = select(m.HealthScore).where(m.HealthScore.timestamp.between(start, end))
    aq = select(m.Anomaly).where(m.Anomaly.timestamp.between(start, end))
    if run_id:
        tq = tq.where(m.Telemetry.run_id == run_id)
        hq = hq.where(m.HealthScore.run_id == run_id)
        aq = aq.where(m.Anomaly.run_id == run_id)
    tel = s.execute(tq).all()
    health = s.scalars(hq.order_by(m.HealthScore.timestamp)).all()
    anomalies = s.scalars(aq.order_by(m.Anomaly.timestamp)).all()

    # Telemetry availability / quality
    q_counts = Counter(q for _, q in tel)
    packets = len(tel)
    if packets >= 2:
        span = (as_utc(tel[-1][0]) - as_utc(tel[0][0])).total_seconds() if tel else 0
        expected = max(packets, int(round(span / sample_interval_s)) + 1)
    else:
        expected = max(packets, int((end - start).total_seconds() / sample_interval_s))
    valid = q_counts.get("VALID", 0) + q_counts.get("SUSPECT", 0)

    overall = np.array([h.overall_score for h in health]) if health else np.array([])
    sub_health = {sid: {"mean": round(float(np.mean([getattr(h, sid) for h in health])), 1),
                        "min": round(float(np.min([getattr(h, sid) for h in health])), 1)} if health else
                  {"mean": None, "min": None} for sid in SUBSYSTEMS}

    sev_counts = {k: 0 for k in SEVERITIES}
    sub_counts: Counter = Counter()
    delays = []
    for a in anomalies:
        sev_counts[a.severity] = sev_counts.get(a.severity, 0) + 1
        # Weight each event's subsystems by their share of the explanation (contributions at the peak).
        weights: Counter = Counter()
        for f in a.top_features or []:
            if f.get("subsystem") in (a.subsystems or []):
                weights[f["subsystem"]] += f.get("contribution") or 0.0
        for x in a.subsystems or []:
            sub_counts[x] += 1.0 + weights.get(x, 0.0)
        if a.detection_delay_s is not None:
            delays.append(a.detection_delay_s)

    # Key plots (downsampled)
    plot_rows = s.execute(
        select(m.Telemetry.timestamp, *[getattr(m.Telemetry, p) for p in KEY_PLOT_PARAMS])
        .where(m.Telemetry.timestamp.between(start, end))
        .where(m.Telemetry.run_id == run_id if run_id else True)
        .order_by(m.Telemetry.timestamp)).all()
    plot_rows = downsample(plot_rows, 300)
    telemetry_plots = {p: [{"timestamp": iso(r[0]), "value": r[i + 1]} for r in plot_rows]
                       for i, p in enumerate(KEY_PLOT_PARAMS)}
    health_plot = [{"timestamp": iso(h.timestamp), "overall_score": h.overall_score, "anomaly_score": h.anomaly_score}
                   for h in downsample(list(health), 300)]

    # Event timeline
    timeline: list[dict[str, Any]] = []
    for a in anomalies:
        timeline.append({"timestamp": iso(a.timestamp), "kind": "anomaly", "severity": a.severity,
                         "text": a.description, "ref_id": a.id})
    eq = select(m.SimulationEvent).where(m.SimulationEvent.timestamp.between(start, end))
    if run_id:
        eq = eq.where(m.SimulationEvent.run_id == run_id)
    for e in s.scalars(eq):
        p = e.parameters or {}
        detail = ", ".join(f"{k}={v}" for k, v in p.items() if k in ("scenario", "severity", "speed", "parameter", "value"))
        timeline.append({"timestamp": iso(e.timestamp), "kind": "simulation",
                         "text": f"{e.event_type.replace('_', ' ')}" + (f" ({detail})" if detail else "")})
    for c in s.scalars(select(m.Command).where(m.Command.timestamp.between(start, end))):
        timeline.append({"timestamp": iso(c.timestamp), "kind": "command",
                         "text": f"{c.command} by {c.user}: {c.status}", "ref_id": c.id})
    for ev in s.scalars(select(m.SystemEvent).where(m.SystemEvent.timestamp.between(start, end))
                        .where(m.SystemEvent.level != "INFO")):
        timeline.append({"timestamp": iso(ev.timestamp), "kind": "system", "severity": ev.level,
                         "text": f"[{ev.component}] {ev.message}"})
    timeline.sort(key=lambda t: t["timestamp"] or "")

    summary = {
        "overall_health": {"mean": round(float(overall.mean()), 1) if len(overall) else None,
                           "min": round(float(overall.min()), 1) if len(overall) else None,
                           "final": round(float(overall[-1]), 1) if len(overall) else None},
        "subsystem_health": sub_health,
        "anomaly_count": len(anomalies),
        "severity_counts": sev_counts,
        "most_affected_subsystem": sub_counts.most_common(1)[0][0] if sub_counts else None,
        "max_anomaly_score": round(max((a.peak_score for a in anomalies), default=0.0), 4),
        "detection_delay_s": {"mean": round(float(np.mean(delays)), 1) if delays else None,
                              "min": min(delays) if delays else None, "max": max(delays) if delays else None,
                              "count": len(delays)},
        "telemetry": {"packets": packets, "expected": expected,
                      "availability_pct": round(100.0 * packets / expected, 2) if expected else 0.0,
                      "valid_pct": round(100.0 * valid / packets, 2) if packets else 0.0,
                      "quality_counts": {q.value: q_counts.get(q.value, 0) for q in Quality}},
    }
    rid = m.new_id()
    content = {
        "id": rid, "title": title or f"Mission health report {iso(end)[:16].replace('T', ' ')}Z",
        "created_at": iso(datetime.now(timezone.utc)), "mission_id": mission_id, "satellite_id": satellite_id,
        "run_id": run_id, "start": iso(start), "end": iso(end), "model_version": model_version,
        "summary": summary, "plots": {"health": health_plot, "telemetry": telemetry_plots},
        "timeline": timeline[-500:], "anomalies": [anomaly_dict(a) for a in anomalies],
    }
    report = m.Report(id=rid, title=content["title"], start=start, end=end, run_id=run_id,
                      anomaly_count=len(anomalies), content=content)
    s.add(report)
    return report


def report_summary_row(r: m.Report) -> dict:
    return {"id": r.id, "title": r.title, "created_at": iso(r.created_at), "start": iso(r.start), "end": iso(r.end),
            "anomaly_count": r.anomaly_count, "run_id": r.run_id}


def report_csv(content: dict) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["section", "key", "value"])
    for k in ("title", "mission_id", "run_id", "start", "end", "model_version"):
        w.writerow(["report", k, content.get(k)])
    s = content["summary"]
    for k, v in s["overall_health"].items():
        w.writerow(["overall_health", k, v])
    for sid, v in s["subsystem_health"].items():
        w.writerow(["subsystem_health", sid, json.dumps(v)])
    for k, v in s["severity_counts"].items():
        w.writerow(["severity_counts", k, v])
    for k in ("anomaly_count", "most_affected_subsystem", "max_anomaly_score"):
        w.writerow(["summary", k, s[k]])
    for k, v in s["detection_delay_s"].items():
        w.writerow(["detection_delay_s", k, v])
    for k, v in s["telemetry"].items():
        w.writerow(["telemetry", k, json.dumps(v) if isinstance(v, dict) else v])
    w.writerow([])
    w.writerow(["anomaly_id", "timestamp", "severity", "subsystems", "peak_score", "confidence", "status",
                "detection_delay_s", "description"])
    for a in content["anomalies"]:
        w.writerow([a["id"], a["timestamp"], a["severity"], "|".join(a["subsystems"]), a["peak_score"],
                    a["confidence"], a["status"], a["detection_delay_s"], a["description"]])
    return buf.getvalue()


def _svg_line(points: list[dict], key: str, width: int = 640, height: int = 140, color: str = "#2563eb",
              y_range: tuple[float, float] | None = None) -> str:
    vals = [p[key] for p in points if p.get(key) is not None]
    if len(vals) < 2:
        return "<p><em>No data.</em></p>"
    lo, hi = y_range or (min(vals), max(vals))
    if hi - lo < 1e-9:
        hi = lo + 1
    n = len(points)
    coords = []
    for i, p in enumerate(points):
        v = p.get(key)
        if v is None:
            continue
        x = 40 + (width - 50) * i / (n - 1)
        y = 10 + (height - 30) * (1 - (v - lo) / (hi - lo))
        coords.append(f"{x:.1f},{y:.1f}")
    return (f'<svg viewBox="0 0 {width} {height}" width="100%" role="img">'
            f'<line x1="40" y1="{height - 20}" x2="{width - 10}" y2="{height - 20}" stroke="#999"/>'
            f'<text x="2" y="16" font-size="10">{hi:.1f}</text><text x="2" y="{height - 22}" font-size="10">{lo:.1f}</text>'
            f'<polyline fill="none" stroke="{color}" stroke-width="1.5" points="{" ".join(coords)}"/></svg>')


def report_html(c: dict) -> str:
    e = html.escape
    s = c["summary"]
    rows = "".join(f"<tr><td>{e(sid.upper())}</td><td>{v['mean']}</td><td>{v['min']}</td></tr>"
                   for sid, v in s["subsystem_health"].items())
    sev = " · ".join(f"{k}: {v}" for k, v in s["severity_counts"].items())
    anomalies = "".join(
        f"<tr><td>{e(a['timestamp'] or '')}</td><td>{e(a['severity'])}</td><td>{e(', '.join(a['subsystems']))}</td>"
        f"<td>{a['peak_score']:.2f}</td><td>{a['confidence']:.2f}</td><td>{a['detection_delay_s'] if a['detection_delay_s'] is not None else '–'}</td>"
        f"<td>{e(a['status'])}</td><td>{e(a['description'])}</td></tr>" for a in c["anomalies"])
    timeline = "".join(f"<li><code>{e(t['timestamp'] or '')}</code> [{e(t['kind'])}] {e(t['text'])}</li>"
                       for t in c["timeline"][-200:])
    plots = "".join(f"<h3>{e(p)}</h3>{_svg_line(pts, 'value')}" for p, pts in c["plots"]["telemetry"].items())
    t = s["telemetry"]
    d = s["detection_delay_s"]
    return f"""<!doctype html><html><head><meta charset="utf-8"><title>{e(c['title'])}</title>
<style>body{{font-family:system-ui,sans-serif;max-width:960px;margin:24px auto;padding:0 16px;color:#111}}
table{{border-collapse:collapse;width:100%;font-size:13px}}td,th{{border:1px solid #ccc;padding:4px 6px;text-align:left}}
h1{{font-size:22px}}h2{{font-size:17px;margin-top:28px;border-bottom:1px solid #ddd}}h3{{font-size:13px;margin:12px 0 0}}
.kv td:first-child{{width:260px;color:#555}}ul{{font-size:13px}}</style></head><body>
<h1>{e(c['title'])}</h1>
<table class="kv"><tr><td>Mission</td><td>{e(c['mission_id'])} / {e(c.get('satellite_id', ''))}</td></tr>
<tr><td>Interval (UTC)</td><td>{e(c['start'])} → {e(c['end'])}</td></tr>
<tr><td>Simulation run</td><td>{e(c['run_id'] or '–')}</td></tr>
<tr><td>Model version</td><td>{e(c['model_version'])}</td></tr>
<tr><td>Generated</td><td>{e(c['created_at'])}</td></tr></table>
<h2>Summary</h2><table class="kv">
<tr><td>Overall health (mean / min / final)</td><td>{s['overall_health']['mean']} / {s['overall_health']['min']} / {s['overall_health']['final']}</td></tr>
<tr><td>Anomalies</td><td>{s['anomaly_count']} ({sev})</td></tr>
<tr><td>Most affected subsystem</td><td>{e(str(s['most_affected_subsystem'] or '–'))}</td></tr>
<tr><td>Maximum anomaly score</td><td>{s['max_anomaly_score']:.2f}</td></tr>
<tr><td>Detection delay (mean / min / max, n)</td><td>{d['mean']} / {d['min']} / {d['max']} s (n={d['count']})</td></tr>
<tr><td>Telemetry availability</td><td>{t['availability_pct']}% ({t['packets']} of {t['expected']} packets)</td></tr>
<tr><td>Valid data</td><td>{t['valid_pct']}%</td></tr></table>
<h2>Subsystem health</h2><table><tr><th>Subsystem</th><th>Mean</th><th>Min</th></tr>{rows}</table>
<h2>Key plots</h2><h3>Overall health</h3>{_svg_line(c['plots']['health'], 'overall_score', color='#16a34a', y_range=(0, 100))}
<h3>Anomaly score</h3>{_svg_line(c['plots']['health'], 'anomaly_score', color='#dc2626', y_range=(0, 1))}{plots}
<h2>Anomalies</h2><table><tr><th>Detected</th><th>Severity</th><th>Subsystems</th><th>Peak</th><th>Conf.</th><th>Delay s</th><th>Status</th><th>Description</th></tr>{anomalies}</table>
<h2>Event timeline</h2><ul>{timeline}</ul></body></html>"""


def count_reports(s: Session) -> int:
    return int(s.scalar(select(func.count(m.Report.id))) or 0)
