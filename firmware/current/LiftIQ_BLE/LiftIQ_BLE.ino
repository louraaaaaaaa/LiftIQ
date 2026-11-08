// LiftIQ / openGym Firmware — Multi-Axis VBT, Bump Rejection & Phone Control
// Board:   Seeed Studio XIAO ESP32-S3
// Library: DFRobot_BMI160 (github.com/DFRobot/DFRobot_BMI160)
// Hardware: SDA = GPIO 5 (D4), SCL = GPIO 6 (D5), I2C Address = 0x68

#include <Wire.h>
#include <DFRobot_BMI160.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLE2902.h>

// --- HARDWARE CONFIGURATION ---
const int PIN_SDA = 5;
const int PIN_SCL = 6;
const int8_t BMI160_I2C = 0x68;

DFRobot_BMI160 bmi160;

// Sensor Conversion Constants (+/-2g accel, +/-2000 deg/s gyro)
const float ACCEL_SENSITIVITY_LSB_PER_G = 16384.0f; 
const float GYRO_SENSITIVITY_LSB_PER_DPS = 16.384f;
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

const uint8_t CALIBRATION_IDLE = 0;
const uint8_t CALIBRATION_STARTED = 1;
const uint8_t CALIBRATION_COMPLETE = 2;
const uint8_t CALIBRATION_FAILED = 3;

// --- TUNABLE PHYSICS & THRESHOLD VARIABLES ---
float baselineGravity = 9.81f; // Recalibrated at the start of each measurement

// Dynamically updated thresholds (can be tuned via BLE from phone)
float START_CONCENTRIC_THRESH      = 1.2f;  // Dynamic accel (m/s^2) to initiate rep
float STOP_CONCENTRIC_THRESH       = 0.3f;  // Dynamic accel (m/s^2) to end concentric phase
float REST_NOISE_THRESH            = 0.25f; // Stationary noise floor

unsigned long MIN_CONCENTRIC_TIME_MS = 400;  // Must lift for at least 400ms
unsigned long MIN_TOTAL_REP_TIME_MS  = 900;  // Full rep cycle must take >= 900ms
float MIN_PEAK_VELOCITY              = 0.12f; // Must achieve at least 0.12 m/s

// Motion State Machine
enum LiftPhase { IDLE = 0, CONCENTRIC = 1, ECCENTRIC = 2 };
LiftPhase currentPhase = IDLE;

// Rep Tracking Telemetry
int repCount = 0;
unsigned long lastSampleTime   = 0;
unsigned long concentricStartTime = 0;
unsigned long totalRepStartTime   = 0;
unsigned long phaseStartTime       = 0;

float currentVelocity = 0.0f; // m/s
float peakVelocity    = 0.0f; // m/s
float peakAccel       = 0.0f; // m/s^2
float velocitySum     = 0.0f;
int concentricSamples = 0;

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
        } 
        // Command 0x02: LIVE THRESHOLD TUNING FROM PHONE
        else if (command == 0x02 && length >= 4) {
          START_CONCENTRIC_THRESH = rxData[1] / 10.0f;  // Sent as int * 10
          MIN_CONCENTRIC_TIME_MS  = rxData[2] * 10;     // Sent as int / 10
          MIN_PEAK_VELOCITY       = rxData[3] / 100.0f; // Sent as int * 100

          Serial.println("\n[BLE CMD] Thresholds Updated from App:");
          Serial.print(" - Start Accel Thresh : "); Serial.print(START_CONCENTRIC_THRESH); Serial.println(" m/s^2");
          Serial.print(" - Min Concentric Duration : "); Serial.print(MIN_CONCENTRIC_TIME_MS); Serial.println(" ms");
          Serial.print(" - Min Peak Velocity       : "); Serial.print(MIN_PEAK_VELOCITY); Serial.println(" m/s");
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

void notifyTelemetry(
  float ax,
  float ay,
  float az,
  float totalAccel,
  float dynamicAccel,
  float velocity,
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

  // Six scaled int16 values, phase, calibration status, and uint16 rep count.
  // Little-endian packet, 16 bytes total (fits the default BLE MTU).
  int16_t values[6] = {
    scaledInt16(ax, 100.0f),
    scaledInt16(ay, 100.0f),
    scaledInt16(az, 100.0f),
    scaledInt16(totalAccel, 100.0f),
    scaledInt16(dynamicAccel, 100.0f),
    scaledInt16(velocity, 1000.0f)
  };
  uint8_t payload[16];
  for (uint8_t i = 0; i < 6; i++) {
    uint16_t encoded = (uint16_t)values[i];
    payload[i * 2] = (uint8_t)(encoded & 0xFF);
    payload[i * 2 + 1] = (uint8_t)(encoded >> 8);
  }
  payload[12] = (uint8_t)currentPhase;
  payload[13] = status;
  payload[14] = (uint8_t)(repCount & 0xFF);
  payload[15] = (uint8_t)((repCount >> 8) & 0xFF);

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
  
  double sumAccel = 0.0;
  int validSamples = 0;

  for (int i = 0; i < 100; i++) {
    int16_t raw[6] = {0};
    if (bmi160.getAccelGyroData(raw) == BMI160_OK) {
      // DFRobot packing order: raw[3..5] is Accel XYZ
      float ax_ms2 = (raw[3] / ACCEL_SENSITIVITY_LSB_PER_G) * G_TO_MS2;
      float ay_ms2 = (raw[4] / ACCEL_SENSITIVITY_LSB_PER_G) * G_TO_MS2;
      float az_ms2 = (raw[5] / ACCEL_SENSITIVITY_LSB_PER_G) * G_TO_MS2;

      float totalAccel = sqrt(ax_ms2 * ax_ms2 + ay_ms2 * ay_ms2 + az_ms2 * az_ms2);
      sumAccel += totalAccel;
      validSamples++;
    }
    delay(10);
  }

  if (validSamples == 0) {
    notifyCalibrationStatus(CALIBRATION_FAILED);
    Serial.println("[CALIBRATION] FAILED - no valid BMI160 samples");
    return false;
  }

  baselineGravity = sumAccel / validSamples;
  Serial.print("[CALIBRATION] COMPLETE - baseline gravity: ");
  Serial.print(baselineGravity, 3);
  Serial.println(" m/s^2");
  notifyCalibrationStatus(CALIBRATION_COMPLETE);
  return true;
}

void resetRepTracking() {
  repCount = 0;
  currentPhase = IDLE;
  currentVelocity = 0.0f;
  peakVelocity = 0.0f;
  peakAccel = 0.0f;
  velocitySum = 0.0f;
  concentricSamples = 0;
  concentricStartTime = 0;
  totalRepStartTime = 0;
  phaseStartTime = 0;
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
  Serial.println("Plotter Format -> ax(m/s2),ay(m/s2),az(m/s2),aTotal,aDynamic,Vel(m/s),Phase,RepCount");
  Serial.println("=========================================================================");
  lastSampleTime = millis();
}

void loop() {
  handleSerialCommand();
  serviceCalibrationRequest();

  unsigned long currentTime = millis();
  float dt = (currentTime - lastSampleTime) / 1000.0f; // Delta t in seconds
  lastSampleTime = currentTime;

  int16_t raw[6] = {0};
  if (bmi160.getAccelGyroData(raw) != BMI160_OK) {
    return;
  }

  // Extract raw gyro (deg/s) - Index 0, 1, 2
  float gx = raw[0] / GYRO_SENSITIVITY_LSB_PER_DPS;
  float gy = raw[1] / GYRO_SENSITIVITY_LSB_PER_DPS;
  float gz = raw[2] / GYRO_SENSITIVITY_LSB_PER_DPS;

  // Extract raw accel (m/s^2) - Index 3, 4, 5
  float ax = (raw[3] / ACCEL_SENSITIVITY_LSB_PER_G) * G_TO_MS2;
  float ay = (raw[4] / ACCEL_SENSITIVITY_LSB_PER_G) * G_TO_MS2;
  float az = (raw[5] / ACCEL_SENSITIVITY_LSB_PER_G) * G_TO_MS2;

  // Calculate 3D Total & Dynamic Acceleration Vector Magnitude
  float totalAccel = sqrt(ax * ax + ay * ay + az * az);
  float dynamicAccel = fabs(totalAccel - baselineGravity);

  if (dynamicAccel > peakAccel) {
    peakAccel = dynamicAccel;
  }

  // --- STATE MACHINE WITH BUMP & FALSE REP REJECTION ---
  switch (currentPhase) {
    case IDLE:
      if (dynamicAccel > START_CONCENTRIC_THRESH) {
        currentPhase = CONCENTRIC;
        concentricStartTime = currentTime;
        totalRepStartTime = currentTime;
        phaseStartTime = currentTime;
        
        currentVelocity = 0.0f;
        peakVelocity = 0.0f;
        peakAccel = dynamicAccel;
        velocitySum = 0.0f;
        concentricSamples = 0;
        Serial.println("\n>>> Phase: [CONCENTRIC LIFT STARTED] <<<");
      }
      break;

    case CONCENTRIC:
      // Discrete numerical integration for linear velocity
      currentVelocity += dynamicAccel * dt;
      velocitySum += currentVelocity;
      concentricSamples++;

      if (currentVelocity > peakVelocity) {
        peakVelocity = currentVelocity;
      }

      // Check if concentric acceleration subsides
      if (dynamicAccel < STOP_CONCENTRIC_THRESH) {
        unsigned long concentricDuration = currentTime - concentricStartTime;

        // BUMP FILTER 1: Check minimum concentric duration
        if (concentricDuration >= MIN_CONCENTRIC_TIME_MS) {
          currentPhase = ECCENTRIC;
          phaseStartTime = currentTime;
          Serial.println("\n>>> Phase: [ECCENTRIC / LOWERING] <<<");
        } else {
          // Reject quick bump noise
          Serial.print("\n[BUMP REJECTED] Concentric duration too short: ");
          Serial.print(concentricDuration);
          Serial.println(" ms");

          currentVelocity = 0.0f;
          peakAccel = 0.0f;
          currentPhase = IDLE;
        }
      }
      break;

    case ECCENTRIC:
      // Motion returned to rest level
      if (dynamicAccel < REST_NOISE_THRESH && (currentTime - phaseStartTime > 200)) {
        unsigned long totalRepDuration = currentTime - totalRepStartTime;
        float meanVelocity = (concentricSamples > 0) ? (velocitySum / concentricSamples) : 0.0f;

        // BUMP FILTERS 2 & 3: Validate full rep duration and peak velocity
        if (totalRepDuration >= MIN_TOTAL_REP_TIME_MS && peakVelocity >= MIN_PEAK_VELOCITY) {
          repCount++;

          // Print Formatted Log
          Serial.println("\n==========================================");
          Serial.print(" REP #"); Serial.print(repCount); Serial.println(" LOGGED!");
          Serial.print(" - Duration      : "); Serial.print(totalRepDuration); Serial.println(" ms");
          Serial.print(" - Mean Velocity : "); Serial.print(meanVelocity, 2); Serial.println(" m/s");
          Serial.print(" - Peak Velocity : "); Serial.print(peakVelocity, 2); Serial.println(" m/s");
          Serial.print(" - Peak Accel    : "); Serial.print(peakAccel, 2); Serial.println(" m/s^2");
          Serial.println("==========================================\n");

        } else {
          Serial.print("\n[REP REJECTED] Total duration (");
          Serial.print(totalRepDuration);
          Serial.print("ms) or Peak Vel (");
          Serial.print(peakVelocity, 2);
          Serial.println("m/s) failed threshold.");
        }

        // Zero Velocity Update (ZUPT)
        currentVelocity = 0.0f;
        peakAccel = 0.0f;
        currentPhase = IDLE;
      }
      break;
  }

  // --- SERIAL STREAM FOR REAL-TIME PLOTTER (100 Hz CSV) ---
  Serial.print("ax:"); Serial.print(ax, 2); Serial.print(",");
  Serial.print("ay:"); Serial.print(ay, 2); Serial.print(",");
  Serial.print("az:"); Serial.print(az, 2); Serial.print(",");
  Serial.print("aTotal:"); Serial.print(totalAccel, 2); Serial.print(",");
  Serial.print("aDynamic:"); Serial.print(dynamicAccel, 2); Serial.print(",");
  Serial.print("Velocity:"); Serial.print(currentVelocity, 2); Serial.print(",");
  Serial.print("Phase:"); Serial.print((int)currentPhase); Serial.print(",");
  Serial.print("RepCount:"); Serial.println(repCount);

  notifyTelemetry(ax, ay, az, totalAccel, dynamicAccel, currentVelocity, CALIBRATION_IDLE);

  delay(10); // ~100Hz loop rate
}