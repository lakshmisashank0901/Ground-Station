import json, sys, numpy as np
from app.core.config import get_settings
from app.ml.inference import ModelBundle
from app.ml.training import alarms, detector_matrix, fuse_matrix, score_rows
from app.simulation.spacecraft import Spacecraft
b = ModelBundle.load(get_settings().models_dir); W=b.metadata["fusion"]["weights"]; FG=b.metadata["fusion"]["floor_gain"]
train_phase = (11 * 0.137) % 1.0
out = []
for k, off in enumerate(np.round(np.arange(0, 1.0, 0.1), 2)):
    for rep in range(2):
        sc = Spacecraft(seed=20000 + 10 * k + rep, orbit_phase0=(train_phase + off) % 1.0)
        rows = [sc.step(1.0, []) for _ in range(14400)]
        det = detector_matrix(score_rows(b, rows))
        r = {k2: float(alarms(np.nan_to_num(det[k2])).mean()) for k2 in ["rule","mahalanobis","isolation_forest","lstm"]}
        r["fused"] = float(alarms(fuse_matrix(det, W, FG)).mean()); r["offset"] = float(off); r["rep"] = rep
        out.append(r); print(r, flush=True)
json.dump(out, open(sys.argv[1], "w"), indent=1)
