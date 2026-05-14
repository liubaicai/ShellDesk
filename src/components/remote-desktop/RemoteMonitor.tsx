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

function RemoteMonitor({ connectionId }: RemoteMonitorProps) {
  const [statusReport, setStatusReport] = useState<RemoteStatusReport | null>(null);
  const [statusError, setStatusError] = useState('');
  const [isStatusLoading, setIsStatusLoading] = useState(false);
  const isRefreshingStatusRef = useRef(false);

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
      <div className="monitor-toolbar">
        <span>{statusReport ? `刷新于 ${formatDateTime(statusReport.refreshedAt)}` : '尚未读取状态'}</span>
        <button type="button" className="command-button" onClick={refreshStatus} disabled={isStatusLoading}>
          {isStatusLoading ? '刷新中...' : '刷新'}
        </button>
      </div>
      {statusError ? <div className="error-banner">{statusError}</div> : null}
      <div className="status-grid">
        {statusReport?.items.map((item) => (
          <article key={item.key} className="status-card">
            <strong>{item.label}</strong>
            <pre>{item.value}</pre>
          </article>
        ))}
      </div>
    </div>
  );
}

export default RemoteMonitor;
