"""Live acceleration / velocity / position dashboard for LiftIQ.

Pipeline, all in the sensor's own body frame until the last step:

    raw -> moving average (SMOOTH_SAMPLES) -> subtract accel bias
        -> per-axis hysteresis gate -> "filtered acceleration"

Calibration (device held still) measures the actual raw accel reading at
that pose -- NOT an idealized [0, 0, 1g] -- and uses it as accel_bias:
subtracted directly, per axis, from every later smoothed reading. Held
still at the calibration pose, filtered acceleration reads ~[0, 0, 0]g
on all three axes, regardless of how the device happens to be mounted
(it doesn't need to be perfectly level).

The per-axis hysteresis gate then kills residual sensor noise: each axis
must exceed ACCEL_GATE_HIGH_G before it's allowed through at all, and has
to drop back below ACCEL_GATE_LOW_G before it's gated off again (a
Schmitt trigger, same idea as rep_counter.py's threshold).

Both the "Acceleration" panel and the velocity/position integration use
this same filtered signal, rotated into world frame with the same
Madgwick orientation fusion as imu_cube_view.py (Madgwick itself still
gets the raw, un-filtered accel -- it needs the real gravity vector to
sense orientation; feeding it the bias-removed signal would erase the
one reference it depends on). A separate "Raw acceleration" panel shows
the unfiltered signal for comparison.

The hysteresis gate above only stops NEW noise from being added to
velocity -- it does nothing to correct velocity that's already wrong.
Zero acceleration is consistent with being at rest AND with coasting at
a constant nonzero velocity (Newton's first law); you cannot tell those
apart from a single instant of accel data. So this also runs a proper
zero-velocity update (ZUPT): a sliding window (ZUPT_WINDOW_SAMPLES) of
recent bias-corrected accel deviation AND gyro magnitude. Only once BOTH
stay below their thresholds for the WHOLE window -- sustained calm, not
a momentary zero-crossing mid-motion -- does it declare the device
stationary and hard-reset velocity to exactly zero. This is what
actually bounds drift: any leftover velocity error from a rep that
didn't integrate to net-zero gets corrected the next time the device
is genuinely still, instead of being frozen in place forever.

Velocity and position still have no true displacement ground truth, so
this remains an estimate: whatever drift accumulates DURING a motion
burst (between ZUPT resets) is real error that this doesn't fix -- ZUPT
only bounds drift to within one rep, it doesn't eliminate it within one.

Configure below, then run:

    python accel_plot.py

While running, click the plot window and press 'r' to re-zero: redoes
the IMU bias calibration (gyro + accel), resets orientation to identity,
and zeros velocity, position, and the hysteresis gate state.
"""

import time
from collections import deque

import numpy as np
import matplotlib.pyplot as plt
from matplotlib.animation import FuncAnimation
from mpl_toolkits.mplot3d import Axes3D  # noqa: F401 (registers 3D projection)
from ahrs.filters import Madgwick

from liftiq_orientation import DEG_TO_RAD, G_TO_MS2, quaternion_to_matrix
from liftiq_serial import calibrate_imu_bias, log_sample, open_stream, read_sample, start_csv_log

PORT = "COM5"
BAUD = 115200
WINDOW_SECONDS = 10.0      # seconds of history shown on the scrolling 2D/3D plots
SMOOTH_SAMPLES = 10        # moving-average window, in samples; 1 disables smoothing
CALIBRATION_SAMPLES = 100  # samples averaged for gyro + accel bias at rest
LOG_TO_CSV = True          # write raw samples to tools/recordings/accel_plot_NNN.csv

# Per-axis hysteresis gate on bias-corrected body-frame acceleration, in g,
# before it's allowed through to the "filtered" plot or the integrator.
# Start near the BMI160's noise floor (roughly 0.002-0.01g after the
# SMOOTH_SAMPLES averaging) and widen HIGH if standing-still still drifts,
# or narrow both if real reps get gated out.
ACCEL_GATE_HIGH_G = 0.015
ACCEL_GATE_LOW_G = 0.005

# Zero-velocity update: device is declared "stationary" (velocity hard-reset
# to 0) only once bias-corrected accel deviation AND gyro magnitude have both
# stayed below their thresholds for this many consecutive samples -- a
# sustained calm window, not a single zero-crossing mid-motion. Widen the
# window or tighten the thresholds if it's firing during real motion;
# shrink/loosen if it's slow to catch genuine stops.
ZUPT_WINDOW_SAMPLES = 20
ZUPT_ACCEL_THRESHOLD_G = 0.02
ZUPT_GYRO_THRESHOLD_DPS = 5.0

MAX_SAMPLES = 5000


def rezero(ser):
    gyro_bias, accel_bias_g = calibrate_imu_bias(ser, CALIBRATION_SAMPLES)
    q = np.array([1.0, 0.0, 0.0, 0.0])
    print("Re-zeroed — orientation, velocity, and position reset.")
    return gyro_bias, accel_bias_g, q


def main():
    ser = open_stream(PORT, BAUD)
    gyro_bias, accel_bias_g, q = rezero(ser)
    madgwick = Madgwick()

    log_file, log_writer = start_csv_log("accel_plot") if LOG_TO_CSV else (None, None)

    raw_window = deque(maxlen=max(SMOOTH_SAMPLES, 1))
    vx = vy = vz = 0.0
    px = py = pz = 0.0
    last_time = time.time()
    gate_armed = {axis: False for axis in "xyz"}  # per-axis hysteresis state
    zupt_accel_window = deque(maxlen=ZUPT_WINDOW_SAMPLES)
    zupt_gyro_window = deque(maxlen=ZUPT_WINDOW_SAMPLES)
    zupt_reset_count = 0

    t_data = deque(maxlen=MAX_SAMPLES)
    raw_axes = {k: deque(maxlen=MAX_SAMPLES) for k in "xyz"}
    raw_mag = deque(maxlen=MAX_SAMPLES)
    a_axes = {k: deque(maxlen=MAX_SAMPLES) for k in "xyz"}
    a_mag = deque(maxlen=MAX_SAMPLES)
    v_axes = {k: deque(maxlen=MAX_SAMPLES) for k in "xyz"}
    v_mag = deque(maxlen=MAX_SAMPLES)
    p_axes = {k: deque(maxlen=MAX_SAMPLES) for k in "xyz"}
    p_mag = deque(maxlen=MAX_SAMPLES)

    fig = plt.figure(figsize=(14, 11))
    gs = fig.add_gridspec(4, 3)

    shared_x = None  # first-created 2D axes; every other 2D axes shares its time (x) axis

    def make_row(row, title, ylabel):
        nonlocal shared_x
        ax_axes = fig.add_subplot(gs[row, 0], sharex=shared_x)
        if shared_x is None:
            shared_x = ax_axes
        ax_mag = fig.add_subplot(gs[row, 1], sharex=shared_x)
        lines_axes = {k: ax_axes.plot([], [], label=k)[0] for k in "xyz"}
        line_mag, = ax_mag.plot([], [], color="tab:red", label="magnitude")
        ax_axes.set_title(f"{title} — per axis")
        ax_axes.set_ylabel(ylabel)
        ax_axes.legend(loc="upper right")
        ax_axes.grid(True, alpha=0.3)
        ax_mag.set_title(f"{title} — magnitude")
        ax_mag.set_ylabel(ylabel)
        ax_mag.legend(loc="upper right")
        ax_mag.grid(True, alpha=0.3)
        return ax_axes, ax_mag, lines_axes, line_mag

    ax_raw_axes, ax_raw_mag, lines_raw_axes, line_raw_mag = make_row(0, "Raw acceleration", "g")
    ax_accel_axes, ax_accel_mag, lines_a_axes, line_a_mag = make_row(1, "Filtered acceleration", "g")
    ax_vel_axes, ax_vel_mag, lines_v_axes, line_v_mag = make_row(2, "Velocity", "m/s")
    ax_pos_axes, ax_pos_mag, lines_p_axes, line_p_mag = make_row(3, "Position", "m")
    ax_pos_axes.set_xlabel("Time (s)")
    ax_pos_mag.set_xlabel("Time (s)")

    ax_3d = fig.add_subplot(gs[:, 2], projection="3d")
    ax_3d.set_title("Position estimate (world frame)")
    ax_3d.set_xlabel("X (m)")
    ax_3d.set_ylabel("Y (m)")
    ax_3d.set_zlabel("Z (m)")
    trail_3d, = ax_3d.plot([], [], [], color="tab:blue", linewidth=1)
    point_3d, = ax_3d.plot([], [], [], color="tab:red", marker="o")
    zupt_text = ax_3d.text2D(0.02, 0.98, "", transform=ax_3d.transAxes, va="top", fontsize=9)

    all_2d_axes = [
        ax_raw_axes, ax_raw_mag, ax_accel_axes, ax_accel_mag,
        ax_vel_axes, ax_vel_mag, ax_pos_axes, ax_pos_mag,
    ]
    all_lines = (
        list(lines_raw_axes.values()) + [line_raw_mag]
        + list(lines_a_axes.values()) + [line_a_mag]
        + list(lines_v_axes.values()) + [line_v_mag]
        + list(lines_p_axes.values()) + [line_p_mag]
        + [trail_3d, point_3d, zupt_text]
    )

    start_time = time.time()

    def on_key(event):
        nonlocal gyro_bias, accel_bias_g, q, vx, vy, vz, px, py, pz, last_time, start_time, \
            log_file, log_writer, zupt_reset_count
        if event.key != "r":
            return
        gyro_bias, accel_bias_g, q = rezero(ser)
        vx = vy = vz = 0.0
        px = py = pz = 0.0
        last_time = time.time()
        start_time = time.time()
        raw_window.clear()
        for axis in gate_armed:
            gate_armed[axis] = False
        zupt_accel_window.clear()
        zupt_gyro_window.clear()
        zupt_reset_count = 0
        for d in (
            t_data, raw_mag, a_mag, v_mag, p_mag,
            *raw_axes.values(), *a_axes.values(), *v_axes.values(), *p_axes.values(),
        ):
            d.clear()
        if LOG_TO_CSV:
            log_file.close()
            log_file, log_writer = start_csv_log("accel_plot")

    fig.canvas.mpl_connect("key_press_event", on_key)

    def update(_frame):
        nonlocal vx, vy, vz, px, py, pz, last_time, q, zupt_reset_count
        stationary = False

        while ser.in_waiting:
            sample = read_sample(ser)
            if sample is None:
                continue
            sax, say, saz, sgx, sgy, sgz = sample
            raw_window.append((sax, say, saz))
            n = len(raw_window)
            smoothed = np.array([
                sum(s[0] for s in raw_window) / n,
                sum(s[1] for s in raw_window) / n,
                sum(s[2] for s in raw_window) / n,
            ])

            now_wall = time.time()
            dt = now_wall - last_time
            last_time = now_wall
            now = now_wall - start_time

            if log_writer:
                log_sample(log_writer, now, sample)

            # Bias-correct in body frame, then gate each axis independently.
            unbiased = smoothed - accel_bias_g
            filtered = np.zeros(3)
            for i, axis in enumerate("xyz"):
                value = unbiased[i]
                if gate_armed[axis]:
                    if abs(value) < ACCEL_GATE_LOW_G:
                        gate_armed[axis] = False
                elif abs(value) > ACCEL_GATE_HIGH_G:
                    gate_armed[axis] = True
                filtered[i] = value if gate_armed[axis] else 0.0

            # Madgwick needs the real (un-filtered) reading to sense gravity.
            gx, gy, gz = np.array([sgx, sgy, sgz]) - gyro_bias
            acc_for_orientation = smoothed * G_TO_MS2
            gyr = np.array([gx, gy, gz]) * DEG_TO_RAD
            q = madgwick.updateIMU(q, gyr=gyr, acc=acc_for_orientation, dt=dt)

            r = quaternion_to_matrix(q)
            acc_world = r @ (filtered * G_TO_MS2)

            # ZUPT: only a sustained calm window (not a single zero-crossing)
            # counts as "stationary" and hard-resets velocity. Zero
            # acceleration alone can't distinguish at-rest from coasting at
            # constant velocity -- this is what actually corrects that,
            # rather than just gating noise out of the integrator.
            zupt_accel_window.append(float(np.linalg.norm(unbiased)))
            zupt_gyro_window.append(float(np.linalg.norm([gx, gy, gz])))
            stationary = (
                len(zupt_accel_window) == ZUPT_WINDOW_SAMPLES
                and max(zupt_accel_window) < ZUPT_ACCEL_THRESHOLD_G
                and max(zupt_gyro_window) < ZUPT_GYRO_THRESHOLD_DPS
            )

            if stationary:
                if vx != 0.0 or vy != 0.0 or vz != 0.0:
                    zupt_reset_count += 1
                vx = vy = vz = 0.0
            else:
                vx += acc_world[0] * dt
                vy += acc_world[1] * dt
                vz += acc_world[2] * dt
            px += vx * dt
            py += vy * dt
            pz += vz * dt

            t_data.append(now)
            raw_axes["x"].append(smoothed[0])
            raw_axes["y"].append(smoothed[1])
            raw_axes["z"].append(smoothed[2])
            raw_mag.append(float(np.linalg.norm(smoothed)))
            a_axes["x"].append(filtered[0])
            a_axes["y"].append(filtered[1])
            a_axes["z"].append(filtered[2])
            a_mag.append(float(np.linalg.norm(filtered)))
            v_axes["x"].append(vx)
            v_axes["y"].append(vy)
            v_axes["z"].append(vz)
            v_mag.append((vx ** 2 + vy ** 2 + vz ** 2) ** 0.5)
            p_axes["x"].append(px)
            p_axes["y"].append(py)
            p_axes["z"].append(pz)
            p_mag.append((px ** 2 + py ** 2 + pz ** 2) ** 0.5)

        if not t_data:
            return all_lines

        cutoff = t_data[-1] - WINDOW_SECONDS
        while t_data and t_data[0] < cutoff:
            t_data.popleft()
            for d in (
                *raw_axes.values(), raw_mag, *a_axes.values(), a_mag,
                *v_axes.values(), v_mag, *p_axes.values(), p_mag,
            ):
                d.popleft()

        for k in "xyz":
            lines_raw_axes[k].set_data(t_data, raw_axes[k])
            lines_a_axes[k].set_data(t_data, a_axes[k])
            lines_v_axes[k].set_data(t_data, v_axes[k])
            lines_p_axes[k].set_data(t_data, p_axes[k])
        line_raw_mag.set_data(t_data, raw_mag)
        line_a_mag.set_data(t_data, a_mag)
        line_v_mag.set_data(t_data, v_mag)
        line_p_mag.set_data(t_data, p_mag)

        for ax in all_2d_axes:
            ax.set_xlim(t_data[-1] - WINDOW_SECONDS, t_data[-1])
            ax.relim()
            ax.autoscale_view(scalex=False)

        trail_3d.set_data_3d(p_axes["x"], p_axes["y"], p_axes["z"])
        point_3d.set_data_3d([px], [py], [pz])
        zupt_text.set_text(
            f"{'STATIONARY (v held at 0)' if stationary else 'moving'}\n"
            f"ZUPT resets: {zupt_reset_count}"
        )

        span = max(
            max(p_axes["x"], default=0) - min(p_axes["x"], default=0),
            max(p_axes["y"], default=0) - min(p_axes["y"], default=0),
            max(p_axes["z"], default=0) - min(p_axes["z"], default=0),
            0.05,
        )
        half = span / 2 + 0.02
        ax_3d.set_xlim(px - half, px + half)
        ax_3d.set_ylim(py - half, py + half)
        ax_3d.set_zlim(pz - half, pz + half)

        return all_lines

    _ani = FuncAnimation(fig, update, interval=100, blit=False)
    plt.tight_layout()
    plt.show()


if __name__ == "__main__":
    main()
