import { useEffect, useMemo, useRef, useState } from 'react';

import { formatDateTime, getErrorMessage } from './desktopUtils';

interface RemoteMonitorProps {
  connectionId: string;
}

interface RemoteStatusItem {
  key: string;
  label: string;
  value: string;
}

interface RemoteStatusReport {
  refreshedAt: string;
  items: RemoteStatusItem[];
}

interface MonitorMetric {
  key: string;
  label: string;
  value: string;
  detail: string;
  icon: string;
  progress?: number;
  progressColor?: string;
}

function getStatusLines(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function getFirstStatusLine(value: string) {
  return getStatusLines(value)[0] ?? '\u2014';
}

function clampProgress(value: number) {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function parseNumericToken(value: string) {
  return Number.parseFloat(value.replace(',', '.'));
}

function getProgressColor(progress: number) {
  if (progress >= 90) return 'critical';
  if (progress >= 70) return 'warning';
  return 'normal';
}

function parseLoadMetric(value: string): Omit<MonitorMetric, 'key' | 'label' | 'icon'> | null {
  const match = value.match(/load averages?:\s*([0-9]+(?:[.,][0-9]+)?)[,\s]+([0-9]+(?:[.,][0-9]+)?)[,\s]+([0-9]+(?:[.,][0-9]+)?)/i);

  if (!match) {
    return null;
  }

  const [, oneMinute, fiveMinutes, fifteenMinutes] = match;
  const oneMinuteValue = parseNumericToken(oneMinute);
  const progress = Number.isFinite(oneMinuteValue) ? clampProgress((oneMinuteValue / 2) * 100) : undefined;

  return {
    value: oneMinute,
    detail: `5 分钟 ${fiveMinutes} \u00B7 15 分钟 ${fifteenMinutes}`,
    progress,
    progressColor: progress !== undefined ? getProgressColor(progress) : undefined,
  };
}

function parseMemoryMetric(value: string): Omit<MonitorMetric, 'key' | 'label' | 'icon'> | null {
  const memoryLine = getStatusLines(value).find((line) => /^mem:/i.test(line));

  if (!memoryLine) {
    return null;
  }

  const columns = memoryLine.split(/\s+/);
  const total = Number.parseFloat(columns[1] ?? '');
  const used = Number.parseFloat(columns[2] ?? '');

  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(used)) {
    return null;
  }

  const progress = clampProgress((used / total) * 100);

  return {
    value: `${progress}%`,
    detail: `${Math.round(used)} / ${Math.round(total)} MB`,
    progress,
    progressColor: getProgressColor(progress),
  };
}

function parseDiskMetric(value: string): Omit<MonitorMetric, 'key' | 'label' | 'icon'> | null {
  const lines = getStatusLines(value);
  const usageLine = lines.find((line, index) => index > 0 && /\d+%/.test(line));

  if (!usageLine) {
    return null;
  }

  const columns = usageLine.split(/\s+/);
  const usage = columns.find((column) => /\d+%/.test(column)) ?? '';
  const total = columns[1] ?? '';
  const used = columns[2] ?? '';
  const mountPath = columns.at(-1) ?? '/';
  const progress = Number.parseInt(usage, 10);

  return {
    value: usage || getFirstStatusLine(value),
    detail: [used && total ? `${used} / ${total}` : '', mountPath].filter(Boolean).join(' \u00B7 '),
    progress: Number.isFinite(progress) ? clampProgress(progress) : undefined,
    progressColor: Number.isFinite(progress) ? getProgressColor(progress) : undefined,
  };
}

function parseNetworkMetric(value: string): Omit<MonitorMetric, 'key' | 'label' | 'icon'> {
  const interfaces = getStatusLines(value).filter((line) => !/^lo\b/i.test(line));
  const preview = interfaces
    .slice(0, 2)
    .map((line) => line.replace(/\s+/g, ' '))
    .join(' \u00B7 ');

  return {
    value: interfaces.length ? `${interfaces.length} 个接口` : '未识别',
    detail: preview || getFirstStatusLine(value),
  };
}

function createFallbackMetric(value: string): Omit<MonitorMetric, 'key' | 'label' | 'icon'> {
  return {
    value: getFirstStatusLine(value),
    detail: value.includes('\n') ? '查看下方详细信息' : '\u2014',
  };
}

const STATUS_ICONS: Record<string, string> = {
  hostname: '\u{1F3E0}',
  user: '\u{1F464}',
  kernel: '\u2699\uFE0F',
  uptime: '\u23F1\uFE0F',
  disk: '\u{1F4BE}',
  memory: '\u{1F9E0}',
  network: '\u{1F310}',
};

function RemoteMonitor({ connectionId }: RemoteMonitorProps) {
  const [statusReport, setStatusReport] = useState<RemoteStatusReport | null>(null);
  const [statusError, setStatusError] = useState('');
  const [isStatusLoading, setIsStatusLoading] = useState(false);
  const isRefreshingStatusRef = useRef(false);
  const [refreshCountdown, setRefreshCountdown] = useState(8);
  const countdownRef = useRef<number | null>(null);

  const statusItems = statusReport?.items ?? [];
  const hostnameValue = statusItems.find((item) => item.key === 'hostname')?.value ?? '';
  const userValue = statusItems.find((item) => item.key === 'user')?.value ?? '';
  const kernelValue = statusItems.find((item) => item.key === 'kernel')?.value ?? '';
  const uptimeValue = statusItems.find((item) => item.key === 'uptime')?.value ?? '';
  const diskValue = statusItems.find((item) => item.key === 'disk')?.value ?? '';
  const memoryValue = statusItems.find((item) => item.key === 'memory')?.value ?? '';
  const networkValue = statusItems.find((item) => item.key === 'network')?.value ?? '';
  const loadMetric = parseLoadMetric(uptimeValue) ?? createFallbackMetric(uptimeValue);
  const memoryMetric = parseMemoryMetric(memoryValue) ?? createFallbackMetric(memoryValue);
  const diskMetric = parseDiskMetric(diskValue) ?? createFallbackMetric(diskValue);
  const networkMetric = parseNetworkMetric(networkValue);

  const overviewMetrics: MonitorMetric[] = useMemo(() => [
    { key: 'load', label: '系统负载', icon: '\u26A1', ...loadMetric },
    { key: 'memory', label: '内存占用', icon: '\u{1F9E0}', ...memoryMetric },
    { key: 'disk', label: '根分区', icon: '\u{1F4BE}', ...diskMetric },
    { key: 'network', label: '网络接口', icon: '\u{1F310}', ...networkMetric },
  ], [loadMetric, memoryMetric, diskMetric, networkMetric]);

  const refreshStatus = async () => {
    if (!window.guiSSH?.connections) {
      setStatusError('当前运行环境不支持资源监视。');
      return;
    }

    if (isRefreshingStatusRef.current) {
      return;
    }

    isRefreshingStatusRef.current = true;
    setIsStatusLoading(true);
    setStatusError('');

    try {
      const report: RemoteStatusReport = await window.guiSSH.connections.getStatus(connectionId);
      setStatusReport(report);
    } catch (error) {
      setStatusReport(null);
      setStatusError(getErrorMessage(error));
    } finally {
      isRefreshingStatusRef.current = false;
      setIsStatusLoading(false);
    }
  };

  useEffect(() => {
    void refreshStatus();
    setRefreshCountdown(8);

    const refreshTimer = window.setInterval(() => {
      void refreshStatus();
      setRefreshCountdown(8);
    }, 8000);

    countdownRef.current = window.setInterval(() => {
      setRefreshCountdown((prev) => Math.max(0, prev - 1));
    }, 1000);

    return () => {
      window.clearInterval(refreshTimer);
      if (countdownRef.current) window.clearInterval(countdownRef.current);
    };
  }, [connectionId]);

  const uptimeLine = getFirstStatusLine(uptimeValue);

  return (
    <div className="monitor-pane">
      <div className="monitor-shell">
        <header className="monitor-header">
          <div className="monitor-header-left">
            <div className="monitor-title-area">
              <span className="monitor-pulse-dot" />
              <span className="monitor-kicker">系统监视器</span>
            </div>
            <strong className="monitor-hostname">{getFirstStatusLine(hostnameValue) || '远程主机'}</strong>
            <div className="monitor-host-meta">
              <span className="monitor-meta-tag">{getFirstStatusLine(kernelValue)}</span>
              {userValue ? <span className="monitor-meta-tag">{getFirstStatusLine(userValue)}</span> : null}
              {uptimeLine && uptimeLine !== '\u2014' ? <span className="monitor-meta-tag">{uptimeLine}</span> : null}
            </div>
          </div>
          <div className="monitor-header-right">
            <div className="monitor-refresh-info">
              <div className="monitor-countdown-bar">
                <span style={{ width: `${(refreshCountdown / 8) * 100}%` }} />
              </div>
              <small>{statusReport ? `刷新于 ${formatDateTime(statusReport.refreshedAt)}` : '等待首次读取'}</small>
            </div>
            <button type="button" className="monitor-refresh-btn" onClick={refreshStatus} disabled={isStatusLoading}>
              {isStatusLoading ? '刷新中...' : '手动刷新'}
            </button>
          </div>
        </header>

        {statusError ? <div className="error-banner">{statusError}</div> : null}

        <section className="monitor-overview" aria-label="监控概览">
          {overviewMetrics.map((metric) => (
            <article key={metric.key} className={`monitor-metric-card ${metric.progressColor ?? ''}`}>
              <div className="metric-card-head">
                <span className="metric-card-icon">{metric.icon}</span>
                <span className="metric-card-label">{metric.label}</span>
              </div>
              <strong className="metric-card-value">{metric.value}</strong>
              <small className="metric-card-detail">{metric.detail}</small>
              {typeof metric.progress === 'number' ? (
                <div className="monitor-meter" aria-hidden="true">
                  <span className={metric.progressColor ?? 'normal'} style={{ width: `${metric.progress}%` }} />
                </div>
              ) : null}
            </article>
          ))}
        </section>

        <div className="monitor-detail-section">
          <h3 className="monitor-detail-heading">系统详情</h3>
          <div className="status-grid">
            {statusItems.map((item) => (
              <article key={item.key} className={`status-card ${item.key === 'kernel' || item.key === 'network' ? 'wide' : ''}`}>
                <div className="status-card-header">
                  <span className="status-card-icon">{STATUS_ICONS[item.key] ?? '\u{1F4CB}'}</span>
                  <strong>{item.label}</strong>
                  <span className="status-card-key">{item.key}</span>
                </div>
                <pre>{item.value}</pre>
              </article>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default RemoteMonitor;
