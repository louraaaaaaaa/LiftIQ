import asyncio
import csv
import queue
import struct
import tempfile
import threading
import unittest
from collections import deque
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from firmware_debug import (
    CSV_COLUMNS,
    DebugDashboard,
    DevicesEvent,
    SampleEvent,
    TelemetrySample,
    bluetooth_worker,
    parse_ble_packet,
    write_session_csv,
)


class FirmwareDebugParserTests(unittest.TestCase):
    def test_parses_ble_telemetry_packet(self):
        packet = struct.pack(
            "<6hBBH",
            123,
            -234,
            978,
            979,
            2,
            150,
            2,
            0,
            7,
        )

        decoded = parse_ble_packet(packet)

        self.assertIsNotNone(decoded)
        sample, status = decoded
        self.assertEqual((sample.ax, sample.ay, sample.az), (1.23, -2.34, 9.78))
        self.assertEqual(sample.total_accel, 9.79)
        self.assertEqual(sample.dynamic_accel, 0.02)
        self.assertEqual(sample.velocity, 0.15)
        self.assertEqual(sample.phase, 2)
        self.assertEqual(sample.rep_count, 7)
        self.assertIsNone(status)

    def test_decodes_ble_calibration_status(self):
        for encoded_status, expected_status in (
            (1, "started"),
            (2, "complete"),
            (3, "failed"),
        ):
            with self.subTest(status=expected_status):
                packet = struct.pack(
                    "<6hBBH", 0, 0, 0, 0, 0, 0, 0, encoded_status, 0
                )
                decoded = parse_ble_packet(packet)
                self.assertIsNotNone(decoded)
                self.assertEqual(decoded[1], expected_status)

    def test_rejects_malformed_ble_packet(self):
        self.assertIsNone(parse_ble_packet(b"short"))
        invalid_phase = struct.pack("<6hBBH", 0, 0, 0, 0, 0, 0, 4, 0, 0)
        self.assertIsNone(parse_ble_packet(invalid_phase))
        invalid_status = struct.pack("<6hBBH", 0, 0, 0, 0, 0, 0, 0, 4, 0)
        self.assertIsNone(parse_ble_packet(invalid_status))

    def test_exports_all_plot_values_and_rep_count(self):
        record = {
            "elapsed_s": 0.1,
            "ax_m_s2": 1.0,
            "ay_m_s2": 2.0,
            "az_m_s2": 9.0,
            "total_accel_m_s2": 9.3,
            "dynamic_accel_m_s2": 0.5,
            "velocity_estimate_m_s": 0.2,
            "phase": "CONCENTRIC",
            "phase_id": 1,
            "rep_count": 3,
            "sample_rate_hz": 100.0,
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "session.csv"
            write_session_csv(path, [record])
            with path.open(newline="", encoding="utf-8") as csv_file:
                reader = csv.DictReader(csv_file)
                self.assertEqual(tuple(reader.fieldnames), CSV_COLUMNS)
                rows = list(reader)

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["rep_count"], "3")
        self.assertEqual(rows[0]["phase"], "CONCENTRIC")
        self.assertEqual(rows[0]["velocity_estimate_m_s"], "0.2")

    def test_capture_records_every_plot_value_with_elapsed_time_and_rate(self):
        dashboard = DebugDashboard.__new__(DebugDashboard)
        dashboard.session_start_time = 10.0
        dashboard.last_sample_timestamp = None
        dashboard.rep_count = 2
        dashboard.current_phase = 0
        dashboard.session_records = []
        dashboard.times = deque()
        dashboard.accel_x = deque()
        dashboard.accel_y = deque()
        dashboard.accel_z = deque()
        dashboard.total_accel = deque()
        dashboard.dynamic_accel = deque()
        dashboard.velocity = deque()
        sample = TelemetrySample(1, 2, 9, 9.3, 0.5, 0.2, 1, 3)

        dashboard._capture_sample(SampleEvent(sample, 10.01))
        dashboard._capture_sample(SampleEvent(sample, 10.02))

        self.assertEqual(len(dashboard.session_records), 2)
        self.assertEqual(dashboard.session_records[0]["elapsed_s"], 0.01)
        self.assertEqual(dashboard.session_records[0]["ax_m_s2"], 1)
        self.assertEqual(dashboard.session_records[0]["phase"], "CONCENTRIC")
        self.assertEqual(dashboard.session_records[0]["rep_count"], 3)
        self.assertEqual(dashboard.session_records[1]["sample_rate_hz"], 100.0)


class BluetoothScanTests(unittest.IsolatedAsyncioTestCase):
    async def test_scan_command_lists_discovered_devices(self):
        events = queue.Queue()
        commands = queue.Queue()
        stop_event = threading.Event()
        commands.put(("scan", None))
        device = SimpleNamespace(name="GymIQ Sensor", address="AA:BB:CC")
        advertisement = SimpleNamespace(local_name=None, rssi=-48)
        discovered = {"AA:BB:CC": (device, advertisement)}

        with patch(
            "firmware_debug.BleakScanner.discover",
            new=AsyncMock(return_value=discovered),
        ):
            async def stop_after_scan():
                while True:
                    try:
                        event = events.get_nowait()
                    except queue.Empty:
                        await asyncio.sleep(0.01)
                        continue
                    if isinstance(event, DevicesEvent):
                        break
                stop_event.set()
                return event

            _, event = await asyncio.gather(
                bluetooth_worker(1.0, events, commands, stop_event),
                stop_after_scan(),
            )

        self.assertEqual(
            event.devices,
            [("AA:BB:CC", "GymIQ Sensor", -48)],
        )


if __name__ == "__main__":
    unittest.main()
