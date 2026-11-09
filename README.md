# LiftIQ

LiftIQ is a magnet-mounted ESP32-S3 + BMI160 prototype for tracking exercise
reps from equipment movement. The repository now separates the latest BLE
firmware, the phone app, and archived development sketches.

## Current prototype

- **Firmware:** [`firmware/current/LiftIQ_BLE/LiftIQ_BLE.ino`](firmware/current/LiftIQ_BLE/LiftIQ_BLE.ino)
  advertises the `GymIQ Sensor` BLE service and streams live acceleration,
  acceleration-based phase, calibration status, rep count, and battery voltage.
  Speed estimation is disabled because the IMU-only estimate drifted in tests.
- **Phone app:** [`app/`](app/README.md) is an installable, phone-first web app
  for connecting to the sensor, tracking a set, and keeping set history and
  CSV files in local app storage.
- **PC tools:** [`tools/`](tools/README.md) contains the serial bring-up
  scripts and the Python BLE debug dashboard.
- **Earlier sketches:** [`firmware/archive/`](firmware/archive/README.md)
  keeps the previous serial firmware and BLE tuner prototype.

## App quick start

1. Flash `firmware/current/LiftIQ_BLE/LiftIQ_BLE.ino` to the ESP32-S3 with the Arduino
   IDE and the `DFRobot_BMI160` library.
2. On your Windows PC, run `npm.cmd start` from the `app/` folder and open
   <http://localhost:8000> in Chrome or Edge.
3. For phone testing, publish `app/` to an HTTPS static host and open its URL
   in Chrome on Android. A LAN HTTP address does not grant Bluetooth access.
4. Open **Sensor & settings**, tap **Connect sensor**, and select **GymIQ
   Sensor**. Set the countdown, then start a workout and keep the device still
   while it calibrates.
5. Stop the set and confirm or correct the rep count. The samples and confirmed
   count are saved in that browser's local history; use **History** → **↓ CSV**
   to download a copy.

Battery monitoring on D9 assumes an external 2:1 voltage divider. Verify the
sensor wiring before use; a LiPo cell must not be connected directly to D9.
See [hardware/BOM.md](hardware/BOM.md).

Web Bluetooth works in Chrome/Edge on PC and Chromium-based browsers on
Android. iOS Safari does not provide Web Bluetooth, so it cannot connect to
the current firmware through this web app. A native iOS app would be a
separate implementation.

The GitHub Pages workflow in `.github/workflows/pages.yml` publishes only
`app/` to the repository Pages site after a push to `main` or `master`. Once
that workflow has been pushed and its first deployment succeeds, the app is
available at `https://louraaaaaaaa.github.io/LiftIQ/`. Check the repository's
**Settings → Pages** and **Actions** tabs if the URL still shows the README or
the deployment is pending.

The saved history is held in the browser's IndexedDB storage on that device;
it is not synchronized or backed up. Clearing browser/site data can erase it.
CSV exports remain in the app until a set is deleted, and a downloaded copy is
also placed in the phone's normal downloads.

## Repository layout

```text
app/                         Phone-first PWA and app-local history
firmware/current/            Latest BLE set-tracking firmware
firmware/archive/             Superseded firmware and tuner prototype
hardware/                     BOM, wiring notes, and datasheets
tools/                        PC-side serial/BLE development tools
```

See [hardware/BOM.md](hardware/BOM.md) for the hardware and wiring details.
