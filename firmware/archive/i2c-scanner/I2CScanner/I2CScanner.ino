// I2C Scanner — standalone bus sweep for LiftIQ bring-up.
//
// Sweeps all 7-bit I2C addresses and reports which ones ACK, once on boot
// and then every 5s. Use this on its own (no BMI160/SSD1306 libraries
// needed) to pin down the GY-BMI160's actual address before touching
// LiftIQ.ino — GY-BMI160 boards vary on whether SAO/SDO defaults to
// GND (0x68) or VCC (0x69).
//
// Board: Tools > Board > esp32 > "XIAO_ESP32S3"

#include <Wire.h>

const int PIN_SDA = 5;  // XIAO ESP32-S3 D4
const int PIN_SCL = 6;  // XIAO ESP32-S3 D5

const char* knownDevice(uint8_t addr) {
  switch (addr) {
    case 0x68: return "BMI160 (SAO/SDO -> GND)";
    case 0x69: return "BMI160 (SAO/SDO -> VDDIO)";
    case 0x3C: return "SSD1306 OLED (typical)";
    case 0x3D: return "SSD1306 OLED (alt)";
    default:   return "";
  }
}

void scanOnce() {
  Serial.println("Scanning I2C bus...");
  int found = 0;
  for (uint8_t addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    uint8_t error = Wire.endTransmission();
    if (error == 0) {
      found++;
      Serial.print("  0x");
      if (addr < 16) Serial.print('0');
      Serial.print(addr, HEX);
      const char* name = knownDevice(addr);
      if (name[0] != '\0') {
        Serial.print("  <- ");
        Serial.print(name);
      }
      Serial.println();
    } else if (error == 4) {
      Serial.print("  0x");
      Serial.print(addr, HEX);
      Serial.println("  unknown error");
    }
  }
  if (found == 0) {
    Serial.println("  no devices found — check wiring/power");
  } else {
    Serial.print(found);
    Serial.println(" device(s) found");
  }
  Serial.println();
}

void setup() {
  Serial.begin(115200);
  while (!Serial) {
    delay(10);
  }
  Wire.begin(PIN_SDA, PIN_SCL);
  scanOnce();
}

void loop() {
  delay(5000);
  scanOnce();
}
