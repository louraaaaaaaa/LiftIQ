# LiftIQ phone app

Status: current (the Train-flow parts are a reference implementation, see below)
Last reviewed: 2026-11-23
Purpose: how to run, test and release the stable and dev apps, and how the dev app is laid out. The dev app's Train flow, exercise picker, photos and
history (W2, W2b, W2c, W2d) are a **reference implementation, superseded by the openGym integration** ([`docs/OPENGYM_INTEGRATION_DESIGN.md`](../docs/OPENGYM_INTEGRATION_DESIGN.md));
they are kept for the analysis, BLE, session and protocol logic they exercise.

A dependency-free, installable strength-training log for the LiftIQ BLE
firmware (Web Bluetooth PWA, plain ES modules, no build step). Sessions and CSV
files stay in IndexedDB on this device.

## Two apps: stable and dev

| | `app/stable/` | `app/dev/` |
|---|---|---|
| Purpose | the released app, **the only thing GitHub Pages publishes** | all development (Step 0 / Lab, INFO read, experiments) |
| Name / look | LiftIQ, green | **LiftIQ Dev**, purple theme and icon, `DEV` badge |
| Version | `stable/VERSION` (and `channel.js`), starts at 1.0.0 | `1.1.0-dev` in `dev/channel.js` |
| Service worker cache | `liftiq-app-vN` | `liftiq-dev-vN` (own prefix, never touches stable caches) |
| Local port | `npm run start:stable` -> <http://localhost:8001> | `npm start` -> <http://localhost:8000> |
| Tests | `npm run test:stable` | `npm test` |
| How it changes | **only** via the release tool | edit freely |

`app/stable` was created from the app that was live on GitHub Pages (commit `a81fe00`) without code
changes (only a `VERSION` file was added). Everything else (`package.json`, `dev-server.mjs`, this README) is shared at
`app/` level.

Dev degrades gracefully against older firmware: if the RAW or INFO characteristic is missing the
connection still succeeds, live set tracking works, and the Lab page says "Raw capture is not supported
by this sensor firmware".

## Browser and hosting requirements

- Windows, macOS, or Linux PC with a current Chrome or Edge browser, or an
  Android phone with current Chrome (Web Bluetooth required).
- Serve the app from an **HTTPS** website. Web Bluetooth and PWA
  installation need a secure origin. `http://localhost` is allowed for PC
  development; do not open `index.html` directly as a `file://` page.
- iOS Safari currently does not support Web Bluetooth. Use the Python
  dashboard on a computer or build a separate native iOS client.

For PC testing, open a terminal in this `app` directory and run:

```powershell
npm.cmd start            # dev app on http://localhost:8000
npm.cmd run start:stable # stable app on http://localhost:8001
```

(`npm start` on macOS/Linux.) The servers listen on the PC only (127.0.0.1). Open the page in Chrome or Edge, tap
**Sensor -> Connect sensor**, and choose your **LiftIQ-XXXX** sensor (the legacy
**GymIQ Sensor** name also works). Turn on the PC's Bluetooth and close other
apps already connected to the tracker. `node dev-server.mjs <dir> <port>` serves any folder.

Phone testing needs a static **HTTPS** host. GitHub Pages serves `app/stable` (see Release below); a plain
`http://192.168.x.x` address is not a secure origin and cannot access Bluetooth. Every new file must be
added to `APP_FILES` in `sw.js`; the cache number is bumped by the release tool for stable. On Android use
**Add to Home screen** / **Install app** from Chrome's menu; the app shell is cached for offline launch,
but Bluetooth still needs the sensor nearby.

## Release procedure (dev -> stable)

Stable changes only through the release tool, which never commits or pushes:

```powershell
cd app
npm.cmd run release -- --version 1.2.0 --dry-run   # build + verify in a temp folder, change nothing
npm.cmd run release -- --version 1.2.0             # same, then write app/stable
```

(or `node tools/release-app.mjs --version 1.2.0 [--dry-run]` from the repository root). It:

1. runs the dev unit tests and `tests/compat` (against the dev decoder) and aborts on failure;
2. refuses to run if `app/stable` has uncommitted changes or the version is not higher than `stable/VERSION`;
3. copies `app/dev` to `app/stable`, dropping dev-only files (`icon-dev.svg`) and rewriting the channel:
   removes the `<!--dev:start-->...<!--dev:end-->` DEV badge, restores the stable title, theme colour, icon
   and manifest name, sets `channel.js` to `CHANNEL = "stable"` / `APP_VERSION = "X.Y.Z"`, writes `VERSION`,
   and bumps the service-worker cache number (`liftiq-app-v11` -> `v12`, so installed apps update);
4. verifies the result contains no dev branding and every referenced file exists, then runs the stable tests;
5. prints next steps: review `git diff`, try `npm run start:stable`, commit, push. The Pages workflow then
   deploys `app/stable`.

Rollback before committing: `git checkout -- app/stable && git clean -fd app/stable`. Before a release
make sure `npm run test:all` is green and, if the firmware changed, the firmware is compatible
(`docs/PROTOCOL.md`).

## Using the app (stable app, 1.0.0)

This section describes the **stable** app and its simple flow with the firmware's five-second calibration. The dev app replaces
**Workout** by the Train flow, which uses a 1.5 s ready check instead of the calibration (see "Dev app only" below); its
Lab page (raw capture) is under Sensor > Developer tools.

The stable bottom navigation has three sections: **Workout**, **History** and **Sensor**. The header always shows the
connection state and the sensor battery.

1. **Sensor → Connect sensor.** Approve Android's permission/pairing prompt if
   asked. Saved rep thresholds are sent to the sensor on connect.
2. **Workout → Start set.** The sensor calibrates for about five seconds; keep
   it still. An inline panel shows calibration progress. **Cancel** is always
   available. If calibration is slow the panel offers **Retry calibration**
   (and **Continue set** if the sensor reports it has actually finished). The
   app derives calibration from the status byte in every packet, so one lost
   Bluetooth packet cannot leave the app waiting.
3. During the set the big counter shows the sensor's rep count, with a sticky
   **Pause** and **Stop set** bar. Pausing stops sample logging and the
   elapsed timer; the sensor keeps counting reps and the live count is what is
   saved when you resume or stop. The screen is kept awake while a set is
   active (Screen Wake Lock, where supported).
4. **Stop set** reads the sensor's final rep count once, then asks you to
   confirm or correct it before saving.
5. **History** lists saved sets with **↓ CSV** download and **Delete**.
6. **Sensor** shows Bluetooth/stream/calibration status, the battery state,
   a custom display name (app-only label) and the rep thresholds (movement
   start 0.1–5.0 m/s², phase reversal and return-to-rest 0.1–3.0 m/s²;
   defaults 1.0, 0.35, 0.45), and a collapsed **Debug** panel.

### Lab (raw capture, research)

For the offline trajectory experiments (Step 0: [`docs/history/DEVELOPMENT_HISTORY.md`](../docs/history/DEVELOPMENT_HISTORY.md), [`docs/experiments/STEP0_PROTOCOL.md`](../docs/experiments/STEP0_PROTOCOL.md)). Dev app only. Needs firmware with the
research-capture feature; otherwise the page says it is unavailable. Fill in exercise, load (kg),
known range of motion (cm) and notes, then:

1. **Arm** - hold the sensor perfectly still for 5 s (progress bar). The sensor measures gyro bias and gravity.
2. **Start**, do the set, **Stop**. The sensor records 6-axis data at 200 Hz in its RAM (up to 40 s).
3. The app downloads the capture automatically (progress bar of chunks received). Missing chunks are
   re-requested automatically; after repeated failures it stops with an error. The data stays on the sensor
   until it is erased, so after a disconnect reconnect and press **Resume download**.
4. **Save CSV** downloads the file in the Raw CSV v1 format, stores it on the phone (list below the form,
   with download/delete) and erases the sensor memory. Put exported files in `data/recordings/raw/`.

A normal set and a raw capture cannot run at the same time (both the app and the firmware refuse).
While the capture is uploading, live rep telemetry is paused.

### Battery indicator

Three states are distinguished: waiting for the first packet; **No battery**
when the sensor reports 0 mV (running from USB, or battery sense not wired - the
D3->D2 jumper, see `hardware/BOM.md`); and a valid reading. The percentage is a linear
3.3–4.2 V estimate, not a fuel-gauge measurement. The Debug panel shows the raw
cell-voltage field.

### Debug panel

Session state, last firmware calibration status, packet rate, total / dropped /
invalid packet counts, battery mV, age and hex of the last raw packet. State
transitions are also written to the browser console with `console.debug`.

### CSV

Columns: `elapsed_s, ax_m_s2, ay_m_s2, az_m_s2, total_accel_m_s2,
dynamic_accel_m_s2, phase, phase_id, rep_count, seq, actual_rep_count, arrival_s`.
`seq` is the unwrapped firmware packet counter (gaps mean lost packets).
`elapsed_s` is sensor time, `(seq - firstSeq) / 50` (the firmware sends exactly 50 Hz), so it
is free of Bluetooth arrival batching; `arrival_s` (last column) is the phone arrival time.
Legacy packets without `seq` use arrival time for `elapsed_s`.
Accelerations are m/s² and include gravity; with the current firmware the
accelerometer range is ±8 g. Paused samples are omitted, so elapsed time keeps
the pause gap. Exports are collected in `data/recordings/app-sessions/`.

Set history is local to the browser. The app asks the browser to protect its
storage from cleanup but that is not a backup; use **↓ CSV** to keep a copy.

## Dev app only: the Train flow (W2) - reference implementation

> Superseded by the openGym integration (the fork brings its own exercise picker, history and workout UI). Kept as a working reference for the
> ready check, session machine, pulse analysis, set review and CSV formats, which are reused by the sensor package.

`app/dev` replaces the old Workout page with a guided workout flow (not in `stable` yet). Run it with `npm start` (http://localhost:8000, Chrome on Android or desktop for Bluetooth). The bottom navigation is **Train | History | Sensor**; the Lab (raw capture) and the debug panel are under Sensor > Developer tools (switch, default off). The full interaction contract is `docs/UX_TRAIN_FLOW.md`.

Flow (state machine in `workout.js`, drives the unchanged `SessionMachine` for calibration/recording/disconnects):

1. **Choose a machine.** Type your own machine name at the top (saved as a custom machine), or search/filter the exercise library: chips **Stack machines** (default) and **All**, filters for body part, target muscle and equipment, recent exercises first, pages of 40 with infinite scroll. The library is the open dataset hasaneyldrm/exercises-dataset (1,324 exercises, English) plus the 10 seeded machines; thumbnails and the movement GIF are loaded from the internet at runtime with the "© Gym visual" attribution and can be switched off under Sensor > Training settings > Online exercise previews (see `docs/EXERCISE_DATA.md` for the licence status). **Quick set (no machine)** is at the bottom. You can add your own photo of any machine.
2. **Set up.** Weight in kg is optional: prefilled from the last set of that exercise, change with the −/+ stepper (step in Sensor → Training settings, default 5 kg) or the field, or tap **Weight unknown**. The machine name can be edited for the current exercise. The **ready check** (live stillness ring) replaces the firmware calibration: Start set records once the machine has been still for 1.5 s (pressing early arms it). Back and Change machine are always available before the set.
3. **During the set.** Big live rep estimate (causal pulse counter; it counts the setup pull too), elapsed time, large **STOP SET**.
4. **Review.** Offline pulse analysis (`analysis/pulses.js`, spec `docs/REP_ANALYSIS.md`): rep count with the setup pull excluded by default, a **Include setup pull** switch, velocity chart with numbered pulses (S = setup pull), per-rep bars (peak velocity, up-stroke cm estimate, time to next), mean peak velocity, velocity loss, rep period. The weight can be set or corrected here. **Yes, N reps** confirms, **Edit count** changes it (stored as `user-edited`), **Discard set** drops it.
5. **Rest.** Timestamp-based countdown (default 90 s, Sensor → Training settings), −15/+15 s, Skip; at zero the phone vibrates, beeps (after a first tap) and flashes. Then **Next set** (weight prefilled from the previous set) or **Finish exercise**.
6. **Summary** table per exercise (set, kg, reps, mean peak velocity, velocity loss, rep period), **Add another exercise** or **Finish workout**. `buildExerciseReportData(block, sets, samples)` in `workout.js` is the hook for the W3 report.

Recovery: the active workout (exercise, weight, saved sets, rest timer, and an unsaved review with its samples) is stored in IndexedDB; after a reload the Train page offers **Resume**. A set that is still recording when the page reloads is lost (samples live in memory); a BLE drop mid-set goes to review with the captured samples.

Data model (IndexedDB `liftiq-local`, version 4 (v4 adds the `photos` store); `sessions` and `rawSessions` untouched; the migration is additive, see `storesToCreate` in `workout-storage.js`): `exercises` (custom), `workouts` `{id, startedAt, endedAt, blocks:[{id, exerciseId, exerciseName, startedAt, endedAt, setIds}]}`, `sets` (weightKg may be null, repsDetectedWithSetup, repsDetectedExcludingSetup, setupPullFlagged, setupPullIncluded, repsConfirmed, repsSource `sensor-confirmed|user-edited`, metrics, pulses, restS, sampleCount, droppedPackets, sensorName, firmwareVersion, appVersion, note), `setSamples` `{setId, samples}`, `meta` (active workout). Storage is behind an interface with `MemoryWorkoutStorage` (tests) and `IdbWorkoutStorage`. Rest time and weight step live in `localStorage` (`liftiq-train-settings`).

History groups workouts by date, then exercise blocks, then sets labelled like `Seated cable row · Set 2 · 45 kg · 8 reps · 22 Nov 2026 14:05` (weight omitted when unknown); opening a set shows its chart and metrics again, with CSV download and delete. Old sets from the previous app are under **Older sets**.

Per-set CSV (`liftiq-set v1`): file name `liftiq_<YYYY-MM-DD>_<exercise-slug>_set<N>.csv` (a second workout the same day gets `_2`, `_3`, ...); `# key: value` header lines (format, exercise, weight_kg, set_number, reps_detected_with_setup, reps_detected_excluding_setup, setup_pull_flagged, setup_pull_included, reps_confirmed, reps_source, firmware_version, app_version, sensor_name, captured_at, note), then the usual columns (`actual_rep_count` = confirmed reps) plus `vert_accel_m_s2` and `vert_velocity_m_s`. `tools/livesets/analyze_live_sets.py` reads both formats.

## Code layout

All paths below are inside `dev/` and `stable/` (stable is a released copy of dev).

**Dev only:** `protocol.js`, `raw-protocol.js`, `packet-stats.js`, `session.js`, `ble.js`, `ready-check.js` and `analysis/*.js` in `dev/` are one-line re-exports of `dev/vendor/liftiq-sensor/`, a generated copy of `packages/liftiq-sensor/` (the source of truth). Do not edit the vendored folder: change the package and run `npm run vendor` (`npm run vendor:check` verifies it). The rows below describe what each module does.

| File | Role |
|---|---|
| `channel.js` | `CHANNEL` (`dev`/`stable`) and `APP_VERSION`; rewritten by the release tool (stable only after a release) |
| `protocol.js` | Packet decoder, constants (incl. INFO UUID/parser), CSV, battery classification |
| `packet-stats.js` | Sequence unwrapping, drop count, packet rate (debug) |
| `session.js` | Capture state machine (no DOM, no Bluetooth; unit tested) |
| `raw-protocol.js` | Lab chunk parsing, reassembly, stream/header decoding, Raw CSV v1 (pure, unit tested) |
| `raw-session.js` | Lab state machine (arm/start/stop/download/resend/save; unit tested) |
| `ble.js` | BLE client over a transport interface, default Web Bluetooth (RAW and INFO characteristics optional) |
| `storage.js` | IndexedDB wrapper |
| `chart.js` | Canvas signal chart |
| `wakelock.js` | Screen Wake Lock |
| `ui.js` | DOM rendering |
| `app.js` | Wiring |
| `workout.js` | (dev) Workout flow state machine + `buildExerciseReportData` (no DOM/BLE; unit tested) |
| `workout-storage.js` | (dev) Storage interface, in-memory and IndexedDB implementations, DB v3 migration plan |
| `exercises.js` | (dev) Seed exercise library, pictograms, custom exercises, slugs |
| `exercise-db.js`, `exercise-media.js` | (dev) Open exercise dataset library (1,324 exercises, `assets/exercise-db/`), picker filters/pagination, equipment support classification, runtime media URLs + attribution renderer; see `docs/EXERCISE_DATA.md` |
| `set-format.js` | (dev) Readable set labels, CSV file names, per-set CSV |
| `analysis/pulses.js`, `analysis/live-counter.js` | (dev) Shims over the vendored offline pulse analysis and causal live counter (`docs/REP_ANALYSIS.md`) |
| `ready-check.js`, `photos.js`, `dev-tools.js` | (dev) Stillness detector, machine photo downscale/storage, developer-tools flag |
| `pulse-chart.js`, `train-view.js`, `rest-alert.js` | (dev) Review chart (SVG), Train/History DOM rendering, rest beep/vibration |
| `sw.js` | Offline cache (`APP_FILES`, `CACHE_PREFIX`, `CACHE_NAME`) |

## Development

```bash
npm test               # dev unit tests            (app/dev/test)
npm run test:stable    # stable unit tests         (app/stable/test)
npm run compat         # firmware <-> app compatibility gates (tests/compat)
npm run test:tools     # python tests of tools/ble, tools/trajectory and tools/livesets
npm run test:sensor    # shared sensor package tests (packages/liftiq-sensor/test)
npm run vendor         # copy packages/liftiq-sensor/src into dev/vendor/liftiq-sensor
npm run vendor:check   # fail if the vendored copy differs from the package
npm run check:links    # Markdown link check (tools/check-links.mjs)
npm run test:all       # everything above (vendor:check + link check + all test suites)
```

Unit tests run `node --test`: packet decoding, CSV, raw-capture reassembly/CSV and the Lab state machine, the session
state machine (with a fake BLE client and clock), the packet tracker, and the older-firmware connection fallbacks. They need no
packages or sensor. See [`docs/DEVELOPMENT.md`](../docs/DEVELOPMENT.md) (Rules) and [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md).
