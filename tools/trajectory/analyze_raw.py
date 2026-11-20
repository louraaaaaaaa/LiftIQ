"""Analyse a LiftIQ raw CSV v1 capture: per-rep ROM / velocity / path, ablations, plots.

    python analyze_raw.py file.csv [--ablate] [--plot] [--out DIR]
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import replace
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fusion  # noqa: E402
import metrics  # noqa: E402
import pipeline  # noqa: E402
import rawio  # noqa: E402
import zupt  # noqa: E402
from pipeline import PipelineConfig  # noqa: E402


def ablation_configs(base: PipelineConfig):
    b = base
    return [
        ("static gravity, no ZUPT", replace(b, fusion_mode="static", zupt_mode="none", loop_closure=False)),
        ("static gravity + ZUPT lin + loop", replace(b, fusion_mode="static", zupt_mode="linear", loop_closure=True)),
        ("fusion, no gyro bias sub, ZUPT lin + loop", replace(b, bias="none", zupt_mode="linear", loop_closure=True)),
        ("fusion + bias, no ZUPT", replace(b, zupt_mode="none", loop_closure=False)),
        ("fusion + bias, ZUPT reset", replace(b, zupt_mode="reset", loop_closure=False)),
        ("fusion + bias, ZUPT + linear drift removal", replace(b, zupt_mode="linear", loop_closure=False)),
        ("... + loop closure", replace(b, zupt_mode="linear", loop_closure=True)),
        ("fusion + bias, RTS smoothing", replace(b, zupt_mode="rts", loop_closure=False)),
        ("... RTS + loop closure", replace(b, zupt_mode="rts", loop_closure=True)),
        ("... linear + loop + PCA axis", replace(b, zupt_mode="linear", loop_closure=True, pca=True)),
    ]


def parse_start_phase(cap, cli=None):
    """'start=up|down' as first token of the header notes; else CLI value; else 'up'."""
    tok = str(cap.meta.get("notes", "")).strip().split(" ")[0].lower()
    if tok in ("start=up", "start=down"):
        return tok.split("=")[1]
    return cli or "up"


def run_one(cap, cfg, concentric="up"):
    res = pipeline.reconstruct(cap, cfg)
    rows = metrics.all_rep_metrics(res.reps, concentric, cfg.start_phase)
    summ = metrics.compare_known(rows, cap.known_rom_cm)
    return res, rows, summ


def print_report(cap, res, rows, summ):
    vr = rawio.validate(cap)
    print(f"samples={vr['n']}  duration={vr['duration_s']:.1f}s  fs_est={vr['fs_est']:.1f}Hz  "
          f"exercise={cap.meta.get('exercise', '?')}  load_kg={cap.meta.get('load_kg', '?')}  "
          f"known_rom_cm={cap.meta.get('known_rom_cm', '-')}")
    for w in vr["warnings"] + res.notes:
        print(f"  ! {w}")
    print(f"gyro bias used ({res.bias_source}): {np.round(res.gyro_bias, 3)} deg/s   g_ref={res.g_ref:.3f} m/s^2   "
          f"stationary={100 * res.stat.mean():.0f}%   config={res.cfg.name} "
          f"[{res.cfg.fusion_mode}/{res.cfg.bias}/{res.cfg.zupt_mode}/loop={res.cfg.loop_closure}/pca={res.cfg.pca}]")
    if not rows:
        print("no reps detected")
        return
    print(metrics.format_table(rows))
    roms = np.array([r["rom_cm"] for r in rows])
    print(f"reps={len(rows)}  ROM mean={roms.mean():.1f} cm  sd={roms.std():.1f} cm")
    if "mean_abs_err_cm" in summ:
        print(f"vs known {summ['known']:.1f} cm: mean err {summ['mean_err_cm']:+.2f} cm, "
              f"mean |err| {summ['mean_abs_err_cm']:.2f} cm ({summ['mean_abs_err_pct']:.1f}%), "
              f"max |err| {summ['max_abs_err_cm']:.2f} cm")


def rest_consistency(cap, res, min_len_s=0.2):
    """Per stationary window: accel-derived tilt vs fused vs gyro-only (no accel correction) roll/pitch.

    Returns list of dicts and prints a table. 'gyro-only' integrates the bias-corrected gyro from the same
    initial pose with no gravity correction, so (gyro-only - accel) is the drift the correction removes.
    """
    from fusion import mahony, q_to_euler_deg
    fs = res.fs
    w = np.radians(res.gyro - res.gyro_bias)
    qg = mahony(res.acc, w, fs, res.q0, kp=0.0, g_ref=res.g_ref)
    eg, ef = q_to_euler_deg(qg), q_to_euler_deg(res.q)
    rows = []
    for s, e, v in _runs(res.stat):
        if not v or (e - s) < min_len_s * fs:
            continue
        m = np.median(res.acc[s:e], axis=0)
        roll = np.degrees(np.arctan2(m[1], m[2]))
        pitch = np.degrees(np.arctan2(-m[0], np.hypot(m[1], m[2])))
        k = (s + e) // 2
        rows.append(dict(t=res.t[k], dur=(e - s) / fs, acc_roll=roll, acc_pitch=pitch, fused_roll=ef[k, 0],
                         gyro_roll=eg[k, 0], gyro_pitch=eg[k, 1]))
    return rows, eg


def print_rest_consistency(rows):
    if not rows:
        print("no stationary windows >= 0.2 s: orientation is pure gyro integration")
        return
    print(f"stationary windows: {len(rows)}   (roll/pitch in deg)")
    print("  t[s]  dur   acc_roll  fused_roll  gyro_only_roll | acc_pitch  gyro_only_pitch")
    for r in rows:
        print(f"{r['t']:6.2f} {r['dur']:5.2f} {r['acc_roll']:9.1f} {r['fused_roll']:10.1f} {r['gyro_roll']:14.1f} |"
              f" {r['acc_pitch']:9.1f} {r['gyro_pitch']:15.1f}")
    drift = [r['gyro_roll'] - r['acc_roll'] for r in rows]
    print(f"gyro-only minus accel roll at rests: first {drift[0]:+.1f}, last {drift[-1]:+.1f}, max |.| {max(abs(d) for d in drift):.1f} deg")


def ablation_table(cap, base, concentric="up"):
    print("\nABLATION")
    head = f"{'configuration':<46}{'reps':>5}{'ROM cm':>8}{'sd':>6}{'|err|cm':>9}{'max':>7}{'|err|%':>8}"
    print(head)
    print("-" * len(head))
    out = []
    for name, cfg in ablation_configs(base):
        try:
            _, rows, summ = run_one(cap, replace(cfg, name=name), concentric)
        except Exception as e:  # keep the table going
            print(f"{name:<46} failed: {e}")
            continue
        roms = np.array([r["rom_cm"] for r in rows]) if rows else np.array([np.nan])
        if "mean_abs_err_cm" in summ:
            tail = f"{summ['mean_abs_err_cm']:9.2f}{summ['max_abs_err_cm']:7.2f}{summ['mean_abs_err_pct']:8.1f}"
        else:
            tail = f"{'-':>9}{'-':>7}{'-':>8}"
        print(f"{name:<46}{len(rows):5d}{np.nanmean(roms):8.1f}{np.nanstd(roms):6.1f}{tail}")
        out.append((name, summ))
    return out


def make_plots(cap, res, outdir: Path, stem: str):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    outdir.mkdir(parents=True, exist_ok=True)
    t = res.t

    fig, ax = plt.subplots(3, 1, figsize=(11, 7), sharex=True)
    ax[0].plot(t, cap.acc)
    ax[0].set_ylabel("accel m/s^2 (sensor)")
    ax[0].legend(["ax", "ay", "az"], ncol=3, loc="upper right")
    ax[1].plot(t, cap.gyro - res.gyro_bias)
    ax[1].set_ylabel("gyro deg/s (bias-sub)")
    ax[2].plot(t, res.lin)
    ax[2].set_ylabel("linear acc world m/s^2")
    ax[2].set_xlabel("t [s]")
    for a in ax:
        _shade(a, t, res.stat)
    fig.suptitle("Raw signals (grey = stationary)")
    fig.tight_layout()
    fig.savefig(outdir / f"{stem}_raw.png", dpi=110)
    plt.close(fig)

    eul = fusion.q_to_euler_deg(res.q)
    fig, ax = plt.subplots(figsize=(11, 3.5))
    ax.plot(t, eul)
    ax.legend(["roll", "pitch", "yaw (relative to start)"], ncol=3)
    ax.set_xlabel("t [s]")
    ax.set_ylabel("deg")
    ax.set_title("Orientation (ZYX Euler)")
    fig.tight_layout()
    fig.savefig(outdir / f"{stem}_orientation.png", dpi=110)
    plt.close(fig)

    fig, ax = plt.subplots(figsize=(11, 3.5))
    ax.plot(t, res.v)
    ax.legend(["vx", "vy", "vz"], ncol=3)
    _shade(ax, t, res.stat)
    ax.set_xlabel("t [s]")
    ax.set_ylabel("m/s")
    ax.set_title(f"World velocity ({res.cfg.zupt_mode}); grey = stationary instants")
    fig.tight_layout()
    fig.savefig(outdir / f"{stem}_velocity.png", dpi=110)
    plt.close(fig)

    if res.reps:
        fig = plt.figure(figsize=(7, 6))
        a3 = fig.add_subplot(projection="3d")
        for k, r in enumerate(res.reps):
            a3.plot(*(r.p.T * 100), label=f"rep {k + 1}")
        a3.set_xlabel("x cm")
        a3.set_ylabel("y cm")
        a3.set_zlabel("z cm (up)")
        a3.legend(fontsize=7)
        a3.set_title("3D path per rep (yaw relative to start pose)")
        fig.tight_layout()
        fig.savefig(outdir / f"{stem}_path3d.png", dpi=110)
        plt.close(fig)

        fig, ax = plt.subplots(1, 3, figsize=(13, 4))
        for k, r in enumerate(res.reps):
            P = r.p * 100
            ax[0].plot(P[:, 0], P[:, 1])
            ax[1].plot(P[:, 0], P[:, 2])
            ax[2].plot(P[:, 1], P[:, 2])
        for a, (xl, yl) in zip(ax, [("x", "y"), ("x", "z"), ("y", "z")]):
            a.set_xlabel(f"{xl} cm")
            a.set_ylabel(f"{yl} cm")
            a.set_aspect("equal", adjustable="datalim")
            a.grid(alpha=0.3)
        fig.suptitle("2D projections of rep paths")
        fig.tight_layout()
        fig.savefig(outdir / f"{stem}_path2d.png", dpi=110)
        plt.close(fig)
    return sorted(p.name for p in outdir.glob(f"{stem}_*.png"))


def _shade(ax, t, stat):
    for s, e, v in _runs(stat):
        if v:
            ax.axvspan(t[s], t[min(e, len(t) - 1)], color="0.85", lw=0)


def _runs(mask):
    n = len(mask)
    edges = np.flatnonzero(np.diff(mask.astype(np.int8))) + 1
    starts = np.concatenate([[0], edges])
    ends = np.concatenate([edges, [n]])
    return [(int(s), int(e), bool(mask[s])) for s, e in zip(starts, ends)]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file")
    ap.add_argument("--ablate", action="store_true", help="run the ablation comparison table")
    ap.add_argument("--plot", action="store_true", help="save PNG plots")
    ap.add_argument("--out", default=None, help="output directory for plots (default: <file dir>/analysis)")
    ap.add_argument("--zupt", default="linear", choices=["none", "reset", "linear", "rts"])
    ap.add_argument("--no-loop-closure", action="store_true")
    ap.add_argument("--pca", action="store_true", help="project acceleration on its principal axis")
    ap.add_argument("--units-per-rep", type=int, default=None, help="e.g. 4 for the table-square test")
    ap.add_argument("--min-rom-cm", type=float, default=8.0)
    ap.add_argument("--concentric", default="up", choices=["up", "down"])
    ap.add_argument("--start-phase", default=None, choices=["up", "down"],
                    help="first phase of a rep; header notes 'start=down ...' take precedence (default up)")
    ap.add_argument("--auto-thresholds", action="store_true",
                    help="derive stationary thresholds from the noise of the first stationary second")
    ap.add_argument("--noise-from", default=None, help="static capture (test A) to take the noise from")
    ap.add_argument("--rest-report", action="store_true", help="accel-tilt vs fused vs gyro-only orientation at the stationary windows")
    ap.add_argument("--accel-cal", default=None, help="JSON from calibrate_accel.py (offset/scale per axis)")
    ap.add_argument("--normalize-gravity", action="store_true", help="rescale accel so the rest |g| = 9.80665 (assumes the excess is scale, not offset)")
    ap.add_argument("--kp-weak", type=float, default=0.0, help="weak gravity gain outside stationary windows (gated by | |a|-g | < 0.3)")
    ap.add_argument("--stationary-scale", type=float, default=1.0, help="multiply auto stationary thresholds (e.g. 4 for a trembling hand)")
    ap.add_argument("--no-reject-zupt", action="store_true", help="disable the vertical-velocity-peak rest rejection (use for non-vertical tests)")
    ap.add_argument("--no-despike", action="store_true")
    ap.add_argument("--no-auto-thresholds", action="store_true", help="use the fixed StationaryParams defaults")
    ap.add_argument("--window-s", type=float, default=0.4, help="stationary statistic window (0.25-0.5 s)")
    ap.add_argument("--skip-s", type=float, default=0.3, help="ignore this much start-up transient for stationary detection")
    ap.add_argument("--bias", default="header", choices=["header", "rest", "none"])
    a = ap.parse_args(argv)

    cap = rawio.load_raw(a.file)
    base = PipelineConfig(name="selected", zupt_mode=a.zupt, loop_closure=not a.no_loop_closure, pca=a.pca,
                          units_per_rep=a.units_per_rep, min_rom_m=a.min_rom_cm / 100, bias=a.bias,
                          start_phase=parse_start_phase(cap, a.start_phase),
                          auto_thresholds=(not a.no_auto_thresholds) or bool(a.noise_from),
                          stationary_scale=a.stationary_scale, reject_false_zupt=not a.no_reject_zupt, despike=not a.no_despike, kp_weak=a.kp_weak,
                          normalize_gravity=a.normalize_gravity,
                          accel_cal=json.loads(Path(a.accel_cal).read_text()) if a.accel_cal else None,
                          stationary=zupt.StationaryParams(skip_s=a.skip_s, window_s=a.window_s),
                          noise_from=rawio.load_raw(a.noise_from) if a.noise_from else None)
    res, rows, summ = run_one(cap, base, a.concentric)
    print_report(cap, res, rows, summ)
    if a.rest_report:
        r, _ = rest_consistency(cap, res)
        print_rest_consistency(r)
    if a.ablate:
        ablation_table(cap, base, a.concentric)
    if a.plot:
        out = Path(a.out) if a.out else Path(a.file).resolve().parent / "analysis"
        files = make_plots(cap, res, out, Path(a.file).stem)
        print(f"\nplots in {out}: {', '.join(files)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
