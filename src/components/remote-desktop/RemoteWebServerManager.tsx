import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import DismissibleAlert from './DismissibleAlert';

import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import { isWindowsSystem, type RemoteCommandInput } from './remoteSystem';
import type { RemoteSystemType } from './types';
import {
  createWebServerActionCommand,
  createWebServerSnapshotCommand,
  getWebServerLabel,
  parseWebServerSnapshot,
  type WebServerAction,
  type WebServerKind,
  type WebServerService,
  type WebServerSnapshot,
  type WebSiteConfigSummary,
} from './webServerParsers';

interface RemoteWebServerManagerProps {
  connectionId: string;
  systemType?: RemoteSystemType;
  onOpenConfigFile?: (filePath: string) => void;
}

type WebTab = 'summary' | 'config' | 'raw';

interface PendingWebAction {
  action: WebServerAction;
  label: string;
  service: WebServerService;
  command: RemoteCommandInput;
  danger?: boolean;
}

function runCmd(connectionId: string, input: RemoteCommandInput) {
  const api = window.guiSSH?.connections;

  if (!api) {
    throw new Error('ShellDesk IPC 未就绪。');
  }

  return api.runCommand(connectionId, input.command, input.stdin);
}

function getStatusTone(status?: string) {
  const value = status?.toLowerCase() ?? '';

  if (value.includes('active') || value.includes('running')) return 'success';
  if (value.includes('inactive') || value.includes('stopped')) return 'warning';
  if (value.includes('failed')) return 'danger';
  return 'unknown';
}

function firstValue(values: string[]) {
  return values.length ? values.join(', ') : '-';
}

function getSiteTitle(site: WebSiteConfigSummary) {
  return site.serverNames[0] || site.filePath.split(/[\\/]/).pop() || site.filePath;
}

function RemoteWebServerManager({ connectionId, systemType, onOpenConfigFile }: RemoteWebServerManagerProps) {
  const isWindowsHost = isWindowsSystem(systemType);
  const [snapshot, setSnapshot] = useState<WebServerSnapshot | null>(null);
  const [activeKind, setActiveKind] = useState<WebServerKind>('nginx');
  const [selectedSiteId, setSelectedSiteId] = useState('');
  const [activeTab, setActiveTab] = useState<WebTab>('summary');
  const [testOutput, setTestOutput] = useState('');
  const [loading, setLoading] = useState(false);
  const [actionRunning, setActionRunning] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [lastRefreshedAt, setLastRefreshedAt] = useState('');
  const [pendingAction, setPendingAction] = useState<PendingWebAction | null>(null);

  const activeService = useMemo(() => {
    return snapshot?.services.find((service) => service.kind === activeKind) ?? snapshot?.services[0] ?? null;
  }, [activeKind, snapshot?.services]);

  const visibleSites = useMemo(() => {
    return snapshot?.sites.filter((site) => site.kind === activeKind) ?? [];
  }, [activeKind, snapshot?.sites]);

  const selectedSite = useMemo(() => {
    return visibleSites.find((site) => site.id === selectedSiteId) ?? visibleSites[0] ?? null;
  }, [selectedSiteId, visibleSites]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    setNotice('');

    try {
      const result = await runCmd(connectionId, createWebServerSnapshotCommand(isWindowsHost));
      const nextSnapshot = parseWebServerSnapshot(result.stdout, result.stderr);
      const nextKind = activeKind && nextSnapshot.services.some((service) => service.kind === activeKind)
        ? activeKind
        : nextSnapshot.services[0]?.kind ?? 'nginx';

      setSnapshot(nextSnapshot);
      setActiveKind(nextKind);
      setSelectedSiteId((current) => (
        current && nextSnapshot.sites.some((site) => site.id === current)
          ? current
          : nextSnapshot.sites.find((site) => site.kind === nextKind)?.id ?? ''
      ));
      setLastRefreshedAt(new Date().toLocaleTimeString(getShellDeskLocale()));
      setNotice(nextSnapshot.services.length
        ? `检测到 ${nextSnapshot.services.length} 个 Web 服务，${nextSnapshot.sites.length} 个配置文件。`
        : '未检测到 Nginx、Apache 或 Caddy。');
    } catch (error) {
      setError(getErrorMessage(error));
      setSnapshot(null);
    } finally {
      setLoading(false);
    }
  }, [activeKind, connectionId, isWindowsHost]);

  useEffect(() => {
    void refresh();
  }, [connectionId, isWindowsHost]);

  const prepareAction = (action: WebServerAction) => {
    if (!activeService) return;

    try {
      const labels: Record<WebServerAction, string> = {
        test: '配置测试',
        reload: 'Reload',
        restart: 'Restart',
      };

      setPendingAction({
        action,
        label: labels[action],
        service: activeService,
        command: createWebServerActionCommand(activeService.kind, action, activeService.serviceName, isWindowsHost),
        danger: action !== 'test',
      });
    } catch (error) {
      setError(getErrorMessage(error));
    }
  };

  const executePendingAction = async () => {
    if (!pendingAction) return;

    setActionRunning(true);
    setError('');
    setNotice('');

    try {
      const result = await runCmd(connectionId, pendingAction.command);
      const output = result.stdout || result.stderr || `${pendingAction.label} 已执行。`;

      if (result.code !== 0) {
        throw new Error(output);
      }

      if (pendingAction.action === 'test') {
        setTestOutput(output);
        setActiveTab('raw');
      }

      setNotice(output);
      setPendingAction(null);

      if (pendingAction.action !== 'test') {
        await refresh();
      }
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setActionRunning(false);
    }
  };

  const copySiteSummary = async () => {
    if (!selectedSite) return;

    await navigator.clipboard.writeText([
      `${getWebServerLabel(selectedSite.kind)} ${getSiteTitle(selectedSite)}`,
      `file: ${selectedSite.filePath}`,
      `enabled: ${selectedSite.enabled}`,
      `listen: ${firstValue(selectedSite.listens)}`,
      `root: ${selectedSite.root ?? '-'}`,
      `access_log: ${selectedSite.accessLog ?? '-'}`,
      `error_log: ${selectedSite.errorLog ?? '-'}`,
      `certificates: ${firstValue(selectedSite.certificateFiles)}`,
    ].join('\n'));
    setNotice('已复制站点摘要。');
  };

  const copyConfig = async () => {
    if (!selectedSite) return;

    await navigator.clipboard.writeText(selectedSite.rawConfig);
    setNotice('已复制配置内容。');
  };

  const openConfigInNotepad = () => {
    if (!selectedSite) return;

    if (!onOpenConfigFile) {
      setError('当前窗口无法打开记事本。');
      return;
    }

    onOpenConfigFile(selectedSite.filePath);
    setNotice(`已在记事本打开：${selectedSite.filePath}`);
  };

  return (
    <section className="web-server-manager">
      <header className="web-toolbar">
        <div className={`web-service-card ${getStatusTone(activeService?.status)}`}>
          <span>Web 服务</span>
          <strong>{activeService ? getWebServerLabel(activeService.kind) : '未检测'}</strong>
          <em>{activeService?.status ?? lastRefreshedAt ?? '等待刷新'}</em>
        </div>
        <div className="web-service-switch">
          {(['nginx', 'apache', 'caddy'] as WebServerKind[]).map((kind) => {
            const service = snapshot?.services.find((item) => item.kind === kind);
            return (
              <button
                key={kind}
                type="button"
                className={activeKind === kind ? 'active' : ''}
                onClick={() => {
                  setActiveKind(kind);
                  setSelectedSiteId(snapshot?.sites.find((site) => site.kind === kind)?.id ?? '');
                }}
                disabled={!service}
              >
                {getWebServerLabel(kind)}
              </button>
            );
          })}
        </div>
        <div className="web-toolbar-actions">
          <button type="button" onClick={refresh} disabled={loading}>{loading ? '检测中' : '重新检测'}</button>
          <button type="button" className="primary" onClick={() => prepareAction('test')} disabled={!activeService}>配置测试</button>
          <button type="button" onClick={() => prepareAction('reload')} disabled={!activeService}>Reload</button>
          <button type="button" className="danger" onClick={() => prepareAction('restart')} disabled={!activeService}>Restart</button>
        </div>
      </header>

      {error ? <DismissibleAlert className="web-alert danger" onDismiss={() => setError('')} role="alert">{error}</DismissibleAlert> : null}
      {notice ? <DismissibleAlert className="web-alert info" onDismiss={() => setNotice('')}>{notice}</DismissibleAlert> : null}

      <div className="web-layout">
        <aside className="web-site-list">
          <div className="web-site-list-head">
            <strong>站点配置</strong>
            <span>{visibleSites.length} files</span>
          </div>
          <div className="web-site-scroll">
            {visibleSites.map((site) => (
              <button
                key={site.id}
                type="button"
                className={selectedSite?.id === site.id ? 'active' : ''}
                onClick={() => setSelectedSiteId(site.id)}
                onDoubleClick={() => {
                  setSelectedSiteId(site.id);
                  onOpenConfigFile?.(site.filePath);
                }}
              >
                <span className={site.enabled ? 'enabled' : 'available'}>{site.enabled ? 'enabled' : 'available'}</span>
                <strong title={getSiteTitle(site)}>{getSiteTitle(site)}</strong>
                <em title={site.filePath}>{site.filePath}</em>
              </button>
            ))}
            {!visibleSites.length ? <div className="web-empty-state">未找到该服务的配置文件。</div> : null}
          </div>
        </aside>

        <main className="web-main">
          <nav className="web-tabs">
            <button type="button" className={activeTab === 'summary' ? 'active' : ''} onClick={() => setActiveTab('summary')}>摘要</button>
            <button type="button" className={activeTab === 'config' ? 'active' : ''} onClick={() => setActiveTab('config')}>配置</button>
            <button type="button" className={activeTab === 'raw' ? 'active' : ''} onClick={() => setActiveTab('raw')}>命令输出</button>
            <button type="button" className="primary" onClick={openConfigInNotepad} disabled={!selectedSite}>记事本打开</button>
            <button type="button" onClick={copySiteSummary} disabled={!selectedSite}>复制摘要</button>
            <button type="button" onClick={copyConfig} disabled={!selectedSite}>复制配置</button>
          </nav>

          {activeTab === 'summary' ? (
            <section className="web-summary">
              <div className="web-summary-hero">
                <span>{selectedSite ? getWebServerLabel(selectedSite.kind) : 'Web Server'}</span>
                <strong>{selectedSite ? getSiteTitle(selectedSite) : '尚未选择站点'}</strong>
                <em>{selectedSite?.filePath ?? '刷新后选择站点配置。'}</em>
              </div>
              <div className="web-metric-grid">
                <div><span>Listen</span><strong>{firstValue(selectedSite?.listens ?? [])}</strong></div>
                <div><span>Root</span><strong>{selectedSite?.root ?? '-'}</strong></div>
                <div><span>Cert</span><strong>{selectedSite?.certificateFiles.length ?? 0}</strong></div>
                <div><span>Status</span><strong>{selectedSite?.enabled ? 'enabled' : 'available'}</strong></div>
              </div>
              <dl className="web-detail-list">
                <div><dt>Server Name</dt><dd>{firstValue(selectedSite?.serverNames ?? [])}</dd></div>
                <div><dt>Access Log</dt><dd>{selectedSite?.accessLog ?? '-'}</dd></div>
                <div><dt>Error Log</dt><dd>{selectedSite?.errorLog ?? '-'}</dd></div>
                <div><dt>Certificate</dt><dd>{firstValue(selectedSite?.certificateFiles ?? [])}</dd></div>
              </dl>
            </section>
          ) : null}

          {activeTab === 'config' ? (
            <section className="web-config-panel">
              <div className="web-config-panel-head">
                <span title={selectedSite?.filePath}>{selectedSite?.filePath ?? '选择站点后显示配置内容。'}</span>
                <button type="button" onClick={openConfigInNotepad} disabled={!selectedSite}>记事本打开</button>
              </div>
              <pre className="web-config-output">{selectedSite?.rawConfig || '选择站点后显示配置内容。'}</pre>
            </section>
          ) : null}

          {activeTab === 'raw' ? (
            <pre className="web-config-output">{testOutput || snapshot?.rawOutput || '配置测试或检测输出会显示在这里。'}</pre>
          ) : null}
        </main>

        <aside className="web-service-detail">
          <div className="web-detail-head">
            <strong>服务详情</strong>
            <span>{activeService?.version || '-'}</span>
          </div>
          <dl>
            <div><dt>类型</dt><dd>{activeService ? getWebServerLabel(activeService.kind) : '-'}</dd></div>
            <div><dt>命令</dt><dd>{activeService?.binary ?? '-'}</dd></div>
            <div><dt>服务名</dt><dd>{activeService?.serviceName ?? '-'}</dd></div>
            <div><dt>状态</dt><dd>{activeService?.status ?? '-'}</dd></div>
            <div><dt>配置文件</dt><dd>{visibleSites.length}</dd></div>
          </dl>
          <div className="web-detail-note">
            支持 Nginx、Apache/httpd 和 Caddy。Reload 与 Restart 会通过非交互式 sudo / systemctl 执行，失败时会保留原始输出。
          </div>
        </aside>
      </div>

      {pendingAction ? createPortal(
        <div className="web-modal-backdrop" role="presentation" onClick={() => setPendingAction(null)}>
          <div className={`web-confirm-dialog ${pendingAction.danger ? 'danger' : ''}`} role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="web-confirm-header">
              <span>{pendingAction.danger ? '确认服务操作' : '确认命令'}</span>
              <strong>{getWebServerLabel(pendingAction.service.kind)} · {pendingAction.label}</strong>
            </div>
            <dl>
              <div><dt>服务名</dt><dd>{pendingAction.service.serviceName}</dd></div>
              <div><dt>当前状态</dt><dd>{pendingAction.service.status}</dd></div>
              <div><dt>版本</dt><dd>{pendingAction.service.version || '-'}</dd></div>
            </dl>
            {pendingAction.action === 'reload' && testOutput && /failed|error|invalid/i.test(testOutput) ? (
              <p className="web-warning-text">最近一次配置测试输出包含错误字样，请确认后再继续。</p>
            ) : null}
            <pre>{pendingAction.command.command}</pre>
            <div className="web-confirm-actions">
              <button type="button" onClick={() => setPendingAction(null)}>取消</button>
              <button type="button" className={pendingAction.danger ? 'danger' : 'primary'} onClick={executePendingAction} disabled={actionRunning}>
                {actionRunning ? '执行中' : '执行'}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </section>
  );
}

export default RemoteWebServerManager;
