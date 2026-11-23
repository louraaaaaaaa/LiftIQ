# LiftIQ development tracker

Status: current
Last reviewed: 2026-11-23
Purpose: the SHORT living tracker: fixed constraints, rules, a status board, open decisions, known issues and next steps. Long per-batch notes live in
[`docs/history/DEVELOPMENT_HISTORY.md`](history/DEVELOPMENT_HISTORY.md), dated entries in [`CHANGELOG.md`](../CHANGELOG.md), the document index in [`docs/README.md`](README.md).

Architecture decisions are made in chat between the owner and the architect (Claude); implementation is delegated to agents. Every agent updates this
file when it finishes work: change the status-board row and the Next steps, and append the dated entry to `CHANGELOG.md` (files touched / verified / not verified).

## Fixed constraints (prototype hardware is built — do not redesign)

- XIAO ESP32C3 + GY-BMI160 (I2C, SDA=GPIO6/D4, SCL=GPIO7/D5, addr 0x68) + 330 mAh LiPo.
- Custom PCB already built. Battery divider midpoint is wired to **D3 = GPIO5 (ADC2_CH0)**, which cannot be read in software on the ESP32-C3; a jumper/wire from the D3 pad to **D2 = GPIO4 (ADC1_CH4)** is required (firmware `PIN_BATTERY = 4`). XIAO ESP32-C3 map: D0=GPIO2, D1=GPIO3, D2=GPIO4, D3=GPIO5, D4=GPIO6, D5=GPIO7. (History entries that say D1/GPIO3 were a labelling error, see the 2026-11-22 correction in the history.)
- DFRobot_BMI160 library stays for now (fixed +/-2 g range at library level; the sketch writes +/-8 g itself).
- BLE only; phone app is the Web Bluetooth PWA in `app/` (`app/stable` released, `app/dev` development). Capacitor/native wrapper is a later decision.
- Licence: software and firmware AGPL-3.0-or-later (`LICENSE`, `NOTICE.md`); hardware licence undecided.

## Rules (apply to every agent and every change)

1. **Before declaring any firmware or app change done, run `cd app && npm run test:all`** (vendor check, link check, dev + sensor package + stable unit tests, `tests/compat`, python tool tests). For firmware changes also compile: `arduino-cli compile --fqbn esp32:esp32:XIAO_ESP32C3 --warnings all firmware/LiftIQ_BLE` (flags `DEBUG_SERIAL_STREAM`, `DEBUG_DIAG`, `DEBUG_PROTOCOL_SELFTEST` at 0 and 1) with no warnings from our files.
2. **Firmware changes must keep `tests/compat` green.** Any firmware version must keep working with the latest STABLE app and older stable releases (`docs/PROTOCOL.md`): additive changes only, new data on new characteristics, experimental features dormant unless invoked, breaking changes only with a new protocol major, a parallel v1 path and the user's explicit approval.
3. **`app/stable/` changes only through `node tools/release-app.mjs`** (run with `--dry-run` first; it never commits or pushes). Do not hand-edit `app/stable`, and never point the Pages workflow at `app/dev`.
4. Golden vectors (`tests/compat/golden/v1_vectors.json`) may be extended, never edited. If `protocol_v1.h` changes the encoder output, regenerate `protocol_v1_selftest_vectors.h` with `node tests/compat/tools/gen-selftest-header.mjs`.
5. Touching packet encoding: run `tools/ble/check_protocol_serial.py` on the real board (flash with `DEBUG_PROTOCOL_SELFTEST 1`, then back to 0) before calling it verified.
6. Sensor code is edited only in `packages/liftiq-sensor/src`, then `cd app && npm run vendor` (the vendored copy in `app/dev/vendor/` is generated).
7. Update this file (status board / Next steps) and `CHANGELOG.md` when you finish. Do not edit `hardware/` unless you are the hardware owner or assistant.

Status words: `DONE` implemented and verified as far as possible without hardware · `IN PROGRESS` · `PLANNED` · `IDEA` (not committed to).

## Status board (2026-11-23)

| Area | State | Where the detail is |
|---|---|---|
| Firmware (`firmware/LiftIQ_BLE`) | DONE, hardware-verified up to the 2.8 cleanup (100 Hz sampling, 50 Hz telemetry, +/-8 g, battery on GPIO4, raw capture 200 Hz, INFO characteristic). Cleanup 2.7/2.8 compiled but NOT re-flashed; pulse counter in firmware is PLANNED (W4) | [history Batch 1-2c, Step 0](history/DEVELOPMENT_HISTORY.md), [`CHANGELOG.md`](../CHANGELOG.md) |
| Protocol and compat gates | DONE: BLE v1 frozen, golden vectors, host-compiled encoder test, behaviour tests against stable, constants guard. Board self-test never run on a real board | [`PROTOCOL.md`](PROTOCOL.md), [`tests/compat/`](../tests/compat), [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| Sensor package (`packages/liftiq-sensor`) | DONE (P2, 0.1.0): protocol, raw protocol, packet stats, session machine, ready check, pulse analysis, BLE client over a transport interface. Tests green; the refactored BLE client has NOT been verified with the real sensor | [package README](../packages/liftiq-sensor/README.md), [`OPENGYM_INTEGRATION_DESIGN.md`](OPENGYM_INTEGRATION_DESIGN.md) (B1, E) |
| Stable app (`app/stable`, 1.0.0) | PUBLISHED on GitHub Pages, frozen; changes only through the release tool. First real release blocked until the release-tool fix lands (see Known issues / this change set) | [`app/README.md`](../app/README.md), [`ARCHITECTURE.md`](ARCHITECTURE.md) (release model) |
| Dev app (`app/dev`, 1.1.0-dev) | REFERENCE IMPLEMENTATION. Train flow, exercise picker, photos and history (W2, W2b, W2c, W2d) are superseded by openGym's UI; the analysis, BLE, protocol, session logic and Lab stay and are reused | [`app/README.md`](../app/README.md), [`UX_TRAIN_FLOW.md`](UX_TRAIN_FLOW.md), [`EXERCISE_DATA.md`](EXERCISE_DATA.md) |
| Analysis / Step 0 | Pulse analysis (W1) DONE: golden counts 8, 8, 7, 5, 9 reproduced offline and live. Step 0 capture chain verified on hardware (200 Hz, 0 dropped chunks); experiments A, C, D (static noise, horizontal path, ROM vs tape) not yet run, the IMU decision gate is open | [`REP_ANALYSIS.md`](REP_ANALYSIS.md), [`experiments/STEP0_PROTOCOL.md`](experiments/STEP0_PROTOCOL.md), [`tools/trajectory/`](../tools/trajectory/README.md) |
| openGym fork | P0 DONE and pushed (fork `github.com/louraaaaaaaa/openGym`, branch `liftiq`, local clone outside this repo); P1 spike NEXT (Record with sensor on Android Chrome). Pages/Actions on the fork not yet enabled | [`OPENGYM_INTEGRATION_DESIGN.md`](OPENGYM_INTEGRATION_DESIGN.md) (E, F), [`INTEGRATION_OPENGYM.md`](INTEGRATION_OPENGYM.md) (research input) |
| Exercise data / media | DONE in dev app: 1,324-exercise open dataset (MIT text), media linked at runtime with attribution and an off switch. Licence clarification from Gym visual / the dataset author PENDING (not yet sent) | [`EXERCISE_DATA.md`](EXERCISE_DATA.md), [`IMAGE_CREDITS.md`](IMAGE_CREDITS.md), [`NOTICE.md`](../NOTICE.md) |
| Hardware | v1 built; v2 discussion IN PROGRESS and owned by the owner and a separate assistant: do not edit `hardware/`. The folder is being reorganised (`hardware/v1`, `hardware/v2`, `hardware/datasheets`) | [`hardware/BOM.md`](../hardware/BOM.md), [`HANDOFF_HARDWARE.md`](HANDOFF_HARDWARE.md) |
| Release / CI | `compat.yml` (node, link check, python tests) and `pages.yml` (publishes only `app/stable`) exist; neither has been seen running on GitHub for this repo state. Nothing committed yet since the 2026-11-20 reorganisation | [`ARCHITECTURE.md`](ARCHITECTURE.md), [`.github/workflows/`](../.github/workflows) |

## Open decisions

- **Hardware v2** (IMU BMI270 vs staying on BMI160, optional MLX90393, board form): owner's separate hardware discussion; Step 0 experiments A, C, D are the IMU decision gate (~2 cm per-rep ROM error means software on the current IMU is enough). Background: [history, Ideas / undecided](history/DEVELOPMENT_HISTORY.md).
- **Hardware / docs licence:** not decided (software and firmware are AGPL-3.0-or-later).
- **openGym fork vs upstream PR:** fork now (P0-P4), talk to the maintainer in parallel (P6); owner decisions F1-F10 are listed in [`OPENGYM_INTEGRATION_DESIGN.md`](OPENGYM_INTEGRATION_DESIGN.md).
- **Exercise media licence:** whether Gym visual / the dataset author object (switch `EXERCISE_MEDIA_ENABLED_DEFAULT` in `app/dev/exercise-media.js`); relevant only while the dev app keeps showing the media.
- **Capacitor wrapper vs native app** (iOS and background BLE); battery service and non-linear LiPo curve; pairing/security; NimBLE-Arduino; IMU FIFO + INT wake from deep sleep (INT must reach GPIO0-5 on a future PCB); keep CSV out of the main IndexedDB record.
- **Branding:** LiftIQ / GymIQ / openGym naming is inconsistent.

## Known issues (open)

- Battery pin: the divider midpoint is on D3/GPIO5 (ADC2, unreadable in software); a jumper to D2/GPIO4 is required. Cause and fix: Batch 2b in the history. The owner still has to confirm the wire is on the D2 pad.
- The firmware cleanup (2.7/2.8) and the sensor-package BLE client were compiled/unit-tested only; neither has run against the real sensor since.
- `node tools/release-app.mjs --version 9.9.9 --dry-run` aborted at its verification step because `app/dev/dev-tools.js` contains the storage key `liftiq-dev-tools`, matched by the no-dev-branding check (pre-existing, found 2026-11-22). Fixed in this change set, see the CHANGELOG entry of 2026-11-23.
- The dev and package tests read recordings from `tests/fixtures/seated-row-2026-11-22` (a copy of five `data/recordings/app-sessions` files): the release tool runs the dev tests, so those fixtures must stay in the repo.
- The first-test findings of 2026-11-20 (calibration desync, battery 0 mV, +/-2 g clipping, 27 Hz rate) are all closed; the notes are in the history (Part 6).

## Compiling the firmware (re-run after every firmware change)

```
arduino-cli compile --fqbn esp32:esp32:XIAO_ESP32C3 --warnings all firmware/LiftIQ_BLE
```

Compile-only, never uploads. To check the serial-debug build, compile a copy with `#define DEBUG_SERIAL_STREAM 1` (e.g. `sed 's/^#define DEBUG_SERIAL_STREAM 0/#define DEBUG_SERIAL_STREAM 1/'` into a temp sketch folder named `LiftIQ_BLE`) and leave the committed sketch at 0. The first compile after a core or `--warnings` change builds the whole ESP32 core and takes several minutes. If `arduino-cli` is not on PATH, the Arduino IDE bundles one at `%LOCALAPPDATA%\Programs\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe`. Libraries come from `~/Documents/Arduino/libraries` (DFRobot_BMI160).

## Next steps

Existing items (kept):

- W3: exercise report (per-set overview, rep metrics, cross-set comparison, HTML export + print/PDF); see (e) below for how it is built.
- W4: firmware pulse counter for resilience, with shared golden vectors (opt-in / new characteristic per the compat rules); see (i).
- W5: openGym export (Strong-style CSV), then optional token push; see (i) and the openGym design.
- Batch 3 / 4 ideas (time-based, continuous-rep detector in firmware; per-rep BLE event packet; ZUPT velocity per rep; load field and per-rep chart): see the planning notes in the history (Part 5).
- Step 0 experiments: see (f).

Added 2026-11-23:

- (a) Enable Actions/Pages on the openGym fork and verify the deployed standalone site on a phone.
- (b) Verify the refactored BLE client (`packages/liftiq-sensor`) with the real sensor: connect, ready check, one set, Lab capture.
- (c) Commit a checkpoint of the LiftIQ repo: many days of work are uncommitted (the owner commits; review `git status` first, hardware changes are another assistant's).
- (d) P1 spike "Record with sensor" in the openGym fork on Android.
- (e) Build the exercise report (W3) as a package module (SVG/HTML builders) reusable by both apps.
- (f) Hardware v2 decisions from the owner's separate hardware discussion, plus Step 0 experiments A, C, D as the IMU decision gate.
- (g) First stable release (needs the release-tool fix, now done) when the owner wants a feature on the phone.
- (h) Send the licence-clarification question to Gym visual / the dataset author (pending).
- (i) Later: firmware pulse counter for BLE-drop resilience (W4), openGym import-file export, Capacitor BLE / iPhone.
