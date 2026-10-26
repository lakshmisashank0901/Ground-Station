# Results for the research paper: SAT-01 hybrid anomaly detection

All numbers come from the trained model bundle `v20261020-180015` in `backend/models/`. The models were
re-scored on **10 independent evaluation seeds** (9000–9900) and are reported as **mean ± sample std**.
Each seed has 21 labelled fault runs (7 scenarios × 3 severities), 14,400 s of fault-free normal operation,
56,538 samples in total, and 10,638 fault-active samples. None of these seeds overlap the training (11),
validation (1000+) or original test (5000+) seeds. The scripts that produce every number are in
`paper_results/scripts/` and the raw per-seed JSON is in `paper_results/raw/`.

Two evaluation conditions are reported:

* **In-distribution (ID).** Every run uses the same orbit-phase offset as the training run (φ₀ = 0.507).
  Only the noise realisations differ. This is the primary result.
* **Phase-shifted (OOD).** Each run takes its orbit phase from its seed, as the original
  `training/evaluate.py` does. This is a robustness / generalisation test (see §5).

Metric definitions follow `app/ml/training.py`. Point metrics are per sample and exclude the 300 s recovery
tail. An *event* counts as detected if an alarm (fused score ≥ 0.30 for 3 consecutive samples) fires
between fault onset and 300 s after the fault ends. Detection delay is measured from fault injection.
ROC-AUC and PR-AUC (average precision) are computed on the continuous detector scores and do not depend on
the alarm threshold.

---

## 1. Experimental setup (for the Methods section)

| Item | Value |
|---|---|
| Telemetry features | 24 (EPS, OBC, ADCS, COMM, payload; `obc_uptime` excluded, `payload_active` added) |
| Sampling rate | 1 Hz |
| Training data | 96,000 s nominal operation (≈ 17 orbits of 5,700 s), chronological 70/15/15 split |
| Fault library | OBC thermal, power degradation, sensor drift, comm degradation, OBC overload, multiple fault, transient spike × {mild, moderate, severe} |
| Fault run layout | 900 s nominal → fault (scenario-specific duration) → 600 s post-fault |
| Scaler | Standard scaler fitted on the training split only |
| Mahalanobis | Ledoit-Wolf covariance; threshold D = 9.77 (99.9th pct. of validation) |
| Isolation Forest | 200 trees; threshold 0.131 above the validation median |
| LSTM forecaster | LSTM(64) → Dropout(0.2) → LSTM(32) → Dense(16) → Dense(24); 60-s window; Adam 1e-3; MSE; 15 epochs; train/val loss 0.234 / 0.233; training time 123 s (CPU) |
| LSTM thresholds | short-term error 7.11 σ; drift bias 3.12 σ |
| Fusion | weights rule 0.25 / Mahalanobis 0.30 / LSTM 0.45 / IF 0; floor gain 0.6 (grid-searched on validation) |
| Alarm rule | fused score ≥ 0.30 for 3 consecutive samples |
| Hardware | Apple-silicon laptop CPU (macOS arm64) |

## 2. Main result: detector comparison (in-distribution, 10 seeds)

**Table 1.**

| Detector | Precision | Recall | F1 | ROC-AUC | PR-AUC | Event detection | Mean delay (s) | False alarms / h |
|---|---|---|---|---|---|---|---|---|
| Rule / range | 1.000 ± 0.000 | 0.414 ± 0.002 | 0.585 ± 0.002 | 0.731 ± 0.000 | 0.576 ± 0.000 | 0.610 ± 0.020 | 146.0 ± 5.8 | 0.00 ± 0.00 |
| Mahalanobis | 0.936 ± 0.002 | 0.895 ± 0.001 | **0.915 ± 0.001** | 0.975 ± 0.001 | **0.961 ± 0.001** | **1.000** | 52.2 ± 0.5 | 0.57 ± 0.17 |
| Isolation Forest | 0.917 ± 0.027 | 0.072 ± 0.005 | 0.134 ± 0.008 | 0.834 ± 0.002 | 0.634 ± 0.006 | 0.348 ± 0.045 | 134.6 ± 32.0 | 3.98 ± 1.30 |
| LSTM | 0.591 ± 0.014 | **0.919 ± 0.002** | 0.719 ± 0.010 | 0.963 ± 0.002 | 0.895 ± 0.003 | 0.981 ± 0.025 | **42.2 ± 1.5** | 3.80 ± 1.05 |
| **Fused (proposed)** | **0.940 ± 0.001** | 0.879 ± 0.001 | 0.908 ± 0.001 | 0.975 ± 0.001 | 0.952 ± 0.001 | **1.000** | 60.9 ± 0.6 | **0.07 ± 0.12** |

False alarms/h counts alarm onsets per hour of fault-free operation. As a fraction of samples, the fused
detector's normal-data alarm rate is 0.0001 ± 0.0003, compared with 0.053 for the LSTM alone.

Figures: `figures/fig1_detector_comparison.png` and `figures/fig2_roc_pr.png` (ROC and PR curves).

## 3. Ablation of the fusion (in-distribution, 10 seeds)

Sub-models keep their original relative weights, re-normalised. Floor gain is 0.6 throughout.

**Table 2.**

| Configuration | Precision | Recall | F1 | PR-AUC | Event det. | Mean delay (s) | False alarms / h |
|---|---|---|---|---|---|---|---|
| Rule only | 1.000 | 0.414 | 0.585 | 0.576 | 0.610 | 146.0 | 0.00 |
| Mahalanobis only | 0.936 | 0.895 | 0.915 | 0.961 | 1.000 | 52.2 | 0.57 |
| LSTM only | 0.591 | 0.919 | 0.719 | 0.895 | 0.981 | 42.2 | 3.80 |
| Rule + Mahalanobis | 0.973 | 0.857 | 0.911 | 0.960 | 1.000 | 71.4 | 0.00 |
| Rule + LSTM | 0.941 | 0.854 | 0.895 | 0.921 | 0.938 | 77.7 | 0.15 |
| Mahalanobis + LSTM | 0.838 | 0.910 | 0.872 | 0.954 | 1.000 | 45.2 | 1.25 |
| **Rule + Mahalanobis + LSTM (proposed)** | 0.940 | 0.879 | 0.908 | 0.952 | 1.000 | 60.9 | 0.07 |
| + Isolation Forest (w = 0.15) | 0.946 | 0.866 | 0.904 | 0.949 | 1.000 | 67.3 | 0.07 |
| Equal weights (no IF) | 0.946 | 0.867 | 0.905 | 0.949 | 1.000 | 66.9 | 0.07 |

All std ≤ 0.015 for the ratio metrics and ≤ 2.4 s for delay (full table: `raw/tables_in_distribution.md`).

**Floor gain** (proposed weights). F1 is flat at 0.908 for g ∈ {0, 0.5, 0.6}. It then drops to 0.869
(g = 0.7), 0.816 (g = 0.8) and 0.724 (g = 1.0, equivalent to max-pooling), as LSTM false positives start
to pass through the floor. Larger g shortens the mean delay (60.9 s → 35.9 s at g = 1.0).

## 4. Per-scenario detection delay (fused, in-distribution)

Every scenario reaches a detection rate of 1.00 at every severity, across all 10 seeds (210/210 events).

**Table 3.** Mean fused detection delay (s), mean ± std over 10 seeds.

| Scenario | Mild | Moderate | Severe |
|---|---|---|---|
| Transient spike | 2 ± 0 | 2 ± 0 | 2 ± 0 |
| OBC overload | 14 ± 1 | 8 ± 0 | 6 ± 0 |
| Comm degradation | 38 ± 2 | 21 ± 1 | 14 ± 1 |
| Multiple fault | 37 ± 3 | 20 ± 1 | 14 ± 1 |
| Power degradation | 66 ± 1 | 34 ± 1 | 22 ± 1 |
| Sensor drift | 224 ± 7 | 126 ± 4 | 87 ± 3 |
| OBC thermal | 251 ± 6 | 166 ± 5 | 124 ± 6 |

Per-detector event detection for the hard cases:

* Mild OBC thermal: rule 0.0, IF 0.0, Mahalanobis 1.0 (226 s), LSTM 1.0 (156 s).
* Mild sensor drift: rule 0.0, IF 0.0, Mahalanobis 1.0 (200 s), LSTM 1.0 (60 s).
* Mild power degradation: rule 0.0, Mahalanobis 1.0 (44 s), LSTM 1.0 (68 s).

The rule detector never detects mild thermal, mild power, mild overload or mild spike faults, because those
faults stay inside their limits.

Figures: `figures/fig5_delay_heatmap.png` and `figures/fig3_score_timelines.png` (example score traces).

## 5. Robustness: orbit-phase shift between training and deployment

In the simulator, the eclipse cycle, solar input and payload schedule follow orbit phase (φ₀ + t/P). The
yaw attitude profile and `gyro_z` follow absolute time t. The training run therefore contains only one
alignment between the yaw profile and the eclipse cycle. When a test run starts at a different orbit
phase, that learned relationship breaks.

**Table 4.** Share of time in alarm (%) on fault-free data against orbit-phase offset from the training
run. Each value is the mean of 2 runs of 4 h each.

| Offset | 0.0 | 0.1 | 0.2 | 0.3 | 0.4 | 0.5 | 0.6 | 0.7 | 0.8 | 0.9 |
|---|---|---|---|---|---|---|---|---|---|---|
| LSTM | 5.4 | 57.4 | 67.4 | 74.6 | 80.1 | 85.4 | 73.3 | 77.7 | 76.2 | 42.3 |
| Mahalanobis | 0.0 | 0.1 | 0.5 | 0.5 | 3.7 | 8.4 | 7.8 | 0.8 | 0.3 | 0.2 |
| Isolation Forest | 0.5 | 1.9 | 1.7 | 0.2 | 0.0 | 0.0 | 0.1 | 0.2 | 0.1 | 0.2 |
| **Fused** | **0.0** | 6.4 | 15.8 | 24.4 | 26.3 | 38.5 | 41.7 | 31.2 | 7.6 | 0.2 |

**Table 5.** Detector metrics with seed-dependent orbit phase (10 seeds, phase offsets spread over the
orbit).

| Detector | Precision | Recall | F1 | ROC-AUC | PR-AUC | Event det. | Mean delay (s) | Normal alarm rate |
|---|---|---|---|---|---|---|---|---|
| Rule / range | 1.000 ± 0.000 | 0.487 ± 0.015 | 0.655 ± 0.013 | 0.772 ± 0.008 | 0.641 ± 0.013 | 0.648 ± 0.025 | 154.8 ± 23.0 | 0.000 ± 0.000 |
| Mahalanobis | 0.803 ± 0.027 | 0.913 ± 0.008 | 0.854 ± 0.016 | 0.973 ± 0.006 | 0.954 ± 0.006 | 1.000 | 41.1 ± 6.3 | 0.022 ± 0.033 |
| Isolation Forest | 0.866 ± 0.032 | 0.143 ± 0.027 | 0.245 ± 0.040 | 0.809 ± 0.010 | 0.559 ± 0.024 | 0.552 ± 0.046 | 193.7 ± 56.4 | 0.004 ± 0.006 |
| LSTM | 0.295 ± 0.031 | 0.970 ± 0.007 | 0.452 ± 0.034 | 0.865 ± 0.028 | 0.548 ± 0.060 | 0.995 ± 0.015 | 14.8 ± 3.9 | 0.626 ± 0.243 |
| Fused | 0.547 ± 0.066 | 0.915 ± 0.009 | 0.683 ± 0.051 | 0.959 ± 0.006 | 0.941 ± 0.005 | 1.000 | 40.7 ± 4.2 | 0.192 ± 0.154 |
| Rule + Mahalanobis (ablation) | 0.962 ± 0.006 | 0.864 ± 0.003 | **0.910 ± 0.003** | 0.973 ± 0.006 | 0.954 ± 0.006 | 1.000 | 67.9 ± 1.5 | **0.000 ± 0.000** |

Figure: `figures/fig4_phase_shift.png`.

## 6. Alarm operating point (fused, in-distribution)

**Table 6.**

| Threshold τ | Persistence (samples) | F1 | Event det. | Mean delay (s) | False alarms / h |
|---|---|---|---|---|---|
| 0.2 | 3 | 0.768 | 1.000 | 38.5 | 2.85 |
| **0.3** | **3** | **0.908** | **1.000** | **60.9** | **0.07** |
| 0.3 | 10 | 0.901 | 0.857 | 78.7 | 0.03 |
| 0.4 | 3 | 0.904 | 1.000 | 80.8 | 0.00 |
| 0.5 | 3 | 0.873 | 1.000 | 112.5 | 0.00 |
| 0.5 | 10 | 0.863 | 0.857 | 140.5 | 0.00 |

The full 4 × 4 grid is in `raw/tables_in_distribution.md`. Figure: `figures/fig6_operating_point.png`.

## 7. Computational cost

* Batch inference over all four detectors plus fusion and explanations: **0.248 ± 0.003 ms per sample**.
  This is the in-distribution measurement; the phase-shifted run gives 0.256 ± 0.006 ms. At 1 Hz telemetry,
  that is under 0.03 % of the real-time budget.
* Full training pipeline (data generation, all models, calibration, fusion tuning, evaluation): 162 s on a
  laptop CPU. The LSTM accounts for 123 s of that.

---

## 8. Findings to state in the paper

1. **Statistical and temporal detectors complement each other.** Under in-distribution conditions the
   fused detector reaches F1 0.908, PR-AUC 0.952 and 100 % event detection (210/210) at 0.07 false
   alarms/h. The rule baseline reaches F1 0.585 and detects 61 % of events. Isolation Forest reaches F1
   0.134 and detects 35 %.
2. **The main benefit of fusion is fewer false alarms, not higher F1.** Mahalanobis alone has a slightly
   higher F1 (0.915) but raises about 8× more false alarms per hour (0.57). The LSTM alone raises 3.8/h.
   Fusion trades about 9 s of mean delay for near-zero false alarms. Report this trade-off directly.
   Do not claim fusion beats every single detector.
3. **The LSTM is the fastest detector on slow faults.** On mild sensor drift it detects in 60 s, against
   200 s for Mahalanobis and 224 s for the fused detector. On mild OBC thermal it detects in 156 s, against
   226 s for Mahalanobis. With the current weights, fusion dilutes this early warning. This motivates
   future work on scenario-adaptive or learned fusion.
4. **Gradual faults are the hardest.** Thermal and drift faults take 87–251 s to detect, against 2–66 s
   for the other scenarios. That delay includes time when the deviation is still below the noise floor.
5. **Isolation Forest is a weak baseline on this telemetry.** It detects 35 % of events in-distribution.
   This supports using it as a reference rather than giving it a fusion weight. Adding it at w = 0.15
   changes F1 by only −0.004.
6. **Generalisation limitation (Threats to Validity).** The learned detectors, especially the LSTM,
   overfit the single yaw-to-eclipse alignment present in the one training trajectory. With the orbit
   phase shifted by 0.5 orbit, the fused detector is in alarm 38–42 % of the time on normal data, and
   fused F1 falls to 0.683 ± 0.051. The rule + Mahalanobis combination stays robust (F1 0.910, zero false
   alarms). Recommended mitigations: train on several trajectories with varied initial orbit phase, or add
   orbit-phase features (sin/cos φ). This should be reported as a limitation.

## 9. Corrections to `docs/ML_REPORT.md` if you cite it

* It says 25 features. The model uses **24** (`metadata.json → features`).
* Its single-test-set fused figures (F1 0.768, FPR 0.133) mix two conditions: phase-matched normal data
  (the tail of the training trajectory) and phase-shifted fault runs. Its statement that the false
  positives come from the post-recovery fault tail is not supported. Most of them are pre-fault nominal
  samples in phase-shifted runs (§5). Use the multi-seed numbers above instead.
* All data is simulated. The results show the method works on the project's fault library, not performance
  on real spacecraft telemetry.

## Reproduce

```bash
cd backend
PYTHONPATH=. .venv/bin/python ../paper_results/scripts/paper_eval.py --out ../paper_results/raw/id --phase 0.507 \
    --seeds 9000 9100 9200 9300 9400 9500 9600 9700 9800 9900          # in-distribution
PYTHONPATH=. .venv/bin/python ../paper_results/scripts/paper_eval.py --out ../paper_results/raw/ood \
    --seeds 9000 9100 9200 9300 9400 9500 9600 9700 9800 9900          # phase-shifted
PYTHONPATH=. .venv/bin/python ../paper_results/scripts/phase_sweep.py ../paper_results/raw/phase_sweep.json
.venv/bin/python ../paper_results/scripts/aggregate.py ../paper_results/raw/id/results.json
# figures need matplotlib; make_figures.py expects results_inphase/ and results/ subfolders of its argument
```
