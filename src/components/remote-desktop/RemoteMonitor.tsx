import { useCallback, useEffect, useRef, useState } from 'react';

import { formatDateTime, getErrorMessage } from './desktopUtils';

interface RemoteMonitorProps {
  connectionId: string;
}

interface TimeSeriesPoint {
  time: number;
  value: number;
}

interface ProcessInfo {
  pid: number;
  ppid: number;
  user: string;
  cpu: number;
  mem: number;
  rss: number;
  command: string;
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

// ─── Process Table ────────────────────────────────────────────────────────

interface ProcessTableProps {
  processes: ProcessInfo[];
  isLoading: boolean;
  error: string;
  onKill: (pid: number) => void;
  onRefresh: () => void;
}

function ProcessTable({ processes, isLoading, error, onKill, onRefresh }: ProcessTableProps) {
  const [killingPid, setKillingPid] = useState<number | null>(null);

  const handleKill = async (pid: number) => {
    setKillingPid(pid);
    try {
      await onKill(pid);
    } finally {
      setKillingPid(null);
    }
  };

  return (
    <div className="monitor-process-section">
      <div className="process-section-head">
        <h3 className="process-section-title">进程管理</h3>
        <button type="button" className="monitor-refresh-btn" onClick={onRefresh} disabled={isLoading}>
          {isLoading ? '读取中...' : '刷新进程'}
        </button>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="process-table-wrap">
        <table className="process-table">
          <thead>
            <tr>
              <th>PID</th>
              <th>PPID</th>
              <th>用户</th>
              <th>CPU%</th>
              <th>内存%</th>
              <th>RSS (KB)</th>
              <th className="process-command-col">命令</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {processes.length === 0 && !isLoading ? (
              <tr>
                <td colSpan={8} className="process-empty">暂无进程数据</td>
              </tr>
            ) : (
              processes.map((proc) => (
                <tr key={proc.pid}>
                  <td className="process-pid">{proc.pid}</td>
                  <td>{proc.ppid}</td>
                  <td>{proc.user}</td>
                  <td className={proc.cpu > 50 ? 'process-highlight' : ''}>{proc.cpu.toFixed(1)}</td>
                  <td className={proc.mem > 50 ? 'process-highlight' : ''}>{proc.mem.toFixed(1)}</td>
                  <td>{proc.rss.toLocaleString()}</td>
                  <td className="process-command-col" title={proc.command}>{proc.command}</td>
                  <td>
                    <button
                      type="button"
                      className="process-kill-btn"
                      onClick={() => handleKill(proc.pid)}
                      disabled={killingPid === proc.pid}
                    >
                      {killingPid === proc.pid ? '...' : '终止'}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Main Monitor Component ──────────────────────────────────────────────

export default function RemoteMonitor({ connectionId }: RemoteMonitorProps) {
  const [hostname, setHostname] = useState('');
  const [kernel, setKernel] = useState('');
  const [uptimeLine, setUptimeLine] = useState('');

  const [cpuData, setCpuData] = useState<TimeSeriesPoint[]>([]);
  const [memData, setMemData] = useState<TimeSeriesPoint[]>([]);
  const [netRxData, setNetRxData] = useState<TimeSeriesPoint[]>([]);
  const [netTxData, setNetTxData] = useState<TimeSeriesPoint[]>([]);
  const [diskData, setDiskData] = useState<TimeSeriesPoint[]>([]);

  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [processError, setProcessError] = useState('');
  const [isProcessLoading, setIsProcessLoading] = useState(false);

  const [statusError, setStatusError] = useState('');
  const [refreshedAt, setRefreshedAt] = useState('');

  const prevNetRxRef = useRef<number | null>(null);
  const prevNetTxRef = useRef<number | null>(null);

  // ── collect one data point for charts ────────────────────────────────
  const collectMetrics = useCallback(async () => {
    const api = window.guiSSH?.connections;
    if (!api) return;

    const now = Date.now();

    try {
      const [cpuResult, memResult, diskResult, netResult] = await Promise.allSettled([
        api.runCommand(connectionId, "cat /proc/loadavg 2>/dev/null | awk '{print $1*100}' || echo 0"),
        api.runCommand(connectionId, "free 2>/dev/null | awk '/^Mem:/ {printf \"%.1f\", $3/$2*100}' || echo 0"),
        api.runCommand(connectionId, "df / 2>/dev/null | awk 'NR==2 {gsub(/%/,\"\"); print $5}' || echo 0"),
        api.runCommand(connectionId, "cat /proc/net/dev 2>/dev/null | awk 'NR>2 && !/^ *lo:/ {rx+=$2; tx+=$10} END {print rx, tx}' || echo '0 0'"),
      ]);

      // CPU
      if (cpuResult.status === 'fulfilled') {
        const val = parseFloat(cpuResult.value.stdout) || 0;
        setCpuData((prev) => [...prev.slice(-(MAX_POINTS - 1)), { time: now, value: Math.min(val, 100 * 8) }]);
      }

      // Memory
      if (memResult.status === 'fulfilled') {
        const val = parseFloat(memResult.value.stdout) || 0;
        setMemData((prev) => [...prev.slice(-(MAX_POINTS - 1)), { time: now, value: val }]);
      }

      // Disk
      if (diskResult.status === 'fulfilled') {
        const val = parseFloat(diskResult.value.stdout) || 0;
        setDiskData((prev) => [...prev.slice(-(MAX_POINTS - 1)), { time: now, value: val }]);
      }

      // Network - compute deltas
      if (netResult.status === 'fulfilled') {
        const parts = netResult.value.stdout.trim().split(/\s+/);
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
      }
    } catch {
      // silently ignore individual failures
    }
  }, [connectionId]);

  // ── fetch host info ──────────────────────────────────────────────────
  const fetchHostInfo = useCallback(async () => {
    const api = window.guiSSH?.connections;
    if (!api) return;

    try {
      const report = await api.getStatus(connectionId);
      setRefreshedAt(report.refreshedAt);

      const items = report.items ?? [];
      setHostname(items.find((i) => i.key === 'hostname')?.value?.split('\n')[0]?.trim() || '远程主机');
      setKernel(items.find((i) => i.key === 'kernel')?.value?.split('\n')[0]?.trim() || '');
      setUptimeLine(items.find((i) => i.key === 'uptime')?.value?.split('\n')[0]?.trim() || '');
      setStatusError('');
    } catch (error) {
      setStatusError(getErrorMessage(error));
    }
  }, [connectionId]);

  // ── fetch process list ───────────────────────────────────────────────
  const fetchProcesses = useCallback(async () => {
    const api = window.guiSSH?.connections;
    if (!api) return;

    setIsProcessLoading(true);
    setProcessError('');

    try {
      const result = await api.runCommand(
        connectionId,
        'ps -eo pid,ppid,user,%cpu,%mem,rss,comm --sort=-%cpu --no-headers 2>/dev/null | head -40',
      );

      const lines = result.stdout.trim().split('\n').filter(Boolean);
      const parsed: ProcessInfo[] = [];

      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 7) continue;
        parsed.push({
          pid: parseInt(parts[0], 10),
          ppid: parseInt(parts[1], 10),
          user: parts[2],
          cpu: parseFloat(parts[3]) || 0,
          mem: parseFloat(parts[4]) || 0,
          rss: parseInt(parts[5], 10) || 0,
          command: parts.slice(6).join(' '),
        });
      }

      setProcesses(parsed);
    } catch (error) {
      setProcessError(getErrorMessage(error));
      setProcesses([]);
    } finally {
      setIsProcessLoading(false);
    }
  }, [connectionId]);

  const killProcess = useCallback(async (pid: number) => {
    const api = window.guiSSH?.connections;
    if (!api) return;

    try {
      await api.runCommand(connectionId, `kill -9 ${pid} 2>/dev/null || kill ${pid} 2>/dev/null`);
      await fetchProcesses();
    } catch (error) {
      setProcessError(getErrorMessage(error));
    }
  }, [connectionId, fetchProcesses]);

  // ── polling ──────────────────────────────────────────────────────────
  useEffect(() => {
    void fetchHostInfo();
    void collectMetrics();
    void fetchProcesses();

    const metricsTimer = setInterval(collectMetrics, POLL_INTERVAL_MS);
    const hostTimer = setInterval(fetchHostInfo, 15000);
    const processTimer = setInterval(fetchProcesses, 10000);

    return () => {
      clearInterval(metricsTimer);
      clearInterval(hostTimer);
      clearInterval(processTimer);
    };
  }, [connectionId, fetchHostInfo, collectMetrics, fetchProcesses]);

  // ── render ───────────────────────────────────────────────────────────
  return (
    <div className="monitor-pane">
      <div className="monitor-shell">
        <header className="monitor-header">
          <div className="monitor-header-left">
            <div className="monitor-title-area">
              <span className="monitor-pulse-dot" />
              <span className="monitor-kicker">系统监视器</span>
            </div>
            <strong className="monitor-hostname">{hostname}</strong>
            <div className="monitor-host-meta">
              {kernel ? <span className="monitor-meta-tag">{kernel}</span> : null}
              {uptimeLine ? <span className="monitor-meta-tag">{uptimeLine}</span> : null}
            </div>
          </div>
          <div className="monitor-header-right">
            <div className="monitor-refresh-info">
              <small>{refreshedAt ? `刷新于 ${formatDateTime(refreshedAt)}` : '等待首次读取'}</small>
            </div>
            <button type="button" className="monitor-refresh-btn" onClick={fetchHostInfo}>
              手动刷新
            </button>
          </div>
        </header>

        {statusError ? <div className="error-banner">{statusError}</div> : null}

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
          <SimpleLineChart
            data={diskData}
            color="#c084fc"
            fillColor="rgba(192,132,252,0.12)"
            unit="%"
            maxValue={100}
            label="磁盘占用"
          />
        </section>

        <ProcessTable
          processes={processes}
          isLoading={isProcessLoading}
          error={processError}
          onKill={killProcess}
          onRefresh={fetchProcesses}
        />
      </div>
    </div>
  );
}
