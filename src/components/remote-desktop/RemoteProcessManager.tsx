import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import DismissibleAlert from './DismissibleAlert';

import { t } from '../../i18n';
import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import {
  DEFAULT_SIGNAL,
  getLinuxProcessDetailCommand,
  getLinuxProcessListCommand,
  getProcessSignalCommand,
  getSignalByValue,
  getVisibleProcessSortKey,
  getWindowsProcessDetailCommand,
  getWindowsProcessListCommand,
  SIGNALS,
} from './processManagerCommands';
import {
  compactAiField,
  formatCpu,
  formatMemory,
  getCpuValue,
  getMemoryValue,
  parseLinuxProcessOutput,
  parseProcessDetailOutput,
  parseWindowsProcessOutput,
} from './processManagerParsers';
import type {
  PendingSignal,
  ProcessContextMenuState,
  ProcessDetail,
  ProcessRow,
  RemoteProcessEntry,
  RemoteProcessManagerProps,
  RemoteProcessManagerSortKey,
  RemoteProcessManagerViewMode,
  SortDir,
} from './processManagerTypes';
import { useProcessManagerAi } from './processManagerAi';
import {
  getProcessContextMenuPosition,
  getStateTone,
  ProcessAiReportModal,
  ProcessContextMenu,
  ProcessDetailPanel,
  SignalConfirmModal,
} from './processManagerViews';
import { clampPercent } from './parseUtils';
import { isWindowsSystem } from './remoteSystem';
import { useSudoCommand } from './sudoPrompt';

export type {
  RemoteProcessManagerLaunchOptions,
  RemoteProcessManagerSortKey,
  RemoteProcessManagerViewMode,
} from './processManagerTypes';
export type { RemoteProcessEntry } from './processManagerTypes';

const AUTO_REFRESH_OPTIONS = [3000, 5000, 10000] as const;
const DEFAULT_AUTO_REFRESH_MS = 5000;
const PROCESS_ROW_HEIGHT = 33;
const PROCESS_ROW_OVERSCAN = 8;

function compareProcesses(
  first: RemoteProcessEntry,
  second: RemoteProcessEntry,
  sortKey: RemoteProcessManagerSortKey,
  sortDir: SortDir,
  isWindowsHost: boolean,
) {
  const direction = sortDir === 'asc' ? 1 : -1;

  const readSortValue = (process: RemoteProcessEntry) => {
    if (sortKey === 'pid') return process.pid;
    if (sortKey === 'ppid') return process.ppid ?? -1;
    if (sortKey === 'cpu') return getCpuValue(process, isWindowsHost);
    if (sortKey === 'memory') return getMemoryValue(process, isWindowsHost);
    if (sortKey === 'user') return process.user ?? '';
    if (sortKey === 'state') return process.state ?? '';
    if (sortKey === 'startTime') return process.startTime ?? '';
    if (sortKey === 'runtime') return process.runtime ?? '';
    return process.command;
  };

  const firstValue = readSortValue(first);
  const secondValue = readSortValue(second);

  if (typeof firstValue === 'number' && typeof secondValue === 'number') {
    return (firstValue - secondValue) * direction;
  }

  return String(firstValue).localeCompare(String(secondValue), getShellDeskLocale()) * direction;
}

function matchesQuery(process: RemoteProcessEntry, query: string) {
  if (!query) {
    return true;
  }

  const normalizedQuery = query.toLowerCase();
  const searchableText = [
    process.pid,
    process.ppid,
    process.user,
    process.state,
    process.command,
    process.executablePath,
  ].filter((value) => value !== undefined && value !== null).join(' ').toLowerCase();

  return searchableText.includes(normalizedQuery);
}

function flattenProcessTree(
  processes: RemoteProcessEntry[],
  visiblePids: Set<number>,
  compare: (first: RemoteProcessEntry, second: RemoteProcessEntry) => number,
) {
  const processByPid = new Map(processes.map((process) => [process.pid, process]));
  const childrenByPid = new Map<number, RemoteProcessEntry[]>();

  processes.forEach((process) => {
    if (!visiblePids.has(process.pid)) {
      return;
    }

    const parentPid = process.ppid;

    if (parentPid === undefined || !visiblePids.has(parentPid)) {
      return;
    }

    const children = childrenByPid.get(parentPid) ?? [];
    children.push(process);
    childrenByPid.set(parentPid, children);
  });

  childrenByPid.forEach((children) => children.sort(compare));

  const roots = processes
    .filter((process) => visiblePids.has(process.pid))
    .filter((process) => process.ppid === undefined || !processByPid.has(process.ppid) || !visiblePids.has(process.ppid))
    .sort(compare);
  const rows: ProcessRow[] = [];
  const walkedPids = new Set<number>();

  const walk = (process: RemoteProcessEntry, depth: number) => {
    if (walkedPids.has(process.pid)) {
      return;
    }

    walkedPids.add(process.pid);
    rows.push({ process, depth });
    (childrenByPid.get(process.pid) ?? []).forEach((child) => walk(child, depth + 1));
  };

  roots.forEach((process) => walk(process, 0));

  processes
    .filter((process) => visiblePids.has(process.pid) && !walkedPids.has(process.pid))
    .sort(compare)
    .forEach((process) => rows.push({ process, depth: 0 }));

  return rows;
}

function ProcessManager({ connectionId, settings, systemType, launchOptions }: RemoteProcessManagerProps) {
  const language = settings.language;
  const isWindowsHost = isWindowsSystem(systemType);
  const { runCommand, sudoPrompt } = useSudoCommand(connectionId, systemType);
  const isMountedRef = useRef(true);
  const isRefreshingRef = useRef(false);
  const missingPidNoticeRef = useRef<number | null>(null);
  const tableWrapRef = useRef<HTMLDivElement | null>(null);
  const [processes, setProcesses] = useState<RemoteProcessEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [signalingPid, setSignalingPid] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [success, setSuccess] = useState('');
  const [search, setSearch] = useState(launchOptions?.search ?? '');
  const [userFilter, setUserFilter] = useState(launchOptions?.user ?? 'all');
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [autoRefreshMs, setAutoRefreshMs] = useState<(typeof AUTO_REFRESH_OPTIONS)[number]>(DEFAULT_AUTO_REFRESH_MS);
  const [sortKey, setSortKey] = useState<RemoteProcessManagerSortKey>(getVisibleProcessSortKey(launchOptions?.sortKey));
  const [sortDir, setSortDir] = useState<SortDir>(launchOptions?.sortDir ?? 'desc');
  const [viewMode, setViewMode] = useState<RemoteProcessManagerViewMode>(launchOptions?.viewMode ?? 'table');
  const [selectedSignalValue, setSelectedSignalValue] = useState(DEFAULT_SIGNAL.value);
  const [selectedPid, setSelectedPid] = useState<number | null>(launchOptions?.pid ?? null);
  const [processDetail, setProcessDetail] = useState<ProcessDetail | null>(null);
  const [pendingSignal, setPendingSignal] = useState<PendingSignal | null>(null);
  const [contextMenu, setContextMenu] = useState<ProcessContextMenuState | null>(null);
  const [tableScrollTop, setTableScrollTop] = useState(0);
  const [tableViewportHeight, setTableViewportHeight] = useState(0);
  const selectedSignal = getSignalByValue(selectedSignalValue);

  const refresh = useCallback(async (options?: { silent?: boolean }) => {
    if (isRefreshingRef.current) {
      return;
    }

    isRefreshingRef.current = true;

    if (!options?.silent) {
      setLoading(true);
    }

    setError('');

    try {
      const result = await runCommand(isWindowsHost ? getWindowsProcessListCommand(language) : getLinuxProcessListCommand(language));
      const stdout = result.stdout || '';
      const nextProcesses = isWindowsHost ? parseWindowsProcessOutput(stdout) : parseLinuxProcessOutput(stdout, language);

      if (!isMountedRef.current) {
        return;
      }

      setProcesses(nextProcesses);

      if (result.code !== 0 && !nextProcesses.length) {
        setError(result.stderr || t('process.error.listReadFailed', language));
      } else if (!nextProcesses.length && stdout.trim()) {
        setError(t('process.error.listUnparseable', language, { output: compactAiField(stdout, 200) }));
      } else if (!nextProcesses.length) {
        setError(result.stderr || t('process.error.noProcessData', language));
      }
    } catch (err) {
      if (isMountedRef.current) {
        setError(getErrorMessage(err));
      }
    } finally {
      isRefreshingRef.current = false;

      if (isMountedRef.current && !options?.silent) {
        setLoading(false);
      }
    }
  }, [isWindowsHost, language, runCommand]);

  const loadProcessDetails = useCallback(async (pid: number) => {
    if (!Number.isInteger(pid) || pid <= 0) {
      return;
    }

    setDetailLoading(true);

    try {
      const result = await runCommand(isWindowsHost ? getWindowsProcessDetailCommand(pid) : getLinuxProcessDetailCommand(pid));
      const nextDetail = parseProcessDetailOutput(result.stdout || '', pid);

      if (result.code !== 0) {
        nextDetail.error = result.stderr || t('process.error.detailReadFailed', language);
      }

      if (isMountedRef.current) {
        setProcessDetail(nextDetail);
      }
    } catch (err) {
      if (isMountedRef.current) {
        setProcessDetail({
          pid,
          ioStats: [],
          threads: [],
          ports: [],
          loadedAt: Date.now(),
          error: getErrorMessage(err),
        });
      }
    } finally {
      if (isMountedRef.current) {
        setDetailLoading(false);
      }
    }
  }, [isWindowsHost, language, runCommand]);

  useEffect(() => {
    isMountedRef.current = true;
    void refresh();

    return () => {
      isMountedRef.current = false;
      isRefreshingRef.current = false;
    };
  }, [refresh]);

  useEffect(() => {
    if (!launchOptions) {
      return;
    }

    if (typeof launchOptions.search === 'string') setSearch(launchOptions.search);
    if (typeof launchOptions.user === 'string') setUserFilter(launchOptions.user);
    if (launchOptions.sortKey) setSortKey(getVisibleProcessSortKey(launchOptions.sortKey));
    if (launchOptions.sortDir) setSortDir(launchOptions.sortDir);
    if (launchOptions.viewMode) setViewMode(launchOptions.viewMode);
    if (Number.isInteger(launchOptions.pid) && launchOptions.pid! > 0) setSelectedPid(launchOptions.pid!);
  }, [launchOptions]);

  useEffect(() => {
    if (!autoRefresh) {
      return undefined;
    }

    let canceled = false;
    let timerId: number | undefined;

    const scheduleTick = () => {
      if (canceled) {
        return;
      }

      timerId = window.setTimeout(async () => {
        if (!pendingSignal && signalingPid === null) {
          await refresh({ silent: true });
        }

        scheduleTick();
      }, autoRefreshMs);
    };

    scheduleTick();

    return () => {
      canceled = true;

      if (timerId !== undefined) {
        window.clearTimeout(timerId);
      }
    };
  }, [autoRefresh, autoRefreshMs, pendingSignal, refresh, signalingPid]);

  useEffect(() => {
    if (selectedPid === null) {
      setProcessDetail(null);
      return;
    }

    void loadProcessDetails(selectedPid);
  }, [loadProcessDetails, selectedPid]);

  useEffect(() => {
    if (!contextMenu) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setContextMenu(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [contextMenu]);

  const compare = useCallback((first: RemoteProcessEntry, second: RemoteProcessEntry) => (
    compareProcesses(first, second, sortKey, sortDir, isWindowsHost)
  ), [isWindowsHost, sortDir, sortKey]);

  const users = useMemo(() => {
    const uniqueUsers = new Set(
      processes
        .map((process) => process.user?.trim())
        .filter((user): user is string => Boolean(user && user !== '-')),
    );

    return [...uniqueUsers].sort((first, second) => first.localeCompare(second, getShellDeskLocale()));
  }, [processes]);

  const baseFilteredProcesses = useMemo(() => {
    const normalizedSearch = search.trim();

    return processes.filter((process) => {
      const matchesUser = userFilter === 'all' || process.user === userFilter;
      return matchesUser && matchesQuery(process, normalizedSearch);
    });
  }, [processes, search, userFilter]);

  const processRows = useMemo<ProcessRow[]>(() => {
    const basePids = new Set(baseFilteredProcesses.map((process) => process.pid));
    const normalizedSearch = search.trim();

    if (viewMode === 'table') {
      return [...baseFilteredProcesses].sort(compare).map((process) => ({ process, depth: 0 }));
    }

    if (normalizedSearch) {
      const processByPid = new Map(processes.map((process) => [process.pid, process]));

      baseFilteredProcesses.forEach((process) => {
        let parentPid = process.ppid;
        let guard = 0;

        while (parentPid !== undefined && guard < 64) {
          const parent = processByPid.get(parentPid);

          if (!parent) {
            break;
          }

          basePids.add(parent.pid);
          parentPid = parent.ppid;
          guard += 1;
        }

        processes.filter((candidate) => candidate.ppid === process.pid).forEach((child) => basePids.add(child.pid));
      });
    }

    return flattenProcessTree(processes, basePids, compare);
  }, [baseFilteredProcesses, compare, processes, search, viewMode]);

  const selectedProcess = useMemo(() => {
    if (selectedPid === null) {
      return null;
    }

    return processes.find((process) => process.pid === selectedPid) ?? null;
  }, [processes, selectedPid]);

  const selectedParent = useMemo(() => {
    if (!selectedProcess?.ppid) {
      return null;
    }

    return processes.find((process) => process.pid === selectedProcess.ppid) ?? null;
  }, [processes, selectedProcess]);

  const selectedChildren = useMemo(() => {
    if (!selectedProcess) {
      return [];
    }

    return processes.filter((process) => process.ppid === selectedProcess.pid).sort(compare);
  }, [compare, processes, selectedProcess]);

  const maxCpuValue = useMemo(() => Math.max(1, ...processes.map((process) => getCpuValue(process, isWindowsHost))), [isWindowsHost, processes]);
  const maxMemoryValue = useMemo(() => Math.max(1, ...processes.map((process) => getMemoryValue(process, isWindowsHost))), [isWindowsHost, processes]);
  const virtualRows = useMemo(() => {
    if (processRows.length === 0) {
      return { rows: [] as ProcessRow[], startIndex: 0, endIndex: 0, topHeight: 0, bottomHeight: 0 };
    }
    const visibleCount = Math.max(1, Math.ceil(tableViewportHeight / PROCESS_ROW_HEIGHT));
    const startIndex = Math.max(0, Math.floor(tableScrollTop / PROCESS_ROW_HEIGHT) - PROCESS_ROW_OVERSCAN);
    const endIndex = Math.min(processRows.length, startIndex + visibleCount + PROCESS_ROW_OVERSCAN * 2);
    return {
      rows: processRows.slice(startIndex, endIndex),
      startIndex,
      endIndex,
      topHeight: startIndex * PROCESS_ROW_HEIGHT,
      bottomHeight: Math.max(0, (processRows.length - endIndex) * PROCESS_ROW_HEIGHT),
    };
  }, [processRows, tableScrollTop, tableViewportHeight]);

  const {
    aiReportOpen,
    setAiReportOpen,
    aiReportPhase,
    aiReportText,
    aiReportError,
    setAiReportError,
    aiReportNotice,
    setAiReportNotice,
    aiReportSnapshotNote,
    processInsight,
    processInsightLoadingPid,
    isAiReportBusy,
    requestAiReport,
    requestProcessInsight,
    copyAiReport,
    exportAiReport,
  } = useProcessManagerAi({
    settings,
    language,
    processes,
    isWindowsHost,
    selectedProcess,
    processDetail,
    selectedParent,
    selectedChildren,
  });

  useEffect(() => {
    if (selectedPid !== null && processes.some((process) => process.pid === selectedPid)) {
      missingPidNoticeRef.current = null;
      setNotice('');
      return;
    }

    if (selectedPid !== null && processes.length > 0 && !loading && missingPidNoticeRef.current !== selectedPid) {
      missingPidNoticeRef.current = selectedPid;
      setNotice(t('process.notice.pidMissing', language, { pid: selectedPid }));
    }

    if (selectedPid === null && processRows.length > 0) {
      setSelectedPid(processRows[0].process.pid);
    }
  }, [language, loading, processRows, processes, selectedPid]);

  const toggleSort = (key: RemoteProcessManagerSortKey) => {
    if (sortKey === key) {
      setSortDir((currentDir) => (currentDir === 'asc' ? 'desc' : 'asc'));
      return;
    }

    setSortKey(key);
    setSortDir(key === 'user' || key === 'command' || key === 'state' ? 'asc' : 'desc');
  };

  const sortIndicator = (key: RemoteProcessManagerSortKey) => {
    if (sortKey !== key) {
      return <span className="proc-sort-icon" aria-hidden="true" />;
    }

    return <span className="proc-sort-icon" aria-hidden="true">{sortDir === 'asc' ? '▲' : '▼'}</span>;
  };

  const syncTableViewport = useCallback(() => {
    const element = tableWrapRef.current;
    if (!element) return;
    setTableScrollTop(element.scrollTop);
    setTableViewportHeight(element.clientHeight);
  }, []);

  useEffect(() => {
    syncTableViewport();
    const element = tableWrapRef.current;
    if (!element || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver(syncTableViewport);
    observer.observe(element);
    return () => observer.disconnect();
  }, [syncTableViewport]);

  useEffect(() => {
    const element = tableWrapRef.current;
    if (!element) return;
    element.scrollTop = 0;
    setTableScrollTop(0);
  }, [search, sortDir, sortKey, userFilter, viewMode]);

  const closeContextMenu = () => setContextMenu(null);

  const openProcessContextMenu = (event: MouseEvent<HTMLTableRowElement>, process: RemoteProcessEntry) => {
    event.preventDefault();
    event.stopPropagation();
    setSelectedPid(process.pid);
    const position = getProcessContextMenuPosition(event.clientX, event.clientY);
    setContextMenu({ ...position, process });
  };

  const copyToClipboard = async (value: string, label: string) => {
    setError('');
    setNotice('');
    setSuccess('');

    try {
      await navigator.clipboard.writeText(value);
      setSuccess(t('process.message.copied', language, { label }));
    } catch (err) {
      setError(t('process.error.copyFailed', language, { error: getErrorMessage(err) }));
    }
  };

  const requestSignal = (process: RemoteProcessEntry) => {
    setPendingSignal({
      pid: process.pid,
      command: process.command,
      signal: isWindowsHost
        ? {
            value: 'win-kill',
            name: 'Stop-Process',
            label: t('process.signal.windowsKill.label', language),
            descriptionId: 'process.signal.windowsKill.description',
          }
        : selectedSignal,
    });
  };

  const sendSignal = async (pending: PendingSignal) => {
    if (!Number.isInteger(pending.pid) || pending.pid <= 0) {
      setError(t('process.error.invalidPid', language));
      return;
    }

    setSignalingPid(pending.pid);
    setError('');
    setNotice('');
    setSuccess('');

    try {
      const result = await runCommand(getProcessSignalCommand(isWindowsHost, pending.signal.value, pending.pid));

      if (result.code !== 0) {
        throw new Error(result.stderr || result.stdout || t('process.error.operationFailed', language));
      }

      setSuccess(isWindowsHost
        ? t('process.success.ended', language, { pid: pending.pid })
        : t('process.success.signalSent', language, { pid: pending.pid, signal: pending.signal.name }));
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSignalingPid(null);
      setPendingSignal(null);
    }
  };

  const renderSortHeader = (key: RemoteProcessManagerSortKey, label: string, className: string) => (
    <th className={className}>
      <button type="button" className="proc-sort-button" onClick={() => toggleSort(key)}>
        <span>{label}</span>
        {sortIndicator(key)}
      </button>
    </th>
  );

  const renderProcessRow = ({ process, depth }: ProcessRow) => {
    const isSelected = selectedPid === process.pid;
    const stateTone = getStateTone(process.state);
    const cpuValue = getCpuValue(process, isWindowsHost);
    const memoryValue = getMemoryValue(process, isWindowsHost);
    const cpuWidth = isWindowsHost ? (cpuValue / maxCpuValue) * 100 : clampPercent(cpuValue);
    const memoryWidth = isWindowsHost ? (memoryValue / maxMemoryValue) * 100 : clampPercent(memoryValue);

    return (
      <tr
        key={process.pid}
        className={`proc-row ${isSelected ? 'selected' : ''} ${stateTone === 'zombie' ? 'proc-zombie' : ''}`}
        onClick={() => setSelectedPid(process.pid)}
        onContextMenu={(event) => openProcessContextMenu(event, process)}
      >
        <td className="proc-pid">{process.pid}</td>
        <td className="proc-ppid">{process.ppid ?? '-'}</td>
        <td className="proc-user" title={process.user}>{process.user || '-'}</td>
        <td className="proc-cpu">
          <div className="proc-bar-wrap">
            <div className="proc-bar proc-bar-cpu" style={{ width: `${cpuWidth}%` }} />
            <span>{formatCpu(process, isWindowsHost)}</span>
          </div>
        </td>
        <td className="proc-mem">
          <div className="proc-bar-wrap">
            <div className="proc-bar proc-bar-mem" style={{ width: `${memoryWidth}%` }} />
            <span>{formatMemory(process, isWindowsHost)}</span>
          </div>
        </td>
        <td className="proc-command" title={process.command}>
          {viewMode === 'tree' ? <span className="proc-tree-indent" style={{ width: depth * 14 }} /> : null}
          {viewMode === 'tree' && depth > 0 ? <span className="proc-tree-branch" aria-hidden="true">└</span> : null}
          <span>{process.command}</span>
        </td>
      </tr>
    );
  };

  return (
    <div className="proc-manager">
      <div className="proc-toolbar">
        <div className="proc-toolbar-left">
          <button type="button" className="proc-tool-button ai" onClick={() => void requestAiReport()} disabled={loading || (!processes.length && !isAiReportBusy)}>
            {isAiReportBusy ? t('process.ui.aiAnalyzing', language) : t('process.ui.aiAnalyze', language)}
          </button>

          <button type="button" className="proc-tool-button primary" onClick={() => void refresh()} disabled={loading}>
            {loading ? t('process.ui.refreshing', language) : t('process.ui.refresh', language)}
          </button>

          <div className="proc-segmented" aria-label={t('process.ui.viewMode', language)}>
            <button type="button" className={viewMode === 'table' ? 'active' : ''} onClick={() => setViewMode('table')}>
              {t('process.ui.table', language)}
            </button>
            <button type="button" className={viewMode === 'tree' ? 'active' : ''} onClick={() => setViewMode('tree')}>
              {t('process.ui.tree', language)}
            </button>
          </div>

          <label className="proc-check-label">
            <input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />
            {t('process.ui.autoRefresh', language)}
          </label>

          <select
            className="proc-select proc-refresh-select"
            value={autoRefreshMs}
            onChange={(event) => setAutoRefreshMs(Number(event.target.value) as (typeof AUTO_REFRESH_OPTIONS)[number])}
            disabled={!autoRefresh}
            aria-label={t('process.ui.autoRefreshInterval', language)}
          >
            {AUTO_REFRESH_OPTIONS.map((interval) => <option key={interval} value={interval}>{interval / 1000}s</option>)}
          </select>

          <span className="proc-summary"><strong>{processRows.length}</strong> / {processes.length}</span>
        </div>

        <div className="proc-toolbar-right">
          <select className="proc-select proc-user-filter" value={userFilter} onChange={(event) => setUserFilter(event.target.value)} aria-label={t('process.ui.filterByUser', language)}>
            <option value="all">{t('process.ui.allUsers', language)}</option>
            {users.map((user) => <option key={user} value={user}>{user}</option>)}
          </select>

          <input
            type="search"
            className="proc-search"
            placeholder={t('process.ui.searchPlaceholder', language)}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      </div>

      {error ? <DismissibleAlert className="proc-alert danger" onDismiss={() => setError('')} role="alert">{error}</DismissibleAlert> : null}
      {notice ? <DismissibleAlert className="proc-alert info" onDismiss={() => setNotice('')}>{notice}</DismissibleAlert> : null}
      {success ? <DismissibleAlert className="proc-alert success" onDismiss={() => setSuccess('')}>{success}</DismissibleAlert> : null}

      <div className="proc-content">
        <section className="proc-table-panel" aria-label={t('process.ui.listAria', language)}>
          <div className="proc-table-wrap" ref={tableWrapRef} onScroll={syncTableViewport}>
            <table className="proc-table">
              <thead>
                <tr>
                  {renderSortHeader('pid', 'PID', 'proc-col-pid')}
                  {renderSortHeader('ppid', 'PPID', 'proc-col-ppid')}
                  {renderSortHeader('user', t('process.ui.user', language), 'proc-col-user')}
                  {renderSortHeader('cpu', isWindowsHost ? 'CPU(s)' : 'CPU%', 'proc-col-cpu')}
                  {renderSortHeader('memory', isWindowsHost ? t('process.ui.memoryMb', language) : 'MEM%', 'proc-col-mem')}
                  {renderSortHeader('command', t('process.ui.command', language), 'proc-col-command')}
                </tr>
              </thead>
              <tbody>
                {processRows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="proc-empty">
                      {loading ? t('process.ui.loadingList', language) : t('process.ui.noMatches', language)}
                    </td>
                  </tr>
                ) : (
                  <>
                    {virtualRows.topHeight > 0 ? <tr className="proc-spacer-row" aria-hidden="true"><td colSpan={6} style={{ height: virtualRows.topHeight }} /></tr> : null}
                    {virtualRows.rows.map(renderProcessRow)}
                    {virtualRows.bottomHeight > 0 ? <tr className="proc-spacer-row" aria-hidden="true"><td colSpan={6} style={{ height: virtualRows.bottomHeight }} /></tr> : null}
                  </>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <ProcessDetailPanel
          language={language}
          isWindowsHost={isWindowsHost}
          selectedPid={selectedPid}
          selectedProcess={selectedProcess}
          selectedParent={selectedParent}
          selectedChildren={selectedChildren}
          processDetail={processDetail}
          detailLoading={detailLoading}
          processInsight={processInsight}
          processInsightLoadingPid={processInsightLoadingPid}
          selectedSignal={selectedSignal}
          selectedSignalValue={selectedSignalValue}
          signals={SIGNALS}
          signalingPid={signalingPid}
          onSelectPid={setSelectedPid}
          onCopy={(value, label) => void copyToClipboard(value, label)}
          onLoadDetails={(pid) => void loadProcessDetails(pid)}
          onRequestSignal={requestSignal}
          onRequestInsight={() => void requestProcessInsight()}
          onSignalChange={setSelectedSignalValue}
        />
      </div>

      <ProcessContextMenu
        contextMenu={contextMenu}
        language={language}
        isWindowsHost={isWindowsHost}
        signalingPid={signalingPid}
        selectedSignal={selectedSignal}
        onClose={closeContextMenu}
        onCopy={(value, label) => void copyToClipboard(value, label)}
        onRequestSignal={requestSignal}
      />

      <ProcessAiReportModal
        open={aiReportOpen}
        language={language}
        phase={aiReportPhase}
        text={aiReportText}
        error={aiReportError}
        notice={aiReportNotice}
        snapshotNote={aiReportSnapshotNote}
        isBusy={isAiReportBusy}
        onClose={() => setAiReportOpen(false)}
        onDismissError={() => setAiReportError('')}
        onDismissNotice={() => setAiReportNotice('')}
        onCopy={() => void copyAiReport()}
        onExport={() => void exportAiReport()}
      />

      <SignalConfirmModal
        pendingSignal={pendingSignal}
        language={language}
        isWindowsHost={isWindowsHost}
        onCancel={() => setPendingSignal(null)}
        onConfirm={(pending) => void sendSignal(pending)}
      />
      {sudoPrompt}
    </div>
  );
}

export default ProcessManager;
