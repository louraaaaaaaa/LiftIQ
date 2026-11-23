# tools/trajectory - offline trajectory experiment toolkit (Step 0)

Takes raw 6-axis captures (raw CSV v1, see `docs/history/DEVELOPMENT_HISTORY.md` Step 0) from the BMI160 and measures how accurately
per-rep vertical range of motion (ROM), velocity and a 3D path can be reconstructed, with ablations. Purpose: decide
whether the current IMU is good enough (gate: ~2 cm per-rep ROM error vs a tape measure) or better hardware is needed.
numpy + matplotlib only (no scipy). No magnetometer is used.

## Status: what is and is not validated

* Validated: only on SYNTHETIC data (`synth.py`) with a BMI160-like error model built from the datasheet numbers given in
  the brief. 19 unit tests pass (`test_trajectory.py`).
* NOT validated: any real capture. No real raw CSV existed when this was written. All accuracy numbers below are what the
  algorithms achieve on simulated rigid-body motion with simulated sensor errors. They are a best case, not a prediction:
  hand tremor, stack vibration/impacts, non-rigid mounting, temperature transients and unmodelled sensor behaviour are
  absent. Do not quote them as expected real-world accuracy until Step 0 experiments have been run.
* The existing `data/recordings/app-sessions/*.csv` are 50 Hz accel-only live-mode files: not usable here.

## Capture requirement (read first)

ARM (5 s still) -> START -> keep the sensor **still in the same pose for >= 1 s before the first rep**, and >= 1 s
after the last rep before STOP. The first second gives the initial pose and noise level; `analyze_raw.py` prints a
WARNING when the first 1 s is not stationary (it then falls back to the header gravity and results are less reliable).

**Start phase.** Stack/machine exercises start with the up (concentric) phase; barbell lifts like squat/bench start
with the down (eccentric) phase. Write `start=down` (or `start=up`) as the FIRST token of the Lab notes field, e.g.
`start=down squat, empty bar`. `analyze_raw.py` reads it from the header `notes`; otherwise `--start-phase up|down`;
default up. Concentric velocity is always the upward phase.

**Auto thresholds (now the default).** The stationary thresholds are derived from the quietest windows ANYWHERE in the
capture (1st percentile of the windowed robust spread, converted to a noise sigma, x1.6 / x2.2 with absolute floors;
`--stationary-scale K` loosens them, `--noise-from static_cold_1.csv` takes them from a test-A capture,
`--no-auto-thresholds` restores the fixed defaults). Synthetic slow-rep result (4 s per phase, 40 cm, 6 seeds x 4
reps): default thresholds -13.1 cm (BMI160-like) / -15.1 cm (BMI270-like) mean error; auto-thresholds 0.67 cm / 0.21 cm,
no reps missed (worst single rep for one seed 3.3 cm). At 5 s per phase it is still poor (5.9 cm / 3.7 cm). Normal-speed reps are unaffected (2.5 s: 0.09 cm).

## Real-data robustness (first real capture, hand rotation test, 2026-11-20)

Added after the first real file (`data/recordings/raw/liftiq-raw-2026-11-20-364b2a76.csv`): Hampel despiking of accel
and gyro (`--no-despike` to disable), windowed MAD/median statistics instead of std/mean, start-up transient skip
(`--skip-s 0.3`), initial pose from the first stationary run of >= 0.3 s (not necessarily the first second),
window length `--window-s` (0.25-0.5 s), optional weak gravity gain outside rests (`--kp-weak`, default off:
it made the real file slightly worse, see below), `--no-reject-zupt` for non-vertical tests,
`--rest-report` (accel tilt vs fused vs gyro-only roll at each stationary window).
Everything here was tuned on ONE hand-held file and is not validated beyond it and the synthetic suite.
On that file: the 6 rests agree with accel roll to <= 0.7 deg for gyro-only integration with the header bias
(5.9 deg without bias subtraction); the "baseline drift" seen earlier (-3 to -12 deg) is the hand really
resting at different tilts, not gyro drift. Only 2 stationary windows are found (initial 0.9-1.2 s and 10.15-10.4 s,
with `--window-s 0.25 --stationary-scale 4 --no-reject-zupt`); the other rests are 0.15-0.3 s with hand tremor.

**Accel scale/offset.** `--normalize-gravity` rescales accel so the rest |g| is 9.80665; it is only right if the
excess (real file: +3.4 %) is scale, not offset, which a single pose cannot tell, so it is OFF by default
(it cost ~0.8 cm on 40 cm synthetic reps when the excess was offset). Proper fix: 6-position calibration,
`python calibrate_accel.py cal.json xp.csv xn.csv yp.csv yn.csv zp.csv zn.csv` (still captures, each with one
axis up; `file.csv:t0-t1` selects a window), then `analyze_raw.py file.csv --accel-cal cal.json`
(`acc_cal = (acc - offset) / scale`; misalignment and temperature drift not modelled).

## Files

| file | purpose |
|---|---|
| `rawio.py` | load/save/validate raw CSV v1 (unknown header keys ignored, optional keys may be missing, gaps -> `resample_uniform`) |
| `fusion.py` | quaternion utils, gyro-bias handling, 6-axis Mahony filter with gravity gating, gravity removal |
| `zupt.py` | stationary detection, rep segmentation, velocity/position integration (none / reset / linear / RTS), PCA axis |
| `pipeline.py` | `PipelineConfig` + `reconstruct()` gluing the above |
| `metrics.py` | per-rep ROM, path length, concentric mean/peak velocity, duration, error vs `known_rom_cm` |
| `analyze_raw.py` | CLI |
| `synth.py` | synthetic truth + BMI160/BMI270-like error model, writes raw CSV v1 |
| `sensitivity.py` | Monte-Carlo sweeps (residual gyro/accel bias, tilt error, rep duration, sample rate, pauses) |
| `test_trajectory.py` | unittest suite |

## Usage

```
cd tools/trajectory
python analyze_raw.py ../../data/recordings/raw/weightstack_40cm_1.csv --ablate --plot
python analyze_raw.py file.csv --zupt rts --pca               # RTS smoothing, constrained (guided) exercise
python analyze_raw.py square_1.csv --units-per-rep 4          # table-square: 4 pause-delimited sides per loop
python synth.py out.csv --rom-cm 40 --reps 4 --arc-cm 2 --tilt-deg 5 --model bmi160 --seed 1
python sensitivity.py --seeds 6 --out ../../data/recordings/raw/analysis   # ~1 min
python -m unittest test_trajectory -v
```

`--plot` writes `<stem>_raw.png`, `_orientation.png`, `_velocity.png` (stationary instants shaded), `_path3d.png`,
`_path2d.png` into `--out` (default `<csv dir>/analysis`). Main options: `--zupt none|reset|linear|rts`,
`--no-loop-closure`, `--pca`, `--bias header|rest|none`, `--concentric up|down`, `--min-rom-cm`, `--units-per-rep N`.

## Algorithm

1. **Load/validate.** Check monotonic `t_s`, rate vs header, gaps (>2.5x median dt), clipping, `dropped_chunks`; gaps are
   linearly resampled to a uniform grid.
2. **Initial pose.** If the first 1 s is quiet, its mean accel gives the gravity direction and `g_ref = |mean|`
   (cancels accel scale error); else the header `gravity_ms2`. World frame: z up; x/y fixed by the minimal rotation
   taking that reading to +z (yaw is arbitrary).
3. **Gyro bias.** Header estimate (default), initial-rest estimate, or none. Subtracted before fusion.
4. **Orientation.** Mahony filter (kp = 4 /s). Gravity correction is applied only when `| |a| - g_ref | < 0.5 m/s^2`
   AND the sample is stationary. The stationary requirement matters: during sustained horizontal acceleration `|a|`
   stays about g, and a magnitude gate alone let the filter tilt "into" the acceleration (it shortened a 30 cm table
   side to ~25 cm in the synthetic test). Between rests orientation is pure gyro integration.
5. **Linear acceleration.** `R(q) a - [0,0,g_ref]`, minus the mean over the initial rest (removes residual offsets).
6. **Stationary detection.** Centred 0.4 s window; rolling std of `|a|`, of the raw accel vector (sees horizontal
   motion) and of the gyro (bias independent), plus `| mean|a| - g_ref |`; hysteresis (enter below lo, leave above hi);
   runs shorter than 0.15 s (rest) / 0.25 s (move) are absorbed. A rest candidate sitting at a vertical velocity peak
   (integrated vertical speed from the last rest > half the peak) is rejected, because slow reps have a low-acceleration
   stretch around peak velocity that looks like rest.
7. **Integration** (`--zupt`): `none` plain trapezoid; `reset` v=0 on all stationary samples; `linear` per moving unit
   (between rests) velocity ramp removal so v_end=0; `rts` per-axis Kalman filter [p, v, accel bias] with v=0
   pseudo-measurements on stationary samples plus RTS backward smoother.
8. **Rep grouping.** A moving unit that nets a vertical displacement pairs with the next unit of opposite sign
   (concentric + eccentric). A unit that returns to its start (continuous reps, no pause) is split at vertical turning
   points. `--units-per-rep N` groups N units instead (table square).
9. **Loop closure** (default on): per rep, a linear-in-moving-time ramp forces end position = start position.
   The raw closure error is reported (`clos_cm`) as a quality indicator.
10. **PCA** (`--pca`): projects linear acceleration on its dominant direction (guided stack lifts), removing orthogonal leakage.
11. **Metrics:** ROM = max-min of world z within the rep; path length = 3D polyline; concentric velocity over the
    phase ending at the extreme (`--concentric up|down`); error vs `known_rom_cm`.

## Synthetic accuracy (BMI160-like and BMI270-like, ideal protocol: 40 cm, ~1 s pauses, 1.5 s phases, 200 Hz)

Per-rep vertical ROM error, mean |err| / p95, 6 seeds x 4 reps. Run `sensitivity.py` for the full tables.

| condition | BMI160-like | BMI270-like |
|---|---|---|
| ideal protocol | 0.09 / 0.20 cm | 0.09 / 0.19 cm |
| residual gyro bias 3 deg/s | 0.11 / 0.26 cm (horizontal excursion error 3.2 cm) | 0.11 / 0.24 cm |
| residual accel bias 20 mg | 0.09 / 0.20 cm | 0.09 / 0.19 cm |
| tilt error 5 deg | 0.18 / 0.36 cm | 0.18 / 0.35 cm |
| pauses 0.3 s | 0.40 / 1.07 cm | 0.13 / 0.26 cm |
| no pauses (continuous) | 0.29 / 0.68 cm | 0.10 / 0.23 cm |
| no pauses, no gyro bias subtraction | pipeline fails (100% reps missed) | 0.46 / 0.80 cm, 83% missed |
| 4 s per phase (slow), default thresholds | -13 cm (rep split by false rest; 8% missed) | -15 cm |
| 4 s per phase, `--auto-thresholds` | 0.67 cm | 0.21 cm |

Reading: with a rest calibration and pauses, zero-velocity updates remove nearly all drift, so BMI160 and BMI270 are
indistinguishable in this simulation; the sensors differ mainly when pauses are short/absent or when the rest
calibration is skipped/stale (the offset/TCO terms). The synthetic model has no hand/stack jitter, so these are optimistic.

## Assumptions (not from datasheet / brief) - replace with measurements from protocol test A

* Noise bandwidth = fs/2 (no digital filtering): sigma = density x sqrt(fs/2).
* BMI160 initial accel offset +/-20 mg (removed by rest calibration), accel and gyro scale error +/-0.5 % uniform per axis.
* Warm-up: 5 K temperature rise ramping linearly between the rest calibration and the end of the capture.
* TCO and zero-rate offset drawn uniformly within the quoted limits (worst-case limits are rarely reached).
* BMI270 gyro noise assumed equal to BMI160's (architect's research notes: "about the same").
* Synthetic header calibration = 5 s rest at the start pose at dT=0, so the header gyro bias is correct to the noise level.

## Limitations

* No heading reference: yaw (world x/y) is relative to the start pose; use vertical ROM and shape, not compass direction.
* Needs stationary instants. Pauses of >= 0.5 s at top/bottom work; shorter or none degrade (see table), and
  start/end of the capture need a ~1 s rest (also gives the initial pose).
* Slow motion defeats accel-based rest detection: phases of ~4 s for 40 cm (peak accel ~0.1 m/s^2, comparable to
  noise) were mis-segmented in simulation. Default `StationaryParams` are fixed; `--auto-thresholds` adapts them to measured noise (fixes 4 s phases, not 5 s).
* Reps are grouped by vertical turning points; only stationary-delimited vertical logic is implemented. Other exercises may need `--units-per-rep`.
* The false-rest rejection only looks at vertical speed and so does nothing for horizontal exercises.
* Gyro scale error, axis misalignment and accel non-orthogonality are not calibrated.
* Everything is offline (not suitable for the ESP32 as is).
* Mahony is pure gyro integration while moving; a sustained gyro bias error leaks into tilt until the next rest
  (gain kp = 4 /s limits the lag at rest).
