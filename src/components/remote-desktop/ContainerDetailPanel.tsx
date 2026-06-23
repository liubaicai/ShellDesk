import { useEffect, useRef, useState } from 'react';
import { t, useCurrentAppLanguage, type MessageId } from '../../i18n';
import { buildContainerDiagnostics } from './containerCommands';
import { formatShortId, getStateLabel } from './containerParsers';
import type { ContainerAction, ContainerConfigForm, ContainerDetail, ContainerSummary, DetailTab, RestartPolicy } from './containerTypes';

const restartPolicyOptions: Array<{ value: RestartPolicy; labelId: MessageId }> = [
  { value: 'no', labelId: 'container.restartPolicy.no' },
  { value: 'on-failure', labelId: 'container.restartPolicy.onFailure' },
  { value: 'unless-stopped', labelId: 'container.restartPolicy.unlessStopped' },
  { value: 'always', labelId: 'container.restartPolicy.always' },
];

function createDefaultConfigForm(): ContainerConfigForm {
  return { name: '', restartPolicy: 'no', cpuLimit: '', memoryLimit: '' };
}

interface ContainerDetailPanelProps {
  container: ContainerSummary | null;
  detail: ContainerDetail | null;
  detailLoading: boolean;
  containersLoading: boolean;
  actingKey: string;
  savingConfig: boolean;
  onAction: (action: ContainerAction) => void;
  onReload: (containerId: string) => void | Promise<void>;
  onCopy: (value: string, label: string) => void | Promise<void>;
  onConfigSubmit: (form: ContainerConfigForm) => void | Promise<void>;
  onExec: (command: string) => Promise<{ output: string; code: number }>;
  onReadLogs: (containerId: string, options?: { tail?: number; sinceSeconds?: number }) => Promise<string>;
}

function ContainerDetailPanel({ container, detail, detailLoading, containersLoading, actingKey, savingConfig, onAction, onReload, onCopy, onConfigSubmit, onExec, onReadLogs }: ContainerDetailPanelProps) {
  const language = useCurrentAppLanguage();
  const liveLogRequestRef = useRef(0);
  const [detailTab, setDetailTab] = useState<DetailTab>('summary');
  const [configForm, setConfigForm] = useState<ContainerConfigForm>(() => createDefaultConfigForm());
  const [execCommand, setExecCommand] = useState('id && uname -a');
  const [execOutput, setExecOutput] = useState('');
  const [execRunning, setExecRunning] = useState(false);
  const [liveLogs, setLiveLogs] = useState('');
  const [logsStreaming, setLogsStreaming] = useState(false);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState('');
  const selectedDetail = detail?.id === container?.id ? detail : null;

  useEffect(() => {
    setDetailTab('summary');
    setExecOutput('');
    setLiveLogs('');
    setLogsStreaming(false);
    setLogsError('');
    liveLogRequestRef.current += 1;
  }, [container?.id]);

  useEffect(() => {
    if (!logsStreaming || !container || container.state !== 'running') {
      return undefined;
    }
    let disposed = false;
    const requestId = liveLogRequestRef.current + 1;
    liveLogRequestRef.current = requestId;
    const pollLogs = async () => {
      if (disposed || liveLogRequestRef.current !== requestId) return;
      setLogsLoading(true);
      try {
        const output = await onReadLogs(container.id, { tail: 240, sinceSeconds: 8 });
        if (disposed || liveLogRequestRef.current !== requestId) return;
        setLiveLogs(output || t('container.ui.noRecentLogs', language));
        setLogsError('');
      } catch (error) {
        if (disposed || liveLogRequestRef.current !== requestId) return;
        setLogsError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!disposed && liveLogRequestRef.current === requestId) {
          setLogsLoading(false);
          window.setTimeout(pollLogs, 3000);
        }
      }
    };
    void pollLogs();
    return () => {
      disposed = true;
    };
  }, [container, language, logsStreaming, onReadLogs]);

  useEffect(() => {
    if (!selectedDetail) {
      setConfigForm(createDefaultConfigForm());
      return;
    }
    setConfigForm({ name: selectedDetail.name, restartPolicy: selectedDetail.config.restartPolicy, cpuLimit: '', memoryLimit: '' });
  }, [selectedDetail?.id, selectedDetail?.name, selectedDetail?.config.restartPolicy]);

  const updateConfigForm = <Key extends keyof ContainerConfigForm>(key: Key, value: ContainerConfigForm[Key]) => {
    setConfigForm((currentForm) => ({ ...currentForm, [key]: value }));
  };

  const isActionDisabled = (action: ContainerAction) => {
    if (!container || Boolean(actingKey)) return true;
    if (action === 'start') return container.state === 'running';
    if (action === 'stop' || action === 'restart' || action === 'kill') return container.state !== 'running' && container.state !== 'paused';
    if (action === 'pause') return container.state !== 'running';
    if (action === 'unpause') return container.state !== 'paused';
    return false;
  };

  const actionLabels: Record<ContainerAction, { labelId: MessageId; danger?: boolean; primary?: boolean }> = {
    start: { labelId: 'container.action.start', primary: true },
    stop: { labelId: 'container.action.stop', danger: true },
    restart: { labelId: 'container.action.restart' },
    pause: { labelId: 'container.action.pause' },
    unpause: { labelId: 'container.action.unpause', primary: true },
    kill: { labelId: 'container.action.kill', danger: true },
    remove: { labelId: 'container.action.remove', danger: true },
  };

  const renderActionButton = (action: ContainerAction) => {
    const definition = actionLabels[action];
    const key = container ? `${action}:${container.id}` : action;
    const className = ['container-action-btn', definition.primary ? 'primary' : '', definition.danger ? 'danger' : ''].filter(Boolean).join(' ');
    return <button key={action} type="button" className={className} disabled={isActionDisabled(action)} onClick={() => onAction(action)}>{actingKey === key ? t('container.ui.processing', language) : t(definition.labelId, language)}</button>;
  };

  const executeContainerExec = async () => {
    const command = execCommand.trim();
    if (!command || !container) return;
    setExecRunning(true);
    setExecOutput('');
    try {
      const result = await onExec(command);
      setExecOutput(result.output || t('container.exec.exit', language, { code: result.code }));
    } catch {
      // Global command errors are surfaced by the manager alert.
    } finally {
      setExecRunning(false);
    }
  };

  const refreshLogsOnce = async () => {
    if (!container) return;
    setLogsLoading(true);
    setLogsError('');
    try {
      const output = await onReadLogs(container.id, { tail: 240 });
      setLiveLogs(output || t('container.ui.noRecentLogs', language));
    } catch (error) {
      setLogsError(error instanceof Error ? error.message : String(error));
    } finally {
      setLogsLoading(false);
    }
  };

  const renderContainerConfig = () => {
    if (!selectedDetail) return <div className="container-empty">{detailLoading ? t('container.ui.loadingDetail', language) : t('container.ui.noDetail', language)}</div>;
    const configItems = [
      { label: t('container.ui.restartPolicy', language), value: selectedDetail.config.restartPolicyText },
      { label: t('container.ui.network', language), value: selectedDetail.config.networkMode },
      { label: t('container.ui.privileged', language), value: selectedDetail.config.privileged },
      { label: t('container.ui.hostname', language), value: selectedDetail.config.hostname },
      { label: t('container.ui.user', language), value: selectedDetail.config.user },
      { label: t('container.ui.workdir', language), value: selectedDetail.config.workingDir },
      { label: t('container.ui.entrypoint', language), value: selectedDetail.config.entrypoint },
      { label: t('container.ui.command', language), value: selectedDetail.config.command },
    ];
    return (
      <div className="container-config-workbench">
        <section className="container-config-current">
          <header><strong>{t('container.ui.currentConfig', language)}</strong><button type="button" className="container-copy-btn" onClick={() => void onCopy(selectedDetail.inspectText, 'inspect')}>{t('container.ui.copyInspect', language)}</button></header>
          <div className="container-config-grid">{configItems.map((item) => <div key={item.label}><span>{item.label}</span><strong title={item.value}>{item.value || '-'}</strong></div>)}</div>
          <div className="container-config-lists">
            <section><header><strong>{t('container.ui.resourceLimits', language)}</strong><span>{selectedDetail.config.resources.length}</span></header><div className="container-chip-list">{selectedDetail.config.resources.length ? selectedDetail.config.resources.map((item) => <code key={`${item.label}:${item.value}`}>{item.label}: {item.value}</code>) : <span>{t('container.ui.noResourceLimits', language)}</span>}</div></section>
            <section><header><strong>Labels</strong><span>{selectedDetail.config.labels.length}</span></header><div className="container-chip-list">{selectedDetail.config.labels.length ? selectedDetail.config.labels.slice(0, 18).map((label) => <code key={label}>{label}</code>) : <span>{t('container.ui.noLabels', language)}</span>}{selectedDetail.config.labels.length > 18 ? <span>{t('container.ui.moreItems', language, { count: selectedDetail.config.labels.length - 18 })}</span> : null}</div></section>
          </div>
        </section>
        <form className="container-config-form" onSubmit={(event) => { event.preventDefault(); void onConfigSubmit(configForm); }}>
          <header><strong>{t('container.ui.dynamicConfig', language)}</strong><span>{t('container.ui.dynamicConfigHint', language)}</span></header>
          <div className="container-config-fields">
            <label><span>{t('container.ui.name', language)}</span><input type="text" value={configForm.name} onChange={(event) => updateConfigForm('name', event.target.value)} /></label>
            <label><span>{t('container.ui.restartPolicy', language)}</span><select value={configForm.restartPolicy} onChange={(event) => updateConfigForm('restartPolicy', event.target.value as RestartPolicy)}>{restartPolicyOptions.map((option) => <option key={option.value} value={option.value}>{t(option.labelId, language)}</option>)}</select></label>
            <label><span>CPU</span><input type="text" value={configForm.cpuLimit} onChange={(event) => updateConfigForm('cpuLimit', event.target.value)} placeholder="0.50" /></label>
            <label><span>{t('container.ui.memory', language)}</span><input type="text" value={configForm.memoryLimit} onChange={(event) => updateConfigForm('memoryLimit', event.target.value)} placeholder="512m" /></label>
          </div>
          <div className="container-inline-warning">{t('container.ui.recreateHint', language)}</div>
          <div className="container-workbench-actions"><button type="submit" className="container-action-btn primary" disabled={savingConfig}>{savingConfig ? t('container.ui.processing', language) : t('container.ui.saveConfig', language)}</button></div>
        </form>
      </div>
    );
  };

  const renderDetailSummary = () => (
    <>
      <div className="container-overview">
        <div><span>CPU</span><strong>{selectedDetail?.stats?.cpu || '-'}</strong><small>{selectedDetail?.stats?.error ? t('container.ui.statsUnavailable', language) : 'no-stream'}</small></div>
        <div><span>{t('container.ui.memory', language)}</span><strong>{selectedDetail?.stats?.memory || '-'}</strong><small>{selectedDetail?.stats?.memoryPercent || '-'}</small></div>
        <div><span>{t('container.ui.networkIo', language)}</span><strong>{selectedDetail?.stats?.netIO || '-'}</strong><small>Block {selectedDetail?.stats?.blockIO || '-'}</small></div>
        <div><span>PIDs</span><strong>{selectedDetail?.stats?.pids || '-'}</strong><small>{selectedDetail?.createdAt || container?.createdAt || '-'}</small></div>
      </div>
      {selectedDetail?.stats?.error ? <div className="container-inline-warning">{selectedDetail.stats.error}</div> : null}
      {selectedDetail?.inspectError ? <div className="container-inline-warning">{selectedDetail.inspectError}</div> : null}
      <div className="container-summary-sections">
        <section><header><strong>{t('container.ui.ports', language)}</strong><span>{selectedDetail?.ports.length ?? 0}</span></header><div className="container-chip-list">{selectedDetail?.ports.length ? selectedDetail.ports.map((port) => <code key={port}>{port}</code>) : <span>{t('container.diagnostics.noPorts', language)}</span>}</div></section>
        <section><header><strong>{t('container.ui.mounts', language)}</strong><span>{selectedDetail?.mounts.length ?? 0}</span></header><div className="container-chip-list">{selectedDetail?.mounts.length ? selectedDetail.mounts.map((mount) => <code key={mount}>{mount}</code>) : <span>{t('container.diagnostics.noMounts', language)}</span>}</div></section>
        <section><header><strong>{t('container.ui.env', language)}</strong><span>{selectedDetail?.env.length ?? 0}</span></header><div className="container-chip-list">{selectedDetail?.env.length ? selectedDetail.env.slice(0, 24).map((item) => <code key={item}>{item}</code>) : <span>{t('container.ui.noEnv', language)}</span>}{selectedDetail && selectedDetail.env.length > 24 ? <span>{t('container.ui.moreItems', language, { count: selectedDetail.env.length - 24 })}</span> : null}</div></section>
      </div>
    </>
  );

  const renderLogsPanel = () => (
    <div className="container-live-logs">
      <div className="container-live-logs-toolbar">
        <span>{logsStreaming ? t('container.ui.logsLive', language) : t('container.ui.logsSnapshot', language)}</span>
        <div>
          <button type="button" className="container-action-btn" onClick={() => void refreshLogsOnce()} disabled={logsLoading}>{logsLoading ? t('container.ui.reading', language) : t('container.ui.refresh', language)}</button>
          <button type="button" className={logsStreaming ? 'container-action-btn danger' : 'container-action-btn primary'} onClick={() => setLogsStreaming((current) => !current)} disabled={container?.state !== 'running'}>
            {logsStreaming ? t('container.ui.stopLiveLogs', language) : t('container.ui.startLiveLogs', language)}
          </button>
        </div>
      </div>
      {logsError ? <div className="container-inline-warning">{logsError}</div> : null}
      <pre>{liveLogs || selectedDetail?.logs || t('container.ui.noRecentLogs', language)}</pre>
    </div>
  );

  return (
    <section className="container-detail-panel" aria-label={t('container.ui.detailAria', language)}>
      {container ? (
        <>
          <header className="container-detail-header"><div><span>{t('container.ui.container', language)}</span><strong title={container.name}>{selectedDetail?.name || container.name}</strong><code title={container.id}>{formatShortId(container.id)}</code><p title={selectedDetail?.image || container.image}>{selectedDetail?.image || container.image}</p></div><button type="button" className="container-copy-btn" disabled={!selectedDetail} onClick={() => selectedDetail ? void onCopy(buildContainerDiagnostics(selectedDetail, language), t('container.ui.diagnosticsLabel', language)) : undefined}>{t('container.ui.copyDiagnostics', language)}</button></header>
          <div className="container-status-row"><span className={`container-state-tag ${selectedDetail?.state || container.state}`}>{getStateLabel(selectedDetail?.state || container.state, language)}</span><strong title={selectedDetail?.status || container.status}>{selectedDetail?.status || container.status}</strong><small title={container.ports}>{container.ports}</small></div>
          <div className="container-action-bar" aria-label={t('container.ui.actionsAria', language)}>{(['start', 'stop', 'restart', 'pause', 'unpause', 'kill', 'remove'] as ContainerAction[]).map(renderActionButton)}<button type="button" className="container-action-btn" onClick={() => { setDetailTab('logs'); void onReload(container.id); }}>{t('container.ui.viewLogs', language)}</button><button type="button" className="container-action-btn" onClick={() => setDetailTab('exec')}>Exec</button></div>
          <div className="container-detail-tabs" role="tablist" aria-label={t('container.ui.detailTabsAria', language)}><button type="button" role="tab" className={detailTab === 'summary' ? 'active' : ''} onClick={() => setDetailTab('summary')}>{t('container.ui.summary', language)}</button><button type="button" role="tab" className={detailTab === 'config' ? 'active' : ''} onClick={() => setDetailTab('config')}>{t('container.ui.config', language)}</button><button type="button" role="tab" className={detailTab === 'logs' ? 'active' : ''} onClick={() => setDetailTab('logs')}>{t('container.ui.logs', language)}</button><button type="button" role="tab" className={detailTab === 'inspect' ? 'active' : ''} onClick={() => setDetailTab('inspect')}>Inspect</button><button type="button" role="tab" className={detailTab === 'exec' ? 'active' : ''} onClick={() => setDetailTab('exec')}>Exec</button></div>
          <div className="container-detail-body">
            {detailLoading && !selectedDetail ? <div className="container-empty">{t('container.ui.loadingDetail', language)}</div> : null}
            {selectedDetail || !detailLoading ? <>{detailTab === 'summary' ? renderDetailSummary() : null}{detailTab === 'config' ? renderContainerConfig() : null}{detailTab === 'logs' ? renderLogsPanel() : null}{detailTab === 'inspect' ? <pre>{selectedDetail?.inspectText || t('container.ui.noInspect', language)}</pre> : null}{detailTab === 'exec' ? <div className="container-exec-panel"><form onSubmit={(event) => { event.preventDefault(); void executeContainerExec(); }}><input type="text" value={execCommand} onChange={(event) => setExecCommand(event.target.value)} placeholder={t('container.ui.execPlaceholder', language)} aria-label={t('container.ui.execAria', language)} /><button type="submit" className="container-action-btn primary" disabled={execRunning || container.state !== 'running'}>{execRunning ? t('container.ui.execRunning', language) : t('container.ui.run', language)}</button></form><pre>{execOutput || (container.state !== 'running' ? t('container.ui.execNotRunning', language) : t('container.ui.execPrompt', language))}</pre></div> : null}</> : null}
          </div>
        </>
      ) : (
        <div className="container-detail-empty"><strong>{containersLoading ? t('container.ui.loadingContainer', language) : t('container.ui.noContainerSelected', language)}</strong><span>{containersLoading ? t('container.ui.waitRuntime', language) : t('container.ui.noDetail', language)}</span></div>
      )}
    </section>
  );
}

export default ContainerDetailPanel;
