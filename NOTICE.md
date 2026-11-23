# Notice: licences of LiftIQ and of third-party components

This file is informational and not legal advice. The full text of the GNU Affero General Public License v3 is in [`LICENSE`](LICENSE) (the unmodified text from https://www.gnu.org/licenses/agpl-3.0.txt).

## LiftIQ's own licence

| Part | Licence | Status |
|---|---|---|
| Software: phone app (`app/`), shared sensor package (`packages/liftiq-sensor/`), tools (`tools/`), tests | **AGPL-3.0-or-later** | Approved by the project owner on 2026-11-22 |
| Firmware (`firmware/`) | **AGPL-3.0-or-later** | Approved by the project owner on 2026-11-22 |
| Hardware design files and hardware documentation (`hardware/`: PCB, BOM, datasheet notes) | **Not decided yet** | Until decided, no licence is granted for the hardware files beyond what the law gives; do not assume AGPL applies to them |
| Documentation (`docs/`) and recordings (`data/`) | Not decided yet (follows the owner's decision for hardware/docs) | Third-party material inside them keeps its own licence (below) |

Source files of `packages/liftiq-sensor/` carry `SPDX-License-Identifier: AGPL-3.0-or-later`; other files are covered by this notice and the root `LICENSE`. The package is vendored into other projects (see `packages/liftiq-sensor/README.md`); a project that includes it and is used over a network must offer the corresponding source under the AGPL.

## Third-party components

| Component | Where | Licence | Notes |
|---|---|---|---|
| Exercise dataset text/data: `hasaneyldrm/exercises-dataset` (names, muscles, equipment, instructions) | `app/dev/assets/exercise-db/` (generated compact index + `LICENSE-exercises-dataset.txt`), `tools/exercise-db/` | MIT (c) 2026 Hasan Emir Yildirim | Pinned commit and details: `docs/EXERCISE_DATA.md` |
| Exercise images and GIFs, (c) Gym visual | **Not stored in this repository.** Loaded at runtime from the dataset's public URLs, with attribution, and can be switched off (`EXERCISE_MEDIA_ENABLED_DEFAULT` in `app/dev/exercise-media.js`) | (c) Gym visual, all rights reserved; the dataset's repository grants no licence to the media | Clarification from Gym visual / the dataset author is pending (`docs/EXERCISE_DATA.md`). Not covered by the MIT licence of the dataset text |
| Machine example photos | `app/dev/assets/machines/` | Wikimedia Commons files: CC0 1.0 (lat pulldown), CC BY-SA 4.0 (leg extension, pec deck), CC BY 2.0 (cable station) | Authors, sources, modifications: `docs/IMAGE_CREDITS.md` and `credits.json`; shown in the app under Sensor > Credits. CC BY-SA applies to the adapted image files only |
| "Tiny Open Logger, TOL: An Open-Source Xiao ESP32 Based IMU" (paper, UbiComp 2025) | `docs/references/` | CC BY 4.0 (https://creativecommons.org/licenses/by/4.0, stated in the PDF) | Kept as a reference; not modified |
| DFRobot_BMI160 Arduino library (v1.0.0) | Used by `firmware/LiftIQ_BLE` (not stored in this repository; installed with the Arduino IDE/CLI) | MIT, (c) 2010 DFRobot Co.Ltd (its `LICENSE` file and the `@license` line in `DFRobot_BMI160.h/.cpp`, read from the installed library) | https://github.com/DFRobot/DFRobot_BMI160 |
| Arduino-ESP32 core 3.3.12 (`Wire`, `BLEDevice`/BLE, ESP-IDF headers) | Toolchain dependency of the firmware, not stored here | LGPL-2.1-or-later (the `license` field of the core's `package.json`); individual core libraries and ESP-IDF components carry their own licences | Not re-verified per file |
| BMI160 datasheet | `hardware/datasheets/` | Bosch Sensortec's own terms (not an open licence) | Kept as a reference only |

The mobile app has no npm/runtime dependencies (plain ES modules). Development tooling (Node.js, Python packages in `tools/requirements.txt`) is not redistributed.

## Not yet reviewed

- Licence of the hardware design and documentation (open decision, see above).
- Per-file licence headers (only the sensor package carries SPDX lines so far).
- Whether the Gym visual media may be shown at all (pending clarification).
