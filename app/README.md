# LiftIQ phone app

A dependency-free, installable strength-training log for the LiftIQ BLE
firmware (Web Bluetooth PWA, plain ES modules, no build step). Sessions and CSV
files stay in IndexedDB on this device.

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

(`npm start` on macOS/Linux.) This serves the app only on the PC at
[http://localhost:8000](http://localhost:8000). Open it in Chrome or Edge, tap
**Sensor → Connect sensor**, and choose your **LiftIQ-XXXX** sensor (the legacy
**GymIQ Sensor** name also works). Turn on the PC's Bluetooth and close other
apps already connected to the tracker.

For phone testing, publish the contents of `app/` to any static **HTTPS** host
(GitHub Pages publishes `app/` as-is). A plain `http://192.168.x.x` address is
not a secure origin and cannot access Bluetooth. After updating the files the
service worker cache name (`CACHE_NAME` in `sw.js`) must be bumped, and every
new file added to `APP_FILES`. On Android use **Add to Home screen** / **Install
app** from Chrome's menu; the app shell is cached for offline launch, but
Bluetooth still needs the sensor nearby.

## Using the app

The bottom navigation has three sections: **Workout**, **History** and
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
the pause gap. Exports are collected in `tools/recordings/app-sessions/`.

Set history is local to the browser. The app asks the browser to protect its
storage from cleanup but that is not a backup; use **↓ CSV** to keep a copy.

## Code layout

| File | Role |
|---|---|
| `protocol.js` | Packet decoder, constants, CSV, battery classification |
| `packet-stats.js` | Sequence unwrapping, drop count, packet rate (debug) |
| `session.js` | Capture state machine (no DOM, no Bluetooth; unit tested) |
| `ble.js` | Web Bluetooth client |
| `storage.js` | IndexedDB wrapper |
| `chart.js` | Canvas signal chart |
| `wakelock.js` | Screen Wake Lock |
| `ui.js` | DOM rendering |
| `app.js` | Wiring |
| `sw.js` | Offline cache (`APP_FILES`, `CACHE_NAME`) |

## Development

```bash
npm test
```

Runs `node --test`: packet decoding, CSV, the session state machine (with a fake
BLE client and clock) and the packet tracker. It needs no packages or sensor.
