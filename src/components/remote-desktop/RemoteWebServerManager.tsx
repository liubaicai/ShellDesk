import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import DismissibleAlert from './DismissibleAlert';

import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import { isWindowsSystem, type RemoteCommandInput } from './remoteSystem';
import { useSudoCommand } from './sudoPrompt';
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
import { tCurrent } from '../../i18n';

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
  const { runCommand, sudoPrompt } = useSudoCommand(connectionId, systemType);
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
      const result = await runCommand(createWebServerSnapshotCommand(isWindowsHost));
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
        ? tCurrent('auto.remoteWebServerManager.7je1cb', { value0: nextSnapshot.services.length, value1: nextSnapshot.sites.length })
        : tCurrent('auto.remoteWebServerManager.10cqsf6'));
    } catch (error) {
      setError(getErrorMessage(error));
      setSnapshot(null);
    } finally {
      setLoading(false);
    }
  }, [activeKind, isWindowsHost, runCommand]);

  useEffect(() => {
    void refresh();
  }, [connectionId, isWindowsHost]);

  const prepareAction = (action: WebServerAction) => {
    if (!activeService) return;

    try {
      const labels: Record<WebServerAction, string> = {
        test: tCurrent('auto.remoteWebServerManager.bakl0a'),
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
      const result = await runCommand(pendingAction.command);
      const output = result.stdout || result.stderr || tCurrent('auto.remoteWebServerManager.105ee9t', { value0: pendingAction.label });

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

    try {
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
      setNotice(tCurrent('auto.remoteWebServerManager.1o5acy3'));
    } catch (error) {
      setError(tCurrent('auto.remoteWebServerManager.copyFailed', { value0: getErrorMessage(error) }));
    }
  };

  const copyConfig = async () => {
    if (!selectedSite) return;

    try {
      await navigator.clipboard.writeText(selectedSite.rawConfig);
      setNotice(tCurrent('auto.remoteWebServerManager.1owzfkn'));
    } catch (error) {
      setError(tCurrent('auto.remoteWebServerManager.copyFailed', { value0: getErrorMessage(error) }));
    }
  };

  const openConfigInNotepad = () => {
    if (!selectedSite) return;

    if (!onOpenConfigFile) {
      setError(tCurrent('auto.remoteWebServerManager.11nlzak'));
      return;
    }

    onOpenConfigFile(selectedSite.filePath);
    setNotice(tCurrent('auto.remoteWebServerManager.15g2q60', { value0: selectedSite.filePath }));
  };

  return (
    <section className="web-server-manager">
      <header className="web-toolbar">
        <div className={`web-service-card ${getStatusTone(activeService?.status)}`}>
          <span>{tCurrent('auto.remoteWebServerManager.f4yrqp')}</span>
          <strong>{activeService ? getWebServerLabel(activeService.kind) : tCurrent('auto.remoteWebServerManager.1e2crtw')}</strong>
          <em>{activeService?.status ?? lastRefreshedAt ?? tCurrent('auto.remoteWebServerManager.llewtw')}</em>
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
          <button type="button" onClick={refresh} disabled={loading}>{loading ? tCurrent('auto.remoteWebServerManager.xr2jgj') : tCurrent('auto.remoteWebServerManager.1ot472x')}</button>
          <button type="button" className="primary" onClick={() => prepareAction('test')} disabled={!activeService}>{tCurrent('auto.remoteWebServerManager.bakl0a2')}</button>
          <button type="button" onClick={() => prepareAction('reload')} disabled={!activeService}>Reload</button>
          <button type="button" className="danger" onClick={() => prepareAction('restart')} disabled={!activeService}>Restart</button>
        </div>
      </header>

      {error ? <DismissibleAlert className="web-alert danger" onDismiss={() => setError('')} role="alert">{error}</DismissibleAlert> : null}
      {notice ? <DismissibleAlert className="web-alert info" onDismiss={() => setNotice('')}>{notice}</DismissibleAlert> : null}

      <div className="web-layout">
        <aside className="web-site-list">
          <div className="web-site-list-head">
            <strong>{tCurrent('auto.remoteWebServerManager.1ss3v5s')}</strong>
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
            {!visibleSites.length ? <div className="web-empty-state">{tCurrent('auto.remoteWebServerManager.yfq4qc')}</div> : null}
          </div>
        </aside>

        <main className="web-main">
          <nav className="web-tabs">
            <button type="button" className={activeTab === 'summary' ? 'active' : ''} onClick={() => setActiveTab('summary')}>{tCurrent('auto.remoteWebServerManager.10fwitu')}</button>
            <button type="button" className={activeTab === 'config' ? 'active' : ''} onClick={() => setActiveTab('config')}>{tCurrent('auto.remoteWebServerManager.1x99t4y')}</button>
            <button type="button" className={activeTab === 'raw' ? 'active' : ''} onClick={() => setActiveTab('raw')}>{tCurrent('auto.remoteWebServerManager.es77i5')}</button>
            <button type="button" className="primary" onClick={openConfigInNotepad} disabled={!selectedSite}>{tCurrent('auto.remoteWebServerManager.yhp24r')}</button>
            <button type="button" onClick={copySiteSummary} disabled={!selectedSite}>{tCurrent('auto.remoteWebServerManager.18nulp1')}</button>
            <button type="button" onClick={copyConfig} disabled={!selectedSite}>{tCurrent('auto.remoteWebServerManager.1853829')}</button>
          </nav>

          {activeTab === 'summary' ? (
            <section className="web-summary">
              <div className="web-summary-hero">
                <span>{selectedSite ? getWebServerLabel(selectedSite.kind) : 'Web Server'}</span>
                <strong>{selectedSite ? getSiteTitle(selectedSite) : tCurrent('auto.remoteWebServerManager.hm49zd')}</strong>
                <em>{selectedSite?.filePath ?? tCurrent('auto.remoteWebServerManager.1r2xg0b')}</em>
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
                <span title={selectedSite?.filePath}>{selectedSite?.filePath ?? tCurrent('auto.remoteWebServerManager.113kvq6')}</span>
                <button type="button" onClick={openConfigInNotepad} disabled={!selectedSite}>{tCurrent('auto.remoteWebServerManager.yhp24r2')}</button>
              </div>
              <pre className="web-config-output">{selectedSite?.rawConfig || tCurrent('auto.remoteWebServerManager.113kvq62')}</pre>
            </section>
          ) : null}

          {activeTab === 'raw' ? (
            <pre className="web-config-output">{testOutput || snapshot?.rawOutput || tCurrent('auto.remoteWebServerManager.zjujfr')}</pre>
          ) : null}
        </main>

        <aside className="web-service-detail">
          <div className="web-detail-head">
            <strong>{tCurrent('auto.remoteWebServerManager.y5zpae')}</strong>
            <span>{activeService?.version || '-'}</span>
          </div>
          <dl>
            <div><dt>{tCurrent('auto.remoteWebServerManager.anh4cj')}</dt><dd>{activeService ? getWebServerLabel(activeService.kind) : '-'}</dd></div>
            <div><dt>{tCurrent('auto.remoteWebServerManager.emgxwk')}</dt><dd>{activeService?.binary ?? '-'}</dd></div>
            <div><dt>{tCurrent('auto.remoteWebServerManager.j60ypu')}</dt><dd>{activeService?.serviceName ?? '-'}</dd></div>
            <div><dt>{tCurrent('auto.remoteWebServerManager.1ccx4t4')}</dt><dd>{activeService?.status ?? '-'}</dd></div>
            <div><dt>{tCurrent('auto.remoteWebServerManager.7kieyz')}</dt><dd>{visibleSites.length}</dd></div>
          </dl>
          <div className="web-detail-note">
            {tCurrent('auto.remoteWebServerManager.suz7ty')}</div>
        </aside>
      </div>

      {pendingAction ? createPortal(
        <div className="web-modal-backdrop" role="presentation" onClick={() => setPendingAction(null)}>
          <div className={`web-confirm-dialog ${pendingAction.danger ? 'danger' : ''}`} role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="web-confirm-header">
              <span>{pendingAction.danger ? tCurrent('auto.remoteWebServerManager.1p8o5ho') : tCurrent('auto.remoteWebServerManager.17ojhw6')}</span>
              <strong>{getWebServerLabel(pendingAction.service.kind)} · {pendingAction.label}</strong>
            </div>
            <dl>
              <div><dt>{tCurrent('auto.remoteWebServerManager.j60ypu2')}</dt><dd>{pendingAction.service.serviceName}</dd></div>
              <div><dt>{tCurrent('auto.remoteWebServerManager.c6rjk')}</dt><dd>{pendingAction.service.status}</dd></div>
              <div><dt>{tCurrent('auto.remoteWebServerManager.va46gx')}</dt><dd>{pendingAction.service.version || '-'}</dd></div>
            </dl>
            {pendingAction.action === 'reload' && testOutput && /failed|error|invalid/i.test(testOutput) ? (
              <p className="web-warning-text">{tCurrent('auto.remoteWebServerManager.1jfjwtf')}</p>
            ) : null}
            <pre>{pendingAction.command.command}</pre>
            <div className="web-confirm-actions">
              <button type="button" onClick={() => setPendingAction(null)}>{tCurrent('auto.remoteWebServerManager.1589w37')}</button>
              <button type="button" className={pendingAction.danger ? 'danger' : 'primary'} onClick={executePendingAction} disabled={actionRunning}>
                {actionRunning ? tCurrent('auto.remoteWebServerManager.6svkbt') : tCurrent('auto.remoteWebServerManager.6azgji')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
      {sudoPrompt}
    </section>
  );
}

export default RemoteWebServerManager;
