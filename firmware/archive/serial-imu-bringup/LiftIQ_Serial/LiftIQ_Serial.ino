// LiftIQ firmware — IMU bring-up test
// Seeed XIAO ESP32-S3 + GY-BMI160 (6-DOF accel+gyro), streamed over USB serial.
//
// Dev setup: edit in VS Code, compile/upload with Arduino IDE.
// Board:   Tools > Board > esp32 > "XIAO_ESP32S3"
// Library: Arduino IDE Library Manager > search "DFRobot_BMI160" > install
//          (github.com/DFRobot/DFRobot_BMI160)
//
// Output: one CSV line per sample — ax,ay,az,gx,gy,gz
//   accel in g, gyro in deg/s. Read by tools/imu_cube_view.py.
//
// Display and BLE come later — this is IMU-only bring-up over USB.

#include <Wire.h>
#include <DFRobot_BMI160.h>

// XIAO ESP32-S3 default I2C pins (silkscreen D4/D5).
const int PIN_SDA = 5;
const int PIN_SCL = 6;
const int8_t BMI160 = 0x68;

// DFRobot_BMI160 hardcodes these ranges on init and exposes no public
// setter — used here purely to convert raw counts to physical units.
// (Its own example sketch gets this wrong for gyro: it multiplies raw
// counts by pi/180 instead of dividing by the sensitivity below.)
const float ACCEL_SENSITIVITY_LSB_PER_G = 16384.0f;    // +/- 2g range
const float GYRO_SENSITIVITY_LSB_PER_DPS = 16.384f;    // +/- 2000 deg/s range

const unsigned long SAMPLE_INTERVAL_MS = 10;  // ~100 Hz

DFRobot_BMI160 bmi160;

void scanI2C() {
  Serial.println("Scanning I2C bus...");
  int found = 0;
  for (uint8_t addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      Serial.print("  found device at 0x");
      Serial.println(addr, HEX);
      found++;
    }
  }
  if (found == 0) {
    Serial.println("  no I2C devices found — check wiring");
  }
}

void setup() {
  Serial.begin(115200);
  while (!Serial) {
    delay(10);
  }
  Serial.println("LiftIQ boot");

  Wire.begin(PIN_SDA, PIN_SCL);
  scanI2C();

  if (bmi160.I2cInit(BMI160) != BMI160_OK) {
    Serial.println("BMI160 init failed — check wiring/address, halting");
    while (true) {
      delay(1000);
    }
  }
  Serial.println("BMI160 init OK (fixed range: +/-2g, +/-2000 deg/s)");

  Serial.println("ax,ay,az,gx,gy,gz");
}

void loop() {
  static unsigned long lastSample = 0;
  const unsigned long now = millis();
  if (now - lastSample < SAMPLE_INTERVAL_MS) {
    return;
  }
  lastSample = now;

  int16_t raw[6] = {0};
  if (bmi160.getAccelGyroData(raw) != BMI160_OK) {
    return;
  }

  // Packing order per DFRobot_BMI160::getAccelGyroData: gyro xyz, then accel xyz.
  const float gx = raw[0] / GYRO_SENSITIVITY_LSB_PER_DPS;
  const float gy = raw[1] / GYRO_SENSITIVITY_LSB_PER_DPS;
  const float gz = raw[2] / GYRO_SENSITIVITY_LSB_PER_DPS;
  const float ax = raw[3] / ACCEL_SENSITIVITY_LSB_PER_G;
  const float ay = raw[4] / ACCEL_SENSITIVITY_LSB_PER_G;
  const float az = raw[5] / ACCEL_SENSITIVITY_LSB_PER_G;

  Serial.print(ax, 4); Serial.print(',');
  Serial.print(ay, 4); Serial.print(',');
  Serial.print(az, 4); Serial.print(',');
  Serial.print(gx, 4); Serial.print(',');
  Serial.print(gy, 4); Serial.print(',');
  Serial.println(gz, 4);
}
