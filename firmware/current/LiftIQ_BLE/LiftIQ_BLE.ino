// LiftIQ / openGym Firmware — Acceleration-Only Rep Tracking
// Board:   Seeed Studio XIAO ESP32C3 (Arduino board: XIAO_ESP32C3)
// Library: DFRobot_BMI160 (github.com/DFRobot/DFRobot_BMI160)
// Hardware: SDA = GPIO 6 (D4), SCL = GPIO 7 (D5), battery ADC = GPIO 3 (D1)
// BMI160 I2C address = 0x68

#include <Wire.h>
#include <DFRobot_BMI160.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLE2902.h>

// --- HARDWARE CONFIGURATION ---
const int PIN_SDA = 6;
const int PIN_SCL = 7;
const int PIN_BATTERY = 3;  // XIAO ESP32C3 D1 / GPIO3 / ADC1_CH3
const int8_t BMI160_I2C = 0x68;
const float BATTERY_DIVIDER_RATIO = 2.0f;

DFRobot_BMI160 bmi160;

// Sensor Conversion Constants (+/-2g accelerometer)
const float ACCEL_SENSITIVITY_LSB_PER_G = 16384.0f; 
const float G_TO_MS2 = 9.81f;

// --- BLE UUID DEFINITIONS ---
#define SERVICE_UUID              "4fa8691a-1365-4a4f-a808-3fda13b292e0"
#define NOTIFY_CHARACTERISTIC_UUID "beb5483e-36e1-4688-b7f5-ea07361b26a8"
#define WRITE_CHARACTERISTIC_UUID  "cba8691a-1365-4a4f-a808-3fda13b292e0"

BLECharacteristic *pNotifyCharacteristic;
BLECharacteristic *pWriteCharacteristic;
bool deviceConnected = false;
volatile bool calibrationRequested = false;
unsigned long lastBleNotifyTime = 0;
unsigned long lastBatteryReadTime = 0;
uint16_t batteryVoltageMillivolts = 0;

const uint8_t CALIBRATION_IDLE = 0;
const uint8_t CALIBRATION_STARTED = 1;
const uint8_t CALIBRATION_COMPLETE = 2;
const uint8_t CALIBRATION_FAILED = 3;

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
const float PHASE_FILTER_ALPHA = 0.25f;
const uint8_t MOTION_ONSET_SAMPLES = 4;

// Motion State Machine
enum LiftPhase { IDLE = 0, CONCENTRIC = 1, ECCENTRIC = 2 };
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

uint16_t readBatteryMillivolts() {
  const uint32_t pinMillivolts = analogReadMilliVolts(PIN_BATTERY);
  const uint32_t batteryMillivolts = (uint32_t)lroundf(pinMillivolts * BATTERY_DIVIDER_RATIO);
  return batteryMillivolts > 65535 ? 65535 : (uint16_t)batteryMillivolts;
}

void notifyTelemetry(
  float ax,
  float ay,
  float az,
  float totalAccel,
  float dynamicAccel,
  float,
  uint8_t status
) {
  if (!deviceConnected) {
    return;
  }
  unsigned long now = millis();
  if (status == CALIBRATION_IDLE && now - lastBleNotifyTime < 20) {
    return;
  }
  lastBleNotifyTime = now;

  // Five accelerometer fields, reserved zero, phase, calibration, reps, battery.
  // Little-endian packet, 18 bytes total (fits the default BLE MTU).
  int16_t values[6] = {
    scaledInt16(ax, 100.0f),
    scaledInt16(ay, 100.0f),
    scaledInt16(az, 100.0f),
    scaledInt16(totalAccel, 100.0f),
    scaledInt16(dynamicAccel, 100.0f),
    0
  };
  uint8_t payload[18];
  for (uint8_t i = 0; i < 6; i++) {
    uint16_t encoded = (uint16_t)values[i];
    payload[i * 2] = (uint8_t)(encoded & 0xFF);
    payload[i * 2 + 1] = (uint8_t)(encoded >> 8);
  }
  payload[12] = (uint8_t)currentPhase;
  payload[13] = status;
  payload[14] = (uint8_t)(repCount & 0xFF);
  payload[15] = (uint8_t)((repCount >> 8) & 0xFF);
  payload[16] = (uint8_t)(batteryVoltageMillivolts & 0xFF);
  payload[17] = (uint8_t)(batteryVoltageMillivolts >> 8);

  pNotifyCharacteristic->setValue(payload, sizeof(payload));
  pNotifyCharacteristic->notify();
}

void notifyCalibrationStatus(uint8_t status) {
  notifyTelemetry(0, 0, 0, 0, 0, 0, status);
}

// --- BASELINE GRAVITY CALIBRATION ---
bool calibrateBaselineGravity() {
  notifyCalibrationStatus(CALIBRATION_STARTED);
  Serial.println("[CALIBRATION] STARTED - Keep device still");
  delay(500);
  
  double sumAccelX = 0.0;
  double sumAccelY = 0.0;
  double sumAccelZ = 0.0;
  int validSamples = 0;

  for (int i = 0; i < 450; i++) {
    int16_t raw[6] = {0};
    if (bmi160.getAccelGyroData(raw) == BMI160_OK) {
      // DFRobot packing order: raw[3..5] is Accel XYZ
      float ax_ms2 = (raw[3] / ACCEL_SENSITIVITY_LSB_PER_G) * G_TO_MS2;
      float ay_ms2 = (raw[4] / ACCEL_SENSITIVITY_LSB_PER_G) * G_TO_MS2;
      float az_ms2 = (raw[5] / ACCEL_SENSITIVITY_LSB_PER_G) * G_TO_MS2;
      sumAccelX += ax_ms2;
      sumAccelY += ay_ms2;
      sumAccelZ += az_ms2;
      validSamples++;
    }
    delay(10);
  }

  if (validSamples == 0) {
    notifyCalibrationStatus(CALIBRATION_FAILED);
    Serial.println("[CALIBRATION] FAILED - no valid BMI160 samples");
    return false;
  }

  gravityX = sumAccelX / validSamples;
  gravityY = sumAccelY / validSamples;
  gravityZ = sumAccelZ / validSamples;
  baselineGravity = sqrt(gravityX * gravityX + gravityY * gravityY + gravityZ * gravityZ);
  Serial.print("[CALIBRATION] COMPLETE - baseline gravity: ");
  Serial.print(baselineGravity, 3);
  Serial.println(" m/s^2");
  notifyCalibrationStatus(CALIBRATION_COMPLETE);
  return true;
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

  if (calibrateBaselineGravity()) {
    resetRepTracking();
  }
}

void setup() {
  Serial.begin(115200);
  while (!Serial && millis() < 3000); // Wait up to 3 sec for Serial Monitor

  Serial.println("\n=== LiftIQ / openGym Firmware Booting ===");

  pinMode(PIN_BATTERY, INPUT);
  Wire.begin(PIN_SDA, PIN_SCL);

  // Initialize BMI160 Sensor
  if (bmi160.I2cInit(BMI160_I2C) != BMI160_OK) {
    Serial.println("[ERROR] BMI160 init failed! Check wiring. Halting...");
    while (true) { delay(1000); }
  }
  Serial.println("[OK] BMI160 Initialized successfully.");

  // Setup BLE Server & Characteristics
  BLEDevice::init("GymIQ Sensor");
  BLEServer *pServer = BLEDevice::createServer();
  pServer->setCallbacks(new ServerCallbacks());

  BLEService *pService = pServer->createService(SERVICE_UUID);

  // 1. Telemetry Output (Notify)
  pNotifyCharacteristic = pService->createCharacteristic(
                            NOTIFY_CHARACTERISTIC_UUID,
                            BLECharacteristic::PROPERTY_READ | 
                            BLECharacteristic::PROPERTY_NOTIFY
                          );
  pNotifyCharacteristic->addDescriptor(new BLE2902());

  // 2. Control Input (Write)
  pWriteCharacteristic = pService->createCharacteristic(
                           WRITE_CHARACTERISTIC_UUID,
                           BLECharacteristic::PROPERTY_WRITE
                         );
  pWriteCharacteristic->setCallbacks(new ControlCallbacks());

  pService->start();

  // Configure Advertising payload so phone scans find it cleanly
  BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->setMinPreferred(0x06); // functions that help with iPhone connections
  pAdvertising->setMinPreferred(0x12);
  BLEDevice::startAdvertising();

  Serial.println("[OK] BLE Advertising started as 'GymIQ Sensor'.");
  Serial.println("=========================================================================");
  Serial.println("Plotter Format -> ax(m/s2),ay(m/s2),az(m/s2),aTotal,aDynamic,SpeedEstimate(NA),Phase,RepCount");
  Serial.println("=========================================================================");
  lastSampleTime = millis();
}

void loop() {
  handleSerialCommand();
  serviceCalibrationRequest();

  unsigned long currentTime = millis();
  if (currentTime - lastBatteryReadTime >= 1000) {
    batteryVoltageMillivolts = readBatteryMillivolts();
    lastBatteryReadTime = currentTime;
  }
  float dt = (currentTime - lastSampleTime) / 1000.0f; // Delta t in seconds
  lastSampleTime = currentTime;

  int16_t raw[6] = {0};
  if (bmi160.getAccelGyroData(raw) != BMI160_OK) {
    return;
  }

  // Extract raw accel (m/s^2) - Index 3, 4, 5
  float ax = (raw[3] / ACCEL_SENSITIVITY_LSB_PER_G) * G_TO_MS2;
  float ay = (raw[4] / ACCEL_SENSITIVITY_LSB_PER_G) * G_TO_MS2;
  float az = (raw[5] / ACCEL_SENSITIVITY_LSB_PER_G) * G_TO_MS2;

  const float totalAccel = sqrt(ax * ax + ay * ay + az * az);
  const float sampleDt = dt > 0.0f && dt < 0.05f ? dt : 0.01f;

  // With no gyro, track gravity only while the rep state machine is idle and
  // acceleration magnitude is close to 1g. Freeze the reference during reps.
  if (
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
    filteredAxisAccel += PHASE_FILTER_ALPHA * (projectedAccel - filteredAxisAccel);
  }

  // --- ACCELERATION-ONLY REP AND PHASE STATE MACHINE ---
  switch (currentPhase) {
    case IDLE:
      if (
        linearAccelMagnitude > START_CONCENTRIC_THRESH &&
        dynamicAccel > MIN_ONSET_MAGNITUDE_DEVIATION
      ) {
        onsetAccelSumX += linearAccelX;
        onsetAccelSumY += linearAccelY;
        onsetAccelSumZ += linearAccelZ;
        onsetSampleCount++;
        if (onsetSampleCount >= MOTION_ONSET_SAMPLES) {
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
            Serial.println("\n>>> Phase: [CONCENTRIC - ACCELERATION ONSET] <<<");
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
          Serial.println("\n>>> Phase: [ECCENTRIC - ACCELERATION REVERSAL] <<<");
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
        unsigned long totalRepDuration = currentTime - totalRepStartTime;
        repCount++;
        Serial.println("\n==========================================");
        Serial.print(" REP #"); Serial.print(repCount); Serial.println(" LOGGED!");
        Serial.print(" - Duration      : "); Serial.print(totalRepDuration); Serial.println(" ms");
        Serial.println(" - Detection     : acceleration-only cycle");
        Serial.println("==========================================\n");

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
  Serial.print("ax:"); Serial.print(ax, 2); Serial.print(",");
  Serial.print("ay:"); Serial.print(ay, 2); Serial.print(",");
  Serial.print("az:"); Serial.print(az, 2); Serial.print(",");
  Serial.print("aTotal:"); Serial.print(totalAccel, 2); Serial.print(",");
  Serial.print("aDynamic:"); Serial.print(dynamicAccel, 2); Serial.print(",");
  Serial.print("VelocityEstimate:"); Serial.print("NA"); Serial.print(",");
  Serial.print("Phase:"); Serial.print((int)currentPhase); Serial.print(",");
  Serial.print("RepCount:"); Serial.println(repCount);

  notifyTelemetry(ax, ay, az, totalAccel, dynamicAccel, 0.0f, CALIBRATION_IDLE);

  delay(10); // ~100Hz loop rate
}