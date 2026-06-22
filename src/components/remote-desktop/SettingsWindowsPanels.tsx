import { useCallback, useEffect, useState } from 'react';

import { getErrorMessage } from './desktopUtils';
import DismissibleAlert from './DismissibleAlert';
import { powershellCommand } from './remoteSystem';
import { t, translateStructuredText, useCurrentAppLanguage } from '../../i18n';
import type { SettingsConfirmDialogConfig, SysInfoItem } from './settingsTypes';
import { createLineChangePreview, createWindowsDiskSummaryCommand, getSystemInfoItems, isSafeHostname, isSafeNameserver, isVisibleSystemInfoItem, renderDiskInfoSummary, SettingsCommandPreview, SettingsConfirmDialog, useRemoteSettingsCommand } from './settingsShared';

const windowsHostsPath = 'C:/Windows/System32/drivers/etc/hosts';

export function WindowsSystemInfoPanel({ connectionId }: { connectionId: string }) {
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
  const hostLabel = hostnameItem?.value || t('remoteSettings.windows.host', language);
  const osLabel = osItem?.value || t('remoteSettings.windows.systemDescription', language);

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
            {item.key === 'disk' ? renderDiskInfoSummary(item.value, language) : <pre className="sysinfo-card-value">{item.value}</pre>}
          </article>
        ))}
      </div>
    </div>
  );
}

export function WindowsNetworkPanel() {
  const language = useCurrentAppLanguage();
  const runCommand = useRemoteSettingsCommand();
  const [hostname, setHostname] = useState('');
  const [networkInfo, setNetworkInfo] = useState('');
  const [dnsInfo, setDnsInfo] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [hostResult, ipResult, dnsResult] = await Promise.all([
        runCommand(powershellCommand('[System.Net.Dns]::GetHostName()')),
        runCommand(powershellCommand('Get-NetIPConfiguration | Format-List | Out-String -Width 220')),
        runCommand(powershellCommand('Get-DnsClientServerAddress -AddressFamily IPv4,IPv6 | Format-Table -AutoSize | Out-String -Width 200')),
      ]);
      setHostname(hostResult.stdout || hostResult.stderr);
      setNetworkInfo(ipResult.stdout || ipResult.stderr);
      setDnsInfo(dnsResult.stdout || dnsResult.stderr);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [runCommand]);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <div className="settings-panel-content">
      <div className="settings-panel-header">
        <div>
          <h3>{t('remoteSettings.windows.networkTitle', language)}</h3>
          <p>{t('remoteSettings.windows.networkDescription', language)}</p>
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
      <div className="settings-info-card">
        <div className="settings-info-row">
          <span className="settings-info-label">{t('remoteSettings.network.hostname', language)}</span>
          <strong className="settings-info-value">{hostname || '...'}</strong>
        </div>
      </div>
      <div className="settings-section">
        <h4>{t('remoteSettings.windows.adapters', language)}</h4>
        <pre className="settings-output">{networkInfo || t('remoteSettings.common.loading', language)}</pre>
      </div>
      <div className="settings-section">
        <h4>{t('remoteSettings.windows.dnsConfig', language)}</h4>
        <pre className="settings-output">{dnsInfo || t('remoteSettings.common.loading', language)}</pre>
      </div>
    </div>
  );
}

export function WindowsHostsPanel({ connectionId }: { connectionId: string }) {
  const language = useCurrentAppLanguage();
  const [content, setContent] = useState('');
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [newIp, setNewIp] = useState('');
  const [newHost, setNewHost] = useState('');
  const [confirmDialog, setConfirmDialog] = useState<SettingsConfirmDialogConfig | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const text = await window.guiSSH!.connections.readFile(connectionId, windowsHostsPath);
      setContent(text);
      setDraft(text);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const saveHosts = async () => {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      await window.guiSSH!.connections.writeFile(connectionId, windowsHostsPath, draft);
      setContent(draft);
      setSuccess(t('remoteSettings.windows.hostsSaved', language));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const requestSaveHosts = () => {
    if (draft === content) {
      setSuccess(t('remoteSettings.windows.hostsNoDraftChanges', language));
      return;
    }

    setConfirmDialog({
      title: t('remoteSettings.windows.hostsSaveTitle', language),
      message: t('remoteSettings.windows.hostsSaveMessage', language, { path: windowsHostsPath }),
      detail: t('remoteSettings.windows.hostsSaveDetail', language),
      preview: createLineChangePreview(content, draft, language),
      confirmLabel: t('remoteSettings.hosts.saveConfirm', language),
      tone: 'warning',
      onConfirm: saveHosts,
    });
  };

  const addEntry = async () => {
    const ip = newIp.trim();
    const host = newHost.trim();
    if (!ip || !host) {
      setError(t('remoteSettings.windows.hostsIpHostRequired', language));
      return;
    }
    if (!isSafeNameserver(ip) || !isSafeHostname(host)) {
      setError(t('remoteSettings.windows.hostsIpHostInvalid', language));
      return;
    }
    const line = `${ip}\t${host}`;
    const nextDraft = `${draft.trimEnd()}\r\n${line}\r\n`;
    setDraft(nextDraft);
    setNewIp('');
    setNewHost('');
    setSuccess(t('remoteSettings.windows.hostsAddedDraft', language, { host }));
  };

  return (
    <div className="settings-panel-content">
      <div className="settings-panel-header">
        <div>
          <h3>{t('remoteSettings.hosts.title', language)}</h3>
          <p>{windowsHostsPath}</p>
        </div>
        <div className="settings-header-actions">
          <button type="button" className="settings-action-btn" onClick={refresh} disabled={loading}>{loading ? t('remoteSettings.common.loading', language) : t('remoteSettings.common.refresh', language)}</button>
          <button type="button" className="settings-action-btn primary" onClick={requestSaveHosts} disabled={saving || draft === content}>
            {saving ? t('remoteSettings.hosts.saving', language) : t('remoteSettings.hosts.previewSave', language)}
          </button>
        </div>
      </div>
      {error ? (
        <DismissibleAlert className="error-banner" source="RemoteSettings" onDismiss={() => setError('')} role="alert">
          {error}
        </DismissibleAlert>
      ) : null}
      {success ? (
        <DismissibleAlert className="settings-success-banner" onDismiss={() => setSuccess('')}>
          {success}
        </DismissibleAlert>
      ) : null}
      <div className="settings-section">
        <h4>{t('remoteSettings.windows.hostsAddSection', language)}</h4>
        <div className="settings-inline-form">
          <input className="settings-input" placeholder={t('remoteSettings.hosts.ipPlaceholder', language)} value={newIp} onChange={(e) => setNewIp(e.target.value)} />
          <input className="settings-input" placeholder={t('remoteSettings.hosts.hostnamePlaceholder', language)} value={newHost} onChange={(e) => setNewHost(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void addEntry(); }} />
          <button type="button" className="settings-action-btn primary" onClick={addEntry}>{t('remoteSettings.hosts.add', language)}</button>
        </div>
      </div>
      <div className="settings-section">
        <h4>{t('remoteSettings.windows.hostsEditTitle', language)}</h4>
        <textarea
          className="settings-textarea"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={18}
          spellCheck={false}
        />
        <SettingsCommandPreview label={t('remoteSettings.hosts.changePreview', language)} content={createLineChangePreview(content, draft, language)} />
      </div>
      {confirmDialog ? <SettingsConfirmDialog config={confirmDialog} onClose={() => setConfirmDialog(null)} /> : null}
    </div>
  );
}

export function WindowsRoutePanel() {
  const language = useCurrentAppLanguage();
  const runCommand = useRemoteSettingsCommand();
  const [routes, setRoutes] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await runCommand(powershellCommand('Get-NetRoute | Sort-Object -Property DestinationPrefix, RouteMetric | Format-Table -AutoSize | Out-String -Width 260'));
      setRoutes(result.stdout || result.stderr || t('remoteSettings.route.unavailable', language));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [language, runCommand]);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <div className="settings-panel-content">
      <div className="settings-panel-header">
        <div>
          <h3>{t('remoteSettings.route.tableTitle', language)}</h3>
          <p>{t('remoteSettings.windows.routeDescription', language)}</p>
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
      <div className="settings-section">
        <h4>{t('remoteSettings.route.tableTitle', language)}</h4>
        <pre className="settings-output">{routes || t('remoteSettings.common.loading', language)}</pre>
      </div>
    </div>
  );
}

export function WindowsDiskPanel() {
  const language = useCurrentAppLanguage();
  const runCommand = useRemoteSettingsCommand();
  const [diskInfo, setDiskInfo] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const diskResult = await runCommand(createWindowsDiskSummaryCommand(language));
      setDiskInfo(diskResult.stdout || diskResult.stderr);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [language, runCommand]);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <div className="settings-panel-content">
      <div className="settings-panel-header">
        <div>
          <h3>{t('remoteSettings.windows.diskTitle', language)}</h3>
          <p>{t('remoteSettings.windows.diskDescription', language)}</p>
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
      <div className="settings-section">
        <h4>{t('remoteSettings.windows.localDisks', language)}</h4>
        <pre className="settings-output">{diskInfo || t('remoteSettings.common.loading', language)}</pre>
      </div>
    </div>
  );
}
