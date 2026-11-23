# openGym integration — research notes and plan

Status: historical
Last reviewed: 2026-11-23
Purpose: first research notes on openGym (2026-11-22). Research input to [`OPENGYM_INTEGRATION_DESIGN.md`](OPENGYM_INTEGRATION_DESIGN.md), which is the later design and the one to follow; the phases P1-P4 below are superseded by the milestones P0-P6 there.

Research status as written on 2026-11-22: research done; implementation intentionally out of scope for the first workout-flow release.
Source: public repository <https://github.com/DuarteSantos8/openGym> (README, CLAUDE.md, NOTICE.md, CONTRIBUTING.md,
docs/MODULES.md, docs/API_TOKENS.md, docs/dev/SISTER_APPS.md read on 2026-11-22). Facts below may change; re-check before building.

## What openGym is

- Self-hostable gym tracker: React 19 + Vite frontend, Capacitor shells for Android/iPhone (+ Apple Watch, Wear OS, Garmin),
  a plain Node `api/` with an OpenAPI spec (`api/openapi.yaml`), optional MCP server. Phone-only mode (no server) exists.
- Library of ~5,600 exercises with animated demos, routines, guided sessions with a rest timer, PRs, estimated 1RM,
  plate math, imports from Strong / Hevy / FitNotes, CSV export, a performance report (PDF).
- A "Modules" switch for feature areas (Effort, Plates, Health, Watch, ...). Modules are parts of openGym itself, not
  third-party plugins ("Nothing outside the app can add code").
- Extension surfaces that exist today: scoped API tokens (`Authorization: Bearer ogt_...`, `GET/PUT /api/token/data`,
  category "Workouts" can be set to *Change directly*, writes need `baseRev`, 409 on conflict), signed webhooks,
  imports, MCP `log_workout`. Sister apps (openNutrition, openRunning) are read-only links initiated from openGym.
- No Bluetooth/sensor/bar-velocity feature was found in README/ROADMAP.

## Constraints that shape the plan

1. **License:** openGym code is AGPL-3.0-or-later. Copying openGym code into LiftIQ would force LiftIQ under AGPL-compatible
   terms. A pull request into openGym needs a signed CLA (they may relicense contributions). LiftIQ currently has no LICENSE file. (Update 2026-11-23: LiftIQ software and firmware have been AGPL-3.0-or-later since 2026-11-22, see `LICENSE` and `NOTICE.md`.)
2. **(Update 2026-11-22: LiftIQ's own exercise database is the open dataset hasaneyldrm/exercises-dataset, see docs/EXERCISE_DATA.md; openGym ids can still be mapped by name later.)** **Exercise media is NOT free to reuse:** the stills/animations are licensed to openGym by Gym visual, not covered by AGPL,
   no public API/CDN, must not be hotlinked or copied. So LiftIQ cannot show openGym's exercise previews. Exercise *text*
   is MIT / openGym-authored (check `catalogue/README.md` per entry) — ids and names can be mapped, media cannot.
3. **Phone-only openGym has no API reachable from a web page.** Token API needs a self-hosted server (CORS/HTTPS to be checked).
4. **Web Bluetooth is not available on iPhone.** openGym's Capacitor shells have no BLE plugin today; a deep integration (or a
   LiftIQ Capacitor wrapper) would need a native BLE plugin — that would also fix iPhone support.

## Phased plan

| Phase | What | Notes |
|---|---|---|
| P1 | Standalone LiftIQ workout flow in the dev app: exercise -> weight -> set -> review (reps, include/exclude setup pull) -> rest timer -> next set -> exercise report. Own small exercise list with an optional `opengymId` mapping field. Own simple pictograms instead of openGym media. | No openGym code or media copied. |
| P2 | Export to openGym through its **import path** (a Strong-compatible CSV: date, workout, exercise, set order, weight, reps, notes) — works for phone-only users and needs no openGym changes. Verify the exact column names/matching rules in openGym `docs/DATA_IMPORTS.md` first. | Exercise names must match openGym's library; use the optional `opengymId`/name mapping. |
| P3 | Optional push to a self-hosted openGym through a scoped token (`PUT /api/token/data`, Workouts = Change directly). Needs the workout/set schema (see `frontend/src/lib/workout-model.js`, `finish-workout.js`), `baseRev` handling, CORS. Extra per-set velocity fields only if openGym keeps/accepts unknown fields (unknown — test). | Self-hosted only. |
| P4 | Deep integration (a BLE "sensor module" inside openGym's app, possibly shown in its performance report). Requires agreement with the maintainer, a CLA, AGPL consequences for the contributed code, and a Capacitor BLE plugin. | Decide only after P1-P3 prove the value. Contact the maintainer early. |

Rule: until P4 is agreed, LiftIQ code must not copy openGym code or media; interfaces are files and HTTP only.
