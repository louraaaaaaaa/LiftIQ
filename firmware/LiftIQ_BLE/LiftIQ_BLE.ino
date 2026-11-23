// LiftIQ firmware - acceleration-only rep tracking over BLE
// Board:   Seeed Studio XIAO ESP32C3 (arduino-cli: esp32:esp32:XIAO_ESP32C3)
// Library: DFRobot_BMI160 (used for sensor init only; data is read directly over Wire)
// Wiring:  SDA = GPIO 6 (D4), SCL = GPIO 7 (D5), BMI160 at I2C 0x68.
//          Battery divider midpoint is on the D3 pad (GPIO5 = ADC2, which the ESP32-C3
//          cannot read) and is jumpered to D2 = GPIO 4 (ADC1_CH4), which is read here.

// Set to 1 to enable the human-readable serial stream (100 Hz plotter CSV,
// 1 Hz battery line, phase/rep banners). Required by the tools/ serial
// plotter and dashboard scripts. Boot messages and errors are always printed.
#define DEBUG_SERIAL_STREAM 0

// Set to 1 for one compact diagnostic line every 5 s (loop Hz, notify Hz, I2C
// timing/errors, accelerometer clipping, battery, calibration, reps, connection).
#define DEBUG_DIAG 0

// Set to 1 to print, at boot, the hex of the v1 encoder output for the golden inputs
// (see tools/ble/check_protocol_serial.py). Does not change BLE behaviour.
#define DEBUG_PROTOCOL_SELFTEST 0

#include <Wire.h>
#include <DFRobot_BMI160.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLE2902.h>
#include <esp_mac.h>   // esp_read_mac / ESP_MAC_BT
#include <esp_heap_caps.h>
#include "protocol_v1.h"   // pure v1 packet encoders (host-tested in tests/compat)
#if DEBUG_PROTOCOL_SELFTEST
#include "protocol_v1_selftest_vectors.h"
#endif

// Defined before the first function so the Arduino auto-generated prototypes can see it.
enum LiftPhase { IDLE = 0, CONCENTRIC = 1, ECCENTRIC = 2 };

// --- HARDWARE CONFIGURATION ---
const int PIN_SDA = 6;
const int PIN_SCL = 7;
const int PIN_BATTERY = 4;  // D2 / GPIO4 / ADC1_CH4, jumpered from the D3 divider midpoint
const uint8_t BATTERY_ADC_SAMPLES = 16;
const int8_t BMI160_I2C = 0x68;
const float BATTERY_DIVIDER_RATIO = 2.0f;
const uint32_t BATTERY_MIN_PLAUSIBLE_PIN_MV = 300;   // below/above this the reading is treated as 0
const uint32_t BATTERY_MAX_PLAUSIBLE_PIN_MV = 3500;

DFRobot_BMI160 bmi160;

// --- ACCELEROMETER CONFIGURATION (written directly over I2C after library init) ---
// ACC_RANGE (0x41): 0x03 = +/-2 g, 0x05 = +/-4 g, 0x08 = +/-8 g (datasheet 2.11.12);
// sensitivity at +/-8 g is 4096 LSB/g. Keep ACCEL_RANGE_G, the register value and the sensitivity in sync.
const uint8_t ACCEL_RANGE_G = 8;
const uint8_t BMI160_ACC_RANGE_VALUE = 0x08;
const float ACCEL_SENSITIVITY_LSB_PER_G = 4096.0f;
// ACC_CONF (0x40) = 0x28: normal filter, 100 Hz ODR (also the chip's reset value).
const uint8_t BMI160_ACC_CONF_VALUE = 0x28;
const uint8_t BMI160_REG_CHIP_ID = 0x00;
const uint8_t BMI160_REG_ERR = 0x02;
const uint8_t BMI160_REG_PMU_STATUS = 0x03;
const uint8_t BMI160_REG_ACC_DATA = 0x12;  // ACC_X LSB, then X MSB, Y, Z (6 bytes)
const uint8_t BMI160_REG_ACC_CONF = 0x40;
const uint8_t BMI160_REG_ACC_RANGE = 0x41;
const int16_t ACCEL_CLIP_RAW = 32000;      // raw |axis| at/above this counts as clipping (full scale 32768)
const uint32_t I2C_CLOCK_HZ = 400000;

// --- RESEARCH CAPTURE (raw 6-axis recording into RAM, uploaded after the set) ---
#define FW_VERSION "liftiq-fw s0.3"   // max 16 chars (INFO characteristic)
#define RAW_CHARACTERISTIC_UUID "5c0de0a1-7b3e-4f0a-9b6e-2d1c8a52f001"
// Read-only INFO characteristic (protocol_v1.h encodeInfoV1): protocol version, capabilities, firmware string.
#define INFO_CHARACTERISTIC_UUID "5c0de0a1-7b3e-4f0a-9b6e-2d1c8a52f002"
const uint16_t RAW_SAMPLE_HZ = 200;          // must match the ODR register values below (0x29 = 200 Hz)
const uint32_t RAW_PERIOD_US = 1000000UL / RAW_SAMPLE_HZ;
const uint16_t RAW_MAX_SECONDS = 40;         // capture cap (shorter if the heap cannot hold it)
const uint16_t RAW_MIN_SECONDS = 5;          // below this ARM fails with an error
const uint16_t GYRO_RANGE_DPS = 1000;        // must match BMI160_GYR_RANGE_VALUE (0x01 = +/-1000 dps)
const float GYRO_SENSITIVITY_LSB_PER_DPS = 32.8f;
const uint8_t BMI160_GYR_RANGE_VALUE = 0x01;
const uint8_t BMI160_GYR_CONF_VALUE = 0x29;  // normal filter (bwp 0b10), ODR 0b1001 = 200 Hz
const uint8_t BMI160_ACC_CONF_RAW_VALUE = 0x29;  // normal filter, ODR 200 Hz (live mode uses 0x28 = 100 Hz)
const uint8_t BMI160_REG_GYR_CONF = 0x42;
const uint8_t BMI160_REG_GYR_RANGE = 0x43;
const uint8_t BMI160_REG_DATA_BURST = 0x0C;  // gyro XYZ, accel XYZ, SENSORTIME (15 bytes)
// Capture buffer layout (stream version 2): blocks of RAW_BLOCK_SAMPLES samples, each block =
// [SENSORTIME u32 (24-bit) of its first sample][RAW_BLOCK_SAMPLES x 12 bytes: gyro XYZ, accel XYZ int16].
// 12.16 bytes per sample instead of 14; t_s inside a block is nominal (1 / RAW_SAMPLE_HZ).
const uint8_t RAW_SAMPLE_BYTES = 12;
const uint8_t RAW_BLOCK_SAMPLES = 25;
const uint16_t RAW_BLOCK_BYTES = 4 + RAW_BLOCK_SAMPLES * RAW_SAMPLE_BYTES;
const uint8_t RAW_START_DISCARD_SAMPLES = RAW_SAMPLE_HZ / 10;   // first 100 ms after START are dropped (filter settling)
const uint32_t RAW_ARM_MS = 5000;            // rest calibration length
const uint32_t RAW_ARM_SETTLE_MS = 500;      // discard after the ODR change
// Heap kept free after the buffer is allocated (NimBLE connection/GATT allocations, String values per
// notify, Serial). Measured on hardware: free heap 120 KB at ARM with a client connected (186 KB at boot).
const uint32_t RAW_HEAP_RESERVE = 20 * 1024;
const uint32_t RAW_BLOCK_SLACK = 256;        // allocator overhead margin on the largest block
const uint8_t RAW_MAX_PAYLOAD = 180;
const uint16_t RAW_PREFERRED_MTU = 247;
const uint8_t RAW_CHUNKS_PER_SERVICE = 3;
const unsigned long RAW_STATUS_PERIOD_MS = 500;
// Chunk types ([type u8][chunkIndex u16][len u8][payload...]):
const uint8_t RAW_CHUNK_STATUS = 0x01;
const uint8_t RAW_CHUNK_DATA = 0x02;
const uint8_t RAW_CHUNK_INFO = 0x03;   // upload start: P u16, totalChunks u16, totalBytes u32
const uint8_t RAW_CHUNK_DONE = 0x04;   // same payload, sent after the last chunk of a (re)send
// Capture states:
const uint8_t RAW_IDLE = 0;
const uint8_t RAW_ARMING = 1;
const uint8_t RAW_ARMED = 2;
const uint8_t RAW_CAPTURING = 3;
const uint8_t RAW_READY = 4;
const uint8_t RAW_UPLOADING = 5;
const uint8_t RAW_ERROR = 6;

// --- FIXED SAMPLE SCHEDULE ---
const uint32_t SAMPLE_PERIOD_US = 10000;   // 100 Hz IMU polling
const uint8_t NOTIFY_EVERY_N_SAMPLES = 2;  // 50 Hz BLE notifications
const float G_TO_MS2 = 9.81f;

// --- BLE UUID DEFINITIONS ---
#define SERVICE_UUID              "4fa8691a-1365-4a4f-a808-3fda13b292e0"
#define NOTIFY_CHARACTERISTIC_UUID "beb5483e-36e1-4688-b7f5-ea07361b26a8"
#define WRITE_CHARACTERISTIC_UUID  "cba8691a-1365-4a4f-a808-3fda13b292e0"

BLECharacteristic *pNotifyCharacteristic;
BLECharacteristic *pRawCharacteristic;
bool deviceConnected = false;
volatile bool calibrationRequested = false;
volatile bool repTrackingEnabled = false;
unsigned long lastBatteryReadTime = 0;
uint16_t batteryVoltageMillivolts = 0;
uint16_t batteryDividerMillivolts = 0;
uint16_t telemetrySequence = 0;  // wraps at 65535; one increment per notification sent
char bleDeviceName[16] = "LiftIQ";

const uint8_t CALIBRATION_IDLE = 0;
const uint8_t CALIBRATION_STARTED = 1;
const uint8_t CALIBRATION_COMPLETE = 2;
const uint8_t CALIBRATION_FAILED = 3;

// Calibration status is PERSISTENT STATE, carried in byte 13 of EVERY telemetry
// packet (so one lost notification cannot desync the app):
//   0 = not calibrated since boot, 1 = calibrating (set the instant the start
//   command is written), 2 = calibrated and rep tracking enabled,
//   3 = last calibration failed (no valid IMU samples).
volatile uint8_t calibrationStatus = CALIBRATION_IDLE;
volatile bool forceNextNotify = false;  // send the next sample without the 20 ms throttle

// Non-blocking calibration (advanced from loop(), reusing the normal sample reads).
const unsigned long CAL_SETTLE_MS = 500;   // discard while the user lets go of the sensor
const unsigned long CAL_TOTAL_MS = 5000;   // end of the accumulation window
bool calibrationActive = false;
unsigned long calibrationStartTime = 0;
double calSumX = 0.0, calSumY = 0.0, calSumZ = 0.0;
int calValidSamples = 0;
unsigned long lastBatteryZeroWarnTime = 0;

// --- Fixed-schedule / diagnostic bookkeeping ---
uint32_t nextSampleUs = 0;
uint32_t lastSampleUs = 0;
uint32_t sampleCounter = 0;
uint32_t liveCounter = 0;

// Research capture state
volatile uint8_t rawState = RAW_IDLE;
uint8_t rawErrorCode = 0;           // 1 = out of memory, 2 = bad command/state
uint8_t rawFlags = 0;               // bit0 = capacity reduced by heap, bit1 = auto-stopped at cap
uint8_t* rawBuf = nullptr;
uint32_t rawCapSamples = 0;
uint32_t rawCount = 0;
uint32_t rawArmStartMs = 0;
uint8_t rawArmPercent = 0;
double rawSumG[3] = {0, 0, 0};
double rawSumA[3] = {0, 0, 0};
uint32_t rawArmSamples = 0;
float rawGyroBias[3] = {0, 0, 0};
float rawGravity[3] = {0, 0, 0};
uint16_t rawRepCount = 0;
uint32_t rawBaseSensortime = 0;
bool rawBaseSet = false;
uint8_t rawDiscardLeft = 0;
volatile bool rawCmdPending = false;
volatile uint8_t rawCmd = 0;
volatile uint16_t rawCmdArg1 = 0;
volatile uint16_t rawCmdArg2 = 0;
volatile uint16_t connMtu = 23;
volatile bool rawNotifyFailed = false;
bool rawStatusDirty = true;
unsigned long rawLastStatusMs = 0;
uint16_t rawStatusSeq = 0;
// Upload state: stream = [headerLen u16][header][samples]; chunk i covers [i*P, (i+1)*P)
uint8_t rawStream[80];              // header part of the stream (length prefix + header)
uint16_t rawStreamHeaderBytes = 0;
uint32_t rawStreamBytes = 0;
uint16_t rawPayload = 0;
uint16_t rawTotalChunks = 0;
uint16_t rawUpNext = 0;
uint16_t rawUpEnd = 0;
uint8_t rawUpPhase = 0;             // 0 none, 1 send INFO, 2 send data, 3 send DONE
#if DEBUG_DIAG
unsigned long lastDiagTime = 0;
uint32_t diagSamples = 0;
uint32_t diagNotifies = 0;
uint32_t diagI2cUsSum = 0;
uint32_t diagI2cUsMax = 0;
uint32_t i2cErrorCount = 0;
uint32_t clipSampleCount = 0;
#endif

// --- TUNABLE PHYSICS & THRESHOLD VARIABLES ---
float baselineGravity = 9.81f; // Recalibrated at the start of each measurement
float gravityX = 0.0f;
float gravityY = 0.0f;
float gravityZ = G_TO_MS2;

float START_CONCENTRIC_THRESH = 1.0f;
const float MIN_ONSET_MAGNITUDE_DEVIATION = 0.05f;
float PHASE_REVERSAL_THRESH = 0.35f;
float REST_NOISE_THRESH = 0.45f;
const float GRAVITY_TRACKING_TOLERANCE = 1.2f;
const unsigned long MIN_CONCENTRIC_TIME_MS = 350;
const unsigned long MIN_ECCENTRIC_TIME_MS = 350;
const unsigned long MIN_TOTAL_REP_TIME_MS = 900;
const unsigned long MIN_PHASE_SIGNAL_MS = 80;
const unsigned long MIN_REST_DWELL_MS = 300;
const float GRAVITY_FILTER_TIME_CONSTANT_S = 0.75f;
// Sample-rate independent (reproduces the original behaviour at the old ~37 ms loop period):
// phase low-pass tau ~110 ms (alpha = dt / (tau + dt) with the real dt) and an onset
// window of ~150 ms of consecutive above-threshold samples.
const float PHASE_FILTER_TIME_CONSTANT_S = 0.110f;
const unsigned long MOTION_ONSET_WINDOW_MS = 150;
const uint8_t MOTION_ONSET_MIN_SAMPLES = 2;

// Motion State Machine
LiftPhase currentPhase = IDLE;

// Rep Tracking Telemetry
int repCount = 0;
unsigned long lastSampleTime   = 0;
unsigned long concentricStartTime = 0;
unsigned long totalRepStartTime   = 0;
unsigned long phaseStartTime       = 0;

float motionAxisX = 0.0f;
float motionAxisY = 0.0f;
float motionAxisZ = 0.0f;
float onsetAccelSumX = 0.0f;
float onsetAccelSumY = 0.0f;
float onsetAccelSumZ = 0.0f;
float filteredAxisAccel = 0.0f;
uint8_t onsetSampleCount = 0;
unsigned long onsetStartTime = 0;
uint8_t phaseSignalSampleCount = 0;
bool eccentricBrakingDetected = false;
unsigned long restStartTime = 0;
unsigned long phaseSignalStartTime = 0;

// --- BLE CALLBACK HANDLERS ---
class ServerCallbacks: public BLEServerCallbacks {
    void onConnect(BLEServer* pServer) { 
      deviceConnected = true; 
      connMtu = 23;
      Serial.println("\n[BLE] App Connected!");
    }
#ifdef CONFIG_NIMBLE_ENABLED
    void onMtuChanged(BLEServer* pServer, ble_gap_conn_desc* desc, uint16_t mtu) override {
      connMtu = mtu;
    }
#endif
    void onDisconnect(BLEServer* pServer) { 
      deviceConnected = false;
      if (rawState == RAW_UPLOADING) { rawState = RAW_READY; rawUpPhase = 0; rawStatusDirty = true; }
      Serial.println("\n[BLE] App Disconnected. Restarting Advertising...");
      pServer->getAdvertising()->start();
    }
};

class ControlCallbacks: public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic *pCharacteristic) {
      uint8_t* rxData = pCharacteristic->getData();
      size_t length = pCharacteristic->getLength();

      if (length > 0) {
        uint8_t command = rxData[0];
        
        // Command 0x01: START NEW SET / RESET REPS
        if (command == 0x01 && (rawState == RAW_ARMING || rawState == RAW_CAPTURING || rawState == RAW_UPLOADING)) {
          Serial.println("\n[BLE CMD] Start New Set ignored: research capture busy.");
        } else if (command >= 0x10 && command <= 0x15) {
          rawCmdArg1 = (length >= 3) ? (rxData[1] | (uint16_t(rxData[2]) << 8)) : 0;
          rawCmdArg2 = (length >= 5) ? (rxData[3] | (uint16_t(rxData[4]) << 8)) : 0;
          rawCmd = command;
          rawCmdPending = true;
        } else if (command == 0x01) {
          // Publish "calibrating" immediately so every packet from now on says so.
          repTrackingEnabled = false;
          calibrationStatus = CALIBRATION_STARTED;
          forceNextNotify = true;
          calibrationRequested = true;
          Serial.println("\n[BLE CMD] Start New Set -> calibration requested.");
        } else if (command == 0x02 && length == 7) {
          const uint16_t startEncoded = rxData[1] | (uint16_t(rxData[2]) << 8);
          const uint16_t reversalEncoded = rxData[3] | (uint16_t(rxData[4]) << 8);
          const uint16_t restEncoded = rxData[5] | (uint16_t(rxData[6]) << 8);
          const float startThreshold = startEncoded / 100.0f;
          const float reversalThreshold = reversalEncoded / 100.0f;
          const float restThreshold = restEncoded / 100.0f;

          if (
            startThreshold >= 0.1f && startThreshold <= 5.0f &&
            reversalThreshold >= 0.1f && reversalThreshold <= 3.0f &&
            restThreshold >= 0.1f && restThreshold <= 3.0f
          ) {
            START_CONCENTRIC_THRESH = startThreshold;
            PHASE_REVERSAL_THRESH = reversalThreshold;
            REST_NOISE_THRESH = restThreshold;
            Serial.println("\n[BLE CMD] Rep thresholds updated.");
          } else {
            Serial.println("\n[BLE CMD] Invalid rep thresholds ignored.");
          }
        } 
      }
    }
};

class RawCallbacks: public BLECharacteristicCallbacks {
    void onStatus(BLECharacteristic* pCharacteristic, Status s, uint32_t code) {
      if (s == BLECharacteristicCallbacks::Status::ERROR_GATT || s == BLECharacteristicCallbacks::Status::ERROR_NO_CLIENT) {
        rawNotifyFailed = true;
      }
    }
};

// --- IMU access: direct Wire reads (the DFRobot library read path has delay(10) + delay(1) per byte) ---
bool imuWriteReg(uint8_t reg, uint8_t value) {
  Wire.beginTransmission((uint8_t)BMI160_I2C);
  Wire.write(reg);
  Wire.write(value);
  return Wire.endTransmission() == 0;
}

bool imuReadRegs(uint8_t reg, uint8_t *buffer, uint8_t length) {
  Wire.beginTransmission((uint8_t)BMI160_I2C);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) {
    return false;
  }
  if (Wire.requestFrom((uint8_t)BMI160_I2C, (size_t)length, true) != length) {
    return false;
  }
  for (uint8_t i = 0; i < length; i++) {
    buffer[i] = Wire.read();
  }
  return true;
}

// Write ACC_CONF / ACC_RANGE (the library only writes its config during init), read back and print.
bool configureAccelerometer() {
  bool ok = imuWriteReg(BMI160_REG_ACC_CONF, BMI160_ACC_CONF_VALUE);
  delay(2);
  ok = imuWriteReg(BMI160_REG_ACC_RANGE, BMI160_ACC_RANGE_VALUE) && ok;
  delay(10);
  ok = imuWriteReg(BMI160_REG_GYR_CONF, BMI160_GYR_CONF_VALUE) && ok;
  delay(2);
  ok = imuWriteReg(BMI160_REG_GYR_RANGE, BMI160_GYR_RANGE_VALUE) && ok;
  delay(10);
  uint8_t gconf = 0xFF, grange = 0xFF;
  ok = imuReadRegs(BMI160_REG_GYR_CONF, &gconf, 1) && ok;
  ok = imuReadRegs(BMI160_REG_GYR_RANGE, &grange, 1) && ok;
  uint8_t conf = 0xFF, range = 0xFF, err = 0xFF, pmu = 0xFF, chip = 0xFF;
  ok = imuReadRegs(BMI160_REG_ACC_CONF, &conf, 1) && ok;
  ok = imuReadRegs(BMI160_REG_ACC_RANGE, &range, 1) && ok;
  ok = imuReadRegs(BMI160_REG_ERR, &err, 1) && ok;
  ok = imuReadRegs(BMI160_REG_PMU_STATUS, &pmu, 1) && ok;
  ok = imuReadRegs(BMI160_REG_CHIP_ID, &chip, 1) && ok;
  Serial.printf("[IMU] chip=0x%02X ACC_CONF=0x%02X (want 0x%02X) ACC_RANGE=0x%02X (want 0x%02X, +/-%u g) GYR_CONF=0x%02X (want 0x%02X) GYR_RANGE=0x%02X (want 0x%02X, +/-%u dps) ERR_REG=0x%02X PMU_STATUS=0x%02X\n",
                chip, conf, BMI160_ACC_CONF_VALUE, range, BMI160_ACC_RANGE_VALUE, ACCEL_RANGE_G,
                gconf, BMI160_GYR_CONF_VALUE, grange, BMI160_GYR_RANGE_VALUE, GYRO_RANGE_DPS, err, pmu);
  const bool matches = ok && conf == BMI160_ACC_CONF_VALUE && (range & 0x0F) == BMI160_ACC_RANGE_VALUE &&
                       gconf == BMI160_GYR_CONF_VALUE && (grange & 0x07) == BMI160_GYR_RANGE_VALUE;
  if (!matches) {
    Serial.println("[IMU] ERROR: accelerometer configuration read-back mismatch.");
  }
  return matches;
}

// Reads raw accelerometer X/Y/Z (6 bytes, one I2C transaction).
bool readAccelRaw(int16_t out[3]) {
  uint8_t bytes[6];
#if DEBUG_DIAG
  const uint32_t startUs = micros();
#endif
  const bool ok = imuReadRegs(BMI160_REG_ACC_DATA, bytes, 6);
#if DEBUG_DIAG
  const uint32_t durationUs = micros() - startUs;
  diagI2cUsSum += durationUs;
  if (durationUs > diagI2cUsMax) diagI2cUsMax = durationUs;
  if (!ok) i2cErrorCount++;
#endif
  if (!ok) {
    return false;
  }
  for (uint8_t i = 0; i < 3; i++) {
    out[i] = (int16_t)(((uint16_t)bytes[i * 2 + 1] << 8) | bytes[i * 2]);
  }
  return true;
}

// --- BATTERY (analogReadMilliVolts on ADC1; average of several samples, retry on 0) ---
// Returns the estimated cell millivolts (pin voltage x divider ratio); dividerMillivolts
// receives the pin voltage. Readings outside the plausibility window count as 0 mV.
uint16_t readBatteryMillivolts(uint16_t &dividerMillivolts) {
  uint32_t pinMillivolts = 0;
  for (uint8_t attempt = 0; attempt < 3 && pinMillivolts == 0; attempt++) {
    uint32_t sum = 0;
    for (uint8_t i = 0; i < BATTERY_ADC_SAMPLES; i++) {
      sum += analogReadMilliVolts(PIN_BATTERY);
      delayMicroseconds(100);
    }
    pinMillivolts = sum / BATTERY_ADC_SAMPLES;
    if (pinMillivolts == 0) delayMicroseconds(500);
  }
  if (pinMillivolts < BATTERY_MIN_PLAUSIBLE_PIN_MV || pinMillivolts > BATTERY_MAX_PLAUSIBLE_PIN_MV) {
    pinMillivolts = 0;
  }
  dividerMillivolts = (uint16_t)pinMillivolts;
  const uint32_t batteryMillivolts = (uint32_t)lroundf(pinMillivolts * BATTERY_DIVIDER_RATIO);
  return batteryMillivolts > 65535 ? 65535 : (uint16_t)batteryMillivolts;
}

void notifyTelemetry(
  float ax,
  float ay,
  float az,
  float totalAccel,
  float dynamicAccel
) {
  if (!deviceConnected) {
    return;
  }
  // Cadence is decided by the caller (every NOTIFY_EVERY_N_SAMPLES-th sample).
  forceNextNotify = false;
#if DEBUG_DIAG
  diagNotifies++;
#endif

  // Five accelerometer fields, uint16 sequence counter (bytes 10-11), phase,
  // calibration status (byte 13, persistent state), reps, battery.
  // Little-endian, 18 bytes (fits the default MTU). The sequence increments
  // once per notification sent, so the app can detect dropped packets by gaps.
  // The byte layout lives in protocol_v1.h (frozen, docs/PROTOCOL.md; host-tested).
  TelemetryV1 telemetry;
  telemetry.ax = ax;
  telemetry.ay = ay;
  telemetry.az = az;
  telemetry.totalAccel = totalAccel;
  telemetry.dynamicAccel = dynamicAccel;
  telemetry.seq = telemetrySequence++;
  telemetry.phase = (uint8_t)currentPhase;
  telemetry.calibrationStatus = calibrationStatus;
  telemetry.repCount = (uint16_t)repCount;
  telemetry.batteryMillivolts = batteryVoltageMillivolts;
  uint8_t payload[LIFTIQ_TELEMETRY_V1_LENGTH];
  encodeTelemetryV1(payload, telemetry);

  pNotifyCharacteristic->setValue(payload, sizeof(payload));
  pNotifyCharacteristic->notify();
}

void resetRepTracking();

// --- BASELINE GRAVITY CALIBRATION (non-blocking) ---
void startCalibration(unsigned long now) {
  repTrackingEnabled = false;
  calibrationActive = true;
  calibrationStartTime = now;
  calSumX = 0.0;
  calSumY = 0.0;
  calSumZ = 0.0;
  calValidSamples = 0;
  calibrationStatus = CALIBRATION_STARTED;
  forceNextNotify = true;
  Serial.println("[CALIBRATION] STARTED - Keep device still");
}

void finishCalibration() {
  calibrationActive = false;
  forceNextNotify = true;
  if (calValidSamples == 0) {
    calibrationStatus = CALIBRATION_FAILED;
    Serial.println("[CALIBRATION] FAILED - no valid BMI160 samples");
    return;
  }
  gravityX = calSumX / calValidSamples;
  gravityY = calSumY / calValidSamples;
  gravityZ = calSumZ / calValidSamples;
  baselineGravity = sqrt(gravityX * gravityX + gravityY * gravityY + gravityZ * gravityZ);
  Serial.print("[CALIBRATION] COMPLETE - baseline gravity: ");
  Serial.print(baselineGravity, 3);
  Serial.println(" m/s^2");
  resetRepTracking();
  repTrackingEnabled = true;
  calibrationStatus = CALIBRATION_COMPLETE;  // set last: packets now say calibrated with 0 reps
  Serial.println("[REP TRACKING] Enabled after calibration.");
}

// Called once per valid IMU sample (m/s^2) while calibrationActive.
void updateCalibration(float ax, float ay, float az, unsigned long now) {
  const unsigned long elapsed = now - calibrationStartTime;
  if (elapsed >= CAL_SETTLE_MS) {
    calSumX += ax;
    calSumY += ay;
    calSumZ += az;
    calValidSamples++;
  }
  if (elapsed >= CAL_TOTAL_MS) {
    finishCalibration();
  }
}

void resetRepTracking() {
  repCount = 0;
  currentPhase = IDLE;
  concentricStartTime = 0;
  totalRepStartTime = 0;
  phaseStartTime = 0;
  motionAxisX = 0.0f;
  motionAxisY = 0.0f;
  motionAxisZ = 0.0f;
  eccentricBrakingDetected = false;
  restStartTime = 0;
  phaseSignalStartTime = 0;
  phaseSignalSampleCount = 0;
  onsetSampleCount = 0;
  onsetAccelSumX = 0.0f;
  onsetAccelSumY = 0.0f;
  onsetAccelSumZ = 0.0f;
  filteredAxisAccel = 0.0f;
  lastSampleTime = millis();
}

void handleSerialCommand() {
  while (Serial.available() > 0) {
    if (Serial.read() == 'C') {
      calibrationRequested = true;
    }
  }
}

void serviceCalibrationRequest() {
  if (!calibrationRequested) {
    return;
  }
  calibrationRequested = false;
  resetRepTracking();  // reps read 0 and phase IDLE while calibrating
  startCalibration(millis());
}

// ======================= RESEARCH CAPTURE =======================
bool rawFastPolling() {
  return rawState == RAW_ARMING || rawState == RAW_CAPTURING;
}

void rawFreeBuffer() {
  if (rawBuf) {
    heap_caps_free(rawBuf);
    rawBuf = nullptr;
  }
  rawCapSamples = 0;
  rawCount = 0;
}

void rawSetAccelOdr(bool fast) {
  imuWriteReg(BMI160_REG_ACC_CONF, fast ? BMI160_ACC_CONF_RAW_VALUE : BMI160_ACC_CONF_VALUE);
}

// Reads gyro XYZ, accel XYZ and the 24-bit SENSORTIME in one burst.
bool readImuBurst(int16_t g[3], int16_t a[3], uint32_t &sensortime) {
  uint8_t b[15];
  if (!imuReadRegs(BMI160_REG_DATA_BURST, b, 15)) {
    return false;
  }
  for (uint8_t i = 0; i < 3; i++) {
    g[i] = (int16_t)(((uint16_t)b[i * 2 + 1] << 8) | b[i * 2]);
    a[i] = (int16_t)(((uint16_t)b[6 + i * 2 + 1] << 8) | b[6 + i * 2]);
  }
  sensortime = (uint32_t)b[12] | ((uint32_t)b[13] << 8) | ((uint32_t)b[14] << 16);
  return true;
}

void rawSetState(uint8_t state) {
  rawState = state;
  rawStatusDirty = true;
}

void rawAbortToIdle() {
  rawUpPhase = 0;
  rawFreeBuffer();
  rawSetAccelOdr(false);
  rawFlags = 0;
  rawErrorCode = 0;
  rawArmPercent = 0;
  rawSetState(RAW_IDLE);
}

// Bytes needed for n samples in the block layout.
uint32_t rawBytesForSamples(uint32_t n) {
  const uint32_t rem = n % RAW_BLOCK_SAMPLES;
  return (n / RAW_BLOCK_SAMPLES) * RAW_BLOCK_BYTES + (rem ? 4 + rem * RAW_SAMPLE_BYTES : 0);
}

// Largest sample count that fits in `bytes` (inverse of rawBytesForSamples).
uint32_t rawSamplesForBytes(uint32_t bytes) {
  const uint32_t full = bytes / RAW_BLOCK_BYTES;
  const uint32_t rem = bytes % RAW_BLOCK_BYTES;
  return full * RAW_BLOCK_SAMPLES + (rem > 4 ? (rem - 4) / RAW_SAMPLE_BYTES : 0);
}

// Capacity = min(RAW_MAX_SECONDS, what fits in the largest block, what leaves RAW_HEAP_RESERVE of total free heap).
uint32_t rawComputeCapacity(size_t &largest, size_t &freeHeap, bool &reduced) {
  largest = heap_caps_get_largest_free_block(MALLOC_CAP_8BIT);
  freeHeap = heap_caps_get_free_size(MALLOC_CAP_8BIT);
  const uint32_t byBlock = largest > RAW_BLOCK_SLACK ? (uint32_t)(largest - RAW_BLOCK_SLACK) : 0;
  const uint32_t byHeap = freeHeap > RAW_HEAP_RESERVE ? (uint32_t)(freeHeap - RAW_HEAP_RESERVE) : 0;
  const uint32_t bytes = byBlock < byHeap ? byBlock : byHeap;
  uint32_t cap = rawSamplesForBytes(bytes);
  const uint32_t wanted = (uint32_t)RAW_MAX_SECONDS * RAW_SAMPLE_HZ;
  reduced = cap < wanted;
  return reduced ? cap : wanted;
}

void rawBeginArm() {
  rawFreeBuffer();
  rawFlags = 0;
  rawErrorCode = 0;
  size_t largest = 0, freeHeap = 0;
  bool reduced = false;
  const uint32_t capSamples = rawComputeCapacity(largest, freeHeap, reduced);
  if (reduced) rawFlags |= 0x01;
  if (capSamples < (uint32_t)RAW_MIN_SECONDS * RAW_SAMPLE_HZ) {
    rawErrorCode = 1;
    rawSetState(RAW_ERROR);
    Serial.printf("[RAW] ARM failed: free heap %u, largest block %u too small\n", (unsigned)freeHeap, (unsigned)largest);
    return;
  }
  rawBuf = (uint8_t*)heap_caps_malloc(rawBytesForSamples(capSamples), MALLOC_CAP_8BIT);
  if (!rawBuf) {
    rawErrorCode = 1;
    rawSetState(RAW_ERROR);
    Serial.println("[RAW] ARM failed: allocation failed");
    return;
  }
  rawCapSamples = capSamples;
  rawCount = 0;
  rawArmSamples = 0;
  for (uint8_t i = 0; i < 3; i++) { rawSumG[i] = 0; rawSumA[i] = 0; }
  rawArmStartMs = millis();
  rawArmPercent = 0;
  rawSetAccelOdr(true);
  rawSetState(RAW_ARMING);
  Serial.printf("[RAW] ARM: capacity %u samples (%.1f s, %u bytes), free heap %u before / %u after, largest block %u\n",
                (unsigned)rawCapSamples, rawCapSamples / (float)RAW_SAMPLE_HZ, (unsigned)rawBytesForSamples(rawCapSamples),
                (unsigned)freeHeap, (unsigned)heap_caps_get_free_size(MALLOC_CAP_8BIT), (unsigned)largest);
}

void rawFinishCapture(bool autoStopped) {
  rawRepCount = (uint16_t)(repCount < 0 ? 0 : repCount);
  rawSetAccelOdr(false);
  if (autoStopped) rawFlags |= 0x02;
  rawSetState(RAW_READY);
  Serial.printf("[RAW] capture stopped: %u samples%s, reps=%u\n", (unsigned)rawCount, autoStopped ? " (cap reached)" : "", (unsigned)rawRepCount);
}

// Called for every fast-poll sample.
void rawHandleSample(const int16_t g[3], const int16_t a[3], uint32_t sensortime, unsigned long nowMs) {
  if (rawState == RAW_ARMING) {
    const uint32_t elapsed = nowMs - rawArmStartMs;
    { const uint32_t pct = elapsed * 100UL / RAW_ARM_MS; rawArmPercent = (uint8_t)(pct > 100 ? 100 : pct); }
    if (elapsed >= RAW_ARM_SETTLE_MS) {
      for (uint8_t i = 0; i < 3; i++) { rawSumG[i] += g[i]; rawSumA[i] += a[i]; }
      rawArmSamples++;
    }
    if (elapsed >= RAW_ARM_MS) {
      if (rawArmSamples == 0) {
        rawErrorCode = 2;
        rawSetAccelOdr(false);
        rawSetState(RAW_ERROR);
        return;
      }
      for (uint8_t i = 0; i < 3; i++) {
        rawGyroBias[i] = (float)(rawSumG[i] / rawArmSamples) / GYRO_SENSITIVITY_LSB_PER_DPS;
        rawGravity[i] = (float)(rawSumA[i] / rawArmSamples) / ACCEL_SENSITIVITY_LSB_PER_G * G_TO_MS2;
      }
      rawArmPercent = 100;
      rawSetState(RAW_ARMED);
      Serial.printf("[RAW] ARMED: gyro_bias=%.3f;%.3f;%.3f dps gravity=%.3f;%.3f;%.3f m/s2\n",
                    rawGyroBias[0], rawGyroBias[1], rawGyroBias[2], rawGravity[0], rawGravity[1], rawGravity[2]);
    }
    return;
  }
  if (rawState == RAW_CAPTURING) {
    if (rawCount >= rawCapSamples) {
      rawFinishCapture(true);
      return;
    }
    if (rawDiscardLeft > 0) {   // filter-settling transient right after START
      rawDiscardLeft--;
      return;
    }
    if (!rawBaseSet) {
      rawBaseSensortime = sensortime & 0xFFFFFF;
      rawBaseSet = true;
    }
    const uint32_t block = rawCount / RAW_BLOCK_SAMPLES;
    const uint32_t pos = rawCount % RAW_BLOCK_SAMPLES;
    uint8_t* blockStart = rawBuf + (size_t)block * RAW_BLOCK_BYTES;
    if (pos == 0) {   // block header: 24-bit SENSORTIME of the block's first sample
      blockStart[0] = (uint8_t)(sensortime & 0xFF);
      blockStart[1] = (uint8_t)((sensortime >> 8) & 0xFF);
      blockStart[2] = (uint8_t)((sensortime >> 16) & 0xFF);
      blockStart[3] = 0;
    }
    uint8_t* d = blockStart + 4 + pos * RAW_SAMPLE_BYTES;
    for (uint8_t i = 0; i < 3; i++) {
      d[i * 2] = (uint8_t)(g[i] & 0xFF);
      d[i * 2 + 1] = (uint8_t)((uint16_t)g[i] >> 8);
      d[6 + i * 2] = (uint8_t)(a[i] & 0xFF);
      d[6 + i * 2 + 1] = (uint8_t)((uint16_t)a[i] >> 8);
    }
    rawCount++;
    if (rawCount >= rawCapSamples) {
      rawFinishCapture(true);
    }
  }
}

// ---- chunk transport ----
bool rawSendChunk(uint8_t type, uint16_t index, const uint8_t* payload, uint8_t len) {
  uint8_t chunk[4 + RAW_MAX_PAYLOAD];
  chunk[0] = type;
  chunk[1] = (uint8_t)(index & 0xFF);
  chunk[2] = (uint8_t)(index >> 8);
  chunk[3] = len;
  if (len) memcpy(chunk + 4, payload, len);
  rawNotifyFailed = false;
  pRawCharacteristic->setValue(chunk, 4 + len);
  pRawCharacteristic->notify();
  return !rawNotifyFailed;
}

void rawBuildStatusPayload(uint8_t payload[12]) {
  payload[0] = rawState;
  payload[1] = rawErrorCode;
  payload[2] = rawArmPercent;
  payload[3] = rawFlags;
  memcpy(payload + 4, &rawCount, 4);
  memcpy(payload + 8, &rawCapSamples, 4);
}

// Updates the READ value; notifies only when connected.
void rawPublishStatus(bool notify) {
  uint8_t payload[12];
  rawBuildStatusPayload(payload);
  uint8_t chunk[16];
  chunk[0] = RAW_CHUNK_STATUS;
  chunk[1] = (uint8_t)(rawStatusSeq & 0xFF);
  chunk[2] = (uint8_t)(rawStatusSeq >> 8);
  chunk[3] = 12;
  memcpy(chunk + 4, payload, 12);
  rawStatusSeq++;
  pRawCharacteristic->setValue(chunk, 16);
  if (notify && deviceConnected) pRawCharacteristic->notify();
}

void rawPrepareUpload() {
  // header: ver u8, count u32, rate u16, accelG u8, gyroDps u16, bias f32x3, gravity f32x3,
  //         reps u16, sensortimeBase u32, fwLen u8, fw string
  // stream version 2: blockSamples u8 follows gyroDps; data = blocks of [sensortime u32][samples x 12 B]
  uint8_t* h = rawStream + 2;
  uint8_t n = 0;
  h[n++] = 2;
  memcpy(h + n, &rawCount, 4); n += 4;
  const uint16_t rate = RAW_SAMPLE_HZ;
  memcpy(h + n, &rate, 2); n += 2;
  h[n++] = ACCEL_RANGE_G;
  const uint16_t gyro = GYRO_RANGE_DPS;
  memcpy(h + n, &gyro, 2); n += 2;
  h[n++] = RAW_BLOCK_SAMPLES;
  memcpy(h + n, rawGyroBias, 12); n += 12;
  memcpy(h + n, rawGravity, 12); n += 12;
  memcpy(h + n, &rawRepCount, 2); n += 2;
  memcpy(h + n, &rawBaseSensortime, 4); n += 4;
  const uint8_t fwLen = (uint8_t)strlen(FW_VERSION);
  h[n++] = fwLen;
  memcpy(h + n, FW_VERSION, fwLen); n += fwLen;
  rawStream[0] = n;
  rawStream[1] = 0;
  rawStreamHeaderBytes = 2 + n;
  rawStreamBytes = rawStreamHeaderBytes + rawBytesForSamples(rawCount);
  uint16_t payload = connMtu > 7 ? connMtu - 7 : 16;   // MTU - 3 (ATT) - 4 (chunk header)
  if (payload > RAW_MAX_PAYLOAD) payload = RAW_MAX_PAYLOAD;
  if (payload < 16) payload = 16;
  rawPayload = payload;
  rawTotalChunks = (uint16_t)((rawStreamBytes + rawPayload - 1) / rawPayload);
}

void rawCopyStream(uint32_t offset, uint8_t* dst, uint8_t len) {
  for (uint8_t i = 0; i < len; i++) {
    const uint32_t pos = offset + i;
    if (pos < rawStreamHeaderBytes) {
      dst[i] = rawStream[pos];
    } else {
      dst[i] = rawBuf[pos - rawStreamHeaderBytes];
    }
  }
}

bool rawSendInfo(uint8_t type) {
  uint8_t p[8];
  memcpy(p, &rawPayload, 2);
  memcpy(p + 2, &rawTotalChunks, 2);
  memcpy(p + 4, &rawStreamBytes, 4);
  return rawSendChunk(type, rawTotalChunks, p, 8);
}

void rawStartUpload(uint16_t first, uint16_t end, bool sendInfo) {
  if (!rawBuf) return;
  if (rawState == RAW_READY && rawStreamBytes == 0) rawPrepareUpload();
  rawUpNext = first;
  rawUpEnd = end;
  rawUpPhase = sendInfo ? 1 : 2;
  rawSetState(RAW_UPLOADING);
}

void rawProcessCommand() {
  if (!rawCmdPending) return;
  const uint8_t cmd = rawCmd;
  const uint16_t a1 = rawCmdArg1;
  const uint16_t a2 = rawCmdArg2;
  rawCmdPending = false;
  switch (cmd) {
    case 0x10:  // ARM
      if (rawState == RAW_CAPTURING || rawState == RAW_UPLOADING || calibrationActive) { rawErrorCode = 2; rawStatusDirty = true; break; }
      rawStreamBytes = 0;
      rawBaseSet = false;
      rawBeginArm();
      break;
    case 0x11:  // START
      if (rawState == RAW_ARMED) {
        rawCount = 0;
        rawBaseSet = false;
        rawDiscardLeft = RAW_START_DISCARD_SAMPLES;
        rawStreamBytes = 0;
        rawFlags &= ~0x02;
        rawSetState(RAW_CAPTURING);
        Serial.println("[RAW] capture started");
      } else { rawErrorCode = 2; rawStatusDirty = true; }
      break;
    case 0x12:  // STOP
      if (rawState == RAW_CAPTURING) rawFinishCapture(false);
      else if (rawState == RAW_ARMING) rawAbortToIdle();
      else { rawErrorCode = 2; rawStatusDirty = true; }
      break;
    case 0x13:  // DOWNLOAD
      if (rawState == RAW_READY || rawState == RAW_UPLOADING) {
        rawStreamBytes = 0;
        rawPrepareUpload();
        rawStartUpload(0, rawTotalChunks, true);
      } else { rawErrorCode = 2; rawStatusDirty = true; }
      break;
    case 0x14:  // RESEND firstChunk, count
      if ((rawState == RAW_READY || rawState == RAW_UPLOADING) && rawBuf) {
        if (rawStreamBytes == 0) rawPrepareUpload();
        uint32_t end = (uint32_t)a1 + a2;
        if (end > rawTotalChunks) end = rawTotalChunks;
        rawStartUpload(a1, (uint16_t)end, false);
      } else { rawErrorCode = 2; rawStatusDirty = true; }
      break;
    case 0x15:  // ERASE / abort
      rawAbortToIdle();
      rawStreamBytes = 0;
      Serial.println("[RAW] erased");
      break;
  }
}

// Called every loop() iteration: commands, upload pacing, periodic status.
void rawService() {
  rawProcessCommand();
  const unsigned long now = millis();
  if (rawState == RAW_UPLOADING && deviceConnected) {
    for (uint8_t sent = 0; sent < RAW_CHUNKS_PER_SERVICE && rawUpPhase != 0; sent++) {
      bool ok = true;
      if (rawUpPhase == 1) {
        ok = rawSendInfo(RAW_CHUNK_INFO);
        if (ok) rawUpPhase = 2;
      } else if (rawUpPhase == 2) {
        if (rawUpNext >= rawUpEnd) {
          rawUpPhase = 3;
        } else {
          uint8_t payload[RAW_MAX_PAYLOAD];
          const uint32_t offset = (uint32_t)rawUpNext * rawPayload;
          const uint32_t remaining = rawStreamBytes - offset;
          const uint8_t len = (uint8_t)(remaining < rawPayload ? remaining : rawPayload);
          rawCopyStream(offset, payload, len);
          ok = rawSendChunk(RAW_CHUNK_DATA, rawUpNext, payload, len);
          if (ok) rawUpNext++;
        }
      } else if (rawUpPhase == 3) {
        ok = rawSendInfo(RAW_CHUNK_DONE);
        if (ok) {
          rawUpPhase = 0;
          rawSetState(RAW_READY);
        }
      }
      if (!ok) break;   // congestion: retry the same chunk on the next call
    }
    return;
  }
  if (rawStatusDirty || now - rawLastStatusMs >= RAW_STATUS_PERIOD_MS) {
    rawStatusDirty = false;
    rawLastStatusMs = now;
    rawPublishStatus(true);
  }
}

#if DEBUG_DIAG
// One compact line every 5 s (opt-in via DEBUG_DIAG).
void printDiagnostic(unsigned long now) {
  const unsigned long elapsedMs = now - lastDiagTime;
  if (elapsedMs == 0) return;
  const uint32_t avgI2cUs = diagSamples ? diagI2cUsSum / diagSamples : 0;
  Serial.printf("[DIAG] loop=%.1fHz notify=%.1fHz i2c_us avg=%u max=%u err=%u clip=%u batt_mv=%u cal=%u rep=%d conn=%d\n",
                diagSamples * 1000.0f / elapsedMs, diagNotifies * 1000.0f / elapsedMs,
                (unsigned)avgI2cUs, (unsigned)diagI2cUsMax, (unsigned)i2cErrorCount, (unsigned)clipSampleCount,
                (unsigned)batteryVoltageMillivolts, (unsigned)calibrationStatus, repCount, deviceConnected ? 1 : 0);
  diagSamples = 0;
  diagNotifies = 0;
  diagI2cUsSum = 0;
  diagI2cUsMax = 0;
  lastDiagTime = now;
}
#endif

#if DEBUG_PROTOCOL_SELFTEST
// Prints "[PROTO] <name> <36 hex chars>" for every golden input (tools/ble/check_protocol_serial.py
// compares the lines with tests/compat/golden/v1_vectors.json). No BLE traffic is generated.
void protocolSelfTest() {
  for (size_t i = 0; i < PROTOCOL_SELFTEST_COUNT; i++) {
    uint8_t out[LIFTIQ_TELEMETRY_V1_LENGTH];
    encodeTelemetryV1(out, PROTOCOL_SELFTEST_VECTORS[i].input);
    Serial.printf("[PROTO] %s ", PROTOCOL_SELFTEST_VECTORS[i].name);
    for (uint8_t b = 0; b < LIFTIQ_TELEMETRY_V1_LENGTH; b++) Serial.printf("%02x", out[b]);
    Serial.println();
  }
  uint8_t info[LIFTIQ_INFO_LENGTH];
  encodeInfoV1(info, LIFTIQ_PROTOCOL_MAJOR, LIFTIQ_PROTOCOL_MINOR, LIFTIQ_CAP_RAW_CAPTURE, FW_VERSION);
  Serial.print("[PROTO] INFO ");
  for (uint8_t b = 0; b < LIFTIQ_INFO_LENGTH; b++) Serial.printf("%02x", info[b]);
  Serial.println();
  Serial.println("[PROTO] done");
}
#endif

void setup() {
  Serial.begin(115200);
  while (!Serial && millis() < 3000); // Wait up to 3 sec for Serial Monitor

  Serial.println("\n=== LiftIQ / openGym Firmware Booting ===");

  Wire.begin(PIN_SDA, PIN_SCL);

  // Battery pin: plain input (no pull-up/down). The D3 pad it is jumpered from is never configured.
  pinMode(PIN_BATTERY, INPUT);
  // analogSetPinAttenuation only works once the pin is an ADC channel, hence the dummy read.
  (void)analogRead(PIN_BATTERY);
  analogSetPinAttenuation(PIN_BATTERY, ADC_11db);
  batteryVoltageMillivolts = readBatteryMillivolts(batteryDividerMillivolts);
  Serial.printf("[BATTERY] boot: pin D2/GPIO4=%u mV, estimated cell=%u mV\n",
                (unsigned)batteryDividerMillivolts, (unsigned)batteryVoltageMillivolts);
  if (batteryDividerMillivolts == 0) {
    Serial.println("[BATTERY] WARNING: 0 mV on D2/GPIO4 - D3->D2 jumper missing, no LiPo attached, or USB only.");
  }
  lastBatteryReadTime = millis();

  // Initialize BMI160 Sensor
  if (bmi160.I2cInit(BMI160_I2C) != BMI160_OK) {
    Serial.println("[ERROR] BMI160 init failed! Check wiring. Halting...");
    while (true) { delay(1000); }
  }
  Serial.println("[OK] BMI160 Initialized successfully.");
  // Library init resets the bus clock and sets +/-2 g / 1600 Hz: restore 400 kHz, then override the accelerometer config.
  Wire.setClock(I2C_CLOCK_HZ);
  configureAccelerometer();

  // Setup BLE Server & Characteristics
  // Unique name from the last two bytes of the Bluetooth MAC: "LiftIQ-XXXX".
  uint8_t mac[6] = {0};
  esp_read_mac(mac, ESP_MAC_BT);
  snprintf(bleDeviceName, sizeof(bleDeviceName), "LiftIQ-%02X%02X", mac[4], mac[5]);
  BLEDevice::init(bleDeviceName);
  BLEDevice::setMTU(RAW_PREFERRED_MTU);
  BLEServer *pServer = BLEDevice::createServer();
  pServer->setCallbacks(new ServerCallbacks());

  BLEService *pService = pServer->createService(SERVICE_UUID);

  // 1. Telemetry Output (Notify)
  pNotifyCharacteristic = pService->createCharacteristic(
                            NOTIFY_CHARACTERISTIC_UUID,
                            BLECharacteristic::PROPERTY_READ | 
                            BLECharacteristic::PROPERTY_NOTIFY
                          );
#ifdef CONFIG_BLUEDROID_ENABLED
  // Bluedroid needs the CCCD (0x2902) added by hand; NimBLE (the default for this core) creates
  // it automatically for NOTIFY characteristics (see BLECharacteristic::addDescriptor).
  pNotifyCharacteristic->addDescriptor(new BLE2902());
#endif

  // 2. Control Input (Write)
  BLECharacteristic *pWriteCharacteristic = pService->createCharacteristic(
                           WRITE_CHARACTERISTIC_UUID,
                           BLECharacteristic::PROPERTY_WRITE
                         );
  pWriteCharacteristic->setCallbacks(new ControlCallbacks());

  // 3. Research capture: chunked upload + READ-able status
  pRawCharacteristic = pService->createCharacteristic(
                         RAW_CHARACTERISTIC_UUID,
                         BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY
                       );
  pRawCharacteristic->setCallbacks(new RawCallbacks());
#ifdef CONFIG_BLUEDROID_ENABLED
  pRawCharacteristic->addDescriptor(new BLE2902());
#endif
  rawPublishStatus(false);

  // 4. INFO (read-only): protocol version, capabilities, firmware string. Additive characteristic;
  //    apps that do not know it simply never read it.
  {
    BLECharacteristic *pInfoCharacteristic = pService->createCharacteristic(
                                               INFO_CHARACTERISTIC_UUID,
                                               BLECharacteristic::PROPERTY_READ
                                             );
    uint8_t info[LIFTIQ_INFO_LENGTH];
    encodeInfoV1(info, LIFTIQ_PROTOCOL_MAJOR, LIFTIQ_PROTOCOL_MINOR, LIFTIQ_CAP_RAW_CAPTURE, FW_VERSION);
    pInfoCharacteristic->setValue(info, sizeof(info));
  }

  pService->start();

  // Configure Advertising payload so phone scans find it cleanly
  BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->setMinPreferred(0x12);  // helps iPhone connections
  BLEDevice::startAdvertising();

  Serial.print("[OK] BLE Advertising started as '");
  Serial.print(bleDeviceName);
  Serial.println("'.");
  Serial.println("[REP TRACKING] Waiting for start-set calibration command.");
#if DEBUG_PROTOCOL_SELFTEST
  protocolSelfTest();
#endif
  {
    size_t largest = 0, freeHeap = 0;
    bool reduced = false;
    const uint32_t cap = rawComputeCapacity(largest, freeHeap, reduced);
    Serial.printf("[RAW] free heap=%u largest block=%u, capture cap %.1f s at %u Hz (%u bytes) with %u bytes reserve (at ARM a connected client uses ~66 KB less heap)\n",
                  (unsigned)freeHeap, (unsigned)largest, cap / (float)RAW_SAMPLE_HZ, (unsigned)RAW_SAMPLE_HZ,
                  (unsigned)rawBytesForSamples(cap), (unsigned)RAW_HEAP_RESERVE);
  }
#if DEBUG_SERIAL_STREAM
  Serial.println("=========================================================================");
  Serial.println("Plotter Format -> ax(m/s2),ay(m/s2),az(m/s2),aTotal,aDynamic,Phase,RepCount");
  Serial.println("=========================================================================");
#endif
  lastSampleTime = millis();
#if DEBUG_DIAG
  lastDiagTime = millis();
#endif
  nextSampleUs = micros() + SAMPLE_PERIOD_US;
  lastSampleUs = micros();
}

void loop() {
  handleSerialCommand();
  serviceCalibrationRequest();
  rawService();

  // Fixed schedule from micros(): 100 Hz normally, 200 Hz while arming/capturing raw data.
  const bool fastPoll = rawFastPolling();
  const uint32_t periodUs = fastPoll ? RAW_PERIOD_US : SAMPLE_PERIOD_US;
  const uint32_t nowUs = micros();
  if ((int32_t)(nowUs - nextSampleUs) < 0) {
    if ((int32_t)(nextSampleUs - nowUs) > 1500) {
      delay(1);  // yield to the BLE stack when the next sample is not due soon
    }
    return;
  }
  if ((int32_t)(nowUs - nextSampleUs) > (int32_t)(5 * periodUs)) {
    nextSampleUs = nowUs;  // fell far behind (blocking work): resynchronise instead of bursting
  }
  nextSampleUs += periodUs;
  sampleCounter++;

  unsigned long currentTime = millis();

  // ONE reader feeds both paths: in fast mode a 15-byte burst (gyro, accel, SENSORTIME) is read
  // every 5 ms, stored for the raw capture, and every 2nd burst feeds the unchanged 100 Hz live pipeline.
  int16_t raw[3] = {0};
  if (fastPoll) {
    int16_t gyro[3];
    uint32_t sensortime = 0;
    if (!readImuBurst(gyro, raw, sensortime)) {
      return;
    }
    rawHandleSample(gyro, raw, sensortime, currentTime);
    if ((sampleCounter & 1) != 0) {
      return;  // live pipeline runs on every 2nd poll (100 Hz)
    }
  } else if (!readAccelRaw(raw)) {
    // A dead IMU must still end calibration (status 3) instead of leaving it at 1.
    if (calibrationActive && currentTime - calibrationStartTime >= CAL_TOTAL_MS) {
      finishCalibration();
    }
    return;
  }
  liveCounter++;
  const bool notifySlot = (liveCounter % NOTIFY_EVERY_N_SAMPLES) == 0;

  // Battery is read once a second, on a non-notify sample slot.
  if (!fastPoll && !notifySlot && currentTime - lastBatteryReadTime >= 1000) {
    batteryVoltageMillivolts = readBatteryMillivolts(batteryDividerMillivolts);
#if DEBUG_SERIAL_STREAM
    Serial.print("[BATTERY] pin divider=");
    Serial.print(batteryDividerMillivolts / 1000.0f, 3);
    Serial.print(" V, estimated cell=");
    Serial.print(batteryVoltageMillivolts / 1000.0f, 3);
    Serial.println(" V");
#endif
    lastBatteryReadTime = currentTime;
    if (batteryDividerMillivolts == 0 && currentTime - lastBatteryZeroWarnTime >= 10000) {
      Serial.println("[BATTERY] WARNING: D2/GPIO4 reads 0 mV (jumper D3->D2 missing / no LiPo / USB only?).");
      lastBatteryZeroWarnTime = currentTime;
    }
  }
  float dt = (nowUs - lastSampleUs) / 1000000.0f; // Delta t in seconds
  lastSampleUs = nowUs;
  lastSampleTime = currentTime;

#if DEBUG_DIAG
  diagSamples++;
  if (abs(raw[0]) >= ACCEL_CLIP_RAW || abs(raw[1]) >= ACCEL_CLIP_RAW || abs(raw[2]) >= ACCEL_CLIP_RAW) {
    clipSampleCount++;
  }
#endif

  // Raw accel -> m/s^2
  float ax = (raw[0] / ACCEL_SENSITIVITY_LSB_PER_G) * G_TO_MS2;
  float ay = (raw[1] / ACCEL_SENSITIVITY_LSB_PER_G) * G_TO_MS2;
  float az = (raw[2] / ACCEL_SENSITIVITY_LSB_PER_G) * G_TO_MS2;

  if (calibrationActive) {
    updateCalibration(ax, ay, az, currentTime);
  }

  const float totalAccel = sqrt(ax * ax + ay * ay + az * az);
  const float sampleDt = dt > 0.0f && dt < 0.05f ? dt : 0.01f;

  // With no gyro, track gravity only while the rep state machine is idle and
  // acceleration magnitude is close to 1g. Freeze the reference during reps.
  if (
    !calibrationActive &&
    currentPhase == IDLE &&
    fabs(totalAccel - baselineGravity) < GRAVITY_TRACKING_TOLERANCE
  ) {
    const float alpha = sampleDt / (GRAVITY_FILTER_TIME_CONSTANT_S + sampleDt);
    gravityX += (ax - gravityX) * alpha;
    gravityY += (ay - gravityY) * alpha;
    gravityZ += (az - gravityZ) * alpha;
    const float gravityMagnitude = sqrt(gravityX * gravityX + gravityY * gravityY + gravityZ * gravityZ);
    if (gravityMagnitude > 0.001f) {
      const float scale = baselineGravity / gravityMagnitude;
      gravityX *= scale;
      gravityY *= scale;
      gravityZ *= scale;
    }
  }

  float linearAccelX = ax - gravityX;
  float linearAccelY = ay - gravityY;
  float linearAccelZ = az - gravityZ;
  const float linearAccelMagnitude = sqrt(
    linearAccelX * linearAccelX +
    linearAccelY * linearAccelY +
    linearAccelZ * linearAccelZ
  );

  // Magnitude deviation is orientation-invariant, so a sensor rotation at
  // rest does not by itself look like a rep onset or active movement.
  float dynamicAccel = fabs(totalAccel - baselineGravity);
  float projectedAccel = 0.0f;
  if (currentPhase != IDLE) {
    projectedAccel =
      linearAccelX * motionAxisX +
      linearAccelY * motionAxisY +
      linearAccelZ * motionAxisZ;
    const float phaseAlpha = sampleDt / (PHASE_FILTER_TIME_CONSTANT_S + sampleDt);
    filteredAxisAccel += phaseAlpha * (projectedAccel - filteredAxisAccel);
  }

  // --- ACCELERATION-ONLY REP AND PHASE STATE MACHINE ---
  switch (currentPhase) {
    case IDLE:
      if (
        repTrackingEnabled &&
        linearAccelMagnitude > START_CONCENTRIC_THRESH &&
        dynamicAccel > MIN_ONSET_MAGNITUDE_DEVIATION
      ) {
        onsetAccelSumX += linearAccelX;
        onsetAccelSumY += linearAccelY;
        onsetAccelSumZ += linearAccelZ;
        if (onsetSampleCount == 0) onsetStartTime = currentTime;
        if (onsetSampleCount < 255) onsetSampleCount++;
        if (
          onsetSampleCount >= MOTION_ONSET_MIN_SAMPLES &&
          currentTime - onsetStartTime >= MOTION_ONSET_WINDOW_MS
        ) {
          const float onsetMagnitude = sqrt(
            onsetAccelSumX * onsetAccelSumX +
            onsetAccelSumY * onsetAccelSumY +
            onsetAccelSumZ * onsetAccelSumZ
          );
          if (onsetMagnitude > 0.001f) {
            motionAxisX = onsetAccelSumX / onsetMagnitude;
            motionAxisY = onsetAccelSumY / onsetMagnitude;
            motionAxisZ = onsetAccelSumZ / onsetMagnitude;
            currentPhase = CONCENTRIC;
            concentricStartTime = currentTime;
            totalRepStartTime = currentTime;
            phaseStartTime = currentTime;
            filteredAxisAccel =
              linearAccelX * motionAxisX +
              linearAccelY * motionAxisY +
              linearAccelZ * motionAxisZ;
            phaseSignalSampleCount = 0;
            eccentricBrakingDetected = false;
            restStartTime = 0;
#if DEBUG_SERIAL_STREAM
            Serial.println("\n>>> Phase: [CONCENTRIC - ACCELERATION ONSET] <<<");
#endif
          }
          onsetSampleCount = 0;
          onsetAccelSumX = 0.0f;
          onsetAccelSumY = 0.0f;
          onsetAccelSumZ = 0.0f;
        }
      } else {
        onsetSampleCount = 0;
        onsetAccelSumX = 0.0f;
        onsetAccelSumY = 0.0f;
        onsetAccelSumZ = 0.0f;
      }
      break;

    case CONCENTRIC:
      if (
        filteredAxisAccel < -PHASE_REVERSAL_THRESH &&
        currentTime - concentricStartTime >= MIN_CONCENTRIC_TIME_MS
      ) {
        if (phaseSignalSampleCount == 0) phaseSignalStartTime = currentTime;
        phaseSignalSampleCount++;
        if (currentTime - phaseSignalStartTime >= MIN_PHASE_SIGNAL_MS) {
          currentPhase = ECCENTRIC;
          phaseStartTime = currentTime;
          phaseSignalSampleCount = 0;
          eccentricBrakingDetected = false;
          restStartTime = 0;
          phaseSignalStartTime = 0;
#if DEBUG_SERIAL_STREAM
          Serial.println("\n>>> Phase: [ECCENTRIC - ACCELERATION REVERSAL] <<<");
#endif
        }
      } else {
        phaseSignalSampleCount = 0;
        phaseSignalStartTime = 0;
      }
      break;

    case ECCENTRIC:
      if (
        filteredAxisAccel > PHASE_REVERSAL_THRESH &&
        currentTime - phaseStartTime >= MIN_ECCENTRIC_TIME_MS
      ) {
        if (phaseSignalSampleCount == 0) phaseSignalStartTime = currentTime;
        phaseSignalSampleCount++;
        if (currentTime - phaseSignalStartTime >= MIN_PHASE_SIGNAL_MS) {
          eccentricBrakingDetected = true;
        }
      } else {
        phaseSignalSampleCount = 0;
        phaseSignalStartTime = 0;
      }

      if (
        eccentricBrakingDetected &&
        dynamicAccel < REST_NOISE_THRESH
      ) {
        if (restStartTime == 0) restStartTime = currentTime;
      } else {
        restStartTime = 0;
      }

      if (
        restStartTime != 0 &&
        currentTime - restStartTime >= MIN_REST_DWELL_MS &&
        currentTime - totalRepStartTime >= MIN_TOTAL_REP_TIME_MS
      ) {
        repCount++;
#if DEBUG_SERIAL_STREAM
        unsigned long totalRepDuration = currentTime - totalRepStartTime;
        Serial.println("\n==========================================");
        Serial.print(" REP #"); Serial.print(repCount); Serial.println(" LOGGED!");
        Serial.print(" - Duration      : "); Serial.print(totalRepDuration); Serial.println(" ms");
        Serial.println(" - Detection     : acceleration-only cycle");
        Serial.println("==========================================\n");
#endif

        currentPhase = IDLE;
        restStartTime = 0;
        phaseSignalSampleCount = 0;
        phaseSignalStartTime = 0;
        motionAxisX = 0.0f;
        motionAxisY = 0.0f;
        motionAxisZ = 0.0f;
      }
      break;
  }

  // --- SERIAL STREAM FOR REAL-TIME PLOTTER (100 Hz CSV) ---
#if DEBUG_SERIAL_STREAM
  Serial.print("ax:"); Serial.print(ax, 2); Serial.print(",");
  Serial.print("ay:"); Serial.print(ay, 2); Serial.print(",");
  Serial.print("az:"); Serial.print(az, 2); Serial.print(",");
  Serial.print("aTotal:"); Serial.print(totalAccel, 2); Serial.print(",");
  Serial.print("aDynamic:"); Serial.print(dynamicAccel, 2); Serial.print(",");
  Serial.print("Phase:"); Serial.print((int)currentPhase); Serial.print(",");
  Serial.print("RepCount:"); Serial.println(repCount);
#endif

  // 50 Hz BLE cadence: every 2nd sample, or immediately after a calibration status change.
  if ((notifySlot || forceNextNotify) && rawState != RAW_UPLOADING) {   // live telemetry pauses during upload
    notifyTelemetry(ax, ay, az, totalAccel, dynamicAccel);
  }

#if DEBUG_DIAG
  if (millis() - lastDiagTime >= 5000) {
    printDiagnostic(millis());
  }
#endif
}