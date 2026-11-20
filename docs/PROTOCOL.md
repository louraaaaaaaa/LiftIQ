# LiftIQ BLE protocol (v1 - FROZEN)

This is the contract between the sensor firmware and the phone app. **Policy (architect decision):
any firmware version must keep working with the latest STABLE app and with older stable releases.**
The executable form of this document is `tests/compat/` (golden vectors, host-compiled firmware
encoder, behavioural tests against the stable app, constant guards). If this text and the tests
disagree, the tests (and `app/stable/`) are the truth and this file is a bug.

Derived from: `app/stable/protocol.js`, `app/stable/session.js`, `app/stable/ble.js`,
`firmware/LiftIQ_BLE/LiftIQ_BLE.ino`, `firmware/LiftIQ_BLE/protocol_v1.h`.

## 1. GATT layout

| Item | UUID | Properties | Status |
|---|---|---|---|
| Service | `4fa8691a-1365-4a4f-a808-3fda13b292e0` | - | v1, frozen |
| Telemetry (notify) | `beb5483e-36e1-4688-b7f5-ea07361b26a8` | READ, NOTIFY | v1, frozen |
| Control (write) | `cba8691a-1365-4a4f-a808-3fda13b292e0` | WRITE | v1, frozen |
| RAW capture | `5c0de0a1-7b3e-4f0a-9b6e-2d1c8a52f001` | READ, NOTIFY | experimental (dev app only), see section 6 |
| INFO | `5c0de0a1-7b3e-4f0a-9b6e-2d1c8a52f002` | READ | additive, protocol 1.1, see section 5 |

- **Device name:** `LiftIQ-XXXX` (XXXX = last two Bluetooth MAC bytes, upper-case hex). Apps filter
  on the name prefix `LiftIQ` and also accept the legacy fixed name `GymIQ Sensor`.
- **Advertising:** the firmware advertises the service UUID (scan response on). Apps must be able to
  find the sensor by service UUID alone; the name is a convenience.
- Apps request `optionalServices: [service UUID]`; they only ever need the three v1 UUIDs.

## 2. Telemetry packet (notify characteristic), 18 bytes, little-endian

Sent as a notification, and the same bytes are the characteristic's READ value (the app reads once
when a set stops to get the authoritative rep count).

| Bytes | Field | Type | Meaning |
|---|---|---|---|
| 0-1 | ax | int16 | acceleration X, m/s^2 x 100, sensor body frame, **includes gravity** |
| 2-3 | ay | int16 | acceleration Y, m/s^2 x 100 |
| 4-5 | az | int16 | acceleration Z, m/s^2 x 100 |
| 6-7 | total | int16 | acceleration magnitude `sqrt(ax^2+ay^2+az^2)`, m/s^2 x 100 |
| 8-9 | dynamic | int16 | `|total - baselineGravity|`, m/s^2 x 100. Read as **signed**; the current firmware never sends a negative value |
| 10-11 | seq | uint16 | sample sequence counter, +1 per notification actually sent, wraps 65535 -> 0. Apps unwrap it, count gaps as drops, and derive sensor time as `(seq - firstSeq) / 50 s` |
| 12 | phase | uint8 | 0 idle, 1 concentric, 2 eccentric (any other value makes the packet invalid for the app) |
| 13 | calibration status | uint8 | **persistent state present in every packet**: 0 not calibrated since boot, 1 calibrating, 2 calibrated and rep tracking enabled, 3 last calibration failed. Any other value makes the packet invalid |
| 14-15 | reps | uint16 | firmware rep count, wraps at 65536; reset to 0 when a calibration starts |
| 16-17 | battery | uint16 | estimated cell voltage in mV; **0 = unavailable** (no battery / USB only / divider not wired) |

- Accelerometer range is +/-8 g, so valid values are far inside int16 (+/-327.67 m/s^2). The encoder
  saturates out-of-range input at -32768 / 32767 and rounds to nearest (`lroundf`).
- **Legacy 16-byte packets** (first firmware: no seq, no battery; bytes 10-11 were a reserved zero
  speed slot) must stay decodable by apps: `seq = null`, `battery = null`. The firmware never sends
  them any more, but a v1 app accepts them. Any other length (17, 19, ...) is rejected as invalid.
- The packet stays 18 bytes so it fits the default 23-byte ATT MTU. **Never grow or reinterpret it.**

Golden vectors: `tests/compat/golden/v1_vectors.json` (idle, concentric, eccentric, calibrating 1,
calibrated 2, failed 3, battery 0 / 4150 / 65535, seq 65535 and its wrap, reps 300 / 65535, accel
extremes, saturation and rounding of the encoder, legacy 16-byte, invalid packets, INFO).

## 3. Control characteristic (write), opcodes

| First byte | Payload | Meaning |
|---|---|---|
| `0x01` | none | **start set / calibrate.** The firmware sets status 1 immediately (the very next telemetry packet already carries it), resets reps to 0 and disables rep tracking, calibrates for about 5 s while telemetry keeps flowing, then sets status 2 (reps 0, tracking enabled) or status 3 (no valid IMU samples). Re-sending it restarts the calibration |
| `0x02` | exactly 7 bytes: `0x02, start u16, reversal u16, rest u16` (little-endian, each = m/s^2 x 100) | rep thresholds. Ranges: start 0.10-5.00, reversal 0.10-3.00, rest 0.10-3.00. Out-of-range or wrong length: ignored, no error |

- **Unknown opcodes must be ignored harmlessly** by firmware (and unknown characteristics/packets by
  apps). That is what makes additive extension safe.
- Experimental opcodes `0x10`-`0x15` (RAW capture) exist in the current firmware; see section 6.

## 4. Behavioural guarantees the stable app relies on

Extracted from `app/stable/session.js`, `packet-stats.js`, `ble.js`; enforced by `tests/compat/behavior.test.js`
and `constants-guard.test.js`. A firmware that violates one of these breaks released apps.

1. **Notifications start on connect.** The app enables notifications once and keeps them for the whole
   connection (battery and calibration indicators need packets between sets). Telemetry flows without
   any command.
2. **Cadence: 50 Hz** (one packet per 20 ms; firmware: 100 Hz sample schedule, every 2nd sample).
   The app hard-codes `NOTIFY_HZ = 50` to convert `seq` to sensor time. Changing the rate corrupts the
   CSV time axis.
3. **Status is in every packet** (byte 13 is state, not an event). A lost packet must never desync the
   app: the app derives calibration from any packet.
4. **Status 1 right after `0x01`**, before the app's 4 s "stale status 2" guard matters: the app
   accepts a status 2 only if it saw status 1 since the command, or >= 4 s have elapsed.
5. **Calibration finishes in < 15 s** (app timeout 15 000 ms; firmware takes ~5 s) with status 2 or 3.
   Telemetry keeps flowing during calibration.
6. **Reps reset to 0 on start**, and `reps` is the live firmware count (the app shows it live and
   saves the READ value at stop).
7. **Battery field is in every packet** (0 = unavailable, never garbage).
8. **READ of the telemetry characteristic** returns a valid 18-byte packet at any time while connected.
9. **Advertising resumes after disconnect**, so the app can reconnect without a power cycle.
10. **Unknown/new traffic is harmless**: an app that never touches RAW/INFO sees exactly the v1 behaviour.

## 5. INFO characteristic (read-only, protocol 1.1)

`5c0de0a1-7b3e-4f0a-9b6e-2d1c8a52f002`, READ, always 20 bytes:

| Bytes | Field | Meaning |
|---|---|---|
| 0 | protocolMajor u8 | 1 |
| 1 | protocolMinor u8 | 1 (1.0 = original, 1.1 = + RAW capture + INFO) |
| 2-3 | capabilities u16 LE | bit0 = RAW capture supported |
| 4-19 | firmware version | ASCII, up to 16 chars, NUL padded (a full 16 chars has no terminator) |

The dev app reads it once at connect and shows firmware + protocol on the Sensor page. The stable app
ignores it. Apps must treat a missing or unreadable INFO as "old firmware": the connection must still
succeed (tested in `app/dev/test/compat-ble.test.js`). Encoder: `encodeInfoV1` in `protocol_v1.h`.

## 6. Experimental features (current: RAW capture)

- RAW characteristic `5c0de0a1-7b3e-4f0a-9b6e-2d1c8a52f001` and opcodes `0x10`-`0x15` (arm, start, stop,
  download, resend, erase). Chunk/stream formats are documented in `docs/DEVELOPMENT.md` (Step 0) and
  may still change; only the dev app uses them.
- **Dormant rule:** with no RAW command received, the firmware's live behaviour must be identical to a
  firmware without RAW: same telemetry bytes, 50 Hz cadence, accelerometer at 100 Hz / +/-8 g (ACC_CONF
  0x28 / ACC_RANGE 0x08). During a capture the firmware may temporarily change accelerometer ODR and
  pause live telemetry, but must restore the live configuration afterwards, and `0x01` is ignored while a
  capture is busy. `constants-guard.test.js` pins the live configuration constants.

## 7. Extension rules

1. **Additive only.** Never change the meaning, length, order or scaling of any existing byte, of the
   18-byte telemetry packet, of opcodes `0x01`/`0x02`, or of the UUIDs/name prefix above.
2. **New data goes on NEW characteristics inside the same service** (stable apps then need no change and
   simply never subscribe to them). Never add fields to the telemetry packet.
3. **New control opcodes** must be ignored harmlessly by old firmware and old apps (apps must tolerate a
   write that old firmware silently drops; firmware must ignore opcodes it does not know).
4. **Experimental features** (RAW now; a future one the same way) must be dormant unless a newer app
   invokes them, and must not change v1 behaviour (rate, timing, accelerometer configuration, packet
   bytes) when unused.
5. **Breaking change = new protocol major version**, a parallel v1 path kept alive in the firmware
   (e.g. a second service UUID), and the user's explicit approval. Never edit v1 in place.
6. New golden vectors may be **added**; existing vectors must never change (they are the contract).
7. A firmware change is done only when `cd app && npm run test:all` is green (and, for packet-affecting
   changes, `tools/ble/check_protocol_serial.py` matches on the real board).

## 8. Feature lifecycle

`experimental` (dev app only, may change or be removed, listed in section 6) -> `released` (frozen the
moment the STABLE app starts using it: move its description into sections 1-5, add golden vectors,
add it to `tests/compat`). Releasing is done with `tools/release-app.mjs`; there is no other path from
dev to stable. RAW capture is still experimental; INFO becomes "released" with the first stable release
that reads it (1.1.0 or later).

## 9. Version history

| Protocol | Firmware | Change |
|---|---|---|
| 1.0 | before `s0.3` | telemetry (18 B, seq, persistent status, battery) + control `0x01`/`0x02` |
| 1.1 | `liftiq-fw s0.3` | + INFO characteristic, + RAW capture characteristic and opcodes `0x10`-`0x15` (experimental) |
