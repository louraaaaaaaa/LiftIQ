"""Live BLE debug dashboard for LiftIQ's Test firmware."""

import argparse
import asyncio
import csv
import math
import queue
import struct
import threading
import time
from collections import deque
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
from typing import Dict, List, Optional, Tuple, Union

from bleak import BleakClient, BleakScanner
from bleak.exc import BleakError
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
from matplotlib.figure import Figure

PHASE_NAMES = {0: "IDLE", 1: "CONCENTRIC", 2: "ECCENTRIC"}
NOTIFY_CHARACTERISTIC_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26a8"
WRITE_CHARACTERISTIC_UUID = "cba8691a-1365-4a4f-a808-3fda13b292e0"
CALIBRATION_STATUS = {0: None, 1: "started", 2: "complete", 3: "failed"}
BLE_PACKET_FORMAT = "<6hBBH"


@dataclass(frozen=True)
class TelemetrySample:
    ax: float
    ay: float
    az: float
    total_accel: float
    dynamic_accel: float
    velocity: float
    phase: int
    rep_count: Optional[int]


@dataclass(frozen=True)
class SampleEvent:
    sample: TelemetrySample
    timestamp: float


@dataclass(frozen=True)
class StatusEvent:
    message: str
    is_error: bool = False
    connected: Optional[bool] = None


@dataclass(frozen=True)
class CalibrationEvent:
    status: str
    timestamp: float


@dataclass(frozen=True)
class DevicesEvent:
    devices: List[Tuple[str, str, int]]


DashboardEvent = Union[SampleEvent, StatusEvent, CalibrationEvent, DevicesEvent]
BluetoothCommand = Tuple[str, object]
CSV_COLUMNS = (
    "elapsed_s",
    "ax_m_s2",
    "ay_m_s2",
    "az_m_s2",
    "total_accel_m_s2",
    "dynamic_accel_m_s2",
    "velocity_estimate_m_s",
    "phase",
    "phase_id",
    "rep_count",
    "sample_rate_hz",
)


def write_session_csv(path: Union[str, Path], records: List[Dict[str, object]]) -> None:
    """Write all captured samples and displayed telemetry metrics to CSV."""
    with open(path, "w", newline="", encoding="utf-8") as csv_file:
        writer = csv.DictWriter(csv_file, fieldnames=CSV_COLUMNS)
        writer.writeheader()
        writer.writerows(records)


def parse_ble_packet(
    data: bytes,
) -> Optional[Tuple[TelemetrySample, Optional[str]]]:
    """Decode the firmware's fixed 16-byte BLE notification packet."""
    if len(data) != struct.calcsize(BLE_PACKET_FORMAT):
        return None

    encoded = struct.unpack(BLE_PACKET_FORMAT, data)
    ax, ay, az, total_accel, dynamic_accel = (value / 100.0 for value in encoded[:5])
    velocity = encoded[5] / 1000.0
    phase, calibration_status, rep_count = encoded[6:]
    if phase not in PHASE_NAMES or calibration_status not in CALIBRATION_STATUS:
        return None

    sample = TelemetrySample(
        ax=ax,
        ay=ay,
        az=az,
        total_accel=total_accel,
        dynamic_accel=dynamic_accel,
        velocity=velocity,
        phase=phase,
        rep_count=rep_count,
    )
    return sample, CALIBRATION_STATUS[calibration_status]


async def bluetooth_worker(
    scan_timeout: float,
    events: queue.Queue[DashboardEvent],
    commands: queue.Queue[BluetoothCommand],
    stop_event: threading.Event,
) -> None:
    known_devices = {}
    client: Optional[BleakClient] = None

    def on_disconnect(_client: BleakClient) -> None:
        del _client
        events.put(
            StatusEvent(
                "Bluetooth device disconnected",
                is_error=True,
                connected=False,
            )
        )

    def on_notification(_sender: object, data: bytearray) -> None:
        del _sender
        decoded = parse_ble_packet(bytes(data))
        if decoded is None:
            events.put(
                StatusEvent("Received an invalid BLE telemetry packet", is_error=True)
            )
            return

        timestamp = time.monotonic()
        sample, status = decoded
        if status is not None:
            events.put(CalibrationEvent(status, timestamp))
            return
        events.put(SampleEvent(sample, timestamp))

    while not stop_event.is_set():
        try:
            try:
                command, value = commands.get_nowait()
            except queue.Empty:
                await asyncio.sleep(0.02)
                continue

            if command == "scan":
                events.put(StatusEvent("Scanning for nearby Bluetooth sensors..."))
                discovered = await BleakScanner.discover(
                    timeout=scan_timeout, return_adv=True
                )
                known_devices.clear()
                visible_devices = []
                for address, (device, advertisement) in discovered.items():
                    name = device.name or advertisement.local_name or "Unknown sensor"
                    known_devices[address] = device
                    visible_devices.append((address, name, advertisement.rssi))
                visible_devices.sort(key=lambda item: (-item[2], item[1].casefold()))
                events.put(DevicesEvent(visible_devices))
                events.put(
                    StatusEvent(
                        f"Found {len(visible_devices)} Bluetooth device(s)"
                        if visible_devices
                        else "No Bluetooth devices found. Check the sensor is powered."
                    )
                )
            elif command in ("connect", "pair") and isinstance(value, str):
                if client is not None and client.is_connected:
                    await client.disconnect()
                device = known_devices.get(value, value)
                client = BleakClient(
                    device,
                    disconnected_callback=on_disconnect,
                    pair=command == "pair",
                )
                await client.connect()
                await client.start_notify(
                    NOTIFY_CHARACTERISTIC_UUID, on_notification
                )
                display_name = known_devices.get(value)
                name = display_name.name if display_name else value
                events.put(
                    StatusEvent(
                        f"Connected to '{name}'"
                        + (" (paired)" if command == "pair" else ""),
                        connected=True,
                    )
                )
            elif command == "disconnect":
                if client is not None and client.is_connected:
                    await client.disconnect()
                client = None
                events.put(StatusEvent("Disconnected", connected=False))
            elif command == "write" and isinstance(value, bytes):
                if client is None or not client.is_connected:
                    raise BleakError("Connect to the LiftIQ sensor before sending commands.")
                await client.write_gatt_char(
                    WRITE_CHARACTERISTIC_UUID, value, response=True
                )
        except (BleakError, OSError, asyncio.TimeoutError, RuntimeError) as exc:
            events.put(
                StatusEvent(
                    f"Bluetooth error: {exc}",
                    is_error=True,
                    connected=False if command in ("connect", "pair") else None,
                )
            )

    if client is not None and client.is_connected:
        await client.disconnect()


class DebugDashboard:
    def __init__(
        self, scan_timeout: float, window_seconds: float
    ) -> None:
        self.root = tk.Tk()
        self.root.title("LiftIQ - Bluetooth Test Firmware Debug")
        self.root.geometry("1100x800")
        self.events: queue.Queue[DashboardEvent] = queue.Queue()
        self.commands: queue.Queue[BluetoothCommand] = queue.Queue()
        self.stop_event = threading.Event()
        self.window_seconds = window_seconds
        self.capture_state = "idle"
        self.connection_active = False
        self.device_addresses: Dict[str, str] = {}
        self.session_start_time = 0.0
        self.calibration_requested_at: Optional[float] = None
        self.calibration_started = False
        self.session_records: List[Dict[str, object]] = []
        self.session_exported = False
        self.last_sample_timestamp: Optional[float] = None
        self.rep_count = 0
        self.current_phase = 0
        self.connection_status = "Searching for Bluetooth device..."
        self.status_is_error = False

        self._clear_plot_history()

        self.figure = Figure(figsize=(11, 7), constrained_layout=True)
        grid = self.figure.add_gridspec(
            5, 4, height_ratios=(0.55, 0.55, 1.8, 1.25, 1.25)
        )
        self.metric_values = []
        metric_titles = (
            "Acceleration XYZ (m/s^2)",
            "Total acceleration (m/s^2)",
            "Dynamic acceleration (m/s^2)",
            "Velocity estimate (m/s)",
            "Current phase",
            "Rep count",
            "Sample rate",
        )
        metric_positions = ((0, 0), (0, 1), (0, 2), (0, 3), (1, 0), (1, 1), (1, 2))
        for title, (row, column) in zip(metric_titles, metric_positions):
            axis = self.figure.add_subplot(grid[row, column])
            axis.set_axis_off()
            axis.text(0.03, 0.78, title, fontsize=9, color="dimgray", transform=axis.transAxes)
            value = axis.text(
                0.03, 0.25, "—", fontsize=15, weight="bold", transform=axis.transAxes
            )
            self.metric_values.append(value)

        self.status_axis = self.figure.add_subplot(grid[1, 3])
        self.status_axis.set_axis_off()
        self.status_text = self.status_axis.text(
            0.03, 0.68, "Session: Ready", fontsize=9, wrap=True,
            transform=self.status_axis.transAxes
        )
        self.connection_text = self.status_axis.text(
            0.03, 0.2, self.connection_status, fontsize=8, wrap=True,
            transform=self.status_axis.transAxes
        )

        self.ax_accel = self.figure.add_subplot(grid[2, :])
        self.ax_magnitude = self.figure.add_subplot(grid[3, :], sharex=self.ax_accel)
        self.ax_velocity = self.figure.add_subplot(grid[4, :], sharex=self.ax_accel)

        (self.line_x,) = self.ax_accel.plot([], [], label="X")
        (self.line_y,) = self.ax_accel.plot([], [], label="Y")
        (self.line_z,) = self.ax_accel.plot([], [], label="Z")
        self.ax_accel.set_title("Raw accelerometer axes (includes gravity)")
        self.ax_accel.set_ylabel("m/s^2")
        self.ax_accel.legend(loc="upper right", ncol=3)
        self.ax_accel.grid(True, alpha=0.3)

        (self.line_total,) = self.ax_magnitude.plot([], [], label="Total")
        (self.line_dynamic,) = self.ax_magnitude.plot([], [], label="Dynamic")
        self.ax_magnitude.set_title("Acceleration magnitude")
        self.ax_magnitude.set_ylabel("m/s^2")
        self.ax_magnitude.legend(loc="upper right")
        self.ax_magnitude.grid(True, alpha=0.3)

        (self.line_velocity,) = self.ax_velocity.plot([], [], color="tab:purple")
        self.ax_velocity.set_title("Firmware velocity estimate")
        self.ax_velocity.set_ylabel("m/s")
        self.ax_velocity.set_xlabel("Time (s)")
        self.ax_velocity.grid(True, alpha=0.3)

        controls = ttk.Frame(self.root, padding=(8, 4))
        controls.pack(side=tk.BOTTOM, fill=tk.X)
        ttk.Label(controls, text="Bluetooth sensor:").pack(side=tk.LEFT, padx=(0, 4))
        self.device_selector = ttk.Combobox(
            controls, state="readonly", width=42, values=()
        )
        self.device_selector.pack(side=tk.LEFT, padx=4)
        self.scan_button = ttk.Button(
            controls, text="Scan", command=self.scan_devices
        )
        self.scan_button.pack(side=tk.LEFT, padx=4)
        self.connect_button = ttk.Button(
            controls,
            text="Connect",
            command=lambda: self.connect_selected(pair=False),
            state=tk.DISABLED,
        )
        self.connect_button.pack(side=tk.LEFT, padx=4)
        self.pair_button = ttk.Button(
            controls,
            text="Pair & Connect",
            command=lambda: self.connect_selected(pair=True),
            state=tk.DISABLED,
        )
        self.pair_button.pack(side=tk.LEFT, padx=4)
        self.disconnect_button = ttk.Button(
            controls,
            text="Disconnect",
            command=self.disconnect_device,
            state=tk.DISABLED,
        )
        self.disconnect_button.pack(side=tk.LEFT, padx=4)

        session_controls = ttk.Frame(self.root, padding=(8, 4))
        session_controls.pack(side=tk.BOTTOM, fill=tk.X)
        self.start_button = ttk.Button(
            session_controls, text="Start", command=self.start_session
        )
        self.start_button.configure(state=tk.DISABLED)
        self.start_button.pack(side=tk.LEFT, padx=(0, 6))
        self.pause_button = ttk.Button(
            session_controls, text="Pause", command=self.toggle_pause, state=tk.DISABLED
        )
        self.pause_button.pack(side=tk.LEFT, padx=6)
        self.stop_button = ttk.Button(
            session_controls, text="Stop", command=self.stop_session, state=tk.DISABLED
        )
        self.stop_button.pack(side=tk.LEFT, padx=6)
        self.export_button = ttk.Button(
            session_controls,
            text="Save CSV...",
            command=self.export_session,
            state=tk.DISABLED,
        )
        self.export_button.pack(side=tk.LEFT, padx=6)

        self.canvas = FigureCanvasTkAgg(self.figure, master=self.root)
        self.canvas.get_tk_widget().pack(side=tk.TOP, fill=tk.BOTH, expand=True)
        self.root.protocol("WM_DELETE_WINDOW", self.close)

        worker = threading.Thread(
            target=lambda: asyncio.run(
                bluetooth_worker(
                    scan_timeout,
                    self.events,
                    self.commands,
                    self.stop_event,
                )
            ),
            daemon=True,
        )
        worker.start()
        self.commands.put(("scan", None))
        self.root.after(100, self.update)

    def update(self) -> None:
        self._consume_events()
        self._check_calibration_timeout()
        self._redraw()
        self.root.after(100, self.update)

    def _consume_events(self) -> None:
        while True:
            try:
                event = self.events.get_nowait()
            except queue.Empty:
                break

            if isinstance(event, StatusEvent):
                self.connection_status = event.message
                self.status_is_error = event.is_error
                if event.connected is not None:
                    self.connection_active = event.connected
                if not self.connection_active and self.capture_state == "calibrating":
                    self.capture_state = "idle"
                    self.calibration_requested_at = None
                elif not self.connection_active and self.capture_state in ("recording", "paused"):
                    self.capture_state = "stopped"
                    self._clear_plot_history()
                self._update_controls()
            elif isinstance(event, DevicesEvent):
                selected = self.device_selector.get()
                self.device_addresses = {
                    f"{name} [{address}] - RSSI {rssi} dBm": address
                    for address, name, rssi in event.devices
                }
                choices = tuple(self.device_addresses)
                self.device_selector.configure(values=choices)
                if selected in self.device_addresses:
                    self.device_selector.set(selected)
                elif choices:
                    self.device_selector.current(0)
                self._update_controls()
            elif isinstance(event, CalibrationEvent):
                if event.status == "started" and self.capture_state == "calibrating":
                    self.calibration_started = True
                    self.connection_status = "Calibration started - keep the sensor still"
                    self.status_is_error = False
                elif event.status == "complete" and self.capture_state == "calibrating":
                    self.capture_state = "recording"
                    self.session_start_time = event.timestamp
                    self.last_sample_timestamp = None
                    self.calibration_requested_at = None
                    self.calibration_started = False
                    self.connection_status = "Calibration complete"
                    self.status_is_error = False
                    self._update_controls()
                elif event.status == "failed" and self.capture_state == "calibrating":
                    self.capture_state = "idle"
                    self.calibration_requested_at = None
                    self.calibration_started = False
                    self.connection_status = "Calibration failed. Check the sensor and try again."
                    self.status_is_error = True
                    self._update_controls()
            elif isinstance(event, SampleEvent):
                if self.capture_state == "recording":
                    self._capture_sample(event)

    def _clear_plot_history(self) -> None:
        self.times = deque()
        self.accel_x = deque()
        self.accel_y = deque()
        self.accel_z = deque()
        self.total_accel = deque()
        self.dynamic_accel = deque()
        self.velocity = deque()

    def _capture_sample(self, event: SampleEvent) -> None:
        if event.timestamp < self.session_start_time:
            return
        sample = event.sample
        elapsed = event.timestamp - self.session_start_time
        sample_rate = 0.0
        if self.last_sample_timestamp is not None:
            interval = event.timestamp - self.last_sample_timestamp
            if interval > 0:
                sample_rate = 1.0 / interval
        self.last_sample_timestamp = event.timestamp
        self.current_phase = sample.phase
        if sample.rep_count is not None:
            self.rep_count = sample.rep_count

        self.times.append(elapsed)
        self.accel_x.append(sample.ax)
        self.accel_y.append(sample.ay)
        self.accel_z.append(sample.az)
        self.total_accel.append(sample.total_accel)
        self.dynamic_accel.append(sample.dynamic_accel)
        self.velocity.append(sample.velocity)
        self.session_records.append(
            {
                "elapsed_s": round(elapsed, 6),
                "ax_m_s2": sample.ax,
                "ay_m_s2": sample.ay,
                "az_m_s2": sample.az,
                "total_accel_m_s2": sample.total_accel,
                "dynamic_accel_m_s2": sample.dynamic_accel,
                "velocity_estimate_m_s": sample.velocity,
                "phase": PHASE_NAMES[sample.phase],
                "phase_id": sample.phase,
                "rep_count": self.rep_count,
                "sample_rate_hz": round(sample_rate, 3),
            }
        )

    def start_session(self) -> None:
        if not self.connection_active or self.capture_state in (
            "calibrating",
            "recording",
            "paused",
        ):
            return
        if self.session_records and not self.session_exported:
            discard = messagebox.askyesno(
                "Discard stopped session?",
                "The stopped session has not been exported. Starting a new "
                "session will discard its captured data. Continue?",
                parent=self.root,
            )
            if not discard:
                return

        self.session_records = []
        self.session_exported = False
        self._clear_plot_history()
        self.session_start_time = 0.0
        self.last_sample_timestamp = None
        self.rep_count = 0
        self.current_phase = 0
        self.capture_state = "calibrating"
        self.calibration_requested_at = time.monotonic()
        self.calibration_started = False
        self.connection_status = "Calibrating - keep the sensor still"
        self.status_is_error = False
        self._update_controls()
        self._redraw()
        self.commands.put(("write", b"\x01"))

    def scan_devices(self) -> None:
        if self.connection_active:
            self.connection_status = "Disconnect before scanning for another sensor"
            self.status_is_error = True
            self._redraw()
            return
        self.scan_button.configure(state=tk.DISABLED)
        self.commands.put(("scan", None))

    def connect_selected(self, pair: bool) -> None:
        if self.connection_active:
            return
        selection = self.device_selector.get()
        address = self.device_addresses.get(selection)
        if address is None:
            self.connection_status = "Scan and select a Bluetooth sensor first"
            self.status_is_error = True
            self._redraw()
            return
        self.connect_button.configure(state=tk.DISABLED)
        self.pair_button.configure(state=tk.DISABLED)
        self.connection_status = (
            "Pairing and connecting..." if pair else "Connecting..."
        )
        self.status_is_error = False
        self._redraw()
        self.commands.put(("pair" if pair else "connect", address))

    def disconnect_device(self) -> None:
        self.commands.put(("disconnect", None))

    def toggle_pause(self) -> None:
        if self.capture_state == "recording":
            self.capture_state = "paused"
        elif self.capture_state == "paused":
            self.capture_state = "recording"
            self.last_sample_timestamp = None
        else:
            return
        self._update_controls()
        self._redraw()

    def stop_session(self) -> None:
        if self.capture_state not in ("recording", "paused"):
            return
        self._consume_events()
        self.capture_state = "stopped"
        self._clear_plot_history()
        self._update_controls()
        self._redraw()

    def export_session(self) -> None:
        if self.capture_state != "stopped" or not self.session_records:
            return
        filename = f"liftiq_session_{datetime.now():%Y%m%d_%H%M%S}.csv"
        path = filedialog.asksaveasfilename(
            parent=self.root,
            title="Export LiftIQ session",
            defaultextension=".csv",
            initialfile=filename,
            filetypes=(("CSV files", "*.csv"), ("All files", "*.*")),
        )
        if not path:
            return
        try:
            write_session_csv(path, self.session_records)
        except OSError as exc:
            messagebox.showerror("CSV export failed", str(exc), parent=self.root)
            return
        self.session_exported = True
        self.connection_status = f"Exported {len(self.session_records)} samples to {path}"
        self.status_is_error = False
        self._redraw()

    def _update_controls(self) -> None:
        active = self.capture_state in ("recording", "paused")
        can_start = (
            self.connection_active
            and not active
            and self.capture_state != "calibrating"
        )
        self.start_button.configure(state=tk.NORMAL if can_start else tk.DISABLED)
        self.pause_button.configure(state=tk.NORMAL if active else tk.DISABLED)
        self.pause_button.configure(
            text="Resume" if self.capture_state == "paused" else "Pause"
        )
        self.stop_button.configure(state=tk.NORMAL if active else tk.DISABLED)
        can_export = self.capture_state == "stopped" and bool(self.session_records)
        self.export_button.configure(state=tk.NORMAL if can_export else tk.DISABLED)
        self.scan_button.configure(
            state=tk.DISABLED if self.connection_active else tk.NORMAL
        )
        selected = self.device_selector.get() in self.device_addresses
        connecting = self.connection_status in ("Connecting...", "Pairing and connecting...")
        self.connect_button.configure(
            state=tk.NORMAL
            if selected and not self.connection_active and not connecting
            else tk.DISABLED
        )
        self.pair_button.configure(
            state=tk.NORMAL
            if selected and not self.connection_active and not connecting
            else tk.DISABLED
        )
        self.disconnect_button.configure(
            state=tk.NORMAL if self.connection_active else tk.DISABLED
        )

    def _session_status(self) -> str:
        if self.capture_state == "calibrating":
            return "Session: Calibrating - keep sensor still"
        if self.capture_state == "recording":
            return f"Session: Recording ({len(self.session_records)} samples)"
        if self.capture_state == "paused":
            return f"Session: Paused ({len(self.session_records)} samples)"
        if self.capture_state == "stopped":
            return f"Session: Stopped ({len(self.session_records)} samples)"
        return "Session: Ready"

    def _check_calibration_timeout(self) -> None:
        if (
            self.capture_state == "calibrating"
            and self.calibration_requested_at is not None
            and time.monotonic() - self.calibration_requested_at > 15.0
        ):
            self.capture_state = "idle"
            self.calibration_requested_at = None
            self.connection_status = (
                "No calibration response. Verify the BLE connection and firmware."
                if not self.calibration_started
                else "Calibration did not finish. Check the sensor and try again."
            )
            self.calibration_started = False
            self.status_is_error = True
            self._update_controls()

    def _redraw(self) -> None:
        self.status_text.set_text(self._session_status())
        self.connection_text.set_text(self.connection_status)
        self.connection_text.set_color("tab:red" if self.status_is_error else "dimgray")
        if not self.times:
            for line in (
                self.line_x,
                self.line_y,
                self.line_z,
                self.line_total,
                self.line_dynamic,
                self.line_velocity,
            ):
                line.set_data([], [])
            for text in self.metric_values:
                text.set_text("—")
            if self.capture_state == "stopped":
                self.metric_values[5].set_text(str(self.rep_count))
            self.ax_accel.set_xlim(0, self.window_seconds)
            self.ax_magnitude.set_xlim(0, self.window_seconds)
            self.ax_velocity.set_xlim(0, self.window_seconds)
            self.canvas.draw_idle()
            return

        latest = self.times[-1]
        cutoff = latest - self.window_seconds
        while self.times and self.times[0] < cutoff:
            for samples in (
                self.times,
                self.accel_x,
                self.accel_y,
                self.accel_z,
                self.total_accel,
                self.dynamic_accel,
                self.velocity,
            ):
                samples.popleft()

        sample = (
            f"{self.accel_x[-1]:.2f}, {self.accel_y[-1]:.2f}, "
            f"{self.accel_z[-1]:.2f}"
        )
        rate = float(self.session_records[-1]["sample_rate_hz"])
        values = (
            sample,
            f"{self.total_accel[-1]:.2f}",
            f"{self.dynamic_accel[-1]:.2f}",
            f"{self.velocity[-1]:.2f}",
            PHASE_NAMES.get(self.current_phase, "UNKNOWN"),
            str(self.rep_count),
            f"{rate:.1f} Hz",
        )
        for text, value in zip(self.metric_values, values):
            text.set_text(value)

        self.line_x.set_data(self.times, self.accel_x)
        self.line_y.set_data(self.times, self.accel_y)
        self.line_z.set_data(self.times, self.accel_z)
        self.line_total.set_data(self.times, self.total_accel)
        self.line_dynamic.set_data(self.times, self.dynamic_accel)
        self.line_velocity.set_data(self.times, self.velocity)
        left = max(0.0, latest - self.window_seconds)
        right = max(self.window_seconds, latest)
        for axis in (self.ax_accel, self.ax_magnitude, self.ax_velocity):
            axis.set_xlim(left, right)
            axis.relim()
            axis.autoscale_view(scalex=False)
        self.canvas.draw_idle()

    def close(self) -> None:
        if self.session_records and not self.session_exported:
            close_without_export = messagebox.askyesno(
                "Close without exporting?",
                "The current session has not been exported. Closing now will "
                "discard its captured data. Close anyway?",
                parent=self.root,
            )
            if not close_without_export:
                return
        self.stop_event.set()
        self.root.destroy()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--scan-timeout",
        type=float,
        default=5.0,
        help="Seconds per Bluetooth scan (default: 5)",
    )
    parser.add_argument("--window", type=float, default=10.0, help="Plot history in seconds")
    args = parser.parse_args()
    if not math.isfinite(args.window) or args.window <= 0:
        parser.error("--window must be a finite number greater than zero")
    if not math.isfinite(args.scan_timeout) or args.scan_timeout <= 0:
        parser.error("--scan-timeout must be a finite number greater than zero")

    app = DebugDashboard(args.scan_timeout, args.window)
    app.root.mainloop()


if __name__ == "__main__":
    main()
