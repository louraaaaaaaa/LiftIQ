"""End-to-end reconstruction: RawCapture -> reps with 3D position / velocity."""
from __future__ import annotations

from dataclasses import dataclass, field, replace

import numpy as np

import fusion
import rawio
import zupt


@dataclass
class PipelineConfig:
    name: str = "full"
    fusion_mode: str = "mahony"          # 'mahony' | 'static' (one orientation from the initial rest)
    bias: str = "header"            # 'header' | 'rest' | 'none'  (gyro bias subtraction)
    zupt_mode: str = "linear"            # 'none' | 'reset' | 'linear' | 'rts'
    loop_closure: bool = True       # force start == end per rep
    pca: bool = False               # project acceleration on its principal axis
    kp: float = 4.0                 # Mahony gain (1/s) when gravity is trusted
    gate_stationary: bool = True    # trust gravity only on stationary samples (else | |a|-g | gate only)
    gate_tol: float = 0.5           # m/s^2: trust gravity only if | |a|-g | < this
    rest_s: float = 1.0             # initial-rest window used for init pose / g
    rest_offset: bool = True        # subtract mean linear acc of the initial rest
    stationary: zupt.StationaryParams = field(default_factory=zupt.StationaryParams)
    reject_false_zupt: bool = True  # drop rest candidates that sit at a velocity peak (slow reps)
    auto_thresholds: bool = True    # thresholds from the quietest windows anywhere in the capture (or noise_from)
    stationary_scale: float = 1.0   # multiply auto thresholds (loosen for a trembling hand)
    despike: bool = True            # Hampel despiking of accel and gyro before everything else
    kp_weak: float = 0.0            # weak gravity gain outside stationary windows (gated by weak_tol), 0 = off
    weak_tol: float = 0.3           # m/s^2: | |a| - g_ref | tolerance for the weak correction
    normalize_gravity: bool = False # rescale accel so the measured rest |g| equals 9.80665 (only right if the excess is scale, not offset)
    accel_cal: object = None        # dict(offset, scale) from calibrate_accel.py
    noise_from: object = None       # RawCapture of a static capture (test A) to take the noise from
    start_phase: str = "up"         # 'up' | 'down': first phase of a rep (stack: up, squat/bench: down)
    min_rom_m: float = 0.08
    units_per_rep: int | None = None
    tilt_error_deg: float = 0.0     # sensitivity studies only: inject a constant tilt error


@dataclass
class Result:
    cfg: PipelineConfig
    t: np.ndarray
    fs: float
    q: np.ndarray
    lin: np.ndarray
    stat: np.ndarray
    v: np.ndarray
    p: np.ndarray
    reps: list
    g_ref: float
    gyro_bias: np.ndarray
    bias_source: str
    axis: np.ndarray | None = None
    notes: list = field(default_factory=list)
    rest: object = None          # slice of the stationary window used for the initial pose
    acc: object = None           # accel actually used (despiked, calibrated, normalised)
    gyro: object = None
    q0: object = None
    n_spikes: int = 0


def reconstruct(cap: rawio.RawCapture, cfg: PipelineConfig | None = None) -> Result:
    cfg = cfg or PipelineConfig()
    notes = []
    rep_ok = rawio.validate(cap)
    if (not rep_ok["monotonic"]) or rep_ok["n_gaps"]:
        cap = rawio.resample_uniform(cap)
        notes.append("resampled to a uniform grid (gaps / non-monotonic t_s)")
    fs = cap.fs
    t = cap.t - cap.t[0]
    acc, gyro = np.array(cap.acc, float), np.array(cap.gyro, float)
    n_spikes = 0
    if cfg.despike:
        acc, n1 = zupt.hampel(acc, 7, 5.0, 1.0)
        gyro, n2 = zupt.hampel(gyro, 7, 5.0, 20.0)
        n_spikes = n1 + n2
        if n_spikes:
            notes.append(f"despiked {n_spikes} outlier samples (Hampel)")
    hdr_g = cap.gravity_ms2
    if cfg.accel_cal is not None:
        acc = (acc - np.asarray(cfg.accel_cal["offset"])) / np.asarray(cfg.accel_cal["scale"])
        if hdr_g is not None:
            hdr_g = (hdr_g - np.asarray(cfg.accel_cal["offset"])) / np.asarray(cfg.accel_cal["scale"])
        notes.append("accel offset/scale calibration applied")

    # --- stationary detection (thresholds from the quietest windows anywhere, or from a static capture) ---
    sp = cfg.stationary
    if cfg.auto_thresholds:
        nc = cfg.noise_from
        src_acc, src_gyro, src_fs = (nc.acc, nc.gyro, nc.fs) if nc is not None else (acc, gyro, fs)
        sp = zupt.quiet_window_thresholds(src_acc, src_gyro, src_fs, sp, scale=cfg.stationary_scale)
        notes.append("stationary thresholds from " + ("static capture" if nc is not None else "quietest windows of this capture")
                     + f" (acc|a| {sp.acc_std_lo:.3f}, acc vec {sp.acc_vec_lo:.3f} m/s^2, gyro {sp.gyro_std_lo:.2f} deg/s)")
    skip = int(sp.skip_s * fs)
    g_pre = float(np.linalg.norm(hdr_g)) if hdr_g is not None else float(np.median(np.linalg.norm(acc[skip:skip + int(fs)], axis=1)))
    stat = zupt.detect_stationary(acc, gyro, fs, g_pre, sp)

    # --- initial rest: first stationary run >= 0.3 s (not necessarily the first second) ---
    rest = None
    for s0, e0, val in zupt._runs(stat):
        if val and (e0 - max(s0, skip)) >= 0.3 * fs:
            s0 = max(s0, skip)
            rest = slice(s0, min(e0, s0 + int(2 * fs)))
            break
    if rest is not None:
        g_sensor = np.median(acc[rest], axis=0)
        if rest.start > 1.0 * fs:
            notes.append(f"WARNING: first 1 s is not stationary (first rest at {rest.start / fs:.1f} s; protocol: stay still >= 1 s after START)")
        elif (rest.stop - rest.start) < 0.5 * fs:
            notes.append(f"WARNING: initial rest is short ({(rest.stop - rest.start) / fs:.2f} s; protocol: >= 1 s)")
    elif hdr_g is not None:
        g_sensor = hdr_g
        notes.append("WARNING: first 1 s is not stationary and no stationary window found (protocol: stay still >= 1 s after START): using header gravity for the initial pose")
    else:
        g_sensor = np.median(acc[: int(fs)], axis=0)
        notes.append("WARNING: first 1 s is not stationary, no stationary window and no header gravity: initial pose is a guess")
    g_ref = float(np.linalg.norm(g_sensor))
    if cfg.normalize_gravity and g_ref > 1e-6:
        k = fusion.G0 / g_ref
        if abs(k - 1) > 0.002:
            notes.append(f"accel rescaled by {k:.4f} so rest |g| = 9.80665 (measured {g_ref:.3f})")
        acc = acc * k
        g_sensor = g_sensor * k
        g_ref = fusion.G0
    q0 = fusion.q_init_from_gravity(g_sensor)

    bias, bsrc = fusion.resolve_gyro_bias(gyro, fs, cap.gyro_bias_dps, cfg.bias, rest)
    if cfg.fusion_mode == "mahony":
        w = np.radians(gyro - bias)
        q = fusion.mahony(acc, w, fs, q0, kp=cfg.kp, g_ref=g_ref, gate_tol=cfg.gate_tol,
                          trust=stat if cfg.gate_stationary else None, kp_weak=cfg.kp_weak, weak_tol=cfg.weak_tol)
    elif cfg.fusion_mode == "static":
        q = np.tile(q0, (len(acc), 1))
    else:
        raise ValueError(cfg.fusion_mode)
    if cfg.tilt_error_deg:
        qe = fusion.q_from_axis_angle([1.0, 0, 0], np.radians(cfg.tilt_error_deg))
        q = fusion.q_mul(qe, q)

    lin = fusion.linear_acceleration_world(acc, q, g_ref)
    if cfg.rest_offset and rest is not None:
        lin = lin - lin[rest].mean(axis=0)

    if cfg.reject_false_zupt:
        stat = zupt.reject_implausible_zupt(lin, stat, fs)
    axis = None
    if cfg.pca:
        axis = zupt.principal_axis(lin, stat)
        lin = zupt.project_on_axis(lin, axis)

    v, p, extra = zupt.integrate(lin, stat, fs, cfg.zupt_mode)
    units = zupt.moving_units(stat)
    idx = zupt.group_units_into_reps(units, p, cfg.units_per_rep, cfg.min_rom_m)
    reps = zupt.build_reps(t, v, p, stat, idx, cfg.loop_closure)
    if not reps:
        notes.append("no reps found (no stationary-delimited motion above min ROM)")
    return Result(cfg, t, fs, q, lin, stat, v, p, reps, g_ref, bias, bsrc, axis, notes, rest, acc, gyro, q0, n_spikes)
