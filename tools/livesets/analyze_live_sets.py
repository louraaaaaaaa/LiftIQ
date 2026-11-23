#!/usr/bin/env python
"""Analyse live-mode app-session CSVs (50 Hz accelerometer + firmware phase/rep data).

For every CSV it finds the per-rep velocity pulses (one fast pull per rep on a cable
stack), estimates peak velocity, up-stroke length and rep period, compares the pulse
count with the rep count the firmware reported and the count the user entered, and
writes figures + tables into a sub-folder named after the file label.

    python analyze_live_sets.py DIR_OR_CSV [DIR_OR_CSV ...] [--out-root DIR]

Input: app live-set CSVs, either the old app-session format or the per-set `liftiq-set v1` format
(`# key: value` header lines, then the same columns plus vert_accel_m_s2 / vert_velocity_m_s, which
are ignored here: the analysis recomputes them from ax, ay, az).

Method (accelerometer only, sensor upright so the z axis is vertical):
  a = clip(az - g, +-12 m/s^2)       g = median of the first second (sensor still)
  v = leaky integral of a, tau = 4 s (no drift reset, so values are estimates)
  pulse = local maximum of v above 0.45 m/s, at least 1 s apart
  up-stroke length = integral of v while v > 0.1 m/s around the pulse
Limits: no zero-velocity update, no orientation tracking; lengths are uncalibrated.
"""
import argparse
import csv
import glob
import os
import statistics as st

import numpy as np
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

BG, PANEL, FG, GRID = "#121714", "#171e1a", "#e6ece6", "#2a352e"
LIME, BLUE, RED, AMBER, GREY = "#c5f36b", "#8ab4ff", "#ff6b6b", "#ffb454", "#8b978d"
plt.rcParams.update({
    "figure.facecolor": BG, "axes.facecolor": PANEL, "axes.edgecolor": GRID,
    "axes.labelcolor": FG, "text.color": FG, "xtick.color": FG, "ytick.color": FG,
    "grid.color": GRID, "axes.grid": True, "legend.facecolor": PANEL,
    "legend.edgecolor": GRID, "font.size": 9,
})

TAU_S = 4.0
CLIP = 12.0
PEAK_MIN = 0.45
REFRACTORY_S = 1.0
EDGE_V = 0.1


def load(path):
    with open(path, newline="") as handle:
        # liftiq-set v1 files start with "# key: value" comment lines; older app-session files do not
        lines = [line for line in handle if not line.startswith("#")]
    rows = list(csv.DictReader(lines))
    return {
        "rows": rows,
        "t": np.array([float(r["elapsed_s"]) for r in rows]),
        "ax": np.array([float(r["ax_m_s2"]) for r in rows]),
        "ay": np.array([float(r["ay_m_s2"]) for r in rows]),
        "az": np.array([float(r["az_m_s2"]) for r in rows]),
        "phase": [r["phase"] for r in rows],
        "reps": np.array([int(r["rep_count"]) for r in rows]),
        "entered": int(rows[0]["actual_rep_count"]) if rows[0].get("actual_rep_count") not in (None, "") else None,
    }


def analyse(d):
    t, az = d["t"], d["az"]
    dt = float(np.median(np.diff(t)))
    n_ref = max(10, int(1.0 / dt))
    g = float(np.median(az[:n_ref]))
    a = np.clip(az - g, -CLIP, CLIP)
    v = np.zeros_like(a)
    for i in range(1, len(a)):
        v[i] = v[i - 1] * (1 - dt / TAU_S) + a[i] * dt
    peaks = []
    for i in range(1, len(v) - 1):
        if v[i] > PEAK_MIN and v[i] >= v[i - 1] and v[i] >= v[i + 1]:
            if not peaks or t[i] - t[peaks[-1]] > REFRACTORY_S:
                peaks.append(i)
            elif v[i] > v[peaks[-1]]:
                peaks[-1] = i
    pulses = []
    for i in peaks:
        lo = i
        while lo > 0 and v[lo] > EDGE_V:
            lo -= 1
        hi = i
        while hi < len(v) - 1 and v[hi] > EDGE_V:
            hi += 1
        pulses.append({
            "i": i, "t": float(t[i]), "vpeak": float(v[i]),
            "disp_cm": float(v[lo:hi].sum() * dt * 100.0), "up_s": float(t[hi] - t[lo]),
            "t0": float(t[lo]), "t1": float(t[hi]),
        })
    if len(pulses) >= 3:
        med_dur = st.median(p["up_s"] for p in pulses[1:])
        med_disp = st.median(p["disp_cm"] for p in pulses[1:])
        pulses[0]["setup"] = pulses[0]["up_s"] > 1.4 * med_dur or pulses[0]["disp_cm"] > 1.25 * med_disp
    for k, p in enumerate(pulses):
        p.setdefault("setup", False)
        p["n"] = k + 1
        p["period_s"] = pulses[k + 1]["t"] - p["t"] if k + 1 < len(pulses) else None
    fw_events = []
    prev = 0
    for k, c in enumerate(d["reps"]):
        if c != prev:
            fw_events.append((float(t[k]), int(c)))
            prev = int(c)
    return {"g": g, "dt": dt, "a": a, "v": v, "pulses": pulses, "fw_events": fw_events,
            "fw_final": int(d["reps"][-1])}


def reps_only(pulses):
    return [p for p in pulses if not p["setup"]]


def velocity_loss(pulses):
    rp = reps_only(pulses)
    if len(rp) < 4:
        return None
    first = st.mean(p["vpeak"] for p in rp[:2])
    last = st.mean(p["vpeak"] for p in rp[-2:])
    return 100.0 * (first - last) / first


def phase_spans(d):
    spans, start, cur = [], 0, d["phase"][0]
    for i, ph in enumerate(d["phase"] + ["END"]):
        if ph != cur:
            spans.append((cur, d["t"][start], d["t"][min(i, len(d["t"]) - 1)]))
            cur, start = ph, i
    return spans


def fig_overview(d, r, label, out):
    fig, axs = plt.subplots(3, 1, figsize=(13, 9), sharex=True, gridspec_kw={"height_ratios": [3, 3, 1.4]})
    t = d["t"]
    ax = axs[0]
    ax.plot(t, d["az"], color=FG, lw=0.9, label="az (vertical)")
    ax.axhline(r["g"], color=GREY, lw=0.6)
    for ph, t0, t1 in phase_spans(d):
        if ph == "CONCENTRIC":
            ax.axvspan(t0, t1, color=LIME, alpha=0.25, lw=0)
        elif ph == "ECCENTRIC":
            ax.axvspan(t0, t1, color=BLUE, alpha=0.22, lw=0)
    for k, (te, c) in enumerate(r["fw_events"]):
        ax.axvline(te, color=RED, lw=1.2, label="firmware rep logged" if k == 0 else None)
        ax.text(te, ax.get_ylim()[1], f" fw {c}", color=RED, fontsize=8, va="top")
    ax.set_ylabel("az  m/s²")
    ax.set_title(f"{label}   entered={d['entered']}   firmware={r['fw_final']}   pulses={len(r['pulses'])}"
                 f" (excluding setup pull: {len(reps_only(r['pulses']))})")
    ax.legend(loc="upper right")
    ax = axs[1]
    ax.plot(t, r["v"], color=BLUE, lw=1.2, label="vertical velocity estimate (leaky integral)")
    ax.axhline(0, color=GREY, lw=0.6)
    ax.axhline(PEAK_MIN, color=AMBER, lw=0.6, ls="--", label=f"pulse threshold {PEAK_MIN} m/s")
    for p in r["pulses"]:
        c = AMBER if p["setup"] else LIME
        ax.plot(p["t"], p["vpeak"], "v", color=c, ms=8)
        ax.text(p["t"], p["vpeak"] + 0.06, str(p["n"]) + ("*" if p["setup"] else ""), color=c, ha="center", fontsize=9)
        ax.axvspan(p["t0"], p["t1"], color=c, alpha=0.10, lw=0)
    ax.set_ylabel("v  m/s")
    ax.legend(loc="upper right")
    ax = axs[2]
    ax.plot(t, d["ax"], color="#7fb0ff", lw=0.7, label="ax")
    ax.plot(t, d["ay"], color="#6fd08c", lw=0.7, label="ay")
    ax.set_ylabel("ax, ay")
    ax.set_xlabel("time  s     (green = firmware CONCENTRIC, blue = ECCENTRIC; * = probable setup pull)")
    ax.legend(loc="upper right", ncol=2)
    fig.tight_layout()
    fig.savefig(os.path.join(out, "01_overview.png"), dpi=110)
    plt.close(fig)


def fig_metrics(r, label, out):
    ps = r["pulses"]
    n = [p["n"] for p in ps]
    col = [AMBER if p["setup"] else LIME for p in ps]
    fig, axs = plt.subplots(1, 3, figsize=(13, 3.8))
    axs[0].bar(n, [p["vpeak"] for p in ps], color=col)
    axs[0].set_title("peak up velocity  m/s")
    axs[1].bar(n, [p["disp_cm"] for p in ps], color=col)
    axs[1].set_title("up-stroke length  cm (estimate)")
    per = [(p["n"], p["period_s"]) for p in ps if p["period_s"]]
    axs[2].bar([x for x, _ in per], [y for _, y in per], color=BLUE)
    axs[2].set_title("time to next rep  s")
    for a_ in axs:
        a_.set_xlabel("pulse #  (amber = setup pull)")
    vl = velocity_loss(ps)
    fig.suptitle(f"{label}   velocity loss first two -> last two reps: " + (f"{vl:.0f}%" if vl is not None else "n/a"))
    fig.tight_layout()
    fig.savefig(os.path.join(out, "02_rep_metrics.png"), dpi=110)
    plt.close(fig)


def fig_overlay(d, r, label, out):
    fig, ax = plt.subplots(figsize=(9, 4.5))
    t, v = d["t"], r["v"]
    cmap = plt.get_cmap("viridis")
    ps = r["pulses"]
    for k, p in enumerate(ps):
        m = (t >= p["t"] - 1.0) & (t <= p["t"] + 2.6)
        ax.plot(t[m] - p["t"], v[m], color=cmap(k / max(1, len(ps) - 1)), lw=1.6,
                ls="--" if p["setup"] else "-", label=f"{p['n']}" + ("*" if p["setup"] else ""))
    ax.axhline(0, color=GREY, lw=0.6)
    ax.set_xlabel("time around the pull peak  s")
    ax.set_ylabel("v  m/s")
    ax.set_title(f"{label}  rep shapes overlaid (early = purple, late = yellow)")
    ax.legend(title="pulse #", ncol=2, fontsize=8)
    fig.tight_layout()
    fig.savefig(os.path.join(out, "03_rep_overlay.png"), dpi=110)
    plt.close(fig)


def fig_counts(d, r, label, out):
    ps = r["pulses"]
    vals = [("you entered", d["entered"], BLUE), ("firmware", r["fw_final"], RED),
            ("pulses (all)", len(ps), LIME), ("pulses (no setup)", len(reps_only(ps)), AMBER)]
    fig, ax = plt.subplots(figsize=(6.5, 3.6))
    ax.bar([v[0] for v in vals], [v[1] if v[1] is not None else 0 for v in vals], color=[v[2] for v in vals])
    for k, v in enumerate(vals):
        ax.text(k, (v[1] or 0) + 0.15, str(v[1]), ha="center")
    ax.set_title(f"{label}  rep counts")
    fig.tight_layout()
    fig.savefig(os.path.join(out, "04_counts.png"), dpi=110)
    plt.close(fig)


def write_tables(d, r, label, out):
    ps = r["pulses"]
    with open(os.path.join(out, "pulses.csv"), "w", newline="") as handle:
        w = csv.writer(handle)
        w.writerow(["pulse", "t_s", "setup_pull", "peak_velocity_m_s", "upstroke_cm_est", "upstroke_s", "time_to_next_s"])
        for p in ps:
            w.writerow([p["n"], f"{p['t']:.2f}", int(p["setup"]), f"{p['vpeak']:.2f}", f"{p['disp_cm']:.0f}",
                        f"{p['up_s']:.2f}", "" if p["period_s"] is None else f"{p['period_s']:.2f}"])
    rp = reps_only(ps)
    vl = velocity_loss(ps)
    lines = [
        f"# Set {label}",
        "",
        f"- entered rep count: **{d['entered']}**, firmware count: **{r['fw_final']}**",
        f"- velocity pulses found: **{len(ps)}**; without the probable setup pull: **{len(rp)}**",
        f"- mean peak velocity (no setup): {st.mean(p['vpeak'] for p in rp):.2f} m/s" if rp else "",
        f"- velocity loss (first two reps -> last two): {vl:.0f}%" if vl is not None else "",
        f"- mean up-stroke length (no setup, estimate): {st.mean(p['disp_cm'] for p in rp):.0f} cm" if rp else "",
        f"- firmware rep events at t = {', '.join(f'{te:.1f}s' for te, _ in r['fw_events'])}",
        f"- gravity reference g = {r['g']:.2f} m/s²",
        "",
        "Files: `01_overview.png` signal, firmware phases and detected pulses; `02_rep_metrics.png` per-rep numbers;",
        "`03_rep_overlay.png` rep shapes overlaid; `04_counts.png` count comparison; `pulses.csv` the numbers.",
        "",
        "Velocity and length are estimates from integrating a 50 Hz accelerometer without zero-velocity resets.",
    ]
    with open(os.path.join(out, "summary.md"), "w") as handle:
        handle.write("\n".join(x for x in lines if x != "" or True) + "\n")


def fig_comparison(results, root):
    fig, axs = plt.subplots(1, 3, figsize=(14, 4.2))
    cmap = plt.get_cmap("tab10")
    for k, (label, d, r) in enumerate(results):
        rp = reps_only(r["pulses"])
        axs[0].plot(range(1, len(rp) + 1), [p["vpeak"] for p in rp], "o-", color=cmap(k), label=label)
        axs[1].plot(range(1, len(rp) + 1), [p["disp_cm"] for p in rp], "o-", color=cmap(k), label=label)
        per = [p["period_s"] for p in rp if p["period_s"]]
        axs[2].plot(range(1, len(per) + 1), per, "o-", color=cmap(k), label=label)
    axs[0].set_title("peak velocity per rep  m/s")
    axs[1].set_title("up-stroke length per rep  cm (estimate)")
    axs[2].set_title("time to next rep  s")
    for a in axs:
        a.set_xlabel("rep # (setup pull excluded)")
    axs[0].legend(fontsize=8)
    fig.tight_layout()
    fig.savefig(os.path.join(root, "comparison_all_sets.png"), dpi=110)
    plt.close(fig)
    with open(os.path.join(root, "comparison_all_sets.md"), "w") as handle:
        handle.write("# All sets\n\n| set | entered | firmware | pulses (all) | pulses (no setup) | mean peak v m/s | velocity loss % |\n|---|---|---|---|---|---|---|\n")
        for label, d, r in results:
            rp = reps_only(r["pulses"])
            vl = velocity_loss(r["pulses"])
            handle.write(f"| {label} | {d['entered']} | {r['fw_final']} | {len(r['pulses'])} | {len(rp)} | "
                         f"{st.mean(p['vpeak'] for p in rp):.2f} | {'' if vl is None else f'{vl:.0f}'} |\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("inputs", nargs="+")
    ap.add_argument("--out-root", help="default: the folder of the first CSV")
    args = ap.parse_args()
    files = []
    for item in args.inputs:
        files += sorted(glob.glob(os.path.join(item, "*.csv"))) if os.path.isdir(item) else [item]
    root = args.out_root or os.path.dirname(os.path.abspath(files[0]))
    results = []
    for path in files:
        d = load(path)
        stem = os.path.splitext(os.path.basename(path))[0]
        label = stem if stem.startswith("liftiq_") else stem.split("-")[-1]  # liftiq-set v1 names keep the whole stem
        out = os.path.join(root, label)
        os.makedirs(out, exist_ok=True)
        r = analyse(d)
        fig_overview(d, r, label, out)
        fig_metrics(r, label, out)
        fig_overlay(d, r, label, out)
        fig_counts(d, r, label, out)
        write_tables(d, r, label, out)
        results.append((label, d, r))
        print(f"{label}: entered={d['entered']} firmware={r['fw_final']} pulses={len(r['pulses'])} -> {out}")
    fig_comparison(results, root)
    print("comparison:", os.path.join(root, "comparison_all_sets.png"))


if __name__ == "__main__":
    main()
