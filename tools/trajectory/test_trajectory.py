"""Tests for the trajectory toolkit (synthetic data, fixed seeds).

Run:  python -m unittest test_trajectory -v      (from tools/trajectory)
  or: python -m unittest discover -s tools/trajectory -p "test_*.py"
"""
import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fusion  # noqa: E402
import metrics  # noqa: E402
import pipeline  # noqa: E402
import rawio  # noqa: E402
import synth  # noqa: E402
import zupt  # noqa: E402
from pipeline import PipelineConfig  # noqa: E402

IDEAL = synth.ErrorModel("ideal", 0.0, 0.0, 0.0, 0.0, 0.0, accel_offset_mg=0.0, scale_err=0.0, delta_t_k=0.0)
SCN = synth.Scenario(kind="vertical", rom_m=0.40, n_reps=4, lateral_arc_m=0.02, tilt_deg=5.0)


def rom_errors(cap, truth, cfg):
    res = pipeline.reconstruct(cap, cfg)
    rows = synth.match_reps(res, truth)
    return res, rows, np.array([r["rom_err_cm"] for r in rows if r["found"]])


class RawIoTests(unittest.TestCase):
    def test_round_trip_and_tolerance(self):
        cap, _ = synth.simulate(replace(SCN, n_reps=1), synth.BMI160_LIKE, 200.0, seed=3)
        cap.meta["notes"] = "table: left corner; ok"
        cap.meta["future_key"] = "ignored"
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "x.csv"
            rawio.save_raw(p, cap)
            back = rawio.load_raw(p)
        self.assertEqual(len(back), len(cap))
        np.testing.assert_allclose(back.t, cap.t, atol=1e-6)
        np.testing.assert_allclose(back.acc, cap.acc, atol=1e-4)
        np.testing.assert_allclose(back.gyro, cap.gyro, atol=1e-3)
        self.assertEqual(back.meta["notes"], "table: left corner; ok")
        self.assertAlmostEqual(back.known_rom_cm, 40.0)
        np.testing.assert_allclose(back.gyro_bias_dps, cap.gyro_bias_dps, atol=1e-4)
        self.assertEqual(back.fs, 200.0)

    def test_missing_optional_keys_and_validation(self):
        txt = "# format: liftiq-raw v1\n# bogus line\nt_s,ax,ay,az,gx,gy,gz\n" + "".join(
            f"{i / 200:.4f},0,0,9.8,0,0,0\n" for i in range(100)) + "0.9,0,0,9.8,0,0,0\n"
        cap = rawio.parse_raw_csv(txt)
        self.assertIsNone(cap.known_rom_cm)
        self.assertIsNone(cap.gyro_bias_dps)
        rep = rawio.validate(cap)
        self.assertEqual(rep["n_gaps"], 1)
        self.assertTrue(any("gyro_bias" in w for w in rep["warnings"]))
        u = rawio.resample_uniform(cap)
        self.assertTrue(np.allclose(np.diff(u.t), 1 / 200, atol=1e-9))


class FusionTests(unittest.TestCase):
    def test_recovers_known_rotation(self):
        """90 deg about the sensor x axis and back, ideal sensor: up-vector error stays small."""
        scn = synth.Scenario(kind="rotation", rotation_deg=90.0, n_reps=1, rotation_axis=(1.0, 0.0, 0.0))
        cap, tr = synth.simulate(scn, IDEAL, 200.0, seed=0)
        q0 = fusion.q_init_from_gravity(cap.acc[:200].mean(axis=0))
        q = fusion.mahony(cap.acc, np.radians(cap.gyro), 200.0, q0, kp=1.0, g_ref=fusion.G0)
        up_est = fusion.q_rotate(fusion.q_conj(q), [0, 0, 1])
        up_true = fusion.q_rotate(fusion.q_conj(tr["q"]), [0, 0, 1])
        err = np.degrees(np.arccos(np.clip((up_est * up_true).sum(1), -1, 1)))
        self.assertLess(err.max(), 1.0)
        # peak rotation really reached ~90 deg relative to start
        rel = fusion.q_angle_between_deg(q[0], q[np.argmax(fusion.q_angle_between_deg(q[0], q))])
        self.assertAlmostEqual(rel, 90.0, delta=1.5)

    def test_gating_ignores_accelerations(self):
        """With a strong vertical bump the gravity update is gated off and tilt stays put."""
        n, fs = 600, 200.0
        acc = np.tile([0.0, 0.0, fusion.G0], (n, 1))
        acc[100:200, 0] = 5.0
        q = fusion.mahony(acc, np.zeros((n, 3)), fs, [1.0, 0, 0, 0], kp=5.0, g_ref=fusion.G0, gate_tol=0.5)
        tilt = np.degrees(np.arccos(np.clip(fusion.q_rotate(q, [0, 0, 1])[:, 2], -1, 1)))
        self.assertLess(tilt.max(), 1e-6)  # |a| = 11 m/s^2 -> rejected, no tilt change
        # whereas a static tilted reading (|a| = g) IS trusted and converges
        # sensor tilted 10 deg: reading is R^T z * g
        reading = fusion.q_rotate(fusion.q_conj(fusion.q_from_axis_angle([0, 1, 0], np.radians(10))), [0, 0, fusion.G0])
        q = fusion.mahony(np.tile(reading, (n, 1)), np.zeros((n, 3)), fs, [1.0, 0, 0, 0], kp=5.0, g_ref=fusion.G0)
        up = fusion.q_rotate(fusion.q_conj(q[-1]), [0, 0, 1]) * fusion.G0
        np.testing.assert_allclose(up, reading, atol=0.05)

    def test_quaternion_utils(self):
        q = fusion.q_from_axis_angle([0, 0, 1], np.pi / 2)
        np.testing.assert_allclose(fusion.q_rotate(q, [1, 0, 0]), [0, 1, 0], atol=1e-12)
        qa = fusion.q_from_vectors([1, 0, 0], [0, 0, 1])
        np.testing.assert_allclose(fusion.q_rotate(qa, [1, 0, 0]), [0, 0, 1], atol=1e-12)


class ZuptTests(unittest.TestCase):
    def _profile(self, bias=0.05):
        fs = 200.0
        t = np.arange(0, 6, 1 / fs)
        tau = np.clip((t - 2.0) / 1.5, 0, 1)
        a = (60 * tau - 180 * tau ** 2 + 120 * tau ** 3) / 1.5 ** 2 * 0.4
        a[(t < 2.0) | (t > 3.5)] = 0.0
        lin = np.zeros((len(t), 3))
        lin[:, 2] = a + bias
        stat = (t < 1.95) | (t > 3.55)
        return fs, t, lin, stat

    def test_zupt_removes_drift(self):
        fs, t, lin, stat = self._profile()
        v0, p0, _ = zupt.integrate(lin, stat, fs, "none")
        vl, pl, _ = zupt.integrate(lin, stat, fs, "linear")
        vr, pr, _ = zupt.integrate(lin, stat, fs, "rts")
        end = len(t) - 1
        self.assertGreater(abs(v0[end, 2]), 0.2)     # drifted: 0.05 m/s^2 * 6 s = 0.3 m/s
        self.assertLess(abs(vl[end, 2]), 1e-9)
        self.assertLess(abs(vr[end, 2]), 0.01)
        self.assertLess(abs(pl[end, 2] - 0.4), 0.02)  # true displacement 0.4 m
        self.assertLess(abs(pr[end, 2] - 0.4), 0.02)
        self.assertGreater(abs(p0[end, 2] - 0.4), 0.5)

    def test_detects_pauses(self):
        cap, tr = synth.simulate(SCN, synth.BMI160_LIKE, 200.0, seed=0)
        res = pipeline.reconstruct(cap, PipelineConfig())
        units = zupt.moving_units(res.stat)
        self.assertEqual(len(units), 8)  # 4 reps x (up, down)
        self.assertEqual(len(res.reps), 4)


class PipelineTests(unittest.TestCase):
    def test_clean_rep_rom_within_tolerance(self):
        cap, tr = synth.simulate(SCN, IDEAL, 200.0, seed=0)
        _, rows, e = rom_errors(cap, tr, PipelineConfig())
        self.assertEqual(len(e), 4)
        self.assertLess(np.abs(e).max(), 0.5, f"ideal sensor ROM errors cm: {e}")

    def test_bmi160_like_rom_within_tolerance(self):
        errs = []
        for seed in range(3):
            cap, tr = synth.simulate(SCN, synth.BMI160_LIKE, 200.0, seed=seed)
            _, rows, e = rom_errors(cap, tr, PipelineConfig())
            self.assertEqual(len(e), 4, f"seed {seed}: reps missed")
            errs.extend(e)
        print(f"\n  BMI160-like 40 cm ROM error over {len(errs)} reps: mean|e|={np.mean(np.abs(errs)):.2f} cm, "
              f"max|e|={np.max(np.abs(errs)):.2f} cm")
        self.assertLess(np.max(np.abs(errs)), 1.0)

    def test_ablation_ordering_on_drifted_data(self):
        model = replace(synth.BMI160_LIKE, gyro_bias_residual_dps=3.0, accel_bias_residual_mg=20.0)
        errs = {"none": [], "reset": [], "linear": [], "rts": []}
        for seed in range(3):
            cap, tr = synth.simulate(SCN, model, 200.0, seed=seed)
            for mode in errs:
                cfg = PipelineConfig(zupt_mode=mode, loop_closure=False)
                _, rows, e = rom_errors(cap, tr, cfg)
                errs[mode].append(np.abs(e).mean() if len(e) else np.inf)
        m = {k: float(np.mean(v)) for k, v in errs.items()}
        print(f"\n  mean|ROM err| cm on drifted data: {m}")
        self.assertLess(m["linear"], m["none"])
        self.assertLessEqual(m["linear"], m["reset"] + 1e-9)
        self.assertLess(m["rts"], m["none"])
        self.assertLess(m["reset"], m["none"])

    def test_loop_closure_not_worse(self):
        cap, tr = synth.simulate(SCN, synth.BMI160_LIKE, 200.0, seed=1)
        _, _, e0 = rom_errors(cap, tr, PipelineConfig(loop_closure=False))
        _, _, e1 = rom_errors(cap, tr, PipelineConfig(loop_closure=True))
        self.assertLessEqual(np.abs(e1).mean(), np.abs(e0).mean() + 0.1)

    def test_metrics_compare_known(self):
        cap, tr = synth.simulate(SCN, synth.BMI160_LIKE, 200.0, seed=2)
        res = pipeline.reconstruct(cap, PipelineConfig())
        rows = metrics.all_rep_metrics(res.reps)
        summ = metrics.compare_known(rows, cap.known_rom_cm)
        self.assertEqual(summ["n"], 4)
        self.assertLess(summ["max_abs_err_cm"], 1.0)
        self.assertGreater(rows[0]["peak_con_vel"], rows[0]["mean_con_vel"])
        self.assertIn("err_cm", metrics.format_table(rows))

    def test_table_square_closes(self):
        scn = synth.Scenario(kind="table_square", n_reps=3)
        cap, tr = synth.simulate(scn, synth.BMI160_LIKE, 200.0, seed=0)
        res = pipeline.reconstruct(cap, PipelineConfig(units_per_rep=4, min_rom_m=0.0))
        rows = metrics.all_rep_metrics(res.reps)
        self.assertEqual(len(rows), 3)
        for r in rows:
            self.assertAlmostEqual(r["path_cm"], 120.0, delta=8.0)


class ArchitectAdditionsTests(unittest.TestCase):
    def test_auto_thresholds_fix_slow_reps(self):
        scn = replace(SCN, t_up_s=4.0, t_down_s=4.0)
        cap, tr = synth.simulate(scn, synth.BMI160_LIKE, 200.0, seed=1000)
        old = PipelineConfig(auto_thresholds=False, stationary=zupt.StationaryParams(robust=False))
        _, _, e_def = rom_errors(cap, tr, old)           # fixed legacy thresholds, std statistics
        _, _, e_auto = rom_errors(cap, tr, PipelineConfig())   # default: robust stats + quiet-window thresholds
        self.assertEqual(len(e_auto), 4)
        self.assertLess(np.abs(e_auto).max(), 4.0)  # worst rep of this seed is 3.3 cm (mean over seeds 0.67)
        self.assertTrue(len(e_def) < 4 or np.abs(e_def).max() > 5.0)  # default thresholds fail here

    def test_start_phase_parsing_and_down_first_rep(self):
        import analyze_raw
        cap, _ = synth.simulate(SCN, IDEAL, 200.0, seed=0)
        cap.meta["notes"] = "start=down squat"
        self.assertEqual(analyze_raw.parse_start_phase(cap, "up"), "down")
        cap.meta["notes"] = "whatever"
        self.assertEqual(analyze_raw.parse_start_phase(cap, None), "up")
        t = np.linspace(0, 4, 400)
        z = 0.4 * (0.5 + 0.5 * np.cos(np.pi * t / 2))      # top -> bottom -> top
        p = np.column_stack([0 * z, 0 * z, z])
        v = np.gradient(p, t, axis=0)
        rep = zupt.Rep(0, 399, t, p, v, np.ones(400, bool), np.zeros(3))
        row = metrics.rep_metrics(rep, 1, "up", "down")
        self.assertGreater(row["mean_con_vel"], 0.1)
        self.assertAlmostEqual(row["rom_cm"], 40.0, delta=0.1)

    def test_warns_when_start_not_still(self):
        cap, _ = synth.simulate(replace(SCN, lead_rest_s=0.0), IDEAL, 200.0, seed=0)
        res = pipeline.reconstruct(cap, PipelineConfig())
        self.assertTrue(any("first 1 s" in n for n in res.notes))


class RealDataTests(unittest.TestCase):
    """Excerpt (t <= 6 s) of the first real capture: hand rotation test about x, no ground truth.
    Thresholds/behaviour were tuned on this single hand-held file; these are smoke/regression checks."""

    def setUp(self):
        self.cap = rawio.load_raw(Path(__file__).resolve().parent / "testdata" / "real_rotation_excerpt.csv")

    def test_rest_found_and_rotation_returns(self):
        res = pipeline.reconstruct(self.cap, PipelineConfig())
        self.assertGreater(res.n_spikes, 0)                       # real file has single-sample spikes
        self.assertIsNotNone(res.rest)                            # initial rest found although < 1 s and late
        self.assertGreaterEqual((res.rest.stop - res.rest.start) / res.fs, 0.25)
        self.assertTrue(0.5 < res.rest.start / res.fs < 1.6)
        roll = fusion.q_to_euler_deg(res.q)[:, 0]
        self.assertLess(roll.min(), -80.0)                        # the ~100 deg rotation is seen
        i1, i2 = int(1.0 * res.fs), int(4.0 * res.fs)             # before the rotation / at the rest after it
        self.assertLess(abs(roll[i2] - roll[i1]), 4.0)            # returns near the start (accel tilt differs by 1.5 deg)

    def test_despike_removes_spike_only(self):
        x = np.sin(np.linspace(0, 6, 400))[:, None] * np.ones((1, 3))
        y = x.copy()
        y[200, 1] += 3.0
        out, n = zupt.hampel(y, 7, 5.0, 1.0)
        self.assertEqual(n, 1)
        np.testing.assert_allclose(out[:, 0], x[:, 0])
        self.assertLess(abs(out[200, 1] - x[200, 1]), 0.05)


class AccelCalTests(unittest.TestCase):
    def test_six_position_calibration(self):
        import calibrate_accel
        g, off, sc = 9.80665, np.array([0.3, -0.2, 0.25]), np.array([1.02, 0.99, 1.015])
        means = []
        for i in range(3):
            for sgn in (1, -1):
                v = np.zeros(3)
                v[i] = sgn * g
                means.append(sc * v + off)
        cal = calibrate_accel.calibrate_from_means(means)
        np.testing.assert_allclose(cal["offset"], off, atol=1e-9)
        np.testing.assert_allclose(cal["scale"], sc, atol=1e-9)
        self.assertLess(cal["max_norm_residual_ms2"], 1e-9)
        with self.assertRaises(ValueError):
            calibrate_accel.calibrate_from_means(means[:5])


if __name__ == "__main__":
    unittest.main()
