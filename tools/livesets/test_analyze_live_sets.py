"""Tests for analyze_live_sets.py: old app-session CSVs and the liftiq-set v1 per-set format."""
import csv
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import analyze_live_sets as als  # noqa: E402

DATA = os.path.join(HERE, "..", "..", "tests", "fixtures", "seated-row-2026-11-22")
OLD = os.path.join(DATA, "liftiq-2026-11-20-29c819f1.csv")


def write_set_v1(path, rows):
    """Write rows in the app's per-set format: '# key: value' lines + extra vertical columns."""
    columns = list(rows[0].keys()) + ["vert_accel_m_s2", "vert_velocity_m_s"]
    with open(path, "w", newline="") as handle:
        handle.write("# format: liftiq-set v1\r\n# exercise: Seated cable row\r\n# weight_kg: \r\n# reps_confirmed: 8\r\n")
        writer = csv.DictWriter(handle, fieldnames=columns, lineterminator="\r\n")
        writer.writeheader()
        for row in rows:
            writer.writerow({**row, "vert_accel_m_s2": "0.1", "vert_velocity_m_s": "0.0"})


def test_old_format_still_loads_and_counts():
    d = als.load(OLD)
    r = als.analyse(d)
    assert len(r["pulses"]) == 9
    assert len(als.reps_only(r["pulses"])) == 8


def test_set_v1_comment_header_and_extra_columns(tmp_path):
    with open(OLD, newline="") as handle:
        rows = list(csv.DictReader(handle))
    for row in rows:
        row["actual_rep_count"] = "8"
    path = tmp_path / "liftiq_2026-11-22_seated-cable-row_set1.csv"
    write_set_v1(path, rows)
    d = als.load(str(path))
    assert d["entered"] == 8
    assert len(d["t"]) == len(rows)
    r = als.analyse(d)
    assert len(r["pulses"]) == 9
    assert len(als.reps_only(r["pulses"])) == 8
    old = als.analyse(als.load(OLD))
    assert [round(p["vpeak"], 6) for p in r["pulses"]] == [round(p["vpeak"], 6) for p in old["pulses"]]
