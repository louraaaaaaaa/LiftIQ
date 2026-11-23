# Release 1.1.0 (prepared, go/no-go pending)

Status: current
Last reviewed: 2026-11-23
Purpose: what stable 1.1.0 contains, what changes for the user, known limits, the exact owner steps and the rollback. Nothing here has been run in the real `app/stable`: it is still 1.0.0.

## What 1.1.0 contains

`app/dev` (1.1.0-dev) promoted to `app/stable` by `node tools/release-app.mjs --version 1.1.0`: channel stable, no DEV badge, title "LiftIQ | Set tracker", manifest "LiftIQ Set Tracker", service-worker cache `liftiq-app-v12` (was `v11`), `VERSION` 1.1.0, no `window.__liftiq` handle. 57 files (1.64 MB, of which 852 kB is the lazily loaded exercise index, about 107 kB gzipped) instead of 17 files (120 kB). New: Train flow and exercise picker (1,324-exercise open dataset, MIT text), own machine photos, rest timer, summary, history with readable names, pulse-based rep analysis, 1.5 s ready check, vendored `@liftiq/sensor` package (`vendor/liftiq-sensor/`), Lab and debug panel behind Sensor > "Show developer tools" (off by default). The dev tests replace the old stable tests and also run in `app/stable/test`.

## What changes for the user

- Rep counting: the app analyses the acceleration pulses itself instead of showing the firmware's own count (which undercounted). The count can still be corrected on the review screen.
- The set starts after a 1.5 s "hold still" ready check instead of the 5 s calibration.
- Train flow: pick an exercise, set up, record, review (the setup pull can be excluded), rest timer, next set, summary.
- Saved sets get readable file names (no weight/reps in the name). Old sets stay under History > "Older sets" with their CSV download.
- Exercise pictures and animations are OFF by default (Gym visual licence clarification pending). Turn them on under Sensor > Training settings > "Online exercise previews". Build rule: `EXERCISE_MEDIA_ENABLED_DEFAULT` is false in stable and true in dev; the release tool rewrites it and refuses a build where it is still true.

## Known limitations

- The refactored BLE client and the pulse analysis have never run with the real sensor in the app (offline recordings and unit tests only). The first real use is the first on-device test of 1.1.0.
- iPhone is unsupported (no Web Bluetooth). Android Chrome only.
- Installed PWAs: the new service worker activates after the new page was fetched (second launch); `liftiq-app-v11` is deleted when `v12` activates (the media cache `liftiq-app-media-v1` is kept).
- The `test/` folder is published with the app (about 90 kB), harmless.
- IndexedDB goes from v1 to v4 (additive: new stores only, `sessions` is never touched). Stable 1.0.0 cannot open a v4 database, see rollback.

## Owner steps

1. Review the report of the trial release and this file.
2. In the real repo: `node tools/release-app.mjs --version 1.1.0` (runs the tests, builds `app/stable`, runs the stable tests, never commits).
3. `cd app && npm run test:all` (all green; needs `python -m pytest`).
4. Optional local look: `cd app && npm run start:stable` (http://localhost:8001).
5. Commit and push so `pages.yml` publishes `app/stable`. Suggested message: "Release app 1.1.0 (stable: pulse rep analysis, Train flow, ready check; dataset media off by default)". Include `app/stable`, `tools/`, `tests/`, `app/dev/test`, `docs/` and `CHANGELOG.md`.
6. First launch on the phone (Android Chrome, https://louraaaaaaaa.github.io/LiftIQ/): open it twice (the second launch runs the new service worker), check that the version is 1.1.0 with no DEV badge, that History > "Older sets" still lists the old sets and a CSV downloads, then connect the sensor and record one set. The cache should be `liftiq-app-v12`.

## Rollback

`git revert <release commit>` and `git push`. Pages republishes 1.0.0 (cache `liftiq-app-v11`). Phones that already loaded 1.1.0 may need the page refreshed twice to get the old service worker back. Because 1.1.0 upgrades the local database to v4 and 1.0.0 opens it as v1, a 1.0.0 app on such a phone cannot open its database: clear the site data or reinstall the PWA (this deletes the on-device history, so download the CSVs first). Prefer a fix-forward release (1.1.1) over a rollback once 1.1.0 has been used.
