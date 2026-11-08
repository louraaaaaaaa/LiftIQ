"""Live 3D cube view of LiftIQ's IMU orientation.

Reads the "ax,ay,az,gx,gy,gz" CSV stream printed by firmware/archive/
serial-imu-bringup/LiftIQ_Serial/LiftIQ_Serial.ino,
fuses it into an orientation quaternion with a Madgwick filter (IMU-only, no
magnetometer), and renders a rotating cube that mirrors the device.

Usage:
    python imu_cube_view.py --port COM5

While running, click the cube view window and press 'r' to re-zero: it
redoes the gyro bias calibration and treats the device's current pose as
the new reference orientation (everything after is shown relative to it).
"""

import argparse
import time

import numpy as np
from ahrs.filters import Madgwick
from vpython import box, canvas, color, rate, vector

from liftiq_orientation import (
    DEG_TO_RAD,
    G_TO_MS2,
    quaternion_conjugate,
    quaternion_multiply,
    quaternion_to_matrix,
)
from liftiq_serial import calibrate_gyro_bias, log_sample, open_stream, read_sample, start_csv_log

GYRO_CALIBRATION_SAMPLES = 100


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", required=True, help="Serial port, e.g. COM5")
    parser.add_argument("--baud", type=int, default=115200)
    parser.add_argument(
        "--log", action=argparse.BooleanOptionalAction, default=True,
        help="Log raw samples to tools/recordings/cube_view_NNN.csv (default: on)",
    )
    args = parser.parse_args()

    ser = open_stream(args.port, args.baud)

    gyro_bias = calibrate_gyro_bias(ser, GYRO_CALIBRATION_SAMPLES)
    log_file, log_writer = start_csv_log("cube_view") if args.log else (None, None)
    start_time = time.time()

    scene = canvas(title="LiftIQ — device orientation", width=800, height=600)
    scene.append_to_caption(
        "\nClick this window and press 'r' to re-zero: re-calibrates gyro "
        "bias and sets the device's current pose as the new reference.\n"
    )
    cube = box(length=2, height=0.3, width=1, color=color.orange)

    recalibrate_requested = False

    def on_keydown(evt):
        nonlocal recalibrate_requested
        if evt.key == "r":
            recalibrate_requested = True

    scene.bind("keydown", on_keydown)

    madgwick = Madgwick()
    q = np.array([1.0, 0.0, 0.0, 0.0])
    q_ref = np.array([1.0, 0.0, 0.0, 0.0])  # current pose is displayed relative to this
    last_time = time.time()

    try:
        while True:
            rate(200)

            if recalibrate_requested:
                recalibrate_requested = False
                gyro_bias = calibrate_gyro_bias(ser, GYRO_CALIBRATION_SAMPLES)
                q_ref = q.copy()
                last_time = time.time()
                start_time = time.time()
                if args.log:
                    log_file.close()
                    log_file, log_writer = start_csv_log("cube_view")
                print("Re-zeroed — current pose is now the reference orientation.")
                continue

            sample = read_sample(ser)
            if sample is None:
                continue

            if log_writer:
                log_sample(log_writer, time.time() - start_time, sample)

            now = time.time()
            dt = now - last_time
            last_time = now

            ax, ay, az, gx, gy, gz = sample
            gx, gy, gz = np.array([gx, gy, gz]) - gyro_bias

            acc = np.array([ax, ay, az]) * G_TO_MS2
            gyr = np.array([gx, gy, gz]) * DEG_TO_RAD

            q = madgwick.updateIMU(q, gyr=gyr, acc=acc, dt=dt)

            q_display = quaternion_multiply(quaternion_conjugate(q_ref), q)
            r = quaternion_to_matrix(q_display)
            forward, up = r[:, 0], r[:, 1]
            cube.axis = vector(*forward) * cube.length
            cube.up = vector(*up)
    finally:
        if log_file:
            log_file.close()


if __name__ == "__main__":
    main()
