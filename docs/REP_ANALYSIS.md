# Rep / pulse analysis (W1)

Status: current
Last reviewed: 2026-11-23
Purpose: specification of the pulse/rep analysis (offline and causal live counter). The code now lives in `packages/liftiq-sensor/src/analysis/` and is reused by every app; the dev app only keeps re-export shims.

Code (source of truth): `packages/liftiq-sensor/src/analysis/pulses.js` (offline, `analyzeSet`) and `packages/liftiq-sensor/src/analysis/live-counter.js` (causal, `createLiveCounter`); `app/dev/analysis/*.js` are re-export shims over the vendored copy. Pure ES modules, no DOM/BLE/dependencies. Tests: `packages/liftiq-sensor/test/pulses.test.js` (replays `tests/fixtures/seated-row-2026-11-22`). Python reference: `tools/livesets/analyze_live_sets.py`.

Scope: sensor magnet-mounted on the moving plate of a cable-stack machine (seated row first). One rep = ONE fast up-pull of the plate (peak 0.5-1.0 m/s, 0.5-0.8 s, 30-37 cm) followed by a slow controlled descent (about -0.3 m/s, 2 s), touch-and-go, period 2.3-3.5 s. The first pull of a set is a longer "setup pull" (43-54 cm, 0.8-1.4 s).

## Signal model

1. Samples `{t, ax, ay, az}` in m/s^2 (the app's `elapsed_s`/`ax_m_s2`/... are accepted too). Non-finite samples are skipped, non-monotonic timestamps dropped (warning).
2. Gravity reference `g`: mean accel vector of the stillest 1 s window (lowest variance of |a|) among the first 5 s, or `options.gravity`. Mean (not per-axis median) so the estimate rotates with the sensor.
3. `a_vert = a . (g/|g|) - |g|`: positive = up, independent of mounting orientation.
4. Clip to +-12 m/s^2 (handling shocks reach 30-38 m/s^2).
5. Leaky integral `v[i] = v[i-1] (1 - dt/tau) + a_vert[i] dt` with the real per-sample dt; dt is limited to 0.1 s (a longer gap counts as 0.1 s and raises a warning).
6. Pulse = local maximum of `v` above `peakMin`, maxima closer than `refractory` merged (the larger wins). Edges are where `v` crosses `edge` (0.1 m/s) before/after the maximum. Per pulse: `t`, `vPeak`, `upstrokeCm` (integral of v between the edges; ESTIMATE), `upstrokeS`, `riseS`, `timeToNextS`.

## Parameters

| name | default | why |
|---|---|---|
| tau | 4 s | leak that bounds integration drift without distorting a 0.6 s pull; no zero-velocity resets exist |
| peakMin | 0.45 m/s | below the weakest real rep (0.46) and well above descent velocity (-0.3) and noise |
| refractory | 1.0 s | reps are 2.3 s apart or more; merges ripples inside one pull |
| clip | 12 m/s^2 | real pulls reach ~4-6 m/s^2; shocks are 30+ |
| edge | 0.1 m/s | start/end of the up-stroke |
| minWidthS / minRiseS | 0.25 s / 0.15 s | handling rejection (below) |
| maxClipFraction | 0.25 | handling rejection (below) |
| setupDurRatio / setupDispRatio | 1.4 / 1.25 | setup-pull heuristic (below) |
| includeSetupPull | `'auto'` | `true`: count it; `false`/`'auto'`: exclude when flagged |

## Handling-noise rejection

A candidate pulse is dropped (listed in `result.rejected`, warning added) when its up-stroke is shorter than `minWidthS`, when it rises from the 0.1 m/s edge to its peak in under `minRiseS` (an impulse: a shock integrates to a step in `v` within 1-3 samples, whereas a real pull builds up over 0.3-0.5 s), or when more than `maxClipFraction` of its samples are at the clip level. On the five real files none of these rules fired (the clip plus the leaky integral already keep the shocks below `peakMin` or merged away); they are covered by a synthetic test (3-sample 38 m/s^2 shock). Real rep rise times are about 0.3 s, so the margin is 2x. These thresholds are therefore a safety net, not tuned to data.

## Setup-pull heuristic

Only with >= 3 pulses: pulse 1 is flagged `setup:true` when its `upstrokeS` > 1.4 x median of the other pulses, or its `upstrokeCm` > 1.25 x that median. With `includeSetupPull:'auto'` (default) the flagged pulse is excluded from `reps` and returned as `setupPull`; the app lets the user override with `true`.

## Outputs

`{reps, setupPull, repCount, totalPulses, metrics, series:{t,aVert,v}, warnings, gravity, rejected}`. Metrics (over `reps`): `meanPeakVelocity`, `velocityLossPct` (mean vPeak of first two vs last two reps, >= 4 reps), `meanUpstrokeCm`, `meanRepPeriodS`, `repPeriodTrend` (least-squares slope of the period in s per rep, >= 3 periods).

## Live counter

`createLiveCounter(opts).push(sample) -> {count, ready, newRep?}`. No look-ahead. `ready:false` until gravity is established: first still 1 s window (std of |a| below 0.35 m/s^2; falls back after 5 s). Buffered start samples are then replayed causally. A candidate is the running maximum of `v` above `peakMin`; it is confirmed when `v` falls to 70 % of the candidate peak (about 0.2-0.3 s after the maximum, so latency is well below 1 s). The same refractory rule (keep the larger, count unchanged) and the minimum-rise impulse rule apply. After a resolved candidate the counter re-arms only when `v` falls below `peakMin` or rises anew by 0.1 m/s, so the slow tail of a rejected shock cannot create a phantom rep. The live counter counts every pulse including the setup pull (the app decides after the set from the offline analysis). `newRep` = `{t, vPeak, tStart, confirmedAt, latencyS}`.

## Known limits

- Velocity and length are those of the weight STACK/plate, not of the handle (pulley ratios differ per machine); lengths are uncalibrated estimates.
- Vertical-only motion assumed (cable stacks). Machines/exercises with rotating or horizontal sensor motion are out of scope.
- 50 Hz live stream (BLE): short peaks are smoothed; BLE drops show up as gaps (handled by the dt guard, not interpolated).
- Without zero-velocity resets, velocity is a leaky estimate: a gravity-reference error of 0.01 m/s^2 shifts `v` by up to ~0.04 m/s (bias x tau). Gravity must come from a still start.
- A slow rep with peak velocity below 0.45 m/s is not counted.

## Acceptance results (5 real seated-row sets)

| set | offline reps (setup excl.) | golden | total pulses | setup flagged | live count | max live latency after offline peak |
|---|---|---|---|---|---|---|
| 29c819f1 | 8 | 8 | 9 | yes | 9 | 0.26 s |
| 594989b0 | 8 | 8 | 9 | yes | 9 | 0.26 s |
| 86ae3b5f | 7 | 7 | 8 | yes | 8 | 0.20 s |
| 86c1eceb | 5 | 5 | 6 | yes | 6 | 0.32 s |
| d0656b91 | 9 | 9 | 10 | yes | 10 | 0.18 s |

Orientation invariance (arbitrary fixed rotation): same counts, vPeak within 1 %.

Agreement with the Python prototype (`pulses.csv`): pulse times identical (within 0.02 s), `vPeak` within 3 % (or 0.035 m/s) and `upstrokeCm` within 3 cm, setup flags identical. The JS values are slightly higher (about +0.01 to +0.03 m/s, up to +3 cm on the weakest rep), an intended consequence of (a) projecting onto the measured gravity direction and subtracting |g| (10.16 m/s^2 here, the sensor is not exactly 1 g-scaled) instead of subtracting the median of az, and (b) using the real dt. Because the integral has no zero-velocity reset, tiny reference differences appear directly as velocity offset (see limits). The Python prototype's rounding (2 decimals / integer cm) adds up to 0.005 m/s / 0.5 cm.
