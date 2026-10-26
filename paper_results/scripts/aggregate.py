import json, sys, numpy as np
R = json.load(open(sys.argv[1])); P = R["per_seed"]; n = len(P)
def ms(vals, f="{:.3f}"):
    v = [x for x in vals if x is not None]; 
    if not v: return "—"
    return (f + " ± " + f).format(np.mean(v), np.std(v, ddof=1) if len(v) > 1 else 0)
keys = [("precision","{:.3f}"),("recall","{:.3f}"),("f1","{:.3f}"),("roc_auc","{:.3f}"),("pr_auc","{:.3f}"),
        ("false_positive_rate","{:.3f}"),("event_detection_rate","{:.3f}"),("mean_detection_delay_s","{:.1f}"),
        ("normal_alarm_rate","{:.4f}"),("false_alarms_per_hour","{:.2f}")]
def table(section, names):
    print("| Config | " + " | ".join(k for k,_ in keys) + " |"); print("|---"*(len(keys)+1)+"|")
    for nm in names:
        print(f"| {nm} | " + " | ".join(ms([p[section][nm][k] for p in P], f) for k, f in keys) + " |")
print(f"## seeds={n}, samples/seed={P[0]['n_samples']}, fault samples/seed={P[0]['n_fault_samples']}")
print("\n### Detectors"); table("detectors", ["rule","mahalanobis","isolation_forest","lstm","fused"])
print("\n### Ablation"); table("ablation", list(P[0]["ablation"]))
print("\n### Floor gain"); table("floor_gain", list(P[0]["floor_gain"]))
print("\n### Alarm threshold|persistence"); table("alarm_sensitivity", list(P[0]["alarm_sensitivity"]))
print("\n### Per scenario x severity: detection rate / mean delay (s), per detector")
cases = list(P[0]["per_case"]["fused"])
dets = ["rule","mahalanobis","isolation_forest","lstm","fused"]
print("| Case | " + " | ".join(dets) + " |"); print("|---"*(len(dets)+1)+"|")
for c in cases:
    row = []
    for d in dets:
        hits = [p["per_case"][d][c]["hit"] for p in P]; dl = [p["per_case"][d][c]["delay"] for p in P if p["per_case"][d][c]["hit"]]
        row.append(f"{np.mean(hits):.1f} / " + (f"{np.mean(dl):.0f}±{np.std(dl, ddof=1) if len(dl)>1 else 0:.0f}" if dl else "—"))
    print(f"| {c} | " + " | ".join(row) + " |")
print("\n### Per scenario fused (all severities)")
for s in sorted({c.split('|')[0] for c in cases}):
    hits = [p["per_case"]["fused"][c]["hit"] for p in P for c in cases if c.startswith(s+"|")]
    dl = [p["per_case"]["fused"][c]["delay"] for p in P for c in cases if c.startswith(s+"|") and p["per_case"]["fused"][c]["hit"]]
    print(s, f"{np.mean(hits):.3f}", f"{np.mean(dl):.1f} ± {np.std(dl, ddof=1):.1f}", f"median {np.median(dl):.0f}")
print("\n### latency ms/sample", ms([p["latency_ms_per_sample"] for p in P]))
