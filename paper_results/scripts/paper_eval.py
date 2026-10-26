"""Multi-seed evaluation of the saved SAT-01 models for the research paper.

Run from backend/:  .venv/bin/python <this file> --out <dir> --seeds 9000 9100 9200 9300 9400
"""
from __future__ import annotations

import argparse
import itertools
import json
import time
from pathlib import Path

import numpy as np
from sklearn.metrics import average_precision_score, roc_auc_score, roc_curve, precision_recall_curve

from app.core.config import get_settings
from app.ml.inference import ModelBundle
from app.ml.training import (alarms, detector_matrix, event_detection, fuse_matrix, generate_fault_run,
                             generate_normal, point_metrics, score_rows)
from app.simulation.scenarios import FAULT_SCENARIOS

SEVS = ["mild", "moderate", "severe"]
DETS = ["rule", "mahalanobis", "isolation_forest", "lstm", "fused"]


def series(det, name, weights, fg):
    if name == "fused":
        return fuse_matrix(det, weights, fg)
    return np.nan_to_num(det[name], nan=0.0)


def summarize(scored, normal_det, score_fn, thr=0.30, pers=3):
    all_al, all_lab, all_sc, delays, per = [], [], [], [], {}
    for det, labels, meta in scored:
        s = score_fn(det)
        al = alarms(s, thr, pers)
        hit, d = event_detection(al, meta)
        all_al.append(al); all_lab.append(labels); all_sc.append(s)
        if hit:
            delays.append(d)
        per[(meta["scenario"], meta["severity"])] = {"hit": bool(hit), "delay": d}
    s = score_fn(normal_det)
    n_al = alarms(s, thr, pers)
    all_al.append(n_al); all_lab.append(np.zeros(len(n_al), np.int8)); all_sc.append(s)
    lab = np.concatenate(all_lab); sc = np.concatenate(all_sc)
    m = point_metrics(np.concatenate(all_al), lab)
    keep = lab >= 0
    m["roc_auc"] = float(roc_auc_score(lab[keep], sc[keep]))
    m["pr_auc"] = float(average_precision_score(lab[keep], sc[keep]))
    m["event_detection_rate"] = len(delays) / len(scored)
    m["mean_detection_delay_s"] = float(np.mean(delays)) if delays else None
    m["median_detection_delay_s"] = float(np.median(delays)) if delays else None
    m["normal_alarm_rate"] = float(n_al.mean())
    # false alarms per hour of nominal operation (alarm onsets = rising edges)
    onsets = int(np.sum(np.diff(n_al.astype(int), prepend=0) == 1))
    m["false_alarms_per_hour"] = onsets / (len(n_al) / 3600)
    return m, per, (lab[keep], sc[keep])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--seeds", type=int, nargs="+", default=[9000, 9100, 9200, 9300, 9400])
    ap.add_argument("--normal-n", type=int, default=14_400)
    ap.add_argument("--phase", type=float, default=None, help="force orbit_phase0 for every generated run")
    a = ap.parse_args()
    if a.phase is not None:
        import app.ml.training as T
        from app.simulation.spacecraft import Spacecraft
        T.Spacecraft = lambda seed, orbit_phase0: Spacecraft(seed=seed, orbit_phase0=a.phase)
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    bundle = ModelBundle.load(get_settings().models_dir)
    W = bundle.metadata["fusion"]["weights"]; FG = bundle.metadata["fusion"]["floor_gain"]

    ablations = {
        "rule only": {"rule": 1},
        "mahalanobis only": {"mahalanobis": 1},
        "lstm only": {"lstm": 1},
        "rule + mahalanobis": {"rule": W["rule"], "mahalanobis": W["mahalanobis"]},
        "rule + lstm": {"rule": W["rule"], "lstm": W["lstm"]},
        "mahalanobis + lstm": {"mahalanobis": W["mahalanobis"], "lstm": W["lstm"]},
        "rule + mahalanobis + lstm (proposed)": dict(W),
        "all four (IF weight 0.15)": {"rule": 0.2, "mahalanobis": 0.25, "lstm": 0.4, "isolation_forest": 0.15},
        "equal weights (no IF)": {"rule": 1 / 3, "mahalanobis": 1 / 3, "lstm": 1 / 3},
    }
    res = {"seeds": a.seeds, "weights": W, "floor_gain": FG, "per_seed": []}
    for seed in a.seeds:
        t0 = time.perf_counter()
        runs = [generate_fault_run(s, sev, seed=seed + i)
                for i, (s, sev) in enumerate(itertools.product(FAULT_SCENARIOS, SEVS))]
        normal = generate_normal(a.normal_n, seed)
        t1 = time.perf_counter()
        scored = [(detector_matrix(score_rows(bundle, r)), l, m) for r, l, m in runs]
        normal_det = detector_matrix(score_rows(bundle, normal))
        n = sum(len(l) for _, l, _ in runs) + len(normal)
        lat = (time.perf_counter() - t1) * 1000 / n
        rec = {"seed": seed, "n_samples": n, "n_fault_samples": int(sum((l == 1).sum() for _, l, _ in runs)),
               "latency_ms_per_sample": lat, "detectors": {}, "per_case": {}, "ablation": {},
               "floor_gain": {}, "alarm_sensitivity": {}}
        curves = {}
        for d in DETS:
            m, per, (lab, sc) = summarize(scored, normal_det, lambda det, d=d: series(det, d, W, FG))
            rec["detectors"][d] = m
            rec["per_case"][d] = {f"{k[0]}|{k[1]}": v for k, v in per.items()}
            if seed == a.seeds[0]:
                fpr, tpr, _ = roc_curve(lab, sc); p, r, _ = precision_recall_curve(lab, sc)
                idx = np.linspace(0, len(fpr) - 1, min(len(fpr), 2000)).astype(int)
                jdx = np.linspace(0, len(p) - 1, min(len(p), 2000)).astype(int)
                curves[d] = {"fpr": fpr[idx].tolist(), "tpr": tpr[idx].tolist(),
                             "precision": p[jdx].tolist(), "recall": r[jdx].tolist()}
        for name, w in ablations.items():
            w = {k: w.get(k, 0.0) for k in ["rule", "mahalanobis", "lstm", "isolation_forest"]}
            m, _, _ = summarize(scored, normal_det, lambda det, w=w: fuse_matrix(det, w, FG))
            rec["ablation"][name] = m
        for fg in [0.0, 0.5, 0.6, 0.7, 0.8, 1.0]:
            m, _, _ = summarize(scored, normal_det, lambda det, fg=fg: fuse_matrix(det, W, fg))
            rec["floor_gain"][str(fg)] = m
        for thr, pers in itertools.product([0.2, 0.3, 0.4, 0.5], [1, 3, 5, 10]):
            m, _, _ = summarize(scored, normal_det, lambda det: fuse_matrix(det, W, FG), thr, pers)
            rec["alarm_sensitivity"][f"{thr}|{pers}"] = m
        if seed == a.seeds[0]:
            (out / "curves.json").write_text(json.dumps(curves))
            np.savez_compressed(out / "example_runs.npz", **{
                f"{m['scenario']}_{m['severity']}__{k}": series(det, k, W, FG)
                for det, _, m in scored for k in DETS},
                **{f"{m['scenario']}_{m['severity']}__labels": l for _, l, m in scored})
        res["per_seed"].append(rec)
        print(f"seed {seed}: gen {t1 - t0:.0f}s score {time.perf_counter() - t1:.0f}s "
              f"fused F1={rec['detectors']['fused']['f1']:.3f}", flush=True)
    (out / "results.json").write_text(json.dumps(res, indent=1))


if __name__ == "__main__":
    main()
