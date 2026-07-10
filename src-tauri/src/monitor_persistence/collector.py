#!/usr/bin/env python3
"""Low-overhead ShellDesk host metrics collector backed by SQLite."""

from __future__ import annotations

import base64
import ctypes
import json
import math
import os
import platform
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


INTERVAL_MINUTES = 5
RETENTION_DAYS = 30
DEFAULT_THRESHOLDS = {"cpu": 90.0, "memory": 90.0, "disk": 85.0}
MONITOR_DIR = Path(
    os.environ.get("SHELLDESK_MONITOR_DIR", str(Path.home() / ".shelldesk" / "monitor"))
).expanduser()
DATABASE_PATH = MONITOR_DIR / "monitor.sqlite3"


def _finite(value: Any) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _clamp_percent(value: Any) -> Optional[float]:
    number = _finite(value)
    return None if number is None else max(0.0, min(100.0, number))


def _run(command: List[str], timeout: float = 15.0) -> str:
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            check=False,
            text=True,
            timeout=timeout,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return result.stdout.strip() if result.returncode == 0 else ""


def _linux_cpu_snapshot() -> Optional[Tuple[int, int]]:
    try:
        fields = Path("/proc/stat").read_text(encoding="utf-8").splitlines()[0].split()[1:]
        values = [int(value) for value in fields]
    except (OSError, ValueError, IndexError):
        return None
    if len(values) < 4:
        return None
    idle = values[3] + (values[4] if len(values) > 4 else 0)
    return sum(values), idle


def _linux_cpu_percent() -> Optional[float]:
    first = _linux_cpu_snapshot()
    if first is None:
        return None
    time.sleep(0.12)
    second = _linux_cpu_snapshot()
    if second is None:
        return None
    total_delta = second[0] - first[0]
    idle_delta = second[1] - first[1]
    if total_delta <= 0:
        return None
    return _clamp_percent((total_delta - idle_delta) / total_delta * 100.0)


def _linux_memory_percent() -> Optional[float]:
    values: Dict[str, int] = {}
    try:
        for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
            key, raw_value = line.split(":", 1)
            values[key] = int(raw_value.strip().split()[0])
    except (OSError, ValueError, IndexError):
        return None
    total = values.get("MemTotal", 0)
    available = values.get("MemAvailable", values.get("MemFree", 0))
    return _clamp_percent((total - available) / total * 100.0) if total > 0 else None


def _linux_network_bytes() -> Tuple[Optional[int], Optional[int]]:
    rx = 0
    tx = 0
    found = False
    try:
        lines = Path("/proc/net/dev").read_text(encoding="utf-8").splitlines()[2:]
        for line in lines:
            interface, raw_values = line.split(":", 1)
            if interface.strip() == "lo":
                continue
            values = raw_values.split()
            rx += int(values[0])
            tx += int(values[8])
            found = True
    except (OSError, ValueError, IndexError):
        return None, None
    return (rx, tx) if found else (None, None)


def _linux_service_health() -> Tuple[str, Optional[int], List[str]]:
    if shutil.which("systemctl") is None:
        return "unknown", None, []
    output = _run(
        ["systemctl", "list-units", "--type=service", "--state=failed", "--no-legend", "--no-pager", "--plain"],
        timeout=12.0,
    )
    failed = [line.split()[0] for line in output.splitlines() if line.split()]
    return ("warning" if failed else "healthy"), len(failed), failed[:8]


def _mac_cpu_percent() -> Optional[float]:
    output = _run(["ps", "-A", "-o", "%cpu="], timeout=12.0)
    values = [_finite(value.strip()) for value in output.splitlines()]
    total = sum(value for value in values if value is not None)
    cores = os.cpu_count() or 1
    return _clamp_percent(total / cores)


def _mac_memory_percent() -> Optional[float]:
    total = _finite(_run(["sysctl", "-n", "hw.memsize"]))
    output = _run(["vm_stat"])
    if not total or not output:
        return None
    page_size = 4096.0
    first_line = output.splitlines()[0] if output.splitlines() else ""
    if "page size of" in first_line:
        page_size = _finite(first_line.split("page size of", 1)[1].split("bytes", 1)[0]) or page_size
    pages: Dict[str, float] = {}
    for line in output.splitlines()[1:]:
        if ":" not in line:
            continue
        key, raw_value = line.split(":", 1)
        value = _finite(raw_value.strip().rstrip("."))
        if value is not None:
            pages[key] = value
    available_pages = pages.get("Pages free", 0.0) + pages.get("Pages inactive", 0.0)
    return _clamp_percent((total - available_pages * page_size) / total * 100.0)


def _mac_network_bytes() -> Tuple[Optional[int], Optional[int]]:
    output = _run(["netstat", "-ibn"], timeout=12.0)
    header: List[str] = []
    counters: Dict[str, Tuple[int, int]] = {}
    for line in output.splitlines():
        fields = line.split()
        if not fields:
            continue
        if fields[0] == "Name":
            header = fields
            continue
        if not header or fields[0].startswith("lo"):
            continue
        try:
            ibytes_index = header.index("Ibytes")
            obytes_index = header.index("Obytes")
            rx = int(fields[ibytes_index])
            tx = int(fields[obytes_index])
        except (ValueError, IndexError):
            continue
        previous = counters.get(fields[0], (0, 0))
        counters[fields[0]] = (max(previous[0], rx), max(previous[1], tx))
    if not counters:
        return None, None
    return sum(value[0] for value in counters.values()), sum(value[1] for value in counters.values())


def _windows_snapshot() -> Dict[str, Any]:
    script = r"""
$ErrorActionPreference = 'SilentlyContinue'
$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
$os = Get-CimInstance Win32_OperatingSystem
$memory = if ($os.TotalVisibleMemorySize) { (($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / $os.TotalVisibleMemorySize) * 100 } else { $null }
$net = Get-NetAdapterStatistics
$rx = ($net | Measure-Object -Property ReceivedBytes -Sum).Sum
$tx = ($net | Measure-Object -Property SentBytes -Sum).Sum
$failed = @(Get-CimInstance Win32_Service | Where-Object { $_.StartMode -eq 'Auto' -and $_.State -ne 'Running' } | Select-Object -First 8 -ExpandProperty Name)
[pscustomobject]@{ cpu = $cpu; memory = $memory; rx = $rx; tx = $tx; failedServices = $failed } | ConvertTo-Json -Compress
"""
    output = _run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
        timeout=25.0,
    )
    try:
        value = json.loads(output)
    except (json.JSONDecodeError, TypeError):
        return {}
    return value if isinstance(value, dict) else {}


def _windows_memory_fallback() -> Optional[float]:
    class MemoryStatus(ctypes.Structure):
        _fields_ = [
            ("length", ctypes.c_ulong),
            ("memory_load", ctypes.c_ulong),
            ("total_physical", ctypes.c_ulonglong),
            ("available_physical", ctypes.c_ulonglong),
            ("total_page_file", ctypes.c_ulonglong),
            ("available_page_file", ctypes.c_ulonglong),
            ("total_virtual", ctypes.c_ulonglong),
            ("available_virtual", ctypes.c_ulonglong),
            ("available_extended_virtual", ctypes.c_ulonglong),
        ]

    status = MemoryStatus()
    status.length = ctypes.sizeof(MemoryStatus)
    try:
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            return _clamp_percent(status.memory_load)
    except (AttributeError, OSError):
        pass
    return None


def _disk_percent() -> Optional[float]:
    root = Path.home().anchor if platform.system() == "Windows" else "/"
    try:
        usage = shutil.disk_usage(root or "/")
    except OSError:
        return None
    return _clamp_percent(usage.used / usage.total * 100.0) if usage.total > 0 else None


def collect_snapshot() -> Dict[str, Any]:
    system = platform.system()
    if system == "Linux":
        cpu = _linux_cpu_percent()
        memory = _linux_memory_percent()
        rx, tx = _linux_network_bytes()
        service_status, failed_count, failed_services = _linux_service_health()
    elif system == "Darwin":
        cpu = _mac_cpu_percent()
        memory = _mac_memory_percent()
        rx, tx = _mac_network_bytes()
        service_status, failed_count, failed_services = "unknown", None, []
    elif system == "Windows":
        windows = _windows_snapshot()
        cpu = _clamp_percent(windows.get("cpu"))
        memory = _clamp_percent(windows.get("memory")) or _windows_memory_fallback()
        rx_value = windows.get("rx")
        tx_value = windows.get("tx")
        rx = int(rx_value) if _finite(rx_value) is not None else None
        tx = int(tx_value) if _finite(tx_value) is not None else None
        raw_failed = windows.get("failedServices", [])
        failed_services = [str(value) for value in (raw_failed if isinstance(raw_failed, list) else [raw_failed]) if value]
        failed_count = len(failed_services)
        service_status = "warning" if failed_count else "healthy"
    else:
        cpu = memory = None
        rx = tx = None
        service_status, failed_count, failed_services = "unknown", None, []

    return {
        "collected_at": int(time.time() * 1000),
        "cpu_percent": cpu,
        "memory_percent": memory,
        "disk_percent": _disk_percent(),
        "net_rx_bytes": rx,
        "net_tx_bytes": tx,
        "service_status": service_status,
        "service_failed_count": failed_count,
        "service_details": json.dumps(failed_services, ensure_ascii=False),
    }


def connect() -> sqlite3.Connection:
    MONITOR_DIR.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DATABASE_PATH, timeout=15.0)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA synchronous=NORMAL")
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS samples (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          collected_at INTEGER NOT NULL,
          cpu_percent REAL,
          memory_percent REAL,
          disk_percent REAL,
          net_rx_bytes INTEGER,
          net_tx_bytes INTEGER,
          net_rx_bytes_per_sec REAL,
          net_tx_bytes_per_sec REAL,
          service_status TEXT NOT NULL DEFAULT 'unknown',
          service_failed_count INTEGER,
          service_details TEXT NOT NULL DEFAULT '[]'
        );
        CREATE INDEX IF NOT EXISTS idx_samples_collected_at ON samples(collected_at);
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS alert_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          metric TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          ended_at INTEGER,
          threshold REAL NOT NULL,
          peak_value REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_alert_events_started_at ON alert_events(started_at);
        """
    )
    return connection


def get_thresholds(connection: sqlite3.Connection) -> Dict[str, float]:
    thresholds = dict(DEFAULT_THRESHOLDS)
    rows = connection.execute(
        "SELECT key, value FROM settings WHERE key IN ('threshold.cpu', 'threshold.memory', 'threshold.disk')"
    ).fetchall()
    for key, raw_value in rows:
        metric = str(key).split(".", 1)[-1]
        value = _finite(raw_value)
        if metric in thresholds and value is not None:
            thresholds[metric] = max(1.0, min(100.0, value))
    return thresholds


def update_alerts(connection: sqlite3.Connection, snapshot: Dict[str, Any], thresholds: Dict[str, float]) -> None:
    metrics = {
        "cpu": snapshot.get("cpu_percent"),
        "memory": snapshot.get("memory_percent"),
        "disk": snapshot.get("disk_percent"),
    }
    collected_at = int(snapshot["collected_at"])
    for metric, raw_value in metrics.items():
        value = _finite(raw_value)
        threshold = thresholds[metric]
        open_event = connection.execute(
            "SELECT id, peak_value FROM alert_events WHERE metric = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1",
            (metric,),
        ).fetchone()
        if value is not None and value >= threshold:
            if open_event:
                connection.execute(
                    "UPDATE alert_events SET peak_value = ? WHERE id = ?",
                    (max(float(open_event[1]), value), int(open_event[0])),
                )
            else:
                connection.execute(
                    "INSERT INTO alert_events(metric, started_at, threshold, peak_value) VALUES (?, ?, ?, ?)",
                    (metric, collected_at, threshold, value),
                )
        elif open_event:
            connection.execute(
                "UPDATE alert_events SET ended_at = ? WHERE id = ?",
                (collected_at, int(open_event[0])),
            )


def collect() -> Dict[str, Any]:
    snapshot = collect_snapshot()
    with connect() as connection:
        previous = connection.execute(
            "SELECT collected_at, net_rx_bytes, net_tx_bytes FROM samples ORDER BY collected_at DESC LIMIT 1"
        ).fetchone()
        rx_rate = tx_rate = None
        if previous:
            elapsed = (int(snapshot["collected_at"]) - int(previous[0])) / 1000.0
            if elapsed > 0:
                for counter_key, index, rate_key in (
                    ("net_rx_bytes", 1, "rx"),
                    ("net_tx_bytes", 2, "tx"),
                ):
                    current = snapshot.get(counter_key)
                    prior = previous[index]
                    if current is not None and prior is not None and int(current) >= int(prior):
                        rate = (int(current) - int(prior)) / elapsed
                        if rate_key == "rx":
                            rx_rate = rate
                        else:
                            tx_rate = rate
        connection.execute(
            """
            INSERT INTO samples(
              collected_at, cpu_percent, memory_percent, disk_percent,
              net_rx_bytes, net_tx_bytes, net_rx_bytes_per_sec, net_tx_bytes_per_sec,
              service_status, service_failed_count, service_details
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                snapshot["collected_at"], snapshot["cpu_percent"], snapshot["memory_percent"],
                snapshot["disk_percent"], snapshot["net_rx_bytes"], snapshot["net_tx_bytes"],
                rx_rate, tx_rate, snapshot["service_status"], snapshot["service_failed_count"],
                snapshot["service_details"],
            ),
        )
        thresholds = get_thresholds(connection)
        update_alerts(connection, snapshot, thresholds)
        retention_cutoff = int(snapshot["collected_at"]) - RETENTION_DAYS * 24 * 60 * 60 * 1000
        connection.execute("DELETE FROM samples WHERE collected_at < ?", (retention_cutoff,))
        connection.execute("DELETE FROM alert_events WHERE COALESCE(ended_at, started_at) < ?", (retention_cutoff,))
    return {"ok": True, "collectedAt": snapshot["collected_at"]}


def status() -> Dict[str, Any]:
    if not DATABASE_PATH.exists():
        return {
            "configured": True,
            "databasePath": str(DATABASE_PATH),
            "sampleCount": 0,
            "lastSampleAt": None,
            "intervalMinutes": INTERVAL_MINUTES,
            "retentionDays": RETENTION_DAYS,
            "thresholds": dict(DEFAULT_THRESHOLDS),
        }
    with connect() as connection:
        sample_count, last_sample_at = connection.execute(
            "SELECT COUNT(*), MAX(collected_at) FROM samples"
        ).fetchone()
        thresholds = get_thresholds(connection)
    return {
        "configured": True,
        "databasePath": str(DATABASE_PATH),
        "sampleCount": int(sample_count or 0),
        "lastSampleAt": int(last_sample_at) if last_sample_at is not None else None,
        "intervalMinutes": INTERVAL_MINUTES,
        "retentionDays": RETENTION_DAYS,
        "thresholds": thresholds,
    }


def history(since_ms: int, limit: int) -> Dict[str, Any]:
    if not DATABASE_PATH.exists():
        return {"samples": [], "alerts": [], "thresholds": dict(DEFAULT_THRESHOLDS)}
    with connect() as connection:
        rows = connection.execute(
            """
            SELECT collected_at, cpu_percent, memory_percent, disk_percent,
                   net_rx_bytes_per_sec, net_tx_bytes_per_sec,
                   service_status, service_failed_count, service_details
            FROM samples WHERE collected_at >= ? ORDER BY collected_at DESC LIMIT ?
            """,
            (since_ms, limit),
        ).fetchall()
        alert_rows = connection.execute(
            """
            SELECT id, metric, started_at, ended_at, threshold, peak_value
            FROM alert_events WHERE COALESCE(ended_at, started_at) >= ?
            ORDER BY started_at DESC LIMIT 100
            """,
            (since_ms,),
        ).fetchall()
        thresholds = get_thresholds(connection)
    samples = []
    for row in reversed(rows):
        try:
            service_details = json.loads(row[8] or "[]")
        except json.JSONDecodeError:
            service_details = []
        samples.append(
            {
                "timestamp": int(row[0]),
                "cpuPercent": row[1],
                "memoryPercent": row[2],
                "diskPercent": row[3],
                "netRxBytesPerSec": row[4],
                "netTxBytesPerSec": row[5],
                "serviceStatus": row[6],
                "serviceFailedCount": row[7],
                "serviceDetails": service_details if isinstance(service_details, list) else [],
            }
        )
    alerts = [
        {
            "id": int(row[0]),
            "metric": row[1],
            "startedAt": int(row[2]),
            "endedAt": int(row[3]) if row[3] is not None else None,
            "threshold": row[4],
            "peakValue": row[5],
        }
        for row in alert_rows
    ]
    return {"samples": samples, "alerts": alerts, "thresholds": thresholds}


def configure(encoded_config: str) -> Dict[str, Any]:
    try:
        raw_config = base64.b64decode(encoded_config.encode("ascii"), validate=True).decode("utf-8")
        config = json.loads(raw_config)
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("Invalid threshold configuration") from error
    if not isinstance(config, dict):
        raise ValueError("Invalid threshold configuration")
    values: Dict[str, float] = {}
    for metric in DEFAULT_THRESHOLDS:
        value = _finite(config.get(metric))
        if value is None or value < 1.0 or value > 100.0:
            raise ValueError(f"Threshold {metric} must be between 1 and 100")
        values[metric] = value
    with connect() as connection:
        for metric, value in values.items():
            connection.execute(
                "INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)",
                (f"threshold.{metric}", str(value)),
            )
    return {"ok": True, "thresholds": values}


def main() -> int:
    command = sys.argv[1] if len(sys.argv) > 1 else "collect"
    try:
        if command == "collect":
            result = collect()
        elif command == "status":
            result = status()
        elif command == "history":
            since_ms = int(sys.argv[2]) if len(sys.argv) > 2 else 0
            limit = max(1, min(5000, int(sys.argv[3]) if len(sys.argv) > 3 else 2016))
            result = history(max(0, since_ms), limit)
        elif command == "configure" and len(sys.argv) > 2:
            result = configure(sys.argv[2])
        else:
            raise ValueError(f"Unsupported command: {command}")
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0
    except Exception as error:  # The scheduler must surface one concise diagnostic.
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
