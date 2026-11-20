"""6-position static accelerometer calibration (per-axis offset and scale).

    python calibrate_accel.py out.json cap_xp.csv cap_xn.csv cap_yp.csv cap_yn.csv cap_zp.csv cap_zn.csv
    python calibrate_accel.py out.json a.csv:2-6 b.csv:1.5-5 ...      # use only t in [2, 6] s

Each input is a still capture (or window) with one sensor axis pointing up (+x, -x, +y, -y, +z, -z in any order;
the axis/sign is detected from the dominant accel component). Without a window the quietest 1 s of the file is used.
For axis i with readings m(+i), m(-i) and gravity g:  offset_i = (m(+i) + m(-i)) / 2,  scale_i = (m(+i) - m(-i)) / (2 g).
Applied as  acc_cal = (acc - offset) / scale  via  analyze_raw.py --accel-cal out.json.
Limits: ignores axis misalignment / non-orthogonality; positions must be within a few degrees of axis-aligned
(a tilt of e degrees costs ~ 1 - cos(e) in scale); offset temperature drift is not captured.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rawio  # noqa: E402
import zupt  # noqa: E402

G0 = 9.80665


def calibrate_from_means(means, g=G0):
    """means: list of >= 6 mean accel vectors (3,), one per position. Returns dict(offset, scale, ...)."""
    pos = {}
    for m in means:
        m = np.asarray(m, float)
        i = int(np.argmax(np.abs(m)))
        key = (i, 1 if m[i] > 0 else -1)
        pos[key] = m
    missing = [(i, s) for i in range(3) for s in (1, -1) if (i, s) not in pos]
    if missing:
        raise ValueError(f"need all six positions; missing (axis, sign): {missing}")
    off = np.array([(pos[(i, 1)][i] + pos[(i, -1)][i]) / 2 for i in range(3)])
    sc = np.array([(pos[(i, 1)][i] - pos[(i, -1)][i]) / (2 * g) for i in range(3)])
    cal = {k: (m - off) / sc for k, m in pos.items()}
    resid = max(abs(np.linalg.norm(c) - g) for c in cal.values())
    return dict(offset=off.tolist(), scale=sc.tolist(), g=g, max_norm_residual_ms2=float(resid))


def window_mean(cap: rawio.RawCapture, t0=None, t1=None):
    if t0 is not None:
        m = (cap.t >= t0) & (cap.t <= t1)
        return np.median(cap.acc[m], axis=0)
    w = int(cap.fs)
    m_s, v, _, _ = zupt.window_stats(cap.acc, cap.gyro, cap.fs, 0.4)
    c = np.convolve(v + m_s, np.ones(w) / w, mode="same")
    i = int(np.argmin(c[w // 2: len(c) - w // 2])) + w // 2
    return np.median(cap.acc[i - w // 2: i + w // 2], axis=0)


def apply_cal(acc, cal):
    return (np.asarray(acc, float) - np.asarray(cal["offset"])) / np.asarray(cal["scale"])


def main(argv=None):
    a = sys.argv[1:] if argv is None else argv
    if len(a) < 7:
        print(__doc__)
        return 2
    out, items = a[0], a[1:]
    means = []
    for it in items:
        path, _, rng = it.partition(":")
        cap = rawio.load_raw(path)
        t0, t1 = (float(x) for x in rng.split("-")) if rng else (None, None)
        means.append(window_mean(cap, t0, t1))
    cal = calibrate_from_means(means)
    Path(out).write_text(json.dumps(cal, indent=2))
    print(json.dumps(cal, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
