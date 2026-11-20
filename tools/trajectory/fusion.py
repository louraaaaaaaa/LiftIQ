"""Orientation fusion (6-axis Mahony with gravity gating) and gravity removal.

Conventions
-----------
* Quaternions are [w, x, y, z], unit, and rotate SENSOR-frame vectors into the
  WORLD frame:  v_world = q * v_sensor * q^-1.
* World frame: z up, x/y arbitrary (no heading reference; the world x/y is
  fixed by the minimal rotation that takes the initial rest gravity reading to +z).
* Accelerometer reads specific force: at rest it reads +g along "up".
  Linear (kinematic) acceleration in world = R*acc - [0, 0, g].
"""
from __future__ import annotations

import math

import numpy as np

G0 = 9.80665


# ---------------------------------------------------------------- quaternions
def q_normalize(q):
    q = np.asarray(q, float)
    return q / np.linalg.norm(q, axis=-1, keepdims=True)


def q_conj(q):
    q = np.asarray(q, float)
    return q * np.array([1.0, -1.0, -1.0, -1.0])


def q_mul(a, b):
    a, b = np.broadcast_arrays(np.asarray(a, float), np.asarray(b, float))
    w1, x1, y1, z1 = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    w2, x2, y2, z2 = b[..., 0], b[..., 1], b[..., 2], b[..., 3]
    return np.stack([
        w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
        w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
        w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
        w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
    ], axis=-1)


def q_from_axis_angle(axis, angle_rad):
    axis = np.asarray(axis, float)
    axis = axis / np.linalg.norm(axis)
    angle = np.asarray(angle_rad, float)
    s = np.sin(angle / 2)[..., None]
    return np.concatenate([np.cos(angle / 2)[..., None], axis * s], axis=-1)


def q_rotate(q, v):
    """Rotate vectors v (...,3) by quaternions q (...,4) (broadcast)."""
    q = np.asarray(q, float)
    v = np.asarray(v, float)
    qv = q[..., 1:]
    w = q[..., :1]
    t = 2.0 * np.cross(qv, v)
    return v + w * t + np.cross(qv, t)


def q_from_vectors(a, b):
    """Minimal rotation quaternion taking direction a onto direction b."""
    a = np.asarray(a, float) / np.linalg.norm(a)
    b = np.asarray(b, float) / np.linalg.norm(b)
    d = float(np.dot(a, b))
    if d < -1 + 1e-12:  # opposite: any perpendicular axis
        ax = np.cross(a, [1.0, 0, 0])
        if np.linalg.norm(ax) < 1e-6:
            ax = np.cross(a, [0, 1.0, 0])
        return q_from_axis_angle(ax, math.pi)
    q = np.concatenate([[1.0 + d], np.cross(a, b)])
    return q_normalize(q)


def q_to_euler_deg(q):
    """ZYX (yaw, pitch, roll) -> returns (roll, pitch, yaw) in degrees, (N,3)."""
    q = np.atleast_2d(q)
    w, x, y, z = q[:, 0], q[:, 1], q[:, 2], q[:, 3]
    roll = np.arctan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y))
    pitch = np.arcsin(np.clip(2 * (w * y - z * x), -1, 1))
    yaw = np.arctan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))
    return np.degrees(np.column_stack([roll, pitch, yaw]))


def q_angle_between_deg(qa, qb):
    """Angle of the rotation taking qa to qb (degrees), elementwise."""
    d = np.abs(np.sum(np.asarray(qa) * np.asarray(qb), axis=-1))
    return np.degrees(2 * np.arccos(np.clip(d, -1, 1)))


# ------------------------------------------------------------- rest / bias
def initial_rest_slice(acc, gyro_dps, fs, rest_s=1.0, max_acc_std=0.08, max_gyro_std=1.0):
    """Return slice of the first rest_s seconds if it looks stationary, else None."""
    n = int(rest_s * fs)
    if len(acc) < n or n < 10:
        return None
    a, g = acc[:n], gyro_dps[:n]
    if np.linalg.norm(a, axis=1).std() > max_acc_std or g.std(axis=0).max() > max_gyro_std:
        return None
    return slice(0, n)


def resolve_gyro_bias(cap_gyro_dps, fs, header_bias, mode="header", rest=None):
    """mode: 'header' (fallback rest, then zero) | 'rest' | 'none'. rest = slice of a stationary window."""
    if mode == "none":
        return np.zeros(3), "none"
    rest_b = np.median(cap_gyro_dps[rest], axis=0) if rest is not None else None
    if mode == "rest" and rest_b is not None:
        return rest_b, "rest"
    if header_bias is not None and mode in ("header", "rest"):
        return np.asarray(header_bias, float), "header"
    if rest_b is not None:
        return rest_b, "rest"
    return np.zeros(3), "none"


# ------------------------------------------------------------------ Mahony
def mahony(acc, gyro_rads, fs, q0, kp=1.0, ki=0.0, g_ref=G0, gate_tol=0.5, trust=None, kp_weak=0.0, weak_tol=0.3):
    """6-axis Mahony filter. acc (N,3) m/s^2, gyro_rads (N,3) rad/s (bias already removed).

    The accelerometer correction is applied only when | |a| - g_ref | < gate_tol
    (quasi-static / low linear acceleration), so linear acceleration does not
    pull the tilt estimate. If ``trust`` (bool (N,)) is given, the correction is
    additionally restricted to samples where it is True (e.g. the stationary
    mask): sustained horizontal acceleration keeps |a| ~ g, so the magnitude
    gate alone lets it leak into the tilt estimate. Returns q (N,4) sensor->world.
    """
    n = len(acc)
    dt = 1.0 / fs
    w, x, y, z = (float(v) for v in q0)
    ix = iy = iz = 0.0
    out = np.empty((n, 4))
    acc = np.asarray(acc, float)
    gyro_rads = np.asarray(gyro_rads, float)
    for i in range(n):
        ax, ay, az = acc[i]
        gx, gy, gz = gyro_rads[i]
        norm = math.sqrt(ax * ax + ay * ay + az * az)
        dev = abs(norm - g_ref)
        k = kp if (trust is None or trust[i]) else kp_weak
        if k > 0 and norm > 1e-6 and dev < (gate_tol if (trust is None or trust[i]) else weak_tol):
            ax, ay, az = ax / norm, ay / norm, az / norm
            # predicted "up" in sensor frame = 3rd row of R(sensor->world)
            vx = 2 * (x * z - w * y)
            vy = 2 * (y * z + w * x)
            vz = w * w - x * x - y * y + z * z
            ex = ay * vz - az * vy
            ey = az * vx - ax * vz
            ez = ax * vy - ay * vx
            if ki > 0:
                ix += ki * ex * dt
                iy += ki * ey * dt
                iz += ki * ez * dt
                gx += ix
                gy += iy
                gz += iz
            gx += k * ex
            gy += k * ey
            gz += k * ez
        hx, hy, hz = 0.5 * dt * gx, 0.5 * dt * gy, 0.5 * dt * gz
        nw = w - x * hx - y * hy - z * hz
        nx = x + w * hx + y * hz - z * hy
        ny = y + w * hy - x * hz + z * hx
        nz = z + w * hz + x * hy - y * hx
        s = 1.0 / math.sqrt(nw * nw + nx * nx + ny * ny + nz * nz)
        w, x, y, z = nw * s, nx * s, ny * s, nz * s
        out[i] = (w, x, y, z)
    return out


def q_init_from_gravity(g_sensor):
    """Quaternion (sensor->world) that maps the measured gravity reading onto +z."""
    return q_from_vectors(g_sensor, [0.0, 0.0, 1.0])


def linear_acceleration_world(acc, q, g_ref=G0):
    """World-frame linear acceleration: R(q)*acc - [0,0,g_ref]."""
    a_w = q_rotate(q, acc)
    a_w[..., 2] -= g_ref
    return a_w
