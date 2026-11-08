"""Shared serial helpers for reading LiftIQ's "ax,ay,az,gx,gy,gz" CSV stream."""

import csv
import os

import numpy as np
import serial

RECORDINGS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "recordings")


def open_stream(port, baud):
    """Open the serial port and print the header line the firmware sends."""
    ser = serial.Serial(port, baud, timeout=1)
    ser.readline()  # drop any partial line from mid-stream connect
    header = ser.readline().decode("ascii", errors="ignore").strip()
    print(f"Header: {header}")
    return ser


def read_sample(ser):
    """Read one CSV line as [ax, ay, az, gx, gy, gz]; None if garbled/empty."""
    line = ser.readline().decode("ascii", errors="ignore").strip()
    if not line:
        return None
    parts = line.split(",")
    if len(parts) != 6:
        return None
    try:
        return [float(p) for p in parts]
    except ValueError:
        return None


def calibrate_gyro_bias(ser, n_samples=100):
    """Average n_samples of gyro readings (device must be still) to get its bias."""
    print(f"Calibrating gyro bias ({n_samples} samples, keep device still)...")
    samples = []
    while len(samples) < n_samples:
        sample = read_sample(ser)
        if sample is not None:
            samples.append(sample[3:6])
    bias = np.mean(samples, axis=0)
    print(f"Gyro bias (deg/s): {bias}")
    return bias


def calibrate_imu_bias(ser, n_samples=100):
    """Average n_samples of accel+gyro readings (device must be still) to get
    the gyro's bias (deg/s) and the accelerometer's rest reading (g).

    The accel rest reading captures both true gravity at the device's
    current orientation AND the sensor's own zero-g offset error as one
    combined vector -- meant to be used as a fixed reference subtracted
    from future (orientation-rotated) readings, rather than assuming an
    idealized gravity vector.
    """
    print(f"Calibrating IMU bias ({n_samples} samples, keep device still)...")
    samples = []
    while len(samples) < n_samples:
        sample = read_sample(ser)
        if sample is not None:
            samples.append(sample)
    samples = np.array(samples)
    accel_bias = samples[:, 0:3].mean(axis=0)
    gyro_bias = samples[:, 3:6].mean(axis=0)
    print(f"Accel bias (g): {accel_bias}")
    print(f"Gyro bias (deg/s): {gyro_bias}")
    return gyro_bias, accel_bias


def start_csv_log(prefix):
    """Open recordings/<prefix>_NNN.csv (first unused NNN) and return a
    (file, writer) pair. Caller writes rows of [t, ax, ay, az, gx, gy, gz];
    the header is written here. File is line-buffered so Ctrl+C doesn't
    lose the last few samples.
    """
    os.makedirs(RECORDINGS_DIR, exist_ok=True)
    n = 1
    while True:
        path = os.path.join(RECORDINGS_DIR, f"{prefix}_{n:03d}.csv")
        if not os.path.exists(path):
            break
        n += 1
    f = open(path, "w", newline="", buffering=1)
    writer = csv.writer(f)
    writer.writerow(["t", "ax", "ay", "az", "gx", "gy", "gz"])
    print(f"Logging raw samples to {path}")
    return f, writer


def log_sample(writer, t, sample):
    writer.writerow([t] + list(sample))
