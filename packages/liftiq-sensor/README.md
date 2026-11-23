# @liftiq/sensor

LiftIQ sensor core: BLE protocol decoder, session state machine, ready check and pulse (rep) analysis for the
LiftIQ cable-machine sensor. Plain ES modules: **no framework, no DOM, no storage, no dependencies, no bundler**.
This folder is the **single source of truth**; consumers (the LiftIQ dev app, a future openGym fork) use a
**vendored copy** (see "Vendoring").

- Version: `0.1.0` (see `package.json`), licence: **AGPL-3.0-or-later** (repo root `LICENSE`, `NOTICE.md`).
- Works in browsers and Node 20+ (tests use `node --test`).

## Modules (`src/`)

| Module | What |
|---|---|
| `protocol.js` | UUIDs, device filters, `decodeTelemetry(DataView)`, `parseInfo`, `describeInfo`, battery helpers (`estimateBatteryPercentage`, `describeBattery`), `encodeRepThresholds`, `packetToHex`, `CSV_COLUMNS` / `createSessionCsv`, `NOTIFY_HZ` (50) |
| `raw-protocol.js` | Research-capture (Lab) chunk parsing, reassembly and Raw CSV v1 |
| `packet-stats.js` | `PacketTracker`: wrapping uint16 `seq` unwrap, dropped packets, packet rate |
| `session.js` | `SessionMachine` (disconnected, idle, calibrating, recording, paused, reviewing, saving), incl. `startWithoutCalibration`, `abort`, `releaseReview`; `STATES`, `START_COMMAND`. Ble, storage and clock are injected |
| `ready-check.js` | `createStillnessDetector()`: "is the machine still enough to start a set" |
| `analysis/pulses.js` | `analyzeSet(samples, options)`: offline pulse analysis (spec: `docs/REP_ANALYSIS.md`) |
| `analysis/live-counter.js` | `createLiveCounter()`: causal live pulse counter |
| `ble-client.js` | `BleClient`: the LiftIQ GATT logic on top of a `BleTransport` |
| `web-bluetooth-transport.js` | `WebBluetoothTransport`: default transport (`navigator.bluetooth`) |
| `index.js` | Re-exports everything above (one public surface) |

```js
import { BleClient, SessionMachine, PacketTracker, createLiveCounter, analyzeSet } from "./vendor/liftiq-sensor/index.js";
```

## Transport interface

`BleClient` never touches `navigator.bluetooth`; everything goes through a transport object (duck-typed). Pass your own
with `new BleClient({ transport, onPacket, onInvalidPacket, onDisconnect, onRawChunk })`; the default is
`new WebBluetoothTransport()`. `device` and `characteristic` are opaque handles created by the transport. All methods
except `isSupported`, `isConnected`, `disconnect` and `onDisconnect` return promises.

```ts
interface BleTransport {
  isSupported(): boolean;
  // Show the picker / scan. Called from a user gesture. Resolves with a device handle that has a `name`.
  requestDevice(filters: object[], optionalServices: string[]): Promise<Device>;
  connect(device): Promise<void>;                 // GATT connect
  disconnect(device): void;
  isConnected(device): boolean;
  // Rejects when the service or characteristic does not exist (older firmware): the client treats RAW/INFO as optional.
  getCharacteristic(device, serviceUuid: string, characteristicUuid: string): Promise<Characteristic>;
  // Enable notifications and deliver every value as a DataView. A second call for the same characteristic replaces the callback.
  startNotifications(characteristic, onValue: (value: DataView) => void): Promise<void>;
  stopNotifications(characteristic): Promise<void>;   // must not throw if the device is gone
  readValue(characteristic): Promise<DataView>;
  writeValue(characteristic, bytes: Uint8Array): Promise<void>;
  // Register a callback for a dropped link; returns an unsubscribe function.
  onDisconnect(device, callback: () => void): () => void;
}
```

`filters` are Web Bluetooth style (`{services}`, `{namePrefix}`, `{name}`); a native transport may translate them.
UUIDs are lower-case strings (`SERVICE_UUID`, `NOTIFY_UUID`, ... exported from `protocol.js`). A Capacitor transport
(`@capacitor-community/bluetooth-le`) only has to implement this object; the rest of the package is unchanged.
`BleClient` also exposes what `SessionMachine` needs: `write(bytes)`, `readValue()`, `isConnected()`.

## Data shapes

- **Decoded packet** (`decodeTelemetry`, 18-byte v1; legacy 16-byte packets have `seq`/`batteryMillivolts` = `null`):
  `{ ax, ay, az, totalAccel, dynamicAccel, phase, calibration, calibrationCode, seq, repCount, batteryMillivolts }`
  (m/s^2; `phase` 0 IDLE / 1 CONCENTRIC / 2 ECCENTRIC; `calibrationCode` 0 none / 1 calibrating / 2 calibrated / 3 failed;
  `seq` is the wrapping uint16 counter).
- **Session sample** (`SessionMachine.session.samples[]`, CSV rows): `{ elapsed_s, ax_m_s2, ay_m_s2, az_m_s2, total_accel_m_s2,
  dynamic_accel_m_s2, phase, phase_id, rep_count, seq, actual_rep_count, arrival_s }`. `elapsed_s = (seq - firstSeq) / NOTIFY_HZ`.
- **Analysis input**: samples `{ t, ax, ay, az }` (seconds, m/s^2) or the session sample shape above.
- **Analysis output** (`analyzeSet`): `{ repCount, reps[], totalPulses, setupPull, metrics, series, warnings }`; see `docs/REP_ANALYSIS.md`.
- Strings the user sees are the host's job (no i18n here); results are numbers/keys.

## Vendoring

Never edit a vendored copy. From the LiftIQ repo root:

```bash
node tools/vendor-sensor.mjs --target app/dev/vendor           # writes app/dev/vendor/liftiq-sensor/
node tools/vendor-sensor.mjs --target app/dev/vendor --check   # exit 1 if the copy differs from packages/liftiq-sensor/src
# from app/: npm run vendor, npm run vendor:check
```

Every `.js` file gets the first line `// VENDORED FROM packages/liftiq-sensor@<version> — do not edit`, and
`liftiq-sensor/VERSION.json` records `{ version, sourceCommit: null, fileHashes }` (sha256 of the LF-normalised sources).
A consumer in another repository runs the same script with `--target <its vendor folder>` (copy `tools/vendor-sensor.mjs`
or run it from a LiftIQ checkout) and commits the result together with `VERSION.json`.

## Tests

`cd packages/liftiq-sensor && npm test` or `cd app && npm run test:sensor`. Fixtures are read from
`tests/fixtures/seated-row-2026-11-22/` (five recorded seated-row sets with golden counts 8, 8, 7, 5, 9).
The BLE client tests use an in-memory `FakeTransport` plus one run through `WebBluetoothTransport` with a fake `navigator.bluetooth`.

## Rules for changes

Keep the package free of DOM, storage, framework and dependency use (`test/package.test.js` checks). Do not change
public function signatures without bumping the version and the vendored consumers. Protocol changes follow
`docs/PROTOCOL.md` and keep `tests/compat` green.

## Licence

AGPL-3.0-or-later. Anything that includes this code and is used over a network must offer its corresponding source
under the same licence (AGPL section 13).
