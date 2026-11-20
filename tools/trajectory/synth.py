"""Synthetic ground-truth motion + BMI160-like (and BMI270-like) IMU error model.

Writes raw CSV v1.  Parameter sets are explicit below; entries marked
ASSUMPTION are NOT from the datasheets/brief and should be replaced by
measured values (Step 0 experiments A) when available.
"""
from __future__ import annotations

import argparse
import math
from dataclasses import dataclass, field, replace

import numpy as np

import fusion
import rawio

G0 = fusion.G0


# ------------------------------------------------------------ error model
@dataclass(frozen=True)
class ErrorModel:
    name: str
    accel_noise_ug_rthz: float      # accel noise density, ug/sqrt(Hz)
    gyro_noise_dps_rthz: float      # gyro noise density, deg/s/sqrt(Hz)
    accel_tco_mg_k: float           # accel offset temperature coefficient, +/- mg/K
    gyro_offset_dps: float          # zero-rate offset before compensation, +/- deg/s
    gyro_tco_dps_k: float           # gyro offset temperature coefficient, +/- deg/s/K
    accel_offset_mg: float = 20.0   # ASSUMPTION: initial accel offset (removed by rest calibration)
    scale_err: float = 0.005        # ASSUMPTION from brief: ~0.5 % per-axis scale error, accel and gyro
    delta_t_k: float = 5.0          # ASSUMPTION: temperature rise between rest calibration and end of capture
    noise_bw_factor: float = 0.5    # ASSUMPTION: noise bandwidth = factor * fs (0.5 = Nyquist, no digital LPF)
    # extra (sensitivity-study) residuals applied on top, per axis uniform +/- value
    gyro_bias_residual_dps: float = 0.0
    accel_bias_residual_mg: float = 0.0


# Datasheet numbers given in the brief (BMI160 datasheet). Gyro noise for the BMI270 is assumed equal
# to the BMI160 ("about the same" per the architect's research notes) -> ASSUMPTION.
BMI160_LIKE = ErrorModel("BMI160-like", 180.0, 0.007, 1.0, 3.0, 0.05)
BMI270_LIKE = ErrorModel("BMI270-like", 160.0, 0.007, 0.25, 0.5, 0.02)
MODELS = {"bmi160": BMI160_LIKE, "bmi270": BMI270_LIKE}


# --------------------------------------------------------------- scenarios
@dataclass(frozen=True)
class Scenario:
    kind: str = "vertical"          # vertical | table_square | static | rotation
    rom_m: float = 0.40
    t_up_s: float = 1.5
    t_down_s: float = 1.5
    hold_top_s: float = 1.0         # pause at the top (0 -> continuous)
    hold_bottom_s: float = 1.0
    n_reps: int = 4
    profile: str = "minjerk"        # minjerk | sine
    lateral_arc_m: float = 0.0      # sideways bulge during the rep (x)
    tilt_deg: float = 0.0           # sensor tilts by this much mid-rep (about body y)
    lead_rest_s: float = 3.0
    tail_rest_s: float = 2.0
    side_m: float = 0.30            # table_square side
    side_s: float = 1.5
    rotation_deg: float = 90.0      # rotation test
    rotation_axis: tuple = (1.0, 0.0, 0.0)
    mount_rpy_deg: tuple = (12.0, -8.0, 30.0)   # arbitrary sensor mounting vs world
    exercise: str = "synthetic"


def _minjerk(tau):
    tau = np.clip(tau, 0, 1)
    return 10 * tau ** 3 - 15 * tau ** 4 + 6 * tau ** 5


def _sine(tau):
    tau = np.clip(tau, 0, 1)
    return 0.5 * (1 - np.cos(np.pi * tau))


def _progress(scn, t, t0, dur):
    f = _minjerk if scn.profile == "minjerk" else _sine
    return f((t - t0) / dur)


def _mount_quat(rpy_deg):
    r, p, y = (math.radians(a) for a in rpy_deg)
    qz = fusion.q_from_axis_angle([0, 0, 1], y)
    qy = fusion.q_from_axis_angle([0, 1, 0], p)
    qx = fusion.q_from_axis_angle([1, 0, 0], r)
    return fusion.q_mul(qz, fusion.q_mul(qy, qx))


def make_truth(scn: Scenario, fs_hi: float):
    """High-rate ground truth: t, p_world, q (sensor->world), omega_body (rad/s), rep windows."""
    fs_hi = float(fs_hi)
    windows = []
    if scn.kind == "vertical":
        cyc = scn.t_up_s + scn.hold_top_s + scn.t_down_s + scn.hold_bottom_s
        total = scn.lead_rest_s + scn.n_reps * cyc + scn.tail_rest_s
    elif scn.kind == "table_square":
        cyc = 4 * (scn.side_s + 0.8)
        total = scn.lead_rest_s + scn.n_reps * cyc + scn.tail_rest_s
    elif scn.kind == "rotation":
        cyc = 2 * 4.0 + 2 * 1.0
        total = scn.lead_rest_s + scn.n_reps * cyc + scn.tail_rest_s
    else:
        cyc, total = 0.0, scn.lead_rest_s + 40.0
    t = np.arange(0, total, 1.0 / fs_hi)
    p = np.zeros((len(t), 3))
    theta = np.zeros(len(t))
    axis = np.array([0.0, 1.0, 0.0])
    q0 = _mount_quat(scn.mount_rpy_deg)

    if scn.kind == "vertical":
        for r in range(scn.n_reps):
            a = scn.lead_rest_s + r * cyc
            up = _progress(scn, t, a, scn.t_up_s)
            dn = _progress(scn, t, a + scn.t_up_s + scn.hold_top_s, scn.t_down_s)
            s = up - dn                    # 0 -> 1 -> 0 (segments never overlap)
            p[:, 2] += scn.rom_m * s
            p[:, 0] += scn.lateral_arc_m * np.sin(np.pi * s)
            theta += np.radians(scn.tilt_deg) * np.sin(np.pi * s)
            windows.append((a, a + scn.t_up_s + scn.hold_top_s + scn.t_down_s))
    elif scn.kind == "table_square":
        corners = np.array([[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]], float) * scn.side_m
        q0 = _mount_quat((0.0, 0.0, scn.mount_rpy_deg[2]))   # lying flat on the table
        for r in range(scn.n_reps):
            windows.append((scn.lead_rest_s + r * cyc, scn.lead_rest_s + (r + 1) * cyc - 0.8))
        # build position as sum over all sides of s_k * d_k (each s_k saturates at 1)
        for r in range(scn.n_reps):
            a = scn.lead_rest_s + r * cyc
            for k in range(4):
                s = _progress(scn, t, a + k * (scn.side_s + 0.8), scn.side_s)
                d = corners[k + 1] - corners[k]
                p[:, :2] += s[:, None] * d[None, :]
    elif scn.kind == "rotation":
        for r in range(scn.n_reps):
            a = scn.lead_rest_s + r * cyc
            s = _progress(scn, t, a, 4.0) - _progress(scn, t, a + 5.0, 4.0)
            theta += np.radians(scn.rotation_deg) * s
            windows.append((a, a + 9.0))
        axis = np.asarray(scn.rotation_axis, float)
    elif scn.kind != "static":
        raise ValueError(scn.kind)

    q = fusion.q_mul(q0, fusion.q_from_axis_angle(axis, theta))
    omega_body = np.outer(np.gradient(theta, 1.0 / fs_hi), axis / np.linalg.norm(axis))
    return dict(t=t, p=p, q=q, omega=omega_body, windows=windows, scenario=scn, q0=q0, axis=axis)


# -------------------------------------------------------------- measurement
def _quantise(x, full_scale):
    lsb = full_scale / 32768.0
    return np.clip(np.round(x / lsb) * lsb, -full_scale, full_scale - lsb)


def simulate(scn: Scenario, model: ErrorModel = BMI160_LIKE, fs: float = 200.0, seed: int = 0,
             accel_range_g: float = 8.0, gyro_range_dps: float = 1000.0, known_rom=True):
    """Return (RawCapture, truth dict). Truth is decimated to the sample rate."""
    rng = np.random.default_rng(seed)
    fs_hi = fs * max(1, int(round(2000.0 / fs)))
    k = int(round(fs_hi / fs))
    tr = make_truth(scn, fs_hi)
    dt_hi = 1.0 / fs_hi
    a_w = np.gradient(np.gradient(tr["p"], dt_hi, axis=0), dt_hi, axis=0)
    f_s = fusion.q_rotate(fusion.q_conj(tr["q"]), a_w + np.array([0, 0, G0]))
    w_dps = np.degrees(tr["omega"])
    sl = slice(0, None, k)
    t = tr["t"][sl]
    f_s, w_dps = f_s[sl], w_dps[sl]
    n = len(t)

    # --- error model ---
    sig_a = model.accel_noise_ug_rthz * 1e-6 * G0 * math.sqrt(model.noise_bw_factor * fs)
    sig_g = model.gyro_noise_dps_rthz * math.sqrt(model.noise_bw_factor * fs)
    sa = rng.uniform(-model.scale_err, model.scale_err, 3)
    sg = rng.uniform(-model.scale_err, model.scale_err, 3)
    ba0 = rng.uniform(-1, 1, 3) * model.accel_offset_mg * 1e-3 * G0
    bg0 = rng.uniform(-1, 1, 3) * model.gyro_offset_dps
    tco_a = rng.uniform(-1, 1, 3) * model.accel_tco_mg_k * 1e-3 * G0     # m/s^2 per K
    tco_g = rng.uniform(-1, 1, 3) * model.gyro_tco_dps_k                  # deg/s per K
    res_g = rng.uniform(-1, 1, 3) * model.gyro_bias_residual_dps
    res_a = rng.uniform(-1, 1, 3) * model.accel_bias_residual_mg * 1e-3 * G0
    dT = model.delta_t_k * (t / t[-1])[:, None]                           # linear warm-up ramp
    acc = f_s * (1 + sa) + ba0 + tco_a * dT + res_a + rng.normal(0, sig_a, (n, 3))
    gyr = w_dps * (1 + sg) + bg0 + tco_g * dT + res_g + rng.normal(0, sig_g, (n, 3))
    acc = _quantise(acc, accel_range_g * G0)
    gyr = _quantise(gyr, gyro_range_dps)

    # --- header calibration: 5 s rest at the start pose, dT = 0 ---
    n_cal = int(5 * fs)
    f0 = fusion.q_rotate(fusion.q_conj(tr["q0"]), np.array([0, 0, G0]))
    cal_a = f0 * (1 + sa) + ba0 + rng.normal(0, sig_a, (n_cal, 3))
    cal_g = bg0 + rng.normal(0, sig_g, (n_cal, 3))
    gravity_hdr = _quantise(cal_a, accel_range_g * G0).mean(axis=0)
    bias_hdr = _quantise(cal_g, gyro_range_dps).mean(axis=0)

    meta = {
        "format": "liftiq-raw v1", "fw_version": "synthetic", "device_name": f"synth-{model.name}",
        "app_version": "synthetic", "captured_at": "synthetic", "sample_rate_hz": f"{fs:g}",
        "accel_range_g": f"{accel_range_g:g}", "gyro_range_dps": f"{gyro_range_dps:g}",
        "accel_units": "m/s^2", "gyro_units": "deg/s",
        "gyro_bias_dps": ";".join(f"{v:.5f}" for v in bias_hdr),
        "gravity_ms2": ";".join(f"{v:.5f}" for v in gravity_hdr),
        "rep_count_firmware": "0", "dropped_chunks": "0", "exercise": scn.exercise,
        "load_kg": "0", "notes": f"synthetic seed={seed} model={model.name}",
    }
    if known_rom and scn.kind == "vertical":
        meta["known_rom_cm"] = f"{scn.rom_m * 100:g}"
    cap = rawio.RawCapture(t=t, acc=acc, gyro=gyr, meta=meta)
    truth = dict(t=t, p=tr["p"][sl], q=tr["q"][sl], windows=tr["windows"], scenario=scn, a_world=a_w[sl],
                 omega_dps=w_dps)
    return cap, truth


# --------------------------------------------------------------- evaluation
def match_reps(result, truth, concentric_rom_m=None):
    """Match reconstructed reps to truth windows by time overlap.

    Returns list of dicts: rep (1-based truth index), found, rom_err_cm, horiz_err_cm.
    Unmatched truth reps have found=False.
    """
    scn = truth["scenario"]
    out = []
    tt, p = truth["t"], truth["p"]
    for j, (a, b) in enumerate(truth["windows"]):
        m = (tt >= a) & (tt <= b)
        rom_true = float(p[m, 2].max() - p[m, 2].min())
        hx_true = float(np.max(np.linalg.norm(p[m, :2] - p[m, :2][0], axis=1)))
        best, best_ov = None, 0.0
        for rep in result.reps:
            ov = min(b, rep.t[-1]) - max(a, rep.t[0])
            if ov > best_ov:
                best, best_ov = rep, ov
        row = dict(rep=j + 1, found=False, rom_true_cm=rom_true * 100, hx_true_cm=hx_true * 100)
        if best is not None and best_ov > 0.5 * (b - a):
            z = best.p[:, 2]
            row.update(found=True, rom_est_cm=float((z.max() - z.min()) * 100),
                       hx_est_cm=float(np.max(np.linalg.norm(best.p[:, :2] - best.p[0, :2], axis=1)) * 100))
            row["rom_err_cm"] = row["rom_est_cm"] - row["rom_true_cm"]
            row["hx_err_cm"] = row["hx_est_cm"] - row["hx_true_cm"]
        out.append(row)
    return out


# ----------------------------------------------------------------- CLI
def main(argv=None):
    ap = argparse.ArgumentParser(description="Write a synthetic raw CSV v1 capture")
    ap.add_argument("out")
    ap.add_argument("--kind", default="vertical", choices=["vertical", "table_square", "static", "rotation"])
    ap.add_argument("--model", default="bmi160", choices=list(MODELS))
    ap.add_argument("--rom-cm", type=float, default=40.0)
    ap.add_argument("--reps", type=int, default=4)
    ap.add_argument("--t-up", type=float, default=1.5)
    ap.add_argument("--t-down", type=float, default=1.5)
    ap.add_argument("--hold", type=float, default=1.0, help="pause at top and bottom (s), 0 = continuous")
    ap.add_argument("--arc-cm", type=float, default=0.0)
    ap.add_argument("--tilt-deg", type=float, default=0.0)
    ap.add_argument("--fs", type=float, default=200.0)
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args(argv)
    scn = Scenario(kind=a.kind, rom_m=a.rom_cm / 100, n_reps=a.reps, t_up_s=a.t_up, t_down_s=a.t_down,
                   hold_top_s=a.hold, hold_bottom_s=a.hold, lateral_arc_m=a.arc_cm / 100, tilt_deg=a.tilt_deg)
    cap, _ = simulate(scn, MODELS[a.model], a.fs, a.seed)
    rawio.save_raw(a.out, cap)
    print(f"wrote {a.out}: {len(cap)} samples, {cap.t[-1]:.1f} s")


if __name__ == "__main__":
    main()
