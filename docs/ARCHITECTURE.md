# LiftIQ architecture

Status: current
Last reviewed: 2026-11-23
Purpose: components, data flow, release model, vendoring, compatibility gates and the real folder map. The Train flow described under the dev app is a reference implementation, see the note below the component table.

## Components

| Component | Where | Role |
|---|---|---|
| Sensor firmware | `firmware/LiftIQ_BLE/` | XIAO ESP32C3 + BMI160. Samples at 100 Hz, counts reps, streams 50 Hz telemetry over BLE; experimental raw 6-axis capture. `protocol_v1.h` holds the pure packet encoders |
| Phone app (stable) | `app/stable/` | The released Web Bluetooth PWA. **The only thing GitHub Pages publishes.** Changes only through the release tool |
| Phone app (dev) | `app/dev/` | Development copy (Step 0 / Lab, INFO read, Train workout flow, DEV badge). Never deployed. Consumes the sensor package through a vendored copy (`app/dev/vendor/liftiq-sensor/`). **Its Train flow, exercise picker, photos and history are a reference implementation (see the note below)** |
| Sensor package | `packages/liftiq-sensor/` | **Source of truth** for the framework-free, DOM-free sensor code (protocol decoder, packet stats, session state machine, ready check, pulse analysis, BLE client + transport interface). AGPL-3.0-or-later. Vendored by `tools/vendor-sensor.mjs` into consumers (the dev app, later the openGym fork) |
| Protocol contract | `docs/PROTOCOL.md`, `tests/compat/` | Frozen v1 BLE contract and the executable gates |
| PC tools | `tools/` | Serial bring-up (`serial/`), BLE debug dashboard and protocol self-test (`ble/`), offline trajectory analysis (`trajectory/`), release tool |
| Data | `data/recordings/` | Serial captures, app CSV exports, raw 6-axis captures |
| Hardware | `hardware/` | BOM, datasheets, PCB v1 manufacturing files |

> **Reference implementation, superseded by the openGym integration.** The dev app's own Train flow, exercise picker/database, photos and
> history (W2, W2b, W2c, W2d) are kept for the analysis, BLE, protocol and session logic they exercise. The product direction is the sensor
> inside a fork of the openGym app (design: [`OPENGYM_INTEGRATION_DESIGN.md`](OPENGYM_INTEGRATION_DESIGN.md)), which brings its own UI. The
> sensor package, firmware, protocol, tools and the stable app are unaffected by that decision.

## Data flow

```
BMI160 --I2C 400 kHz--> firmware loop (100 Hz) --> rep detector --> TelemetryV1
                                                    protocol_v1.h  encodeTelemetryV1() 18 bytes
   --BLE notify 50 Hz--> BleClient / WebBluetoothTransport (packages/liftiq-sensor) --> decodeTelemetry --> SessionMachine --> IndexedDB / CSV
   <--BLE write 0x01 / 0x02-- app controls (calibrate/start set, rep thresholds)

Research capture (dev app only): RAW characteristic, 200 Hz 6-axis recording in sensor RAM,
chunked upload after the set --> raw CSV v1 --> data/recordings/raw --> tools/trajectory
```

## Release model: stable vs dev

- **`app/stable/`** is what users get at the Pages URL. It carries `VERSION` (e.g. `1.0.0`), its own
  tests, and a service worker cache `liftiq-app-vN`.
- **`app/dev/`** is where all work happens. It is visibly different: title and PWA name "LiftIQ Dev",
  purple theme colour and icon, a DEV badge, version `x.y.z-dev`, service worker cache prefix
  `liftiq-dev-` (so even if both were ever served from one origin they could not clobber each other's
  caches), run locally on port 8000 (stable on 8001; different ports are different browser origins).
- **Release = `node tools/release-app.mjs --version X.Y.Z`** (from `app/`: `npm run release -- --version X.Y.Z`;
  add `--dry-run` first). It runs the dev tests and `tests/compat`, refuses to run if `app/stable` has
  uncommitted changes, builds the stable app from `app/dev` (copies it, drops `icon-dev.svg`, strips the
  `<!--dev:start-->...<!--dev:end-->` DEV badge, restores the stable title/manifest/theme/icon, rewrites
  `channel.js` to `CHANNEL = "stable"` and the version, bumps the SW cache number), verifies the result
  contains no dev branding, runs the stable tests, and prints next steps. It never commits or pushes.
- The Pages workflow (`.github/workflows/pages.yml`) triggers only on changes to `app/stable/**` (or
  the workflow file) and uploads only `app/stable`. Dev code cannot be deployed by accident.
  The first deploy after the repository reorganisation publishes an app identical to the one already
  live (`app/stable` is the app from commit `a81fe00`).
- Firmware is not part of the app release: it is flashed by hand. It must remain compatible with the
  latest stable app (next section).

## Shared sensor package and vendoring

```
packages/liftiq-sensor/src/   <-- the ONLY place to edit sensor code (+ test/, README.md, package.json)
        | node tools/vendor-sensor.mjs --target <consumer dir>   (npm run vendor in app/)
        v
app/dev/vendor/liftiq-sensor/ (generated: header "VENDORED FROM packages/liftiq-sensor@x.y.z - do not edit",
                               VERSION.json with version + sha256 of every source file)
        ^
app/dev/{protocol,raw-protocol,packet-stats,session,ble,ready-check}.js, app/dev/analysis/*.js
        = one-line `export * from './vendor/liftiq-sensor/...'` shims, so the rest of the dev app imports the old paths unchanged
```

- The package has no framework, DOM, storage or dependency. BLE access goes through a small transport interface
  (default `WebBluetoothTransport`; a Capacitor transport can be added without touching the rest). Everything
  UI-, storage- or app-specific (train view, IndexedDB, workout flow, exercise DB, photos, rest alert, wake lock,
  chart rendering, Lab `raw-session.js`) stays in `app/dev`.
- `npm run vendor:check` (part of `npm run test:all`, run by CI) fails when the vendored copy differs from the source.
  Edit the package, then run `cd app && npm run vendor`.
- `app/stable` is a frozen release and is NOT built from the package: the release tool copies `app/dev` (shims and the
  vendored folder included) when promoting. Compat gates `golden.test.js` / `constants-guard.test.js` import the dev
  decoder through the shim; the PACKET_LENGTH check reads the package source.
- Package tests: `cd app && npm run test:sensor` (node --test, same fixtures in `tests/fixtures/`).
- Licence: AGPL-3.0-or-later (`LICENSE`, `NOTICE.md` at the repository root).

## Compatibility policy (firmware vs app)

Any firmware version must keep working with the latest stable app and older stable releases.
Therefore `docs/PROTOCOL.md` freezes v1 and allows only additive extensions on new characteristics
and opcodes; experimental features stay dormant unless a newer app asks for them. The gates:

| Gate | File | What it proves |
|---|---|---|
| Golden decode | `tests/compat/golden.test.js` | stable and dev decoders decode every v1 vector |
| Real encoder | `tests/compat/firmware-encoder.test.js` | `protocol_v1.h` compiled with host g++ emits the golden bytes |
| Behaviour | `tests/compat/behavior.test.js` | stable `SessionMachine` handles the packet sequences of a v1 firmware (calibration 1 -> 2, failure, loss, disconnect) |
| Constants | `tests/compat/constants-guard.test.js` | UUIDs, name prefix, packet length, opcodes and live-telemetry config agree between sketch, stable and dev |
| Board | `tools/ble/check_protocol_serial.py` | the encoder on the real board matches the golden file (flag `DEBUG_PROTOCOL_SELFTEST`) |

Run everything with `cd app && npm run test:all` (it also runs `tools/check-links.mjs`, which fails on broken relative Markdown links); CI (`.github/workflows/compat.yml`) runs the same
node and python tests on every push and pull request, without any Arduino toolchain.

## Folder map

Current tree (2026-11-23; `node_modules`, `.git` and `hardware/` internals not expanded; `hardware/` is being reorganised by the owner).

```
README.md  CHANGELOG.md        overview and quick start; dated change log (moved out of docs/DEVELOPMENT.md)
LICENSE  NOTICE.md             AGPL-3.0-or-later text; licences of LiftIQ and of third-party components
.gitattributes  .gitignore
.github/workflows/             pages.yml (publishes app/stable only), compat.yml (node, link check and python tests)
app/
  package.json  dev-server.mjs  README.md        npm scripts (start, test:all, release, ...), static dev server
  dev/                         the development app (reference implementation of the Train flow; port 8000)
    *.js  index.html  styles.css  sw.js  manifest.webmanifest   app modules; protocol/session/ble/... are one-line shims
    analysis/                  shims over the vendored pulse analysis
    assets/                    exercise-db/ (generated index + MIT licence) and machines/ (Wikimedia photos + credits.json)
    vendor/liftiq-sensor/      GENERATED copy of packages/liftiq-sensor (npm run vendor), never edit
    test/                      dev app unit tests (node --test)
  stable/                      the released app (Pages), frozen; changes only through tools/release-app.mjs; has its own test/
packages/liftiq-sensor/        source of truth for the shared sensor code: src/ (+ src/analysis/), test/, package.json, README.md
firmware/
  LiftIQ_BLE/                  the sketch + protocol_v1.h (+ generated protocol_v1_selftest_vectors.h)
  archive/                     older sketches (i2c-scanner, serial-imu-bringup) and legacy-tuner.html, with a README
docs/
  README.md                    index of all documents with status tags (start here)
  DEVELOPMENT.md               short living tracker (status board, rules, next steps)
  ARCHITECTURE.md  PROTOCOL.md  REP_ANALYSIS.md  OPENGYM_INTEGRATION_DESIGN.md      current
  UX_TRAIN_FLOW.md  EXERCISE_DATA.md  IMAGE_CREDITS.md  HANDOFF_HARDWARE.md        reference
  INTEGRATION_OPENGYM.md       research notes that fed the design (historical)
  history/DEVELOPMENT_HISTORY.md   the long per-batch notes, moved verbatim
  experiments/STEP0_PROTOCOL.md    physical experiment protocol (IMU decision gate)
  references/                  third-party papers (README + the Tiny Open Logger PDF)
hardware/                      BOM.md, datasheets/, v1/ (gerbers, flatcam, schematic image), v2/ (work in progress); owned by the owner
tests/
  compat/                      firmware <-> app compatibility gates (node --test), golden/ vectors, host/ (C++ encoder test), tools/ (header generator)
  fixtures/                    shared test data: seated-row-2026-11-22/ (recordings + golden counts), exercise-db/ (sample dataset)
tools/
  README.md  requirements.txt
  serial/                      legacy serial plotting / cube view / rep counter
  ble/                         BLE debug dashboard (firmware_debug.py), protocol board self-test (check_protocol_serial.py)
  trajectory/                  offline 6-axis analysis (Step 0): fusion, ZUPT, sensitivity, synthetic data
  livesets/                    analysis of the recorded live sets (analyze_live_sets.py)
  exercise-db/                 build-index.mjs: open exercise dataset -> app/dev/assets/exercise-db/ (media is linked at runtime, never stored)
  release-app.mjs  vendor-sensor.mjs  check-links.mjs     release tool, sensor vendoring, Markdown link check
data/recordings/               serial-legacy/, app-sessions/ (CSV exports + per-set analysis folders), raw/ (+ README)
```
