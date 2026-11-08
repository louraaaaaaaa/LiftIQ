# tools

PC-side scripts for sensor bring-up and workout testing. The raw IMU plotting
and orientation tools use USB serial; `firmware_debug.py` connects over BLE.
These are development tools, not part of the firmware or eventual phone app.

The USB serial tools log their raw `ax,ay,az,gx,gy,gz` stream to
`recordings/<tool>_NNN.csv` by default (auto-incrementing, new file per
run and per re-zero) — see [recordings/README.md](recordings/README.md).
`imu_cube_view.py`/`rep_counter.py` take `--no-log` to disable it;
`accel_plot.py` has a `LOG_TO_CSV` constant at the top of the file.

## imu_cube_view.py

Renders a live 3D cube tracking the device's orientation, fed by the raw
accel/gyro stream from
`firmware/archive/serial-imu-bringup/LiftIQ_Serial/LiftIQ_Serial.ino`.

Setup:

```bash
pip install -r requirements.txt
```

Flash `firmware/archive/serial-imu-bringup/LiftIQ_Serial/LiftIQ_Serial.ino`,
note the COM port from Arduino IDE
(Tools > Port), close the Arduino Serial Monitor (only one program can hold
the port), then run:

```bash
python imu_cube_view.py --port COM5
python imu_cube_view.py --port COM5 --no-log   # skip CSV logging
```

Keep the device still for the first second — it samples the gyro to
estimate and cancel its bias before rendering starts. Orientation comes
from a Madgwick filter (IMU-only, no magnetometer): roll/pitch are
self-correcting against the measured gravity vector, but yaw has no
absolute reference (no magnetometer) so it will slowly drift no matter
how good the calibration is — expected, not a bug.

Click the cube window and press **r** any time to re-zero: it redoes the
gyro bias calibration and treats the device's current pose as the new
reference orientation, so you can reposition the device and reset drift
mid-session instead of restarting the script.

## rep_counter.py

First-pass rep counter — no orientation/fusion, just the magnitude of the
accelerometer vector deviating from 1g at rest, fed through a
hysteresis (Schmitt-trigger) state machine so one clean burst of motion
counts as one rep.

```bash
python rep_counter.py --port COM5 --verbose
python rep_counter.py --port COM5 --no-log   # skip CSV logging
```

Run with `--verbose` first on a real set to watch the live deviation
values, then pick `--threshold` (default 0.2g) so it sits cleanly above
resting noise and below a real rep's motion; `--refractory` (default
0.4s) debounces double-counts from noise right after a rep. This is
intentionally simple — a starting point to validate rep counting
end-to-end, not the final algorithm (no displacement, no ZUPT, no
distinction between exercises).

## firmware_debug.py

Live Bluetooth LE dashboard for telemetry from
`firmware/current/LiftIQ_BLE/LiftIQ_BLE.ino`.
It shows body-frame acceleration X/Y/Z, total and dynamic acceleration,
the firmware velocity estimate, current phase, rep count, and measured
notification rate.

Install dependencies, flash `firmware/current/LiftIQ_BLE/LiftIQ_BLE.ino`, then
run:

```bash
pip install -r requirements.txt
python firmware_debug.py
python firmware_debug.py --window 15
```

Use the **Bluetooth sensor** selector to choose a discovered device, then
click **Connect** or **Pair & Connect**. The second option asks Windows to pair
the sensor and may trigger its normal pairing prompt. No UUID entry is
required: the service and telemetry/control characteristic UUIDs used by
LiftIQ are built into the dashboard. Click **Scan** to refresh the list.
`--scan-timeout` sets scan duration. Close other BLE apps connected to the
tracker before connecting; the device may allow only one central connection.

Use **Start** to begin a fresh capture, **Pause/Resume** to suspend and
continue it, and **Stop** to end the capture. Stop clears the live plot
history while retaining the captured samples for **Save CSV...**. Starting
another capture before exporting the stopped one asks for confirmation
before discarding it.

Every **Start** sends the BLE start-set command and asks the firmware to
recalibrate its resting acceleration magnitude. Keep the sensor still while
the dashboard says
**Calibrating - keep sensor still**; recording begins only after the firmware
confirms calibration. This replaces boot-time calibration and resets the
firmware rep counter for each new session. The firmware's BLE "start new
set" command requests the same calibration. The current calibration measures
gravity magnitude only; it does not calibrate gyro bias or remove the
gravity vector from each acceleration axis.

Calibration progress and missing calibration acknowledgments are shown in
the connection status.

The exported CSV contains one row per captured sample: elapsed session time,
all acceleration and velocity values shown in the plots, phase name and ID,
rep count, and measured sample rate. Time remains elapsed session time while
paused, so the CSV preserves pauses as gaps; no samples are captured during
those gaps.

BLE telemetry is sent at up to 50 Hz using 16-byte notifications: six
little-endian signed 16-bit values (acceleration and magnitudes scaled by
100, velocity by 1000), phase, calibration status, and a 16-bit rep count.
Acceleration is displayed in m/s^2, including gravity in the raw XYZ and
total-acceleration values.

**Treat velocity as a tuning signal, not a measurement.** The current
firmware integrates `abs(|acceleration| - baseline gravity)`, which has no
direction and can only increase the estimated speed during a lift phase.
It cannot produce trustworthy displacement or velocity. See the tuning
recommendations below before using those values for training feedback.

## Rep tracking metrics and next tuning steps

- First make the motion signal directional: estimate gravity/orientation,
  subtract gravity, then project linear acceleration onto the machine's
  constrained travel axis. Integrate with measured sample intervals and
  correct velocity at confirmed stationary turnarounds; only then use
  velocity or displacement for rep quality.
- Log per-rep concentric/eccentric duration, pause duration, peak and mean
  signed velocity, range of motion, and peak dynamic acceleration. These
  make tempo and consistency measurable, but validate displacement against
  known stack travel because inertial double-integration drifts.
- Add confidence/rejection reasons and a stable-rest/noise estimate. Tune
  start/stop thresholds and minimum durations against slow reps, partial
  reps, pauses, and machine impacts; require a sustained condition rather
  than changing phase on a single threshold crossing.
- Stream gyro axes or gyro magnitude as well. A sustained low-gyro and
  low-acceleration-variance window is more reliable for confirming rest
  than a single acceleration threshold crossing; gyro also helps catch
  sensor rotation or a loose mount.
- Check sensor clipping and actual sample intervals. The Test sketch uses
  the BMI160 ±2g range; raise the range if representative machine motion
  approaches that limit. Keep the measured sample rate near the intended
  100 Hz and discard or flag long gaps.
- Validate counts against manually labeled sets across different exercises,
  mounting orientations, loads, and rep tempos before treating thresholds
  as general-purpose. A magnitude-only threshold may work for one setup but
  cannot distinguish lift direction or exercise type.

## accel_plot.py

Live dashboard, 4 rows (raw acceleration, filtered acceleration,
velocity, position) x 2 columns (per-axis, magnitude) of scrolling 2D
time plots, plus a live 3D trail of the position estimate — all in one
window.

No CLI args — `PORT`, `BAUD`, `WINDOW_SECONDS`, `SMOOTH_SAMPLES`,
`CALIBRATION_SAMPLES`, `ACCEL_GATE_HIGH_G`, and `ACCEL_GATE_LOW_G` are
constants at the top of the file, edit them there, then:

```bash
python accel_plot.py
```

**Pipeline** (all in the sensor's own body frame until the final
rotation into world frame for the plots):

```
raw -> moving average (SMOOTH_SAMPLES) -> subtract accel bias
    -> per-axis hysteresis gate -> "filtered acceleration"
```

- **Raw acceleration** panel: the moving-averaged signal, nothing else
  removed — this is what the sensor actually reads, bias and all.
- **Accel bias calibration**: the calibration stage (device held still)
  measures the actual raw reading at that pose — not an idealized
  `[0, 0, 1g]` — and subtracts it, per axis, from every later smoothed
  reading. Held still at the calibration pose, filtered acceleration
  reads `~[0, 0, 0]g` on all three axes regardless of how the device
  happens to be mounted (it doesn't need to be level). Printed to the
  console at calibration time as `Accel bias (g): [...]`.
- **Per-axis hysteresis gate**: each bias-corrected axis must exceed
  `ACCEL_GATE_HIGH_G` (default 0.015g) before it's let through at all,
  and has to drop back below `ACCEL_GATE_LOW_G` (default 0.005g, near
  the BMI160's post-smoothing noise floor) before it's gated off again —
  same Schmitt-trigger idea as `rep_counter.py`'s threshold, applied per
  axis. If standing still still drifts, widen `ACCEL_GATE_HIGH_G`; if
  real reps get gated out (velocity/position stay flat when you know you
  moved), narrow both.
- **Filtered acceleration** panel shows the result of both steps above —
  this is also exactly what feeds velocity/position, so what you see
  here is what's being integrated, no hidden second signal.

Madgwick (used only to track orientation, for rotating the filtered
acceleration into world frame) still gets the raw, un-filtered
acceleration — it needs the real gravity vector to sense orientation;
feeding it the bias-removed signal would erase the one reference it
depends on.

**Zero-velocity update (ZUPT).** The hysteresis gate above only stops
*new* noise from being added to velocity — it does nothing to correct
velocity that's already wrong. That matters because zero acceleration is
consistent with being at rest *and* with coasting at constant nonzero
velocity (Newton's first law) — you can't tell those apart from a single
instant of accel data. So if a rep's accel/decel burst doesn't integrate
to *exactly* net-zero (it never will), the leftover velocity error used
to just freeze in place once the signal dropped back into the gate's
dead zone — not corrected, not decayed, stuck forever, so "standing
still" wouldn't actually show up as zero.

This runs an actual stillness detector to fix that: a sliding window
(`ZUPT_WINDOW_SAMPLES`, default 20 samples) of recent bias-corrected
accel deviation *and* gyro magnitude. Only once **both** stay below
their thresholds (`ZUPT_ACCEL_THRESHOLD_G` / `ZUPT_GYRO_THRESHOLD_DPS`)
for the *entire* window — sustained calm, not a momentary zero-crossing
mid-motion — does it declare the device stationary and hard-reset
velocity to exactly 0. The 3D plot shows a live `STATIONARY` / `moving`
indicator with a running reset count, so you can watch it fire and tune
the window/thresholds against real reps (shrink the window or loosen the
thresholds if it's slow to catch genuine stops; widen/tighten if it
fires during real motion).

**Velocity and position are still estimated, not measured.** ZUPT
bounds drift to within a single rep — it corrects whatever accumulated
between one stillness period and the next — but it doesn't eliminate
drift *during* a rep, and if the device never actually stops moving
(continuous reps with no pause) it won't fire at all. Watch the Position
panel with the device held still to confirm it settles at zero; watch it
during real reps to see how much residual drift is left within one.

Click the plot window and press **r** to re-zero: redoes the IMU bias
calibration (gyro + accel), resets orientation to identity, and zeros
velocity/position, the hysteresis gate state, the ZUPT window and reset
count, and the on-screen history.
