import { useCallback, useEffect, useRef, useState } from 'react';

import { isWindowsSystem, powershellCommand } from './remoteSystem';
import type { RemoteSystemType } from './types';

interface RemoteMonitorProps {
  connectionId: string;
  systemType?: RemoteSystemType;
}

interface TimeSeriesPoint {
  time: number;
  value: number;
}

const MAX_POINTS = 60;
const POLL_INTERVAL_MS = 3000;

// ─── Simple Canvas Line Chart ─────────────────────────────────────────────

interface LineChartProps {
  data: TimeSeriesPoint[];
  color: string;
  fillColor: string;
  unit: string;
  minValue?: number;
  maxValue?: number;
  label: string;
}

function SimpleLineChart({ data, color, fillColor, unit, minValue = 0, maxValue = 100, label }: LineChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    canvas.width = w * dpr;
    canvas.height = h * dpr;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, w, h);

    if (data.length < 2) {
      ctx.fillStyle = '#6b7280';
      ctx.font = '12px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('等待数据...', w / 2, h / 2);
      return;
    }

    const padding = { top: 14, right: 14, bottom: 24, left: 38 };
    const plotW = w - padding.left - padding.right;
    const plotH = h - padding.top - padding.bottom;

    const yRange = maxValue - minValue;

    // grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = padding.top + (plotH / 4) * i;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(w - padding.right, y);
      ctx.stroke();

      ctx.fillStyle = '#6b7280';
      ctx.font = '10px system-ui';
      ctx.textAlign = 'right';
      ctx.fillText(`${Math.round(maxValue - (yRange / 4) * i)}${unit}`, padding.left - 5, y + 3);
    }

    // Y axis
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    ctx.moveTo(padding.left, padding.top);
    ctx.lineTo(padding.left, h - padding.bottom);
    ctx.stroke();

    // X axis
    ctx.beginPath();
    ctx.moveTo(padding.left, h - padding.bottom);
    ctx.lineTo(w - padding.right, h - padding.bottom);
    ctx.stroke();

    // time labels
    ctx.fillStyle = '#6b7280';
    ctx.font = '10px system-ui';
    ctx.textAlign = 'center';
    const timeLabels = 4;
    for (let i = 0; i <= timeLabels; i++) {
      const idx = Math.round((data.length - 1) * (i / timeLabels));
      const x = padding.left + (plotW / (data.length - 1)) * idx;
      const d = new Date(data[idx].time);
      ctx.fillText(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`, x, h - 4);
    }

    // fill area
    ctx.beginPath();
    const firstX = padding.left;
    const firstY = padding.top + plotH - ((data[0].value - minValue) / yRange) * plotH;
    ctx.moveTo(firstX, h - padding.bottom);
    ctx.lineTo(firstX, firstY);

    for (let i = 1; i < data.length; i++) {
      const x = padding.left + (plotW / (data.length - 1)) * i;
      const y = padding.top + plotH - ((data[i].value - minValue) / yRange) * plotH;
      ctx.lineTo(x, y);
    }

    const lastX = padding.left + plotW;
    const lastY = padding.top + plotH - ((data[data.length - 1].value - minValue) / yRange) * plotH;
    ctx.lineTo(lastX, h - padding.bottom);
    ctx.closePath();
    ctx.fillStyle = fillColor;
    ctx.fill();

    // line
    ctx.beginPath();
    ctx.moveTo(firstX, firstY);
    for (let i = 1; i < data.length; i++) {
      const x = padding.left + (plotW / (data.length - 1)) * i;
      const y = padding.top + plotH - ((data[i].value - minValue) / yRange) * plotH;
      ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();

    // dot at latest point
    ctx.beginPath();
    ctx.arc(lastX, lastY, 4, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }, [data, color, fillColor, unit, minValue, maxValue]);

  const latestValue = data.length > 0 ? data[data.length - 1].value : undefined;

  return (
    <div className="monitor-chart-card">
      <div className="chart-card-head">
        <span className="chart-card-label">{label}</span>
        {latestValue !== undefined && (
          <span className="chart-card-value" style={{ color }}>
            {latestValue.toFixed(1)}{unit}
          </span>
        )}
      </div>
      <canvas ref={canvasRef} className="monitor-chart-canvas" />
    </div>
  );
}

// ─── Main Monitor Component ──────────────────────────────────────────────

export default function RemoteMonitor({ connectionId, systemType }: RemoteMonitorProps) {
  const isWindowsHost = isWindowsSystem(systemType);
  const [cpuData, setCpuData] = useState<TimeSeriesPoint[]>([]);
  const [memData, setMemData] = useState<TimeSeriesPoint[]>([]);
  const [netRxData, setNetRxData] = useState<TimeSeriesPoint[]>([]);
  const [netTxData, setNetTxData] = useState<TimeSeriesPoint[]>([]);

  const prevNetRxRef = useRef<number | null>(null);
  const prevNetTxRef = useRef<number | null>(null);
  const isPollingRef = useRef(false);

  // ── collect one data point for charts ────────────────────────────────
  const collectMetrics = useCallback(async () => {
    const api = window.guiSSH?.connections;
    if (!api || isPollingRef.current) return;

    isPollingRef.current = true;
    const now = Date.now();

    try {
      const commands = isWindowsHost ? [
        { key: 'cpu', cmd: powershellCommand("$value = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average; if ($null -eq $value) { 0 } else { [math]::Round($value, 1) }") },
        { key: 'mem', cmd: powershellCommand("$os = Get-CimInstance Win32_OperatingSystem; if ($os.TotalVisibleMemorySize) { [math]::Round((($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / $os.TotalVisibleMemorySize) * 100, 1) } else { 0 }") },
        { key: 'net', cmd: powershellCommand("$stats = Get-NetAdapterStatistics -ErrorAction SilentlyContinue; $rx = ($stats | Measure-Object -Property ReceivedBytes -Sum).Sum; $tx = ($stats | Measure-Object -Property SentBytes -Sum).Sum; if ($null -eq $rx) { $rx = 0 }; if ($null -eq $tx) { $tx = 0 }; '{0} {1}' -f [int64]$rx, [int64]$tx") },
      ] : [
        { key: 'cpu', cmd: "cat /proc/loadavg 2>/dev/null | awk '{print $1*100}' || echo 0" },
        { key: 'mem', cmd: "free 2>/dev/null | awk '/^Mem:/ {printf \"%.1f\", $3/$2*100}' || echo 0" },
        { key: 'net', cmd: "cat /proc/net/dev 2>/dev/null | awk 'NR>2 && !/^ *lo:/ {rx+=$2; tx+=$10} END {print rx, tx}' || echo '0 0'" },
      ];

      for (const { key, cmd } of commands) {
        try {
          const result = await api.runCommand(connectionId, cmd);
          const stdout = result.stdout || '';

          switch (key) {
            case 'cpu': {
              const val = parseFloat(stdout) || 0;
              setCpuData((prev) => [...prev.slice(-(MAX_POINTS - 1)), { time: now, value: Math.min(val, 100 * 8) }]);
              break;
            }
            case 'mem': {
              const val = parseFloat(stdout) || 0;
              setMemData((prev) => [...prev.slice(-(MAX_POINTS - 1)), { time: now, value: val }]);
              break;
            }
            case 'net': {
              const parts = stdout.trim().split(/\s+/);
              const rx = parseInt(parts[0], 10) || 0;
              const tx = parseInt(parts[1], 10) || 0;

              if (prevNetRxRef.current !== null) {
                const rxDelta = (rx - prevNetRxRef.current) / (POLL_INTERVAL_MS / 1000);
                const txDelta = (tx - prevNetTxRef.current!) / (POLL_INTERVAL_MS / 1000);
                setNetRxData((prev) => [...prev.slice(-(MAX_POINTS - 1)), { time: now, value: rxDelta / 1024 }]);
                setNetTxData((prev) => [...prev.slice(-(MAX_POINTS - 1)), { time: now, value: txDelta / 1024 }]);
              }

              prevNetRxRef.current = rx;
              prevNetTxRef.current = tx;
              break;
            }
          }
        } catch {
          // 单个命令失败不影响其他
        }
      }
    } finally {
      isPollingRef.current = false;
    }
  }, [connectionId, isWindowsHost]);

  // ── polling ──────────────────────────────────────────────────────────
  useEffect(() => {
    void collectMetrics();

    const metricsTimer = setInterval(collectMetrics, POLL_INTERVAL_MS);

    return () => {
      clearInterval(metricsTimer);
    };
  }, [connectionId, collectMetrics]);

  // ── render ───────────────────────────────────────────────────────────
  return (
    <div className="monitor-pane">
      <div className="monitor-shell">
        <section className="monitor-charts-grid">
          <SimpleLineChart
            data={cpuData}
            color="#60a5fa"
            fillColor="rgba(96,165,250,0.12)"
            unit="%"
            maxValue={100}
            label="CPU 占用"
          />
          <SimpleLineChart
            data={memData}
            color="#f472b6"
            fillColor="rgba(244,114,182,0.12)"
            unit="%"
            maxValue={100}
            label="内存占用"
          />
          <SimpleLineChart
            data={netRxData}
            color="#4ade80"
            fillColor="rgba(74,222,128,0.12)"
            unit=" KB/s"
            maxValue={Math.max(1024, ...netRxData.map((p) => p.value)) || 1024}
            label="网络下载"
          />
          <SimpleLineChart
            data={netTxData}
            color="#facc15"
            fillColor="rgba(250,204,21,0.12)"
            unit=" KB/s"
            maxValue={Math.max(1024, ...netTxData.map((p) => p.value)) || 1024}
            label="网络上传"
          />
        </section>
      </div>
    </div>
  );
}
