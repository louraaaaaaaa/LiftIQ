# LiftIQ development tracker

Single source of truth for what has been decided, what is being built, and what
is planned. Architecture decisions are made in chat between the user and the
architect (Claude); implementation is delegated to agents. Every agent must
update this file when it finishes work.

## Fixed constraints (prototype hardware is built — do not redesign)

- XIAO ESP32C3 + GY-BMI160 (I2C, SDA=GPIO6/D4, SCL=GPIO7/D5, addr 0x68) + 330 mAh LiPo.
- Custom PCB already built. Battery divider midpoint is wired to **D3 = GPIO5 (ADC2_CH0)**, which cannot be read in software on the ESP32-C3; a jumper from the D3 pad to **D1 = GPIO3 (ADC1_CH3)** is required (`BATTERY_PIN_BODGE_D1`).
- DFRobot_BMI160 library stays for now (fixed +/-2 g range).
- BLE only; phone app is the Web Bluetooth PWA in `app/` (`app/stable` released, `app/dev` development). Capacitor/native wrapper is a later decision.

## Rules (apply to every agent and every change)

1. **Before declaring any firmware or app change done, run `cd app && npm run test:all`** (dev + stable unit tests, `tests/compat`, python tool tests). For firmware changes also compile: `arduino-cli compile --fqbn esp32:esp32:XIAO_ESP32C3 --warnings all firmware/LiftIQ_BLE` (flags `DEBUG_SERIAL_STREAM`, `DEBUG_DIAG`, `DEBUG_PROTOCOL_SELFTEST` at 0 and 1) with no warnings from our files.
2. **Firmware changes must keep `tests/compat` green.** Any firmware version must keep working with the latest STABLE app and older stable releases (`docs/PROTOCOL.md`): additive changes only, new data on new characteristics, experimental features dormant unless invoked, breaking changes only with a new protocol major, a parallel v1 path and the user's explicit approval.
3. **`app/stable/` changes only through `node tools/release-app.mjs`** (run with `--dry-run` first; it never commits or pushes). Do not hand-edit `app/stable`, and never point the Pages workflow at `app/dev`.
4. Golden vectors (`tests/compat/golden/v1_vectors.json`) may be extended, never edited. If `protocol_v1.h` changes the encoder output, regenerate `protocol_v1_selftest_vectors.h` with `node tests/compat/tools/gen-selftest-header.mjs`.
5. Touching packet encoding: run `tools/ble/check_protocol_serial.py` on the real board (flash with `DEBUG_PROTOCOL_SELFTEST 1`, then back to 0) before calling it verified.
6. Update this file (tracker row + change log with files touched / verified / unverified) when you finish.

## Status legend

`DONE` implemented and verified as far as possible without hardware ·
`IN PROGRESS` · `PLANNED` · `IDEA` (not committed to)

## Batch 1 — correctness and protocol foundations — DONE (pending hardware verification)

| # | Item | Status |
|---|------|--------|
| 1.1 | Battery pin: firmware `PIN_BATTERY` must be GPIO5 (D3), matching PCB, comments and docs. Average several ADC reads. | DONE (firmware not compiled; no hardware test) |
| 1.2 | Unique device name `LiftIQ-XXXX` (last 2 MAC bytes); app finds sensors by service UUID / `LiftIQ` name prefix, still accepts legacy `GymIQ Sensor`. | DONE (firmware not compiled; no hardware test) |
| 1.3 | Repurpose the reserved int16 at bytes 10-11 of the 18-byte packet as a wrapping uint16 sample sequence counter (packet stays 18 B for the default 23-byte MTU). App unwraps it, counts dropped packets, stores `seq` in CSV. | DONE (firmware not compiled; no hardware test) |
| 1.4 | App: read the notify characteristic once before stopping so the final rep count is authoritative. | DONE (firmware not compiled; no hardware test) |
| 1.5 | App: Screen Wake Lock during a set. | DONE (firmware not compiled; no hardware test) |
| 1.6 | App: pausing must not let reps counted during the pause leak into the saved count (decide and document the chosen behaviour). | DONE (firmware not compiled; no hardware test) |
| 1.7 | Firmware: gate the 100 Hz serial plotter stream behind a `DEBUG_SERIAL_STREAM` flag (default off) — keep `tools/` working when it is on. | DONE (firmware not compiled; no hardware test) |

Decisions recorded while implementing Batch 1:

- **Sequence counter (1.3):** bytes 10-11 are a uint16 incremented once per notification actually sent, calibration status packets included (they share the sender). The app unwraps it across the connection (reset on connect/disconnect), counts gaps (`delta - 1`) as dropped packets in `session.droppedPackets` only while recording, and writes the unwrapped value to the CSV `seq` column. 16-byte legacy packets decode with `seq: null`. The Python `tools/firmware_debug.py` still reads these bytes as an ignored signed int16 and keeps working.
- **Pause (1.6):** reps are physical, so the sensor keeps counting while the app is paused. The app tracks the firmware count live (shown on screen), does not log samples while paused, and the saved/confirmed count on resume or stop is the firmware count. Pause only pauses CSV sampling and the elapsed-time label. UI text states this.
- **Final count (1.4):** `stopSession` does one `readValue()` (only if still connected, failures ignored) and uses its `repCount`. Not possible after a disconnect; the last notified count is used then.
- **Wake lock (1.5):** acquired when calibration completes and the set starts recording; released on stop, disconnect and cancel; re-acquired on `visibilitychange` while recording/paused. Unsupported/denied shows a non-blocking message.
- **Name filters (1.2):** `DEVICE_FILTERS` = service UUID, `namePrefix: "LiftIQ"`, exact `GymIQ Sensor`. `DEVICE_NAME` export removed; `DEVICE_NAME_PREFIX` and `LEGACY_DEVICE_NAME` replace it.
- **Debug stream (1.7):** `DEBUG_SERIAL_STREAM` (default 0) gates the plotter stream, 1 Hz battery line, phase/rep banners and the plotter header. Boot messages, BLE connect/disconnect and command logs remain.

## Batch 1.5 — first on-device test fixes + app rework — DONE (pending on-device verification)

Found in the user's first test (localhost, LiftIQ-C846): live accel works, but
(a) Start set → firmware calibrated and counted reps, yet the app showed "Calibration timed out", state fell back to idle, and Pause/Stop were disabled (no way out); (b) battery stayed "—% / Waiting for sensor data".

Diagnosis (architect): calibration completion depends on ONE unacknowledged notification (status byte is a transient event). If it is lost, the app and firmware disagree forever and the app state machine has no escape. Battery: the app only accepts `mV > 0`, so a 0 mV reading (no LiPo attached / divider unpowered / ADC2 read failing) is indistinguishable from "no data".

| # | Item | Status |
|---|------|--------|
| 1.8 | Firmware: calibration status becomes persistent state carried in byte 13 of EVERY packet (0 none, 1 calibrating, 2 calibrated/tracking, 3 failed); set to 1 immediately in the BLE write callback. App derives calibration from any packet, so one lost packet cannot desync. | DONE (unverified: no compile, no hardware, no browser) |
| 1.9 | Firmware: calibration becomes non-blocking (state machine in loop, ~5 s, telemetry keeps flowing with status 1). | DONE (unverified: no compile, no hardware, no browser) |
| 1.10 | App: rewrite the session state machine explicitly (idle → calibrating → recording ⇄ paused → reviewing → saving); Stop/Cancel always reachable; timeout recovery; unit tests with a fake BLE client. | DONE (unverified: no compile, no hardware, no browser) |
| 1.11 | Battery: distinguish "waiting", "0 V / no battery detected (USB powered?)" and valid; show raw mV; firmware prints a boot-time and a periodic zero-reading warning even with DEBUG_SERIAL_STREAM=0. | DONE (unverified: no compile, no hardware, no browser) |
| 1.12 | App: Debug panel (raw packet hex, packet rate, drops, calibration status, state) + console logging of state transitions. | DONE (unverified: no compile, no hardware, no browser) |
| 1.13 | App: split app.js into modules, redesign the layout (keep colour scheme only), no build step. | DONE (unverified: no compile, no hardware, no browser) |

Decisions recorded while implementing Batch 1.5:

- **Byte 13 (1.8):** persistent calibration state in every packet: 0 none, 1 calibrating, 2 calibrated/tracking, 3 failed. Set to 1 inside the BLE write callback; the next sample bypasses the 20 ms throttle (`forceNextNotify`) so the change is visible immediately. The special status-packet path and `notifyCalibrationStatus` are gone. Packet length and seq semantics unchanged.
- **Firmware calibration (1.9):** `startCalibration` / `updateCalibration` / `finishCalibration` run from `loop()` with the normal sample reads: samples after the first 500 ms are averaged until 5 s. Telemetry (real accel, status 1, reps 0) keeps streaming. 0 valid samples (including a dead IMU) -> status 3. `repTrackingEnabled` only becomes true together with status 2.
- **Battery (1.11):** boot-time print of pin mV and estimated cell (always, even with `DEBUG_SERIAL_STREAM 0`), a read at boot so packet 1 already carries a value, and a zero-reading warning at most every 10 s. App: `describeBattery` -> waiting / none (0 mV) / ok.
- **App state machine (1.10):** `app/session.js` (`SessionMachine`, no DOM/BLE). States disconnected, idle, calibrating, recording, paused, reviewing, saving; `calibrating` has a `stalled` flag (15 s timeout) instead of a separate state. Calibration is derived from any packet's status byte. A status 2 counts only if status 1 was seen since the start command OR >= 4 s elapsed (guards against a stale 2 from the previous calibration). After a timeout, a later status 2 sets `canContinue` and the UI offers "Continue set"; Retry and Cancel are always available. Stop is labelled Cancel during calibration.
- **Deviation:** notifications now stay enabled for the whole connection (previously stopped on set stop) so battery and calibration indicators stay live between sets. The old modal calibration countdown was replaced by an inline panel with a progress bar, so Stop/Cancel is never hidden behind a dialog.
- **Debug (1.12):** collapsed panel on the Sensor page (state, firmware status, rate, total/dropped/invalid, battery mV, last packet age and hex); state transitions go to `console.debug`.
- **Modules (1.13):** `protocol.js` (exports kept, additions `describeBattery`, `packetToHex`, `calibrationCode`), `packet-stats.js`, `session.js`, `ble.js`, `storage.js`, `chart.js`, `ui.js`, `wakelock.js`, `app.js` (wiring). Layout: Workout / History / Sensor bottom nav, sticky Pause/Stop bar on mobile, header connection + battery chips. Colours unchanged. `sw.js` APP_FILES updated, cache `liftiq-app-v11`.

## Batch 2a — first-test findings: battery ADC, accel range, sample rate — IMPLEMENTED (needs hardware verification)

| # | Item | Status |
|---|------|--------|
| 2.1 | Battery ADC robustness: try `analogReadMilliVolts` -> `analogRead` (nominal scale, 12 dB set explicitly) -> ESP-IDF `adc_oneshot` (+ calibration if possible); retry zero reads; remember/print the working path; always-on `[DIAG]` line every 5 s. | DONE (not compiled, not run on hardware) |
| 2.2 | BMI160 range +/-8 g (ACC_RANGE 0x41 = 0x08, 4096 LSB/g) and ACC_CONF (0x40 = 0x28, normal filter, 100 Hz) written directly, read back and printed at boot; clip counter in `[DIAG]`. | DONE (not compiled, not run on hardware) |
| 2.3 | Deterministic cadence: IMU polled on a fixed 100 Hz micros() schedule, notification every 2nd sample (50 Hz), direct I2C reads at 400 kHz; loop Hz / notify Hz in `[DIAG]`. | DONE (not compiled, not run on hardware) |
| 2.4 | Housekeeping: app README rewrite, recordings README (`app-sessions/`), `tools/firmware_debug.py` fix for persistent status byte, docs for +/-8 g and battery paths. | DONE (python tests pass: 9) |

Decisions and evidence for Batch 2a:

- **Root cause of ~27 Hz (2.3) found in the DFRobot library source** (`~/Documents/Arduino/libraries/DFRobot_BMI160/DFRobot_BMI160.cpp`, `I2cGetRegs`): every register read does `delay(10)` between the address write and `requestFrom`, then `delay(1)` after EACH byte. `getAccelGyroData` reads 12 bytes (gyro+accel), so one sample took about 10 + 12 ms plus the sketch's own `delay(10)` = a ~30-37 ms loop. With the old 20 ms throttle every loop iteration therefore sent a notification, i.e. the notify rate equalled the loop rate (~27 Hz measured). The firmware now reads the 6 accel bytes itself in one repeated-start transaction (no delays), at 400 kHz. The library is still used for `I2cInit` (reset + default config). The library only writes config in `I2cInit`/`setSensConf`, so our ACC_CONF/ACC_RANGE writes after init persist.
- **Consequence for the rep detector (open decision):** the thresholds and sample-count constants (`MOTION_ONSET_SAMPLES = 4`, `PHASE_FILTER_ALPHA = 0.25`, `MIN_PHASE_SIGNAL_MS`, ...) were tuned at ~27 Hz effective sampling. At 100 Hz the same sample counts are 3-4x shorter in time and the per-sample low-pass is faster. Rep counting (6/6 in the first test) must be re-validated; Batch 3 should make these time-based.
- **ACC_CONF 0x28 = 100 Hz ODR, normal filter:** matches the datasheet reset value (BMI160 datasheet 2.11.11). Previously the library ran the accelerometer at 1600 Hz ODR with 4x averaging and the sketch polled it at ~27 Hz (aliasing). At ODR 100 Hz polled at 100 Hz the reads are not phase-locked to the IMU, so an occasional sample can be repeated or skipped; true IMU-clocked reads (data-ready/FIFO) stay in Batch 2. The normal filter at 100 Hz attenuates content above roughly 40 Hz, which is above lifting motion but affects impact spikes.
- **Range (2.2):** +/-8 g = 4096 LSB/g (datasheet table), ACC_RANGE 0x08. Packet encoding is int16 of m/s^2 x 100 (max 327.67), so +/-8 g (78.5 m/s^2 per axis, about 136 m/s^2 vector) fits. Thresholds/units unchanged. Gyro stays powered by the library (current draw; not addressed).
- **Battery (2.1) - SUPERSEDED by the verified root cause in Batch 2b below; kept for history. What was believed then:** the first test showed 0 mV on path A while a multimeter read 2.02 V, so the hardware is fine. From the local core 3.3.12 source: `analogReadMilliVolts` silently returns 0 when its eFuse-calibration scheme cannot be created or `adc_oneshot_get_calibrated_result` fails (errors are only `log_e`), and the IDF header for the curve-fitting scheme documents `ESP_ERR_NOT_SUPPORTED` when the required eFuse bits are not burnt. That is a plausible but UNCONFIRMED cause of the 0 mV. I could not find, in the local sources, a statement that ADC2 oneshot is unreliable on the C3 while BLE is active, so none is claimed. Workaround implemented anyway: the battery read happens on a non-notify sample slot (best effort), three read paths with 2 retries on 0, plausibility window 300-3500 mV at the pin, path C only after A and B failed three times (it takes the ADC unit over from the Arduino core and disables A/B afterwards). Paths B and C without calibration convert raw with a NOMINAL 3100 mV full scale (`ADC_RAW_FULLSCALE_MV`), which is unverified: compare the printed raw value to the multimeter (2.02 V) and correct the constant.
- **Always-on diagnostics:** boot lines `[BATTERY] boot: ...` and `[IMU] ... ACC_CONF ... ACC_RANGE ...`, then every 5 s `[DIAG] loop=..Hz notify=..Hz i2c_us avg/max i2c_err clip range batt_path A(...) B(...) C(...) pin_mv cell_mv cal rep conn`. With `DEBUG_SERIAL_STREAM 1` these lines are interleaved with the plotter stream; the serial plotter tools may need to ignore lines starting with `[`.
- **Physical fallback (only if all software paths fail):** solder a bodge wire from the divider midpoint to D1/GPIO3 (ADC1_CH3) and set `PIN_BATTERY = 3`. ADC1 is the Seeed-recommended unit. Do not do this before the `[DIAG]` output has been checked.
- **Python dashboard (2.4c):** `tools/firmware_debug.py` treated every packet with a non-zero status byte as a calibration event and discarded its sample, so with the persistent status byte (2 in every packet after calibration) it would have shown no data. It now emits calibration events only on status change and always emits the sample; it also parses `seq` (unsigned, 18-byte packets only). Two tests added.

## Batch 2b — hardware results: ADC2 unusable, sensor-time CSV — IMPLEMENTED (needs hardware verification of the jumper path)

Verified on hardware after Batch 2a (replaces the 2a hypotheses):

- Serial: loop = 100.0 Hz, I2C avg ~271 us / max ~430 us, i2c_err = 0 (400 kHz works), range +/-8 g, clip = 0.
- CSV `data/recordings/app-sessions/liftiq-2026-11-20-3979b0d1.csv`: 967 rows in 19.3 s = 50.2 Hz, seq deltas all 1 (no loss), 8 of 8 reps counted correctly at the new 100 Hz sampling, peak 29.1 m/s^2 = 2.97 g (would have clipped at +/-2 g). Only 658 unique `elapsed_s` of 967 rows = arrival-time batching in the app (fixed by 2.6).
- **Battery root cause:** ESP-IDF logs `adc_oneshot_new_unit: adc unit not supported` (error 258 = ESP_ERR_NOT_SUPPORTED) for ADC2. `analogReadMilliVolts` and raw `analogRead` both return 0 on GPIO5; the multimeter shows 2.02 V there. ADC2 oneshot is not supported on the ESP32-C3 in this core (IDF 5.x), so D3/GPIO5 can never be read in software. Path C (adc_oneshot) also spammed about 13 error lines per cycle.

| # | Item | Status |
|---|------|--------|
| 2.5 | Battery: path C and all ADC2 access removed; D1/GPIO3 (ADC1) read via a jumper from D3. (The `BATTERY_PIN_BODGE_D1` switch and the B path introduced here were removed again in 2.7.) App 0 mV text: "no battery detected (running from USB, or battery sense not wired?)". | DONE and verified on hardware (A: 2072 mV at pin, cell 4144 mV on USB charge) |
| 2.6 | App sample time: `NOTIFY_HZ = 50` (must match firmware); CSV `elapsed_s` = `(seq - firstSeq) / 50`, new last column `arrival_s`; legacy 16-byte packets fall back to arrival time. | DONE (unit tested; not tried on a device) |

Jumper procedure (closes the battery known issue): check D1 (GPIO3) is unused on the custom PCB, solder a wire from the D3 pad to the D1 pad on the XIAO, leave `BATTERY_PIN_BODGE_D1 1`, reflash, read the `[BATTERY] boot: pin D1/GPIO3 ...` line (expect pin about 2020 mV, cell about 4040 mV). Nominal-scale paths B use `ADC_RAW_FULLSCALE_MV = 3100` (unverified); path A is calibrated on ADC1. Note: the status-change forced notification can add up to one extra packet around calibration (an extra seq step of its own, not a loss); this is fine and keeps seq contiguous.

### Batch 2c — firmware cleanup

Hardware-verified after 2b: `[BATTERY] boot: pin D1/GPIO3 path=A A(mv=2072) B(raw=2841 mv=2150) estimated cell=4144 mV` (cell on USB charge), `[IMU] chip=0xD1 ACC_CONF=0x28 ACC_RANGE=0x08 ERR=0x00 PMU=0x14`, loop 100.0 Hz, i2c_err=0. Note: the user wrote the wire goes "only to gpio4" while the firmware reads GPIO3 and gets a correct value, so GPIO3/D1 is the proven pin; the user should confirm which pad the wire is soldered to.

| # | Item | Status |
|---|------|--------|
| 2.7 | Remove obsolete firmware code without changing runtime behaviour, packet, UUIDs, thresholds or timing: battery reduced to `PIN_BATTERY = 3` + `analogReadMilliVolts` (average, 2 retries on 0, plausibility window, boot line, throttled 0-mV warning kept); `BATTERY_PIN_BODGE_D1`, path B, `ADC_RAW_FULLSCALE_MV`, path bookkeeping, BatteryPath/BatteryReading types, esp_adc/esp_system includes, unused `lastBleNotifyTime` and global `pWriteCharacteristic`, duplicate `setMinPreferred(0x06)`, velocity/speed remnants (header text and `VelocityEstimate:NA` field of the plotter stream) removed; `[DIAG]` and its counters are opt-in via `#define DEBUG_DIAG 0`; `addDescriptor(new BLE2902())` only under `CONFIG_BLUEDROID_ENABLED` (this core's NimBLE auto-creates the 0x2902 CCCD for NOTIFY characteristics, confirmed in `BLECharacteristic::addDescriptor`; removes the deprecation warning). | DONE (compiles, 4 variants; not re-tested on hardware) |

Skipped on purpose: dropping the DFRobot_BMI160 dependency (own init over Wire). The library's init performs the soft reset, power-mode commands and the waits that lead to `PMU=0x14`; reproducing it needs the exact datasheet timing for accel and gyro power-up and can only be validated on the device, and the gyro must stay powered for Batch 3. Risk/benefit not worth it now. Gyro stays powered by the library.

## Batch 2 — resilience — PLANNED

- Auto-reconnect + resume the set when BLE drops (firmware keeps the rep count).
- Non-blocking calibration state machine in firmware; calibration result must not depend on one unacknowledged notification (status readable / repeated).
- Fixed, IMU-clocked sample rate (explicit BMI160 ODR, data-ready check) instead of `delay(10)`.

## Batch 3 — algorithm — PLANNED

- Extract the rep detector into a dependency-free C++ header; host unit tests replaying `data/recordings/**/*.csv` and app-exported CSVs.
- Rep detector is now sample-rate independent (onset window 150 ms, phase low-pass tau 110 ms with real dt; other timers were already ms-based) - replaces the open 100 Hz regression risk from Batch 2a; still to be re-validated on hardware.
- Handle continuous / touch-and-go reps (no 300 ms rest dwell required), slow tempo reps (lower effective onset), and exercises that start with the eccentric.
- Use the gyro (complementary/Madgwick) to track gravity during the rep.
- Verify actual accelerometer range vs. the 3 g peaks seen in recordings.

## Batch 4 — effort metrics — PLANNED

- Per-rep BLE event packet (rep #, duration, concentric/eccentric time, peak accel).
- Zero-velocity-update velocity per rep: mean concentric velocity, velocity loss across the set.
- App: load (kg) field, per-rep and per-set summary, signed projected-axis chart.

## Step 0 — raw 6-axis capture + offline trajectory experiment — IN PROGRESS

Goal: find out how good per-rep 3D/vertical reconstruction can get with the CURRENT BMI160 before choosing new hardware (decision gate: per-rep vertical ROM error vs a tape-measured ROM; ~2 cm = software is enough).
Architecture decisions (architect):
- "Research capture" mode, separate from the normal live set mode (live telemetry/rep counting stays unchanged).
- Firmware records raw accel+gyro on-device into RAM at a fixed 200 Hz (BMI160 ODR 200 Hz, accel ±8 g, gyro ±1000 °/s, burst read incl. SENSORTIME), cap ~40 s, then uploads it AFTER the set over a NEW notify characteristic with chunk sequence numbers and resend requests — no loss, independent of BLE live bandwidth.
- App gets a "Lab" page: metadata (exercise, load, known ROM cm, notes), arm/calibrate (5 s rest → gyro bias + gravity), record, stop, download progress, save raw CSV.
- Python tooling in tools/trajectory/: orientation fusion, zero-velocity updates, drift removal, per-rep ROM/velocity, 3D plots, ablations, synthetic-data tests. Protocol for the physical experiments in docs/experiments/STEP0_PROTOCOL.md.
- Raw CSV v1 format is the contract between app and Python tools (see below).

Raw CSV v1: header comment lines `# key: value` (format=liftiq-raw v1, fw_version, device_name, app_version, captured_at, sample_rate_hz, accel_range_g, gyro_range_dps, accel_units=m/s^2, gyro_units=deg/s, gyro_bias_dps=x;y;z, gravity_ms2=x;y;z, rep_count_firmware, dropped_chunks, exercise, load_kg, known_rom_cm, notes), then column row `t_s,ax,ay,az,gx,gy,gz`. Values are RAW converted to units (bias NOT subtracted); t_s from the IMU SENSORTIME, seconds from first sample.

| # | Item | Status |
|---|------|--------|
| S0.1 | Firmware raw capture + chunked upload (new commands 0x10-0x15, new RAW notify characteristic) | DONE; first capture verified on hardware (3263 samples in 16.31 s = 200 Hz, 0 dropped chunks); S0.1b memory fix below not yet re-tested |
| S0.2 | App Lab page, download with resend, raw CSV export | DONE; first capture downloaded and parsed by the Python tools; stream v2 parser unit tested only |
Research-capture protocol as implemented (S0.1/S0.2):

- RAW characteristic `5c0de0a1-7b3e-4f0a-9b6e-2d1c8a52f001` (READ + NOTIFY) in the existing service. Control commands on the existing write characteristic: `0x10` ARM (allocate buffer, rest 5 s -> gyro bias + gravity), `0x11` START, `0x12` STOP (also aborts ARMING), `0x13` DOWNLOAD, `0x14` RESEND `[u16 firstChunk][u16 count]`, `0x15` ERASE/abort. `0x01` (normal set) is ignored while a capture is arming/capturing/uploading; the app also blocks both ways.
- Chunk: `[type u8][chunkIndex u16 LE][len u8][payload]`. Types: `0x01` STATUS (also the READ value; every 500 ms while idle and on every state change; payload state u8 [0 idle,1 arming,2 armed,3 capturing,4 ready,5 uploading,6 error], errorCode u8 [1 no memory, 2 bad command], armPercent u8, flags u8 [bit0 capacity reduced by heap, bit1 auto-stopped at cap], sampleCount u32, capacitySamples u32), `0x02` DATA, `0x03` INFO and `0x04` DONE (payload `P u16, totalChunks u16, totalBytes u32`; INFO opens an upload, DONE closes every (re)send so the app can count missing chunks).
- Upload stream (cut into DATA chunks of P bytes, index = byte offset / P): `[headerLen u16][header][blocks]` (stream version 2). header = version u8 (2), sampleCount u32, rateHz u16, accelRangeG u8, gyroRangeDps u16, blockSamples u8 (25), gyroBias f32 x3 (deg/s), gravity f32 x3 (m/s^2), repCount u16, sensortimeBase u32, fwLen u8 + fw string. A block = `[24-bit SENSORTIME u32 of its first sample][up to 25 samples x 12 B]`, a sample = gyro XYZ int16 + accel XYZ int16 (12.16 B/sample incl. block headers; was 14 B with a per-sample SENSORTIME). P = min(MTU - 7, 180) with the MTU learned from `onMtuChanged` (firmware asks for MTU 247 via `BLEDevice::setMTU`; the default MTU 23 gives P = 16).
- Pacing: up to 3 chunks per loop iteration; NimBLE reports a failed send through `BLECharacteristicCallbacks::onStatus`, in which case the same chunk is retried on the next iteration (no skipping). Live telemetry notifications are paused while uploading. Data stays in RAM until ERASE; a disconnect during upload returns the state to READY so the app can resume with RESEND.
- IMU: gyro always configured at boot (GYR_CONF 0x29 = 200 Hz normal filter, GYR_RANGE 0x01 = +/-1000 dps, 32.8 LSB/dps; read back and printed in the `[IMU]` line). Accel ODR is switched to 200 Hz (ACC_CONF 0x29) from ARM until STOP and restored to 100 Hz (0x28) afterwards, so live mode is unchanged outside a capture. ONE reader: while arming/capturing the loop polls a 15-byte burst (0x0C..0x1A) every 5 ms; every 2nd burst feeds the unchanged 100 Hz live pipeline (battery reads are skipped meanwhile). Buffer allocated at ARM with `heap_caps_malloc`; capacity = min(40 s, what fits in the largest free block minus 256 B, what leaves `RAW_HEAP_RESERVE` = 20 KB of total free heap), reported in STATUS and printed. The capture auto-stops at the cap. The first 100 ms after START (20 samples, `RAW_START_DISCARD_SAMPLES`) are DISCARDED (filter-settling transient): `t_s` = 0 is the first stored sample, i.e. about 100 ms after the Start press.
- Because the loop polls at 200 Hz without being phase-locked to the IMU clock, an occasional poll may duplicate or skip a sample. With the block format `t_s` is the IMU SENSORTIME at each 25-sample block start (unwrapped 24-bit x 39.0625 us) plus nominal 5 ms steps inside the block, so such single-sample timing glitches are no longer individually visible (they appear as a time error of at most a few ms that is reset at the next block). In the measured capture dt was a constant 5.0 ms with 2 outliers.
- Upload time estimate (NOT measured): a 40 s capture is about 97,300 bytes (8000 samples in 320 blocks). At MTU 23 (P = 16): about 6,100 chunks; at an assumed 60-120 notifications/s that is roughly 50-100 s. At MTU >= 187 (P = 180): about 540 chunks, a few seconds (assumed 100-300 notifications/s). Actual rates depend on the phone connection interval.
- Raw CSV v1 header lines are written as `# key: value` with `format` = `liftiq-raw v1`; `dropped_chunks` = chunks that needed a resend after the first full pass; `t_s` = IMU time since the first stored sample as described above.

| S0.3 | tools/trajectory Python analysis + synthetic tests | IN PROGRESS |
| S0.4 | docs/experiments/STEP0_PROTOCOL.md (physical experiment protocol) | IN PROGRESS |
| S0.5 | User runs the experiments, shares raw CSVs; architect evaluates the decision gate | IN PROGRESS (first capture received) |

First real capture (2026-11-20, data/recordings/raw/liftiq-raw-2026-11-20-364b2a76.csv, hand rotation test, no ground truth): capture chain verified on hardware — 3263 samples / 16.31 s = 200.0 Hz, dt 5 ms, 0 dropped chunks, CSV parses in Python. Findings: (1) ARM capacity was only 4680 samples (23.4 s) vs the 40 s target (heap margin) — under investigation; (2) real still-data gyro scatter and accel spikes are larger than the synthetic noise model, so the synthetic-tuned stationary detector found 0% stationary — pipeline being made robust (despiking, robust thresholds, quietest-window noise estimate); (3) gravity magnitude 10.11–10.14 m/s² (+3%) → accel offset/scale error, a 6-position calibration tool is planned; (4) gyro integration tracked a 90–110° rotation consistently with accel tilt; baseline drift ~5° over 16 s without accel correction.

## Repo structure + release model — DONE (needs a first push to prove the workflows)

| # | Item | Status |
|---|------|--------|
| R1 | Folder reorganisation: `firmware/LiftIQ_BLE`, `app/{dev,stable}`, `data/recordings/{serial-legacy,app-sessions,raw}`, `hardware/pcb/v1/{gerbers,flatcam}` + `pcb/README.md`, `tools/{serial,ble,trajectory}`, `docs/{experiments,references}`; all references, scripts defaults and docs updated; `.gitignore` extended | DONE except two items the OS locked (see change log: root PDF copy, empty `firmware/current/`) |
| R2 | `app/stable` = the app live on Pages (commit `a81fe00`), unchanged except `VERSION` 1.0.0; own tests; SW cache `liftiq-app-v11` untouched | DONE (byte-compared against `git show a81fe00:app/...`, see change log) |
| R3 | `app/dev` visibly distinct (title/manifest "LiftIQ Dev", purple theme + icon, DEV badge, `liftiq-dev-` SW cache, `1.1.0-dev`); degrades gracefully against older firmware (no RAW/INFO characteristic) | DONE (unit tested with a fake GATT; not tried in a real browser) |
| R4 | `app/package.json` scripts (`start`, `start:stable`, `test`, `test:stable`, `compat`, `test:tools`, `test:all`, `release`); `dev-server.mjs <dir> <port>` | DONE |
| R5 | Release tool `tools/release-app.mjs` (tests, clean-stable check, channel rewrite, SW cache bump, verification, `--dry-run`, no commit/push); procedure in `app/README.md` and `docs/ARCHITECTURE.md` | DONE (exercised on a temp copy incl. real run, dirty/old-version refusals; never run on the real `app/stable`) |
| R6 | Pages workflow publishes only `app/stable` (paths filter + workflow_dispatch + dev-build guard) | DONE (not run on GitHub) |
| R7 | `docs/PROTOCOL.md`: frozen v1 contract, behavioural guarantees, extension rules, feature lifecycle | DONE |
| R8 | INFO characteristic `...f002` (protocol 1.1, capabilities, fw string): firmware + dev app (shown on Sensor page); stable ignores it | DONE (host-tested encoder + decoder; firmware not run on hardware) |
| R9 | `firmware/LiftIQ_BLE/protocol_v1.h` pure encoders used by the sketch (`encodeTelemetryV1`, `encodeInfoV1`); FW version `liftiq-fw s0.3` | DONE (host test = golden bytes; arduino-cli compile results in the change log; not run on hardware) |
| R10 | `tests/compat/` golden vectors, stable+dev decode tests, host-compiled firmware encoder test, behavioural tests on the stable `SessionMachine`, constants guard | DONE |
| R11 | `.github/workflows/compat.yml` (node + python tests, no Arduino toolchain) | DONE (not run on GitHub; python job needs tkinter via apt, unverified) |
| R12 | Board self-test: flag `DEBUG_PROTOCOL_SELFTEST` (default 0) + `tools/ble/check_protocol_serial.py` | DONE (script tested against synthetic logs; never run on a board) |

Decisions recorded while implementing the repo structure:

- **Channel design:** `channel.js` (`CHANNEL`, `APP_VERSION`) is the single source of truth in each app. Branding that must be static (HTML title, theme colour, manifest, SW cache, icon file) is rewritten by the release tool from fixed patterns; the tool aborts if a pattern does not match exactly once and verifies the built app contains no dev strings. The DEV badge sits between `<!--dev:start-->` and `<!--dev:end-->` markers in `index.html`.
- **Stable fidelity:** stable's service worker is the original one (activate deletes every other cache). Stable gets the dev service worker (prefix-scoped delete) only through a release, whose first run turns `liftiq-app-v11` into `v12`.
- **Local ports:** dev 8000, stable 8001; different origins, so service workers, caches and IndexedDB never mix. IndexedDB name/version are unchanged in dev (v2 schema) and stable (v1): never serve both from one origin.
- **Dormancy:** nothing in the sketch changed live behaviour; `constants-guard.test.js` pins the 100 Hz / 50 Hz / +/-8 g / ACC_CONF 0x28 live configuration.

## Ideas / undecided

- **v2 hardware / 3D movement reconstruction (discussed 2026-11-20, undecided).** Keep ESP32-C3 + LiPo. The BMI160 already has a gyro, so orientation + a drift-limited per-rep path is possible with the current board; what is missing is a drift-free absolute reference. Key physics: attitude error leaks gravity into the motion signal (1° tilt ≈ 17 mg), accel bias gives ~10 cm error after 2 s per 5 mg. Magnetometer is NOT recommended (magnet mount + steel equipment). Candidate add-ons, in order of value: (1) better 6-axis IMU (ICM-42688-P / LSM6DSV16X / BMI270 — verify datasheets), (2) barometer (BMP581/LPS22HH class, vented enclosure) for drift-free vertical position, (3) time-of-flight ranger (VL53L4CD/L1X) for stack lifts with a clear line of sight, (4) several BLE nodes for body-segment 3D, (5) phone-camera pose fusion. Staged plan: Step 0 log raw 6-axis at 100-200 Hz (batched BLE) and test gyro fusion + zero-velocity updates offline against a measured ROM using existing hardware; Step 1 prototype extra sensors as I2C breakouts on jumper wires before any PCB spin; decision gate on measured per-rep vertical ROM error. Open questions: which exercises (barbell vs stack vs body), "3D" meaning (bar path vs full body), display target.
  - **Decision update (user, same day): IMU-only, optional magnetometer; no baro/ToF/camera.** Research findings: (a) BMI160 gyro is usable; drift is dominated by tilt error + accel bias, which a magnetometer does NOT fix (it only fixes yaw); (b) indoor steel disturbs magnetometers by tens of degrees and the sensor is magnet-mounted, so a magnetometer is not useful in the current mounting; yaw drift over a few-second rep is negligible once gyro bias is calibrated at rest; (c) drift is countered by gyro-bias calibration, 6-axis fusion (gravity-gated accel correction), per-rep zero-velocity updates with drift-function removal, start=end loop closure per rep, exercise constraints (principal axis), and offline backward smoothing; (d) BMI270 vs BMI160 datasheet: accel TCO ±0.25 vs ±1.0 mg/K, gyro zero-rate offset ±0.5 vs ±3 °/s (before compensation), gyro TCO 0.02 vs 0.05 °/s/K, noise about the same — it improves bias stability, not noise; BMI270 needs a config-blob upload at every power-up; (e) reference design: Tiny Open Logger (TOL, UbiComp 2025, XIAO ESP32-C3 + BMI270 + MLX90393 + 1 Gb NAND, CC-BY, github.com/ThumusWasTaken/XiaoMoCap) — a logger with on-board flash (100 Hz 9-axis ≈ 15.8 h), validated only for rotation vs MetaMotionR, not for translation/drift. Next step stays Step 0 (raw 6-axis logging + offline fusion/ZUPT on the current BMI160, measure error against a known ROM) before choosing BMI270 or another IMU.

- Capacitor wrapper (iOS + background BLE) vs native app.
- Battery Service (0x180F) alongside the custom characteristic; non-linear LiPo curve.
- Pairing/security; NimBLE-Arduino; IMU FIFO + INT wake from deep sleep (INT pin must reach GPIO0-5 on a future PCB).
- History storage: keep CSV out of the main IndexedDB record.

### Compiling the firmware (re-run after every firmware change)

```
arduino-cli compile --fqbn esp32:esp32:XIAO_ESP32C3 --warnings all firmware/LiftIQ_BLE
```

Compile-only, never uploads. To check the serial-debug build, compile a copy with `#define DEBUG_SERIAL_STREAM 1` (e.g. `sed 's/^#define DEBUG_SERIAL_STREAM 0/#define DEBUG_SERIAL_STREAM 1/'` into a temp sketch folder named `LiftIQ_BLE`) and leave the committed sketch at 0. The first compile after a core or `--warnings` change builds the whole ESP32 core and takes several minutes. If `arduino-cli` is not on PATH, the Arduino IDE bundles one at `%LOCALAPPDATA%\Programs\Arduino IDEesourcespp\libackendesourcesrduino-cli.exe`. Libraries come from `~/Documents/Arduino/libraries` (DFRobot_BMI160).

## Known issues (open)

First on-device test (2026-11-20, LiftIQ-C846, Batch 1.5 firmware):

1. Batch 1.5 worked: calibration completed, the app went to Recording, and 6/6 reps were counted correctly.
2. Battery: CLOSED by Batch 2b once the jumper is fitted. Cause: ESP32-C3 ADC2 (D3/GPIO5) oneshot is not supported by this core (`adc unit not supported`, ESP_ERR_NOT_SUPPORTED), so the pin reads 0 in software although the multimeter shows 2.02 V. Fix: jumper D3 pad -> D1 pad, firmware reads GPIO3 (ADC1). See Batch 2b.
3. First app CSV (`data/recordings/app-sessions/liftiq-2026-11-20-993c5e0f.csv`, 603 rows, 22.5 s): `seq` gaps all 1 (no BLE loss) but the effective sent rate was ~27 Hz instead of the 50 Hz the throttle allows, 463 unique app timestamps out of 603 (arrival batching, so use `seq` not `elapsed_s` for ordering), and max total acceleration 19.78 m/s^2 = 2.016 g, i.e. the +/-2 g range was clipping on real lifts. Addressed by 2.2 and 2.3.

- ADC2 on ESP32-C3 may read less reliably than ADC1; verify the D3 reading against a multimeter.
- ~~`hardware/manufacturing/README.md` is referenced by README/BOM but does not exist.~~ Fixed by the repo reorganisation: the links now point to `hardware/pcb/README.md`, which carries the not-yet-verified PCB warning.
- Branding is inconsistent (LiftIQ / GymIQ / openGym).

## Change log

(Agents append entries here: date, item numbers, files touched, what was verified, what could not be verified.)

### 2026-11-20 — Batch 1 (items 1.1-1.7)

- **Files touched:** `firmware/current/LiftIQ_BLE/LiftIQ_BLE.ino`, `app/protocol.js`, `app/app.js`, `app/index.html` (copy only), `app/sw.js` (cache v10), `app/test/protocol.test.js`, `README.md`, `app/README.md`, `hardware/BOM.md`, `tools/README.md`, this file.
- **Verified:** `npm test` in `app/` passes (7 tests: seq decode incl. wrap value 65535, 16-byte legacy packet -> `seq: null`, no `velocity` field, name-filter constants, CSV `seq` column). `node --check app/app.js` clean.
- **Not verified:** the Arduino sketch was not compiled (reviewed by reading only; `esp_read_mac(mac, ESP_MAC_BT)` with `<esp_system.h>` plus guarded `<esp_mac.h>` is assumed to build on the XIAO_ESP32C3 core). Not tested: ADC2 reading on GPIO5 against a multimeter, BLE advertising name, Web Bluetooth filters, wake lock, `readValue()` on stop, and dropped-packet counting on a real device.

### 2026-11-20 — Batch 1.5 (items 1.8-1.13)

- **Files touched:** `firmware/current/LiftIQ_BLE/LiftIQ_BLE.ino`; `app/protocol.js`, `app/app.js` (rewritten as wiring), new `app/session.js`, `app/packet-stats.js`, `app/ble.js`, `app/storage.js`, `app/chart.js`, `app/ui.js`, `app/wakelock.js`; `app/index.html`, `app/styles.css`, `app/sw.js`; `app/test/protocol.test.js`, new `app/test/session.test.js`; `tools/README.md`; this file.
- **Verified:** `npm test` in `app/` (28 tests, all pass: state machine with a fake BLE client and fake clock covering lost complete/1 packets, stale status 2, timeout, retry, continue-after-timeout, failure status, pause/resume/stop, failed final read, save/failed save, disconnect mid-set and mid-calibration; packet tracker wrap/drops/rate; battery classification). `node --check` on every `app/*.js`. All element ids used by `ui.js` exist in `index.html`.
- **Not verified:** the sketch was not compiled; nothing was run on hardware; the UI was never opened in a browser (layout, CSS, focus handling, wake lock, Web Bluetooth flow, service worker caching are untested).

### 2026-11-20 — Batch 2a (items 2.1-2.4)

- **Files touched:** `firmware/current/LiftIQ_BLE/LiftIQ_BLE.ino`; `app/README.md` (rewritten); `tools/firmware_debug.py`, `tools/test_firmware_debug.py`, `tools/README.md`, `tools/recordings/README.md`, `hardware/BOM.md`, `README.md`; this file. No app code changed.
- **Verified:** `python -m pytest tools/test_firmware_debug.py` (9 passed incl. 2 new). `npm test` in `app/` unchanged and passing. BMI160 register layout checked against `hardware/datasheets/IMU BMI160.pdf` (ACC_CONF 0x40 reset 0x28; ACC_RANGE 0x41: 0x03/0x05/0x08; ACC data from 0x12; 4096 LSB/g at +/-8 g; I2C up to 1 MHz) and against the DFRobot library source on disk (delays in `I2cGetRegs`, config only written in init).
- **Not verified:** the sketch was not compiled (new includes `esp_adc/adc_oneshot.h`, `adc_cali.h`, `adc_cali_scheme.h` are guarded by `__has_include`; `Wire.requestFrom(uint8_t, size_t, bool)` and `Serial.printf` assumed available on core 3.3.12). Nothing ran on hardware: whether 400 kHz I2C is stable on the PCB, which battery path works, the achieved loop/notify rates, the `[IMU]` read-back values, and rep-count behaviour at 100 Hz sampling are all untested.

### 2026-11-20 — firmware compile fix (post Batch 2a)

- User's Arduino IDE build failed: `BatteryReading` / `BatteryPath` not declared (the Arduino preprocessor inserts auto-generated prototypes near the top, before mid-file type definitions) and a `batteryPathName` name clash. Fixed in `LiftIQ_BLE.ino`: `enum BatteryPath`, `struct BatteryReading` and `enum LiftPhase` moved above all functions (comment explains why); function renamed `batteryPathLabel`.
- Also in this sketch: rep-detector constants made time-based (onset window 150 ms, phase low-pass tau 110 ms with real dt).
- Compiled with the Arduino IDE's bundled arduino-cli 1.5.1 for `esp32:esp32:XIAO_ESP32C3` (core 3.3.12): `DEBUG_SERIAL_STREAM 0` builds cleanly (660851 bytes flash, 50%; 19020 bytes RAM, 5%); `DEBUG_SERIAL_STREAM 1` with `--warnings all` builds (662337 bytes, 50%; 19020 bytes RAM) with one warning: `BLE2902` is deprecated (this core's BLE library is NimBLE-based and adds the 2902 descriptor automatically). Not uploaded, not run.

### 2026-11-20 — Batch 2b (items 2.5-2.6)

- **Files touched:** `firmware/current/LiftIQ_BLE/LiftIQ_BLE.ino` (path C and ADC2 removed, `BATTERY_PIN_BODGE_D1` switch); `app/protocol.js` (`NOTIFY_HZ`, `arrival_s` column, `describeBattery` message), `app/session.js`, `app/ui.js`, `app/test/protocol.test.js`, `app/test/session.test.js`, `app/README.md`; `hardware/BOM.md`, `README.md`, `tools/recordings/README.md`; this file. Rep-detector algorithm untouched.
- **Verified:** `npm test` in `app/` and `node --check` on every module (30 tests pass, incl. seq-based `elapsed_s`, legacy fallback, CSV `arrival_s`, battery message). Firmware compile results: see the entry below.
- **Not verified:** the jumper/D1 reading on hardware, the app against real notifications after this change.
- **Batch 2b compile (arduino-cli 1.5.1, core 3.3.12, `--warnings all`):** `DEBUG_SERIAL_STREAM 0` builds (659,859 bytes flash, 50%; 18,996 bytes RAM, 5%); `DEBUG_SERIAL_STREAM 1` builds (661,349 bytes; 18,996 bytes). Only warning in both: `BLE2902` deprecated (NimBLE adds the descriptor itself). `BATTERY_PIN_BODGE_D1 0` was not separately compiled. Not uploaded.

### 2026-11-20 — Batch 2c (item 2.7, firmware cleanup)

- Backup of the pre-cleanup sketch: scratchpad `LiftIQ_BLE.ino.bak_before_2.7`. The work was interrupted once by a rate limit; on resuming the sketch was fully edited (not half-done) and was only compiled and documented.
- **Files touched:** `firmware/current/LiftIQ_BLE/LiftIQ_BLE.ino` (928 -> 805 lines), `README.md`, `hardware/BOM.md`, this file.
- **Compile (arduino-cli 1.5.1, core 3.3.12, `--warnings all`), no warnings in any variant:**

| DEBUG_SERIAL_STREAM / DEBUG_DIAG | Flash | RAM |
|---|---|---|
| 0 / 0 | 656,149 bytes (50%) | 18,940 bytes |
| 1 / 0 | 657,561 bytes | 18,940 bytes |
| 0 / 1 | 656,917 bytes | 18,964 bytes |
| 1 / 1 | 658,317 bytes | 18,964 bytes |

  Before cleanup (2b, DEBUG 0): 659,859 bytes flash, 18,996 bytes RAM.
- **Not verified:** nothing re-run on hardware. Re-check on the device: boot lines (`[BATTERY] boot: pin D1/GPIO3=... mV`, `[IMU] ... ACC_CONF=0x28 ACC_RANGE=0x08 PMU=0x14`, advertising name), that the app still connects and receives notifications (CCCD is now NimBLE-auto-created instead of added by hand), battery value in the app, and one rep-counting set.

### 2026-11-20 — Step 0 (S0.1 firmware, S0.2 app)

- **Files touched:** `firmware/current/LiftIQ_BLE/LiftIQ_BLE.ino` (backup of the pre-change sketch in the scratchpad: `LiftIQ_BLE.ino.bak_before_S0.1`); app: new `raw-protocol.js`, `raw-session.js`, `test/raw.test.js`; changed `protocol.js` (RAW_UUID), `ble.js`, `storage.js` (DB v2, `rawSessions`), `session.js` (`isBlocked` guard), `ui.js`, `app.js`, `index.html`, `styles.css`, `sw.js` (cache v12 + files), `README.md`; `tools/recordings/README.md`; this file. `tools/trajectory` and `docs/experiments/STEP0_PROTOCOL.md` untouched.
- **Verified:** `npm test` (unit tests for chunk parsing, lost/duplicated/out-of-order reassembly, SENSORTIME wrap, header parsing, CSV header keys/column row, Lab state machine incl. resend, give-up, disconnect/resume and the live/raw guard); `node --check` on every module. Firmware compile results are in the next line.
- **Not verified:** nothing ran on hardware or in a browser. Untested: the new IMU registers read back (`GYR_CONF=0x29 GYR_RANGE=0x01`), 200 Hz burst polling alongside the live loop, heap capacity, MTU negotiation, NimBLE congestion handling, actual upload throughput, the Lab UI layout, and the IndexedDB v1->v2 migration with real existing data.
- **Firmware compile (arduino-cli 1.5.1, core 3.3.12, `--warnings all`), no warnings in any variant:** DEBUG_SERIAL_STREAM/DEBUG_DIAG 0/0 = 662,399 bytes flash (50%), 19,188 bytes RAM; 1/0 = 663,797; 0/1 = 663,157 (19,220 RAM); 1/1 = 664,547. Before Step 0: 656,149 / 18,940. Defaults restored to 0/0 (the committed sketch was compiled as-is). The 40 s capture buffer (112,000 bytes) is allocated at ARM time from the heap, not statically.

### 2026-11-20 — S0.1b capture memory (firmware s0.2, stream v2)

- **Finding:** at ARM the capacity was 4680 samples (23.4 s) although the boot line showed 114,676 bytes largest block. Cause: `room = (largestBlock - 48 KB reserve) / 14 B` = (114,676 - 49,152) / 14 = 4,680. The reserve rule was far too conservative; the real constraint is the TOTAL free heap at ARM with a client connected (120,368 bytes; it was 186,156 at boot, a connected NimBLE client uses ~66 KB), not the block size.
- **Change:** samples are packed in 25-sample blocks with one 24-bit SENSORTIME per block (12.16 B/sample instead of 14); reserve reduced to 20 KB of total free heap (plus 256 B block slack); capacity = min(40 s, fits in the largest block, leaves the reserve). Budget at the measured heap: free 120,368 - 97,280 (8000 samples) = about 23 KB left after allocation (>= 20 KB reserve), so the full 40 s fits; if the free heap is lower the cap shrinks gracefully (about 12.16 B per sample). 40 s at 200 Hz is the cap; `[RAW] ARM:` now prints free heap before/after the allocation.
- **Discard rule (chosen):** the first 100 ms after START are dropped (not marked). `t_s` = 0 is the first stored sample.
- **CSV contract:** columns and header keys unchanged. `t_s` semantics: block-start IMU time + nominal 5 ms steps inside the 25-sample block (documented above); stream version byte is now 2 (old v1 streams are rejected by the app; there is no released v1 firmware).
- **Files:** `firmware/current/LiftIQ_BLE/LiftIQ_BLE.ino` (backup `LiftIQ_BLE.ino.bak_before_S0.1b` in the scratchpad), `app/raw-protocol.js`, `app/test/raw.test.js`, this file.
- **Verified:** `npm test` (42 pass; v2 header/blocks, 24-bit SENSORTIME wrap, v1 rejection, reassembly unchanged); firmware compile results below. **Not verified:** the new capacity and upload on hardware.
- **S0.1b compile (arduino-cli 1.5.1, core 3.3.12, `--warnings all`), no warnings:** DEBUG_SERIAL_STREAM/DEBUG_DIAG 0/0 = 662,841 bytes flash, 19,180 RAM; 1/0 = 664,241; 0/1 = 663,599 (19,212 RAM); 1/1 = 664,993. Committed defaults remain 0/0.

### 2026-11-20 — Repo structure + release model (R1-R12)

- **Moves (git mv, renames recognised by git):** `app/*` -> `app/dev/` (+ untracked raw files), `firmware/current/LiftIQ_BLE` -> `firmware/LiftIQ_BLE`, `tools/*.py` -> `tools/serial/` and `tools/ble/`, `tools/recordings/*` -> `data/recordings/{serial-legacy,app-sessions,raw}`, `hardware/manufacturing/{flatcam,gerbers/unversioned-export/LiftIQ PCB}` -> `hardware/pcb/v1/{flatcam,gerbers/liftiq-pcb-unversioned-export}`, `docs/STEP0_PROTOCOL.md` -> `docs/experiments/`, the Tiny Open Logger PDF -> `docs/references/tiny-open-logger-tol.pdf` (copy verified with `cmp`). Note: file paths inside older change-log entries below use the pre-reorganisation layout (`app/protocol.js`, `firmware/current/...`) and are history, not links.
- **New files:** `app/stable/*` (from `a81fe00`) + `app/stable/VERSION`, `app/dev/channel.js`, `app/dev/icon-dev.svg`, `app/dev/test/compat-ble.test.js`, `tools/release-app.mjs`, `tools/ble/check_protocol_serial.py` + test, `firmware/LiftIQ_BLE/protocol_v1.h`, `protocol_v1_selftest_vectors.h` (generated), `tests/compat/**`, `.github/workflows/compat.yml`, `docs/PROTOCOL.md`, `docs/ARCHITECTURE.md`, `docs/references/README.md`, `hardware/pcb/README.md`.
- **Changed:** `firmware/LiftIQ_BLE/LiftIQ_BLE.ino` (telemetry through `encodeTelemetryV1`, INFO characteristic, `DEBUG_PROTOCOL_SELFTEST`, FW `s0.3`, unused `scaledInt16` removed), `app/dev` (`protocol.js` INFO parsing, `ble.js` optional INFO read, `ui.js` firmware row + Lab "not supported by this sensor firmware" message, `app.js`, `index.html`, `manifest.webmanifest`, `sw.js`, `styles.css`), `app/package.json`, `app/dev-server.mjs` (root + port arguments), `.github/workflows/pages.yml`, `.gitignore`, `tools/serial/liftiq_serial.py` (recordings dir -> `data/recordings/serial-legacy`), READMEs, this file.
- **Verified:**
- `cd app && npm run test:all`: dev 49 pass, stable 30 pass (the stable suite is the a81fe00 suite), `tests/compat` 76 pass (incl. host-compiled firmware encoder: g++ 13.2 MinGW `-std=c++11 -Wall -Wextra -Werror`), python 33 pass (`tools/ble` 14 incl. 5 new, `tools/trajectory` 19).
  - Firmware compile (arduino-cli 1.5.1, core esp32 3.3.12, `--warnings all`, `esp32:esp32:XIAO_ESP32C3`), exit 0, no warning from our files (only the 13 pre-existing warnings inside the third-party `DFRobot_BMI160` library, which are printed because this compile rebuilt the library): committed sketch (all flags 0) 662,959 B flash (50%), 19,180 B RAM (before: 662,841 / 19,180); `DEBUG_SERIAL_STREAM 1` 664,361 / 19,180; `DEBUG_DIAG 1` 663,717 / 19,212; `DEBUG_PROTOCOL_SELFTEST 1` 664,429 / 19,180; all three = 1: 666,581 / 19,212. Committed defaults remain 0/0/0.
  - Release tool exercised on a temp copy of the repo (own `git init`): `--dry-run`; real run 1.0.0 -> 1.1.0 (stable tests green on the result, cache `liftiq-app-v11` -> `v12`, channel.js `stable`, no dev branding, title/manifest/theme/icon restored); refusals for an unchanged/lower version, a missing `--version`, and uncommitted changes in `app/stable`. Never run against the real `app/stable`.
  - Static server smoke test (`dev-server.mjs <dir> <port>`, ports 8100/8101 because the user's old `npm start` server from 18:23 still occupies 8000): `/`, `index.html`, `sw.js`, `protocol.js`, `channel.js`, manifest returned 200 with dev ("LiftIQ Dev", `liftiq-dev-v1`, CHANNEL dev) and stable ("LiftIQ | Set tracker", `liftiq-app-v11`, no channel.js) content; `..` traversal and unknown files 404. Both test servers killed.
  - `app/stable` vs `git show a81fe00:app/<file>` for all 16 non-app-level files (14 app files + 2 tests): byte-identical (after normalising the working copy to LF, which is what git stores). Extra file: `VERSION`. Not copied to stable (app-level, shared): `README.md`, `package.json`, `dev-server.mjs`.
  - `git status`: 29 pure renames (R100) + 16 renamed-and-modified files recognised; stale-path grep clean except history text in this file and the `hardware/pcb/README.md` history note.
- **Not verified / open:** nothing flashed or run on hardware (the INFO characteristic, the `protocol_v1.h` refactor on the board, `DEBUG_PROTOCOL_SELFTEST` output, `check_protocol_serial.py` against a real board); dev app not opened in a real browser (INFO row, DEV badge, Lab message layout, SW behaviour); the GitHub workflows have not run (python job needs tkinter via apt; Node 22 assumed); `lroundf` in `protocol_v1.h` needs `<math.h>` (header comment explains; the brief said only stdint/string). Two OS-locked leftovers: the root-level PDF copy (the original file is open in another program; the verified copy is `docs/references/tiny-open-logger-tol.pdf`) and the empty folder `firmware/current/LiftIQ_BLE` (held by another process): delete both by hand after closing the PDF viewer / Arduino IDE.
