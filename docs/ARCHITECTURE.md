# LiftIQ architecture

## Components

| Component | Where | Role |
|---|---|---|
| Sensor firmware | `firmware/LiftIQ_BLE/` | XIAO ESP32C3 + BMI160. Samples at 100 Hz, counts reps, streams 50 Hz telemetry over BLE; experimental raw 6-axis capture. `protocol_v1.h` holds the pure packet encoders |
| Phone app (stable) | `app/stable/` | The released Web Bluetooth PWA. **The only thing GitHub Pages publishes.** Changes only through the release tool |
| Phone app (dev) | `app/dev/` | Development copy (Step 0 / Lab, INFO read, DEV badge). Never deployed |
| Protocol contract | `docs/PROTOCOL.md`, `tests/compat/` | Frozen v1 BLE contract and the executable gates |
| PC tools | `tools/` | Serial bring-up (`serial/`), BLE debug dashboard and protocol self-test (`ble/`), offline trajectory analysis (`trajectory/`), release tool |
| Data | `data/recordings/` | Serial captures, app CSV exports, raw 6-axis captures |
| Hardware | `hardware/` | BOM, datasheets, PCB v1 manufacturing files |

## Data flow

```
BMI160 --I2C 400 kHz--> firmware loop (100 Hz) --> rep detector --> TelemetryV1
                                                    protocol_v1.h  encodeTelemetryV1() 18 bytes
   --BLE notify 50 Hz--> Web Bluetooth (ble.js) --> decodeTelemetry --> SessionMachine --> IndexedDB / CSV
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

Run everything with `cd app && npm run test:all`; CI (`.github/workflows/compat.yml`) runs the same
node and python tests on every push and pull request, without any Arduino toolchain.

## Folder map

```
README.md                      overview and quick start
.github/workflows/             pages.yml (publish app/stable), compat.yml (tests)
app/dev/  app/stable/          the two apps; app/package.json, app/dev-server.mjs, app/README.md
docs/                          DEVELOPMENT.md (tracker), ARCHITECTURE.md, PROTOCOL.md
docs/experiments/              STEP0_PROTOCOL.md (physical experiment protocol)
docs/references/               third-party reference papers (see its README)
firmware/LiftIQ_BLE/           the sketch + protocol_v1.h (+ generated selftest vectors); firmware/archive/
hardware/                      BOM.md, datasheets/, pcb/v1/{gerbers,flatcam}, pcb/README.md
tests/compat/                  firmware <-> app compatibility gates (node --test) and golden vectors
tools/serial|ble|trajectory/   PC tools; tools/release-app.mjs; tools/README.md
data/recordings/               serial-legacy/, app-sessions/, raw/ (+ README)
```
