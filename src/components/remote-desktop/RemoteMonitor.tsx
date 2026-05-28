import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';

import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import type { RemoteProcessManagerLaunchOptions } from './RemoteProcessManager';
import type { RemoteSystemType } from './types';

interface RemoteMonitorProps {
  connectionId: string;
  systemType?: RemoteSystemType;
  onOpenProcessManager?: (options?: RemoteProcessManagerLaunchOptions) => void;
}

interface MonitorSample {
  timestamp: number;
  cpuPercent: number | null;
  memoryPercent: number | null;
  netRxBytesPerSec: number | null;
  netTxBytesPerSec: number | null;
}

interface ChartPoint {
  time: number;
  value: number | null;
}

interface ChartSeries {
  key: string;
  label: string;
  data: ChartPoint[];
  color: string;
  fillColor: string;
  yMin: number;
  yMax: number;
  axisFormatter: (value: number) => string;
  valueFormatter: (value: number) => string;
}

interface HoverState {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

const MAX_SAMPLES = 90;
const BACKGROUND_POLL_INTERVAL_MS = 5000;
const POLL_INTERVAL_OPTIONS = [2000, 5000, 10000] as const;
const DEFAULT_POLL_INTERVAL_MS = POLL_INTERVAL_OPTIONS[0];

type PollIntervalMs = (typeof POLL_INTERVAL_OPTIONS)[number];
type NullableMetricKey = keyof Omit<MonitorSample, 'timestamp'>;

function appendSample(samples: MonitorSample[], sample: MonitorSample) {
  return [...samples.slice(-(MAX_SAMPLES - 1)), sample];
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function readFiniteNumber(value: unknown) {
  if (isFiniteNumber(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsedValue = Number.parseFloat(value);
    return Number.isFinite(parsedValue) ? parsedValue : null;
  }

  return null;
}

function readPercent(value: unknown) {
  const numericValue = readFiniteNumber(value);
  return numericValue === null ? null : clamp(numericValue, 0, 100);
}

function readByteCounter(value: unknown) {
  const numericValue = readFiniteNumber(value);
  return numericValue !== null && numericValue >= 0 ? numericValue : null;
}

function getRatePerSecond(current: number | null, previous: number | null, seconds: number) {
  if (current === null || previous === null || seconds <= 0) {
    return null;
  }

  const delta = current - previous;
  return delta >= 0 && Number.isFinite(delta) ? delta / seconds : null;
}

function getMetricData(samples: MonitorSample[], key: NullableMetricKey): ChartPoint[] {
  return samples.map((sample) => ({
    time: sample.timestamp,
    value: sample[key],
  }));
}

function getNumericValues(data: ChartPoint[]) {
  return data
    .map((point) => point.value)
    .filter((value): value is number => isFiniteNumber(value));
}

function getLatestPoint(data: ChartPoint[]) {
  return data.length ? data[data.length - 1] : null;
}

function getNiceCeiling(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return 1;
  }

  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return nice * magnitude;
}

function getNetworkScale(data: ChartPoint[]) {
  const maxValue = Math.max(1, ...getNumericValues(data));
  return getNiceCeiling(maxValue * 1.12);
}

function formatPercent(value: number) {
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}%`;
}

function formatBytesPerSecond(value: number) {
  const absValue = Math.abs(value);

  if (absValue >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(absValue >= 10 * 1024 * 1024 ? 1 : 2)} MB/s`;
  }

  if (absValue >= 1024) {
    return `${(value / 1024).toFixed(absValue >= 10 * 1024 ? 0 : 1)} KB/s`;
  }

  return `${value.toFixed(0)} B/s`;
}

function formatTimeLabel(timestamp: number) {
  return new Intl.DateTimeFormat(getShellDeskLocale(), {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(timestamp));
}

function getChartPadding(width: number) {
  return {
    top: 14,
    right: 12,
    bottom: 26,
    left: width < 340 ? 46 : 56,
  };
}

function getSystemLabel(systemType?: RemoteSystemType) {
  if (systemType === 'windows') {
    return 'Windows';
  }

  if (systemType === 'macos') {
    return 'macOS';
  }

  if (systemType === 'unknown') {
    return '未知系统';
  }

  return 'Linux / Unix';
}

function getCssColor(element: HTMLElement, name: string, fallback: string) {
  return getComputedStyle(element).getPropertyValue(name).trim() || fallback;
}

function drawChart(
  canvas: HTMLCanvasElement,
  series: ChartSeries,
  hoverIndex: number | null,
  size: { width: number; height: number },
) {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, size.width);
  const height = Math.max(1, size.height);

  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return;
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const padding = getChartPadding(width);
  const plotWidth = Math.max(1, width - padding.left - padding.right);
  const plotHeight = Math.max(1, height - padding.top - padding.bottom);
  const yRange = Math.max(1, series.yMax - series.yMin);
  const gridColor = getCssColor(canvas, '--monitor-chart-grid', 'rgba(154, 177, 210, 0.12)');
  const axisColor = getCssColor(canvas, '--monitor-chart-axis', 'rgba(154, 177, 210, 0.22)');
  const mutedColor = getCssColor(canvas, '--monitor-chart-muted', '#8390a3');
  const emptyColor = getCssColor(canvas, '--monitor-chart-empty', '#748296');
  const crosshairColor = getCssColor(canvas, '--monitor-chart-crosshair', 'rgba(238, 244, 255, 0.34)');
  const fontFamily = getCssColor(canvas, '--interface-font-family', 'system-ui, sans-serif');

  ctx.lineWidth = 1;
  ctx.strokeStyle = gridColor;
  ctx.font = `10px ${fontFamily}`;
  ctx.textBaseline = 'middle';

  for (let index = 0; index <= 4; index += 1) {
    const y = padding.top + (plotHeight / 4) * index;
    const value = series.yMax - (yRange / 4) * index;

    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();

    ctx.fillStyle = mutedColor;
    ctx.textAlign = 'right';
    ctx.fillText(series.axisFormatter(value), padding.left - 7, y);
  }

  ctx.strokeStyle = axisColor;
  ctx.beginPath();
  ctx.moveTo(padding.left, padding.top);
  ctx.lineTo(padding.left, height - padding.bottom);
  ctx.lineTo(width - padding.right, height - padding.bottom);
  ctx.stroke();

  if (series.data.length > 1) {
    const labelIndexes = Array.from(new Set([0, Math.floor((series.data.length - 1) / 2), series.data.length - 1]));

    ctx.fillStyle = mutedColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    labelIndexes.forEach((dataIndex) => {
      const x = padding.left + (plotWidth / (series.data.length - 1)) * dataIndex;
      ctx.fillText(formatTimeLabel(series.data[dataIndex].time), x, height - 6);
    });
  }

  const points = series.data.map((point, index) => {
    const x = series.data.length > 1
      ? padding.left + (plotWidth / (series.data.length - 1)) * index
      : padding.left + plotWidth;
    const y = point.value === null
      ? null
      : padding.top + plotHeight - ((point.value - series.yMin) / yRange) * plotHeight;

    return {
      x,
      y,
      value: point.value,
    };
  });

  const numericPoints = points.filter((point) => point.value !== null && point.y !== null);

  if (numericPoints.length < 2) {
    ctx.fillStyle = emptyColor;
    ctx.font = `12px ${fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(numericPoints.length === 1 ? '继续采样中' : '暂无可用指标', width / 2, padding.top + plotHeight / 2);

    if (numericPoints.length === 1) {
      const point = numericPoints[0];
      ctx.beginPath();
      ctx.arc(point.x, point.y ?? padding.top + plotHeight, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = series.color;
      ctx.fill();
    }

    return;
  }

  const gradient = ctx.createLinearGradient(0, padding.top, 0, height - padding.bottom);
  gradient.addColorStop(0, series.fillColor);
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');

  let segment: Array<{ x: number; y: number }> = [];

  const flushSegment = () => {
    if (segment.length < 2) {
      segment = [];
      return;
    }

    ctx.beginPath();
    ctx.moveTo(segment[0].x, height - padding.bottom);
    segment.forEach((point) => ctx.lineTo(point.x, point.y));
    ctx.lineTo(segment[segment.length - 1].x, height - padding.bottom);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.beginPath();
    segment.forEach((point, index) => {
      if (index === 0) {
        ctx.moveTo(point.x, point.y);
      } else {
        ctx.lineTo(point.x, point.y);
      }
    });
    ctx.strokeStyle = series.color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    segment = [];
  };

  points.forEach((point) => {
    if (point.value === null || point.y === null) {
      flushSegment();
      return;
    }

    segment.push({ x: point.x, y: point.y });
  });
  flushSegment();

  const latestNumericPoint = [...points].reverse().find((point) => point.value !== null && point.y !== null);
  if (latestNumericPoint?.y !== null && latestNumericPoint?.y !== undefined) {
    ctx.beginPath();
    ctx.arc(latestNumericPoint.x, latestNumericPoint.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = series.color;
    ctx.shadowBlur = 10;
    ctx.shadowColor = series.color;
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  if (hoverIndex !== null && points[hoverIndex]) {
    const hoverPoint = points[hoverIndex];

    ctx.strokeStyle = crosshairColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(hoverPoint.x, padding.top);
    ctx.lineTo(hoverPoint.x, height - padding.bottom);
    ctx.stroke();

    if (hoverPoint.value !== null && hoverPoint.y !== null) {
      ctx.beginPath();
      ctx.arc(hoverPoint.x, hoverPoint.y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(hoverPoint.x, hoverPoint.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = series.color;
      ctx.fill();
    }
  }
}

function MetricLineChart({ series }: { series: ChartSeries }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [hoverState, setHoverState] = useState<HoverState | null>(null);

  const latestPoint = getLatestPoint(series.data);
  const latestLabel = latestPoint?.value === null || latestPoint?.value === undefined
    ? '暂无数据'
    : series.valueFormatter(latestPoint.value);
  const hasData = getNumericValues(series.data).length > 0;
  const hoveredPoint = hoverState ? series.data[hoverState.index] : null;
  const tooltipStyle: CSSProperties | undefined = hoverState
    ? {
        left: clamp(hoverState.x + 12, 8, Math.max(8, hoverState.width - 136)),
        top: clamp(hoverState.y - 46, 8, Math.max(8, hoverState.height - 58)),
      }
    : undefined;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return undefined;
    }

    const updateSize = () => {
      const rect = canvas.getBoundingClientRect();
      setCanvasSize({
        width: rect.width,
        height: rect.height,
      });
    };

    updateSize();
    const resizeObserver = new ResizeObserver(updateSize);
    resizeObserver.observe(canvas);

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || canvasSize.width <= 0 || canvasSize.height <= 0) {
      return;
    }

    drawChart(canvas, series, hoverState?.index ?? null, canvasSize);
  }, [canvasSize, hoverState?.index, series]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!series.data.length) {
      setHoverState(null);
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const padding = getChartPadding(rect.width);
    const plotWidth = Math.max(1, rect.width - padding.left - padding.right);
    const pointerX = clamp(event.clientX - rect.left, 0, rect.width);
    const pointerY = clamp(event.clientY - rect.top, 0, rect.height);
    const ratio = clamp((pointerX - padding.left) / plotWidth, 0, 1);
    const nextIndex = Math.round(ratio * (series.data.length - 1));

    setHoverState({
      index: nextIndex,
      x: pointerX,
      y: pointerY,
      width: rect.width,
      height: rect.height,
    });
  }, [series.data]);

  return (
    <article
      className={`monitor-chart-card ${hasData ? '' : 'is-empty'}`}
      style={{ '--series-color': series.color } as CSSProperties}
    >
      <div className="chart-card-head">
        <span className="chart-card-label">{series.label}</span>
        <span className={latestPoint?.value === null || latestPoint?.value === undefined ? 'chart-card-value muted' : 'chart-card-value'}>
          {latestLabel}
        </span>
      </div>
      <div className="monitor-chart-body">
        <canvas
          ref={canvasRef}
          className="monitor-chart-canvas"
          aria-label={`${series.label}趋势图`}
          onPointerLeave={() => setHoverState(null)}
          onPointerMove={handlePointerMove}
        />
        {hoverState && hoveredPoint && (
          <div className="monitor-chart-tooltip" style={tooltipStyle}>
            <span>{formatTimeLabel(hoveredPoint.time)}</span>
            <strong>
              {hoveredPoint.value === null ? '无数据' : series.valueFormatter(hoveredPoint.value)}
            </strong>
          </div>
        )}
      </div>
    </article>
  );
}

export default function RemoteMonitor({ connectionId, systemType, onOpenProcessManager }: RemoteMonitorProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const isMountedRef = useRef(true);
  const isPollingRef = useRef(false);
  const requestSequenceRef = useRef(0);
  const prevNetworkRef = useRef<{ rx: number | null; tx: number | null; time: number } | null>(null);
  const [samples, setSamples] = useState<MonitorSample[]>([]);
  const [pollIntervalMs, setPollIntervalMs] = useState<PollIntervalMs>(DEFAULT_POLL_INTERVAL_MS);
  const [isWindowActive, setIsWindowActive] = useState(true);
  const [lastSampleAt, setLastSampleAt] = useState<number | null>(null);
  const [metricsError, setMetricsError] = useState<string | null>(null);

  const effectivePollIntervalMs = isWindowActive
    ? pollIntervalMs
    : Math.max(pollIntervalMs, BACKGROUND_POLL_INTERVAL_MS);

  const collectMetrics = useCallback(async () => {
    const api = window.guiSSH?.connections;
    const requestId = requestSequenceRef.current + 1;

    if (isPollingRef.current) {
      return;
    }

    if (!api) {
      const sampleTime = Date.now();
      setSamples((currentSamples) => appendSample(currentSamples, {
        timestamp: sampleTime,
        cpuPercent: null,
        memoryPercent: null,
        netRxBytesPerSec: null,
        netTxBytesPerSec: null,
      }));
      setLastSampleAt(sampleTime);
      setMetricsError('ShellDesk IPC 未就绪');
      return;
    }

    isPollingRef.current = true;
    requestSequenceRef.current = requestId;

    try {
      const metrics = await api.getMetrics(connectionId);
      const sampleTime = Date.now();

      if (!isMountedRef.current || requestId !== requestSequenceRef.current) {
        return;
      }

      const rx = readByteCounter(metrics.netRxBytes);
      const tx = readByteCounter(metrics.netTxBytes);
      const previousNetwork = prevNetworkRef.current;
      const seconds = previousNetwork ? Math.max(0.001, (sampleTime - previousNetwork.time) / 1000) : 0;

      const sample: MonitorSample = {
        timestamp: sampleTime,
        cpuPercent: readPercent(metrics.cpuPercent),
        memoryPercent: readPercent(metrics.memoryPercent),
        netRxBytesPerSec: previousNetwork ? getRatePerSecond(rx, previousNetwork.rx, seconds) : null,
        netTxBytesPerSec: previousNetwork ? getRatePerSecond(tx, previousNetwork.tx, seconds) : null,
      };

      prevNetworkRef.current = { rx, tx, time: sampleTime };
      setSamples((currentSamples) => appendSample(currentSamples, sample));
      setLastSampleAt(sampleTime);
      setMetricsError(null);
    } catch (error) {
      const sampleTime = Date.now();

      if (!isMountedRef.current || requestId !== requestSequenceRef.current) {
        return;
      }

      prevNetworkRef.current = null;
      setSamples((currentSamples) => appendSample(currentSamples, {
        timestamp: sampleTime,
        cpuPercent: null,
        memoryPercent: null,
        netRxBytesPerSec: null,
        netTxBytesPerSec: null,
      }));
      setLastSampleAt(sampleTime);
      setMetricsError(getErrorMessage(error));
    } finally {
      if (requestId === requestSequenceRef.current) {
        isPollingRef.current = false;
      }
    }
  }, [connectionId]);

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      isPollingRef.current = false;
      requestSequenceRef.current += 1;
    };
  }, []);

  useEffect(() => {
    requestSequenceRef.current += 1;
    prevNetworkRef.current = null;
    isPollingRef.current = false;
    setSamples([]);
    setLastSampleAt(null);
    setMetricsError(null);
  }, [connectionId]);

  useEffect(() => {
    const readWindowActiveState = () => {
      const desktopWindow = rootRef.current?.closest('.desktop-window');

      if (desktopWindow) {
        return desktopWindow.classList.contains('focused') && !desktopWindow.classList.contains('minimized');
      }

      return document.visibilityState === 'visible' && document.hasFocus();
    };

    const syncWindowActiveState = () => {
      setIsWindowActive(readWindowActiveState());
    };

    syncWindowActiveState();
    window.addEventListener('focus', syncWindowActiveState);
    window.addEventListener('blur', syncWindowActiveState);
    document.addEventListener('visibilitychange', syncWindowActiveState);

    const desktopWindow = rootRef.current?.closest('.desktop-window');
    const observer = desktopWindow ? new MutationObserver(syncWindowActiveState) : null;
    observer?.observe(desktopWindow!, {
      attributes: true,
      attributeFilter: ['class'],
    });

    return () => {
      window.removeEventListener('focus', syncWindowActiveState);
      window.removeEventListener('blur', syncWindowActiveState);
      document.removeEventListener('visibilitychange', syncWindowActiveState);
      observer?.disconnect();
    };
  }, []);

  useEffect(() => {
    let canceled = false;
    let timerId: number | undefined;

    const scheduleNextTick = () => {
      if (canceled) {
        return;
      }

      timerId = window.setTimeout(() => {
        void tick();
      }, effectivePollIntervalMs);
    };

    const tick = async () => {
      await collectMetrics();
      scheduleNextTick();
    };

    void tick();

    return () => {
      canceled = true;
      if (timerId !== undefined) {
        window.clearTimeout(timerId);
      }
    };
  }, [collectMetrics, effectivePollIntervalMs]);

  const chartSeries = useMemo<ChartSeries[]>(() => {
    const cpuData = getMetricData(samples, 'cpuPercent');
    const memoryData = getMetricData(samples, 'memoryPercent');
    const rxData = getMetricData(samples, 'netRxBytesPerSec');
    const txData = getMetricData(samples, 'netTxBytesPerSec');

    return [
      {
        key: 'cpu',
        label: 'CPU 使用率',
        data: cpuData,
        color: '#67b7ff',
        fillColor: 'rgba(103, 183, 255, 0.2)',
        yMin: 0,
        yMax: 100,
        axisFormatter: formatPercent,
        valueFormatter: formatPercent,
      },
      {
        key: 'memory',
        label: '内存使用率',
        data: memoryData,
        color: '#f08cc8',
        fillColor: 'rgba(240, 140, 200, 0.18)',
        yMin: 0,
        yMax: 100,
        axisFormatter: formatPercent,
        valueFormatter: formatPercent,
      },
      {
        key: 'net-tx',
        label: '网络上传',
        data: txData,
        color: '#ffcf5a',
        fillColor: 'rgba(255, 207, 90, 0.16)',
        yMin: 0,
        yMax: getNetworkScale(txData),
        axisFormatter: formatBytesPerSecond,
        valueFormatter: formatBytesPerSecond,
      },
      {
        key: 'net-rx',
        label: '网络下载',
        data: rxData,
        color: '#6ee7a8',
        fillColor: 'rgba(110, 231, 168, 0.16)',
        yMin: 0,
        yMax: getNetworkScale(rxData),
        axisFormatter: formatBytesPerSecond,
        valueFormatter: formatBytesPerSecond,
      },
    ];
  }, [samples]);

  return (
    <div ref={rootRef} className="monitor-pane">
      <div className="monitor-shell">
        <div className="monitor-control-bar">
          <div className="monitor-sampling-state">
            <span className={`monitor-sampling-dot ${metricsError ? 'error' : isWindowActive ? 'active' : 'idle'}`} />
            <strong>{metricsError ? '采样异常' : isWindowActive ? '实时采样' : '低频采样'}</strong>
            <small>{lastSampleAt ? formatTimeLabel(lastSampleAt) : getSystemLabel(systemType)}</small>
          </div>

          <div className="monitor-control-actions">
            {onOpenProcessManager ? (
              <>
                <button
                  type="button"
                  className="monitor-proc-button"
                  onClick={() => onOpenProcessManager({ sortKey: 'cpu', sortDir: 'desc', viewMode: 'table' })}
                >
                  CPU 进程
                </button>
                <button
                  type="button"
                  className="monitor-proc-button"
                  onClick={() => onOpenProcessManager({ sortKey: 'memory', sortDir: 'desc', viewMode: 'table' })}
                >
                  内存进程
                </button>
              </>
            ) : null}

            <div className="monitor-interval-control" aria-label="采样间隔">
              {POLL_INTERVAL_OPTIONS.map((interval) => (
                <button
                  key={interval}
                  type="button"
                  className={pollIntervalMs === interval ? 'active' : ''}
                  onClick={() => setPollIntervalMs(interval)}
                >
                  {interval / 1000}s
                </button>
              ))}
            </div>
          </div>
        </div>

        {metricsError && <div className="monitor-error-strip">{metricsError}</div>}

        <section className="monitor-charts-grid" aria-label="系统指标趋势">
          {chartSeries.map((series) => (
            <MetricLineChart key={series.key} series={series} />
          ))}
        </section>
      </div>
    </div>
  );
}
