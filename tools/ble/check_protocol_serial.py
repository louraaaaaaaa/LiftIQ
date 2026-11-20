"""Hardware-in-the-loop check of the firmware's v1 packet encoder.

Flash a build with ``#define DEBUG_PROTOCOL_SELFTEST 1`` (default 0). At boot the sketch prints
one ``[PROTO] <vector name> <36 hex chars>`` line per golden input plus ``[PROTO] INFO <40 hex>``
and ``[PROTO] done``. This script compares those lines with
``tests/compat/golden/v1_vectors.json`` (the frozen contract) byte for byte.

    python check_protocol_serial.py --port COM5          # reset the board, read ~10 s, compare
    python check_protocol_serial.py --file boot_log.txt  # compare a saved serial log

Exit code 0 = every golden vector matched, 1 = mismatch/missing, 2 = no [PROTO] output seen.
"""

import argparse
import json
import re
import sys
import time
from pathlib import Path

GOLDEN_PATH = Path(__file__).resolve().parents[2] / "tests" / "compat" / "golden" / "v1_vectors.json"
LINE = re.compile(r"\[PROTO\]\s+(\S+)\s+([0-9a-fA-F]+)\s*$")


def load_golden(path=GOLDEN_PATH):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def normalize_hex(text):
    return re.sub(r"[^0-9a-f]", "", text.lower())


def parse_serial_lines(lines):
    """Return ({name: hex}, saw_done) from raw serial text lines."""
    found = {}
    done = False
    for line in lines:
        stripped = line.strip()
        if stripped.endswith("[PROTO] done") or stripped == "[PROTO] done":
            done = True
            continue
        match = LINE.search(stripped)
        if match:
            found[match.group(1)] = normalize_hex(match.group(2))
    return found, done


def compare(found, golden):
    """List of human-readable problems; empty means everything matched."""
    problems = []
    for vector in golden["telemetryV1"]:
        expected = normalize_hex(vector["hex"])
        got = found.get(vector["name"])
        if got is None:
            problems.append(f"missing: {vector['name']}")
        elif got != expected:
            problems.append(f"MISMATCH {vector['name']}: board {got} != golden {expected}")
    info = found.get("INFO")
    if info is None:
        problems.append("missing: INFO")
    else:
        current = next((v for v in golden["infoV1"] if v["name"] == "info_current_firmware"), None)
        # The INFO firmware string differs per firmware build, so only the protocol header is pinned.
        if current and (len(info) != 40 or info[:4] != normalize_hex(current["hex"])[:4]):
            problems.append(f"INFO header mismatch: board {info}")
    return problems


def read_serial(port, baud, seconds, reset):
    import serial  # pyserial, see requirements.txt

    lines = []
    with serial.Serial(port, baud, timeout=0.5) as ser:
        if reset:
            ser.dtr = False
            ser.rts = True
            time.sleep(0.1)
            ser.rts = False
        deadline = time.time() + seconds
        while time.time() < deadline:
            raw = ser.readline()
            if raw:
                text = raw.decode("utf-8", errors="replace")
                lines.append(text)
                if "[PROTO] done" in text:
                    break
    return lines


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--port", help="serial port, e.g. COM5 or /dev/ttyACM0")
    source.add_argument("--file", help="saved serial log to check instead of a live port")
    parser.add_argument("--baud", type=int, default=115200)
    parser.add_argument("--seconds", type=float, default=15.0, help="max time to read from the port")
    parser.add_argument("--no-reset", action="store_true", help="do not toggle RTS to reboot the board")
    parser.add_argument("--golden", default=str(GOLDEN_PATH))
    args = parser.parse_args(argv)

    if args.file:
        lines = Path(args.file).read_text(encoding="utf-8", errors="replace").splitlines()
    else:
        lines = read_serial(args.port, args.baud, args.seconds, reset=not args.no_reset)

    found, done = parse_serial_lines(lines)
    if not found:
        print("No [PROTO] lines seen. Is DEBUG_PROTOCOL_SELFTEST 1 in the flashed sketch? Press reset and retry.")
        return 2
    golden = load_golden(args.golden)
    problems = compare(found, golden)
    if not done:
        problems.append("the '[PROTO] done' marker was not seen (output cut short)")
    total = len(golden["telemetryV1"]) + 1
    if problems:
        print(f"PROTOCOL SELF-TEST FAILED ({len(problems)} problem(s)):")
        for problem in problems:
            print(f"  - {problem}")
        return 1
    print(f"PROTOCOL SELF-TEST OK: {total} encoder outputs match tests/compat/golden/v1_vectors.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
