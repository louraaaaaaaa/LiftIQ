# LiftIQ phone app

This is a dependency-free, installable web app for the current BLE firmware.
It uses Web Bluetooth for sensor access and IndexedDB for on-device session
history and saved CSV contents.

## Browser and hosting requirements

- Windows, macOS, or Linux PC with a current Chrome or Edge browser, or an
  Android phone with current Chrome (Web Bluetooth required).
- Serve this directory from an **HTTPS** website. Web Bluetooth and PWA
  installation need a secure origin. `http://localhost` is allowed for PC
  development; do not open `index.html` directly as a `file://` page.
- iOS Safari currently does not support Web Bluetooth. Use the Python
  dashboard on a computer or build a separate native iOS client.

For PC testing, open a terminal in this `app` directory and run:

```powershell
npm.cmd start
```

This uses Node.js and serves only on the PC at <http://localhost:8000>. Keep
the terminal running, then open the address in Chrome or Edge. Click
**Connect sensor**, choose **GymIQ Sensor**, then test with the real device
nearby. Turn on the PC's Bluetooth and close other apps already connected to
the tracker.

On macOS or Linux, use `npm start` instead.

For phone testing, publish the contents of `app/` to any static **HTTPS**
host; a plain network URL such as `http://192.168.x.x:8000` is not a secure
origin and cannot access Bluetooth. Open the hosted HTTPS URL in Android
Chrome, connect to the same powered sensor, and add the page to the Home
screen if desired. Set history is stored separately on each browser/device.

On Android, use **Add to Home screen** or **Install app** from Chrome's menu.
The app shell is cached for offline launch; Bluetooth still requires the
sensor to be nearby and connected.

## Using the app

1. Open **Sensor & settings**, power on the sensor, and tap **Connect sensor**.
2. Select **GymIQ Sensor** in the browser's Bluetooth device picker. No UUID
   input is needed. If Android asks for permission or pairing, approve it.
3. Check Bluetooth, telemetry, calibration, and the estimated battery status
   on the sensor page. Set the start countdown there (3 seconds by default).
   Battery monitoring requires the D9 divider wiring documented in
   [`hardware/BOM.md`](../hardware/BOM.md).
4. Optionally enter an exercise name on **Workout**, then tap **Start set**.
   The app runs the countdown and calibrates the sensor before recording.
   Keep it still during calibration.
5. Pause/resume or stop the set. Pausing suspends sample logging and plots,
   while the rep count continues to follow the sensor. After stopping, confirm
   the detected reps or enter your actual count; the confirmed count is saved
   with the samples.
6. Tap **History**, then **↓ CSV** to download a copy of the saved CSV, or **Delete** to remove
   both the session and its CSV from this device.

The CSV columns include elapsed time, XYZ acceleration, total and dynamic
acceleration, phase name and ID, rep count, and the user-confirmed actual rep
count. Sample-rate and speed estimates are not included. The current firmware
uses acceleration-only phase and rep heuristics; phase labels indicate motion
events rather than a direct measurement of movement direction.
Paused samples are omitted, while elapsed time retains the pause gap.

Set history and CSV data are local to the browser on this device. The app asks
the browser to protect its storage from automatic cleanup, but this is not a
backup and the browser may decline. Clearing browser/site data can remove
the history; use **↓ CSV** to keep an independent copy.

## Development

```bash
node --test
```

The tests cover the firmware BLE packet decoder and CSV serialization without
requiring packages or a sensor.
