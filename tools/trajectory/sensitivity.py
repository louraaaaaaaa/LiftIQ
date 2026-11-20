"""Monte-Carlo sensitivity of per-rep vertical ROM error (synthetic data only).

    python sensitivity.py [--seeds N] [--quick] [--out DIR]

Compares the BMI160-like and BMI270-like parameter sets (see synth.py; the
numbers come from the brief, everything else is flagged ASSUMPTION there).
These numbers are what the algorithms achieve on SIMULATED data with the
simulated error model; they are a lower bound on real-world error, not a
prediction of it (real hands/stacks add unmodelled motion, vibration, impacts).
"""
from __future__ import annotations

import argparse
import sys
from dataclasses import replace
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pipeline  # noqa: E402
import synth  # noqa: E402
from pipeline import PipelineConfig  # noqa: E402

# Base scenario: 40 cm rep, 1.5 s up / 1.5 s down, ~1 s pauses, 2 cm lateral arc, 5 deg tilt, 4 reps.
BASE = synth.Scenario(kind="vertical", rom_m=0.40, t_up_s=1.5, t_down_s=1.5, hold_top_s=1.0,
                      hold_bottom_s=1.0, n_reps=4, lateral_arc_m=0.02, tilt_deg=5.0)
MODELS = [synth.BMI160_LIKE, synth.BMI270_LIKE]


def run_cell(scn, model, cfg, fs=200.0, seeds=6):
    errs, hx, missed, total = [], [], 0, 0
    for s in range(seeds):
        cap, tr = synth.simulate(scn, model, fs, seed=1000 + s)
        res = pipeline.reconstruct(cap, cfg)
        for row in synth.match_reps(res, tr):
            total += 1
            if row["found"]:
                errs.append(row["rom_err_cm"])
                hx.append(row["hx_err_cm"])
            else:
                missed += 1
    e = np.abs(np.array(errs)) if errs else np.array([np.nan])
    return dict(mean_abs=float(np.nanmean(e)), p95=float(np.nanpercentile(e, 95)),
                bias=float(np.mean(errs)) if errs else np.nan,
                hx=float(np.mean(np.abs(hx))) if hx else np.nan, missed=100.0 * missed / max(total, 1))


def sweep(title, label, values, make, seeds, cfg_default):
    """make(value, model) -> (scenario, model, cfg, fs)."""
    print(f"\n== {title}")
    print(f"{label:>14} | " + " | ".join(f"{m.name:^38}" for m in MODELS))
    print(f"{'':>14} | " + " | ".join(f"{'mean|err| p95  bias  hor.err miss%':^38}" for _ in MODELS))
    out = {m.name: [] for m in MODELS}
    for v in values:
        cells = []
        for m in MODELS:
            scn, model, cfg, fs = make(v, m)
            c = run_cell(scn, model, cfg or cfg_default, fs, seeds)
            out[m.name].append(c)
            cells.append(f"{c['mean_abs']:7.2f}{c['p95']:6.2f}{c['bias']:+6.2f}{c['hx']:8.2f}{c['missed']:6.0f}")
        print(f"{str(v):>14} | " + " | ".join(f"{c:^38}" for c in cells))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", type=int, default=6)
    ap.add_argument("--quick", action="store_true", help="3 seeds, fewer sweep points")
    ap.add_argument("--out", default=None, help="save sensitivity.png here")
    a = ap.parse_args(argv)
    seeds = 3 if a.quick else a.seeds
    cfg = PipelineConfig(name="ZUPT-lin+loop")
    print("Errors in cm of per-rep vertical ROM vs truth (40 cm rep unless stated); "
          "hor.err = error of max horizontal excursion; miss% = reps not detected.")
    print(f"pipeline: fusion={cfg.fusion_mode}, bias={cfg.bias}, zupt={cfg.zupt_mode}, loop_closure={cfg.loop_closure}; "
          f"seeds={seeds}, 4 reps/capture, fs=200 Hz unless stated")
    results = {}

    def gyro_res(v, m):
        return BASE, replace(m, gyro_bias_residual_dps=v), None, 200.0
    results["gyro_residual"] = sweep("Residual gyro bias after calibration (deg/s, per axis +/-)", "residual dps",
                                     [0, 0.3, 1, 3] if a.quick else [0, 0.1, 0.3, 1, 3], gyro_res, seeds, cfg)

    def acc_res(v, m):
        return BASE, replace(m, accel_bias_residual_mg=v), None, 200.0
    results["accel_residual"] = sweep("Residual accel bias after calibration (mg, per axis +/-)", "residual mg",
                                      [0, 5, 20] if a.quick else [0, 2, 5, 10, 20], acc_res, seeds, cfg)

    def tilt_err(v, m):
        return BASE, m, replace(cfg, tilt_error_deg=v), 200.0
    results["tilt"] = sweep("Constant tilt error injected into the orientation (deg)", "tilt err deg",
                            [0, 1, 5] if a.quick else [0, 0.5, 1, 2, 5], tilt_err, seeds, cfg)

    def dur(v, m):
        return replace(BASE, t_up_s=v, t_down_s=v), m, None, 200.0
    results["duration"] = sweep("Rep phase duration (s per up/down phase)", "phase s",
                                [0.8, 1.5, 4.0] if a.quick else [0.8, 1.0, 1.5, 2.5, 4.0], dur, seeds, cfg)

    def rate(v, m):
        return BASE, m, None, float(v)
    results["fs"] = sweep("Sample rate (Hz)", "fs Hz", [50, 200] if a.quick else [50, 100, 200, 400], rate, seeds, cfg)

    def pause(v, m):
        return replace(BASE, hold_top_s=v, hold_bottom_s=v), m, None, 200.0
    results["pause"] = sweep("Pause at top and bottom (s); 0 = continuous tempo, no stationary instants inside the set",
                             "pause s", [1.0, 0.3, 0.0] if a.quick else [1.0, 0.5, 0.3, 0.15, 0.0], pause, seeds, cfg)

    results["bias_mode"] = sweep("Gyro bias handling with NO pauses (continuous tempo)", "bias mode",
                                 ["header", "none"],
                                 lambda v, m: (replace(BASE, hold_top_s=0.0, hold_bottom_s=0.0), m,
                                               replace(cfg, bias=v), 200.0), seeds, cfg)

    if a.out:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        keys = list(results)
        fig, axs = plt.subplots(2, 4, figsize=(16, 7))
        xs = {"gyro_residual": [0, 0.1, 0.3, 1, 3], "accel_residual": [0, 2, 5, 10, 20], "tilt": [0, 0.5, 1, 2, 5],
              "duration": [0.8, 1.0, 1.5, 2.5, 4.0], "fs": [50, 100, 200, 400], "pause": [1.0, 0.5, 0.3, 0.15, 0.0]}
        for ax, k in zip(axs.ravel(), [k for k in keys if k in xs]):
            x = xs[k][:len(results[k][MODELS[0].name])] if not a.quick else range(len(results[k][MODELS[0].name]))
            for m in MODELS:
                ax.plot(list(x), [c["mean_abs"] for c in results[k][m.name]], "o-", label=m.name)
            ax.set_title(k)
            ax.set_ylabel("mean |ROM err| cm")
            ax.grid(alpha=0.3)
        axs.ravel()[0].legend()
        fig.tight_layout()
        Path(a.out).mkdir(parents=True, exist_ok=True)
        fig.savefig(Path(a.out) / "sensitivity.png", dpi=110)
        print(f"\nsaved {Path(a.out) / 'sensitivity.png'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
