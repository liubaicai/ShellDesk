import { useEffect, useRef, useState } from 'react';

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
  progress?: number;
}

function getStatusLines(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function getFirstStatusLine(value: string) {
  return getStatusLines(value)[0] ?? '—';
}

function clampProgress(value: number) {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function parseNumericToken(value: string) {
  return Number.parseFloat(value.replace(',', '.'));
}

function parseLoadMetric(value: string): Omit<MonitorMetric, 'key' | 'label'> | null {
  const match = value.match(/load averages?:\s*([0-9]+(?:[.,][0-9]+)?)[,\s]+([0-9]+(?:[.,][0-9]+)?)[,\s]+([0-9]+(?:[.,][0-9]+)?)/i);

  if (!match) {
    return null;
  }

  const [, oneMinute, fiveMinutes, fifteenMinutes] = match;
  const oneMinuteValue = parseNumericToken(oneMinute);

  return {
    value: oneMinute,
    detail: `5 分钟 ${fiveMinutes} · 15 分钟 ${fifteenMinutes}`,
    progress: Number.isFinite(oneMinuteValue) ? clampProgress((oneMinuteValue / 2) * 100) : undefined,
  };
}

function parseMemoryMetric(value: string): Omit<MonitorMetric, 'key' | 'label'> | null {
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
  };
}

function parseDiskMetric(value: string): Omit<MonitorMetric, 'key' | 'label'> | null {
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
    detail: [used && total ? `${used} / ${total}` : '', mountPath].filter(Boolean).join(' · '),
    progress: Number.isFinite(progress) ? clampProgress(progress) : undefined,
  };
}

function parseNetworkMetric(value: string): Omit<MonitorMetric, 'key' | 'label'> {
  const interfaces = getStatusLines(value).filter((line) => !/^lo\b/i.test(line));
  const preview = interfaces
    .slice(0, 2)
    .map((line) => line.replace(/\s+/g, ' '))
    .join(' · ');

  return {
    value: interfaces.length ? `${interfaces.length} 个接口` : '未识别',
    detail: preview || getFirstStatusLine(value),
  };
}

function createFallbackMetric(value: string): Omit<MonitorMetric, 'key' | 'label'> {
  return {
    value: getFirstStatusLine(value),
    detail: value.includes('\n') ? '查看下方详细信息' : '—',
  };
}

function RemoteMonitor({ connectionId }: RemoteMonitorProps) {
  const [statusReport, setStatusReport] = useState<RemoteStatusReport | null>(null);
  const [statusError, setStatusError] = useState('');
  const [isStatusLoading, setIsStatusLoading] = useState(false);
  const isRefreshingStatusRef = useRef(false);
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
  const overviewMetrics: MonitorMetric[] = [
    { key: 'load', label: '系统负载', ...loadMetric },
    { key: 'memory', label: '内存占用', ...memoryMetric },
    { key: 'disk', label: '根分区', ...diskMetric },
    { key: 'network', label: '网络接口', ...networkMetric },
  ];

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
    const refreshTimer = window.setInterval(() => {
      void refreshStatus();
    }, 8000);

    return () => window.clearInterval(refreshTimer);
  }, [connectionId]);

  return (
    <div className="monitor-pane">
      <div className="monitor-shell">
        <section className="monitor-hero">
          <div className="monitor-hero-copy">
            <span className="monitor-kicker">Remote System Monitor</span>
            <strong>{getFirstStatusLine(hostnameValue) || '远程主机'}</strong>
            <p>{getFirstStatusLine(kernelValue)}</p>
            <div className="monitor-hero-meta">
              <span>{userValue ? `用户 · ${getFirstStatusLine(userValue)}` : '用户信息待获取'}</span>
              <span>{uptimeValue ? getFirstStatusLine(uptimeValue) : '等待运行状态'}</span>
            </div>
          </div>

          <div className="monitor-toolbar">
            <span>{statusReport ? `刷新于 ${formatDateTime(statusReport.refreshedAt)}` : '等待首次读取'}</span>
            <button type="button" className="command-button" onClick={refreshStatus} disabled={isStatusLoading}>
              {isStatusLoading ? '刷新中...' : '刷新'}
            </button>
          </div>
        </section>

        {statusError ? <div className="error-banner">{statusError}</div> : null}

        <section className="monitor-overview" aria-label="监控概览">
          {overviewMetrics.map((metric) => (
            <article key={metric.key} className="monitor-metric-card">
              <span>{metric.label}</span>
              <strong>{metric.value}</strong>
              <small>{metric.detail}</small>
              {typeof metric.progress === 'number' ? (
                <div className="monitor-meter" aria-hidden="true">
                  <span style={{ width: `${metric.progress}%` }} />
                </div>
              ) : null}
            </article>
          ))}
        </section>

        <div className="status-grid">
          {statusItems.map((item) => (
            <article key={item.key} className={`status-card ${item.key === 'kernel' || item.key === 'network' ? 'wide' : ''}`}>
              <div className="status-card-header">
                <strong>{item.label}</strong>
                <span>{item.key}</span>
              </div>
              <pre>{item.value}</pre>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}

export default RemoteMonitor;
