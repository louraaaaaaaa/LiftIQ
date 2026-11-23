# Test fixtures

`seated-row-2026-11-22/` holds the five golden seated-cable-row recordings (byte-identical copies of the app CSV exports) and `golden.json` (user-confirmed rep counts with and without the setup pull, setup-pull flags, and the Python prototype's per-pulse values). The pulse-analysis, workout and `tools/livesets` tests read only from here, never from `data/recordings/`, so the working data folder can change freely.

Treat these files as immutable: do not edit or rename them. To add a fixture, create a new folder `tests/fixtures/<name>/` with the CSVs and a `golden.json` of the same shape (`sets[]` with `label`, `file`, counts, flags and `prototype_pulses`), and point the new test at it.
