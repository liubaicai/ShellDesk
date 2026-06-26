import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { tCurrent } from '../../i18n';
import DismissibleAlert from './DismissibleAlert';
import { getErrorMessage } from './desktopUtils';
import { isWindowsSystem, type RemoteCommandInput } from './remoteSystem';
import { loadRemoteConnectionProfile, readProfileString, saveRemoteConnectionProfile } from './remoteConnectionProfiles';
import {
  createFrpcAdminStatusCommand,
  createFrpcDetectCommand,
  createFrpcEnableAutostartCommand,
  createFrpcInstallCommand,
  createFrpcLogsCommand,
  createFrpcReadConfigCommand,
  createFrpcRestartCommand,
  createFrpcStartCommand,
  createFrpcStatusCommand,
  createFrpcStopCommand,
  createFrpcWriteConfigCommand,
  generateFrpcToml,
} from './frpCommands';
import { parseFrpcAdminApi, parseFrpcConfigToml, parseFrpcDetectOutput, parseFrpcLogs, parseFrpcStatusOutput } from './frpParsers';
import type { FrpManagerProps, FrpcConfig, FrpcProxy, FrpcProxyStatus, FrpcProxyType, FrpcServiceMode, FrpcStatus } from './frpTypes';
import '../../styles/remote-desktop/_frp-manager.scss';

type FrpTab = 'proxies' | 'logs' | 'settings';
type ProxyForm = FrpcProxy;

const defaultLinuxConfigPath = '/etc/frp/frpc.toml';
const defaultMacConfigPath = '/usr/local/etc/frp/frpc.toml';
const defaultWindowsConfigPath = '%USERPROFILE%\\.frp\\frpc.toml';
const proxyTypes: FrpcProxyType[] = ['tcp', 'udp', 'http', 'https', 'stcp', 'xtcp'];

const defaultConfig: FrpcConfig = {
  server: {
    serverAddr: '',
    serverPort: 7000,
    token: '',
  },
  proxies: [],
};

function runCmd(connectionId: string, input: RemoteCommandInput) {
  const api = window.guiSSH?.connections;
  if (!api) throw new Error(tCurrent('auto.frpManager.noRemoteCommand'));
  return api.runCommand(connectionId, input.command, input.stdin);
}

function createEmptyProxy(): ProxyForm {
  return {
    name: '',
    type: 'tcp',
    localIP: '127.0.0.1',
    localPort: 80,
    remotePort: 0,
    customDomains: [],
    locations: [],
    encryption: false,
    compression: false,
  };
}

function formatProxyTarget(proxy: FrpcProxy) {
  if (proxy.type === 'http' || proxy.type === 'https') {
    return proxy.customDomains?.length ? proxy.customDomains.join(', ') : proxy.subDomain || '-';
  }
  return proxy.remotePort || '-';
}

function formatTraffic(value?: number) {
  if (!value) return '-';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function getStatusLabel(status?: FrpcProxyStatus) {
  if (status === 'active') return tCurrent('auto.frpManager.statusRunning');
  if (status === 'inactive') return tCurrent('auto.frpManager.statusStopped');
  if (status === 'error') return tCurrent('auto.frpManager.statusError');
  return tCurrent('auto.frpManager.statusUnknown');
}

function splitList(value: string) {
  return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
}

function joinList(value?: string[]) {
  return value?.join('\n') ?? '';
}

function RemoteFrpManager({ connectionId, systemType }: FrpManagerProps) {
  const isWindowsHost = isWindowsSystem(systemType);
  const isMacHost = systemType === 'macos';
  const defaultConfigPath = isWindowsHost ? defaultWindowsConfigPath : isMacHost ? defaultMacConfigPath : defaultLinuxConfigPath;
  const [status, setStatus] = useState<FrpcStatus>({
    installed: false,
    version: '',
    running: false,
    serviceMode: 'systemd',
    configPath: defaultConfigPath,
    adminAddr: '127.0.0.1',
    adminPort: 7400,
  });
  const [config, setConfig] = useState<FrpcConfig>(defaultConfig);
  const [activeTab, setActiveTab] = useState<FrpTab>('proxies');
  const [logs, setLogs] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [acting, setActing] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [proxyModal, setProxyModal] = useState<{ mode: 'add' | 'edit'; index: number; value: ProxyForm } | null>(null);
  const [restartAfterSave, setRestartAfterSave] = useState(true);
  const statusRef = useRef(status);

  const tomlPreview = useMemo(() => generateFrpcToml(config), [config]);
  const controlsDisabled = loading || saving || installing || acting !== '' || !status.installed;

  useEffect(() => {
    let disposed = false;
    void loadRemoteConnectionProfile(connectionId, 'frp-manager' as ShellDeskDesktopAppKey).then((profile) => {
      if (disposed || !profile) return;
      setStatus((current) => {
        const next = {
          ...current,
          configPath: readProfileString(profile, 'configPath', current.configPath),
          serviceMode: readProfileString(profile, 'serviceMode', current.serviceMode) === 'process' ? 'process' as const : 'systemd' as const,
          adminAddr: readProfileString(profile, 'adminAddr', current.adminAddr || '127.0.0.1'),
          adminPort: Number(readProfileString(profile, 'adminPort', String(current.adminPort || 7400))) || 7400,
        };
        statusRef.current = next;
        return next;
      });
    });
    return () => {
      disposed = true;
    };
  }, [connectionId]);

  const saveProfile = useCallback((nextStatus: FrpcStatus) => {
    void saveRemoteConnectionProfile(connectionId, 'frp-manager' as ShellDeskDesktopAppKey, {
      configPath: nextStatus.configPath,
      serviceMode: nextStatus.serviceMode,
      adminAddr: nextStatus.adminAddr || '127.0.0.1',
      adminPort: String(nextStatus.adminPort || 7400),
    });
  }, [connectionId]);

  const persistStatus = useCallback((nextStatus: FrpcStatus) => {
    statusRef.current = nextStatus;
    saveProfile(nextStatus);
  }, [saveProfile]);

  const loadConfig = useCallback(async (configPath: string) => {
    const result = await runCmd(connectionId, createFrpcReadConfigCommand(configPath));
    const content = result.stdout || '';
    setConfig(content.trim() ? parseFrpcConfigToml(content) : defaultConfig);
  }, [connectionId]);

  const refreshRuntimeStatus = useCallback(async (nextStatus: FrpcStatus) => {
    const result = await runCmd(connectionId, createFrpcStatusCommand(isWindowsHost, nextStatus.serviceMode, nextStatus.configPath));
    const running = parseFrpcStatusOutput(result.stdout || '', nextStatus.serviceMode);
    setStatus((current) => {
      const next = { ...current, running };
      statusRef.current = next;
      return next;
    });
    return running;
  }, [connectionId, isWindowsHost]);

  const detectFrpc = useCallback(async () => {
    setLoading(true);
    setError('');
    setNotice('');
    try {
      const result = await runCmd(connectionId, createFrpcDetectCommand(isWindowsHost, isMacHost));
      const detected = parseFrpcDetectOutput(result.stdout || '');
      const detectedStatus: Partial<FrpcStatus> = {
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
        setNotice(tCurrent('auto.frpManager.detectDone'));
      } else {
        setNotice(tCurrent('auto.frpManager.detectNone'));
      }
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    } finally {
      setLoading(false);
    }
  }, [connectionId, defaultConfigPath, isMacHost, isWindowsHost, loadConfig, refreshRuntimeStatus, persistStatus]);

  useEffect(() => {
    void detectFrpc();
  }, []);

  const installFrpc = async () => {
    setInstalling(true);
    setError('');
    setNotice(tCurrent('auto.frpManager.installing'));
    try {
      const result = await runCmd(connectionId, createFrpcInstallCommand(isWindowsHost, isMacHost));
      if (result.code !== 0) throw new Error(result.stderr || result.stdout || tCurrent('auto.frpManager.installFailed'));
      setNotice(result.stdout || tCurrent('auto.frpManager.installed'));
      await detectFrpc();
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
      const command = action === 'start'
        ? createFrpcStartCommand(isWindowsHost, status.serviceMode, status.configPath)
        : action === 'stop'
          ? createFrpcStopCommand(isWindowsHost, status.serviceMode, status.configPath)
          : createFrpcRestartCommand(isWindowsHost, status.serviceMode, status.configPath);
      const result = await runCmd(connectionId, command);
      if (result.code !== 0) throw new Error(result.stderr || result.stdout || tCurrent('auto.frpManager.actionFailed'));
      await refreshRuntimeStatus(status);
      setNotice(action === 'start' ? tCurrent('auto.frpManager.started') : action === 'stop' ? tCurrent('auto.frpManager.stopped') : tCurrent('auto.frpManager.restarted'));
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
      const result = await runCmd(connectionId, createFrpcWriteConfigCommand(status.configPath, tomlPreview));
      if (result.code !== 0) throw new Error(result.stderr || result.stdout || tCurrent('auto.frpManager.configSaveFailed'));
      saveProfile(status);
      if (restartAfterSave && status.running) {
        await runCmd(connectionId, createFrpcRestartCommand(isWindowsHost, status.serviceMode, status.configPath));
        await refreshRuntimeStatus(status);
      }
      setNotice(restartAfterSave && status.running ? tCurrent('auto.frpManager.configSavedRestart') : tCurrent('auto.frpManager.configSaved'));
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
      const result = await runCmd(connectionId, createFrpcLogsCommand(isWindowsHost, status.serviceMode, 80));
      setLogs(parseFrpcLogs([result.stdout, result.stderr].filter(Boolean).join('\n')) || tCurrent('auto.frpManager.noLogs'));
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    } finally {
      setActing('');
    }
  };

  const refreshProxyStatus = async () => {
    setActing('admin');
    setError('');
    try {
      const result = await runCmd(connectionId, createFrpcAdminStatusCommand(status.adminAddr || '127.0.0.1', status.adminPort || 7400));
      const snapshots = parseFrpcAdminApi(result.stdout || '');
      setConfig((current) => ({
        ...current,
        proxies: current.proxies.map((proxy) => {
          const snapshot = snapshots.find((item) => item.name === proxy.name);
          return snapshot ? { ...proxy, ...snapshot } : proxy;
        }),
      }));
      setNotice(snapshots.length ? tCurrent('auto.frpManager.proxyRefreshed') : tCurrent('auto.frpManager.proxyRefreshEmpty'));
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
      const result = await runCmd(connectionId, createFrpcEnableAutostartCommand(isWindowsHost, status.serviceMode, status.configPath));
      if (result.code !== 0) throw new Error(result.stderr || result.stdout || tCurrent('auto.frpManager.autostartFailed'));
      setNotice(tCurrent('auto.frpManager.autostartDone'));
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    } finally {
      setActing('');
    }
  };

  const updateServer = <Key extends keyof FrpcConfig['server']>(key: Key, value: FrpcConfig['server'][Key]) => {
    setConfig((current) => ({ ...current, server: { ...current.server, [key]: value } }));
  };

  const updateStatus = <Key extends keyof FrpcStatus>(key: Key, value: FrpcStatus[Key]) => {
    const next = { ...statusRef.current, [key]: value };
    setStatus(next);
    persistStatus(next);
  };

  const submitProxy = (event: FormEvent) => {
    event.preventDefault();
    if (!proxyModal) return;
    const proxy = {
      ...proxyModal.value,
      name: proxyModal.value.name.trim(),
      localIP: proxyModal.value.localIP.trim() || '127.0.0.1',
      customDomains: proxyModal.value.customDomains?.filter(Boolean),
      locations: proxyModal.value.locations?.filter(Boolean),
    };
    if (!proxy.name) {
      setError(tCurrent('auto.frpManager.proxyNameRequired'));
      return;
    }
    if (proxy.localPort < 1 || proxy.localPort > 65535) {
      setError(tCurrent('auto.frpManager.localPortInvalid'));
      return;
    }
    if (proxy.type === 'tcp' || proxy.type === 'udp') {
      if (!proxy.remotePort || proxy.remotePort < 1 || proxy.remotePort > 65535) {
        setError(tCurrent('auto.frpManager.remotePortInvalid'));
        return;
      }
    }
    if (proxy.type === 'http' || proxy.type === 'https') {
      if (!proxy.customDomains?.length && !proxy.subDomain) {
        setError(tCurrent('auto.frpManager.httpDomainRequired'));
        return;
      }
    }
    if (proxy.subDomain) {
      proxy.subDomain = proxy.subDomain.trim();
    }
    if (proxy.secretKey) {
      proxy.secretKey = proxy.secretKey.trim();
    }
    if (!proxy.subDomain) {
      delete proxy.subDomain;
    }
    if (!proxy.secretKey) {
      delete proxy.secretKey;
    }
    if (!proxy.customDomains?.length) {
      delete proxy.customDomains;
    }
    if (!proxy.locations?.length) {
      delete proxy.locations;
    }
    setError('');
    setConfig((current) => {
      const proxies = [...current.proxies];
      if (proxyModal.mode === 'edit') proxies[proxyModal.index] = proxy;
      else proxies.push(proxy);
      return { ...current, proxies };
    });
    setProxyModal(null);
  };

  const updateProxyForm = <Key extends keyof ProxyForm>(key: Key, value: ProxyForm[Key]) => {
    setProxyModal((current) => current ? { ...current, value: { ...current.value, [key]: value } } : current);
  };

  return (
    <div className="frp-manager">
      <div className="frp-toolbar">
        <div className={`frp-status ${status.installed ? 'installed' : 'missing'} ${status.running ? 'running' : 'stopped'}`}>
          <span>{status.installed ? tCurrent('auto.frpManager.frpcInstalled') : tCurrent('auto.frpManager.frpcNotInstalled')}</span>
          <strong>{status.installed ? `${status.version || tCurrent('auto.frpManager.unknownVersion')} · ${status.running ? tCurrent('auto.frpManager.statusRunning') : tCurrent('auto.frpManager.statusStopped')}` : tCurrent('auto.frpManager.needInstall')}</strong>
        </div>
        <button type="button" onClick={detectFrpc} disabled={loading || installing}>{tCurrent('auto.frpManager.detect')}</button>
        {!status.installed && <button type="button" className="primary" onClick={installFrpc} disabled={installing || loading}>{installing ? tCurrent('auto.frpManager.installingBtn') : tCurrent('auto.frpManager.installBtn')}</button>}
        <button type="button" onClick={() => void runServiceAction('start')} disabled={controlsDisabled || status.running}>{tCurrent('auto.frpManager.start')}</button>
        <button type="button" onClick={() => void runServiceAction('stop')} disabled={controlsDisabled || !status.running}>{tCurrent('auto.frpManager.stop')}</button>
        <button type="button" onClick={() => void runServiceAction('restart')} disabled={controlsDisabled}>{tCurrent('auto.frpManager.restart')}</button>
        <button type="button" className="primary" onClick={saveConfig} disabled={controlsDisabled}>{tCurrent('auto.frpManager.saveConfig')}</button>
      </div>

      {error && <DismissibleAlert className="frp-alert danger" onDismiss={() => setError('')}>{error}</DismissibleAlert>}
      {notice && <DismissibleAlert className="frp-alert info" onDismiss={() => setNotice('')}>{notice}</DismissibleAlert>}

      {!status.installed && (
        <div className="frp-install-panel">
          <strong>{tCurrent('auto.frpManager.remoteNotDetected')}</strong>
          <span>{tCurrent('auto.frpManager.installHint')}</span>
          <button type="button" className="primary" onClick={installFrpc} disabled={installing}>{installing ? tCurrent('auto.frpManager.installingBtnAlt') : tCurrent('auto.frpManager.installVersion', { value0: '0.61.1' })}</button>
        </div>
      )}

      <div className="frp-layout">
        <aside className="frp-config">
          <div className="frp-section-head">
            <strong>{tCurrent('auto.frpManager.serverConfig')}</strong>
            <span>frpc.toml</span>
          </div>
          <label>
            <span>{tCurrent('auto.frpManager.serverAddr')}</span>
            <input value={config.server.serverAddr} onChange={(event) => updateServer('serverAddr', event.target.value)} disabled={!status.installed} />
          </label>
          <label>
            <span>{tCurrent('auto.frpManager.serverPort')}</span>
            <input type="number" min="1" max="65535" value={config.server.serverPort} onChange={(event) => updateServer('serverPort', Number(event.target.value))} disabled={!status.installed} />
          </label>
          <label>
            <span>Token</span>
            <input type="password" value={config.server.token} onChange={(event) => updateServer('token', event.target.value)} disabled={!status.installed} />
          </label>
          <div className="frp-preview-head">
            <strong>{tCurrent('auto.frpManager.configPreview')}</strong>
            <button type="button" onClick={() => void loadConfig(status.configPath)} disabled={!status.installed || loading}>{tCurrent('auto.frpManager.reread')}</button>
          </div>
          <textarea className="frp-config-preview" value={tomlPreview} readOnly spellCheck={false} />
        </aside>

        <main className="frp-main">
          <div className="frp-tabs">
            <button type="button" className={activeTab === 'proxies' ? 'active' : ''} onClick={() => setActiveTab('proxies')}>{tCurrent('auto.frpManager.tabProxies')}</button>
            <button type="button" className={activeTab === 'logs' ? 'active' : ''} onClick={() => void loadLogs()}>{tCurrent('auto.frpManager.tabLogs')}</button>
            <button type="button" className={activeTab === 'settings' ? 'active' : ''} onClick={() => setActiveTab('settings')}>{tCurrent('auto.frpManager.tabSettings')}</button>
          </div>

          {activeTab === 'proxies' && (
            <section className="frp-panel">
              <div className="frp-panel-head">
                <strong>{tCurrent('auto.frpManager.proxyRules')}</strong>
                <div>
                  <button type="button" onClick={() => void refreshProxyStatus()} disabled={controlsDisabled}>{tCurrent('auto.frpManager.refreshStatus')}</button>
                  <button type="button" className="primary" onClick={() => setProxyModal({ mode: 'add', index: -1, value: createEmptyProxy() })} disabled={!status.installed}>{tCurrent('auto.frpManager.addProxy')}</button>
                </div>
              </div>
              <div className="frp-table-wrap">
                <table className="frp-proxies-table">
                  <thead>
                    <tr>
                      <th>{tCurrent('auto.frpManager.colName')}</th>
                      <th>{tCurrent('auto.frpManager.colType')}</th>
                      <th>{tCurrent('auto.frpManager.colLocalAddr')}</th>
                      <th>{tCurrent('auto.frpManager.colLocalPort')}</th>
                      <th>{tCurrent('auto.frpManager.colRemote')}</th>
                      <th>{tCurrent('auto.frpManager.colStatus')}</th>
                      <th>{tCurrent('auto.frpManager.colActions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {config.proxies.map((proxy, index) => (
                      <tr key={`${proxy.name}-${index}`}>
                        <td>{proxy.name}</td>
                        <td>{proxy.type}</td>
                        <td>{proxy.localIP}</td>
                        <td>{proxy.localPort}</td>
                        <td>{formatProxyTarget(proxy)}</td>
                        <td><span className={`frp-proxy-status ${proxy.status || 'unknown'}`}>{getStatusLabel(proxy.status)}</span></td>
                        <td>
                          <button type="button" onClick={() => setProxyModal({ mode: 'edit', index, value: { ...proxy } })}>{tCurrent('auto.frpManager.edit')}</button>
                          <button type="button" className="danger" onClick={() => setConfig((current) => ({ ...current, proxies: current.proxies.filter((_, proxyIndex) => proxyIndex !== index) }))}>{tCurrent('auto.frpManager.delete')}</button>
                        </td>
                      </tr>
                    ))}
                    {!config.proxies.length && (
                      <tr>
                        <td colSpan={7} className="frp-empty">{tCurrent('auto.frpManager.noProxies')}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {activeTab === 'logs' && (
            <section className="frp-panel">
              <div className="frp-panel-head">
                <strong>{tCurrent('auto.frpManager.tabLogs')}</strong>
                <button type="button" onClick={() => void loadLogs()} disabled={controlsDisabled}>{acting === 'logs' ? tCurrent('auto.frpManager.readingLogs') : tCurrent('auto.frpManager.refreshLogs')}</button>
              </div>
              <pre className="frp-log-viewer">{logs || tCurrent('auto.frpManager.logsHint')}</pre>
            </section>
          )}

          {activeTab === 'settings' && (
            <section className="frp-panel frp-settings">
              <label>
                <span>{tCurrent('auto.frpManager.serviceMode')}</span>
                <select value={status.serviceMode} onChange={(event) => updateStatus('serviceMode', event.target.value as FrpcServiceMode)} disabled={isWindowsHost}>
                  <option value="systemd">systemd</option>
                  <option value="process">{tCurrent('auto.frpManager.processMode')}</option>
                </select>
              </label>
              <label>
                <span>{tCurrent('auto.frpManager.configPath')}</span>
                <input value={status.configPath} onChange={(event) => updateStatus('configPath', event.target.value)} />
              </label>
              <label>
                <span>{tCurrent('auto.frpManager.adminAddr')}</span>
                <input value={status.adminAddr || ''} onChange={(event) => updateStatus('adminAddr', event.target.value)} />
              </label>
              <label>
                <span>{tCurrent('auto.frpManager.adminPort')}</span>
                <input type="number" min="1" max="65535" value={status.adminPort || 7400} onChange={(event) => updateStatus('adminPort', Number(event.target.value))} />
              </label>
              <label className="frp-checkbox">
                <input type="checkbox" checked={restartAfterSave} onChange={(event) => setRestartAfterSave(event.target.checked)} />
                <span>{tCurrent('auto.frpManager.restartAfterSave')}</span>
              </label>
              <button type="button" onClick={() => void enableAutostart()} disabled={controlsDisabled}>{tCurrent('auto.frpManager.enableAutostart')}</button>
            </section>
          )}
        </main>
      </div>

      {proxyModal && createPortal(
        <div className="frp-modal-backdrop" role="presentation" onMouseDown={() => setProxyModal(null)}>
          <form className="frp-modal" onSubmit={submitProxy} onMouseDown={(event) => event.stopPropagation()}>
            <div className="frp-modal-head">
              <strong>{proxyModal.mode === 'edit' ? tCurrent('auto.frpManager.editProxyTitle') : tCurrent('auto.frpManager.addProxyTitle')}</strong>
              <button type="button" onClick={() => setProxyModal(null)}>{tCurrent('auto.frpManager.close')}</button>
            </div>
            <label>
              <span>{tCurrent('auto.frpManager.proxyName')}</span>
              <input value={proxyModal.value.name} onChange={(event) => updateProxyForm('name', event.target.value)} autoFocus />
            </label>
            <label>
              <span>{tCurrent('auto.frpManager.proxyType')}</span>
              <select value={proxyModal.value.type} onChange={(event) => updateProxyForm('type', event.target.value as FrpcProxyType)}>
                {proxyTypes.map((type) => <option key={type} value={type}>{type}</option>)}
              </select>
            </label>
            <label>
              <span>{tCurrent('auto.frpManager.localAddr')}</span>
              <input value={proxyModal.value.localIP} onChange={(event) => updateProxyForm('localIP', event.target.value)} />
            </label>
            <label>
              <span>{tCurrent('auto.frpManager.localPort')}</span>
              <input type="number" min="1" max="65535" value={proxyModal.value.localPort} onChange={(event) => updateProxyForm('localPort', Number(event.target.value))} />
            </label>
            {(proxyModal.value.type === 'tcp' || proxyModal.value.type === 'udp') && (
              <label>
                <span>{tCurrent('auto.frpManager.remotePort')}</span>
                <input type="number" min="1" max="65535" value={proxyModal.value.remotePort || ''} onChange={(event) => updateProxyForm('remotePort', Number(event.target.value))} />
              </label>
            )}
            {(proxyModal.value.type === 'http' || proxyModal.value.type === 'https') && (
              <>
                <label>
                  <span>{tCurrent('auto.frpManager.customDomains')}</span>
                  <textarea value={joinList(proxyModal.value.customDomains)} onChange={(event: ChangeEvent<HTMLTextAreaElement>) => updateProxyForm('customDomains', splitList(event.target.value))} />
                </label>
                <label>
                  <span>{tCurrent('auto.frpManager.subDomain')}</span>
                  <input value={proxyModal.value.subDomain || ''} onChange={(event) => updateProxyForm('subDomain', event.target.value)} />
                </label>
                <label>
                  <span>{tCurrent('auto.frpManager.urlPaths')}</span>
                  <textarea value={joinList(proxyModal.value.locations)} onChange={(event: ChangeEvent<HTMLTextAreaElement>) => updateProxyForm('locations', splitList(event.target.value))} />
                </label>
              </>
            )}
            {(proxyModal.value.type === 'stcp' || proxyModal.value.type === 'xtcp') && (
              <label>
                <span>{tCurrent('auto.frpManager.secretKey')}</span>
                <input value={proxyModal.value.secretKey || ''} onChange={(event) => updateProxyForm('secretKey', event.target.value)} />
              </label>
            )}
            <label className="frp-checkbox">
              <input type="checkbox" checked={Boolean(proxyModal.value.encryption)} onChange={(event) => updateProxyForm('encryption', event.target.checked)} />
              <span>{tCurrent('auto.frpManager.enableEncryption')}</span>
            </label>
            <label className="frp-checkbox">
              <input type="checkbox" checked={Boolean(proxyModal.value.compression)} onChange={(event) => updateProxyForm('compression', event.target.checked)} />
              <span>{tCurrent('auto.frpManager.enableCompression')}</span>
            </label>
            <div className="frp-modal-actions">
              <button type="button" onClick={() => setProxyModal(null)}>{tCurrent('auto.frpManager.cancel')}</button>
              <button type="submit" className="primary">{tCurrent('auto.frpManager.save')}</button>
            </div>
          </form>
        </div>,
        document.body,
      )}
    </div>
  );
}

export default RemoteFrpManager;
