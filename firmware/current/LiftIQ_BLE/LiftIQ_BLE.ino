// LiftIQ firmware - acceleration-only rep tracking over BLE
// Board:   Seeed Studio XIAO ESP32C3 (arduino-cli: esp32:esp32:XIAO_ESP32C3)
// Library: DFRobot_BMI160 (used for sensor init only; data is read directly over Wire)
// Wiring:  SDA = GPIO 6 (D4), SCL = GPIO 7 (D5), BMI160 at I2C 0x68.
//          Battery divider midpoint is on the D3 pad (GPIO5 = ADC2, which the ESP32-C3
//          cannot read) and is jumpered to D1 = GPIO 3 (ADC1_CH3), which is read here.

// Set to 1 to enable the human-readable serial stream (100 Hz plotter CSV,
// 1 Hz battery line, phase/rep banners). Required by the tools/ serial
// plotter and dashboard scripts. Boot messages and errors are always printed.
#define DEBUG_SERIAL_STREAM 0

// Set to 1 for one compact diagnostic line every 5 s (loop Hz, notify Hz, I2C
// timing/errors, accelerometer clipping, battery, calibration, reps, connection).
#define DEBUG_DIAG 0

#include <Wire.h>
#include <DFRobot_BMI160.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLE2902.h>
#include <esp_mac.h>   // esp_read_mac / ESP_MAC_BT

// Defined before the first function so the Arduino auto-generated prototypes can see it.
enum LiftPhase { IDLE = 0, CONCENTRIC = 1, ECCENTRIC = 2 };

// --- HARDWARE CONFIGURATION ---
const int PIN_SDA = 6;
const int PIN_SCL = 7;
const int PIN_BATTERY = 3;  // D1 / GPIO3 / ADC1_CH3, jumpered from the D3 divider midpoint
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

// --- FIXED SAMPLE SCHEDULE ---
const uint32_t SAMPLE_PERIOD_US = 10000;   // 100 Hz IMU polling
const uint8_t NOTIFY_EVERY_N_SAMPLES = 2;  // 50 Hz BLE notifications
const float G_TO_MS2 = 9.81f;

// --- BLE UUID DEFINITIONS ---
#define SERVICE_UUID              "4fa8691a-1365-4a4f-a808-3fda13b292e0"
#define NOTIFY_CHARACTERISTIC_UUID "beb5483e-36e1-4688-b7f5-ea07361b26a8"
#define WRITE_CHARACTERISTIC_UUID  "cba8691a-1365-4a4f-a808-3fda13b292e0"

BLECharacteristic *pNotifyCharacteristic;
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
      Serial.println("\n[BLE] App Connected!");
    }
    void onDisconnect(BLEServer* pServer) { 
      deviceConnected = false; 
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
        if (command == 0x01) {
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

int16_t scaledInt16(float value, float scale) {
  float scaled = value * scale;
  if (scaled > 32767.0f) scaled = 32767.0f;
  if (scaled < -32768.0f) scaled = -32768.0f;
  return (int16_t)lroundf(scaled);
}

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
  uint8_t conf = 0xFF, range = 0xFF, err = 0xFF, pmu = 0xFF, chip = 0xFF;
  ok = imuReadRegs(BMI160_REG_ACC_CONF, &conf, 1) && ok;
  ok = imuReadRegs(BMI160_REG_ACC_RANGE, &range, 1) && ok;
  ok = imuReadRegs(BMI160_REG_ERR, &err, 1) && ok;
  ok = imuReadRegs(BMI160_REG_PMU_STATUS, &pmu, 1) && ok;
  ok = imuReadRegs(BMI160_REG_CHIP_ID, &chip, 1) && ok;
  Serial.printf("[IMU] chip=0x%02X ACC_CONF=0x%02X (want 0x%02X) ACC_RANGE=0x%02X (want 0x%02X, +/-%u g) ERR_REG=0x%02X PMU_STATUS=0x%02X\n",
                chip, conf, BMI160_ACC_CONF_VALUE, range, BMI160_ACC_RANGE_VALUE, ACCEL_RANGE_G, err, pmu);
  const bool matches = ok && conf == BMI160_ACC_CONF_VALUE && (range & 0x0F) == BMI160_ACC_RANGE_VALUE;
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
  uint16_t values[6] = {
    (uint16_t)scaledInt16(ax, 100.0f),
    (uint16_t)scaledInt16(ay, 100.0f),
    (uint16_t)scaledInt16(az, 100.0f),
    (uint16_t)scaledInt16(totalAccel, 100.0f),
    (uint16_t)scaledInt16(dynamicAccel, 100.0f),
    telemetrySequence++
  };
  uint8_t payload[18];
  for (uint8_t i = 0; i < 6; i++) {
    const uint16_t encoded = values[i];
    payload[i * 2] = (uint8_t)(encoded & 0xFF);
    payload[i * 2 + 1] = (uint8_t)(encoded >> 8);
  }
  payload[12] = (uint8_t)currentPhase;
  payload[13] = calibrationStatus;
  payload[14] = (uint8_t)(repCount & 0xFF);
  payload[15] = (uint8_t)((repCount >> 8) & 0xFF);
  payload[16] = (uint8_t)(batteryVoltageMillivolts & 0xFF);
  payload[17] = (uint8_t)(batteryVoltageMillivolts >> 8);

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
  Serial.printf("[BATTERY] boot: pin D1/GPIO3=%u mV, estimated cell=%u mV\n",
                (unsigned)batteryDividerMillivolts, (unsigned)batteryVoltageMillivolts);
  if (batteryDividerMillivolts == 0) {
    Serial.println("[BATTERY] WARNING: 0 mV on D1/GPIO3 - D3->D1 jumper missing, no LiPo attached, or USB only.");
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

  // Fixed 100 Hz schedule from micros() (no delay(10) drift).
  const uint32_t nowUs = micros();
  if ((int32_t)(nowUs - nextSampleUs) < 0) {
    if ((int32_t)(nextSampleUs - nowUs) > 1500) {
      delay(1);  // yield to the BLE stack when the next sample is not due soon
    }
    return;
  }
  if ((int32_t)(nowUs - nextSampleUs) > (int32_t)(5 * SAMPLE_PERIOD_US)) {
    nextSampleUs = nowUs;  // fell far behind (blocking work): resynchronise instead of bursting
  }
  nextSampleUs += SAMPLE_PERIOD_US;
  sampleCounter++;
  const bool notifySlot = (sampleCounter % NOTIFY_EVERY_N_SAMPLES) == 0;

  unsigned long currentTime = millis();
  // Battery is read once a second, on a non-notify sample slot.
  if (!notifySlot && currentTime - lastBatteryReadTime >= 1000) {
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
      Serial.println("[BATTERY] WARNING: D1/GPIO3 reads 0 mV (jumper D3->D1 missing / no LiPo / USB only?).");
      lastBatteryZeroWarnTime = currentTime;
    }
  }
  float dt = (nowUs - lastSampleUs) / 1000000.0f; // Delta t in seconds
  lastSampleUs = nowUs;
  lastSampleTime = currentTime;

  int16_t raw[3] = {0};
  if (!readAccelRaw(raw)) {
    // A dead IMU must still end calibration (status 3) instead of leaving it at 1.
    if (calibrationActive && currentTime - calibrationStartTime >= CAL_TOTAL_MS) {
      finishCalibration();
    }
    return;
  }
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
  if (notifySlot || forceNextNotify) {
    notifyTelemetry(ax, ay, az, totalAccel, dynamicAccel);
  }

#if DEBUG_DIAG
  if (millis() - lastDiagTime >= 5000) {
    printDiagnostic(millis());
  }
#endif
}