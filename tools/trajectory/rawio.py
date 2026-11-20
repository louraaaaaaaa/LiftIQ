"""Load / save / validate LiftIQ raw CSV v1 (format=liftiq-raw v1).

Header: lines ``# key: value`` (unknown keys kept, optional keys may be absent).
Data:   column row ``t_s,ax,ay,az,gx,gy,gz`` (m/s^2 and deg/s, bias NOT subtracted).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

COLUMNS = ["t_s", "ax", "ay", "az", "gx", "gy", "gz"]
META_ORDER = [
    "format", "fw_version", "device_name", "app_version", "captured_at",
    "sample_rate_hz", "accel_range_g", "gyro_range_dps", "accel_units",
    "gyro_units", "gyro_bias_dps", "gravity_ms2", "rep_count_firmware",
    "dropped_chunks", "exercise", "load_kg", "known_rom_cm", "notes",
]


@dataclass
class RawCapture:
    t: np.ndarray            # (N,) seconds
    acc: np.ndarray          # (N,3) m/s^2, sensor axes as read
    gyro: np.ndarray         # (N,3) deg/s, bias NOT subtracted
    meta: dict = field(default_factory=dict)

    def __len__(self):
        return len(self.t)

    # -- header helpers (tolerate missing / malformed values) --
    def get_float(self, key, default=None):
        try:
            return float(str(self.meta[key]).strip())
        except (KeyError, ValueError):
            return default

    def get_vec(self, key):
        try:
            parts = str(self.meta[key]).replace(",", ";").split(";")
            v = np.array([float(p) for p in parts], dtype=float)
            return v if v.shape == (3,) else None
        except (KeyError, ValueError):
            return None

    @property
    def fs(self):
        """Nominal rate from header, else estimated from t_s."""
        f = self.get_float("sample_rate_hz")
        if f and f > 0:
            return f
        return estimate_fs(self.t)

    @property
    def gyro_bias_dps(self):
        return self.get_vec("gyro_bias_dps")

    @property
    def gravity_ms2(self):
        return self.get_vec("gravity_ms2")

    @property
    def known_rom_cm(self):
        v = self.get_float("known_rom_cm")
        return v if (v is not None and v > 0) else None


def estimate_fs(t):
    t = np.asarray(t, float)
    if len(t) < 2:
        return float("nan")
    return 1.0 / float(np.median(np.diff(t)))


def _parse_header_line(line, meta):
    body = line.lstrip("#").strip()
    if ":" not in body:
        return
    k, _, v = body.partition(":")
    meta[k.strip()] = v.strip()


def parse_raw_csv(text: str) -> RawCapture:
    meta, rows, cols = {}, [], None
    for line in text.splitlines():
        s = line.strip()
        if not s:
            continue
        if s.startswith("#"):
            _parse_header_line(s, meta)
            continue
        if cols is None:
            names = [c.strip() for c in s.split(",")]
            if "t_s" in names:
                cols = names
                continue
            cols = COLUMNS[:]  # headerless data row: assume the contract order
        parts = s.split(",")
        if len(parts) < len(cols):
            continue
        try:
            rows.append([float(p) for p in parts[: len(cols)]])
        except ValueError:
            continue
    if not rows:
        raise ValueError("no data rows found")
    arr = np.array(rows, float)
    idx = {c: i for i, c in enumerate(cols)}
    missing = [c for c in COLUMNS if c not in idx]
    if missing:
        raise ValueError(f"missing columns: {missing}")
    keep = np.isfinite(arr).all(axis=1)
    arr = arr[keep]
    t = arr[:, idx["t_s"]]
    acc = arr[:, [idx["ax"], idx["ay"], idx["az"]]]
    gyro = arr[:, [idx["gx"], idx["gy"], idx["gz"]]]
    return RawCapture(t=t, acc=acc, gyro=gyro, meta=meta)


def load_raw(path) -> RawCapture:
    return parse_raw_csv(Path(path).read_text(encoding="utf-8", errors="replace"))


def format_raw_csv(cap: RawCapture) -> str:
    meta = dict(cap.meta)
    meta.setdefault("format", "liftiq-raw v1")
    keys = [k for k in META_ORDER if k in meta] + [k for k in meta if k not in META_ORDER]
    out = []
    for k in keys:
        v = str(meta[k]).replace("\n", " ").replace("\r", " ")
        out.append(f"# {k}: {v}")
    out.append(",".join(COLUMNS))
    for i in range(len(cap.t)):
        a, g = cap.acc[i], cap.gyro[i]
        out.append(
            f"{cap.t[i]:.6f},{a[0]:.5f},{a[1]:.5f},{a[2]:.5f},{g[0]:.4f},{g[1]:.4f},{g[2]:.4f}"
        )
    return "\n".join(out) + "\n"


def save_raw(path, cap: RawCapture):
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(format_raw_csv(cap), encoding="utf-8", newline="\n")


def validate(cap: RawCapture, gap_factor=2.5) -> dict:
    """Return a report dict with a ``warnings`` list; never raises."""
    t = cap.t
    w = []
    n = len(t)
    dt = np.diff(t) if n > 1 else np.array([])
    monotonic = bool(np.all(dt > 0)) if n > 1 else True
    if not monotonic:
        w.append(f"t_s not strictly increasing ({int(np.sum(dt <= 0))} violations)")
    fs_est = estimate_fs(t)
    fs_nom = cap.get_float("sample_rate_hz")
    if fs_nom and np.isfinite(fs_est) and abs(fs_est - fs_nom) / fs_nom > 0.05:
        w.append(f"estimated rate {fs_est:.1f} Hz differs from header {fs_nom:.1f} Hz")
    med = float(np.median(dt)) if len(dt) else float("nan")
    gaps = np.where(dt > gap_factor * med)[0] if len(dt) and med > 0 else np.array([], int)
    if len(gaps):
        w.append(f"{len(gaps)} gap(s) > {gap_factor}x median dt, max {dt[gaps].max():.3f} s")
    dropped = cap.get_float("dropped_chunks", 0)
    if dropped:
        w.append(f"header reports dropped_chunks={dropped:g}")
    ar, gr = cap.get_float("accel_range_g"), cap.get_float("gyro_range_dps")
    if ar and np.abs(cap.acc).max() >= 0.98 * ar * 9.80665:
        w.append("accel clipped")
    if gr and np.abs(cap.gyro).max() >= 0.98 * gr:
        w.append("gyro clipped")
    if cap.gyro_bias_dps is None:
        w.append("no gyro_bias_dps in header (will estimate from initial rest)")
    return dict(n=n, duration_s=float(t[-1] - t[0]) if n > 1 else 0.0, fs_est=fs_est,
                fs_nominal=fs_nom, monotonic=monotonic, n_gaps=int(len(gaps)),
                max_gap_s=float(dt[gaps].max()) if len(gaps) else 0.0, warnings=w)


def resample_uniform(cap: RawCapture, fs=None) -> RawCapture:
    """Linear-interpolate onto a uniform grid (fixes gaps/jitter). Sorts by t_s."""
    order = np.argsort(cap.t, kind="stable")
    t, acc, gyro = cap.t[order], cap.acc[order], cap.gyro[order]
    keep = np.concatenate([[True], np.diff(t) > 0])
    t, acc, gyro = t[keep], acc[keep], gyro[keep]
    fs = fs or cap.fs
    tu = np.arange(t[0], t[-1], 1.0 / fs)
    acc_u = np.column_stack([np.interp(tu, t, acc[:, i]) for i in range(3)])
    gyro_u = np.column_stack([np.interp(tu, t, gyro[:, i]) for i in range(3)])
    meta = dict(cap.meta)
    meta["sample_rate_hz"] = f"{fs:g}"
    return RawCapture(tu - tu[0], acc_u, gyro_u, meta)
