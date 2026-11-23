# LiftIQ

LiftIQ is a magnet-mounted XIAO ESP32C3 + BMI160 prototype that tracks exercise reps from equipment
movement and shows them in a phone app over Bluetooth LE.

## Quick start (use it)

1. **Sensor:** in the Arduino IDE (or `arduino-cli`) select **XIAO_ESP32C3**, install the `DFRobot_BMI160`
   library and flash [`firmware/LiftIQ_BLE/LiftIQ_BLE.ino`](firmware/LiftIQ_BLE/LiftIQ_BLE.ino).
2. **App:** open the published app at <https://louraaaaaaaa.github.io/LiftIQ/> in Chrome or Edge (PC) or
   Chrome on Android, then **Add to Home screen / Install app**. This is always the **stable** release
   (`app/stable`). iOS Safari has no Web Bluetooth, so iPhones cannot connect to the sensor.
3. Open **Sensor -> Connect sensor**, pick your `LiftIQ-XXXX`, then on **Workout** start a set and keep
   the sensor still during the five-second calibration (stable app; the dev app's Train flow uses a 1.5 s ready check instead). Stop the set and confirm the rep count; history and
   CSV exports stay in that browser's local storage.

The battery divider midpoint is on D3/GPIO5 (ADC2), which the ESP32-C3 cannot read in software: fit a
jumper from the D3 pad to D2/GPIO4 (see [`hardware/BOM.md`](hardware/BOM.md)). The app estimates charge
linearly from 3.3-4.2 V; it is not a fuel gauge. Never connect a LiPo cell directly to a GPIO. The PCB
files have **not yet been verified** against the ESP32C3 footprint and battery net; read
[`hardware/BOM.md`](hardware/BOM.md) before ordering or assembling (the `hardware/` folder is being reorganised, so file locations inside it may change).

## Develop

| What | How |
|---|---|
| Run the dev app (port 8000) | `cd app && npm start` (stable: `npm run start:stable`, port 8001) |
| Run all checks | `cd app && npm run test:all` (vendor check, Markdown link check, dev + sensor package + stable unit tests, firmware/app compatibility gates, python tool tests) |
| Edit shared sensor code | change `packages/liftiq-sensor/src`, then `cd app && npm run vendor` (copies it into `app/dev/vendor/`); `npm run test:sensor` |
| Release dev -> stable | `node tools/release-app.mjs --version X.Y.Z [--dry-run]`, review, commit, push ([app/README.md](app/README.md)) |
| Compile firmware | `arduino-cli compile --fqbn esp32:esp32:XIAO_ESP32C3 firmware/LiftIQ_BLE` |

## Where things are

- [`app/`](app/README.md) - phone app: `stable/` (published) and `dev/` (work in progress)
- [`packages/liftiq-sensor/`](packages/liftiq-sensor/README.md) - shared, framework-free sensor code (source of truth, vendored into the apps)
- [`firmware/`](firmware/LiftIQ_BLE/LiftIQ_BLE.ino) - current BLE firmware; [`firmware/archive/`](firmware/archive/README.md) older sketches
- [`docs/PROTOCOL.md`](docs/PROTOCOL.md) - frozen BLE protocol v1 and extension rules
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) - components, data flow, release model, folder map
- [`docs/README.md`](docs/README.md) - index of every document with a status tag; **start here** to find anything
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) - short living tracker: rules, status board, next steps; long history in [`docs/history/`](docs/history/DEVELOPMENT_HISTORY.md), dated entries in [`CHANGELOG.md`](CHANGELOG.md)
- [`docs/OPENGYM_INTEGRATION_DESIGN.md`](docs/OPENGYM_INTEGRATION_DESIGN.md) - current direction: the sensor inside a fork of the openGym app
- [`docs/experiments/STEP0_PROTOCOL.md`](docs/experiments/STEP0_PROTOCOL.md) - raw capture / trajectory experiment protocol
- [`tests/compat/`](tests/compat) - firmware <-> app compatibility tests (run in CI)
- [`tools/`](tools/README.md) - serial/BLE/trajectory PC tools and the release tool
- [`data/recordings/`](data/recordings/README.md) - recorded CSVs
- [`hardware/`](hardware/BOM.md) - BOM, datasheets, PCB v1 files, v2 work in progress (being reorganised by the owner)

## Hosting notes

GitHub Pages publishes only `app/stable` (workflow `.github/workflows/pages.yml`) after a push to `main`
or `master` that changes it. Check the repository's **Settings -> Pages** and **Actions** tabs if the URL
shows the README or the deployment is pending. Web Bluetooth needs HTTPS (or `http://localhost`); a LAN
HTTP address does not grant Bluetooth access.

## License

LiftIQ's software (phone app, shared sensor package, tools) and firmware are licensed under the
**GNU Affero General Public License v3.0 or later** (AGPL-3.0-or-later), see [`LICENSE`](LICENSE).
The licence of the hardware design files and hardware documentation (`hardware/`) is **not decided yet**.
Third-party components keep their own licences (exercise dataset text MIT, Wikimedia photos, the Tiny Open
Logger paper CC BY 4.0, the DFRobot_BMI160 library MIT, ...); the exercise media from Gym visual is not
stored here and is loaded at runtime. Details: [`NOTICE.md`](NOTICE.md).
