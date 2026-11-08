# Archived firmware and UI prototypes

These are older development artifacts, kept for reference and comparison.
They are not the current firmware:

- `serial-imu-bringup/LiftIQ_Serial/LiftIQ_Serial.ino` — earlier USB serial
  IMU streaming sketch, used by the PC orientation and plotting tools.
- `i2c-scanner/I2CScanner/I2CScanner.ino` — standalone sensor wiring/address
  diagnostic.
- `legacy-tuner.html` — early phone BLE tuner UI; it uses an obsolete
  telemetry packet format and is not compatible with current firmware.

Use [`../current/LiftIQ_BLE/LiftIQ_BLE.ino`](../current/LiftIQ_BLE/LiftIQ_BLE.ino)
for the latest BLE rep-tracking firmware.
