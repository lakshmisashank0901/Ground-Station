import json, sys
from pathlib import Path
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

S = Path(sys.argv[1]); F = S / "figures"; F.mkdir(exist_ok=True)
IN, OOD = S / "results_inphase", S / "results"
C = {"fused": "#2a78d6", "mahalanobis": "#eb6834", "lstm": "#1baf7a", "rule": "#eda100", "isolation_forest": "#e87ba4"}
LBL = {"fused": "Fused (proposed)", "mahalanobis": "Mahalanobis", "lstm": "LSTM", "rule": "Rule/range",
       "isolation_forest": "Isolation Forest"}
ORDER = ["rule", "mahalanobis", "isolation_forest", "lstm", "fused"]
INK, MUTED, GRID = "#0b0b0b", "#52514e", "#e4e3df"
plt.rcParams.update({"font.size": 9, "axes.edgecolor": MUTED, "axes.labelcolor": INK, "xtick.color": MUTED,
                     "ytick.color": MUTED, "axes.spines.top": False, "axes.spines.right": False,
                     "axes.grid": True, "grid.color": GRID, "grid.linewidth": 0.6, "savefig.dpi": 300,
                     "legend.frameon": False, "font.family": "DejaVu Sans"})

def load(d): return json.load(open(d / "results.json"))["per_seed"]
Pin, Pood = load(IN), load(OOD)

# Fig 1: detector comparison (in-distribution), F1 / PR-AUC / event detection, mean ± sd
mets = [("f1", "Point F1"), ("pr_auc", "PR-AUC"), ("event_detection_rate", "Event detection rate")]
fig, ax = plt.subplots(figsize=(6.6, 2.8))
x = np.arange(len(mets)); w = 0.16
for i, d in enumerate(ORDER):
    m = [np.mean([p["detectors"][d][k] for p in Pin]) for k, _ in mets]
    s = [np.std([p["detectors"][d][k] for p in Pin], ddof=1) for k, _ in mets]
    ax.bar(x + (i - 2) * w, m, w * 0.9, yerr=s, color=C[d], label=LBL[d], capsize=2, error_kw={"lw": 0.8})
ax.set_xticks(x, [l for _, l in mets]); ax.set_ylim(0, 1.05); ax.grid(axis="x", visible=False)
ax.legend(ncol=5, loc="upper center", bbox_to_anchor=(0.5, 1.18), fontsize=7.5)
fig.tight_layout(); fig.savefig(F / "fig1_detector_comparison.png"); plt.close(fig)

# Fig 2: ROC + PR curves (in-distribution, seed 9000)
cv = json.load(open(IN / "curves.json"))
fig, (a, b) = plt.subplots(1, 2, figsize=(6.6, 2.9))
for d in ORDER:
    auc = np.mean([p["detectors"][d]["roc_auc"] for p in Pin]); ap = np.mean([p["detectors"][d]["pr_auc"] for p in Pin])
    a.plot(cv[d]["fpr"], cv[d]["tpr"], color=C[d], lw=1.6, label=f"{LBL[d]} ({auc:.3f})")
    b.plot(cv[d]["recall"], cv[d]["precision"], color=C[d], lw=1.6, label=f"{LBL[d]} ({ap:.3f})")
a.plot([0, 1], [0, 1], ls=":", color=MUTED, lw=0.8)
a.set(xlabel="False positive rate", ylabel="True positive rate", title="ROC (AUC)")
b.set(xlabel="Recall", ylabel="Precision", title="Precision–recall (AP)", ylim=(0, 1.02))
a.legend(fontsize=6.5, loc="lower right"); b.legend(fontsize=6.5, loc="lower left")
fig.tight_layout(); fig.savefig(F / "fig2_roc_pr.png"); plt.close(fig)

# Fig 3: example score timelines
ex = np.load(IN / "example_runs.npz")
cases = [("obc_thermal_moderate", "OBC thermal (moderate)"), ("sensor_drift_mild", "Sensor drift (mild)"),
         ("power_degradation_moderate", "Power degradation (moderate)")]
fig, axs = plt.subplots(len(cases), 1, figsize=(6.6, 5.6), sharex=False)
for ax, (k, title) in zip(axs, cases):
    lab = ex[f"{k}__labels"]; t = np.arange(len(lab))
    on = np.flatnonzero(lab == 1)
    ax.axvspan(on[0], on[-1], color="#e34948", alpha=0.08, lw=0, label="Fault active")
    rec = np.flatnonzero(lab == -1)
    if len(rec): ax.axvspan(rec[0], rec[-1], color=MUTED, alpha=0.08, lw=0, label="Recovery (masked)")
    for d in ["rule", "mahalanobis", "lstm", "fused"]:
        ax.plot(t, ex[f"{k}__{d}"], color=C[d], lw=1.8 if d == "fused" else 0.9, label=LBL[d],
                alpha=1 if d == "fused" else 0.85, zorder=3 if d == "fused" else 2)
    ax.axhline(0.30, color=INK, ls="--", lw=0.8); ax.text(t[-1], 0.32, "alarm 0.30", ha="right", fontsize=7, color=MUTED)
    ax.set(ylim=(0, 1.02), ylabel="Score", title=title); ax.title.set_fontsize(9)
axs[-1].set_xlabel("Time since run start (s)")
axs[0].legend(ncol=3, fontsize=7, loc="upper left")
fig.tight_layout(); fig.savefig(F / "fig3_score_timelines.png"); plt.close(fig)

# Fig 4: normal-operation alarm rate vs orbit-phase offset from training run
sw = json.load(open(OOD / "phase_sweep.json"))
offs = sorted({r["offset"] for r in sw})
fig, ax = plt.subplots(figsize=(6.6, 2.8))
for d in ["lstm", "fused", "mahalanobis", "isolation_forest"]:
    y = [np.mean([r[d] for r in sw if r["offset"] == o]) * 100 for o in offs]
    ax.plot(offs, y, color=C[d], lw=2, marker="o", ms=4, label=LBL[d])
ax.set(xlabel="Orbit-phase offset of test run vs. training run (fraction of orbit)",
       ylabel="Time in alarm on\nnormal data (%)", ylim=(0, 100))
ax.legend(fontsize=7.5, ncol=4, loc="upper center", bbox_to_anchor=(0.5, 1.15))
fig.tight_layout(); fig.savefig(F / "fig4_phase_shift.png"); plt.close(fig)

# Fig 5: fused detection delay heatmap scenario × severity (in-distribution)
sc = ["transient_spike", "obc_overload", "comm_degradation", "multiple_fault", "power_degradation", "sensor_drift", "obc_thermal"]
sv = ["mild", "moderate", "severe"]
M = np.array([[np.mean([p["per_case"]["fused"][f"{s}|{v}"]["delay"] for p in Pin]) for v in sv] for s in sc])
fig, ax = plt.subplots(figsize=(4.2, 3.2))
im = ax.imshow(M, cmap="Blues", aspect="auto"); ax.grid(False)
ax.set_xticks(range(3), sv); ax.set_yticks(range(len(sc)), [s.replace("_", " ") for s in sc])
for i in range(len(sc)):
    for j in range(3):
        ax.text(j, i, f"{M[i, j]:.0f}", ha="center", va="center", fontsize=8,
                color="white" if M[i, j] > M.max() * 0.55 else INK)
fig.colorbar(im, ax=ax, label="Mean detection delay (s)", shrink=0.9)
fig.tight_layout(); fig.savefig(F / "fig5_delay_heatmap.png"); plt.close(fig)

# Fig 6: operating-point trade-off (alarm threshold × persistence), in-distribution
fig, ax = plt.subplots(figsize=(4.6, 3.0))
seq = ["#9ec5f0", "#5f9ee6", "#2a78d6", "#174a8a"]
for i, pers in enumerate([1, 3, 5, 10]):
    xs, ys = [], []
    for thr in [0.2, 0.3, 0.4, 0.5]:
        k = f"{thr}|{pers}"
        xs.append(np.mean([p["alarm_sensitivity"][k]["mean_detection_delay_s"] for p in Pin]))
        ys.append(np.mean([p["alarm_sensitivity"][k]["f1"] for p in Pin]))
    ax.plot(xs, ys, color=seq[i], lw=2, marker="o", ms=4, label=f"persistence {pers}")
    if pers == 3:
        for thr, xv, yv in zip([0.2, 0.3, 0.4, 0.5], xs, ys):
            ax.annotate(f"τ={thr}", (xv, yv), textcoords="offset points", xytext=(-6, 7), fontsize=7, color=MUTED)
ax.set(xlabel="Mean detection delay (s)", ylabel="Point F1"); ax.legend(fontsize=7)
fig.tight_layout(); fig.savefig(F / "fig6_operating_point.png"); plt.close(fig)
print("ok", sorted(p.name for p in F.iterdir()))
