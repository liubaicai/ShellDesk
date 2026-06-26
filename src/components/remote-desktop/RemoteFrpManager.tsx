import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
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
  if (!api) throw new Error('当前环境无法执行远程命令');
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
  if (status === 'active') return '运行中';
  if (status === 'inactive') return '已停止';
  if (status === 'error') return '错误';
  return '未知';
}

function splitList(value: string) {
  return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
}

function joinList(value?: string[]) {
  return value?.join('\n') ?? '';
}

function RemoteFrpManager({ connectionId, systemType }: FrpManagerProps) {
  const isWindowsHost = isWindowsSystem(systemType);
  const defaultConfigPath = isWindowsHost ? defaultWindowsConfigPath : defaultLinuxConfigPath;
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

  const tomlPreview = useMemo(() => generateFrpcToml(config), [config]);
  const controlsDisabled = loading || saving || installing || acting !== '' || !status.installed;

  useEffect(() => {
    let disposed = false;
    void loadRemoteConnectionProfile(connectionId, 'frp-manager' as ShellDeskDesktopAppKey).then((profile) => {
      if (disposed || !profile) return;
      setStatus((current) => ({
        ...current,
        configPath: readProfileString(profile, 'configPath', current.configPath),
        serviceMode: readProfileString(profile, 'serviceMode', current.serviceMode) === 'process' ? 'process' : 'systemd',
        adminAddr: readProfileString(profile, 'adminAddr', current.adminAddr || '127.0.0.1'),
        adminPort: Number(readProfileString(profile, 'adminPort', String(current.adminPort || 7400))) || 7400,
      }));
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

  const loadConfig = useCallback(async (configPath: string) => {
    const result = await runCmd(connectionId, createFrpcReadConfigCommand(configPath));
    const content = result.stdout || '';
    setConfig(content.trim() ? parseFrpcConfigToml(content) : defaultConfig);
  }, [connectionId]);

  const refreshRuntimeStatus = useCallback(async (nextStatus: FrpcStatus) => {
    const result = await runCmd(connectionId, createFrpcStatusCommand(isWindowsHost, nextStatus.serviceMode));
    const running = parseFrpcStatusOutput(result.stdout || '', nextStatus.serviceMode);
    setStatus((current) => ({ ...current, running }));
    return running;
  }, [connectionId, isWindowsHost]);

  const detectFrpc = useCallback(async () => {
    setLoading(true);
    setError('');
    setNotice('');
    try {
      const result = await runCmd(connectionId, createFrpcDetectCommand(isWindowsHost));
      const detected = parseFrpcDetectOutput(result.stdout || '');
      const nextStatus: FrpcStatus = {
        ...status,
        installed: detected.installed,
        version: detected.version,
        serviceMode: isWindowsHost ? 'process' : detected.systemdAvailable ? 'systemd' : 'process',
        configPath: detected.configPath || status.configPath || defaultConfigPath,
      };
      setStatus(nextStatus);
      saveProfile(nextStatus);
      if (detected.installed) {
        await loadConfig(nextStatus.configPath);
        await refreshRuntimeStatus(nextStatus);
        setNotice('frpc 检测完成');
      } else {
        setNotice('未检测到 frpc，可使用安装按钮自动安装');
      }
    } catch (caughtError) {
      setError(getErrorMessage(caughtError));
    } finally {
      setLoading(false);
    }
  }, [connectionId, defaultConfigPath, isWindowsHost, loadConfig, refreshRuntimeStatus, saveProfile, status]);

  useEffect(() => {
    void detectFrpc();
  }, []);

  const installFrpc = async () => {
    setInstalling(true);
    setError('');
    setNotice('正在安装 frpc...');
    try {
      const result = await runCmd(connectionId, createFrpcInstallCommand(isWindowsHost));
      if (result.code !== 0) throw new Error(result.stderr || result.stdout || 'frpc 安装失败');
      setNotice(result.stdout || 'frpc 已安装');
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
        ? createFrpcStartCommand(isWindowsHost, status.serviceMode)
        : action === 'stop'
          ? createFrpcStopCommand(isWindowsHost, status.serviceMode)
          : createFrpcRestartCommand(isWindowsHost, status.serviceMode);
      const result = await runCmd(connectionId, command);
      if (result.code !== 0) throw new Error(result.stderr || result.stdout || '操作失败');
      await refreshRuntimeStatus(status);
      setNotice(action === 'start' ? 'frpc 已启动' : action === 'stop' ? 'frpc 已停止' : 'frpc 已重启');
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
      if (result.code !== 0) throw new Error(result.stderr || result.stdout || '配置保存失败');
      saveProfile(status);
      if (restartAfterSave && status.running) {
        await runCmd(connectionId, createFrpcRestartCommand(isWindowsHost, status.serviceMode));
        await refreshRuntimeStatus(status);
      }
      setNotice(restartAfterSave && status.running ? '配置已保存并重启 frpc' : '配置已保存');
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
      setLogs(parseFrpcLogs([result.stdout, result.stderr].filter(Boolean).join('\n')) || '暂无日志');
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
      setNotice(snapshots.length ? '代理状态已刷新' : 'Admin API 未返回代理状态');
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
      const result = await runCmd(connectionId, createFrpcEnableAutostartCommand(isWindowsHost, status.serviceMode));
      if (result.code !== 0) throw new Error(result.stderr || result.stdout || '开机自启动配置失败');
      setNotice('已配置开机自启动');
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
    setStatus((current) => {
      const next = { ...current, [key]: value };
      saveProfile(next);
      return next;
    });
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
      setError('代理名称不能为空');
      return;
    }
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
          <span>{status.installed ? 'frpc 已安装' : '未安装 frpc'}</span>
          <strong>{status.installed ? `${status.version || '未知版本'} · ${status.running ? '运行中' : '已停止'}` : '需要安装'}</strong>
        </div>
        <button type="button" onClick={detectFrpc} disabled={loading || installing}>检测</button>
        {!status.installed && <button type="button" className="primary" onClick={installFrpc} disabled={installing || loading}>{installing ? '安装中...' : '安装 frpc'}</button>}
        <button type="button" onClick={() => void runServiceAction('start')} disabled={controlsDisabled || status.running}>启动</button>
        <button type="button" onClick={() => void runServiceAction('stop')} disabled={controlsDisabled || !status.running}>停止</button>
        <button type="button" onClick={() => void runServiceAction('restart')} disabled={controlsDisabled}>重启</button>
        <button type="button" className="primary" onClick={saveConfig} disabled={controlsDisabled}>保存配置</button>
      </div>

      {error && <DismissibleAlert className="frp-alert danger" onDismiss={() => setError('')}>{error}</DismissibleAlert>}
      {notice && <DismissibleAlert className="frp-alert info" onDismiss={() => setNotice('')}>{notice}</DismissibleAlert>}

      {!status.installed && (
        <div className="frp-install-panel">
          <strong>远程主机未检测到 frpc</strong>
          <span>安装后即可编辑 frpc.toml、启动客户端并查看代理状态。</span>
          <button type="button" className="primary" onClick={installFrpc} disabled={installing}>{installing ? '正在安装...' : '安装 frpc 0.61.1'}</button>
        </div>
      )}

      <div className="frp-layout">
        <aside className="frp-config">
          <div className="frp-section-head">
            <strong>服务端配置</strong>
            <span>frpc.toml</span>
          </div>
          <label>
            <span>服务器地址</span>
            <input value={config.server.serverAddr} onChange={(event) => updateServer('serverAddr', event.target.value)} disabled={!status.installed} />
          </label>
          <label>
            <span>服务器端口</span>
            <input type="number" min="1" max="65535" value={config.server.serverPort} onChange={(event) => updateServer('serverPort', Number(event.target.value))} disabled={!status.installed} />
          </label>
          <label>
            <span>Token</span>
            <input type="password" value={config.server.token} onChange={(event) => updateServer('token', event.target.value)} disabled={!status.installed} />
          </label>
          <div className="frp-preview-head">
            <strong>配置预览</strong>
            <button type="button" onClick={() => void loadConfig(status.configPath)} disabled={!status.installed || loading}>重新读取</button>
          </div>
          <textarea className="frp-config-preview" value={tomlPreview} readOnly spellCheck={false} />
        </aside>

        <main className="frp-main">
          <div className="frp-tabs">
            <button type="button" className={activeTab === 'proxies' ? 'active' : ''} onClick={() => setActiveTab('proxies')}>代理规则</button>
            <button type="button" className={activeTab === 'logs' ? 'active' : ''} onClick={() => void loadLogs()}>日志</button>
            <button type="button" className={activeTab === 'settings' ? 'active' : ''} onClick={() => setActiveTab('settings')}>设置</button>
          </div>

          {activeTab === 'proxies' && (
            <section className="frp-panel">
              <div className="frp-panel-head">
                <strong>代理规则</strong>
                <div>
                  <button type="button" onClick={() => void refreshProxyStatus()} disabled={controlsDisabled}>刷新状态</button>
                  <button type="button" className="primary" onClick={() => setProxyModal({ mode: 'add', index: -1, value: createEmptyProxy() })} disabled={!status.installed}>添加代理</button>
                </div>
              </div>
              <div className="frp-table-wrap">
                <table className="frp-proxies-table">
                  <thead>
                    <tr>
                      <th>名称</th>
                      <th>类型</th>
                      <th>本地地址</th>
                      <th>本地端口</th>
                      <th>远程端口/域名</th>
                      <th>状态</th>
                      <th>操作</th>
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
                          <button type="button" onClick={() => setProxyModal({ mode: 'edit', index, value: { ...proxy } })}>编辑</button>
                          <button type="button" className="danger" onClick={() => setConfig((current) => ({ ...current, proxies: current.proxies.filter((_, proxyIndex) => proxyIndex !== index) }))}>删除</button>
                        </td>
                      </tr>
                    ))}
                    {!config.proxies.length && (
                      <tr>
                        <td colSpan={7} className="frp-empty">暂无代理规则</td>
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
                <strong>日志</strong>
                <button type="button" onClick={() => void loadLogs()} disabled={controlsDisabled}>{acting === 'logs' ? '读取中...' : '刷新日志'}</button>
              </div>
              <pre className="frp-log-viewer">{logs || '点击刷新日志读取最近输出'}</pre>
            </section>
          )}

          {activeTab === 'settings' && (
            <section className="frp-panel frp-settings">
              <label>
                <span>运行模式</span>
                <select value={status.serviceMode} onChange={(event) => updateStatus('serviceMode', event.target.value as FrpcServiceMode)} disabled={isWindowsHost}>
                  <option value="systemd">systemd</option>
                  <option value="process">进程</option>
                </select>
              </label>
              <label>
                <span>配置路径</span>
                <input value={status.configPath} onChange={(event) => updateStatus('configPath', event.target.value)} />
              </label>
              <label>
                <span>Admin 地址</span>
                <input value={status.adminAddr || ''} onChange={(event) => updateStatus('adminAddr', event.target.value)} />
              </label>
              <label>
                <span>Admin 端口</span>
                <input type="number" min="1" max="65535" value={status.adminPort || 7400} onChange={(event) => updateStatus('adminPort', Number(event.target.value))} />
              </label>
              <label className="frp-checkbox">
                <input type="checkbox" checked={restartAfterSave} onChange={(event) => setRestartAfterSave(event.target.checked)} />
                <span>保存配置后自动重启运行中的 frpc</span>
              </label>
              <button type="button" onClick={() => void enableAutostart()} disabled={controlsDisabled}>启用开机自启动</button>
            </section>
          )}
        </main>
      </div>

      {proxyModal && createPortal(
        <div className="frp-modal-backdrop" role="presentation" onMouseDown={() => setProxyModal(null)}>
          <form className="frp-modal" onSubmit={submitProxy} onMouseDown={(event) => event.stopPropagation()}>
            <div className="frp-modal-head">
              <strong>{proxyModal.mode === 'edit' ? '编辑代理' : '添加代理'}</strong>
              <button type="button" onClick={() => setProxyModal(null)}>关闭</button>
            </div>
            <label>
              <span>名称</span>
              <input value={proxyModal.value.name} onChange={(event) => updateProxyForm('name', event.target.value)} autoFocus />
            </label>
            <label>
              <span>类型</span>
              <select value={proxyModal.value.type} onChange={(event) => updateProxyForm('type', event.target.value as FrpcProxyType)}>
                {proxyTypes.map((type) => <option key={type} value={type}>{type}</option>)}
              </select>
            </label>
            <label>
              <span>本地地址</span>
              <input value={proxyModal.value.localIP} onChange={(event) => updateProxyForm('localIP', event.target.value)} />
            </label>
            <label>
              <span>本地端口</span>
              <input type="number" min="1" max="65535" value={proxyModal.value.localPort} onChange={(event) => updateProxyForm('localPort', Number(event.target.value))} />
            </label>
            {(proxyModal.value.type === 'tcp' || proxyModal.value.type === 'udp') && (
              <label>
                <span>远程端口</span>
                <input type="number" min="1" max="65535" value={proxyModal.value.remotePort || ''} onChange={(event) => updateProxyForm('remotePort', Number(event.target.value))} />
              </label>
            )}
            {(proxyModal.value.type === 'http' || proxyModal.value.type === 'https') && (
              <>
                <label>
                  <span>自定义域名</span>
                  <textarea value={joinList(proxyModal.value.customDomains)} onChange={(event: ChangeEvent<HTMLTextAreaElement>) => updateProxyForm('customDomains', splitList(event.target.value))} />
                </label>
                <label>
                  <span>URL 路径</span>
                  <textarea value={joinList(proxyModal.value.locations)} onChange={(event: ChangeEvent<HTMLTextAreaElement>) => updateProxyForm('locations', splitList(event.target.value))} />
                </label>
              </>
            )}
            {(proxyModal.value.type === 'stcp' || proxyModal.value.type === 'xtcp') && (
              <label>
                <span>Secret Key</span>
                <input value={proxyModal.value.secretKey || ''} onChange={(event) => updateProxyForm('secretKey', event.target.value)} />
              </label>
            )}
            <label className="frp-checkbox">
              <input type="checkbox" checked={Boolean(proxyModal.value.encryption)} onChange={(event) => updateProxyForm('encryption', event.target.checked)} />
              <span>启用加密</span>
            </label>
            <label className="frp-checkbox">
              <input type="checkbox" checked={Boolean(proxyModal.value.compression)} onChange={(event) => updateProxyForm('compression', event.target.checked)} />
              <span>启用压缩</span>
            </label>
            <div className="frp-modal-actions">
              <button type="button" onClick={() => setProxyModal(null)}>取消</button>
              <button type="submit" className="primary">保存</button>
            </div>
          </form>
        </div>,
        document.body,
      )}
    </div>
  );
}

export default RemoteFrpManager;
