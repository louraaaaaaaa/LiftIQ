"""Simple real-time rep counter for LiftIQ.

Counts reps from the magnitude of the accelerometer vector deviating from
1g at rest — no orientation/fusion needed, so it works regardless of how
the device is mounted. A rep is one clear acceleration burst: a
Schmitt-trigger (hysteresis) state machine counts a rep when the
deviation rises above --threshold, then re-arms once it settles back
below half that.

This is a first pass to validate rep counting end-to-end, not a tuned
algorithm — expect it to miscount on very smooth/slow reps (bursts too
small to clear --threshold, needs lowering) or on jerky/noisy equipment
(spurious bursts, needs raising --threshold or --refractory). Use
--verbose on a real set to watch the live deviation values and pick a
threshold that sits cleanly between "resting noise" and "mid-rep".

Usage:
    python rep_counter.py --port COM5
    python rep_counter.py --port COM5 --threshold 0.3 --verbose
"""

import argparse
import time

from liftiq_serial import log_sample, open_stream, read_sample, start_csv_log


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", required=True, help="Serial port, e.g. COM5")
    parser.add_argument("--baud", type=int, default=115200)
    parser.add_argument(
        "--threshold", type=float, default=0.2,
        help="Accel deviation from 1g (in g) that counts as mid-rep motion (default 0.2)",
    )
    parser.add_argument(
        "--refractory", type=float, default=0.4,
        help="Minimum seconds between counted reps, to debounce noise (default 0.4)",
    )
    parser.add_argument(
        "--verbose", action="store_true",
        help="Print every sample's deviation, for picking a threshold",
    )
    parser.add_argument(
        "--log", action=argparse.BooleanOptionalAction, default=True,
        help="Log raw samples to tools/recordings/rep_counter_NNN.csv (default: on)",
    )
    args = parser.parse_args()

    ser = open_stream(args.port, args.baud)
    log_file, log_writer = start_csv_log("rep_counter") if args.log else (None, None)
    start_time = time.time()

    rep_count = 0
    armed = True
    last_rep_time = 0.0
    low_threshold = args.threshold * 0.5

    print(f"Counting reps (threshold={args.threshold}g, refractory={args.refractory}s)... Ctrl+C to stop.")

    try:
        while True:
            sample = read_sample(ser)
            if sample is None:
                continue

            if log_writer:
                log_sample(log_writer, time.time() - start_time, sample)

            ax, ay, az, gx, gy, gz = sample
            magnitude = (ax * ax + ay * ay + az * az) ** 0.5
            deviation = abs(magnitude - 1.0)

            if args.verbose:
                print(f"deviation={deviation:.3f}g armed={armed}")

            now = time.time()

            if armed and deviation > args.threshold and (now - last_rep_time) > args.refractory:
                rep_count += 1
                last_rep_time = now
                armed = False
                print(f"Rep {rep_count}")
            elif not armed and deviation < low_threshold:
                armed = True
    except KeyboardInterrupt:
        print(f"\nStopped. Total reps: {rep_count}")
    finally:
        if log_file:
            log_file.close()


if __name__ == "__main__":
    main()
