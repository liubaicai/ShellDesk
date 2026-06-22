import { useCallback, useEffect, useState } from 'react';

import { getErrorMessage } from './desktopUtils';
import DismissibleAlert from './DismissibleAlert';
import { t, translateStructuredText, useCurrentAppLanguage } from '../../i18n';
import type { SysInfoItem } from './settingsTypes';
import { parseCpuInfoSummary, parseMemoryInfoSummary, parseOsName } from './settingsParsers';
import { getSystemInfoItems, isVisibleSystemInfoItem, renderDiskInfoSummary } from './settingsShared';

export default function SettingsSystemInfoPanel({ connectionId }: { connectionId: string }) {
  const language = useCurrentAppLanguage();
  const [items, setItems] = useState<SysInfoItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setItems(await getSystemInfoItems(connectionId));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const hostnameItem = items.find((i) => i.key === 'hostname');
  const osItem = items.find((i) => i.key === 'os');

  const renderStructuredSysInfoValue = (item: SysInfoItem) => {
    if (item.key === 'cpu') {
      const summary = parseCpuInfoSummary(item.value);

      if (!summary) {
        return <pre className="sysinfo-card-value">{item.value}</pre>;
      }

      return (
        <div className="sysinfo-feature-block">
          <div className="sysinfo-feature-title">{summary.model || t('remoteSettings.systemInfo.cpuInfo', language)}</div>
          <div className="sysinfo-metric-grid">
            <div className="sysinfo-metric">
              <span>{t('remoteSettings.systemInfo.logicalCpu', language)}</span>
              <strong>{summary.logicalCpus || '--'}</strong>
            </div>
            <div className="sysinfo-metric">
              <span>{t('remoteSettings.systemInfo.physicalCores', language)}</span>
              <strong>{summary.physicalCores || '--'}</strong>
            </div>
            <div className="sysinfo-metric">
              <span>{t('remoteSettings.systemInfo.threadsPerCore', language)}</span>
              <strong>{summary.threadsPerCore || '--'}</strong>
            </div>
            <div className="sysinfo-metric">
              <span>{t('remoteSettings.systemInfo.cpuSockets', language)}</span>
              <strong>{summary.sockets || '--'}</strong>
            </div>
          </div>
        </div>
      );
    }

    if (item.key === 'memory') {
      const summary = parseMemoryInfoSummary(item.value);

      if (!summary) {
        return <pre className="sysinfo-card-value">{item.value}</pre>;
      }

      return (
        <div className="sysinfo-feature-block">
          <div className="sysinfo-memory-headline">
            <strong>{summary.used}</strong>
            <span>/ {summary.total}</span>
          </div>
          <div className="sysinfo-memory-caption">
            {summary.usagePercent !== null ? t('remoteSettings.systemInfo.usedPercent', language, { percent: String(summary.usagePercent) }) : t('remoteSettings.systemInfo.memoryUsage', language)}
          </div>
          {summary.usagePercent !== null ? (
            <div className="sysinfo-memory-bar" aria-hidden="true">
              <span className="sysinfo-memory-bar-fill" style={{ width: `${Math.max(6, Math.min(summary.usagePercent, 100))}%` }} />
            </div>
          ) : null}
          <div className="sysinfo-metric-grid">
            <div className="sysinfo-metric">
              <span>{t('remoteSettings.systemInfo.available', language)}</span>
              <strong>{summary.available || '--'}</strong>
            </div>
            <div className="sysinfo-metric">
              <span>{t('remoteSettings.systemInfo.free', language)}</span>
              <strong>{summary.free || '--'}</strong>
            </div>
            <div className="sysinfo-metric">
              <span>{t('remoteSettings.systemInfo.cache', language)}</span>
              <strong>{summary.cache || '--'}</strong>
            </div>
            <div className="sysinfo-metric">
              <span>{t('remoteSettings.systemInfo.shared', language)}</span>
              <strong>{summary.shared || '--'}</strong>
            </div>
          </div>
        </div>
      );
    }

    if (item.key === 'disk') {
      return renderDiskInfoSummary(item.value, language);
    }

    return <pre className="sysinfo-card-value">{item.value}</pre>;
  };

  const hostLabel = hostnameItem?.value || t('remoteSettings.systemInfo.remoteHost', language);
  const osLabel = osItem ? parseOsName(osItem.value, language) : t('remoteSettings.systemInfo.description', language);

  return (
    <div className="settings-panel-content">
      <div className="settings-panel-header">
        <div>
          <h3>{hostLabel}</h3>
          <p>{osLabel}</p>
        </div>
        <button type="button" className="settings-action-btn" onClick={refresh} disabled={loading}>
          {loading ? t('remoteSettings.common.loading', language) : t('remoteSettings.common.refresh', language)}
        </button>
      </div>
      {error ? (
        <DismissibleAlert className="error-banner" source="RemoteSettings" onDismiss={() => setError('')} role="alert">
          {error}
        </DismissibleAlert>
      ) : null}

      <div className="sysinfo-grid">
        {items.filter(isVisibleSystemInfoItem).map((item) => (
          <article key={item.key} className="sysinfo-card">
            <div className="sysinfo-card-head">
              <span className="sysinfo-card-icon">{item.icon}</span>
              <span className="sysinfo-card-label">{translateStructuredText(item.label, language)}</span>
            </div>
            {renderStructuredSysInfoValue(item)}
          </article>
        ))}
      </div>
    </div>
  );
}
