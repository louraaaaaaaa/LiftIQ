# Bill of Materials

| Part | Description | Notes |
|---|---|---|
| Seeed 113991114 | XIAO ESP32-S3, Wi-Fi + BT | MCU, small footprint |
| GY-BMI160 | 6-DOF accel + gyro breakout | I2C, confirmed at address 0x68 (SAO/SDO -> GND) |
| SSD1306 0.91" 128x32 | OLED display | I2C, shares bus with IMU |
| Battery | TBD | single-cell LiPo, capacity/connector TBD |
| Button | TBD | set start/stop |
| LED | TBD | status indicator |

## Wiring / pinout

| Signal | XIAO ESP32-S3 pin | GPIO |
|---|---|---|
| I2C SDA | D4 | GPIO5 |
| I2C SCL | D5 | GPIO6 |

Shared I2C bus for BMI160 + SSD1306 (different addresses, no conflict
expected — SSD1306 is typically 0x3C/0x3D). BMI160 confirmed at 0x68 via
the boot-time I2C scan (SAO/SDO strapped to GND on this board).

Firmware library: `DFRobot_BMI160` (Arduino Library Manager) — the
`hanyazou/BMI160-Arduino` library originally planned isn't in Library
Manager and wasn't pursued further once DFRobot's was confirmed working.
Note DFRobot_BMI160 hardcodes accel/gyro range to +/-2g / +/-2000dps
internally with no public setter to change it.

### GY-BMI160 breakout pins (all 12), per the Bosch datasheet's pin-out
table and I2C reference schematic (Figures 31/33, pages 101-102)

| Breakout pin | Chip pin | Required state |
|---|---|---|
| `SCL` | SCx | XIAO SCL (D5/GPIO6) |
| `SDA` | SDx | XIAO SDA (D4/GPIO5) |
| `GND` | GND/GNDIO | GND |
| `VIN` / `3V3` | VDD/VDDIO | 3.3V |
| `CS` | CSB | **tie to 3.3V** — selects I2C mode; floating is undefined behavior, not "don't care" |
| `SAO` | SDO | **tie to GND (0x68) or 3.3V (0x69)** — floating gives an unreliable address |
| `INT1`, `INT2` | INT1, INT2 | leave floating — datasheet: "if not used, DNC" |
| `SCX`, `SDX` | ASCx, ASDx (secondary/aux magnetometer interface, confusingly named) | leave floating — unused without an external magnetometer |
| `OCS` | OCSB (secondary OIS interface) | leave floating — unused |

Datasheet confirms `ASDX`/`ASCX`/`OCSB`/`OSDO` go high-impedance when
unused, so floating is the documented state, not a guess. CS and SAO are
the two pins worth double-checking with a multimeter if the boot-time I2C
scan doesn't find the device — some clone boards strap them onboard,
others leave them genuinely floating.

Button/LED GPIO assignment: TBD.

## Open questions

- Battery cell size/connector and charge circuit (XIAO ESP32-S3 has onboard
  battery charging via JST if using the matching connector — confirm).
- Magnet mounting: strength/size needed to hold on a steel weight-stack
  plate without slipping mid-rep.
- Enclosure: 3D-printed vs off-the-shelf project box.
