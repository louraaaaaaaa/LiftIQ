"""Zero-velocity detection, rep segmentation, velocity/position integration.

Integration modes (``integrate``):
  none    plain trapezoid integration of the whole capture (no corrections)
  reset   velocity forced to 0 on every stationary sample (ZUPT)
  linear  ZUPT + per moving-unit linear velocity drift removal (v_end -> 0)
  rts     Kalman filter [p, v, accel-bias] per axis with v=0 pseudo-measurements
          on stationary samples, followed by an RTS backward smoother
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view


# ------------------------------------------------------------ detection
@dataclass
class StationaryParams:
    window_s: float = 0.40        # centred window for the variation statistics
    acc_std_lo: float = 0.04      # m/s^2: std of |a| -> enter stationary
    acc_std_hi: float = 0.06      # exit stationary above this (hysteresis)
    acc_vec_lo: float = 0.055     # m/s^2: sqrt(sum of per-axis variances) of the raw accel vector
    acc_vec_hi: float = 0.075     #   (sees horizontal motion, where |a| barely changes)
    gyro_std_lo: float = 0.8      # deg/s: sqrt(sum of per-axis variances)
    gyro_std_hi: float = 1.5
    acc_mean_tol: float = 0.35    # m/s^2: | mean|a| - g_ref | must be below this
    min_still_s: float = 0.15     # shorter stationary runs are treated as moving
    min_move_s: float = 0.25      # shorter moving runs are treated as stationary
    skip_s: float = 0.30          # start-up transient: never stationary before this time
    robust: bool = True           # windowed MAD (x1.4826) / median instead of std / mean


def _rolling_std(x, w):
    """Centred rolling std (edge-padded), x (N,) -> (N,)."""
    w = max(int(w) | 1, 3)
    pad = w // 2
    xp = np.pad(x, pad, mode="edge")
    c1 = np.concatenate([[0.0], np.cumsum(xp)])
    c2 = np.concatenate([[0.0], np.cumsum(xp * xp)])
    m = (c1[w:] - c1[:-w]) / w
    v = (c2[w:] - c2[:-w]) / w - m * m
    return np.sqrt(np.maximum(v, 0.0)), m


def _runs(mask):
    """Yield (start, end_exclusive, value) runs of a boolean array."""
    n = len(mask)
    if n == 0:
        return
    edges = np.flatnonzero(np.diff(mask.astype(np.int8))) + 1
    starts = np.concatenate([[0], edges])
    ends = np.concatenate([edges, [n]])
    for s, e in zip(starts, ends):
        yield int(s), int(e), bool(mask[s])


def noise_thresholds(acc, gyro_dps, fs, base: StationaryParams | None = None, lo_k=1.5, hi_k=2.0):
    """StationaryParams from the noise of a quiet segment (acc (N,3), gyro (N,3)).

    Thresholds = k x median rolling std (|a|, accel vector, gyro) of that segment,
    with small absolute floors. Lower thresholds than the defaults on a quiet sensor
    -> slow motion is detected better; noisier sensor -> fewer false 'moving'.
    """
    p = base or StationaryParams()
    w = int(round(p.window_s * fs))
    sm = float(np.median(_rolling_std(np.linalg.norm(acc, axis=1), w)[0]))
    sv = float(np.median(np.sqrt(sum(_rolling_std(acc[:, k], w)[0] ** 2 for k in range(3)))))
    sg = float(np.median(np.sqrt(sum(_rolling_std(gyro_dps[:, k], w)[0] ** 2 for k in range(3)))))
    from dataclasses import replace as _r
    return _r(p, acc_std_lo=max(0.01, lo_k * sm), acc_std_hi=max(0.015, hi_k * sm),
              acc_vec_lo=max(0.02, lo_k * sv), acc_vec_hi=max(0.03, hi_k * sv),
              gyro_std_lo=max(0.2, lo_k * sg), gyro_std_hi=max(0.3, hi_k * sg))


def hampel(x, w=7, k=5.0, floor=0.0):
    """Hampel despiking per channel. x (N,) or (N,C). A sample is replaced by the window
    median if it deviates by more than max(k*1.4826*MAD, floor). Returns (y, n_replaced)."""
    x = np.asarray(x, float)
    X = x[:, None] if x.ndim == 1 else x
    pad = w // 2
    win = sliding_window_view(np.pad(X, ((pad, pad), (0, 0)), mode="edge"), w, axis=0)  # (N,C,w)
    med = np.median(win, axis=2)
    mad = 1.4826 * np.median(np.abs(win - med[..., None]), axis=2)
    bad = np.abs(X - med) > np.maximum(k * mad, floor)
    y = np.where(bad, med, X)
    return (y[:, 0] if x.ndim == 1 else y), int(bad.sum())


def _rolling_mad(x, w):
    """Centred rolling robust sigma (1.4826*MAD) and median, edge padded; x (N,)."""
    w = max(int(w) | 1, 3)
    win = sliding_window_view(np.pad(x, w // 2, mode="edge"), w)
    med = np.median(win, axis=1)
    return 1.4826 * np.median(np.abs(win - med[:, None]), axis=1), med


def window_stats(acc, gyro_dps, fs, window_s=0.40, robust=True):
    """Per-sample window statistics: (mag_spread, vec_spread, gyro_spread, median|a|)."""
    w = int(round(window_s * fs))
    f = _rolling_mad if robust else _rolling_std
    amag = np.linalg.norm(acc, axis=1)
    m_s, m_c = f(amag, w)
    v = np.sqrt(sum(f(acc[:, k], w)[0] ** 2 for k in range(3)))
    g = np.sqrt(sum(f(gyro_dps[:, k], w)[0] ** 2 for k in range(3)))
    return m_s, v, g, m_c


_RATIO_CACHE = {}


def _pct_ratio(w, pct, channels, robust):
    """percentile-`pct` of the rolling spread statistic for unit white Gaussian noise (so the quietest-window
    percentile of real data can be converted back to a noise sigma). Deterministic, cached."""
    key = (w, pct, channels, robust)
    if key not in _RATIO_CACHE:
        rng = np.random.default_rng(12345)
        f = _rolling_mad if robust else _rolling_std
        st = np.sqrt(sum(f(rng.normal(size=6000), w)[0] ** 2 for _ in range(channels)))
        _RATIO_CACHE[key] = float(np.percentile(st[w:-w], pct))
    return _RATIO_CACHE[key]


def quiet_window_thresholds(acc, gyro_dps, fs, base: StationaryParams | None = None, lo_k=1.6, hi_k=2.2,
                            pct=1.0, scale=1.0):
    """Thresholds from the quietest windows ANYWHERE in the capture (after the start-up skip).

    spread statistics are computed in sliding windows; the `pct` percentile (low) of each is taken as the
    noise floor of that channel, lo/hi = k x floor, with absolute floors (accel |a| 0.02/0.03, accel vector
    0.04/0.06 m/s^2, gyro 0.3/0.45 deg/s) so a lucky quiet window cannot make the detector impossible.
    `scale` multiplies the result (loosen for a trembling hand).
    """
    p = base or StationaryParams()
    m_s, v, g, _ = window_stats(acc, gyro_dps, fs, p.window_s, p.robust)
    i0 = min(int(p.skip_s * fs), max(len(acc) - 10, 0))
    w = int(round(p.window_s * fs))
    qm = float(np.percentile(m_s[i0:], pct)) / _pct_ratio(w, pct, 1, p.robust)       # -> noise sigma
    qv = float(np.percentile(v[i0:], pct)) / _pct_ratio(w, pct, 3, p.robust) * np.sqrt(3)
    qg = float(np.percentile(g[i0:], pct)) / _pct_ratio(w, pct, 3, p.robust) * np.sqrt(3)
    from dataclasses import replace as _r
    return _r(p, acc_std_lo=scale * max(0.02, lo_k * qm), acc_std_hi=scale * max(0.03, hi_k * qm),
              acc_vec_lo=scale * max(0.04, lo_k * qv), acc_vec_hi=scale * max(0.06, hi_k * qv),
              gyro_std_lo=scale * max(0.3, lo_k * qg), gyro_std_hi=scale * max(0.45, hi_k * qg))


def detect_stationary(acc, gyro_dps, fs, g_ref, params: StationaryParams | None = None):
    """Boolean mask, True where the sensor is (quasi-)stationary.

    Windowed spread (robust MAD by default) of |a|, of the accel vector (sees horizontal motion) and of the
    gyro (bias independent) plus |median|a| - g_ref|, with hysteresis, minimum run lengths and a start-up
    skip (`skip_s`).
    """
    p = params or StationaryParams()
    a_std, a_vec, g_std, a_mean = window_stats(acc, gyro_dps, fs, p.window_s, p.robust)
    off = np.abs(a_mean - g_ref)
    stat = np.zeros(len(a_std), bool)
    state = False
    for i in range(len(a_std)):
        if state:
            if a_std[i] > p.acc_std_hi or a_vec[i] > p.acc_vec_hi or g_std[i] > p.gyro_std_hi or off[i] > 2 * p.acc_mean_tol:
                state = False
        else:
            if a_std[i] < p.acc_std_lo and a_vec[i] < p.acc_vec_lo and g_std[i] < p.gyro_std_lo and off[i] < p.acc_mean_tol:
                state = True
        stat[i] = state
    for s, e, val in list(_runs(stat)):
        if val and (e - s) < p.min_still_s * fs and s > 0 and e < len(stat):
            stat[s:e] = False
    for s, e, val in list(_runs(stat)):
        if (not val) and (e - s) < p.min_move_s * fs:
            stat[s:e] = True
    k = min(int(p.skip_s * fs), len(stat) - 1)
    stat[:k] = stat[k]          # ignore the start-up transient (no artificial move/rest at the start)
    return stat


def reject_implausible_zupt(lin, stat, fs, min_speed=0.04, peak_frac=0.5, min_peak=0.08):
    """Drop stationary runs that look like the mid-point of a slow move.

    A slow rep has a low-acceleration stretch around its PEAK velocity that the
    accel/gyro detector mistakes for rest. Integrating the linear acceleration
    from the last accepted rest to the middle of a candidate run gives its speed;
    a real pause has a speed far below the peak speed reached since the last
    rest (only drift), a false one is near that peak. Reject when
    speed > max(min_speed, peak_frac * peak_speed). The first run (initial rest)
    is always accepted.
    """
    dt = 1.0 / fs
    out = stat.copy()
    last_end = None
    for s, e, val in list(_runs(stat)):
        if not val:
            continue
        if last_end is None:
            last_end = e
            continue
        mid = (s + e) // 2
        seg = lin[last_end:mid + 1]
        if len(seg) > 2:
            sp = np.abs(_trapz_cum(seg[:, 2:3], dt)[:, 0])  # vertical speed only: tilt error leaks second-order into z
            speed, peak = sp[-1], sp.max()
        else:
            speed = peak = 0.0
        if peak > min_peak and speed > max(min_speed, peak_frac * peak):
            out[s:e] = False
        else:
            last_end = e
    return out

def moving_units(stat, min_len=2):
    """List of (i0, i1_exclusive) runs of moving samples."""
    return [(s, e) for s, e, v in _runs(stat) if (not v) and e - s >= min_len]


# ----------------------------------------------------------- integration
def _trapz_cum(x, dt):
    out = np.zeros_like(x)
    out[1:] = np.cumsum(0.5 * (x[1:] + x[:-1]) * dt, axis=0)
    return out


def integrate(lin, stat, fs, mode="linear", rts_cfg=None):
    """Integrate world linear acceleration (N,3) -> (v, p, extra dict)."""
    dt = 1.0 / fs
    n = len(lin)
    extra = {}
    if mode == "none":
        v = _trapz_cum(lin, dt)
        return v, _trapz_cum(v, dt), extra
    if mode == "rts":
        v, p, b = rts_integrate(lin, stat, fs, **(rts_cfg or {}))
        extra["accel_bias"] = b
        return v, p, extra
    v = np.zeros((n, 3))
    units = moving_units(stat)
    for i0, i1 in units:
        # start one sample earlier (v=0 at the last stationary sample)
        j0 = max(i0 - 1, 0)
        seg = lin[j0:i1]
        vv = _trapz_cum(seg, dt)
        if mode == "linear":
            k = np.linspace(0.0, 1.0, len(vv))[:, None]
            vv = vv - k * vv[-1]
        elif mode != "reset":
            raise ValueError(f"unknown ZUPT mode {mode}")
        v[j0:i1] = vv
    v[stat] = 0.0
    p = _trapz_cum(v, dt)
    return v, p, extra


def rts_integrate(lin, stat, fs, sigma_v_zupt=0.01, sigma_acc=0.08, sigma_bias_walk=0.003,
                  sigma_bias0=0.15):
    """Per-axis [p, v, b] Kalman filter + RTS smoother (batched over 3 axes).

    Model: v' = a_meas - b - noise, b random walk. Pseudo-measurement v=0 on
    every stationary sample. The accel-bias state absorbs constant gravity leakage.
    """
    dt = 1.0 / fs
    n = len(lin)
    F = np.array([[1, dt, -0.5 * dt * dt], [0, 1, -dt], [0, 0, 1]], float)
    Bu = np.array([0.5 * dt * dt, dt, 0.0])
    Q = np.diag([1e-10, (sigma_acc ** 2) * dt, (sigma_bias_walk ** 2) * dt])
    x = np.zeros((3, 3))                                  # (axis, state)
    P = np.tile(np.diag([1e-8, 1e-6, sigma_bias0 ** 2]), (3, 1, 1))
    xf = np.zeros((n, 3, 3))
    Pf = np.zeros((n, 3, 3, 3))
    xp = np.zeros((n, 3, 3))
    Pp = np.zeros((n, 3, 3, 3))
    R = sigma_v_zupt ** 2
    for k in range(n):
        if k > 0:
            x = x @ F.T + lin[k - 1][:, None] * Bu[None, :]
            P = F @ P @ F.T + Q
        xp[k], Pp[k] = x, P
        if stat[k]:
            S = P[:, 1, 1] + R
            K = P[:, :, 1] / S[:, None]
            x = x - K * x[:, 1:2]
            P = P - K[:, :, None] * P[:, 1:2, :]
            P = 0.5 * (P + P.transpose(0, 2, 1))
        xf[k], Pf[k] = x, P
    xs = xf.copy()
    eye = 1e-12 * np.eye(3)
    for k in range(n - 2, -1, -1):
        C = Pf[k] @ F.T @ np.linalg.inv(Pp[k + 1] + eye)
        xs[k] = xf[k] + np.einsum("aij,aj->ai", C, xs[k + 1] - xp[k + 1])
    return xs[:, :, 1], xs[:, :, 0], xs[:, :, 2]


def principal_axis(lin, stat):
    """Unit vector of the dominant direction of linear acceleration while moving."""
    m = ~stat
    if m.sum() < 10:
        return np.array([0.0, 0.0, 1.0])
    a = lin[m] - lin[m].mean(axis=0)
    _, _, vt = np.linalg.svd(a, full_matrices=False)
    ax = vt[0]
    return ax if ax[2] >= 0 else -ax


def project_on_axis(lin, axis):
    return (lin @ axis)[:, None] * axis[None, :]


# ------------------------------------------------------------------- reps
@dataclass
class Rep:
    i0: int
    i1: int                     # inclusive
    t: np.ndarray
    p: np.ndarray               # (n,3) position relative to rep start (loop-closed if enabled)
    v: np.ndarray               # (n,3)
    moving: np.ndarray          # (n,) bool
    closure_raw: np.ndarray     # (3,) p_end - p_start before loop closure
    n_units: int = 1


def _zigzag(z, min_swing):
    """Turning-point indices of z (alternating extrema separated by >= min_swing)."""
    idx = [0]
    direction = 0
    ext = 0
    for i in range(1, len(z)):
        if direction == 0:
            if z[i] - z[ext] >= min_swing:
                direction, ext = 1, i
            elif z[ext] - z[i] >= min_swing:
                direction, ext = -1, i
        elif direction == 1:
            if z[i] > z[ext]:
                ext = i
            elif z[ext] - z[i] >= min_swing:
                idx.append(ext)
                direction, ext = -1, i
        else:
            if z[i] < z[ext]:
                ext = i
            elif z[i] - z[ext] >= min_swing:
                idx.append(ext)
                direction, ext = 1, i
    idx.append(ext)
    return idx


def group_units_into_reps(units, p, units_per_rep=None, min_rom=0.08):
    """Return list of (i0, i1_inclusive, n_units).

    units_per_rep=N: group every N consecutive units (e.g. 4 for a table square).
    Otherwise vertical logic: a unit with net z displacement pairs with the next
    unit of opposite sign (concentric + eccentric); a unit that already returns
    near its start (continuous reps, no pause) is split at z turning points.
    """
    if not units:
        return []
    if units_per_rep:
        out = []
        for k in range(0, len(units) - units_per_rep + 1, units_per_rep):
            out.append((max(units[k][0] - 1, 0), units[k + units_per_rep - 1][1] - 1, units_per_rep))
        return out
    z = p[:, 2]
    info = []
    for i0, i1 in units:
        j0 = max(i0 - 1, 0)
        seg = z[j0:i1]
        info.append((j0, i1 - 1, seg.max() - seg.min(), seg[-1] - seg[0]))
    reps, k = [], 0
    while k < len(info):
        j0, j1, swing, net = info[k]
        if swing < min_rom:
            k += 1
            continue
        if abs(net) < 0.5 * swing:  # full cycle inside one unit -> split on turning points
            tp = _zigzag(z[j0:j1 + 1], 0.5 * min_rom)
            tp = [j0 + t for t in tp]
            if len(tp) >= 3:
                for a in range(0, len(tp) - 2, 2):
                    reps.append((tp[a], tp[a + 2], 1))
            else:
                reps.append((j0, j1, 1))
            k += 1
            continue
        if k + 1 < len(info):
            n0, n1, nswing, nnet = info[k + 1]
            if nswing >= min_rom and np.sign(nnet) == -np.sign(net):
                reps.append((j0, n1, 2))
                k += 2
                continue
        k += 1  # unpaired half-rep: skipped
    return reps


def build_reps(t, v, p, stat, reps_idx, loop_closure=True):
    reps = []
    for i0, i1, nu in reps_idx:
        sl = slice(i0, i1 + 1)
        pr = p[sl] - p[i0]
        vr = v[sl].copy()
        mv = ~stat[sl]
        closure = pr[-1].copy()
        if loop_closure:
            prog = np.cumsum(mv.astype(float))
            prog = prog / prog[-1] if prog[-1] > 0 else np.linspace(0, 1, len(pr))
            pr = pr - prog[:, None] * closure[None, :]
            # velocity consistent with the corrected position
            dtm = np.gradient(t[sl])
            if len(pr) > 2:
                vr = np.gradient(pr, axis=0) / dtm[:, None]
        reps.append(Rep(i0, i1, t[sl], pr, vr, mv, closure, nu))
    return reps
