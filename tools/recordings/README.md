# recordings

Raw sensor logs from `imu_cube_view.py`, `rep_counter.py`, and
`accel_plot.py` (all default `--log`/`LOG_TO_CSV` on). Auto-numbered per
tool: `<tool>_001.csv`, `<tool>_002.csv`, ... A new file starts every time
the script launches, and again every time you press `r` to re-zero
(keeps timestamps monotonic within a file).

Columns: `t,ax,ay,az,gx,gy,gz` — elapsed seconds since that file started,
raw (unsmoothed) accel in g, raw gyro in deg/s. This is the same raw
stream each tool reads live, so any of these files can be replayed
offline to re-tune thresholds/smoothing/filters without needing the
device connected.

These are currently committed to the repo as test fixtures rather than
gitignored — reconsider that if this folder grows large.
