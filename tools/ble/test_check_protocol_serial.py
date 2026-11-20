import tempfile
import unittest
from pathlib import Path

import check_protocol_serial as check


def board_output(golden, corrupt=None, drop=None, done=True):
    lines = ["boot noise", "[BLE] something"]
    for vector in golden["telemetryV1"]:
        if vector["name"] == drop:
            continue
        hex_text = check.normalize_hex(vector["hex"])
        if vector["name"] == corrupt:
            hex_text = hex_text[:-2] + "ff"
        lines.append(f"[PROTO] {vector['name']} {hex_text}")
    info = next(v for v in golden["infoV1"] if v["name"] == "info_current_firmware")
    lines.append("[PROTO] INFO " + check.normalize_hex(info["hex"]))
    if done:
        lines.append("[PROTO] done")
    return lines


class CheckProtocolSerialTests(unittest.TestCase):
    def setUp(self):
        self.golden = check.load_golden()

    def test_golden_file_loads_and_has_all_kinds(self):
        names = {v["name"] for v in self.golden["telemetryV1"]}
        self.assertIn("calibrating_status1", names)
        self.assertIn("seq_wrapped_0", names)

    def test_perfect_board_output_matches(self):
        found, done = check.parse_serial_lines(board_output(self.golden))
        self.assertTrue(done)
        self.assertEqual(check.compare(found, self.golden), [])

    def test_mismatch_and_missing_are_reported(self):
        found, _ = check.parse_serial_lines(board_output(self.golden, corrupt="concentric_rep3", drop="reps_300"))
        problems = check.compare(found, self.golden)
        self.assertTrue(any("MISMATCH concentric_rep3" in p for p in problems))
        self.assertIn("missing: reps_300", problems)

    def test_cli_with_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            good = Path(tmp) / "good.txt"
            good.write_text("\n".join(board_output(self.golden)), encoding="utf-8")
            bad = Path(tmp) / "bad.txt"
            bad.write_text("\n".join(board_output(self.golden, corrupt="idle_at_rest")), encoding="utf-8")
            empty = Path(tmp) / "empty.txt"
            empty.write_text("nothing here\n", encoding="utf-8")
            self.assertEqual(check.main(["--file", str(good)]), 0)
            self.assertEqual(check.main(["--file", str(bad)]), 1)
            self.assertEqual(check.main(["--file", str(empty)]), 2)

    def test_truncated_output_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            cut = Path(tmp) / "cut.txt"
            cut.write_text("\n".join(board_output(self.golden, done=False)), encoding="utf-8")
            self.assertEqual(check.main(["--file", str(cut)]), 1)


if __name__ == "__main__":
    unittest.main()
