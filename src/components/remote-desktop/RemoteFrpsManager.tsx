import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { tCurrent } from '../../i18n';
import DismissibleAlert from './DismissibleAlert';
import { getErrorMessage } from './desktopUtils';
import { isWindowsSystem, type RemoteCommandInput } from './remoteSystem';
import { loadRemoteConnectionProfile, readProfileString, saveRemoteConnectionProfile } from './remoteConnectionProfiles';
import {
  createFrpsDashboardCommand,
  createFrpsDetectCommand,
  createFrpsEnableAutostartCommand,
  createFrpsInstallCommand,
  createFrpsLogsCommand,
  createFrpsReadConfigCommand,
  createFrpsRestartCommand,
  createFrpsStartCommand,
  createFrpsStatusCommand,
  createFrpsStopCommand,
  createFrpsWriteConfigCommand,
  generateFrpsToml,
} from './frpsCommands';
import { parseFrpsConfigToml, parseFrpsDashboardApi, parseFrpsDetectOutput, parseFrpsLogs, parseFrpsStatusOutput } from './frpsParsers';
import type { FrpsConfig, FrpsManagerProps, FrpsProxyInfo, FrpsServiceMode, FrpsStatus } from './frpsTypes';
import '../../styles/remote-desktop/_frps-manager.scss';

type FrpsTab = 'connection' | 'proxies' | 'logs' | 'settings';

const defaultLinuxConfigPath = '/etc/frp/frps.toml';
const defaultWindowsConfigPath = '%USERPROFILE%\\.frp\\frps.toml';
const logLevels: FrpsConfig['logLevel'][] = ['trace', 'debug', 'info', 'warn', 'error'];

const defaultConfig: FrpsConfig = {
  bindAddr: '0.0.0.0',
  bindPort: 7000,
  token: '',
  vhostHTTPPort: 80,
  vhostHTTPSPort: 443,
  subDomainHost: '',
  dashboardAddr: '0.0.0.0',
  dashboardPort: 7500,
  dashboardUser: 'admin',
  dashboardPassword: 'admin',
  logTo: '/var/log/frps.log',
  logLevel: 'info',
  logMaxDays: 3,
  maxPoolCount: 10,
  tcpMux: true,
};

function runCmd(connectionId: string, input: RemoteCommandInput) {
  const api = window.guiSSH?.connections;
  if (!api) throw new Error(tCurrent('auto.frpsManager.noRemoteCommand'));
  return api.runCommand(connectionId, input.command, input.stdin);
}

function formatTraffic(value?: number) {
  if (!value) return '-';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function RemoteFrpsManager({ connectionId, systemType }: FrpsManagerProps) {
  const isWindowsHost = isWindowsSystem(systemType);
  const defaultConfigPath = isWindowsHost ? defaultWindowsConfigPath : defaultLinuxConfigPath;
  const [status, setStatus] = useState<FrpsStatus>({
    installed: false,
    version: '',
    running: false,
    serviceMode: isWindowsHost ? 'process' : 'systemd',
    configPath: defaultConfigPath,
  });
  const [config, setConfig] = useState<FrpsConfig>(defaultConfig);
  const [activeTab, setActiveTab] = useState<FrpsTab>('connection');
  const [proxies, setProxies] = useState<FrpsProxyInfo[]>([]);
  const [logs, setLogs] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [acting, setActing] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [restartAfterSave, setRestartAfterSave] = useState(true);
  const [connectionModalOpen, setConnectionModalOpen] = useState(false);
  const statusRef = useRef(status);

  const tomlPreview = useMemo(() => generateFrpsToml(config), [config]);
  const controlsDisabled = loading || saving || installing || acting !== '' || !status.installed;
  const connectionExample = useMemo(() => [
    `serverAddr = "${config.bindAddr === '0.0.0.0' ? '<server-ip>' : config.bindAddr}"`,
    `serverPort = ${config.bindPort || 7000}`,
    config.token ? `auth.token = "${config.token}"` : '# auth.token = "<token>"',
  ].join('\n'), [config.bindAddr, config.bindPort, config.token]);

  useEffect(() => {
    let disposed = false;
    void loadRemoteConnectionProfile(connectionId, 'frps-manager' as ShellDeskDesktopAppKey).then((profile) => {
      if (disposed || !profile) return;
      setStatus((current) => {
        const next = {
          ...current,
          configPath: readProfileString(profile, 'configPath', current.configPath),
          serviceMode: readProfileString(profile, 'serviceMode', current.serviceMode) === 'process' ? 'process' as const : 'systemd' as const,
        };
        statusRef.current = next;
        return next;
      });
    });
    return () => {
      disposed = true;
    };
  }, [connectionId]);

  const saveProfile = useCallback((nextStatus: FrpsStatus) => {
    void saveRemoteConnectionProfile(connectionId, 'frps-manager' as ShellDeskDesktopAppKey, {
      configPath: nextStatus.configPath,
      serviceMode: nextStatus.serviceMode,
    });
  }, [connectionId]);

  const persistStatus = useCallback((nextStatus: FrpsStatus) => {
    statusRef.current = nextStatus;
    saveProfile(nextStatus);
  }, [saveProfile]);

  const loadConfig = useCallback(async (configPath: string) => {
    const result = await runCmd(connectionId, createFrpsReadConfigCommand(configPath));
    const content = result.stdout || '';
    setConfig(content.trim() ? parseFrpsConfigToml(content) : defaultConfig);
  }, [connectionId]);

  const refreshRuntimeStatus = useCallback(async (nextStatus: FrpsStatus) => {
    const result = await runCmd(connectionId, createFrpsStatusCommand(isWindowsHost, nextStatus.serviceMode, nextStatus.configPath));
    const running = parseFrpsStatusOutput(result.stdout || '', nextStatus.serviceMode);
    setStatus((current) => {
      const next = { ...current, running };
      statusRef.current = next;
      return next;
    });
    return running;
  }, [connectionId, isWindowsHost]);

  const detectFrps = useCallback(async () => {
    setLoading(true);
    setError('');
    setNotice('');
    try {
      const result = await runCmd(connectionId, createFrpsDetectCommand(isWindowsHost));
      const detected = parseFrpsDetectOutput(result.stdout || '');
      const detectedStatus: Partial<FrpsStatus> = {
        installed: detected.installed,
        version: detected.version,
        serviceMode: isWindowsHost ? 'process' : detected.systemdAvailable ? 'systemd' : 'process',
        configPath: detected.configPath || statusRef.current.configPath || defaultConfigPath,
      };
      const nextStatus = { ...statusRef.current, ...detectedStatus };
      setStatus((prev) => ({ ...prev, ...detectedStatus }));
      persistStatus(nextStatus);
      if (detected.installed) {
        await loadConfig(nextStatus.configPath);
        await refreshRuntimeStatus(nextStatus);
        setNotice(tCurrent('auto.frpsManager.detectDone'));
      }
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    } finally {
      setLoading(false);
    }
  }, [connectionId, defaultConfigPath, isWindowsHost, loadConfig, refreshRuntimeStatus, persistStatus]);

  useEffect(() => {
    void detectFrps();
  }, []);

  const installFrps = async () => {
    setInstalling(true);
    setError('');
    setNotice(tCurrent('auto.frpsManager.installing'));
    try {
      const result = await runCmd(connectionId, createFrpsInstallCommand(isWindowsHost));
      if (result.code !== 0) throw new Error(result.stderr || result.stdout || tCurrent('auto.frpsManager.installFailed'));
      setNotice(result.stdout || tCurrent('auto.frpsManager.installed'));
      await detectFrps();
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    } finally {
      setInstalling(false);
    }
  };

  const runServiceAction = async (action: 'start' | 'stop' | 'restart') => {
    setActing(action);
    setError('');
    setNotice('');
    try {
      const currentStatus = statusRef.current;
      const command = action === 'start'
        ? createFrpsStartCommand(isWindowsHost, currentStatus.serviceMode, currentStatus.configPath)
        : action === 'stop'
          ? createFrpsStopCommand(isWindowsHost, currentStatus.serviceMode, currentStatus.configPath)
          : createFrpsRestartCommand(isWindowsHost, currentStatus.serviceMode, currentStatus.configPath);
      const result = await runCmd(connectionId, command);
      if (result.code !== 0) throw new Error(result.stderr || result.stdout || tCurrent('auto.frpsManager.actionFailed'));
      await refreshRuntimeStatus(statusRef.current);
      setNotice(action === 'start' ? tCurrent('auto.frpsManager.started') : action === 'stop' ? tCurrent('auto.frpsManager.stopped') : tCurrent('auto.frpsManager.restarted'));
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    } finally {
      setActing('');
    }
  };

  const saveConfig = async () => {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const currentStatus = statusRef.current;
      const result = await runCmd(connectionId, createFrpsWriteConfigCommand(currentStatus.configPath, tomlPreview));
      if (result.code !== 0) throw new Error(result.stderr || result.stdout || tCurrent('auto.frpsManager.configSaveFailed'));
      saveProfile(currentStatus);
      if (restartAfterSave && currentStatus.running) {
        await runCmd(connectionId, createFrpsRestartCommand(isWindowsHost, currentStatus.serviceMode, currentStatus.configPath));
        await refreshRuntimeStatus(statusRef.current);
      }
      setNotice(restartAfterSave && currentStatus.running ? tCurrent('auto.frpsManager.configSavedRestart') : tCurrent('auto.frpsManager.configSaved'));
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    } finally {
      setSaving(false);
    }
  };

  const loadLogs = async () => {
    setActiveTab('logs');
    setActing('logs');
    setError('');
    try {
      const result = await runCmd(connectionId, createFrpsLogsCommand(isWindowsHost, status.serviceMode, 100));
      setLogs(parseFrpsLogs([result.stdout, result.stderr].filter(Boolean).join('\n')) || tCurrent('auto.frpsManager.noLogs'));
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    } finally {
      setActing('');
    }
  };

  const refreshProxyStatus = async () => {
    setActiveTab('proxies');
    setActing('dashboard');
    setError('');
    try {
      const result = await runCmd(connectionId, createFrpsDashboardCommand(config.dashboardAddr || '127.0.0.1', config.dashboardPort || 7500, config.dashboardUser || 'admin', config.dashboardPassword));
      const snapshots = parseFrpsDashboardApi(result.stdout || '');
      setProxies(snapshots);
      setNotice(snapshots.length ? tCurrent('auto.frpsManager.proxyRefreshed') : tCurrent('auto.frpsManager.proxyRefreshEmpty'));
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    } finally {
      setActing('');
    }
  };

  const enableAutostart = async () => {
    setActing('autostart');
    setError('');
    try {
      const currentStatus = statusRef.current;
      const result = await runCmd(connectionId, createFrpsEnableAutostartCommand(isWindowsHost, currentStatus.serviceMode, currentStatus.configPath));
      if (result.code !== 0) throw new Error(result.stderr || result.stdout || tCurrent('auto.frpsManager.autostartFailed'));
      setNotice(tCurrent('auto.frpsManager.autostartDone'));
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    } finally {
      setActing('');
    }
  };

  const updateConfig = <Key extends keyof FrpsConfig>(key: Key, value: FrpsConfig[Key]) => {
    setConfig((current) => ({ ...current, [key]: value }));
  };

  const updateStatus = <Key extends keyof FrpsStatus>(key: Key, value: FrpsStatus[Key]) => {
    const next = { ...statusRef.current, [key]: value };
    setStatus(next);
    persistStatus(next);
  };

  return (
    <div className="frps-manager">
      <div className="frps-toolbar">
        <div className={`frps-status ${status.installed ? 'installed' : 'missing'} ${status.running ? 'running' : 'stopped'}`}>
          <span>{status.installed ? tCurrent('auto.frpsManager.frpsInstalled') : tCurrent('auto.frpsManager.frpsNotInstalled')}</span>
          <strong>{status.installed ? `${status.version || tCurrent('auto.frpsManager.unknownVersion')} · ${status.running ? tCurrent('auto.frpsManager.statusRunning') : tCurrent('auto.frpsManager.statusStopped')}` : tCurrent('auto.frpsManager.needInstall')}</strong>
        </div>
        <button type="button" onClick={detectFrps} disabled={loading || installing}>{tCurrent('auto.frpsManager.detect')}</button>
        {!status.installed && <button type="button" className="primary" onClick={installFrps} disabled={installing || loading}>{installing ? tCurrent('auto.frpsManager.installingBtn') : tCurrent('auto.frpsManager.installBtn')}</button>}
        <button type="button" onClick={() => void runServiceAction('start')} disabled={controlsDisabled || status.running}>{tCurrent('auto.frpsManager.start')}</button>
        <button type="button" onClick={() => void runServiceAction('stop')} disabled={controlsDisabled || !status.running}>{tCurrent('auto.frpsManager.stop')}</button>
        <button type="button" onClick={() => void runServiceAction('restart')} disabled={controlsDisabled}>{tCurrent('auto.frpsManager.restart')}</button>
        <button type="button" className="primary" onClick={saveConfig} disabled={controlsDisabled}>{tCurrent('auto.frpsManager.saveConfig')}</button>
      </div>

      {error && <DismissibleAlert className="frps-alert danger" onDismiss={() => setError('')}>{error}</DismissibleAlert>}
      {notice && <DismissibleAlert className="frps-alert info" onDismiss={() => setNotice('')}>{notice}</DismissibleAlert>}

      {!status.installed && (
        <div className="frps-install-panel">
          <strong>{tCurrent('auto.frpsManager.remoteNotDetected')}</strong>
          <span>{tCurrent('auto.frpsManager.installHint')}</span>
          <button type="button" className="primary" onClick={installFrps} disabled={installing}>{installing ? tCurrent('auto.frpsManager.installingBtnAlt') : tCurrent('auto.frpsManager.installVersion', { value0: '0.61.1' })}</button>
        </div>
      )}

      <div className="frps-layout">
        <aside className="frps-config">
          <div className="frps-section-head">
            <strong>{tCurrent('auto.frpsManager.serverBinding')}</strong>
            <span>frps.toml</span>
          </div>
          <label><span>{tCurrent('auto.frpsManager.bindAddr')}</span><input value={config.bindAddr} onChange={(event) => updateConfig('bindAddr', event.target.value)} disabled={!status.installed} /></label>
          <label><span>{tCurrent('auto.frpsManager.bindPort')}</span><input type="number" min="1" max="65535" value={config.bindPort} onChange={(event) => updateConfig('bindPort', Number(event.target.value))} disabled={!status.installed} /></label>
          <div className="frps-section-head"><strong>{tCurrent('auto.frpsManager.auth')}</strong></div>
          <label><span>Token</span><input type="password" value={config.token} onChange={(event) => updateConfig('token', event.target.value)} disabled={!status.installed} /></label>
          <div className="frps-section-head"><strong>{tCurrent('auto.frpsManager.vhost')}</strong></div>
          <label><span>{tCurrent('auto.frpsManager.vhostHTTPPort')}</span><input type="number" min="1" max="65535" value={config.vhostHTTPPort} onChange={(event) => updateConfig('vhostHTTPPort', Number(event.target.value))} disabled={!status.installed} /></label>
          <label><span>{tCurrent('auto.frpsManager.vhostHTTPSPort')}</span><input type="number" min="1" max="65535" value={config.vhostHTTPSPort} onChange={(event) => updateConfig('vhostHTTPSPort', Number(event.target.value))} disabled={!status.installed} /></label>
          <label><span>{tCurrent('auto.frpsManager.subDomainHost')}</span><input value={config.subDomainHost} onChange={(event) => updateConfig('subDomainHost', event.target.value)} disabled={!status.installed} /></label>
          <div className="frps-section-head"><strong>{tCurrent('auto.frpsManager.dashboard')}</strong></div>
          <label><span>{tCurrent('auto.frpsManager.dashboardAddr')}</span><input value={config.dashboardAddr} onChange={(event) => updateConfig('dashboardAddr', event.target.value)} disabled={!status.installed} /></label>
          <label><span>{tCurrent('auto.frpsManager.dashboardPort')}</span><input type="number" min="1" max="65535" value={config.dashboardPort} onChange={(event) => updateConfig('dashboardPort', Number(event.target.value))} disabled={!status.installed} /></label>
          <label><span>{tCurrent('auto.frpsManager.dashboardUser')}</span><input value={config.dashboardUser} onChange={(event) => updateConfig('dashboardUser', event.target.value)} disabled={!status.installed} /></label>
          <label><span>{tCurrent('auto.frpsManager.dashboardPassword')}</span><input type="password" value={config.dashboardPassword} onChange={(event) => updateConfig('dashboardPassword', event.target.value)} disabled={!status.installed} /></label>
          <div className="frps-section-head"><strong>{tCurrent('auto.frpsManager.logging')}</strong></div>
          <label><span>{tCurrent('auto.frpsManager.logTo')}</span><input value={config.logTo} onChange={(event) => updateConfig('logTo', event.target.value)} disabled={!status.installed} /></label>
          <label><span>{tCurrent('auto.frpsManager.logLevel')}</span><select value={config.logLevel} onChange={(event) => updateConfig('logLevel', event.target.value as FrpsConfig['logLevel'])} disabled={!status.installed}>{logLevels.map((level) => <option key={level} value={level}>{level}</option>)}</select></label>
          <label><span>{tCurrent('auto.frpsManager.logMaxDays')}</span><input type="number" min="1" max="365" value={config.logMaxDays} onChange={(event) => updateConfig('logMaxDays', Number(event.target.value))} disabled={!status.installed} /></label>
          <div className="frps-section-head"><strong>{tCurrent('auto.frpsManager.transport')}</strong></div>
          <label><span>{tCurrent('auto.frpsManager.maxPoolCount')}</span><input type="number" min="0" max="1000" value={config.maxPoolCount} onChange={(event) => updateConfig('maxPoolCount', Number(event.target.value))} disabled={!status.installed} /></label>
          <label className="frps-checkbox"><input type="checkbox" checked={config.tcpMux} onChange={(event) => updateConfig('tcpMux', event.target.checked)} disabled={!status.installed} /><span>{tCurrent('auto.frpsManager.tcpMux')}</span></label>
          <div className="frps-preview-head">
            <strong>{tCurrent('auto.frpsManager.configPreview')}</strong>
            <button type="button" onClick={() => void loadConfig(status.configPath)} disabled={!status.installed || loading}>{tCurrent('auto.frpsManager.reread')}</button>
          </div>
          <textarea className="frps-config-preview" value={tomlPreview} readOnly spellCheck={false} />
        </aside>

        <main className="frps-main">
          <div className="frps-tabs">
            <button type="button" className={activeTab === 'connection' ? 'active' : ''} onClick={() => setActiveTab('connection')}>{tCurrent('auto.frpsManager.tabConnection')}</button>
            <button type="button" className={activeTab === 'proxies' ? 'active' : ''} onClick={() => void refreshProxyStatus()}>{tCurrent('auto.frpsManager.tabProxies')}</button>
            <button type="button" className={activeTab === 'logs' ? 'active' : ''} onClick={() => void loadLogs()}>{tCurrent('auto.frpsManager.tabLogs')}</button>
            <button type="button" className={activeTab === 'settings' ? 'active' : ''} onClick={() => setActiveTab('settings')}>{tCurrent('auto.frpsManager.tabSettings')}</button>
          </div>

          {activeTab === 'connection' && (
            <section className="frps-panel">
              <div className="frps-panel-head">
                <strong>{tCurrent('auto.frpsManager.connectionSummary')}</strong>
                <button type="button" className="primary" onClick={() => setConnectionModalOpen(true)}>{tCurrent('auto.frpsManager.showExample')}</button>
              </div>
              <div className="frps-table-wrap">
                <table className="frps-proxies-table">
                  <tbody>
                    <tr><th>{tCurrent('auto.frpsManager.bindAddr')}</th><td>{config.bindAddr}</td></tr>
                    <tr><th>{tCurrent('auto.frpsManager.bindPort')}</th><td>{config.bindPort}</td></tr>
                    <tr><th>Token</th><td>{config.token ? '••••••••' : '-'}</td></tr>
                    <tr><th>{tCurrent('auto.frpsManager.dashboard')}</th><td>{`${config.dashboardAddr}:${config.dashboardPort}`}</td></tr>
                    <tr><th>{tCurrent('auto.frpsManager.vhost')}</th><td>{`HTTP ${config.vhostHTTPPort} / HTTPS ${config.vhostHTTPSPort}`}</td></tr>
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {activeTab === 'proxies' && (
            <section className="frps-panel">
              <div className="frps-panel-head">
                <strong>{tCurrent('auto.frpsManager.proxyStatus')}</strong>
                <button type="button" onClick={() => void refreshProxyStatus()} disabled={controlsDisabled}>{acting === 'dashboard' ? tCurrent('auto.frpsManager.refreshing') : tCurrent('auto.frpsManager.refreshStatus')}</button>
              </div>
              <div className="frps-table-wrap">
                <table className="frps-proxies-table">
                  <thead>
                    <tr>
                      <th>{tCurrent('auto.frpsManager.colName')}</th>
                      <th>{tCurrent('auto.frpsManager.colType')}</th>
                      <th>{tCurrent('auto.frpsManager.colStatus')}</th>
                      <th>{tCurrent('auto.frpsManager.colClient')}</th>
                      <th>{tCurrent('auto.frpsManager.colTraffic')}</th>
                      <th>{tCurrent('auto.frpsManager.colConns')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {proxies.map((proxy) => (
                      <tr key={`${proxy.type}-${proxy.name}`}>
                        <td>{proxy.name}</td>
                        <td>{proxy.type || '-'}</td>
                        <td><span className={`frps-proxy-status ${proxy.status === 'online' ? 'active' : 'inactive'}`}>{proxy.status === 'online' ? tCurrent('auto.frpsManager.statusOnline') : tCurrent('auto.frpsManager.statusOffline')}</span></td>
                        <td>{proxy.clientAddr || '-'}</td>
                        <td>{`${formatTraffic(proxy.trafficIn)} / ${formatTraffic(proxy.trafficOut)}`}</td>
                        <td>{proxy.curConns ?? 0}</td>
                      </tr>
                    ))}
                    {!proxies.length && <tr><td colSpan={6} className="frps-empty">{tCurrent('auto.frpsManager.noProxies')}</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {activeTab === 'logs' && (
            <section className="frps-panel">
              <div className="frps-panel-head">
                <strong>{tCurrent('auto.frpsManager.tabLogs')}</strong>
                <button type="button" onClick={() => void loadLogs()} disabled={controlsDisabled}>{acting === 'logs' ? tCurrent('auto.frpsManager.readingLogs') : tCurrent('auto.frpsManager.refreshLogs')}</button>
              </div>
              <pre className="frps-log-viewer">{logs || tCurrent('auto.frpsManager.logsHint')}</pre>
            </section>
          )}

          {activeTab === 'settings' && (
            <section className="frps-panel frps-settings">
              <label>
                <span>{tCurrent('auto.frpsManager.serviceMode')}</span>
                <select value={status.serviceMode} onChange={(event) => updateStatus('serviceMode', event.target.value as FrpsServiceMode)} disabled={isWindowsHost}>
                  <option value="systemd">systemd</option>
                  <option value="process">{tCurrent('auto.frpsManager.processMode')}</option>
                </select>
              </label>
              <label><span>{tCurrent('auto.frpsManager.configPath')}</span><input value={status.configPath} onChange={(event) => updateStatus('configPath', event.target.value)} /></label>
              <label className="frps-checkbox"><input type="checkbox" checked={restartAfterSave} onChange={(event) => setRestartAfterSave(event.target.checked)} /><span>{tCurrent('auto.frpsManager.restartAfterSave')}</span></label>
              <button type="button" onClick={() => void enableAutostart()} disabled={controlsDisabled}>{tCurrent('auto.frpsManager.enableAutostart')}</button>
            </section>
          )}
        </main>
      </div>

      {connectionModalOpen && createPortal(
        <div className="frps-modal-backdrop" role="presentation" onMouseDown={() => setConnectionModalOpen(false)}>
          <div className="frps-modal" onMouseDown={(event) => event.stopPropagation()}>
            <div className="frps-modal-head">
              <strong>{tCurrent('auto.frpsManager.connectionExample')}</strong>
              <button type="button" onClick={() => setConnectionModalOpen(false)}>{tCurrent('auto.frpsManager.close')}</button>
            </div>
            <textarea value={connectionExample} readOnly spellCheck={false} />
            <div className="frps-modal-actions">
              <button type="button" className="primary" onClick={() => setConnectionModalOpen(false)}>{tCurrent('auto.frpsManager.close')}</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

export default RemoteFrpsManager;
