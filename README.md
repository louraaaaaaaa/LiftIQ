# LiftIQ

LiftIQ is a magnet-mounted XIAO ESP32C3 + BMI160 prototype for tracking exercise
reps from equipment movement. The repository now separates the latest BLE
firmware, the phone app, and archived development sketches.

## Current prototype

- **Firmware:** [`firmware/current/LiftIQ_BLE/LiftIQ_BLE.ino`](firmware/current/LiftIQ_BLE/LiftIQ_BLE.ino)
  advertises the `GymIQ Sensor` BLE service and streams live acceleration,
  acceleration-based phase, calibration status, rep count, and battery voltage.
  Speed estimation is disabled because the IMU-only estimate drifted in tests.
- **Phone app:** [`app/`](app/README.md) is an installable, mobile-first
  strength-training dashboard for connecting to the sensor, tracking a set,
  and keeping set history and CSV files in local app storage.
- **PC tools:** [`tools/`](tools/README.md) contains the serial bring-up
  scripts and the Python BLE debug dashboard.
- **Earlier sketches:** [`firmware/archive/`](firmware/archive/README.md)
  keeps the previous serial firmware and BLE tuner prototype.

## App quick start

1. Select **XIAO_ESP32C3** in the Arduino IDE, install the `DFRobot_BMI160`
   library, and flash `firmware/current/LiftIQ_BLE/LiftIQ_BLE.ino`.
2. On your Windows PC, run `npm.cmd start` from the `app/` folder and open
   <http://localhost:8000> in Chrome or Edge.
3. For phone testing, publish `app/` to an HTTPS static host and open its URL
   in Chrome on Android. A LAN HTTP address does not grant Bluetooth access.
4. Open **Sensor**, connect to **GymIQ Sensor**, and optionally set its custom
   name and rep thresholds. On **Workout**, start a set and keep the device
   still during the fixed five-second calibration countdown.
5. Stop the set and confirm or correct the rep count. The samples and confirmed
   count are saved in that browser's history; expand **Set history** to download
   a CSV copy.

The current firmware reads the optional battery divider at D1/GPIO3 (ADC1).
Never connect a LiPo cell directly to a GPIO. The exported PCB files have not
yet been checked against the ESP32C3 footprint and D1 battery net; review
[`hardware/manufacturing/README.md`](hardware/manufacturing/README.md) before
ordering or assembly. See [hardware/BOM.md](hardware/BOM.md) for wiring.

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
hardware/manufacturing/       Gerber/drill exports and FlatCAM project
tools/                        PC-side serial/BLE development tools
```

See [hardware/BOM.md](hardware/BOM.md) for the hardware and wiring details.
