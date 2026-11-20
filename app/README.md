# LiftIQ phone app

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

## Using the app

The bottom navigation has four sections: **Workout**, **History**, **Lab** and
**Sensor**. The header always shows the connection state and the sensor battery.

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

For the offline trajectory experiments (`docs/DEVELOPMENT.md`, Step 0). Needs firmware with the
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
D3->D1 jumper, see `hardware/BOM.md`); and a valid reading. The percentage is a linear
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

## Code layout

All paths below are inside `dev/` and `stable/` (stable is a released copy of dev).

| File | Role |
|---|---|
| `channel.js` | `CHANNEL` (`dev`/`stable`) and `APP_VERSION`; rewritten by the release tool (stable only after a release) |
| `protocol.js` | Packet decoder, constants (incl. INFO UUID/parser), CSV, battery classification |
| `packet-stats.js` | Sequence unwrapping, drop count, packet rate (debug) |
| `session.js` | Capture state machine (no DOM, no Bluetooth; unit tested) |
| `raw-protocol.js` | Lab chunk parsing, reassembly, stream/header decoding, Raw CSV v1 (pure, unit tested) |
| `raw-session.js` | Lab state machine (arm/start/stop/download/resend/save; unit tested) |
| `ble.js` | Web Bluetooth client (RAW and INFO characteristics optional) |
| `storage.js` | IndexedDB wrapper |
| `chart.js` | Canvas signal chart |
| `wakelock.js` | Screen Wake Lock |
| `ui.js` | DOM rendering |
| `app.js` | Wiring |
| `sw.js` | Offline cache (`APP_FILES`, `CACHE_PREFIX`, `CACHE_NAME`) |

## Development

```bash
npm test               # dev unit tests            (app/dev/test)
npm run test:stable    # stable unit tests         (app/stable/test)
npm run compat         # firmware <-> app compatibility gates (tests/compat)
npm run test:tools     # python tests of tools/ble and tools/trajectory
npm run test:all       # everything above
```

Unit tests run `node --test`: packet decoding, CSV, raw-capture reassembly/CSV and the Lab state machine, the session
state machine (with a fake BLE client and clock), the packet tracker, and the older-firmware connection fallbacks. They need no
packages or sensor. See `docs/DEVELOPMENT.md` (Rules) and `docs/ARCHITECTURE.md`.
