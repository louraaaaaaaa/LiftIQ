# LiftIQ development tracker

Single source of truth for what has been decided, what is being built, and what
is planned. Architecture decisions are made in chat between the user and the
architect (Claude); implementation is delegated to agents. Every agent must
update this file when it finishes work.

## Fixed constraints (prototype hardware is built — do not redesign)

- XIAO ESP32C3 + GY-BMI160 (I2C, SDA=GPIO6/D4, SCL=GPIO7/D5, addr 0x68) + 330 mAh LiPo.
- Custom PCB already built. Battery divider midpoint is wired to **D3 = GPIO5 (ADC2_CH0)**, which cannot be read in software on the ESP32-C3; a jumper from the D3 pad to **D1 = GPIO3 (ADC1_CH3)** is required (`BATTERY_PIN_BODGE_D1`).
- DFRobot_BMI160 library stays for now (fixed +/-2 g range).
- BLE only; phone app is the Web Bluetooth PWA in `app/`. Capacitor/native wrapper is a later decision.

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
- CSV `tools/recordings/app-sessions/liftiq-2026-11-20-3979b0d1.csv`: 967 rows in 19.3 s = 50.2 Hz, seq deltas all 1 (no loss), 8 of 8 reps counted correctly at the new 100 Hz sampling, peak 29.1 m/s^2 = 2.97 g (would have clipped at +/-2 g). Only 658 unique `elapsed_s` of 967 rows = arrival-time batching in the app (fixed by 2.6).
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

- Extract the rep detector into a dependency-free C++ header; host unit tests replaying `tools/recordings/*.csv` and app-exported CSVs.
- Rep detector is now sample-rate independent (onset window 150 ms, phase low-pass tau 110 ms with real dt; other timers were already ms-based) - replaces the open 100 Hz regression risk from Batch 2a; still to be re-validated on hardware.
- Handle continuous / touch-and-go reps (no 300 ms rest dwell required), slow tempo reps (lower effective onset), and exercises that start with the eccentric.
- Use the gyro (complementary/Madgwick) to track gravity during the rep.
- Verify actual accelerometer range vs. the 3 g peaks seen in recordings.

## Batch 4 — effort metrics — PLANNED

- Per-rep BLE event packet (rep #, duration, concentric/eccentric time, peak accel).
- Zero-velocity-update velocity per rep: mean concentric velocity, velocity loss across the set.
- App: load (kg) field, per-rep and per-set summary, signed projected-axis chart.

## Ideas / undecided

- Capacitor wrapper (iOS + background BLE) vs native app.
- Battery Service (0x180F) alongside the custom characteristic; non-linear LiPo curve.
- Pairing/security; NimBLE-Arduino; IMU FIFO + INT wake from deep sleep (INT pin must reach GPIO0-5 on a future PCB).
- History storage: keep CSV out of the main IndexedDB record.

### Compiling the firmware (re-run after every firmware change)

```
arduino-cli compile --fqbn esp32:esp32:XIAO_ESP32C3 --warnings all firmware/current/LiftIQ_BLE
```

Compile-only, never uploads. To check the serial-debug build, compile a copy with `#define DEBUG_SERIAL_STREAM 1` (e.g. `sed 's/^#define DEBUG_SERIAL_STREAM 0/#define DEBUG_SERIAL_STREAM 1/'` into a temp sketch folder named `LiftIQ_BLE`) and leave the committed sketch at 0. The first compile after a core or `--warnings` change builds the whole ESP32 core and takes several minutes. If `arduino-cli` is not on PATH, the Arduino IDE bundles one at `%LOCALAPPDATA%\Programs\Arduino IDEesourcespp\libackendesourcesrduino-cli.exe`. Libraries come from `~/Documents/Arduino/libraries` (DFRobot_BMI160).

## Known issues (open)

First on-device test (2026-11-20, LiftIQ-C846, Batch 1.5 firmware):

1. Batch 1.5 worked: calibration completed, the app went to Recording, and 6/6 reps were counted correctly.
2. Battery: CLOSED by Batch 2b once the jumper is fitted. Cause: ESP32-C3 ADC2 (D3/GPIO5) oneshot is not supported by this core (`adc unit not supported`, ESP_ERR_NOT_SUPPORTED), so the pin reads 0 in software although the multimeter shows 2.02 V. Fix: jumper D3 pad -> D1 pad, firmware reads GPIO3 (ADC1). See Batch 2b.
3. First app CSV (`tools/recordings/app-sessions/liftiq-2026-11-20-993c5e0f.csv`, 603 rows, 22.5 s): `seq` gaps all 1 (no BLE loss) but the effective sent rate was ~27 Hz instead of the 50 Hz the throttle allows, 463 unique app timestamps out of 603 (arrival batching, so use `seq` not `elapsed_s` for ordering), and max total acceleration 19.78 m/s^2 = 2.016 g, i.e. the +/-2 g range was clipping on real lifts. Addressed by 2.2 and 2.3.

- ADC2 on ESP32-C3 may read less reliably than ADC1; verify the D3 reading against a multimeter.
- `hardware/manufacturing/README.md` is referenced by README/BOM but does not exist.
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
