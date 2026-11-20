"""Per-rep metrics and comparison against a tape-measured ROM."""
from __future__ import annotations

import numpy as np

from zupt import Rep


def rep_metrics(rep: Rep, index: int = 1, concentric: str = "up", start_phase: str = "up") -> dict:
    p, v, t = rep.p, rep.v, rep.t
    z = p[:, 2]
    rom = float(z.max() - z.min())
    step = np.linalg.norm(np.diff(p, axis=0), axis=1)
    path = float(step.sum())
    xy = p[:, :2]
    horiz = float(np.max(np.linalg.norm(xy - xy[0], axis=1)))
    mv = np.flatnonzero(rep.moving)
    dur = float(t[mv[-1]] - t[mv[0]]) if len(mv) > 1 else float(t[-1] - t[0])

    # concentric phase = last stretch up (or down) ending at the extreme
    i_top, i_bot = int(np.argmax(z)), int(np.argmin(z))
    if start_phase == "down":  # rep starts at the top: use the LAST top / bottom extreme
        i_top = len(z) - 1 - int(np.argmax(z[::-1]))
        i_bot = len(z) - 1 - int(np.argmin(z[::-1]))
    if concentric == "up":
        end = i_top
        start = int(np.argmin(z[: end + 1])) if end > 0 else 0
    else:
        end = i_bot
        start = int(np.argmax(z[: end + 1])) if end > 0 else 0
    sign = 1.0 if concentric == "up" else -1.0
    ph = np.arange(start, end + 1)
    ph_mv = ph[rep.moving[ph]] if len(ph) else ph
    if len(ph_mv) > 2:
        vz = sign * v[ph_mv, 2]
        mean_v, peak_v = float(vz.mean()), float(vz.max())
        con_t = float(t[ph_mv[-1]] - t[ph_mv[0]])
    else:
        mean_v = peak_v = con_t = float("nan")
    return dict(rep=index, t_start=float(t[0]), duration_s=dur, rom_cm=rom * 100,
                path_cm=path * 100, horiz_cm=horiz * 100, mean_con_vel=mean_v,
                peak_con_vel=peak_v, con_s=con_t,
                closure_raw_cm=float(np.linalg.norm(rep.closure_raw) * 100),
                closure_raw_z_cm=float(rep.closure_raw[2] * 100))


def all_rep_metrics(reps, concentric="up", start_phase="up"):
    return [rep_metrics(r, i + 1, concentric, start_phase) for i, r in enumerate(reps)]


def compare_known(rows, known_rom_cm):
    """Adds err_cm / err_pct to each row; returns summary dict."""
    if known_rom_cm is None or not rows:
        return dict(n=len(rows), known=known_rom_cm)
    errs = []
    for r in rows:
        r["err_cm"] = r["rom_cm"] - known_rom_cm
        r["err_pct"] = 100.0 * r["err_cm"] / known_rom_cm
        errs.append(r["err_cm"])
    e = np.array(errs)
    return dict(n=len(rows), known=known_rom_cm, mean_err_cm=float(e.mean()),
                mean_abs_err_cm=float(np.abs(e).mean()), max_abs_err_cm=float(np.abs(e).max()),
                std_cm=float(e.std()), mean_abs_err_pct=float(100 * np.abs(e).mean() / known_rom_cm))


def format_table(rows):
    cols = [("rep", "{:>3d}"), ("t_start", "{:7.2f}"), ("duration_s", "{:6.2f}"), ("rom_cm", "{:7.1f}"),
            ("err_cm", "{:+7.1f}"), ("err_pct", "{:+7.1f}"), ("path_cm", "{:7.1f}"), ("horiz_cm", "{:6.1f}"),
            ("mean_con_vel", "{:7.3f}"), ("peak_con_vel", "{:7.3f}"), ("closure_raw_cm", "{:7.1f}")]
    heads = ["rep", "t0[s]", "dur[s]", "ROM_cm", "err_cm", "err_%", "path_cm", "hor_cm", "v_mean", "v_peak", "clos_cm"]
    use = [(c, f, h) for (c, f), h in zip(cols, heads) if c in rows[0]]
    lines = ["  ".join(f"{h:>7}" for _, _, h in use)]
    for r in rows:
        lines.append("  ".join(f.format(r[c]).rjust(7) for c, f, _ in use))
    return "\n".join(lines)
