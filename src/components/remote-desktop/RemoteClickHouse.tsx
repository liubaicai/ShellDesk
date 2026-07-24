import { MySQL, sql } from '@codemirror/lang-sql';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { type ChangeEvent, type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { getErrorMessage } from './desktopUtils';
import { createDatabaseEditorExtensions } from './databaseEditorExtensions';
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
import {
  buildClickHouseInsertSql,
  type ChCreateTableState,
  type ChSchemaColumn,
  clickHouseCodecs,
  clickHouseColumnTypes,
  type ClickHouseConnectionForm,
  type ClickHouseContextMenuState,
  type ClickHouseDatabaseDialogState,
  type ClickHouseEditingCell,
  clickHouseEngines,
  type ClickHouseHistoryItem,
  type ClickHouseMessage,
  type ClickHousePendingEdit,
  type ClickHouseQueryTab,
  type ClickHouseResultTab,
  type ClickHouseRowEntry,
  type ClickHouseSortState,
  type ClickHouseStatus,
  compareClickHouseCellValues,
  createChCreateTableState,
  createChSchemaColumn,
  createExplainSql,
  createInitialQueryState,
  createQueryTab,
  decodeImportTarget,
  defaultHttpPort,
  defaultHttpsPort,
  describeResult,
  describeStatistics,
  encodeImportTarget,
  formatCount,
  generateClickHouseAlterStatements,
  generateClickHouseCreateTableSql,
  getColumnBadge,
  getColumnMeta,
  getShellDeskEditorTheme,
  type ImportDataState,
  importEditorTarget,
  isProtectedClickHouseDatabase,
  maxHistoryItems,
  maxResultTabs,
  pageSize,
  parseClickHouseCreateTableSql,
  parseImportCsv,
  parseImportJson,
  quoteClickHouseString,
  type RemoteClickHouseProps,
  type TableInfo,
  tablePreviewLimit,
  toClickHouseLiteral,
  validateChCreateTableState,
  valuesEqual,
} from './clickHouseWorkbenchModel';

function RemoteClickHouse({ connectionId, hostId }: RemoteClickHouseProps) {
  const api = window.guiSSH;
  const initialQueryStateRef = useRef(createInitialQueryState());
  const clickhouseIdRef = useRef('');
  const sqlEditorRef = useRef<ReactCodeMirrorRef>(null);
  const importPreviousFocusRef = useRef<Element | null>(null);
  const importFileInputRef = useRef<HTMLInputElement | null>(null);

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
  const [, setTableColumns] = useState<ShellDeskClickHouseColumn[]>([]);
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
  const [databaseDialog, setDatabaseDialog] = useState<ClickHouseDatabaseDialogState>({
    open: false,
    mode: 'create',
    name: '',
    target: '',
    executing: false,
    error: '',
  });
  const [createTableState, setCreateTableState] = useState<ChCreateTableState>(createChCreateTableState);
  const [importDataState, setImportDataState] = useState<ImportDataState>({
    open: false,
    mode: 'csv',
    targetTable: '',
    csvText: '',
    jsonText: '',
    preview: [],
    columns: [],
    executing: false,
    progress: null,
    error: '',
  });

  const isReady = status === 'connected';
  const activeQueryTab = useMemo(() => {
    return queryTabs.find((tab) => tab.id === activeQueryId) ?? queryTabs[0];
  }, [activeQueryId, queryTabs]);

  const activeResultTab = useMemo(() => {
    return resultTabs.find((tab) => tab.id === activeResultId) ?? null;
  }, [activeResultId, resultTabs]);

  const activeResult = activeResultTab?.result ?? null;
  const activeResultColumns = activeResultTab?.columns ?? [];
  const importTargetTables = useMemo(() => (
    Object.entries(dbTables).flatMap(([database, tables]) => (
      tables.map((table) => ({
        database,
        name: table.name,
        value: encodeImportTarget(database, table.name),
        label: `${database}.${table.name}`,
      }))
    ))
  ), [dbTables]);
  const activeResultPrimaryKeys = useMemo(() => {
    return activeResultColumns.filter((column) => column.isPrimaryKey).map((column) => column.name);
  }, [activeResultColumns]);
  const isActiveResultEditable = Boolean(activeResultTab?.table && activeResultPrimaryKeys.length > 0);
  const canRunActiveQuery = Boolean(activeQueryTab?.sql.trim()) && !activeQueryTab?.running;
  const canExplainActiveQuery = canRunActiveQuery && !isWriteStatement(activeQueryTab?.sql.trim() ?? '', 'clickhouse');
  const displayPort = parseInt(port, 10) || (secure ? defaultHttpsPort : defaultHttpPort);
  const isNativeTcpPort = displayPort === 9000;
  const createTableSqlPreview = useMemo(() => (
    createTableState.mode === 'edit' && createTableState.original
      ? generateClickHouseAlterStatements(createTableState.original, createTableState).join('\n')
      : generateClickHouseCreateTableSql(createTableState, activeDb)
  ), [activeDb, createTableState]);

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
    setDatabaseDialog({
      open: false,
      mode: 'create',
      name: '',
      target: '',
      executing: false,
      error: '',
    });
    setCreateTableState(createChCreateTableState());
    setImportDataState((current) => ({ ...current, open: false, executing: false, progress: null, error: '' }));
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

  const openCreateDatabaseDialog = useCallback(() => {
    setDatabaseDialog({
      open: true,
      mode: 'create',
      name: '',
      target: '',
      executing: false,
      error: '',
    });
  }, []);

  const closeDatabaseDialog = useCallback(() => {
    setDatabaseDialog((current) => ({ ...current, open: false, executing: false, error: '' }));
  }, []);

  const openCreateTableDialog = useCallback(() => {
    setCreateTableState({
      ...createChCreateTableState(),
      open: true,
    });
  }, []);

  const closeCreateTableDialog = useCallback(() => {
    setCreateTableState((current) => current.executing ? current : { ...current, open: false, dialogError: '' });
  }, []);

  const handleExecuteCreateDatabase = useCallback(async () => {
    if (!api?.connections || !clickhouseId) return;

    const database = databaseDialog.name.trim();
    if (!database) {
      setDatabaseDialog((current) => ({ ...current, error: tCurrent('auto.remoteClickHouse.pleaseFillDatabaseName') }));
      return;
    }

    const sqlText = `CREATE DATABASE ${quoteIdentifier(database, 'clickhouse')};`;
    const startTime = performance.now();

    setDatabaseDialog((current) => ({ ...current, executing: true, error: '' }));
    setMessage(null);

    try {
      const result = await api.connections.clickhouseQuery(connectionId, clickhouseId, sqlText);
      const queryTime = Math.round(performance.now() - startTime);
      const dbs = await api.connections.clickhouseDatabases(connectionId, clickhouseId);

      setDatabases(dbs);
      setActiveDb(database);
      setExpandedDbs((current) => {
        const next = new Set(Array.from(current).filter((item) => dbs.includes(item)));
        if (dbs.includes(database)) next.add(database);
        return next;
      });
      setDbTables((current) => {
        const next: Record<string, ShellDeskClickHouseTable[]> = {};
        Object.entries(current).forEach(([item, tables]) => {
          if (dbs.includes(item)) next[item] = tables;
        });
        if (dbs.includes(database)) next[database] = next[database] ?? [];
        return next;
      });
      if (dbs.includes(database)) {
        await loadTables(database, true);
      }

      addResultTab({
        id: createId('result'),
        title: database,
        subtitle: tCurrent('auto.remoteClickHouse.createDatabase'),
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
      setDatabaseDialog((current) => ({ ...current, open: false, executing: false, error: '' }));
      setMessage({ type: 'success', text: tCurrent('auto.remoteClickHouse.databaseCreated', { database }) });
    } catch (error) {
      const text = getErrorMessage(error);
      const queryTime = Math.round(performance.now() - startTime);
      addHistoryItem({
        sql: sqlText,
        database,
        status: 'error',
        queryTime,
        error: text,
      });
      setDatabaseDialog((current) => ({
        ...current,
        executing: false,
        error: tCurrent('auto.remoteClickHouse.createDatabaseFailed', { error: text }),
      }));
    }
  }, [addHistoryItem, addResultTab, api, clickhouseId, connectionId, databaseDialog.name, loadTables]);

  const handleExecuteDropDatabase = useCallback(async () => {
    if (!api?.connections || !clickhouseId) return;

    const database = databaseDialog.target.trim();
    if (!database) {
      setDatabaseDialog((current) => ({ ...current, error: tCurrent('auto.remoteClickHouse.pleaseSelectDatabase') }));
      return;
    }
    if (isProtectedClickHouseDatabase(database)) {
      setDatabaseDialog((current) => ({ ...current, error: tCurrent('auto.remoteClickHouse.protectedDatabase') }));
      return;
    }

    const sqlText = `DROP DATABASE ${quoteIdentifier(database, 'clickhouse')};`;
    const startTime = performance.now();
    const contextDatabase = databases.find((item) => item !== database) ?? 'system';

    setDatabaseDialog((current) => ({ ...current, executing: true, error: '' }));
    setMessage(null);

    try {
      const result = await api.connections.clickhouseQuery(connectionId, clickhouseId, sqlText, contextDatabase);
      const queryTime = Math.round(performance.now() - startTime);
      const dbs = await api.connections.clickhouseDatabases(connectionId, clickhouseId);

      setDatabases(dbs);
      setExpandedDbs((current) => new Set(Array.from(current).filter((item) => dbs.includes(item))));
      setDbTables((current) => {
        const next: Record<string, ShellDeskClickHouseTable[]> = {};
        Object.entries(current).forEach(([item, tables]) => {
          if (dbs.includes(item)) next[item] = tables;
        });
        return next;
      });
      setActiveDb((current) => {
        if (current && dbs.includes(current) && current !== database) return current;
        return dbs.includes('default') ? 'default' : dbs[0] ?? '';
      });
      setSelectedTable((current) => (current?.database === database ? null : current));
      if (selectedTable?.database === database) {
        setTableColumns([]);
      }

      addResultTab({
        id: createId('result'),
        title: database,
        subtitle: tCurrent('auto.remoteClickHouse.dropDatabase'),
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
      setDatabaseDialog((current) => ({ ...current, open: false, executing: false, error: '' }));
      setMessage({ type: 'success', text: tCurrent('auto.remoteClickHouse.databaseDropped', { database }) });
    } catch (error) {
      const text = getErrorMessage(error);
      const queryTime = Math.round(performance.now() - startTime);
      addHistoryItem({
        sql: sqlText,
        database,
        status: 'error',
        queryTime,
        error: text,
      });
      setDatabaseDialog((current) => ({
        ...current,
        executing: false,
        error: tCurrent('auto.remoteClickHouse.dropDatabaseFailed', { error: text }),
      }));
    }
  }, [
    addHistoryItem,
    addResultTab,
    api,
    clickhouseId,
    connectionId,
    databaseDialog.target,
    databases,
    selectedTable,
  ]);

  const refreshImportPreview = useCallback((mode: ImportDataState['mode'], text: string) => {
    if (!text.trim()) {
      setImportDataState((current) => ({ ...current, preview: [], columns: [] }));
      return;
    }

    try {
      const parsed = mode === 'csv' ? parseImportCsv(text) : parseImportJson(text);
      setImportDataState((current) => ({ ...current, preview: parsed.preview, columns: parsed.columns }));
    } catch {
      setImportDataState((current) => ({ ...current, preview: [], columns: [] }));
    }
  }, []);

  const openImportDialog = useCallback(() => {
    const targetTable = selectedTable
      ? encodeImportTarget(selectedTable.database, selectedTable.name)
      : activeResultTab?.table
        ? encodeImportTarget(activeResultTab.table.database, activeResultTab.table.name)
        : activeDb && dbTables[activeDb]?.[0]
          ? encodeImportTarget(activeDb, dbTables[activeDb][0].name)
          : '';
    const database = selectedTable?.database || activeResultTab?.table?.database || activeDb || databases[0] || '';

    importPreviousFocusRef.current = typeof document === 'undefined' ? null : document.activeElement;
    if (database) {
      setActiveDb(database);
      void loadTables(database);
    }
    setImportDataState((current) => ({
      ...current,
      open: true,
      targetTable,
      executing: false,
      progress: null,
      error: '',
    }));
  }, [activeDb, activeResultTab, databases, dbTables, loadTables, selectedTable]);

  const closeImportDialog = useCallback(() => {
    setImportDataState((current) => current.executing ? current : { ...current, open: false, progress: null, error: '' });
  }, []);

  const updateImportText = useCallback((mode: ImportDataState['mode'], text: string) => {
    setImportDataState((current) => ({
      ...current,
      mode,
      csvText: mode === 'csv' ? text : current.csvText,
      jsonText: mode === 'json' ? text : current.jsonText,
      progress: null,
      error: '',
    }));
    refreshImportPreview(mode, text);
  }, [refreshImportPreview]);

  const handleImportFileSelected = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      const mode: ImportDataState['mode'] = file.name.endsWith('.json') ? 'json' : 'csv';
      setImportDataState((current) => ({
        ...current,
        mode,
        csvText: mode === 'csv' ? text : current.csvText,
        jsonText: mode === 'json' ? text : current.jsonText,
        progress: null,
        error: '',
      }));
      refreshImportPreview(mode, text);
    };
    reader.readAsText(file);

    event.target.value = '';
  }, [refreshImportPreview]);

  const updateImportMode = useCallback((mode: ImportDataState['mode']) => {
    setImportDataState((current) => ({ ...current, mode, progress: null, error: '' }));
    refreshImportPreview(mode, mode === 'csv' ? importDataState.csvText : importDataState.jsonText);
  }, [importDataState.csvText, importDataState.jsonText, refreshImportPreview]);

  const getImportTargetTable = useCallback(() => {
    if (importDataState.targetTable === importEditorTarget) {
      const table = selectedTable ?? activeResultTab?.table ?? null;
      return table ? { database: table.database, table: table.name, display: `${table.database}.${table.name}` } : null;
    }

    const decoded = decodeImportTarget(importDataState.targetTable);
    return decoded ? { ...decoded, display: `${decoded.database}.${decoded.table}` } : null;
  }, [activeResultTab, importDataState.targetTable, selectedTable]);

  const handleExecuteImport = useCallback(async () => {
    if (!api?.connections || !clickhouseId) return;

    const target = getImportTargetTable();
    const text = importDataState.mode === 'csv' ? importDataState.csvText : importDataState.jsonText;

    if (!target) {
      setImportDataState((current) => ({ ...current, error: tCurrent('auto.remoteClickHouse.importNoTable') }));
      return;
    }
    if (!text.trim()) {
      setImportDataState((current) => ({ ...current, error: tCurrent('auto.remoteClickHouse.importNoData') }));
      return;
    }

    let parsed: { columns: string[]; rows: Record<string, unknown>[]; preview: Record<string, string>[] };
    try {
      parsed = importDataState.mode === 'csv' ? parseImportCsv(text) : parseImportJson(text);
    } catch (error) {
      setImportDataState((current) => ({
        ...current,
        error: tCurrent('auto.remoteClickHouse.importParseError', { error: getErrorMessage(error) }),
      }));
      return;
    }

    if (parsed.columns.length === 0 || parsed.rows.length === 0) {
      setImportDataState((current) => ({ ...current, error: tCurrent('auto.remoteClickHouse.importNoData') }));
      return;
    }

    const batchSize = parsed.rows.length > 50 ? 100 : parsed.rows.length;
    const startTime = performance.now();
    let importedRows = 0;
    let lastResult: ShellDeskClickHouseQueryResult = { columns: [], rows: [], rowCount: 0 };
    const sqlStatements: string[] = [];

    setMessage(null);
    setImportDataState((current) => ({
      ...current,
      executing: true,
      progress: { current: 0, total: parsed.rows.length },
      preview: parsed.preview,
      columns: parsed.columns,
      error: '',
    }));

    try {
      for (let index = 0; index < parsed.rows.length; index += batchSize) {
        const batch = parsed.rows.slice(index, index + batchSize);
        const sqlText = buildClickHouseInsertSql(target.database, target.table, parsed.columns, batch);
        sqlStatements.push(sqlText);
        lastResult = await api.connections.clickhouseQuery(connectionId, clickhouseId, sqlText, target.database);
        importedRows += batch.length;
        setImportDataState((current) => ({ ...current, progress: { current: importedRows, total: parsed.rows.length } }));
      }

      const queryTime = Math.round(performance.now() - startTime);
      const result: ShellDeskClickHouseQueryResult = { ...lastResult, rowCount: importedRows };
      addResultTab({
        id: createId('result'),
        title: target.table,
        subtitle: tCurrent('clickhouse.query.databaseSubtitle', { database: target.database }),
        sql: sqlStatements.join('\n'),
        database: target.database,
        status: 'success',
        result,
        queryTime,
        createdAt: Date.now(),
        table: { database: target.database, name: target.table, engine: '', totalRows: null, totalBytes: null },
        columns: createGenericColumns(result.columns, 'clickhouse'),
      });
      addHistoryItem({
        sql: sqlStatements.join('\n'),
        database: target.database,
        status: 'success',
        queryTime,
        rowCount: importedRows,
      });
      setMessage({ type: 'success', text: tCurrent('auto.remoteClickHouse.importSuccess', { count: importedRows, table: target.display }) });
      setImportDataState((current) => ({ ...current, executing: false, progress: { current: importedRows, total: parsed.rows.length } }));
    } catch (error) {
      const textError = getErrorMessage(error);
      const queryTime = Math.round(performance.now() - startTime);
      addResultTab({
        id: createId('result'),
        title: tCurrent('clickhouse.query.failed'),
        subtitle: tCurrent('clickhouse.query.databaseSubtitle', { database: target.database }),
        sql: sqlStatements.join('\n'),
        database: target.database,
        status: 'error',
        error: textError,
        queryTime,
        createdAt: Date.now(),
        columns: [],
      });
      addHistoryItem({
        sql: sqlStatements.join('\n'),
        database: target.database,
        status: 'error',
        queryTime,
        error: textError,
      });
      setImportDataState((current) => ({
        ...current,
        executing: false,
        error: tCurrent('auto.remoteClickHouse.importFailed', { error: textError }),
      }));
    }
  }, [addHistoryItem, addResultTab, api, clickhouseId, connectionId, getImportTargetTable, importDataState.csvText, importDataState.jsonText, importDataState.mode]);

  const updateCreateTableColumn = useCallback(<Key extends keyof ChSchemaColumn,>(
    columnId: string,
    key: Key,
    value: ChSchemaColumn[Key],
  ) => {
    setCreateTableState((current) => {
      const previousColumn = current.columns.find((column) => column.id === columnId);
      const previousName = previousColumn?.name.trim() ?? '';
      const nextName = key === 'name' ? String(value).trim() : previousName;
      const nextColumns = current.columns.map((column) => (
        column.id === columnId ? { ...column, [key]: value } : column
      ));
      const nextColumnNames = new Set(nextColumns.map((column) => column.name.trim()).filter(Boolean));
      const nextOrderByColumns = current.orderByColumns
        .map((column) => (key === 'name' && previousName && column === previousName ? nextName : column))
        .filter((column) => column && nextColumnNames.has(column));

      return {
        ...current,
        columns: nextColumns,
        orderByColumns: nextOrderByColumns.length > 0 ? nextOrderByColumns : current.orderByColumns,
        dialogError: '',
      };
    });
  }, []);

  const addCreateTableColumn = useCallback(() => {
    setCreateTableState((current) => ({
      ...current,
      columns: [...current.columns, createChSchemaColumn()],
    }));
  }, []);

  const removeCreateTableColumn = useCallback((columnId: string) => {
    setCreateTableState((current) => {
      const removedColumn = current.columns.find((column) => column.id === columnId);
      const removedName = removedColumn?.name.trim();
      const columns = current.columns.filter((column) => column.id !== columnId);

      return {
        ...current,
        columns,
        orderByColumns: removedName
          ? current.orderByColumns.filter((column) => column !== removedName)
          : current.orderByColumns,
      };
    });
  }, []);

  const handleExecuteCreateTable = useCallback(async () => {
    if (!api?.connections || !clickhouseId) return;

    if (!createTableState.tableName.trim()) {
      setCreateTableState((current) => ({ ...current, dialogError: tCurrent('auto.remoteClickHouse.pleaseFillTableName') }));
      return;
    }

    const columns = createTableState.columns.filter((column) => column.name.trim());
    if (columns.length === 0) {
      setCreateTableState((current) => ({ ...current, dialogError: tCurrent('auto.remoteClickHouse.pleaseAddColumns') }));
      return;
    }

    if (createTableState.columns.some((column) => !column.name.trim())) {
      setCreateTableState((current) => ({ ...current, dialogError: tCurrent('auto.remoteClickHouse.invalidColumnName') }));
      return;
    }
    const validationError = validateChCreateTableState(createTableState);
    if (validationError) {
      setCreateTableState((current) => ({ ...current, dialogError: validationError }));
      return;
    }

    const validColumnNames = new Set(createTableState.columns.map((column) => column.name.trim()).filter(Boolean));
    const validOrderByColumns = createTableState.orderByColumns.filter((column) => validColumnNames.has(column));
    if (validOrderByColumns.length === 0) {
      setCreateTableState((current) => ({ ...current, dialogError: tCurrent('auto.remoteClickHouse.pleaseSelectOrderBy') }));
      return;
    }

    const database = activeDb || undefined;
    const sqlText = generateClickHouseCreateTableSql(createTableState, activeDb);
    const startTime = performance.now();

    setCreateTableState((current) => ({ ...current, executing: true, dialogError: '' }));
    setMessage(null);

    try {
      const result = await api.connections.clickhouseQuery(connectionId, clickhouseId, sqlText);
      const queryTime = Math.round(performance.now() - startTime);
      addResultTab({
        id: createId('result'),
        title: createTableState.tableName.trim(),
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
        rowCount: result.rowCount ?? result.rows.length,
      });
      if (activeDb) {
        setExpandedDbs((current) => new Set(current).add(activeDb));
        await loadTables(activeDb, true);
      }
      setMessage({ type: 'success', text: tCurrent('auto.remoteClickHouse.tableCreated') });
      setCreateTableState(createChCreateTableState());
      updateActiveQuerySql(sqlText);
    } catch (error) {
      const text = tCurrent('auto.remoteClickHouse.createTableFailed', { error: getErrorMessage(error) });
      addHistoryItem({
        sql: sqlText,
        database,
        status: 'error',
        queryTime: Math.round(performance.now() - startTime),
        error: text,
      });
      setCreateTableState((current) => ({ ...current, dialogError: text }));
    } finally {
      setCreateTableState((current) => ({ ...current, executing: false }));
    }
  }, [
    activeDb,
    addHistoryItem,
    addResultTab,
    api,
    clickhouseId,
    connectionId,
    createTableState,
    loadTables,
    updateActiveQuerySql,
  ]);

  const handleEditTableStructure = useCallback(async (database: string, table: ShellDeskClickHouseTable) => {
    if (!api?.connections || !clickhouseId) return;

    const sqlText = `SHOW CREATE TABLE ${quoteIdentifier(table.name, 'clickhouse')};`;
    setActiveDb(database);
    setMessage(null);

    try {
      const result = await api.connections.clickhouseQuery(connectionId, clickhouseId, sqlText, database);
      const firstRow = result.rows[0];
      const createSqlColumn = result.columns[0];
      const createSql = firstRow && createSqlColumn ? firstRow[createSqlColumn] : undefined;

      if (typeof createSql !== 'string' || !createSql.trim()) {
        throw new Error(tCurrent('auto.remoteClickHouse.parseFailed'));
      }

      const parsed = parseClickHouseCreateTableSql(createSql);
      const snapshot: ChCreateTableState = {
        ...parsed,
        mode: 'edit',
        open: false,
        tableName: parsed.tableName || `${database}.${table.name}`,
        executing: false,
        dialogError: '',
        original: undefined,
      };

      setCreateTableState({
        ...snapshot,
        open: true,
        original: structuredClone(snapshot),
      });
    } catch (error) {
      void error;
      setMessage({ type: 'error', text: tCurrent('auto.remoteClickHouse.parseFailed') });
    }
  }, [api, clickhouseId, connectionId]);

  const handleExecuteAlterTable = useCallback(async () => {
    if (!api?.connections || !clickhouseId || !createTableState.original) return;

    const columns = createTableState.columns.filter((column) => column.name.trim());
    if (columns.length === 0) {
      setCreateTableState((current) => ({ ...current, dialogError: tCurrent('auto.remoteClickHouse.pleaseAddColumns') }));
      return;
    }

    if (createTableState.columns.some((column) => !column.name.trim())) {
      setCreateTableState((current) => ({ ...current, dialogError: tCurrent('auto.remoteClickHouse.invalidColumnName') }));
      return;
    }
    const validationError = validateChCreateTableState(createTableState);
    if (validationError) {
      setCreateTableState((current) => ({ ...current, dialogError: validationError }));
      return;
    }

    const statements = generateClickHouseAlterStatements(createTableState.original, createTableState);
    const sqlText = statements.join('\n');
    if (statements.length === 0) {
      setCreateTableState((current) => ({ ...current, dialogError: tCurrent('auto.remoteClickHouse.noChanges') }));
      return;
    }

    const database = activeDb || undefined;
    const startTime = performance.now();

    setCreateTableState((current) => ({ ...current, executing: true, dialogError: '' }));
    setMessage(null);

    try {
      let lastResult: ShellDeskClickHouseQueryResult = { columns: [], rows: [], rowCount: 0 };
      for (const statement of statements) {
        lastResult = await api.connections.clickhouseQuery(connectionId, clickhouseId, statement, database);
      }
      const queryTime = Math.round(performance.now() - startTime);

      addResultTab({
        id: createId('result'),
        title: createTableState.tableName.trim(),
        subtitle: database
          ? tCurrent('clickhouse.query.databaseSubtitle', { database })
          : tCurrent('clickhouse.query.noDatabase'),
        sql: sqlText,
        database,
        status: 'success',
        result: lastResult,
        queryTime,
        createdAt: Date.now(),
        columns: createGenericColumns(lastResult.columns, 'clickhouse'),
      });
      addHistoryItem({
        sql: sqlText,
        database,
        status: 'success',
        queryTime,
        rowCount: lastResult.rowCount ?? lastResult.rows.length,
      });
      if (activeDb) {
        await loadTables(activeDb, true);
      }
      setMessage({ type: 'success', text: tCurrent('auto.remoteClickHouse.alterTableApplied', { table: createTableState.tableName.trim() }) });
      setCreateTableState((current) => ({ ...current, open: false, executing: false }));
      updateActiveQuerySql(sqlText);
    } catch (error) {
      const text = getErrorMessage(error);
      addHistoryItem({
        sql: sqlText,
        database,
        status: 'error',
        queryTime: Math.round(performance.now() - startTime),
        error: text,
      });
      setCreateTableState((current) => ({
        ...current,
        executing: false,
        dialogError: tCurrent('auto.remoteClickHouse.alterTableFailed', { error: text }),
      }));
    }
  }, [
    activeDb,
    addHistoryItem,
    addResultTab,
    api,
    clickhouseId,
    connectionId,
    createTableState,
    loadTables,
    updateActiveQuerySql,
  ]);

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

  const handleContextMenuAction = useCallback((action: 'database-info' | 'create-table' | 'drop-database' | 'query-table' | 'table-structure' | 'edit-table') => {
    const target = contextMenu?.target;
    setContextMenu(null);
    if (!target) return;

    if (target.type === 'database') {
      if (action === 'database-info') {
        void handleShowDatabaseInfo(target.database);
      } else if (action === 'create-table') {
        setActiveDb(target.database);
        setCreateTableState({
          ...createChCreateTableState(),
          open: true,
        });
      } else if (action === 'drop-database') {
        setDatabaseDialog({
          open: true,
          mode: 'drop',
          name: '',
          target: target.database,
          executing: false,
          error: '',
        });
      }
      return;
    }

    if (target.type !== 'table') return;
    if (action === 'query-table') {
      void handleSelectTable(target.database, target.table);
    } else if (action === 'table-structure') {
      void handleShowTableStructure(target.database, target.table);
    } else if (action === 'edit-table') {
      void handleEditTableStructure(target.database, target.table);
    }
  }, [contextMenu, handleEditTableStructure, handleSelectTable, handleShowDatabaseInfo, handleShowTableStructure]);

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

  const clickHouseEditorExtensions = useMemo(() => createDatabaseEditorExtensions({
    language: sql({ dialect: MySQL }),
    dark: editorTheme === 'dark',
    onExecute: () => {
      void handleExecuteSql();
    },
  }), [editorTheme, handleExecuteSql]);

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
    setPendingEdit((current) => (current ? { ...current, error: '' } : current));

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
      setPendingEdit((current) => (current ? { ...current, error: getErrorMessage(error) } : current));
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
    return api?.events?.onDatabaseTunnelIdleTimeout((payload) => {
      if (
        payload.kind !== 'clickhouse' ||
        payload.connectionId !== connectionId ||
        payload.sessionId !== clickhouseIdRef.current
      ) {
        return;
      }

      clickhouseIdRef.current = '';
      setClickhouseId('');
      setStatus('disconnected');
      resetWorkspaceState();
      setErrorMessage(`数据库连接已因空闲超过 ${payload.idleMinutes} 分钟自动断开。`);
    });
  }, [api, connectionId, resetWorkspaceState]);

  useEffect(() => {
    setPage(0);
  }, [activeResultId]);

  useEffect(() => {
    if (isReady) {
      sqlEditorRef.current?.view?.focus();
    }
  }, [activeQueryId, isReady]);

  useEffect(() => {
    if (!importDataState.open) return undefined;

    return () => {
      const previousFocus = importPreviousFocusRef.current;
      importPreviousFocusRef.current = null;
      if (previousFocus instanceof HTMLElement) {
        previousFocus.focus();
      }
    };
  }, [importDataState.open]);

  useEffect(() => {
    if (!importDataState.open || typeof document === 'undefined') return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || importDataState.executing) return;
      event.preventDefault();
      closeImportDialog();
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [closeImportDialog, importDataState.executing, importDataState.open]);

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
            <div className="mysql-sidebar-actions">
              <button
                type="button"
                className="mysql-sidebar-text-action"
                onClick={openCreateDatabaseDialog}
                title={tCurrent('auto.remoteClickHouse.createDatabase')}
              >
                DB+
              </button>
              <button
                type="button"
                className="mysql-sidebar-text-action"
                onClick={openCreateTableDialog}
                title={tCurrent('auto.remoteClickHouse.createTable')}
              >
                T+
              </button>
              <button type="button" onClick={openImportDialog} title={tCurrent('auto.remoteClickHouse.importData')}>
                ⇧
              </button>
              <button type="button" onClick={() => void refreshDatabases()} disabled={schemaLoading} title={tCurrent('clickhouse.ui.refreshDatabasesTitle')}>
                {schemaLoading ? '...' : '↻'}
              </button>
            </div>
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
                    <button type="button" className="database-export-button" onClick={openImportDialog}>{tCurrent('auto.remoteClickHouse.importData')}</button>
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
      {importDataState.open ? createPortal(
        <div className="schema-dialog-overlay" role="presentation">
          <div className="schema-dialog mysql-import-dialog" role="dialog" aria-modal="true" aria-labelledby="clickhouse-import-title">
            <div className="schema-dialog-header">
              <h3 id="clickhouse-import-title">
                {tCurrent('auto.remoteClickHouse.importDialogTitle', { table: getImportTargetTable()?.display || '-' })}
              </h3>
              <button
                type="button"
                onClick={closeImportDialog}
                disabled={importDataState.executing}
                aria-label={tCurrent('auto.remoteClickHouse.cancel')}
              >
                ×
              </button>
            </div>

            <div className="schema-form-grid">
              <label className="schema-field schema-field-wide">
                <span>{tCurrent('auto.remoteClickHouse.importTargetTable')}</span>
                <select
                  value={importDataState.targetTable}
                  onChange={(event) => setImportDataState((current) => ({
                    ...current,
                    targetTable: event.target.value,
                    progress: null,
                    error: '',
                  }))}
                  disabled={importDataState.executing}
                >
                  <option value="">{tCurrent('auto.remoteClickHouse.importNoTable')}</option>
                  <option value={importEditorTarget}>{tCurrent('auto.remoteClickHouse.importFromSqlEditor')}</option>
                  {importTargetTables.map((table) => (
                    <option key={table.value} value={table.value}>{table.label}</option>
                  ))}
                </select>
              </label>
            </div>

            <div className="mysql-import-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={importDataState.mode === 'csv'}
                className={importDataState.mode === 'csv' ? 'active' : ''}
                onClick={() => updateImportMode('csv')}
                disabled={importDataState.executing}
              >
                {tCurrent('auto.remoteClickHouse.importCsvTab')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={importDataState.mode === 'json'}
                className={importDataState.mode === 'json' ? 'active' : ''}
                onClick={() => updateImportMode('json')}
                disabled={importDataState.executing}
              >
                {tCurrent('auto.remoteClickHouse.importJsonTab')}
              </button>
            </div>

            <div className="schema-import-file-row">
              <input
                type="file"
                ref={importFileInputRef}
                style={{ display: 'none' }}
                accept=".csv,.json"
                onChange={handleImportFileSelected}
              />
              <button type="button" onClick={() => importFileInputRef.current?.click()} disabled={importDataState.executing}>
                {tCurrent('auto.remoteClickHouse.importSelectFile')}
              </button>
            </div>

            <label className="schema-field schema-preview-field">
              <span>
                {importDataState.mode === 'csv'
                  ? tCurrent('auto.remoteClickHouse.importPasteCsv')
                  : tCurrent('auto.remoteClickHouse.importPasteJson')}
              </span>
              <textarea
                value={importDataState.mode === 'csv' ? importDataState.csvText : importDataState.jsonText}
                onChange={(event) => updateImportText(importDataState.mode, event.target.value)}
                disabled={importDataState.executing}
                rows={8}
                autoFocus
              />
            </label>

            <div className="schema-section">
              <div className="schema-section-header">
                <strong>{tCurrent('auto.remoteClickHouse.importPreview')}</strong>
                {importDataState.progress ? (
                  <span className="mysql-import-progress">
                    {tCurrent('auto.remoteClickHouse.importProgress', {
                      current: importDataState.progress.current,
                      total: importDataState.progress.total,
                    })}
                  </span>
                ) : null}
              </div>
              <div className="mysql-import-preview">
                {importDataState.columns.length > 0 && importDataState.preview.length > 0 ? (
                  <table>
                    <thead>
                      <tr>
                        {importDataState.columns.map((column) => (
                          <th key={column}>{column}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {importDataState.preview.map((row, rowIndex) => (
                        <tr key={`${rowIndex}-${importDataState.columns.join('|')}`}>
                          {importDataState.columns.map((column) => (
                            <td key={column}>{row[column] ?? ''}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="mysql-import-empty">{tCurrent('auto.remoteClickHouse.importNoData')}</div>
                )}
              </div>
            </div>

            {importDataState.error ? (
              <div
                className="dismissible-alert mysql-message-banner error schema-dialog-alert schema-local-alert"
                role="alert"
              >
                <span className="dismissible-alert-content">{importDataState.error}</span>
                <button
                  type="button"
                  className="dismissible-alert-close"
                  onClick={() => setImportDataState((current) => ({ ...current, error: '' }))}
                  aria-label={tCurrent('common.closeAlert')}
                  title={tCurrent('common.closeAlert')}
                >
                  ×
                </button>
              </div>
            ) : null}

            <div className="schema-actions">
              <button type="button" onClick={closeImportDialog} disabled={importDataState.executing}>
                {tCurrent('auto.remoteClickHouse.cancel')}
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => void handleExecuteImport()}
                disabled={importDataState.executing}
              >
                {importDataState.executing ? tCurrent('clickhouse.query.runningButton') : tCurrent('auto.remoteClickHouse.importExecute')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}

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
            {pendingEdit.error ? (
              <DismissibleAlert
                className="mysql-message-banner error"
                inline
                onDismiss={() => setPendingEdit((current) => (current ? { ...current, error: '' } : current))}
                role="alert"
              >
                {pendingEdit.error}
              </DismissibleAlert>
            ) : null}
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

      {createTableState.open ? createPortal(
        <div className="schema-dialog-overlay" role="presentation">
          <div className="schema-dialog" role="dialog" aria-modal="true" aria-labelledby="clickhouse-create-table-title">
            <div className="schema-dialog-header">
              <h3 id="clickhouse-create-table-title">
                {createTableState.mode === 'edit'
                  ? tCurrent('auto.remoteClickHouse.editTableTitle', { table: createTableState.tableName || '-' })
                  : tCurrent('auto.remoteClickHouse.createTableTitle')}
              </h3>
              <button
                type="button"
                onClick={closeCreateTableDialog}
                disabled={createTableState.executing}
                aria-label={tCurrent('auto.remoteClickHouse.cancel')}
              >
                ×
              </button>
            </div>

            <div className="schema-form-grid">
              <label className="schema-field">
                <span>{tCurrent('auto.remoteClickHouse.tableName')}</span>
                <input
                  type="text"
                  value={createTableState.tableName}
                  onChange={(event) => setCreateTableState((current) => ({ ...current, tableName: event.target.value, dialogError: '' }))}
                  disabled={createTableState.mode === 'edit'}
                  autoFocus
                />
              </label>
              <label className="schema-field">
                <span>{tCurrent('auto.remoteClickHouse.engine')}</span>
                <select
                  value={createTableState.engine}
                  onChange={(event) => setCreateTableState((current) => ({ ...current, engine: event.target.value, dialogError: '' }))}
                  disabled={createTableState.mode === 'edit'}
                >
                  {clickHouseEngines.map((engine) => (
                    <option key={engine} value={engine}>{engine}</option>
                  ))}
                </select>
              </label>
              <label className="schema-field">
                <span>{tCurrent('auto.remoteClickHouse.orderBy')}</span>
                <select
                  multiple
                  value={createTableState.orderByColumns}
                  onChange={(event) => setCreateTableState((current) => ({
                    ...current,
                    orderByColumns: Array.from(event.target.selectedOptions, (option) => option.value),
                    dialogError: '',
                  }))}
                >
                  {createTableState.columns.filter((column) => column.name.trim()).map((column) => (
                    <option key={column.id} value={column.name.trim()}>{column.name.trim()}</option>
                  ))}
                </select>
              </label>
              <label className="schema-field">
                <span>{tCurrent('auto.remoteClickHouse.partitionBy')}</span>
                <input
                  type="text"
                  value={createTableState.partitionBy}
                  onChange={(event) => setCreateTableState((current) => ({ ...current, partitionBy: event.target.value, dialogError: '' }))}
                  placeholder="toYYYYMM(created_at)"
                />
              </label>
              <label className="schema-field schema-field-wide">
                <span>{tCurrent('auto.remoteClickHouse.comment')}</span>
                <input
                  type="text"
                  value={createTableState.comment}
                  onChange={(event) => setCreateTableState((current) => ({ ...current, comment: event.target.value, dialogError: '' }))}
                />
              </label>
            </div>

            <div className="schema-section">
              <div className="schema-section-header">
                <strong>{tCurrent('auto.remoteClickHouse.columnName')}</strong>
                <button type="button" onClick={addCreateTableColumn}>{tCurrent('auto.remoteClickHouse.addColumn')}</button>
              </div>
              <div className="schema-columns-scroll">
                <table className="schema-columns-table">
                  <thead>
                    <tr>
                      <th>{tCurrent('auto.remoteClickHouse.columnName')}</th>
                      <th>{tCurrent('auto.remoteClickHouse.columnType')}</th>
                      <th>{tCurrent('auto.remoteClickHouse.nullable')}</th>
                      <th>{tCurrent('auto.remoteClickHouse.defaultValue')}</th>
                      <th>{tCurrent('auto.remoteClickHouse.codec')}</th>
                      <th>{tCurrent('auto.remoteClickHouse.comment')}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {createTableState.columns.map((column) => (
                      <tr key={column.id}>
                        <td>
                          <input
                            type="text"
                            value={column.name}
                            onChange={(event) => updateCreateTableColumn(column.id, 'name', event.target.value)}
                          />
                        </td>
                        <td>
                          <select value={column.type} onChange={(event) => updateCreateTableColumn(column.id, 'type', event.target.value)}>
                            {clickHouseColumnTypes.map((type) => (
                              <option key={type} value={type}>{type}</option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input
                            type="checkbox"
                            checked={column.nullable}
                            onChange={(event) => updateCreateTableColumn(column.id, 'nullable', event.target.checked)}
                          />
                        </td>
                        <td>
                          <input
                            type="text"
                            value={column.defaultValue}
                            onChange={(event) => updateCreateTableColumn(column.id, 'defaultValue', event.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            type="text"
                            list="clickhouse-codec-options"
                            value={column.codec}
                            onChange={(event) => updateCreateTableColumn(column.id, 'codec', event.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            type="text"
                            value={column.comment}
                            onChange={(event) => updateCreateTableColumn(column.id, 'comment', event.target.value)}
                          />
                        </td>
                        <td>
                          <button type="button" onClick={() => removeCreateTableColumn(column.id)}>
                            {tCurrent('auto.remoteClickHouse.removeColumn')}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <datalist id="clickhouse-codec-options">
                  {clickHouseCodecs.filter(Boolean).map((codec) => (
                    <option key={codec} value={codec} />
                  ))}
                </datalist>
              </div>
            </div>

            <label className="schema-field schema-preview-field">
              <span>{tCurrent('auto.remoteClickHouse.sqlPreview')}</span>
              <textarea className="schema-preview" value={createTableSqlPreview} readOnly spellCheck={false} />
            </label>

            <div className="schema-actions schema-actions-stacked">
              {createTableState.dialogError ? (
                <div
                  className="dismissible-alert mysql-message-banner error schema-actions-alert schema-local-alert"
                  role="alert"
                >
                  <span className="dismissible-alert-content">{createTableState.dialogError}</span>
                  <button
                    type="button"
                    className="dismissible-alert-close"
                    onClick={() => setCreateTableState((current) => ({ ...current, dialogError: '' }))}
                    aria-label={tCurrent('common.closeAlert')}
                    title={tCurrent('common.closeAlert')}
                  >
                    ×
                  </button>
                </div>
              ) : null}
              <div className="schema-action-buttons">
                <button type="button" onClick={closeCreateTableDialog} disabled={createTableState.executing}>
                  {tCurrent('auto.remoteClickHouse.cancel')}
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => void (createTableState.mode === 'edit' ? handleExecuteAlterTable() : handleExecuteCreateTable())}
                  disabled={createTableState.executing}
                >
                  {createTableState.executing
                    ? tCurrent('clickhouse.query.runningButton')
                    : createTableState.mode === 'edit'
                      ? tCurrent('auto.remoteClickHouse.executeAlter')
                      : tCurrent('auto.remoteClickHouse.executeCreate')}
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}

      {databaseDialog.open ? createPortal(
        <div className="schema-dialog-overlay" role="presentation">
          <div
            className="schema-dialog mysql-database-dialog"
            role={databaseDialog.mode === 'drop' ? 'alertdialog' : 'dialog'}
            aria-modal="true"
            aria-labelledby="clickhouse-database-dialog-title"
          >
            <div className="schema-dialog-header">
              <h3 id="clickhouse-database-dialog-title">
                {databaseDialog.mode === 'drop'
                  ? tCurrent('auto.remoteClickHouse.dropDatabaseTitle', { database: databaseDialog.target || '-' })
                  : tCurrent('auto.remoteClickHouse.createDatabaseTitle')}
              </h3>
              <button
                type="button"
                onClick={closeDatabaseDialog}
                disabled={databaseDialog.executing}
                aria-label={tCurrent('auto.remoteClickHouse.cancel')}
              >
                ×
              </button>
            </div>

            {databaseDialog.error ? (
              <div
                className="dismissible-alert mysql-message-banner error schema-dialog-alert schema-local-alert"
                role="alert"
              >
                <span className="dismissible-alert-content">{databaseDialog.error}</span>
                <button
                  type="button"
                  className="dismissible-alert-close"
                  onClick={() => setDatabaseDialog((current) => ({ ...current, error: '' }))}
                  aria-label={tCurrent('common.closeAlert')}
                  title={tCurrent('common.closeAlert')}
                >
                  ×
                </button>
              </div>
            ) : null}

            {databaseDialog.mode === 'create' ? (
              <div className="schema-form-grid mysql-database-dialog-body">
                <label className="schema-field schema-field-wide">
                  <span>{tCurrent('auto.remoteClickHouse.databaseName')}</span>
                  <input
                    type="text"
                    value={databaseDialog.name}
                    onChange={(event) => setDatabaseDialog((current) => ({
                      ...current,
                      name: event.target.value,
                      error: '',
                    }))}
                    placeholder={tCurrent('auto.remoteClickHouse.databaseNamePlaceholder')}
                    disabled={databaseDialog.executing}
                    autoFocus
                  />
                </label>
              </div>
            ) : (
              <div className="mysql-database-dialog-body">
                <p className="mysql-database-dialog-warning">
                  {tCurrent('auto.remoteClickHouse.dropDatabaseWarning')}
                </p>
                <code>{databaseDialog.target}</code>
              </div>
            )}

            <div className="schema-actions">
              <button type="button" onClick={closeDatabaseDialog} disabled={databaseDialog.executing}>
                {tCurrent('auto.remoteClickHouse.cancel')}
              </button>
              <button
                type="button"
                className={databaseDialog.mode === 'drop' ? 'danger' : 'primary'}
                onClick={() => void (databaseDialog.mode === 'drop' ? handleExecuteDropDatabase() : handleExecuteCreateDatabase())}
                disabled={databaseDialog.executing || (databaseDialog.mode === 'drop' && isProtectedClickHouseDatabase(databaseDialog.target))}
              >
                {databaseDialog.executing
                  ? tCurrent('clickhouse.query.runningButton')
                  : databaseDialog.mode === 'drop'
                    ? tCurrent('auto.remoteClickHouse.executeDropDatabase')
                    : tCurrent('auto.remoteClickHouse.executeCreateDatabase')}
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
            <span>
              {contextMenu.target.type === 'database'
                ? tCurrent('auto.remoteClickHouse.contextDatabase')
                : `${tCurrent('auto.remoteClickHouse.contextTable')} · ${contextMenu.target.database}`}
            </span>
          </div>
          {contextMenu.target.type === 'database' ? (
            <>
              <button type="button" role="menuitem" onClick={() => handleContextMenuAction('database-info')}>
                {tCurrent('auto.remoteClickHouse.contextDatabaseInfo')}
              </button>
              <button type="button" role="menuitem" onClick={() => handleContextMenuAction('create-table')}>
                {tCurrent('auto.remoteClickHouse.createTable')}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => handleContextMenuAction('drop-database')}
                disabled={isProtectedClickHouseDatabase(contextMenu.target.database)}
              >
                {tCurrent('auto.remoteClickHouse.dropDatabase')}
              </button>
            </>
          ) : (
            <>
              <button type="button" role="menuitem" onClick={() => handleContextMenuAction('query-table')}>
                {tCurrent('auto.remoteClickHouse.contextQueryTable')}
              </button>
              <button type="button" role="menuitem" onClick={() => handleContextMenuAction('table-structure')}>
                {tCurrent('auto.remoteClickHouse.contextTableStructure')}
              </button>
              <button type="button" role="menuitem" onClick={() => handleContextMenuAction('edit-table')}>{tCurrent('auto.remoteClickHouse.editTable')}</button>
            </>
          )}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

export default RemoteClickHouse;
