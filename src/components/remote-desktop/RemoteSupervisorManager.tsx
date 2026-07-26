import {
  Activity,
  FileText,
  List,
  Play,
  RefreshCw,
  RotateCw,
  Square as StopIcon,
  Terminal,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import { tCurrent } from '../../i18n';
import DismissibleAlert from './DismissibleAlert';
import { getErrorMessage } from './desktopUtils';
import { isWindowsSystem } from './remoteSystem';
import {
  createSupervisorActionCommand,
  createSupervisorDetectCommand,
  createSupervisorLogCommand,
  createSupervisorReadConfigCommand,
  createSupervisorStatusCommand,
} from './supervisorCommands';
import {
  parseSupervisorDetectOutput,
  parseSupervisorStatusOutput,
  parseSupervisorTextOutput,
} from './supervisorParsers';
import type {
  SupervisorAction,
  SupervisorLogStream,
  SupervisorManagerProps,
  SupervisorProcess,
  SupervisorProcessState,
  SupervisorRuntime,
} from './supervisorTypes';
import { useSudoCommand } from './sudoPrompt';

type SupervisorTab = 'overview' | 'processes' | 'logs';
type ProcessFilter = 'all' | 'running' | 'stopped' | 'problems';
type PendingAction = { action: SupervisorAction; targets: string[] };

const emptyRuntime: SupervisorRuntime = {
  installed: false,
  executable: '',
  version: '',
  running: false,
  statusMessage: '',
  configFiles: [],
};

const problemStates = new Set<SupervisorProcessState>(['fatal', 'backoff', 'unknown']);
const inactiveStates = new Set<SupervisorProcessState>(['stopped', 'exited']);
const nonStoppableStates = new Set<SupervisorProcessState>([
  ...inactiveStates,
  ...problemStates,
  'stopping',
]);

function getStateLabel(state: SupervisorProcessState) {
  if (state === 'running') return tCurrent('auto.supervisorManager.state.running');
  if (state === 'starting') return tCurrent('auto.supervisorManager.state.starting');
  if (state === 'stopping') return tCurrent('auto.supervisorManager.state.stopping');
  if (state === 'stopped') return tCurrent('auto.supervisorManager.state.stopped');
  if (state === 'exited') return tCurrent('auto.supervisorManager.state.exited');
  if (state === 'fatal') return tCurrent('auto.supervisorManager.state.fatal');
  if (state === 'backoff') return tCurrent('auto.supervisorManager.state.backoff');
  return tCurrent('auto.supervisorManager.state.unknown');
}

function getActionLabel(action: SupervisorAction) {
  if (action === 'start') return tCurrent('auto.supervisorManager.action.start');
  if (action === 'stop') return tCurrent('auto.supervisorManager.action.stop');
  if (action === 'restart') return tCurrent('auto.supervisorManager.action.restart');
  return tCurrent('auto.supervisorManager.action.reload');
}

function isProcessVisible(process: SupervisorProcess, filter: ProcessFilter) {
  if (filter === 'running') {
    return process.state === 'running' || process.state === 'starting';
  }
  if (filter === 'stopped') {
    return inactiveStates.has(process.state);
  }
  if (filter === 'problems') {
    return problemStates.has(process.state);
  }
  return true;
}

function SupervisorActionIcon({ action }: { action: Exclude<SupervisorAction, 'reload'> }) {
  if (action === 'start') return <Play aria-hidden="true" />;
  if (action === 'stop') return <StopIcon aria-hidden="true" />;
  return <RotateCw aria-hidden="true" />;
}

function RemoteSupervisorManager({ connectionId, systemType }: SupervisorManagerProps) {
  const isWindowsHost = isWindowsSystem(systemType);
  const { runCommand, sudoPrompt } = useSudoCommand(connectionId, systemType);
  const [runtime, setRuntime] = useState<SupervisorRuntime>(emptyRuntime);
  const [processes, setProcesses] = useState<SupervisorProcess[]>([]);
  const [activeTab, setActiveTab] = useState<SupervisorTab>('overview');
  const [filter, setFilter] = useState<ProcessFilter>('all');
  const [query, setQuery] = useState('');
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());
  const [selectedConfig, setSelectedConfig] = useState('');
  const [configPreview, setConfigPreview] = useState('');
  const [logTarget, setLogTarget] = useState('');
  const [logStream, setLogStream] = useState<SupervisorLogStream>('stdout');
  const [logText, setLogText] = useState('');
  const [initialized, setInitialized] = useState(false);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [acting, setActing] = useState<SupervisorAction | ''>('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);

  const stats = useMemo(() => ({
    total: processes.length,
    running: processes.filter((process) => process.state === 'running' || process.state === 'starting').length,
    stopped: processes.filter((process) => inactiveStates.has(process.state)).length,
    problems: processes.filter((process) => problemStates.has(process.state)).length,
  }), [processes]);

  const visibleProcesses = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return processes.filter((process) => (
      isProcessVisible(process, filter)
      && (!normalizedQuery || [process.name, process.group, process.description]
        .some((value) => value.toLocaleLowerCase().includes(normalizedQuery)))
    ));
  }, [filter, processes, query]);

  const selectedTargets = useMemo(
    () => processes.filter((process) => selectedNames.has(process.name)).map((process) => process.name),
    [processes, selectedNames],
  );
  const allVisibleSelected = visibleProcesses.length > 0
    && visibleProcesses.every((process) => selectedNames.has(process.name));

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    setNotice('');

    if (isWindowsHost) {
      setRuntime({
        ...emptyRuntime,
        statusMessage: tCurrent('auto.supervisorManager.windowsUnsupported'),
      });
      setProcesses([]);
      setSelectedNames(new Set());
      setInitialized(true);
      setLoading(false);
      return;
    }

    try {
      const detectResult = await runCommand(createSupervisorDetectCommand());
      const nextRuntime = parseSupervisorDetectOutput(detectResult.stdout || '');
      let nextProcesses: SupervisorProcess[] = [];

      if (nextRuntime.installed && nextRuntime.running) {
        const statusResult = await runCommand(createSupervisorStatusCommand());
        nextProcesses = parseSupervisorStatusOutput(statusResult.stdout || '');
      }

      setRuntime(nextRuntime);
      setProcesses(nextProcesses);
      setConfigPreview('');
      setSelectedNames((current) => new Set(nextProcesses
        .map((process) => process.name)
        .filter((name) => current.has(name))));
      setLogTarget((current) => (
        nextProcesses.some((process) => process.name === current)
          ? current
          : nextProcesses[0]?.name ?? ''
      ));
      setSelectedConfig((current) => (
        nextRuntime.configFiles.includes(current)
          ? current
          : nextRuntime.configFiles[0] ?? ''
      ));
    } catch (caughtError) {
      setError(tCurrent('auto.supervisorManager.refreshFailed', { value0: getErrorMessage(caughtError) }));
    } finally {
      setInitialized(true);
      setLoading(false);
    }
  }, [isWindowsHost, runCommand]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadConfig = useCallback(async (path: string) => {
    if (!path) {
      setConfigPreview('');
      return;
    }

    setDetailLoading(true);
    setError('');
    try {
      const result = await runCommand(createSupervisorReadConfigCommand(path));
      if (result.code !== 0) {
        throw new Error(result.stderr || result.stdout);
      }
      setSelectedConfig(path);
      setConfigPreview(parseSupervisorTextOutput(result.stdout || ''));
    } catch (caughtError) {
      setError(tCurrent('auto.supervisorManager.configLoadFailed', { value0: getErrorMessage(caughtError) }));
    } finally {
      setDetailLoading(false);
    }
  }, [runCommand]);

  const loadLogs = useCallback(async () => {
    if (!logTarget) {
      setLogText('');
      return;
    }

    setDetailLoading(true);
    setError('');
    try {
      const result = await runCommand(createSupervisorLogCommand(logTarget, logStream));
      if (result.code !== 0) {
        throw new Error(result.stderr || result.stdout);
      }
      setLogText(parseSupervisorTextOutput(result.stdout || ''));
    } catch (caughtError) {
      setError(tCurrent('auto.supervisorManager.logLoadFailed', { value0: getErrorMessage(caughtError) }));
    } finally {
      setDetailLoading(false);
    }
  }, [logStream, logTarget, runCommand]);

  useEffect(() => {
    if (activeTab === 'logs' && logTarget) {
      void loadLogs();
    }
  }, [activeTab, loadLogs, logTarget]);

  const executeAction = async (action: SupervisorAction, targets: string[]) => {
    setPendingAction(null);
    setActing(action);
    setError('');
    setNotice('');

    try {
      const result = await runCommand(createSupervisorActionCommand(action, targets));
      if (result.code !== 0) {
        throw new Error(result.stderr || result.stdout || getActionLabel(action));
      }
      await refresh();
      setNotice(tCurrent('auto.supervisorManager.actionSucceeded', {
        value0: getActionLabel(action),
        value1: action === 'reload' ? 1 : targets.length,
      }));
    } catch (caughtError) {
      setError(tCurrent('auto.supervisorManager.actionFailed', {
        value0: getActionLabel(action),
        value1: getErrorMessage(caughtError),
      }));
    } finally {
      setActing('');
    }
  };

  const requestAction = (action: SupervisorAction, targets: string[]) => {
    if (action === 'start') {
      void executeAction(action, targets);
      return;
    }
    setPendingAction({ action, targets });
  };

  const toggleProcess = (name: string) => {
    setSelectedNames((current) => {
      const next = new Set(current);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  const toggleVisibleProcesses = () => {
    setSelectedNames((current) => {
      const next = new Set(current);
      visibleProcesses.forEach((process) => {
        if (allVisibleSelected) {
          next.delete(process.name);
        } else {
          next.add(process.name);
        }
      });
      return next;
    });
  };

  const controlsDisabled = loading || acting !== '' || !runtime.installed || !runtime.running;
  const runtimeTone = runtime.running ? 'online' : runtime.installed ? 'warning' : 'offline';

  return (
    <div className="supervisor-manager">
      <header className="supervisor-header">
        <div className="supervisor-heading">
          <span className={`supervisor-heading-icon ${runtimeTone}`}><Activity aria-hidden="true" /></span>
          <span>
            <h2>{tCurrent('auto.supervisorManager.title')}</h2>
            <small>{tCurrent('auto.supervisorManager.subtitle')}</small>
          </span>
        </div>
        <div className="supervisor-header-actions">
          <span className={`supervisor-runtime-pill ${runtimeTone}`}>
            <i />
            {runtime.running
              ? tCurrent('auto.supervisorManager.online')
              : runtime.installed
                ? tCurrent('auto.supervisorManager.unreachable')
                : tCurrent('auto.supervisorManager.notInstalled')}
          </span>
          <button
            type="button"
            className="supervisor-button"
            disabled={loading}
            onClick={() => void refresh()}
          >
            <RefreshCw aria-hidden="true" className={loading ? 'spinning' : ''} />
            {loading ? tCurrent('auto.supervisorManager.refreshing') : tCurrent('auto.supervisorManager.refresh')}
          </button>
          <button
            type="button"
            className="supervisor-button supervisor-button-primary"
            disabled={controlsDisabled}
            onClick={() => requestAction('reload', [])}
          >
            <RotateCw aria-hidden="true" />
            {acting === 'reload' ? tCurrent('auto.supervisorManager.working') : tCurrent('auto.supervisorManager.action.reload')}
          </button>
        </div>
      </header>

      {error ? <DismissibleAlert className="supervisor-alert danger" onDismiss={() => setError('')} role="alert">{error}</DismissibleAlert> : null}
      {notice ? <DismissibleAlert className="supervisor-alert success" onDismiss={() => setNotice('')}>{notice}</DismissibleAlert> : null}

      <nav className="supervisor-tabs" role="tablist" aria-label={tCurrent('auto.supervisorManager.tabsLabel')}>
        <button type="button" role="tab" aria-selected={activeTab === 'overview'} className={activeTab === 'overview' ? 'active' : ''} onClick={() => setActiveTab('overview')}>
          <Activity aria-hidden="true" />
          {tCurrent('auto.supervisorManager.tab.overview')}
        </button>
        <button type="button" role="tab" aria-selected={activeTab === 'processes'} className={activeTab === 'processes' ? 'active' : ''} onClick={() => setActiveTab('processes')}>
          <List aria-hidden="true" />
          {tCurrent('auto.supervisorManager.tab.processes')}
          <span>{processes.length}</span>
        </button>
        <button type="button" role="tab" aria-selected={activeTab === 'logs'} className={activeTab === 'logs' ? 'active' : ''} onClick={() => setActiveTab('logs')}>
          <Terminal aria-hidden="true" />
          {tCurrent('auto.supervisorManager.tab.logs')}
        </button>
      </nav>

      <main className="supervisor-content">
        {!initialized || loading ? (
          <div className="supervisor-empty">
            <RefreshCw className="spinning" aria-hidden="true" />
            <strong>{tCurrent('auto.supervisorManager.loading')}</strong>
            <span>{tCurrent('auto.supervisorManager.loadingHint')}</span>
          </div>
        ) : !runtime.installed ? (
          <div className="supervisor-empty">
            <Activity aria-hidden="true" />
            <strong>{isWindowsHost ? tCurrent('auto.supervisorManager.windowsTitle') : tCurrent('auto.supervisorManager.missingTitle')}</strong>
            <span>{runtime.statusMessage || tCurrent('auto.supervisorManager.missingHint')}</span>
          </div>
        ) : activeTab === 'overview' ? (
          <div className="supervisor-overview">
            <section className="supervisor-runtime-card">
              <div className={`supervisor-runtime-visual ${runtimeTone}`}>
                <Activity aria-hidden="true" />
              </div>
              <div className="supervisor-runtime-copy">
                <span>{tCurrent('auto.supervisorManager.runtime')}</span>
                <strong>{runtime.running ? tCurrent('auto.supervisorManager.healthy') : tCurrent('auto.supervisorManager.unreachable')}</strong>
                <small>{runtime.statusMessage || tCurrent('auto.supervisorManager.runtimeHint')}</small>
              </div>
              <dl>
                <div>
                  <dt>{tCurrent('auto.supervisorManager.version')}</dt>
                  <dd>{runtime.version || '-'}</dd>
                </div>
                <div>
                  <dt>{tCurrent('auto.supervisorManager.executable')}</dt>
                  <dd title={runtime.executable}>{runtime.executable || '-'}</dd>
                </div>
              </dl>
            </section>

            <section className="supervisor-stat-grid" aria-label={tCurrent('auto.supervisorManager.stats')}>
              <article><span>{tCurrent('auto.supervisorManager.total')}</span><strong>{stats.total}</strong><i className="neutral" /></article>
              <article><span>{tCurrent('auto.supervisorManager.running')}</span><strong>{stats.running}</strong><i className="positive" /></article>
              <article><span>{tCurrent('auto.supervisorManager.stopped')}</span><strong>{stats.stopped}</strong><i className="muted" /></article>
              <article><span>{tCurrent('auto.supervisorManager.problems')}</span><strong>{stats.problems}</strong><i className="danger" /></article>
            </section>

            <section className="supervisor-config-card">
              <header>
                <span><FileText aria-hidden="true" /></span>
                <div>
                  <strong>{tCurrent('auto.supervisorManager.configTitle')}</strong>
                  <small>{tCurrent('auto.supervisorManager.configHint')}</small>
                </div>
              </header>
              <div className="supervisor-config-layout">
                <div className="supervisor-config-list">
                  {runtime.configFiles.length > 0 ? runtime.configFiles.map((path) => (
                    <button
                      key={path}
                      type="button"
                      className={selectedConfig === path ? 'active' : ''}
                      title={path}
                      onClick={() => void loadConfig(path)}
                    >
                      <FileText aria-hidden="true" />
                      <span>{path.split('/').pop()}</span>
                      <small>{path}</small>
                    </button>
                  )) : <div className="supervisor-config-empty">{tCurrent('auto.supervisorManager.noConfigs')}</div>}
                </div>
                <pre className="supervisor-config-preview">
                  {detailLoading
                    ? tCurrent('auto.supervisorManager.loadingConfig')
                    : configPreview || tCurrent('auto.supervisorManager.chooseConfig')}
                </pre>
              </div>
            </section>
          </div>
        ) : activeTab === 'processes' ? (
          <div className="supervisor-processes">
            <div className="supervisor-process-toolbar">
              <div className="supervisor-batch-actions">
                <span>{tCurrent('auto.supervisorManager.selected', { value0: selectedTargets.length })}</span>
                <button type="button" disabled={controlsDisabled || selectedTargets.length === 0} onClick={() => requestAction('start', selectedTargets)}>
                  <Play aria-hidden="true" />{tCurrent('auto.supervisorManager.action.start')}
                </button>
                <button type="button" disabled={controlsDisabled || selectedTargets.length === 0} onClick={() => requestAction('stop', selectedTargets)}>
                  <StopIcon aria-hidden="true" />{tCurrent('auto.supervisorManager.action.stop')}
                </button>
                <button type="button" disabled={controlsDisabled || selectedTargets.length === 0} onClick={() => requestAction('restart', selectedTargets)}>
                  <RotateCw aria-hidden="true" />{tCurrent('auto.supervisorManager.action.restart')}
                </button>
                {selectedTargets.length > 0 ? (
                  <button type="button" className="subtle" onClick={() => setSelectedNames(new Set())}>{tCurrent('auto.supervisorManager.clear')}</button>
                ) : null}
              </div>
              <div className="supervisor-filters">
                <select value={filter} onChange={(event) => setFilter(event.target.value as ProcessFilter)} aria-label={tCurrent('auto.supervisorManager.filterLabel')}>
                  <option value="all">{tCurrent('auto.supervisorManager.filter.all')}</option>
                  <option value="running">{tCurrent('auto.supervisorManager.filter.running')}</option>
                  <option value="stopped">{tCurrent('auto.supervisorManager.filter.stopped')}</option>
                  <option value="problems">{tCurrent('auto.supervisorManager.filter.problems')}</option>
                </select>
                <input
                  type="search"
                  value={query}
                  placeholder={tCurrent('auto.supervisorManager.searchPlaceholder')}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
            </div>

            <div className="supervisor-table-wrap">
              <table className="supervisor-table">
                <thead>
                  <tr>
                    <th className="supervisor-check-cell">
                      <input
                        type="checkbox"
                        checked={allVisibleSelected}
                        aria-label={tCurrent('auto.supervisorManager.selectAll')}
                        onChange={toggleVisibleProcesses}
                      />
                    </th>
                    <th>{tCurrent('auto.supervisorManager.process')}</th>
                    <th>{tCurrent('auto.supervisorManager.group')}</th>
                    <th>{tCurrent('auto.supervisorManager.state')}</th>
                    <th>{tCurrent('auto.supervisorManager.pid')}</th>
                    <th>{tCurrent('auto.supervisorManager.uptime')}</th>
                    <th className="supervisor-actions-cell">{tCurrent('auto.supervisorManager.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleProcesses.map((process) => (
                    <tr key={process.name} className={selectedNames.has(process.name) ? 'selected' : ''}>
                      <td className="supervisor-check-cell">
                        <input
                          type="checkbox"
                          checked={selectedNames.has(process.name)}
                          aria-label={tCurrent('auto.supervisorManager.selectProcess', { value0: process.name })}
                          onChange={() => toggleProcess(process.name)}
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="supervisor-process-link"
                          title={process.name}
                          onClick={() => {
                            setLogTarget(process.name);
                            setActiveTab('logs');
                          }}
                        >
                          <strong>{process.processName}</strong>
                          <small>{process.description || '-'}</small>
                        </button>
                      </td>
                      <td><code>{process.group || '-'}</code></td>
                      <td><span className={`supervisor-state-tag ${process.state}`}><i />{getStateLabel(process.state)}</span></td>
                      <td>{process.pid ?? '-'}</td>
                      <td>{process.uptime || '-'}</td>
                      <td className="supervisor-row-actions">
                        {(['start', 'stop', 'restart'] as const).map((action) => (
                          <button
                            key={action}
                            type="button"
                            className={action === 'stop' ? 'danger' : ''}
                            title={getActionLabel(action)}
                            aria-label={`${getActionLabel(action)} ${process.name}`}
                            disabled={controlsDisabled
                              || (action === 'start' && (process.state === 'running' || process.state === 'starting'))
                              || (action === 'stop' && nonStoppableStates.has(process.state))}
                            onClick={() => requestAction(action, [process.name])}
                          >
                            <SupervisorActionIcon action={action} />
                          </button>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {visibleProcesses.length === 0 ? (
                <div className="supervisor-table-empty">
                  <List aria-hidden="true" />
                  <strong>{tCurrent('auto.supervisorManager.noProcesses')}</strong>
                  <span>{runtime.running ? tCurrent('auto.supervisorManager.noProcessesHint') : runtime.statusMessage}</span>
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="supervisor-logs">
            <div className="supervisor-log-toolbar">
              <label>
                <span>{tCurrent('auto.supervisorManager.logProcess')}</span>
                <select value={logTarget} onChange={(event) => setLogTarget(event.target.value)}>
                  {processes.map((process) => <option key={process.name} value={process.name}>{process.name}</option>)}
                </select>
              </label>
              <div className="supervisor-log-streams" role="group" aria-label={tCurrent('auto.supervisorManager.logStream')}>
                {(['stdout', 'stderr'] as SupervisorLogStream[]).map((stream) => (
                  <button key={stream} type="button" className={logStream === stream ? 'active' : ''} onClick={() => setLogStream(stream)}>
                    {stream}
                  </button>
                ))}
              </div>
              <button type="button" className="supervisor-button" disabled={!logTarget || detailLoading} onClick={() => void loadLogs()}>
                <RefreshCw aria-hidden="true" className={detailLoading ? 'spinning' : ''} />
                {tCurrent('auto.supervisorManager.refreshLogs')}
              </button>
            </div>
            <pre className="supervisor-log-output">
              {detailLoading
                ? tCurrent('auto.supervisorManager.loadingLogs')
                : logText || (logTarget ? tCurrent('auto.supervisorManager.emptyLogs') : tCurrent('auto.supervisorManager.chooseProcess'))}
            </pre>
          </div>
        )}
      </main>

      {pendingAction ? createPortal(
        <div className="supervisor-modal-overlay" role="presentation" onMouseDown={() => setPendingAction(null)}>
          <div
            className="supervisor-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="supervisor-confirm-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="supervisor-modal-icon"><RotateCw aria-hidden="true" /></div>
            <div>
              <h3 id="supervisor-confirm-title">{tCurrent('auto.supervisorManager.confirmTitle', { value0: getActionLabel(pendingAction.action) })}</h3>
              <p>{pendingAction.action === 'reload'
                ? tCurrent('auto.supervisorManager.confirmReload')
                : tCurrent('auto.supervisorManager.confirmProcesses', {
                  value0: getActionLabel(pendingAction.action),
                  value1: pendingAction.targets.length,
                })}</p>
              {pendingAction.targets.length > 0 ? <code>{pendingAction.targets.join(', ')}</code> : null}
            </div>
            <footer>
              <button type="button" onClick={() => setPendingAction(null)}>{tCurrent('auto.supervisorManager.cancel')}</button>
              <button type="button" className="danger" onClick={() => void executeAction(pendingAction.action, pendingAction.targets)}>
                {tCurrent('auto.supervisorManager.confirm')}
              </button>
            </footer>
          </div>
        </div>,
        document.body,
      ) : null}
      {sudoPrompt}
    </div>
  );
}

export default RemoteSupervisorManager;
