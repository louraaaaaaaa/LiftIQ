# Step 0 - physical experiment protocol

Goal: collect raw 6-axis captures to measure how well per-rep vertical ROM (and a 3D path) can be reconstructed with the
current BMI160, compared with a tape-measured ROM. Decision gate: ~2 cm per-rep ROM error means software is enough.
Analysis: `tools/trajectory/analyze_raw.py` (see `tools/trajectory/README.md`). This is a measurement exercise, not
training: use light or no load.

## MANDATORY for every capture

**ARM (5 s still) -> START -> keep the sensor perfectly still in the same pose for at least 1 s BEFORE the first rep,
and at least 1 s AFTER the last rep before STOP.** The analysis takes the initial pose and the noise level from that
first second; without it results are unreliable (the tool prints a warning).

**Start phase.** Put `start=up` or `start=down` as the FIRST word of the Lab Notes field: stack/machine exercises
start with the up (concentric) phase (`start=up`); barbell squat/bench-type lifts start with the down phase
(`start=down`). Example notes: `start=down empty bar, sleeve mount`. Default if omitted: up.

## General rules (all tests)

* Capture length is limited to ~40 s on the device. Plan each capture to fit (start the motion about 2 s after recording starts).
* Every capture: sensor still on a stable surface (or hanging still on the plate) during the Lab page 5 s rest
  calibration, do not touch it, then start recording, wait ~2 s still, do the movements, end with ~2 s still, stop.
  The initial and final stillness are required by the analysis.
* Mount the sensor the same way for the whole series (magnet on the plate/bar, note the orientation and where the USB
  port points in the notes). Do not re-mount between captures of the same test.
* Lab page fields: Exercise (name below), Load (kg), Known ROM (cm, measured, one number), Notes (free text: mounting,
  tempo, anything odd, temperature, "cold start"/"after 10 min"). Use 0 for load and leave ROM empty where noted.
* Files: `data/recordings/raw/<test>_<n>.csv` (n = 1, 2, 3 ...). Example `static_cold_1.csv`, `vertical40_pause_3.csv`.
* Send back: all CSVs of the session plus a one-line log per capture (what you did, anything unusual: bumped, dropped
  chunks, wrong ROM, the app showed errors). The CSV header already carries the metadata; do not edit the CSVs.
* Safety: no heavy loads. Stack tests use the lightest plate, bar tests use an empty or very light bar, rack the bar
  before touching the sensor, keep fingers clear of the magnet and moving plates, do not stand under a loaded bar.
  Stop if anything feels unstable.

## A. Static noise / bias test

* Setup: sensor lying flat on a table, nothing touching the table.
* Captures: 2 at cold start (right after power-on / first connect), 2 more after ~10 min of use (BLE connected, a few
  captures done, to warm it up). 40 s each, completely still, no one walking on the floor or touching the table.
* Fields: Exercise `static`, Load 0, Known ROM empty, Notes `cold start` or `warm 10 min`, plus room temperature if known.
* Files: `static_cold_1.csv`, `static_cold_2.csv`, `static_warm_1.csv`, `static_warm_2.csv`.
* Gives: real noise, bias, and warm-up drift. Needed to replace the assumed values in the synthetic model.

## B. Rotation test

* Setup: sensor held in a gloved hand or fixed to a box on a table, start flat.
* Procedure per capture: rest 3 s, then rotate 90 degrees about ONE axis slowly (about 4 s), hold 1 s, rotate back 4 s,
  rest 3 s. Do one capture per axis: x, y (tilt) and z (yaw), plus a second capture of x. Use a book edge or a table
  corner as a visual reference for 90 degrees.
* Fields: Exercise `rotation_x` (or `_y`, `_z`), Load 0, Known ROM empty, Notes the axis and direction.
* Files: `rotation_x_1.csv`, `rotation_y_1.csv`, `rotation_z_1.csv`, `rotation_x_2.csv`.
* Gives: validates the orientation fusion and the gyro scale (final angle vs 90).

## C. Table-square test

* Setup: draw a 30 cm square on a table (tape or marker). Put the sensor flat on a smooth sliding surface (e.g. the
  top of a cardboard box) and slide it by hand along the square, starting and ending at the same corner.
* Procedure per capture: rest 3 s, then 5 repetitions of the full square, pausing about 0.7 s at every corner
  (each side takes ~1 s, a loop ~7 s, 5 loops ~35 s incl. rests only if you keep to this tempo; do 4 loops if you run out of time). Keep the sensor flat and the orientation unchanged
  (no rotation). Finish with 2 s still. Must fit in ~40 s.
* Fields: Exercise `table_square`, Load 0, Known ROM empty (path length is 120 cm, side 30 cm: put it in Notes), Notes `30 cm square, 5 loops`.
* Files: `table_square_1.csv`, `table_square_2.csv`, `table_square_3.csv` (3 captures).
* Gives: 3D/horizontal path accuracy and loop closure. Analyse with `--units-per-rep 4`.

## D. Weight-stack vertical test (deliberate pauses)

* Setup: sensor magnet-mounted on the selected plate of a machine with a vertical guided stack, lightest weight. Mark
  the ROM positions with tape or measure with a tape measure between the bottom and top rest positions of the plate
  (measure the plate travel, not the handle).
* Procedure per capture: rest 3 s, then 5 reps over the known ROM with a deliberate pause of about 1 s at the top and
  about 1 s at the bottom, smooth ~1.5 to 2 s up and ~1.5 to 2 s down. Finish with 3 s still.
* ROMs: 20, 40 and 60 cm (3 ROMs x 2 captures = 6 captures; more if time allows).
* Fields: Exercise `stack_vertical`, Load = the stack weight in kg, Known ROM = 20 / 40 / 60 (measured), Notes
  `deliberate pause 1 s`, the machine, and the mounting position.
* Files: `stack20_pause_1.csv`, `stack20_pause_2.csv`, `stack40_pause_1.csv`, ... `stack60_pause_2.csv`.

## E. Weight-stack vertical test (normal tempo, no deliberate pauses)

* Same setup, ROMs and measurement as D (40 cm is the most important, 20 and 60 if time allows).
* Procedure per capture: rest 3 s, then 5 reps at a normal training tempo, with no intentional pause (natural
  reversal only), same ROM each rep, 3 s still at the end.
* Fields: Exercise `stack_vertical`, Load, Known ROM, Notes `normal tempo, no pause`.
* Files: `stack40_tempo_1.csv`, `stack40_tempo_2.csv`, `stack20_tempo_1.csv`, `stack60_tempo_1.csv`.
* Gives: how much accuracy is lost when the pauses that zero-velocity updates rely on are missing.

## F. Barbell vertical test

* Setup: empty bar (or lightest bar) on a rack, sensor magnet-mounted on the bar sleeve or bar, orientation noted.
  Reference: two rack holes / tape marks at a known height difference (measure with a tape measure, e.g. 30 and 50 cm).
* Procedure per capture: bar on the rack, rest 3 s, lift the bar from the lower reference to the upper reference
  and back with a ~1 s pause at the top and bottom, 5 reps (or 3 if the arm is tiring), rest 3 s at the end, rack the bar.
  Do not do this with load, and do not walk or bump the rack during the rest periods.
* Fields: Exercise `barbell_vertical`, Load (bar weight), Known ROM = the height difference in cm, Notes mounting and `pause 1 s`.
* Files: `bar30_1.csv`, `bar30_2.csv`, `bar50_1.csv`.
* Gives: the free (unguided) case with sway and tilt, to compare with the guided stack.

## Suggested order and minimum set

1. A (4 captures), B (4), C (3): about 20 minutes, no gym needed.
2. D at 40 cm (2 captures), then E at 40 cm (2 captures): the most informative gym test.
3. D at 20 and 60 cm, E at 20 / 60 cm, F: if time allows.

Send A, B, C, D40, E40 first; the architect can evaluate the decision gate from those.
