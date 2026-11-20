# data/recordings

All recordings used by the tools and the offline experiments. Layout:

| Folder | Content | Written by |
|---|---|---|
| `serial-legacy/` | USB-serial raw logs (`accel_plot_NNN.csv`, ...) | `tools/serial/*` (default path of `liftiq_serial.start_csv_log`) |
| `app-sessions/` | CSV exported from the phone app History page | you (move the downloaded files here) |
| `raw/` | Raw 6-axis Lab captures (Raw CSV v1) | you (save the Lab downloads here); `tools/trajectory` reads them and writes plots to `raw/analysis/` (git-ignored) |

## serial-legacy/

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

## app-sessions/

CSV files exported from the phone app (**History → ↓ CSV**), one per saved set,
named `liftiq-<date>-<id>.csv`. Different format from the tool recordings above:

Columns: `elapsed_s,ax_m_s2,ay_m_s2,az_m_s2,total_accel_m_s2,dynamic_accel_m_s2,phase,phase_id,rep_count,seq,actual_rep_count[,arrival_s]`

- Acceleration is in **m/s²** and includes gravity (the tool recordings above use g).
- `seq` is the unwrapped firmware sample counter; a step greater than 1 is a
  lost BLE packet. In files recorded before Batch 2b `elapsed_s` is the phone's arrival time, so notifications that
  arrive in a batch share a timestamp - use `seq` for ordering. From Batch 2b `elapsed_s` is sensor time
  `(seq - firstSeq) / 50` and the final `arrival_s` column holds the phone arrival time.
- `actual_rep_count` is the count the user confirmed or corrected after the set
  (the same value on every row); `rep_count` is the sensor's live count.
- Range: files recorded before firmware Batch 2a are +/-2 g and can clip near
  19.6 m/s² (the first recording peaked at 19.78 m/s² total). Firmware from
  Batch 2a onward is +/-8 g (about 78.5 m/s² full scale) at a 100 Hz IMU rate,
  50 Hz notifications.

## raw/

Raw 6-axis captures from the app **Lab** page (CSV "Raw CSV v1": `# key: value` header lines such as
`sample_rate_hz`, `accel_range_g`, `gyro_range_dps`, `gyro_bias_dps`, `gravity_ms2`, `known_rom_cm`, then the
column row `t_s,ax,ay,az,gx,gy,gz`). Accel in m/s^2, gyro in deg/s, converted from the raw counts with the bias NOT subtracted,
`t_s` from the IMU SENSORTIME. Convention: save the files the app downloads (`liftiq-raw-<date>-<id>.csv`) into this folder.
