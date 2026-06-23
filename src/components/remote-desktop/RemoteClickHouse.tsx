import { indentWithTab } from '@codemirror/commands';
import { MySQL, sql } from '@codemirror/lang-sql';
import type { Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import { exportDatabaseRows, type DatabaseExportFormat } from './databaseExport';
import {
  createGenericColumns,
  createId,
  describeDatabaseTransport,
  formatCellValue,
  formatSqlPreview,
  formatTimestamp,
  isWriteStatement,
  quoteIdentifier,
  useContextMenu,
} from './databaseUtils';
import DismissibleAlert from './DismissibleAlert';
import { loadRemoteConnectionProfile, readProfileBoolean, readProfileString, saveRemoteConnectionProfile } from './remoteConnectionProfiles';
import { tCurrent } from '../../i18n';

interface RemoteClickHouseProps {
  connectionId: string;
  hostId: string;
}

interface ClickHouseConnectionForm {
  host: string;
  port: string;
  secure: boolean;
  user: string;
  password: string;
  initialDatabase: string;
}

type ClickHouseStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
type ClickHouseMessageType = 'info' | 'success' | 'error';
type ClickHouseResultStatus = 'success' | 'error';

interface TableInfo extends ShellDeskClickHouseTable {
  database: string;
}

interface ClickHouseMessage {
  type: ClickHouseMessageType;
  text: string;
}

interface ClickHouseQueryTab {
  id: string;
  title: string;
  sql: string;
  running: boolean;
}

interface ClickHouseResultTab {
  id: string;
  title: string;
  subtitle: string;
  sql: string;
  database?: string;
  status: ClickHouseResultStatus;
  result?: ShellDeskClickHouseQueryResult;
  error?: string;
  queryTime: number;
  createdAt: number;
  table?: TableInfo;
  columns: ShellDeskClickHouseColumn[];
}

interface ClickHouseHistoryItem {
  id: string;
  sql: string;
  database?: string;
  status: ClickHouseResultStatus;
  queryTime: number;
  rowCount?: number;
  error?: string;
  createdAt: number;
}

interface ClickHouseRowEntry {
  row: Record<string, unknown>;
  sourceIndex: number;
}

interface ClickHouseSortState {
  resultId: string;
  column: string;
  direction: 'asc' | 'desc';
}

interface ClickHouseEditingCell {
  rowIndex: number;
  column: string;
  value: string;
  isNull: boolean;
}

interface ClickHousePendingEdit {
  resultId: string;
  table: TableInfo;
  rowIndex: number;
  column: string;
  oldValue: unknown;
  newValue: unknown;
  pkColumns: string[];
  pkValues: unknown[];
}

type ClickHouseContextMenuTarget =
  | { type: 'database'; database: string }
  | { type: 'table'; database: string; table: ShellDeskClickHouseTable };

interface ClickHouseContextMenuState {
  x: number;
  y: number;
  target: ClickHouseContextMenuTarget;
}

const defaultHttpPort = 8123;
const defaultHttpsPort = 8443;
const pageSize = 100;
const tablePreviewLimit = 50;
const maxResultTabs = 10;
const maxHistoryItems = 12;

function getShellDeskEditorTheme(): 'light' | 'dark' {
  if (typeof document === 'undefined') {
    return 'dark';
  }

  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

function createQueryTab(index: number, sql = 'SELECT version() AS version;'): ClickHouseQueryTab {
  return {
    id: createId('query'),
    title: tCurrent('clickhouse.query.tabTitle', { index }),
    sql,
    running: false,
  };
}

function createInitialQueryState(): { tabs: ClickHouseQueryTab[]; activeId: string } {
  const tab = createQueryTab(1);
  return { tabs: [tab], activeId: tab.id };
}

function quoteClickHouseString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function toClickHouseLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return quoteClickHouseString(String(value));
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left === null || left === undefined) return right === null || right === undefined;
  if (right === null || right === undefined) return false;
  return String(left) === String(right);
}

function createExplainSql(sqlText: string): string {
  const statement = sqlText.trim().replace(/;+\s*$/, '');

  if (/^explain\b/i.test(statement)) {
    return statement;
  }

  return `EXPLAIN ${statement}`;
}

function formatCount(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  return new Intl.NumberFormat(getShellDeskLocale()).format(value);
}

function formatBytes(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let size = value;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size >= 10 || unitIndex === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unitIndex]}`;
}

function getColumnMeta(columns: ShellDeskClickHouseColumn[], name: string): ShellDeskClickHouseColumn | undefined {
  return columns.find((column) => column.name === name);
}

function getColumnBadge(column?: ShellDeskClickHouseColumn): string {
  if (!column) return '';
  if (column.isPrimaryKey) return 'PK';
  if (column.isSortingKey) return 'SORT';
  return '';
}

function describeResult(result: ShellDeskClickHouseQueryResult): string {
  if (result.columns.length === 0) return tCurrent('clickhouse.query.executed');
  return tCurrent('clickhouse.query.rows', { count: formatCount(result.rowCount ?? result.rows.length) });
}

function describeStatistics(statistics?: ShellDeskClickHouseQueryStatistics): string {
  if (!statistics) return '';
  const parts = [
    statistics.rowsRead ? tCurrent('clickhouse.query.rowsRead', { count: formatCount(statistics.rowsRead) }) : '',
    statistics.bytesRead ? formatBytes(statistics.bytesRead) : '',
  ].filter(Boolean);

  return parts.join(' · ');
}

function compareClickHouseCellValues(left: unknown, right: unknown): number {
  if (left === null || left === undefined) return right === null || right === undefined ? 0 : 1;
  if (right === null || right === undefined) return -1;

  const leftNumber = typeof left === 'number' ? left : typeof left === 'string' && left.trim() ? Number(left) : Number.NaN;
  const rightNumber = typeof right === 'number' ? right : typeof right === 'string' && right.trim() ? Number(right) : Number.NaN;

  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber - rightNumber;
  }

  return String(left).localeCompare(String(right), getShellDeskLocale(), {
    numeric: true,
    sensitivity: 'base',
  });
}

function RemoteClickHouse({ connectionId, hostId }: RemoteClickHouseProps) {
  const api = window.guiSSH;
  const initialQueryStateRef = useRef(createInitialQueryState());
  const clickhouseIdRef = useRef('');
  const sqlEditorRef = useRef<ReactCodeMirrorRef>(null);

  const [status, setStatus] = useState<ClickHouseStatus>('disconnected');
  const [errorMessage, setErrorMessage] = useState('');
  const [message, setMessage] = useState<ClickHouseMessage | null>(null);
  const [clickhouseId, setClickhouseId] = useState('');
  const [connectionForm, setConnectionForm] = useState<ClickHouseConnectionForm>({
    host: '127.0.0.1',
    port: String(defaultHttpPort),
    secure: false,
    user: 'default',
    password: '',
    initialDatabase: '',
  });
  const { host, port, secure, user, password, initialDatabase } = connectionForm;
  const updateConnectionFormField = useCallback(<Key extends keyof ClickHouseConnectionForm,>(
    key: Key,
    value: SetStateAction<ClickHouseConnectionForm[Key]>,
  ) => {
    setConnectionForm((currentForm) => ({
      ...currentForm,
      [key]: typeof value === 'function'
        ? (value as (currentValue: ClickHouseConnectionForm[Key]) => ClickHouseConnectionForm[Key])(currentForm[key])
        : value,
    }));
  }, []);
  const setHost = useCallback((value: SetStateAction<string>) => updateConnectionFormField('host', value), [updateConnectionFormField]);
  const setPort = useCallback((value: SetStateAction<string>) => updateConnectionFormField('port', value), [updateConnectionFormField]);
  const setSecure = useCallback((value: SetStateAction<boolean>) => updateConnectionFormField('secure', value), [updateConnectionFormField]);
  const setUser = useCallback((value: SetStateAction<string>) => updateConnectionFormField('user', value), [updateConnectionFormField]);
  const setPassword = useCallback((value: SetStateAction<string>) => updateConnectionFormField('password', value), [updateConnectionFormField]);
  const setInitialDatabase = useCallback((value: SetStateAction<string>) => updateConnectionFormField('initialDatabase', value), [updateConnectionFormField]);
  const [databases, setDatabases] = useState<string[]>([]);
  const [expandedDbs, setExpandedDbs] = useState<Set<string>>(new Set());
  const [loadingDbs, setLoadingDbs] = useState<Set<string>>(new Set());
  const [dbTables, setDbTables] = useState<Record<string, ShellDeskClickHouseTable[]>>({});
  const [objectSearch, setObjectSearch] = useState('');
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [selectedTable, setSelectedTable] = useState<TableInfo | null>(null);
  const [tableColumns, setTableColumns] = useState<ShellDeskClickHouseColumn[]>([]);
  const [activeDb, setActiveDb] = useState('');
  const [queryTabs, setQueryTabs] = useState<ClickHouseQueryTab[]>(initialQueryStateRef.current.tabs);
  const [activeQueryId, setActiveQueryId] = useState(initialQueryStateRef.current.activeId);
  const [resultTabs, setResultTabs] = useState<ClickHouseResultTab[]>([]);
  const [activeResultId, setActiveResultId] = useState('');
  const [history, setHistory] = useState<ClickHouseHistoryItem[]>([]);
  const [editingCell, setEditingCell] = useState<ClickHouseEditingCell | null>(null);
  const [pendingEdit, setPendingEdit] = useState<ClickHousePendingEdit | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [page, setPage] = useState(0);
  const [sortState, setSortState] = useState<ClickHouseSortState | null>(null);
  const [editorTheme, setEditorTheme] = useState<'light' | 'dark'>(getShellDeskEditorTheme);
  const [contextMenu, setContextMenu] = useState<ClickHouseContextMenuState | null>(null);

  const isReady = status === 'connected';
  const activeQueryTab = useMemo(() => {
    return queryTabs.find((tab) => tab.id === activeQueryId) ?? queryTabs[0];
  }, [activeQueryId, queryTabs]);

  const activeResultTab = useMemo(() => {
    return resultTabs.find((tab) => tab.id === activeResultId) ?? null;
  }, [activeResultId, resultTabs]);

  const activeResult = activeResultTab?.result ?? null;
  const activeResultColumns = activeResultTab?.columns ?? [];
  const activeResultPrimaryKeys = useMemo(() => {
    return activeResultColumns.filter((column) => column.isPrimaryKey).map((column) => column.name);
  }, [activeResultColumns]);
  const isActiveResultEditable = Boolean(activeResultTab?.table && activeResultPrimaryKeys.length > 0);
  const canRunActiveQuery = Boolean(activeQueryTab?.sql.trim()) && !activeQueryTab?.running;
  const canExplainActiveQuery = canRunActiveQuery && !isWriteStatement(activeQueryTab?.sql.trim() ?? '', 'clickhouse');
  const displayPort = parseInt(port, 10) || (secure ? defaultHttpsPort : defaultHttpPort);
  const isNativeTcpPort = displayPort === 9000;

  useEffect(() => {
    let disposed = false;

    void loadRemoteConnectionProfile(hostId, 'clickhouse').then((profile) => {
      if (disposed || !profile) return;

      setConnectionForm({
        host: readProfileString(profile, 'host', '127.0.0.1'),
        port: readProfileString(profile, 'port', String(defaultHttpPort)),
        secure: readProfileBoolean(profile, 'secure', false),
        user: readProfileString(profile, 'user', 'default'),
        password: readProfileString(profile, 'password', ''),
        initialDatabase: readProfileString(profile, 'initialDatabase', ''),
      });
    });

    return () => {
      disposed = true;
    };
  }, [hostId]);

  const filteredDatabases = useMemo(() => {
    const keyword = objectSearch.trim().toLowerCase();

    if (!keyword) {
      return databases.map((database) => ({
        database,
        tables: dbTables[database] ?? [],
        databaseMatched: true,
      }));
    }

    return databases
      .map((database) => {
        const tables = dbTables[database] ?? [];
        const databaseMatched = database.toLowerCase().includes(keyword);
        const matchedTables = databaseMatched
          ? tables
          : tables.filter((table) => (
              table.name.toLowerCase().includes(keyword)
              || table.engine.toLowerCase().includes(keyword)
            ));

        return { database, tables: matchedTables, databaseMatched };
      })
      .filter((entry) => entry.databaseMatched || entry.tables.length > 0);
  }, [databases, dbTables, objectSearch]);

  const sortedRowEntries = useMemo<ClickHouseRowEntry[]>(() => {
    if (!activeResult) return [];
    const entries = activeResult.rows.map((row, sourceIndex) => ({ row, sourceIndex }));

    if (!sortState || sortState.resultId !== activeResultTab?.id) {
      return entries;
    }

    const direction = sortState.direction === 'asc' ? 1 : -1;
    return entries.sort((left, right) => (
      compareClickHouseCellValues(left.row[sortState.column], right.row[sortState.column]) * direction
    ));
  }, [activeResult, activeResultTab?.id, sortState]);

  const pagedRows = useMemo(() => {
    return sortedRowEntries.slice(page * pageSize, (page + 1) * pageSize);
  }, [page, sortedRowEntries]);

  const totalPages = useMemo(() => {
    return Math.ceil(sortedRowEntries.length / pageSize);
  }, [sortedRowEntries.length]);

  const resetWorkspaceState = useCallback(() => {
    const nextQueryState = createInitialQueryState();
    setDatabases([]);
    setExpandedDbs(new Set());
    setLoadingDbs(new Set());
    setDbTables({});
    setObjectSearch('');
    setSelectedTable(null);
    setTableColumns([]);
    setActiveDb('');
    setQueryTabs(nextQueryState.tabs);
    setActiveQueryId(nextQueryState.activeId);
    setResultTabs([]);
    setActiveResultId('');
    setHistory([]);
    setEditingCell(null);
    setPendingEdit(null);
    setPage(0);
    setSortState(null);
    setMessage(null);
    setContextMenu(null);
  }, []);

  const addHistoryItem = useCallback((item: Omit<ClickHouseHistoryItem, 'id' | 'createdAt'>) => {
    setHistory((prev) => [
      {
        ...item,
        id: createId('history'),
        createdAt: Date.now(),
      },
      ...prev,
    ].slice(0, maxHistoryItems));
  }, []);

  const addResultTab = useCallback((tab: ClickHouseResultTab) => {
    setResultTabs((prev) => [...prev, tab].slice(-maxResultTabs));
    setActiveResultId(tab.id);
    setPage(0);
  }, []);

  const setQueryRunning = useCallback((queryId: string, running: boolean) => {
    setQueryTabs((prev) => prev.map((tab) => (tab.id === queryId ? { ...tab, running } : tab)));
  }, []);

  const updateActiveQuerySql = useCallback((sql: string) => {
    setQueryTabs((prev) => prev.map((tab) => (tab.id === activeQueryId ? { ...tab, sql } : tab)));
  }, [activeQueryId]);

  const loadTables = useCallback(async (database: string, force = false) => {
    if (!api?.connections || !clickhouseId) return;
    if (!force && dbTables[database]) return;

    setLoadingDbs((prev) => new Set(prev).add(database));

    try {
      const tables = await api.connections.clickhouseTables(connectionId, clickhouseId, database);
      setDbTables((prev) => ({ ...prev, [database]: tables }));
    } catch (error) {
      setMessage({ type: 'error', text: getErrorMessage(error) });
    } finally {
      setLoadingDbs((prev) => {
        const next = new Set(prev);
        next.delete(database);
        return next;
      });
    }
  }, [api, clickhouseId, connectionId, dbTables]);

  const refreshDatabases = useCallback(async () => {
    if (!api?.connections || !clickhouseId) return;

    setSchemaLoading(true);
    setMessage(null);

    try {
      const dbs = await api.connections.clickhouseDatabases(connectionId, clickhouseId);
      const expanded = Array.from(expandedDbs).filter((database) => dbs.includes(database));
      const nextTables: Record<string, ShellDeskClickHouseTable[]> = {};

      for (const database of expanded) {
        nextTables[database] = await api.connections.clickhouseTables(connectionId, clickhouseId, database);
      }

      setDatabases(dbs);
      setExpandedDbs(new Set(expanded));
      setDbTables(nextTables);
      setMessage({ type: 'success', text: tCurrent('clickhouse.notice.metadataRefreshed') });

      if (activeDb && !dbs.includes(activeDb)) {
        setActiveDb(dbs[0] ?? '');
      }
    } catch (error) {
      setMessage({ type: 'error', text: getErrorMessage(error) });
    } finally {
      setSchemaLoading(false);
    }
  }, [activeDb, api, clickhouseId, connectionId, expandedDbs]);

  const handleSecureChange = useCallback((checked: boolean) => {
    setSecure(checked);
    setPort((currentPort) => {
      const trimmed = currentPort.trim();
      if (!trimmed || trimmed === String(defaultHttpPort) || trimmed === String(defaultHttpsPort)) {
        return String(checked ? defaultHttpsPort : defaultHttpPort);
      }
      return currentPort;
    });
  }, []);

  const handleConnect = useCallback(async () => {
    if (!api?.connections) return;

    setStatus('connecting');
    setErrorMessage('');
    setMessage(null);

    let createdClickhouseId = '';
    try {
      const result = await api.connections.clickhouseConnect(connectionId, {
        mode: 'auto',
        host: host || '127.0.0.1',
        port: displayPort,
        user: user || 'default',
        password,
        database: initialDatabase.trim() || undefined,
        secure,
      });

      createdClickhouseId = result.clickhouseId;
      setClickhouseId(result.clickhouseId);
      setStatus('connected');
      void saveRemoteConnectionProfile(hostId, 'clickhouse', {
        host: host || '127.0.0.1',
        port: String(displayPort),
        user: user || 'default',
        password,
        initialDatabase: initialDatabase.trim(),
        secure,
      }).catch(() => undefined);

      const requestedDb = initialDatabase.trim();
      setSchemaLoading(true);
      const [dbs, requestedTables] = await Promise.all([
        api.connections.clickhouseDatabases(connectionId, result.clickhouseId),
        requestedDb
          ? api.connections.clickhouseTables(connectionId, result.clickhouseId, requestedDb).catch(() => [])
          : Promise.resolve(null),
      ]);
      const nextActiveDb = requestedDb && dbs.includes(requestedDb)
        ? requestedDb
        : dbs.includes('default')
          ? 'default'
          : dbs[0] ?? '';
      const nextExpanded = nextActiveDb ? new Set([nextActiveDb]) : new Set<string>();
      const nextTables: Record<string, ShellDeskClickHouseTable[]> = {};

      if (nextActiveDb) {
        nextTables[nextActiveDb] = requestedDb && nextActiveDb === requestedDb && requestedTables
          ? requestedTables
          : await api.connections.clickhouseTables(connectionId, result.clickhouseId, nextActiveDb).catch(() => []);
      }

      setDatabases(dbs);
      setActiveDb(nextActiveDb);
      setExpandedDbs(nextExpanded);
      setDbTables(nextTables);
      setMessage({
        type: 'success',
        text: result.fallbackReason && result.transport === 'ssh-exec'
          ? tCurrent('clickhouse.connection.successWithFallback', {
              transport: describeDatabaseTransport(result.transport),
              user: user || 'default',
              host: host || '127.0.0.1',
              port: displayPort,
              reason: result.fallbackReason,
            })
          : tCurrent('clickhouse.connection.success', {
              transport: describeDatabaseTransport(result.transport),
              user: user || 'default',
              host: host || '127.0.0.1',
              port: displayPort,
            }),
      });
    } catch (error) {
      if (createdClickhouseId) {
        try {
          await api.connections.clickhouseDisconnect(connectionId, createdClickhouseId);
        } catch {
          // ignore cleanup errors after partial connect failure
        }
      }
      if (clickhouseIdRef.current === createdClickhouseId) {
        clickhouseIdRef.current = '';
      }
      setClickhouseId((current) => (current === createdClickhouseId ? '' : current));
      setStatus('error');
      setErrorMessage(getErrorMessage(error));
    } finally {
      setSchemaLoading(false);
    }
  }, [api, connectionId, displayPort, host, hostId, initialDatabase, password, secure, user]);

  const handleDisconnect = useCallback(async () => {
    if (!api?.connections || !clickhouseId) return;

    try {
      await api.connections.clickhouseDisconnect(connectionId, clickhouseId);
    } catch {
      // ignore disconnect errors
    }

    setStatus('disconnected');
    setClickhouseId('');
    resetWorkspaceState();
  }, [api, clickhouseId, connectionId, resetWorkspaceState]);

  const toggleDatabase = useCallback((database: string) => {
    const willExpand = !expandedDbs.has(database);
    const nextExpanded = new Set(expandedDbs);

    if (willExpand) {
      nextExpanded.add(database);
      void loadTables(database);
    } else {
      nextExpanded.delete(database);
    }

    setExpandedDbs(nextExpanded);
    setActiveDb(database);
  }, [expandedDbs, loadTables]);

  const handleRefreshDatabase = useCallback((database: string, event?: React.MouseEvent) => {
    event?.stopPropagation();
    void loadTables(database, true);
  }, [loadTables]);

  const openDatabaseContextMenu = useCallback((event: React.MouseEvent, database: string) => {
    event.preventDefault();
    event.stopPropagation();
    setActiveDb(database);
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      target: { type: 'database', database },
    });
  }, []);

  const openTableContextMenu = useCallback((event: React.MouseEvent, database: string, table: ShellDeskClickHouseTable) => {
    event.preventDefault();
    event.stopPropagation();
    setActiveDb(database);
    setSelectedTable({ ...table, database });
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      target: { type: 'table', database, table },
    });
  }, []);

  const handleAddQueryTab = useCallback((seedSql?: string) => {
    setQueryTabs((prev) => {
      const tab = createQueryTab(prev.length + 1, seedSql ?? '');
      setActiveQueryId(tab.id);
      return [...prev, tab];
    });
  }, []);

  const closeQueryTab = useCallback((queryId: string) => {
    setQueryTabs((prev) => {
      if (prev.length === 1) return prev;

      const removedIndex = prev.findIndex((tab) => tab.id === queryId);
      const next = prev.filter((tab) => tab.id !== queryId);

      if (activeQueryId === queryId) {
        setActiveQueryId(next[Math.max(0, removedIndex - 1)]?.id ?? next[0].id);
      }

      return next;
    });
  }, [activeQueryId]);

  const handleCloseQueryTab = useCallback((queryId: string, event: React.MouseEvent) => {
    event.stopPropagation();
    closeQueryTab(queryId);
  }, [closeQueryTab]);

  const closeResultTab = useCallback((resultId: string) => {
    setResultTabs((prev) => {
      const removedIndex = prev.findIndex((tab) => tab.id === resultId);
      const next = prev.filter((tab) => tab.id !== resultId);

      if (activeResultId === resultId) {
        setActiveResultId(next[Math.max(0, removedIndex - 1)]?.id ?? next[0]?.id ?? '');
      }

      return next;
    });
  }, [activeResultId]);

  const handleCloseResultTab = useCallback((resultId: string, event: React.MouseEvent) => {
    event.stopPropagation();
    closeResultTab(resultId);
  }, [closeResultTab]);

  const handleUseHistory = useCallback((item: ClickHouseHistoryItem) => {
    const tab = createQueryTab(queryTabs.length + 1, item.sql);
    setQueryTabs((prev) => [...prev, tab]);
    setActiveQueryId(tab.id);

    if (item.database) {
      setActiveDb(item.database);
    }
  }, [queryTabs.length]);

  const handleSelectTable = useCallback(async (database: string, table: ShellDeskClickHouseTable) => {
    if (!api?.connections || !clickhouseId) return;

    const tableInfo: TableInfo = { ...table, database };
    const previewSql = `SELECT * FROM ${quoteIdentifier(database, 'clickhouse')}.${quoteIdentifier(table.name, 'clickhouse')} LIMIT ${tablePreviewLimit};`;
    const startTime = performance.now();

    setSelectedTable(tableInfo);
    setActiveDb(database);
    setMessage(null);
    setPage(0);
    setTableColumns([]);
    updateActiveQuerySql(previewSql);

    try {
      const result = await api.connections.clickhouseQuery(connectionId, clickhouseId, previewSql, database);
      const queryTime = Math.round(performance.now() - startTime);

      addResultTab({
        id: createId('result'),
        title: table.name,
        subtitle: `${database} · LIMIT ${tablePreviewLimit}`,
        sql: previewSql,
        database,
        status: 'success',
        result,
        queryTime,
        createdAt: Date.now(),
        table: tableInfo,
        columns: createGenericColumns(result.columns, 'clickhouse'),
      });
      addHistoryItem({
        sql: previewSql,
        database,
        status: 'success',
        queryTime,
        rowCount: result.rowCount ?? result.rows.length,
      });
    } catch (error) {
      const text = getErrorMessage(error);
      setTableColumns([]);
      setMessage({ type: 'error', text });

      addResultTab({
        id: createId('result'),
        title: table.name,
        subtitle: database,
        sql: previewSql,
        database,
        status: 'error',
        error: text,
        queryTime: Math.round(performance.now() - startTime),
        createdAt: Date.now(),
        table: tableInfo,
        columns: [],
      });
    }
  }, [addHistoryItem, addResultTab, api, clickhouseId, connectionId, updateActiveQuerySql]);

  const handleShowDatabaseInfo = useCallback(async (database: string) => {
    if (!api?.connections || !clickhouseId) return;

    const sqlText = [
      'SELECT',
      '  name AS `数据库`,',
      '  engine AS `引擎`,',
      '  data_path AS `数据路径`,',
      '  metadata_path AS `元数据路径`',
      'FROM system.databases',
      `WHERE name = ${quoteClickHouseString(database)};`,
    ].join('\n');
    const startTime = performance.now();

    setActiveDb(database);
    setMessage(null);
    setPage(0);
    updateActiveQuerySql(sqlText);

    try {
      const result = await api.connections.clickhouseQuery(connectionId, clickhouseId, sqlText, database);
      const queryTime = Math.round(performance.now() - startTime);
      addResultTab({
        id: createId('result'),
        title: `${database} 信息`,
        subtitle: database,
        sql: sqlText,
        database,
        status: 'success',
        result,
        queryTime,
        createdAt: Date.now(),
        columns: createGenericColumns(result.columns, 'clickhouse'),
      });
      addHistoryItem({
        sql: sqlText,
        database,
        status: 'success',
        queryTime,
        rowCount: result.rowCount ?? result.rows.length,
      });
    } catch (error) {
      const text = getErrorMessage(error);
      setMessage({ type: 'error', text });
      addResultTab({
        id: createId('result'),
        title: `${database} 信息`,
        subtitle: database,
        sql: sqlText,
        database,
        status: 'error',
        error: text,
        queryTime: Math.round(performance.now() - startTime),
        createdAt: Date.now(),
        columns: [],
      });
    }
  }, [addHistoryItem, addResultTab, api, clickhouseId, connectionId, updateActiveQuerySql]);

  const handleShowTableStructure = useCallback(async (database: string, table: ShellDeskClickHouseTable) => {
    if (!api?.connections || !clickhouseId) return;

    const tableInfo: TableInfo = { ...table, database };
    const sqlText = `DESCRIBE TABLE ${quoteIdentifier(database, 'clickhouse')}.${quoteIdentifier(table.name, 'clickhouse')};`;
    const startTime = performance.now();

    setSelectedTable(tableInfo);
    setActiveDb(database);
    setMessage(null);
    setPage(0);
    updateActiveQuerySql(sqlText);

    try {
      const cols = await api.connections.clickhouseColumns(connectionId, clickhouseId, database, table.name);
      setTableColumns(cols);
      const result: ShellDeskClickHouseQueryResult = {
        columns: ['字段', '类型', '默认类型', '默认表达式', '主键', '排序键', '注释'],
        rows: cols.map((column) => ({
          字段: column.name,
          类型: column.type,
          默认类型: column.defaultKind || '',
          默认表达式: column.defaultExpression || '',
          主键: column.isPrimaryKey ? 'YES' : '',
          排序键: column.isSortingKey ? 'YES' : '',
          注释: column.comment || '',
        })),
        rowCount: cols.length,
      };
      const queryTime = Math.round(performance.now() - startTime);
      addResultTab({
        id: createId('result'),
        title: `${table.name} 结构`,
        subtitle: database,
        sql: sqlText,
        database,
        status: 'success',
        result,
        queryTime,
        createdAt: Date.now(),
        table: tableInfo,
        columns: createGenericColumns(result.columns, 'clickhouse'),
      });
      addHistoryItem({
        sql: sqlText,
        database,
        status: 'success',
        queryTime,
        rowCount: result.rows.length,
      });
    } catch (error) {
      const text = getErrorMessage(error);
      setMessage({ type: 'error', text });
      addResultTab({
        id: createId('result'),
        title: `${table.name} 结构`,
        subtitle: database,
        sql: sqlText,
        database,
        status: 'error',
        error: text,
        queryTime: Math.round(performance.now() - startTime),
        createdAt: Date.now(),
        table: tableInfo,
        columns: [],
      });
    }
  }, [addHistoryItem, addResultTab, api, clickhouseId, connectionId, updateActiveQuerySql]);

  const handleContextMenuAction = useCallback((action: 'database-info' | 'query-table' | 'table-structure') => {
    const target = contextMenu?.target;
    setContextMenu(null);
    if (!target) return;

    if (action === 'database-info' && target.type === 'database') {
      void handleShowDatabaseInfo(target.database);
      return;
    }

    if (target.type !== 'table') return;
    if (action === 'query-table') {
      void handleSelectTable(target.database, target.table);
    } else if (action === 'table-structure') {
      void handleShowTableStructure(target.database, target.table);
    }
  }, [contextMenu, handleSelectTable, handleShowDatabaseInfo, handleShowTableStructure]);

  const handleExecuteSql = useCallback(async (sqlOverride?: string, options: { title?: string } = {}) => {
    const sourceSql = sqlOverride ?? activeQueryTab?.sql ?? '';
    if (!api?.connections || !clickhouseId || !sourceSql.trim()) return;

    const sqlText = sourceSql.trim();
    const database = activeDb || undefined;
    const startTime = performance.now();

    setMessage(null);
    setPage(0);
    setQueryRunning(activeQueryTab.id, true);

    try {
      const result = await api.connections.clickhouseQuery(connectionId, clickhouseId, sqlText, database);
      const queryTime = Math.round(performance.now() - startTime);
      const rowCount = result.rowCount ?? result.rows.length;

      addResultTab({
        id: createId('result'),
        title: options.title ?? (isWriteStatement(sqlText, 'clickhouse') ? tCurrent('clickhouse.query.writeStatement') : formatSqlPreview(sqlText, 28, tCurrent('clickhouse.query.emptySql'))),
        subtitle: database
          ? tCurrent('clickhouse.query.databaseSubtitle', { database })
          : tCurrent('clickhouse.query.noDatabase'),
        sql: sqlText,
        database,
        status: 'success',
        result,
        queryTime,
        createdAt: Date.now(),
        columns: createGenericColumns(result.columns, 'clickhouse'),
      });
      addHistoryItem({
        sql: sqlText,
        database,
        status: 'success',
        queryTime,
        rowCount,
      });

      if (result.columns.length === 0) {
        setMessage({ type: 'success', text: tCurrent('clickhouse.notice.statementExecuted') });
      }
    } catch (error) {
      const queryTime = Math.round(performance.now() - startTime);
      const text = getErrorMessage(error);

      addResultTab({
        id: createId('result'),
        title: tCurrent('clickhouse.query.failed'),
        subtitle: database
          ? tCurrent('clickhouse.query.databaseSubtitle', { database })
          : tCurrent('clickhouse.query.noDatabase'),
        sql: sqlText,
        database,
        status: 'error',
        error: text,
        queryTime,
        createdAt: Date.now(),
        columns: [],
      });
      addHistoryItem({
        sql: sqlText,
        database,
        status: 'error',
        queryTime,
        error: text,
      });
    } finally {
      setQueryRunning(activeQueryTab.id, false);
    }
  }, [activeDb, activeQueryTab, addHistoryItem, addResultTab, api, clickhouseId, connectionId, setQueryRunning]);

  const handleExplainSql = useCallback(() => {
    if (!activeQueryTab?.sql.trim()) return;
    const sourceSql = activeQueryTab.sql.trim();
    if (isWriteStatement(sourceSql, 'clickhouse')) {
      setMessage({ type: 'info', text: 'EXPLAIN 仅用于查询语句，请先选择 SELECT 等只读 SQL。' });
      return;
    }

    void handleExecuteSql(createExplainSql(sourceSql), {
      title: `EXPLAIN ${formatSqlPreview(sourceSql, 20)}`,
    });
  }, [activeQueryTab, handleExecuteSql]);

  const clickHouseEditorExtensions = useMemo<Extension[]>(() => [
    keymap.of([
      indentWithTab,
      {
        key: 'Mod-Enter',
        run: () => {
          void handleExecuteSql();
          return true;
        },
      },
    ]),
    sql({ dialect: MySQL }),
    EditorView.theme({
      '&': {
        height: '100%',
        minHeight: '0',
        backgroundColor: 'var(--surface-elevated)',
        color: 'var(--text)',
        fontSize: '13px',
      },
      '.cm-scroller': {
        backgroundColor: 'var(--surface-elevated)',
        fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, monospace',
        lineHeight: '20px',
      },
      '.cm-content': {
        padding: '10px 0',
        caretColor: 'var(--text)',
      },
      '.cm-line': {
        padding: '0 12px',
      },
      '.cm-gutters': {
        borderRight: '1px solid var(--border)',
        backgroundColor: 'var(--surface)',
        color: 'var(--text-muted)',
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'transparent',
        color: 'var(--accent)',
      },
      '.cm-activeLine': {
        backgroundColor: 'color-mix(in srgb, var(--accent) 8%, transparent)',
      },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
        backgroundColor: 'rgba(67, 199, 255, 0.25)',
      },
      '&.cm-focused': {
        outline: 'none',
      },
    }, {
      dark: editorTheme === 'dark',
    }),
  ], [editorTheme, handleExecuteSql]);

  const handleExportActiveResult = useCallback(async (format: DatabaseExportFormat) => {
    if (!activeResult || activeResult.rows.length === 0) return;

    setMessage(null);

    try {
      const filePath = await exportDatabaseRows({
        sourceName: 'ClickHouse',
        format,
        columns: activeResult.columns,
        rows: activeResult.rows,
        fileBaseName: activeResultTab?.title,
        metadata: {
          database: activeResultTab?.database ?? '',
          sql: activeResultTab?.sql ?? '',
          queryTimeMs: activeResultTab?.queryTime ?? 0,
          statistics: activeResult.statistics ?? null,
        },
      });

      if (filePath) {
        setMessage({ type: 'success', text: tCurrent('clickhouse.notice.exported', { path: filePath }) });
      }
    } catch (error) {
      setMessage({ type: 'error', text: getErrorMessage(error) });
    }
  }, [activeResult, activeResultTab]);

  const handleCellEdit = useCallback((rowIndex: number, column: string, currentValue: unknown) => {
    if (!activeResult || !activeResultTab?.table || !isActiveResultEditable) return;

    if (activeResultPrimaryKeys.includes(column)) {
      setMessage({ type: 'info', text: '主键列不能直接编辑。' });
      return;
    }

    setEditingCell({
      rowIndex,
      column,
      value: currentValue === null || currentValue === undefined ? '' : String(currentValue),
      isNull: currentValue === null || currentValue === undefined,
    });
  }, [activeResult, activeResultPrimaryKeys, activeResultTab, isActiveResultEditable]);

  const prepareCellSave = useCallback(() => {
    if (!editingCell || !activeResultTab?.result || !activeResultTab.table) return;

    const row = activeResultTab.result.rows[editingCell.rowIndex];
    if (!row) {
      setEditingCell(null);
      return;
    }

    const newValue = editingCell.isNull ? null : editingCell.value;

    if (valuesEqual(row[editingCell.column], newValue)) {
      setEditingCell(null);
      return;
    }

    setPendingEdit({
      resultId: activeResultTab.id,
      table: activeResultTab.table,
      rowIndex: editingCell.rowIndex,
      column: editingCell.column,
      oldValue: row[editingCell.column],
      newValue,
      pkColumns: activeResultPrimaryKeys,
      pkValues: activeResultPrimaryKeys.map((pkColumn) => row[pkColumn]),
    });
    setEditingCell(null);
  }, [activeResultPrimaryKeys, activeResultTab, editingCell]);

  const handleConfirmCellSave = useCallback(async () => {
    if (!pendingEdit || !api?.connections || !clickhouseId) return;

    const whereClause = pendingEdit.pkColumns
      .map((pkColumn, index) => `${quoteIdentifier(pkColumn, 'clickhouse')} = ${toClickHouseLiteral(pendingEdit.pkValues[index])}`)
      .join(' AND ');
    const updateSql = [
      `ALTER TABLE ${quoteIdentifier(pendingEdit.table.database, 'clickhouse')}.${quoteIdentifier(pendingEdit.table.name, 'clickhouse')}`,
      `UPDATE ${quoteIdentifier(pendingEdit.column, 'clickhouse')} = ${toClickHouseLiteral(pendingEdit.newValue)}`,
      `WHERE ${whereClause};`,
    ].join('\n');

    setEditSaving(true);
    setMessage(null);

    try {
      await api.connections.clickhouseQuery(connectionId, clickhouseId, updateSql, pendingEdit.table.database);
      setResultTabs((prev) => prev.map((tab) => {
        if (tab.id !== pendingEdit.resultId || !tab.result) return tab;

        const nextRows = [...tab.result.rows];
        nextRows[pendingEdit.rowIndex] = {
          ...nextRows[pendingEdit.rowIndex],
          [pendingEdit.column]: pendingEdit.newValue,
        };

        return {
          ...tab,
          result: {
            ...tab.result,
            rows: nextRows,
          },
        };
      }));
      setMessage({ type: 'success', text: '已提交 ClickHouse 单元格更新。' });
      setPendingEdit(null);
    } catch (error) {
      setMessage({ type: 'error', text: getErrorMessage(error) });
    } finally {
      setEditSaving(false);
    }
  }, [api, clickhouseId, connectionId, pendingEdit]);

  const handleCellKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      prepareCellSave();
    } else if (event.key === 'Escape') {
      setEditingCell(null);
    }
  }, [prepareCellSave]);

  useEffect(() => {
    clickhouseIdRef.current = clickhouseId;
  }, [clickhouseId]);

  useEffect(() => {
    setPage(0);
  }, [activeResultId]);

  useEffect(() => {
    if (isReady) {
      sqlEditorRef.current?.view?.focus();
    }
  }, [activeQueryId, isReady]);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return undefined;
    }

    const observer = new MutationObserver(() => setEditorTheme(getShellDeskEditorTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    return () => observer.disconnect();
  }, []);

  useContextMenu(contextMenu, setContextMenu);

  useEffect(() => {
    return () => {
      const currentClickHouseId = clickhouseIdRef.current;
      if (currentClickHouseId && api?.connections) {
        api.connections.clickhouseDisconnect(connectionId, currentClickHouseId).catch(() => {});
      }
    };
  }, [api, connectionId]);

  if (!isReady) {
    return (
      <div className="clickhouse-scope">
        <div className="mysql-connect-panel">
          <form
            className="mysql-connect-card"
            onSubmit={(event) => {
              event.preventDefault();
              void handleConnect();
            }}
          >
            <div className="mysql-connect-heading">
              <span className="mysql-connect-mark">CH</span>
              <div>
                <h3>{tCurrent('clickhouse.connection.title')}</h3>
                <p className="mysql-connect-hint">{tCurrent('clickhouse.connection.hint')}</p>
              </div>
            </div>
            {errorMessage ? (
              <DismissibleAlert className="mysql-error-banner" onDismiss={() => setErrorMessage('')} role="alert" source="RemoteClickHouse">
                {errorMessage}
              </DismissibleAlert>
            ) : null}
            <div className="mysql-connect-grid">
              <label className="mysql-field">
                <span>{tCurrent('clickhouse.connection.host')}</span>
                <input
                  type="text"
                  value={host}
                  onChange={(event) => setHost(event.target.value)}
                  placeholder="127.0.0.1"
                  disabled={status === 'connecting'}
                />
              </label>
              <label className="mysql-field">
                <span>{tCurrent('clickhouse.connection.httpPort')}</span>
                <input
                  type="text"
                  value={port}
                  onChange={(event) => setPort(event.target.value)}
                  placeholder={secure ? String(defaultHttpsPort) : String(defaultHttpPort)}
                  disabled={status === 'connecting'}
                />
              </label>
            </div>
            <div className="mysql-connect-grid">
              <label className="mysql-field">
                <span>{tCurrent('clickhouse.connection.user')}</span>
                <input
                  type="text"
                  value={user}
                  onChange={(event) => setUser(event.target.value)}
                  placeholder="default"
                  disabled={status === 'connecting'}
                />
              </label>
              <label className="mysql-field">
                <span>{tCurrent('clickhouse.connection.defaultDatabase')}</span>
                <input
                  type="text"
                  value={initialDatabase}
                  onChange={(event) => setInitialDatabase(event.target.value)}
                  placeholder="default"
                  disabled={status === 'connecting'}
                />
              </label>
            </div>
            <label className="mysql-field">
              <span>{tCurrent('clickhouse.connection.password')}</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={tCurrent('clickhouse.connection.optional')}
                disabled={status === 'connecting'}
              />
            </label>
            <label className="clickhouse-toggle">
              <input
                type="checkbox"
                checked={secure}
                onChange={(event) => handleSecureChange(event.target.checked)}
                disabled={status === 'connecting'}
              />
              <span>HTTPS / TLS</span>
            </label>
            <div className="mysql-tunnel-note">
              <span>{tCurrent('clickhouse.connection.remoteTarget')}</span>
              <strong>{secure ? 'https' : 'http'}://{host || '127.0.0.1'}:{displayPort}</strong>
              <em>{tCurrent('clickhouse.connection.remoteTargetHint')}</em>
            </div>
            {isNativeTcpPort ? (
              <div className="clickhouse-port-warning" role="status">
                {tCurrent('clickhouse.connection.nativePortWarning')}
              </div>
            ) : null}
            <button
              type="submit"
              className="mysql-connect-btn"
              disabled={status === 'connecting'}
            >
              {status === 'connecting' ? tCurrent('clickhouse.connection.connecting') : tCurrent('clickhouse.connection.connect')}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="clickhouse-scope">
      <div className="mysql-layout">
        <aside className="mysql-sidebar">
          <div className="mysql-sidebar-header">
            <div>
              <strong>{tCurrent('clickhouse.ui.objectBrowser')}</strong>
              <span>{tCurrent('clickhouse.ui.databaseCount', { count: databases.length })}</span>
            </div>
            <button type="button" onClick={() => void refreshDatabases()} disabled={schemaLoading} title={tCurrent('clickhouse.ui.refreshDatabasesTitle')}>
              {schemaLoading ? '...' : '↻'}
            </button>
          </div>
          <div className="mysql-object-search">
            <input
              type="search"
              value={objectSearch}
              onChange={(event) => setObjectSearch(event.target.value)}
              placeholder={tCurrent('clickhouse.ui.searchPlaceholder')}
              spellCheck={false}
            />
            {objectSearch ? (
              <button type="button" onClick={() => setObjectSearch('')} title={tCurrent('clickhouse.ui.clearSearchTitle')}>×</button>
            ) : null}
          </div>
          <div className="mysql-tree">
            {filteredDatabases.map(({ database, tables, databaseMatched }) => {
              const expanded = expandedDbs.has(database);
              const loading = loadingDbs.has(database);
              const visibleTables = objectSearch.trim() && !databaseMatched ? tables : dbTables[database] ?? [];

              return (
                <div key={database} className="mysql-tree-db">
                  <button
                    type="button"
                    className={`mysql-tree-db-btn ${expanded ? 'expanded' : ''} ${activeDb === database ? 'active' : ''}`}
                    onClick={() => toggleDatabase(database)}
                    onContextMenu={(event) => openDatabaseContextMenu(event, database)}
                  >
                    <span className="mysql-tree-arrow">{expanded ? '▾' : '▸'}</span>
                    <span className="mysql-tree-icon">DB</span>
                    <span className="mysql-tree-name">{database}</span>
                    <span className="mysql-tree-count">{dbTables[database]?.length ?? '-'}</span>
                    <span
                      role="button"
                      tabIndex={0}
                      className="mysql-tree-refresh"
                      title={tCurrent('clickhouse.ui.refreshDatabaseTitle')}
                      onClick={(event) => handleRefreshDatabase(database, event)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.stopPropagation();
                          handleRefreshDatabase(database);
                        }
                      }}
                    >
                      ↻
                    </span>
                  </button>
                  {expanded ? (
                    <div className="mysql-tree-tables">
                      {loading ? <div className="mysql-tree-loading">{tCurrent('clickhouse.ui.loadingTables')}</div> : null}
                      {!loading && visibleTables.map((table) => {
                        const tableMeta = [table.engine, formatCount(table.totalRows)].filter((value) => value && value !== '-').join(' · ');
                        return (
                          <div key={table.name}>
                            <button
                              type="button"
                              className={`mysql-tree-table-btn ${selectedTable?.database === database && selectedTable.name === table.name ? 'selected' : ''}`}
                              onClick={() => void handleSelectTable(database, table)}
                              onContextMenu={(event) => openTableContextMenu(event, database, table)}
                              title={tableMeta || table.name}
                            >
                              <span className="mysql-tree-icon">T</span>
                              <span className="mysql-tree-name">{table.name}</span>
                              {table.engine ? <span className="clickhouse-table-engine">{table.engine}</span> : null}
                            </button>
                          </div>
                        );
                      })}
                      {!loading && dbTables[database] !== undefined && visibleTables.length === 0 ? (
                        <div className="mysql-tree-empty">{tCurrent('clickhouse.ui.noMatchedTables')}</div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
            {filteredDatabases.length === 0 ? <div className="mysql-tree-empty">{tCurrent('clickhouse.ui.noMatchedObjects')}</div> : null}
          </div>
          <div className="mysql-history">
            <div className="mysql-history-title">
              <strong>{tCurrent('clickhouse.ui.history')}</strong>
              <span>{history.length}</span>
            </div>
            <div className="mysql-history-list">
              {history.length === 0 ? (
                <div className="mysql-history-empty">{tCurrent('clickhouse.ui.noHistory')}</div>
              ) : history.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`mysql-history-item ${item.status}`}
                  onClick={() => handleUseHistory(item)}
                  title={item.sql}
                >
                  <span className="mysql-history-sql">{formatSqlPreview(item.sql, 34, tCurrent('clickhouse.query.emptySql'))}</span>
                  <span className="mysql-history-meta">
                    {formatTimestamp(item.createdAt)}
                    {item.status === 'success'
                      ? tCurrent('clickhouse.query.historyRows', { count: formatCount(item.rowCount ?? 0) })
                      : tCurrent('clickhouse.query.historyFailed')}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </aside>

        <main className="mysql-main">
          <div className="mysql-topbar">
            <div className="mysql-connection-summary">
              <span className="mysql-status-dot" />
              <strong>{user || 'default'}@{host || '127.0.0.1'}:{displayPort}</strong>
              <span>{tCurrent('clickhouse.connection.id', { id: connectionId.slice(0, 8) })}</span>
            </div>
            <div className="mysql-topbar-actions">
              <span className="mysql-active-db">{tCurrent('clickhouse.query.currentDatabase', { database: activeDb || tCurrent('clickhouse.query.noDatabaseSelected') })}</span>
              <button type="button" className="mysql-disconnect-btn" onClick={() => void handleDisconnect()} title={tCurrent('clickhouse.connection.disconnectTitle')}>
                {tCurrent('clickhouse.connection.disconnect')}
              </button>
            </div>
          </div>

          <section className="mysql-editor-area">
            <div className="mysql-query-tabs" role="tablist" aria-label={tCurrent('clickhouse.query.tabsAria')}>
              {queryTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={activeQueryId === tab.id}
                  className={`mysql-query-tab ${activeQueryId === tab.id ? 'active' : ''}`}
                  onClick={() => setActiveQueryId(tab.id)}
                >
                  <span>{tab.title}</span>
                  {tab.running ? <em>{tCurrent('clickhouse.query.running')}</em> : null}
                  {queryTabs.length > 1 ? (
                    <span
                      role="button"
                      tabIndex={0}
                      className="mysql-tab-close"
                      onClick={(event) => handleCloseQueryTab(tab.id, event)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.stopPropagation();
                          closeQueryTab(tab.id);
                        }
                      }}
                    >
                      ×
                    </span>
                  ) : null}
                </button>
              ))}
              <button type="button" className="mysql-add-tab-btn" onClick={() => handleAddQueryTab()} title={tCurrent('clickhouse.query.addTitle')}>+</button>
            </div>
            <div className="mysql-editor-toolbar">
              <button
                type="button"
                className="mysql-run-btn"
                onClick={() => void handleExecuteSql()}
                disabled={!canRunActiveQuery}
              >
                {activeQueryTab?.running ? tCurrent('clickhouse.query.runningButton') : tCurrent('clickhouse.query.run')}
              </button>
              <button
                type="button"
                className="mysql-explain-btn"
                onClick={handleExplainSql}
                disabled={!canExplainActiveQuery}
              >
                EXPLAIN
              </button>
              <span className="mysql-editor-hint">Ctrl/⌘ + Enter</span>
              <select
                className="mysql-db-select"
                value={activeDb}
                onChange={(event) => setActiveDb(event.target.value)}
                title={tCurrent('clickhouse.query.defaultDatabaseTitle')}
              >
                <option value="">{tCurrent('clickhouse.query.noDatabaseSelected')}</option>
                {databases.map((database) => (
                  <option key={database} value={database}>{database}</option>
                ))}
              </select>
            </div>
            <CodeMirror
              ref={sqlEditorRef}
              className="mysql-sql-editor"
              value={activeQueryTab?.sql ?? ''}
              height="100%"
              basicSetup={{
                lineNumbers: true,
                foldGutter: true,
                highlightActiveLine: true,
                highlightActiveLineGutter: true,
                bracketMatching: true,
                closeBrackets: true,
                autocompletion: true,
                searchKeymap: true,
                defaultKeymap: true,
                history: true,
              }}
              theme={editorTheme}
              extensions={clickHouseEditorExtensions}
              onChange={updateActiveQuerySql}
              placeholder="SELECT * FROM system.tables LIMIT 20;"
              aria-label="ClickHouse SQL"
            />
          </section>

          <section className="mysql-result-area">
            {message ? (
              <DismissibleAlert
                className={`mysql-message-banner ${message.type}`}
                onDismiss={() => setMessage(null)}
                role={message.type === 'error' ? 'alert' : 'status'}
                source="RemoteClickHouse"
              >
                {message.text}
              </DismissibleAlert>
            ) : null}
            <div className="mysql-result-tabs">
              {resultTabs.length === 0 ? (
                <span className="mysql-result-tabs-empty">{tCurrent('clickhouse.query.resultPlaceholder')}</span>
              ) : resultTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className={`mysql-result-tab ${activeResultId === tab.id ? 'active' : ''} ${tab.status}`}
                  onClick={() => setActiveResultId(tab.id)}
                  title={tab.sql}
                >
                  <span>{tab.title}</span>
                  <em>{tab.status === 'success' && tab.result ? describeResult(tab.result) : tCurrent('clickhouse.query.resultError')}</em>
                  <span
                    role="button"
                    tabIndex={0}
                    className="mysql-tab-close"
                    onClick={(event) => handleCloseResultTab(tab.id, event)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.stopPropagation();
                        closeResultTab(tab.id);
                      }
                    }}
                  >
                    ×
                  </span>
                </button>
              ))}
            </div>

            {!activeResultTab ? (
              <div className="mysql-result-placeholder">
                <strong>{tCurrent('clickhouse.query.selectOrRun')}</strong>
                <span>{tCurrent('clickhouse.query.previewLimit', { count: tablePreviewLimit })}</span>
              </div>
            ) : activeResultTab.status === 'error' ? (
              <div className="mysql-result-error-panel">
                <strong>{tCurrent('clickhouse.query.executionFailed')}</strong>
                <code>{formatSqlPreview(activeResultTab.sql, 120, tCurrent('clickhouse.query.emptySql'))}</code>
                <p>{activeResultTab.error}</p>
                <span>{activeResultTab.queryTime}ms · {formatTimestamp(activeResultTab.createdAt)}</span>
              </div>
            ) : activeResult ? (
              <>
                <div className="mysql-result-info">
                  <span>{describeResult(activeResult)}</span>
                  <span>{activeResultTab.queryTime}ms</span>
                  <span>{activeResultTab.subtitle}</span>
                  {describeStatistics(activeResult.statistics) ? <span>{describeStatistics(activeResult.statistics)}</span> : null}
                  <span>{activeResultTab.table
                    ? isActiveResultEditable ? `双击单元格编辑 · 主键 ${activeResultPrimaryKeys.join(', ')}` : tCurrent('clickhouse.query.readonlyTable')
                    : tCurrent('clickhouse.query.readonlyResult')}</span>
                  <div className="database-export-actions" aria-label={tCurrent('clickhouse.query.exportAria')}>
                    <button type="button" className="database-export-button" onClick={() => void handleExportActiveResult('json')} disabled={activeResult.rows.length === 0}>{tCurrent('clickhouse.query.exportJson')}</button>
                    <button type="button" className="database-export-button" onClick={() => void handleExportActiveResult('csv')} disabled={activeResult.rows.length === 0}>{tCurrent('clickhouse.query.exportCsv')}</button>
                  </div>
                </div>
                {activeResult.columns.length > 0 ? (
                  <>
                    <div className="mysql-table-wrapper">
                      <table className="mysql-data-table">
                        <thead>
                          <tr>
                            <th className="mysql-row-num">#</th>
                            {activeResult.columns.map((column) => {
                              const meta = getColumnMeta(activeResultColumns, column);
                              const badge = getColumnBadge(meta);
                              const activeSort = sortState?.resultId === activeResultTab.id && sortState.column === column ? sortState.direction : null;
                              return (
                                <th key={column}>
                                  <button
                                    type="button"
                                    className={`mysql-sort-btn ${activeSort ?? ''}`}
                                    onClick={() => {
                                      setSortState((current) => (
                                        current?.resultId === activeResultTab.id && current.column === column && current.direction === 'asc'
                                          ? { resultId: activeResultTab.id, column, direction: 'desc' }
                                          : { resultId: activeResultTab.id, column, direction: 'asc' }
                                      ));
                                      setPage(0);
                                    }}
                                    title="排序"
                                  >
                                    <span className="mysql-col-name">{column}</span>
                                    <span className="mysql-sort-indicator">{activeSort === 'asc' ? '▲' : activeSort === 'desc' ? '▼' : '↕'}</span>
                                  </button>
                                  {badge ? <span className="mysql-col-key">{badge}</span> : null}
                                  {meta?.type ? <small>{meta.type}</small> : null}
                                </th>
                              );
                            })}
                          </tr>
                        </thead>
                        <tbody>
                          {pagedRows.map(({ row, sourceIndex }, rowIdx) => {
                            const globalRowIdx = page * pageSize + rowIdx;

                            return (
                              <tr key={sourceIndex}>
                                <td className="mysql-row-num">{globalRowIdx + 1}</td>
                                {activeResult.columns.map((column) => {
                                  const cellValue = row[column];
                                  const isEditing = editingCell?.rowIndex === sourceIndex && editingCell.column === column;
                                  const isEditableColumn = isActiveResultEditable && !activeResultPrimaryKeys.includes(column);

                                  return isEditing ? (
                                    <td key={column} className="mysql-cell-editing">
                                      <div className="mysql-cell-editbox">
                                        <input
                                          type="text"
                                          value={editingCell.isNull ? '' : editingCell.value}
                                          onChange={(event) => setEditingCell((current) => current ? { ...current, value: event.target.value, isNull: false } : current)}
                                          onBlur={prepareCellSave}
                                          onKeyDown={handleCellKeyDown}
                                          autoFocus
                                          className="mysql-cell-input"
                                          readOnly={editingCell.isNull}
                                        />
                                        <button
                                          type="button"
                                          className={`mysql-cell-null-toggle ${editingCell.isNull ? 'active' : ''}`}
                                          onMouseDown={(event) => event.preventDefault()}
                                          onClick={() => setEditingCell((current) => current ? { ...current, isNull: !current.isNull } : current)}
                                        >
                                          NULL
                                        </button>
                                      </div>
                                    </td>
                                  ) : (
                                    <td
                                      key={column}
                                      className={`${cellValue === null ? 'mysql-cell-null' : ''} ${isEditableColumn ? 'mysql-cell-editable' : ''}`}
                                      onDoubleClick={() => handleCellEdit(sourceIndex, column, cellValue)}
                                      title={cellValue === null ? 'NULL' : formatCellValue(cellValue)}
                                    >
                                      {cellValue === null ? <em>NULL</em> : formatCellValue(cellValue)}
                                    </td>
                                  );
                                })}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    {totalPages > 1 ? (
                      <div className="mysql-pagination">
                        <button type="button" disabled={page === 0} onClick={() => setPage(0)}>{tCurrent('clickhouse.query.firstPage')}</button>
                        <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>{tCurrent('clickhouse.query.previousPage')}</button>
                        <span>{page + 1} / {totalPages}</span>
                        <button type="button" disabled={page >= totalPages - 1} onClick={() => setPage(page + 1)}>{tCurrent('clickhouse.query.nextPage')}</button>
                        <button type="button" disabled={page >= totalPages - 1} onClick={() => setPage(totalPages - 1)}>{tCurrent('clickhouse.query.lastPage')}</button>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className="mysql-result-empty">
                    <strong>{tCurrent('clickhouse.query.noResultTitle')}</strong>
                    <span>{tCurrent('clickhouse.query.noResultDescription')}</span>
                  </div>
                )}
              </>
            ) : null}
          </section>
        </main>
      </div>
      {pendingEdit ? createPortal(
        <div className="mysql-modal-backdrop" role="presentation">
          <div className="mysql-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="clickhouse-edit-title">
            <div className="mysql-edit-dialog-header">
              <strong id="clickhouse-edit-title">确认更新单元格</strong>
              <span>{pendingEdit.table.database}.{pendingEdit.table.name}</span>
            </div>
            <div className="mysql-edit-summary">
              <div>
                <span>列</span>
                <strong>{pendingEdit.column}</strong>
              </div>
              <div>
                <span>原值</span>
                <code>{formatCellValue(pendingEdit.oldValue)}</code>
              </div>
              <div>
                <span>新值</span>
                <code>{formatCellValue(pendingEdit.newValue)}</code>
              </div>
              <div>
                <span>条件</span>
                <code>{pendingEdit.pkColumns.map((pkColumn, index) => `${pkColumn}=${formatCellValue(pendingEdit.pkValues[index])}`).join(' AND ')}</code>
              </div>
            </div>
            <p className="mysql-edit-warning">ClickHouse 更新会异步 mutation，实际落盘和查询可见时间由服务端决定。</p>
            <div className="mysql-edit-actions">
              <button type="button" onClick={() => setPendingEdit(null)} disabled={editSaving}>取消</button>
              <button type="button" className="primary" onClick={() => void handleConfirmCellSave()} disabled={editSaving}>
                {editSaving ? '保存中...' : '确认保存'}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}

      {contextMenu ? createPortal(
        <div
          className="mysql-context-menu"
          style={{
            left: Math.min(contextMenu.x, window.innerWidth - 220),
            top: Math.min(contextMenu.y, window.innerHeight - 140),
          }}
          role="menu"
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div className="mysql-context-menu-title">
            <strong>{contextMenu.target.type === 'database' ? contextMenu.target.database : contextMenu.target.table.name}</strong>
            <span>{contextMenu.target.type === 'database' ? '数据库' : contextMenu.target.database}</span>
          </div>
          {contextMenu.target.type === 'database' ? (
            <button type="button" role="menuitem" onClick={() => handleContextMenuAction('database-info')}>查看数据库信息</button>
          ) : (
            <>
              <button type="button" role="menuitem" onClick={() => handleContextMenuAction('query-table')}>查询数据</button>
              <button type="button" role="menuitem" onClick={() => handleContextMenuAction('table-structure')}>查看表结构</button>
            </>
          )}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

export default RemoteClickHouse;
