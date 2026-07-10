import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';

import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import {
  MonitorPersistenceDialog,
  type MonitorPersistenceDialogMode,
} from './MonitorPersistenceViews';
import type { RemoteProcessManagerLaunchOptions } from './RemoteProcessManager';
import type { RemoteSystemType } from './types';
import { tCurrent } from '../../i18n';

interface RemoteMonitorProps {
  connectionId: string;
  hostId?: string;
  systemType?: RemoteSystemType;
  onOpenProcessManager?: (options?: RemoteProcessManagerLaunchOptions) => void;
}

interface MonitorSample {
  timestamp: number;
  cpuPercent: number | null;
  memoryPercent: number | null;
  diskPercent: number | null;
  netRxBytesPerSec: number | null;
  netTxBytesPerSec: number | null;
}

interface ChartPoint {
  time: number;
  value: number | null;
}

interface ChartLine {
  key: string;
  label: string;
  shortLabel: string;
  data: ChartPoint[];
  color: string;
  fillColor: string;
}

interface ChartSeries {
  key: string;
  label: string;
  lines: ChartLine[];
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
const HISTORY_REFRESH_INTERVAL_MS = 60_000;
const POLL_INTERVAL_OPTIONS = [2000, 5000, 10000] as const;
const DEFAULT_POLL_INTERVAL_MS = POLL_INTERVAL_OPTIONS[0];
const PERSISTENCE_PROMPT_KEY_PREFIX = 'shelldesk.monitor.persistencePrompt.v1';
const HISTORY_RANGE_OPTIONS = [
  { value: 60 * 60 * 1000, label: '1h', limit: 24 },
  { value: 6 * 60 * 60 * 1000, label: '6h', limit: 96 },
  { value: 24 * 60 * 60 * 1000, label: '24h', limit: 360 },
  { value: 7 * 24 * 60 * 60 * 1000, label: '7d', limit: 2200 },
] as const;
const DEFAULT_HISTORY_RANGE_MS = HISTORY_RANGE_OPTIONS[2].value;

type PollIntervalMs = (typeof POLL_INTERVAL_OPTIONS)[number];
type HistoryRangeMs = (typeof HISTORY_RANGE_OPTIONS)[number]['value'];
type MonitorDataMode = 'realtime' | 'history';
type NullableMetricKey = 'cpuPercent' | 'memoryPercent' | 'diskPercent' | 'netRxBytesPerSec' | 'netTxBytesPerSec';

function getPersistencePromptKey(hostId: string) {
  return `${PERSISTENCE_PROMPT_KEY_PREFIX}.${hostId}`;
}

function hasPersistencePromptDecision(hostId: string) {
  try {
    return window.localStorage.getItem(getPersistencePromptKey(hostId)) === 'decided';
  } catch {
    return false;
  }
}

function rememberPersistencePromptDecision(hostId: string) {
  try {
    window.localStorage.setItem(getPersistencePromptKey(hostId), 'decided');
  } catch {
    // Local preference storage is best-effort; monitoring still works without it.
  }
}

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

function getNetworkScale(...dataSets: ChartPoint[][]) {
  const maxValue = Math.max(1, ...dataSets.flatMap(getNumericValues));
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
    return tCurrent('auto.remoteMonitor.1tfi1cy');
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
  const timeline = series.lines[0]?.data ?? [];

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

  if (timeline.length > 1) {
    const labelIndexes = Array.from(new Set([0, Math.floor((timeline.length - 1) / 2), timeline.length - 1]));

    ctx.fillStyle = mutedColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    labelIndexes.forEach((dataIndex) => {
      const x = padding.left + (plotWidth / (timeline.length - 1)) * dataIndex;
      ctx.fillText(formatTimeLabel(timeline[dataIndex].time), x, height - 6);
    });
  }

  const chartLines = series.lines.map((line) => {
    const points = line.data.map((point, index) => {
      const x = line.data.length > 1
        ? padding.left + (plotWidth / (line.data.length - 1)) * index
        : padding.left + plotWidth;
      const y = point.value === null
        ? null
        : padding.top + plotHeight - ((point.value - series.yMin) / yRange) * plotHeight;
      return { x, y, value: point.value };
    });
    return {
      line,
      points,
      numericPoints: points.filter((point) => point.value !== null && point.y !== null),
    };
  });
  const numericPointCount = chartLines.reduce((count, line) => count + line.numericPoints.length, 0);

  if (!chartLines.some((line) => line.numericPoints.length >= 2)) {
    ctx.fillStyle = emptyColor;
    ctx.font = `12px ${fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(numericPointCount ? tCurrent('auto.remoteMonitor.yf2cti') : tCurrent('auto.remoteMonitor.tx52m'), width / 2, padding.top + plotHeight / 2);
    chartLines.forEach(({ line, numericPoints }) => {
      numericPoints.forEach((point) => {
        ctx.beginPath();
        ctx.arc(point.x, point.y ?? padding.top + plotHeight, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = line.color;
        ctx.fill();
      });
    });

    return;
  }

  chartLines.forEach(({ line, points }) => {
    const gradient = ctx.createLinearGradient(0, padding.top, 0, height - padding.bottom);
    gradient.addColorStop(0, line.fillColor);
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
        if (index === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      });
      ctx.strokeStyle = line.color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
      segment = [];
    };
    points.forEach((point) => {
      if (point.value === null || point.y === null) {
        flushSegment();
      } else {
        segment.push({ x: point.x, y: point.y });
      }
    });
    flushSegment();

    const latestNumericPoint = [...points].reverse().find((point) => point.value !== null && point.y !== null);
    if (latestNumericPoint?.y !== null && latestNumericPoint?.y !== undefined) {
      ctx.beginPath();
      ctx.arc(latestNumericPoint.x, latestNumericPoint.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = line.color;
      ctx.shadowBlur = 10;
      ctx.shadowColor = line.color;
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  });

  if (hoverIndex !== null && timeline[hoverIndex]) {
    const hoverX = timeline.length > 1
      ? padding.left + (plotWidth / (timeline.length - 1)) * hoverIndex
      : padding.left + plotWidth;

    ctx.strokeStyle = crosshairColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(hoverX, padding.top);
    ctx.lineTo(hoverX, height - padding.bottom);
    ctx.stroke();

    chartLines.forEach(({ line, points }) => {
      const hoverPoint = points[hoverIndex];
      if (!hoverPoint || hoverPoint.value === null || hoverPoint.y === null) return;
      ctx.beginPath();
      ctx.arc(hoverPoint.x, hoverPoint.y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(hoverPoint.x, hoverPoint.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = line.color;
      ctx.fill();
    });
  }
}

function MetricLineChart({ series }: { series: ChartSeries }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [hoverState, setHoverState] = useState<HoverState | null>(null);

  const timeline = series.lines[0]?.data ?? [];
  const latestLines = series.lines.map((line) => ({ line, point: getLatestPoint(line.data) }));
  const hasData = series.lines.some((line) => getNumericValues(line.data).length > 0);
  const hoveredTime = hoverState ? timeline[hoverState.index]?.time : null;
  const tooltipStyle: CSSProperties | undefined = hoverState
    ? {
        left: clamp(hoverState.x + 12, 8, Math.max(8, hoverState.width - 188)),
        top: clamp(hoverState.y - 46 - Math.max(0, series.lines.length - 1) * 23, 8, Math.max(8, hoverState.height - 82)),
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
    if (!timeline.length) {
      setHoverState(null);
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const padding = getChartPadding(rect.width);
    const plotWidth = Math.max(1, rect.width - padding.left - padding.right);
    const pointerX = clamp(event.clientX - rect.left, 0, rect.width);
    const pointerY = clamp(event.clientY - rect.top, 0, rect.height);
    const ratio = clamp((pointerX - padding.left) / plotWidth, 0, 1);
    const nextIndex = Math.round(ratio * (timeline.length - 1));

    setHoverState({
      index: nextIndex,
      x: pointerX,
      y: pointerY,
      width: rect.width,
      height: rect.height,
    });
  }, [timeline]);

  return (
    <article
      className={`monitor-chart-card ${hasData ? '' : 'is-empty'}`}
      data-series-key={series.key}
      style={{ '--series-color': series.lines[0]?.color ?? '#67b7ff' } as CSSProperties}
    >
      <div className="chart-card-head">
        <span className="chart-card-label">{series.label}</span>
        <div className="chart-card-values">
          {latestLines.map(({ line, point }) => {
            const value = point?.value;
            const hasValue = value !== null && value !== undefined;
            return (
              <span key={line.key} className={hasValue ? 'chart-card-value' : 'chart-card-value muted'} style={{ color: hasValue ? line.color : undefined }}>
                {line.shortLabel ? <b>{line.shortLabel}</b> : null}
                {hasValue ? series.valueFormatter(value) : tCurrent('auto.remoteMonitor.6tzr61')}
              </span>
            );
          })}
        </div>
      </div>
      <div className="monitor-chart-body">
        <canvas
          ref={canvasRef}
          className="monitor-chart-canvas"
          aria-label={tCurrent('auto.remoteMonitor.19etan4', { value0: series.label })}
          onPointerLeave={() => setHoverState(null)}
          onPointerMove={handlePointerMove}
        />
        {hoverState && hoveredTime ? (
          <div className="monitor-chart-tooltip" style={tooltipStyle}>
            <span>{formatTimeLabel(hoveredTime)}</span>
            {series.lines.map((line) => {
              const point = line.data[hoverState.index];
              return (
                <strong key={line.key} style={{ color: line.color }}>
                  {line.label}: {point?.value === null || point?.value === undefined
                    ? tCurrent('auto.remoteMonitor.13dbhhl')
                    : series.valueFormatter(point.value)}
                </strong>
              );
            })}
          </div>
        ) : null}
      </div>
    </article>
  );
}

export default function RemoteMonitor({ connectionId, hostId, systemType, onOpenProcessManager }: RemoteMonitorProps) {
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
  const [dataMode, setDataMode] = useState<MonitorDataMode>('realtime');
  const [persistenceStatus, setPersistenceStatus] = useState<ShellDeskMonitorPersistenceStatus | null>(null);
  const [historySamples, setHistorySamples] = useState<ShellDeskMonitorHistorySample[]>([]);
  const [historyRangeMs, setHistoryRangeMs] = useState<HistoryRangeMs>(DEFAULT_HISTORY_RANGE_MS);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const [persistencePending, setPersistencePending] = useState(false);
  const [persistenceDialog, setPersistenceDialog] = useState<MonitorPersistenceDialogMode>(null);
  const [thresholdDraft, setThresholdDraft] = useState<ShellDeskMonitorThresholds>({ cpu: 90, memory: 90, disk: 85 });
  const persistenceHostId = hostId || connectionId;

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
        diskPercent: null,
        netRxBytesPerSec: null,
        netTxBytesPerSec: null,
      }));
      setLastSampleAt(sampleTime);
      setMetricsError(tCurrent('auto.remoteMonitor.1bx8guv'));
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
        diskPercent: null,
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
        diskPercent: null,
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

  const loadHistory = useCallback(async () => {
    const api = window.guiSSH?.connections;
    if (!api?.getMonitorHistory) {
      setPersistenceError(tCurrent('monitor.persistence.apiUnavailable'));
      return;
    }
    const range = HISTORY_RANGE_OPTIONS.find((option) => option.value === historyRangeMs) ?? HISTORY_RANGE_OPTIONS[2];
    try {
      const report = await api.getMonitorHistory(connectionId, Date.now() - historyRangeMs, range.limit);
      if (!isMountedRef.current) {
        return;
      }
      setHistorySamples(Array.isArray(report.samples) ? report.samples : []);
      setThresholdDraft(report.thresholds);
      setPersistenceError(null);
    } catch (error) {
      if (isMountedRef.current) {
        setPersistenceError(getErrorMessage(error));
      }
    }
  }, [connectionId, historyRangeMs]);

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
    setDataMode('realtime');
    setPersistenceStatus(null);
    setHistorySamples([]);
    setPersistenceError(null);
    setPersistenceDialog(null);
  }, [connectionId]);

  useEffect(() => {
    if (dataMode !== 'realtime') {
      return undefined;
    }
    let canceled = false;
    const api = window.guiSSH?.connections;

    if (!api?.getMonitorPersistenceStatus) {
      setPersistenceError(tCurrent('monitor.persistence.apiUnavailable'));
      return undefined;
    }

    void api.getMonitorPersistenceStatus(connectionId).then((status) => {
      if (canceled || !isMountedRef.current) {
        return;
      }
      setPersistenceStatus(status);
      setThresholdDraft(status.thresholds);
      setPersistenceError(null);
      if (status.enabled) {
        rememberPersistencePromptDecision(persistenceHostId);
        setDataMode('history');
      } else if (!status.configured && !hasPersistencePromptDecision(persistenceHostId)) {
        setPersistenceDialog('intro');
      }
    }).catch((error) => {
      if (!canceled && isMountedRef.current) {
        setPersistenceError(getErrorMessage(error));
      }
    });

    return () => {
      canceled = true;
    };
  }, [connectionId, persistenceHostId]);

  const setPersistentCollectionEnabled = useCallback(async (enabled: boolean) => {
    const api = window.guiSSH?.connections;
    if (!api?.setMonitorPersistenceEnabled) {
      setPersistenceError(tCurrent('monitor.persistence.apiUnavailable'));
      return;
    }
    setPersistencePending(true);
    setPersistenceError(null);
    try {
      const status = await api.setMonitorPersistenceEnabled(connectionId, enabled);
      if (!isMountedRef.current) {
        return;
      }
      setPersistenceStatus(status);
      setThresholdDraft(status.thresholds);
      rememberPersistencePromptDecision(persistenceHostId);
      setPersistenceDialog(null);
      if (enabled) {
        setDataMode('history');
      }
    } catch (error) {
      if (isMountedRef.current) {
        setPersistenceError(getErrorMessage(error));
      }
    } finally {
      if (isMountedRef.current) {
        setPersistencePending(false);
      }
    }
  }, [connectionId, persistenceHostId]);

  const saveThresholds = useCallback(async () => {
    const api = window.guiSSH?.connections;
    if (!api?.setMonitorThresholds) {
      setPersistenceError(tCurrent('monitor.persistence.apiUnavailable'));
      return;
    }
    setPersistencePending(true);
    setPersistenceError(null);
    try {
      const result = await api.setMonitorThresholds(connectionId, thresholdDraft);
      if (!isMountedRef.current) {
        return;
      }
      setPersistenceStatus((current) => current ? { ...current, thresholds: result.thresholds } : current);
      setThresholdDraft(result.thresholds);
      setPersistenceDialog(null);
      await loadHistory();
    } catch (error) {
      if (isMountedRef.current) {
        setPersistenceError(getErrorMessage(error));
      }
    } finally {
      if (isMountedRef.current) {
        setPersistencePending(false);
      }
    }
  }, [connectionId, loadHistory, thresholdDraft]);

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
  }, [collectMetrics, dataMode, effectivePollIntervalMs]);

  useEffect(() => {
    if (dataMode !== 'history' || !persistenceStatus?.configured) {
      return undefined;
    }
    let canceled = false;
    let timerId: number | undefined;

    const tick = async () => {
      await loadHistory();
      if (!canceled) {
        timerId = window.setTimeout(() => void tick(), HISTORY_REFRESH_INTERVAL_MS);
      }
    };
    void tick();

    return () => {
      canceled = true;
      if (timerId !== undefined) {
        window.clearTimeout(timerId);
      }
    };
  }, [dataMode, loadHistory, persistenceStatus?.configured]);

  const displayedSamples: MonitorSample[] = dataMode === 'history' ? historySamples : samples;

  const chartSeries = useMemo<ChartSeries[]>(() => {
    const cpuData = getMetricData(displayedSamples, 'cpuPercent');
    const memoryData = getMetricData(displayedSamples, 'memoryPercent');
    const diskData = getMetricData(displayedSamples, 'diskPercent');
    const rxData = getMetricData(displayedSamples, 'netRxBytesPerSec');
    const txData = getMetricData(displayedSamples, 'netTxBytesPerSec');

    const series: ChartSeries[] = [
      {
        key: 'cpu',
        label: tCurrent('auto.remoteMonitor.rvar35'),
        lines: [{
          key: 'cpu',
          label: tCurrent('auto.remoteMonitor.rvar35'),
          shortLabel: '',
          data: cpuData,
          color: '#67b7ff',
          fillColor: 'rgba(103, 183, 255, 0.2)',
        }],
        yMin: 0,
        yMax: 100,
        axisFormatter: formatPercent,
        valueFormatter: formatPercent,
      },
      {
        key: 'memory',
        label: tCurrent('auto.remoteMonitor.ryd6gw'),
        lines: [{
          key: 'memory',
          label: tCurrent('auto.remoteMonitor.ryd6gw'),
          shortLabel: '',
          data: memoryData,
          color: '#f08cc8',
          fillColor: 'rgba(240, 140, 200, 0.18)',
        }],
        yMin: 0,
        yMax: 100,
        axisFormatter: formatPercent,
        valueFormatter: formatPercent,
      },
      {
        key: 'network',
        label: tCurrent('monitor.network.traffic'),
        lines: [
          {
            key: 'net-tx',
            label: tCurrent('auto.remoteMonitor.1jwv6je'),
            shortLabel: '↑',
            data: txData,
            color: '#ffcf5a',
            fillColor: 'rgba(255, 207, 90, 0.12)',
          },
          {
            key: 'net-rx',
            label: tCurrent('auto.remoteMonitor.tnorfo'),
            shortLabel: '↓',
            data: rxData,
            color: '#6ee7a8',
            fillColor: 'rgba(110, 231, 168, 0.1)',
          },
        ],
        yMin: 0,
        yMax: getNetworkScale(txData, rxData),
        axisFormatter: formatBytesPerSecond,
        valueFormatter: formatBytesPerSecond,
      },
    ];
    if (dataMode === 'history') {
      series.splice(2, 0, {
        key: 'disk',
        label: tCurrent('monitor.alert.metric.disk'),
        lines: [{
          key: 'disk',
          label: tCurrent('monitor.alert.metric.disk'),
          shortLabel: '',
          data: diskData,
          color: '#a78bfa',
          fillColor: 'rgba(167, 139, 250, 0.18)',
        }],
        yMin: 0,
        yMax: 100,
        axisFormatter: formatPercent,
        valueFormatter: formatPercent,
      });
    }
    return series;
  }, [dataMode, displayedSamples]);

  const latestHistorySample = historySamples.length ? historySamples[historySamples.length - 1] : null;
  const activeError = dataMode === 'history' ? persistenceError : metricsError;
  const activeSampleAt = dataMode === 'history' ? latestHistorySample?.timestamp ?? persistenceStatus?.lastSampleAt ?? null : lastSampleAt;
  const samplingStateClass = activeError
    ? 'error'
    : dataMode === 'history'
      ? persistenceStatus?.enabled ? 'active' : 'idle'
      : isWindowActive ? 'active' : 'idle';
  const samplingStateLabel = activeError
    ? tCurrent('auto.remoteMonitor.1x0ix9t')
    : dataMode === 'history'
      ? persistenceStatus?.enabled ? tCurrent('monitor.persistence.scheduledAnalysis') : tCurrent('monitor.persistence.paused')
      : isWindowActive ? tCurrent('auto.remoteMonitor.5dpl6b') : tCurrent('auto.remoteMonitor.9a9ara');
  const samplePointCount = dataMode === 'history' ? historySamples.length : samples.length;

  const closePersistenceDialog = () => {
    setPersistenceDialog(null);
    setPersistenceError(null);
  };

  return (
    <div ref={rootRef} className="monitor-pane">
      <div className={`monitor-shell mode-${dataMode} ${activeError ? 'has-error' : ''}`}>
        <div className="monitor-control-bar">
          <div className="monitor-sampling-state">
            <span className={`monitor-sampling-dot ${samplingStateClass}`} />
            <strong>{samplingStateLabel}</strong>
            <small>{activeSampleAt ? formatTimeLabel(activeSampleAt) : getSystemLabel(systemType)}</small>
            <small className="monitor-sample-count">{tCurrent('monitor.persistence.sampleCount', { count: samplePointCount })}</small>
          </div>

          <div className="monitor-control-actions">
            {persistenceStatus?.configured ? (
              <div className="monitor-mode-control" aria-label={tCurrent('monitor.persistence.dataSource')}>
                <button type="button" className={dataMode === 'realtime' ? 'active' : ''} onClick={() => setDataMode('realtime')}>
                  {tCurrent('monitor.persistence.realtime')}
                </button>
                <button type="button" className={dataMode === 'history' ? 'active' : ''} onClick={() => setDataMode('history')}>
                  {tCurrent('monitor.persistence.history')}
                </button>
              </div>
            ) : null}

            {onOpenProcessManager ? (
              <>
                <button
                  type="button"
                  className="monitor-proc-button"
                  onClick={() => onOpenProcessManager({ sortKey: 'cpu', sortDir: 'desc', viewMode: 'table' })}
                >
                  {tCurrent('auto.remoteMonitor.7cjarl')}
                </button>
                <button
                  type="button"
                  className="monitor-proc-button"
                  onClick={() => onOpenProcessManager({ sortKey: 'memory', sortDir: 'desc', viewMode: 'table' })}
                >
                  {tCurrent('auto.remoteMonitor.1ph5hdy')}
                </button>
              </>
            ) : null}

            {dataMode === 'realtime' ? (
              <div className="monitor-interval-control" aria-label={tCurrent('auto.remoteMonitor.qnrx5f')}>
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
            ) : (
              <div className="monitor-interval-control" aria-label={tCurrent('monitor.persistence.historyRange')}>
                {HISTORY_RANGE_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={historyRangeMs === option.value ? 'active' : ''}
                    onClick={() => setHistoryRangeMs(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )}

            {dataMode === 'history' && persistenceStatus?.configured ? (
              <button
                type="button"
                className="monitor-proc-button"
                onClick={() => {
                  setPersistenceError(null);
                  setThresholdDraft(persistenceStatus.thresholds);
                  setPersistenceDialog('thresholds');
                }}
              >
                {tCurrent('monitor.alert.configure')}
              </button>
            ) : null}

            <button
              type="button"
              className={`monitor-persistence-toggle ${persistenceStatus?.enabled ? 'enabled' : ''}`}
              disabled={persistencePending || !persistenceStatus}
              onClick={() => {
                setPersistenceError(null);
                setPersistenceDialog(persistenceStatus?.enabled ? 'disable' : 'intro');
              }}
            >
              {persistenceStatus?.enabled
                ? tCurrent('monitor.persistence.disable')
                : tCurrent('monitor.persistence.enable')}
            </button>
          </div>
        </div>

        {activeError && <div className="monitor-error-strip">{activeError}</div>}

        <section className={`monitor-charts-grid mode-${dataMode}`} aria-label={tCurrent('auto.remoteMonitor.1svf0iv')}>
          {chartSeries.map((series) => (
            <MetricLineChart key={series.key} series={series} />
          ))}
        </section>
      </div>

      <MonitorPersistenceDialog
        mode={persistenceDialog}
        pending={persistencePending}
        error={persistenceError}
        thresholds={thresholdDraft}
        onThresholdsChange={setThresholdDraft}
        onDeclineIntro={() => {
          rememberPersistencePromptDecision(persistenceHostId);
          closePersistenceDialog();
        }}
        onEnable={() => void setPersistentCollectionEnabled(true)}
        onCancel={closePersistenceDialog}
        onDisable={() => void setPersistentCollectionEnabled(false)}
        onSaveThresholds={() => void saveThresholds()}
      />
    </div>
  );
}
