import { type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import { exportDatabaseRows, type DatabaseExportFormat } from './databaseExport';
import DismissibleAlert from './DismissibleAlert';
import { loadRemoteConnectionProfile, readProfileString, saveRemoteConnectionProfile } from './remoteConnectionProfiles';
import { tCurrent } from '../../i18n';

interface RemoteMySQLProps {
  connectionId: string;
  hostId: string;
}

interface MysqlConnectionForm {
  host: string;
  port: string;
  user: string;
  password: string;
  initialDatabase: string;
}

type MysqlStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
type MysqlMessageType = 'info' | 'success' | 'error';
type MysqlResultStatus = 'success' | 'error';

interface TableInfo {
  database: string;
  name: string;
}

interface MysqlMessage {
  type: MysqlMessageType;
  text: string;
}

interface MysqlQueryTab {
  id: string;
  title: string;
  sql: string;
  running: boolean;
}

interface MysqlResultTab {
  id: string;
  title: string;
  subtitle: string;
  sql: string;
  database?: string;
  status: MysqlResultStatus;
  result?: ShellDeskMysqlQueryResult;
  error?: string;
  queryTime: number;
  createdAt: number;
  table?: TableInfo;
  columns: ShellDeskMysqlColumn[];
}

interface MysqlHistoryItem {
  id: string;
  sql: string;
  database?: string;
  status: MysqlResultStatus;
  queryTime: number;
  rowCount?: number;
  affectedRows?: number;
  error?: string;
  createdAt: number;
}

interface EditingCell {
  rowIndex: number;
  column: string;
  value: string;
}

interface PendingEdit {
  resultId: string;
  table: TableInfo;
  rowIndex: number;
  column: string;
  oldValue: unknown;
  newValue: unknown;
  pkColumns: string[];
  pkValues: unknown[];
}

const defaultPort = 3306;
const pageSize = 100;
const tablePreviewLimit = 50;
const maxResultTabs = 10;
const maxHistoryItems = 12;

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createQueryTab(index: number, sql = 'SELECT 1;'): MysqlQueryTab {
  return {
    id: createId('query'),
    title: tCurrent('auto.remoteMySQL.1vq2agf', { value0: index }),
    sql,
    running: false,
  };
}

function createInitialQueryState(): { tabs: MysqlQueryTab[]; activeId: string } {
  const tab = createQueryTab(1);
  return { tabs: [tab], activeId: tab.id };
}

function quoteMysqlIdentifier(identifier: string): string {
  return `\`${identifier.replace(/`/g, '``')}\``;
}

function formatSqlPreview(sql: string, length = 56): string {
  const compact = sql.replace(/\s+/g, ' ').trim();
  if (!compact) return tCurrent('auto.remoteMySQL.18ivnwu');
  return compact.length > length ? `${compact.slice(0, length - 1)}...` : compact;
}

function formatCellValue(value: unknown): string {
  if (value === null) return 'NULL';
  if (value === undefined) return '';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(getShellDeskLocale(), {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function createGenericColumns(names: string[]): ShellDeskMysqlColumn[] {
  return names.map((name) => ({
    name,
    type: '',
    nullable: false,
    key: '',
    default: null,
    extra: '',
    comment: '',
  }));
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left === null || left === undefined) return right === null || right === undefined;
  if (right === null || right === undefined) return false;
  return String(left) === String(right);
}

function getColumnMeta(columns: ShellDeskMysqlColumn[], name: string): ShellDeskMysqlColumn | undefined {
  return columns.find((column) => column.name === name);
}

function isWriteStatement(sql: string): boolean {
  return /^\s*(insert|update|delete|replace|alter|drop|truncate|create|rename|grant|revoke)\b/i.test(sql);
}

function describeResult(result: ShellDeskMysqlQueryResult): string {
  if (result.affectedRows !== undefined) {
    const insertText = result.insertId ? tCurrent('auto.remoteMySQL.12xfbkn', { value0: result.insertId }) : '';
    return tCurrent('auto.remoteMySQL.4g1j50', { value0: result.affectedRows, value1: insertText });
  }
  return tCurrent('auto.remoteMySQL.18tehe0', { value0: result.rows.length });
}

function RemoteMySQL({ connectionId, hostId }: RemoteMySQLProps) {
  const api = window.guiSSH;
  const initialQueryStateRef = useRef(createInitialQueryState());
  const mysqlIdRef = useRef('');
  const sqlRef = useRef<HTMLTextAreaElement | null>(null);

  const [status, setStatus] = useState<MysqlStatus>('disconnected');
  const [errorMessage, setErrorMessage] = useState('');
  const [message, setMessage] = useState<MysqlMessage | null>(null);
  const [mysqlId, setMysqlId] = useState('');
  const [connectionForm, setConnectionForm] = useState<MysqlConnectionForm>({
    host: '127.0.0.1',
    port: String(defaultPort),
    user: 'root',
    password: '',
    initialDatabase: '',
  });
  const { host, port, user, password, initialDatabase } = connectionForm;
  const updateConnectionFormField = useCallback(<Key extends keyof MysqlConnectionForm,>(
    key: Key,
    value: SetStateAction<MysqlConnectionForm[Key]>,
  ) => {
    setConnectionForm((currentForm) => ({
      ...currentForm,
      [key]: typeof value === 'function'
        ? (value as (currentValue: MysqlConnectionForm[Key]) => MysqlConnectionForm[Key])(currentForm[key])
        : value,
    }));
  }, []);
  const setHost = useCallback((value: SetStateAction<string>) => updateConnectionFormField('host', value), [updateConnectionFormField]);
  const setPort = useCallback((value: SetStateAction<string>) => updateConnectionFormField('port', value), [updateConnectionFormField]);
  const setUser = useCallback((value: SetStateAction<string>) => updateConnectionFormField('user', value), [updateConnectionFormField]);
  const setPassword = useCallback((value: SetStateAction<string>) => updateConnectionFormField('password', value), [updateConnectionFormField]);
  const setInitialDatabase = useCallback((value: SetStateAction<string>) => updateConnectionFormField('initialDatabase', value), [updateConnectionFormField]);
  const [databases, setDatabases] = useState<string[]>([]);
  const [expandedDbs, setExpandedDbs] = useState<Set<string>>(new Set());
  const [loadingDbs, setLoadingDbs] = useState<Set<string>>(new Set());
  const [dbTables, setDbTables] = useState<Record<string, string[]>>({});
  const [objectSearch, setObjectSearch] = useState('');
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [selectedTable, setSelectedTable] = useState<TableInfo | null>(null);
  const [tableColumns, setTableColumns] = useState<ShellDeskMysqlColumn[]>([]);
  const [activeDb, setActiveDb] = useState('');
  const [queryTabs, setQueryTabs] = useState<MysqlQueryTab[]>(initialQueryStateRef.current.tabs);
  const [activeQueryId, setActiveQueryId] = useState(initialQueryStateRef.current.activeId);
  const [resultTabs, setResultTabs] = useState<MysqlResultTab[]>([]);
  const [activeResultId, setActiveResultId] = useState('');
  const [history, setHistory] = useState<MysqlHistoryItem[]>([]);
  const [editingCell, setEditingCell] = useState<EditingCell | null>(null);
  const [pendingEdit, setPendingEdit] = useState<PendingEdit | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [page, setPage] = useState(0);

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
    return activeResultColumns.filter((column) => column.key === 'PRI').map((column) => column.name);
  }, [activeResultColumns]);

  const isActiveResultEditable = Boolean(activeResultTab?.table && activeResultPrimaryKeys.length > 0);
  const canRunActiveQuery = Boolean(activeQueryTab?.sql.trim()) && !activeQueryTab?.running;

  useEffect(() => {
    let disposed = false;

    void loadRemoteConnectionProfile(hostId, 'mysql').then((profile) => {
      if (disposed || !profile) return;

      setConnectionForm({
        host: readProfileString(profile, 'host', '127.0.0.1'),
        port: readProfileString(profile, 'port', String(defaultPort)),
        user: readProfileString(profile, 'user', 'root'),
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
          : tables.filter((table) => table.toLowerCase().includes(keyword));

        return { database, tables: matchedTables, databaseMatched };
      })
      .filter((entry) => entry.databaseMatched || entry.tables.length > 0);
  }, [databases, dbTables, objectSearch]);

  const pagedRows = useMemo(() => {
    if (!activeResult) return [];
    return activeResult.rows.slice(page * pageSize, (page + 1) * pageSize);
  }, [activeResult, page]);

  const totalPages = useMemo(() => {
    if (!activeResult) return 0;
    return Math.ceil(activeResult.rows.length / pageSize);
  }, [activeResult]);

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
    setMessage(null);
  }, []);

  const addHistoryItem = useCallback((item: Omit<MysqlHistoryItem, 'id' | 'createdAt'>) => {
    setHistory((prev) => [
      {
        ...item,
        id: createId('history'),
        createdAt: Date.now(),
      },
      ...prev,
    ].slice(0, maxHistoryItems));
  }, []);

  const addResultTab = useCallback((tab: MysqlResultTab) => {
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
    if (!api?.connections || !mysqlId) return;
    if (!force && dbTables[database]) return;

    setLoadingDbs((prev) => new Set(prev).add(database));

    try {
      const tables = await api.connections.mysqlTables(connectionId, mysqlId, database);
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
  }, [api, connectionId, dbTables, mysqlId]);

  const refreshDatabases = useCallback(async () => {
    if (!api?.connections || !mysqlId) return;

    setSchemaLoading(true);
    setMessage(null);

    try {
      const dbs = await api.connections.mysqlDatabases(connectionId, mysqlId);
      const expanded = Array.from(expandedDbs).filter((database) => dbs.includes(database));
      const nextTables: Record<string, string[]> = {};

      for (const database of expanded) {
        nextTables[database] = await api.connections.mysqlTables(connectionId, mysqlId, database);
      }

      setDatabases(dbs);
      setExpandedDbs(new Set(expanded));
      setDbTables(nextTables);
      setMessage({ type: 'success', text: tCurrent('auto.remoteMySQL.1cb3a9') });

      if (activeDb && !dbs.includes(activeDb)) {
        setActiveDb(dbs[0] ?? '');
      }
    } catch (error) {
      setMessage({ type: 'error', text: getErrorMessage(error) });
    } finally {
      setSchemaLoading(false);
    }
  }, [activeDb, api, connectionId, expandedDbs, mysqlId]);

  const handleConnect = useCallback(async () => {
    if (!api?.connections) return;

    setStatus('connecting');
    setErrorMessage('');
    setMessage(null);

    let createdMysqlId = '';
    try {
      const nextPort = parseInt(port, 10) || defaultPort;
      const result = await api.connections.mysqlConnect(connectionId, {
        mode: 'auto',
        host: host || '127.0.0.1',
        port: nextPort,
        user: user || 'root',
        password,
        database: initialDatabase.trim() || undefined,
      });

      createdMysqlId = result.mysqlId;
      setMysqlId(result.mysqlId);
      setStatus('connected');
      void saveRemoteConnectionProfile(hostId, 'mysql', {
        host: host || '127.0.0.1',
        port: String(nextPort),
        user: user || 'root',
        password,
        initialDatabase: initialDatabase.trim(),
      }).catch(() => undefined);

      setSchemaLoading(true);
      const requestedDb = initialDatabase.trim();
      const [dbs, requestedTables] = await Promise.all([
        api.connections.mysqlDatabases(connectionId, result.mysqlId),
        requestedDb
          ? api.connections.mysqlTables(connectionId, result.mysqlId, requestedDb).catch(() => [])
          : Promise.resolve(null),
      ]);
      const nextActiveDb = requestedDb && dbs.includes(requestedDb) ? requestedDb : dbs[0] ?? '';
      const nextExpanded = nextActiveDb ? new Set([nextActiveDb]) : new Set<string>();
      const nextTables: Record<string, string[]> = {};

      if (nextActiveDb) {
        nextTables[nextActiveDb] = requestedDb && nextActiveDb === requestedDb && requestedTables
          ? requestedTables
          : await api.connections.mysqlTables(connectionId, result.mysqlId, nextActiveDb).catch(() => []);
      }

      setDatabases(dbs);
      setActiveDb(nextActiveDb);
      setExpandedDbs(nextExpanded);
      setDbTables(nextTables);
      setMessage({
        type: 'success',
        text: tCurrent('auto.remoteMySQL.1ltkkjj', {
          value0: result.transport === 'direct'
            ? tCurrent('mysql.transport.direct')
            : result.transport === 'ssh-exec'
              ? tCurrent('mysql.transport.remoteTcpProxy')
              : tCurrent('mysql.transport.sshTunnel'),
          value1: user || 'root',
          value2: host || '127.0.0.1',
          value3: nextPort,
        }),
      });
    } catch (error) {
      if (createdMysqlId) {
        try {
          await api.connections.mysqlDisconnect(connectionId, createdMysqlId);
        } catch {
          // ignore cleanup errors after partial connect failure
        }
      }
      if (mysqlIdRef.current === createdMysqlId) {
        mysqlIdRef.current = '';
      }
      setMysqlId((current) => (current === createdMysqlId ? '' : current));
      setStatus('error');
      setErrorMessage(getErrorMessage(error));
    } finally {
      setSchemaLoading(false);
    }
  }, [api, connectionId, host, hostId, initialDatabase, password, port, user]);

  const handleDisconnect = useCallback(async () => {
    if (!api?.connections || !mysqlId) return;

    try {
      await api.connections.mysqlDisconnect(connectionId, mysqlId);
    } catch {
      // ignore disconnect errors
    }

    setStatus('disconnected');
    setMysqlId('');
    resetWorkspaceState();
  }, [api, connectionId, mysqlId, resetWorkspaceState]);

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

  const handleAddQueryTab = useCallback((seedSql?: string) => {
    setQueryTabs((prev) => {
      const tab = createQueryTab(prev.length + 1, seedSql ?? '');
      setActiveQueryId(tab.id);
      return [...prev, tab];
    });
  }, []);

  const handleCloseQueryTab = useCallback((queryId: string, event: React.MouseEvent) => {
    event.stopPropagation();

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

  const handleCloseResultTab = useCallback((resultId: string, event: React.MouseEvent) => {
    event.stopPropagation();

    setResultTabs((prev) => {
      const removedIndex = prev.findIndex((tab) => tab.id === resultId);
      const next = prev.filter((tab) => tab.id !== resultId);

      if (activeResultId === resultId) {
        setActiveResultId(next[Math.max(0, removedIndex - 1)]?.id ?? next[0]?.id ?? '');
      }

      return next;
    });
  }, [activeResultId]);

  const handleUseHistory = useCallback((item: MysqlHistoryItem) => {
    const tab = createQueryTab(queryTabs.length + 1, item.sql);
    setQueryTabs((prev) => [...prev, tab]);
    setActiveQueryId(tab.id);

    if (item.database) {
      setActiveDb(item.database);
    }
  }, [queryTabs.length]);

  const handleSelectTable = useCallback(async (database: string, table: string) => {
    if (!api?.connections || !mysqlId) return;

    const previewSql = `SELECT * FROM ${quoteMysqlIdentifier(database)}.${quoteMysqlIdentifier(table)} LIMIT ${tablePreviewLimit};`;
    const startTime = performance.now();

    setSelectedTable({ database, name: table });
    setActiveDb(database);
    setMessage(null);
    setPage(0);
    updateActiveQuerySql(previewSql);

    try {
      const cols = await api.connections.mysqlColumns(connectionId, mysqlId, database, table);
      setTableColumns(cols);

      const result = await api.connections.mysqlQuery(connectionId, mysqlId, previewSql, database);
      const queryTime = Math.round(performance.now() - startTime);
      const resultTab: MysqlResultTab = {
        id: createId('result'),
        title: table,
        subtitle: `${database} · LIMIT ${tablePreviewLimit}`,
        sql: previewSql,
        database,
        status: 'success',
        result,
        queryTime,
        createdAt: Date.now(),
        table: { database, name: table },
        columns: cols,
      };

      addResultTab(resultTab);
      addHistoryItem({
        sql: previewSql,
        database,
        status: 'success',
        queryTime,
        rowCount: result.rows.length,
        affectedRows: result.affectedRows,
      });
    } catch (error) {
      const text = getErrorMessage(error);
      setTableColumns([]);
      setMessage({ type: 'error', text });

      addResultTab({
        id: createId('result'),
        title: table,
        subtitle: database,
        sql: previewSql,
        database,
        status: 'error',
        error: text,
        queryTime: Math.round(performance.now() - startTime),
        createdAt: Date.now(),
        table: { database, name: table },
        columns: [],
      });
    }
  }, [addHistoryItem, addResultTab, api, connectionId, mysqlId, updateActiveQuerySql]);

  const handleExecuteSql = useCallback(async () => {
    if (!api?.connections || !mysqlId || !activeQueryTab?.sql.trim()) return;

    const sqlText = activeQueryTab.sql.trim();
    const database = activeDb || undefined;
    const startTime = performance.now();

    setMessage(null);
    setPage(0);
    setQueryRunning(activeQueryTab.id, true);

    try {
      const result = await api.connections.mysqlQuery(connectionId, mysqlId, sqlText, database);
      const queryTime = Math.round(performance.now() - startTime);
      const resultTab: MysqlResultTab = {
        id: createId('result'),
        title: isWriteStatement(sqlText) ? tCurrent('auto.remoteMySQL.11b0x22') : formatSqlPreview(sqlText, 28),
        subtitle: database ? tCurrent('auto.remoteMySQL.4uvcwr', { value0: database }) : tCurrent('auto.remoteMySQL.1qglxbx'),
        sql: sqlText,
        database,
        status: 'success',
        result,
        queryTime,
        createdAt: Date.now(),
        columns: createGenericColumns(result.columns),
      };

      addResultTab(resultTab);
      addHistoryItem({
        sql: sqlText,
        database,
        status: 'success',
        queryTime,
        rowCount: result.rows.length,
        affectedRows: result.affectedRows,
      });

      if (result.affectedRows !== undefined) {
        setMessage({ type: 'success', text: tCurrent('auto.remoteMySQL.90ms1c', { value0: result.affectedRows }) });
      }
    } catch (error) {
      const queryTime = Math.round(performance.now() - startTime);
      const text = getErrorMessage(error);

      addResultTab({
        id: createId('result'),
        title: tCurrent('auto.remoteMySQL.wq5uqu'),
        subtitle: database ? tCurrent('auto.remoteMySQL.4uvcwr2', { value0: database }) : tCurrent('auto.remoteMySQL.1qglxbx2'),
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
  }, [activeDb, activeQueryTab, addHistoryItem, addResultTab, api, connectionId, mysqlId, setQueryRunning]);

  const handleExportActiveResult = useCallback(async (format: DatabaseExportFormat) => {
    if (!activeResult || activeResult.rows.length === 0) return;

    setMessage(null);

    try {
      const filePath = await exportDatabaseRows({
        sourceName: 'MySQL',
        format,
        columns: activeResult.columns,
        rows: activeResult.rows,
        fileBaseName: activeResultTab?.title,
        metadata: {
          database: activeResultTab?.database ?? '',
          sql: activeResultTab?.sql ?? '',
          queryTimeMs: activeResultTab?.queryTime ?? 0,
        },
      });

      if (filePath) {
        setMessage({ type: 'success', text: `查询结果已导出：${filePath}` });
      }
    } catch (error) {
      setMessage({ type: 'error', text: getErrorMessage(error) });
    }
  }, [activeResult, activeResultTab]);

  const handleCellEdit = useCallback((rowIndex: number, column: string, currentValue: unknown) => {
    if (!activeResultTab || !activeResult || !activeResultTab.table) {
      setMessage({ type: 'info', text: tCurrent('auto.remoteMySQL.6buiou') });
      return;
    }

    if (activeResultPrimaryKeys.length === 0) {
      setMessage({ type: 'info', text: tCurrent('auto.remoteMySQL.phmbzg') });
      return;
    }

    if (activeResultPrimaryKeys.includes(column)) {
      setMessage({ type: 'info', text: tCurrent('auto.remoteMySQL.16w0dof') });
      return;
    }

    setEditingCell({
      rowIndex,
      column,
      value: currentValue === null || currentValue === undefined ? '' : String(currentValue),
    });
  }, [activeResult, activeResultPrimaryKeys, activeResultTab]);

  const prepareCellSave = useCallback(() => {
    if (!editingCell || !activeResultTab?.result || !activeResultTab.table) return;

    const row = activeResultTab.result.rows[editingCell.rowIndex];
    if (!row) {
      setEditingCell(null);
      return;
    }

    const newValue = editingCell.value === '' ? null : editingCell.value;

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
    if (!pendingEdit || !api?.connections || !mysqlId) return;

    setEditSaving(true);
    setMessage(null);

    try {
      const result = await api.connections.mysqlUpdateCell(
        connectionId,
        mysqlId,
        pendingEdit.table.database,
        pendingEdit.table.name,
        pendingEdit.pkColumns[0],
        pendingEdit.pkValues[0],
        pendingEdit.column,
        pendingEdit.newValue,
        pendingEdit.pkColumns.length > 1 ? pendingEdit.pkColumns : undefined,
        pendingEdit.pkColumns.length > 1 ? pendingEdit.pkValues : undefined,
      );

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

      setMessage({
        type: result.affectedRows === 1 ? 'success' : 'info',
        text: tCurrent('auto.remoteMySQL.44ms0s', { value0: result.affectedRows }),
      });
      setPendingEdit(null);
    } catch (error) {
      setMessage({ type: 'error', text: getErrorMessage(error) });
    } finally {
      setEditSaving(false);
    }
  }, [api, connectionId, mysqlId, pendingEdit]);

  const handleCellKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      prepareCellSave();
    } else if (event.key === 'Escape') {
      setEditingCell(null);
    }
  }, [prepareCellSave]);

  const handleSqlKeyDown = useCallback((event: React.KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      void handleExecuteSql();
    }
  }, [handleExecuteSql]);

  useEffect(() => {
    mysqlIdRef.current = mysqlId;
  }, [mysqlId]);

  useEffect(() => {
    setPage(0);
    setEditingCell(null);
  }, [activeResultId]);

  useEffect(() => {
    if (isReady) {
      sqlRef.current?.focus();
    }
  }, [activeQueryId, isReady]);

  useEffect(() => {
    return () => {
      const currentMysqlId = mysqlIdRef.current;
      if (currentMysqlId && api?.connections) {
        api.connections.mysqlDisconnect(connectionId, currentMysqlId).catch(() => {});
      }
    };
  }, [api, connectionId]);

  if (!isReady) {
    return (
      <div className="mysql-connect-panel">
        <form
          className="mysql-connect-card"
          onSubmit={(event) => {
            event.preventDefault();
            void handleConnect();
          }}
        >
          <div className="mysql-connect-heading">
            <span className="mysql-connect-mark">SQL</span>
            <div>
              <h3>{tCurrent('auto.remoteMySQL.6w99hh')}</h3>
              <p className="mysql-connect-hint">{tCurrent('auto.remoteMySQL.o2b4fb')}</p>
            </div>
          </div>
          {errorMessage ? (
            <DismissibleAlert className="mysql-error-banner" onDismiss={() => setErrorMessage('')} role="alert">
              {errorMessage}
            </DismissibleAlert>
          ) : null}
          <div className="mysql-connect-grid">
            <label className="mysql-field">
              <span>{tCurrent('auto.remoteMySQL.5kj63k')}</span>
              <input
                type="text"
                value={host}
                onChange={(event) => setHost(event.target.value)}
                placeholder="127.0.0.1"
                disabled={status === 'connecting'}
              />
            </label>
            <label className="mysql-field">
              <span>{tCurrent('auto.remoteMySQL.19ijc5j')}</span>
              <input
                type="text"
                value={port}
                onChange={(event) => setPort(event.target.value)}
                placeholder="3306"
                disabled={status === 'connecting'}
              />
            </label>
          </div>
          <div className="mysql-connect-grid">
            <label className="mysql-field">
              <span>{tCurrent('auto.remoteMySQL.u9jq8n')}</span>
              <input
                type="text"
                value={user}
                onChange={(event) => setUser(event.target.value)}
                placeholder="root"
                disabled={status === 'connecting'}
              />
            </label>
            <label className="mysql-field">
              <span>{tCurrent('auto.remoteMySQL.aw16vy')}</span>
              <input
                type="text"
                value={initialDatabase}
                onChange={(event) => setInitialDatabase(event.target.value)}
                placeholder={tCurrent('auto.remoteMySQL.zflkxh')}
                disabled={status === 'connecting'}
              />
            </label>
          </div>
          <label className="mysql-field">
            <span>{tCurrent('auto.remoteMySQL.1aph6eg')}</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={tCurrent('auto.remoteMySQL.1g8lhz1')}
              disabled={status === 'connecting'}
            />
          </label>
          <div className="mysql-tunnel-note">
            <span>{tCurrent('auto.remoteMySQL.18eis48')}</span>
            <strong>{host || '127.0.0.1'}:{parseInt(port, 10) || defaultPort}</strong>
            <em>{tCurrent('auto.remoteMySQL.rbi1mz')}</em>
          </div>
          <button
            type="submit"
            className="mysql-connect-btn"
            disabled={status === 'connecting'}
          >
            {status === 'connecting' ? tCurrent('auto.remoteMySQL.1i0m8cf') : tCurrent('auto.remoteMySQL.5je50n')}
          </button>
        </form>
      </div>
    );
  }

  return (
    <>
      <div className="mysql-layout">
        <aside className="mysql-sidebar">
          <div className="mysql-sidebar-header">
            <div>
              <strong>{tCurrent('auto.remoteMySQL.dzec2g')}</strong>
              <span>{databases.length} {tCurrent('auto.remoteMySQL.1bg3e3c')}</span>
            </div>
            <button type="button" onClick={() => void refreshDatabases()} disabled={schemaLoading} title={tCurrent('auto.remoteMySQL.oj1z9s')}>
              {schemaLoading ? '...' : '↻'}
            </button>
          </div>
          <div className="mysql-object-search">
            <input
              type="search"
              value={objectSearch}
              onChange={(event) => setObjectSearch(event.target.value)}
              placeholder={tCurrent('auto.remoteMySQL.jj14o6')}
              spellCheck={false}
            />
            {objectSearch ? (
              <button type="button" onClick={() => setObjectSearch('')} title={tCurrent('auto.remoteMySQL.18bjen0')}>×</button>
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
                  >
                    <span className="mysql-tree-arrow">{expanded ? '▾' : '▸'}</span>
                    <span className="mysql-tree-icon">DB</span>
                    <span className="mysql-tree-name">{database}</span>
                    <span className="mysql-tree-count">{dbTables[database]?.length ?? '-'}</span>
                    <span
                      role="button"
                      tabIndex={0}
                      className="mysql-tree-refresh"
                      title={tCurrent('auto.remoteMySQL.tw6kuq')}
                      onClick={(event) => handleRefreshDatabase(database, event)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          handleRefreshDatabase(database);
                        }
                      }}
                    >
                      ↻
                    </span>
                  </button>
                  {expanded ? (
                    <div className="mysql-tree-tables">
                      {loading ? <div className="mysql-tree-loading">{tCurrent('auto.remoteMySQL.ldc0z9')}</div> : null}
                      {!loading && visibleTables.map((table) => (
                        <div key={table}>
                          <button
                            type="button"
                            className={`mysql-tree-table-btn ${selectedTable?.database === database && selectedTable.name === table ? 'selected' : ''}`}
                            onClick={() => void handleSelectTable(database, table)}
                          >
                            <span className="mysql-tree-icon">T</span>
                            <span className="mysql-tree-name">{table}</span>
                          </button>
                          {selectedTable?.database === database && selectedTable.name === table && tableColumns.length > 0 ? (
                            <div className="mysql-column-list">
                              {tableColumns.map((column) => (
                                <div key={column.name} className="mysql-column-item" title={column.comment || column.extra || column.type}>
                                  <span className="mysql-column-name">{column.name}</span>
                                  <span className="mysql-column-type">{column.type}</span>
                                  {column.key ? <span className="mysql-column-key">{column.key}</span> : null}
                                </div>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ))}
                      {!loading && dbTables[database] !== undefined && visibleTables.length === 0 ? (
                        <div className="mysql-tree-empty">{tCurrent('auto.remoteMySQL.1r39nj')}</div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
            {filteredDatabases.length === 0 ? <div className="mysql-tree-empty">{tCurrent('auto.remoteMySQL.1kuvtrp')}</div> : null}
          </div>
          <div className="mysql-history">
            <div className="mysql-history-title">
              <strong>{tCurrent('auto.remoteMySQL.air9hy')}</strong>
              <span>{history.length}</span>
            </div>
            <div className="mysql-history-list">
              {history.length === 0 ? (
                <div className="mysql-history-empty">{tCurrent('auto.remoteMySQL.mkpr6n')}</div>
              ) : history.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`mysql-history-item ${item.status}`}
                  onClick={() => handleUseHistory(item)}
                  title={item.sql}
                >
                  <span className="mysql-history-sql">{formatSqlPreview(item.sql, 34)}</span>
                  <span className="mysql-history-meta">
                    {formatTimestamp(item.createdAt)}
                    {item.status === 'success' ? ` · ${item.affectedRows !== undefined ? tCurrent('auto.remoteMySQL.1p5p2l4', { value0: item.affectedRows }) : tCurrent('auto.remoteMySQL.18tehe02', { value0: item.rowCount ?? 0 })}` : tCurrent('auto.remoteMySQL.gzim04')}
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
              <strong>{user || 'root'}@{host || '127.0.0.1'}:{parseInt(port, 10) || defaultPort}</strong>
              <span>{tCurrent('auto.remoteMySQL.1x0slnx')}{connectionId.slice(0, 8)}</span>
            </div>
            <div className="mysql-topbar-actions">
              <span className="mysql-active-db">{tCurrent('auto.remoteMySQL.la969c')}{activeDb || tCurrent('auto.remoteMySQL.1mhzgbz')}</span>
              <button type="button" className="mysql-disconnect-btn" onClick={() => void handleDisconnect()} title={tCurrent('auto.remoteMySQL.2kwd2d')}>{tCurrent('auto.remoteMySQL.a4u4dk')}</button>
            </div>
          </div>

          <section className="mysql-editor-area">
            <div className="mysql-query-tabs" role="tablist" aria-label={tCurrent('auto.remoteMySQL.1h2bmkv')}>
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
                  {tab.running ? <em>{tCurrent('auto.remoteMySQL.6svkbt')}</em> : null}
                  {queryTabs.length > 1 ? (
                    <span
                      role="button"
                      tabIndex={0}
                      className="mysql-tab-close"
                      onClick={(event) => handleCloseQueryTab(tab.id, event)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          handleCloseQueryTab(tab.id, event as unknown as React.MouseEvent);
                        }
                      }}
                    >
                      ×
                    </span>
                  ) : null}
                </button>
              ))}
              <button type="button" className="mysql-add-tab-btn" onClick={() => handleAddQueryTab()} title={tCurrent('auto.remoteMySQL.eplu7o')}>+</button>
            </div>
            <div className="mysql-editor-toolbar">
              <button
                type="button"
                className="mysql-run-btn"
                onClick={() => void handleExecuteSql()}
                disabled={!canRunActiveQuery}
              >
                {activeQueryTab?.running ? tCurrent('auto.remoteMySQL.e2byz1') : tCurrent('auto.remoteMySQL.6azgji')}
              </button>
              <span className="mysql-editor-hint">{tCurrent('auto.remoteMySQL.cj2ebw')}</span>
              <select
                className="mysql-db-select"
                value={activeDb}
                onChange={(event) => setActiveDb(event.target.value)}
                title={tCurrent('auto.remoteMySQL.1bytcvl')}
              >
                <option value="">{tCurrent('auto.remoteMySQL.1r2r2r8')}</option>
                {databases.map((database) => (
                  <option key={database} value={database}>{database}</option>
                ))}
              </select>
            </div>
            <textarea
              ref={sqlRef}
              className="mysql-sql-editor"
              value={activeQueryTab?.sql ?? ''}
              onChange={(event) => updateActiveQuerySql(event.target.value)}
              onKeyDown={handleSqlKeyDown}
              placeholder={tCurrent('auto.remoteMySQL.1bvo5bt')}
              spellCheck={false}
            />
          </section>

          <section className="mysql-result-area">
            {message ? (
              <DismissibleAlert
                className={`mysql-message-banner ${message.type}`}
                onDismiss={() => setMessage(null)}
                role={message.type === 'error' ? 'alert' : 'status'}
              >
                {message.text}
              </DismissibleAlert>
            ) : null}
            <div className="mysql-result-tabs">
              {resultTabs.length === 0 ? (
                <span className="mysql-result-tabs-empty">{tCurrent('auto.remoteMySQL.q9h21m')}</span>
              ) : resultTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className={`mysql-result-tab ${activeResultId === tab.id ? 'active' : ''} ${tab.status}`}
                  onClick={() => setActiveResultId(tab.id)}
                  title={tab.sql}
                >
                  <span>{tab.title}</span>
                  <em>{tab.status === 'success' && tab.result ? describeResult(tab.result) : tCurrent('auto.remoteMySQL.v9pftt')}</em>
                  <span
                    role="button"
                    tabIndex={0}
                    className="mysql-tab-close"
                    onClick={(event) => handleCloseResultTab(tab.id, event)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        handleCloseResultTab(tab.id, event as unknown as React.MouseEvent);
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
                <strong>{tCurrent('auto.remoteMySQL.15bfg2y')}</strong>
                <span>{tCurrent('auto.remoteMySQL.1se6un5')}{tablePreviewLimit} {tCurrent('auto.remoteMySQL.1q9izoa')}</span>
              </div>
            ) : activeResultTab.status === 'error' ? (
              <div className="mysql-result-error-panel">
                <strong>{tCurrent('auto.remoteMySQL.qoguk0')}</strong>
                <code>{formatSqlPreview(activeResultTab.sql, 120)}</code>
                <p>{activeResultTab.error}</p>
                <span>{activeResultTab.queryTime}ms · {formatTimestamp(activeResultTab.createdAt)}</span>
              </div>
            ) : activeResult ? (
              <>
                <div className={`mysql-result-info ${activeResult.affectedRows !== undefined ? 'write' : ''}`}>
                  <span>{describeResult(activeResult)}</span>
                  <span>{activeResultTab.queryTime}ms</span>
                  <span>{activeResultTab.subtitle}</span>
                  <span>
                    {isActiveResultEditable
                      ? tCurrent('auto.remoteMySQL.zacxkg', { value0: activeResultPrimaryKeys.join(', ') })
                      : activeResultTab.table ? tCurrent('auto.remoteMySQL.122vefz') : tCurrent('auto.remoteMySQL.g4u81i')}
                  </span>
                  <div className="database-export-actions" aria-label={tCurrent('db.query.exportAria')}>
                    <button type="button" className="database-export-button" onClick={() => void handleExportActiveResult('json')} disabled={activeResult.rows.length === 0}>{tCurrent('db.query.exportJson')}</button>
                    <button type="button" className="database-export-button" onClick={() => void handleExportActiveResult('csv')} disabled={activeResult.rows.length === 0}>{tCurrent('db.query.exportCsv')}</button>
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
                              return (
                                <th key={column}>
                                  <span className="mysql-col-name">{column}</span>
                                  {meta?.key ? <span className="mysql-col-key">{meta.key}</span> : null}
                                  {meta?.type ? <small>{meta.type}</small> : null}
                                </th>
                              );
                            })}
                          </tr>
                        </thead>
                        <tbody>
                          {pagedRows.map((row, rowIdx) => {
                            const globalRowIdx = page * pageSize + rowIdx;

                            return (
                              <tr key={globalRowIdx}>
                                <td className="mysql-row-num">{globalRowIdx + 1}</td>
                                {activeResult.columns.map((column) => {
                                  const cellValue = row[column];
                                  const isEditing = editingCell?.rowIndex === globalRowIdx && editingCell.column === column;
                                  const isEditableColumn = isActiveResultEditable && !activeResultPrimaryKeys.includes(column);

                                  if (isEditing) {
                                    return (
                                      <td key={column} className="mysql-cell-editing">
                                        <input
                                          type="text"
                                          value={editingCell.value}
                                          onChange={(event) => setEditingCell({ ...editingCell, value: event.target.value })}
                                          onKeyDown={handleCellKeyDown}
                                          onBlur={prepareCellSave}
                                          autoFocus
                                          className="mysql-cell-input"
                                        />
                                      </td>
                                    );
                                  }

                                  return (
                                    <td
                                      key={column}
                                      className={`${cellValue === null ? 'mysql-cell-null' : ''} ${isEditableColumn ? 'mysql-cell-editable' : ''}`}
                                      onDoubleClick={() => handleCellEdit(globalRowIdx, column, cellValue)}
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
                        <button type="button" disabled={page === 0} onClick={() => setPage(0)}>{tCurrent('auto.remoteMySQL.1ow5v10')}</button>
                        <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>{tCurrent('auto.remoteMySQL.mtyn6e')}</button>
                        <span>{page + 1} / {totalPages}</span>
                        <button type="button" disabled={page >= totalPages - 1} onClick={() => setPage(page + 1)}>{tCurrent('auto.remoteMySQL.1yw313l')}</button>
                        <button type="button" disabled={page >= totalPages - 1} onClick={() => setPage(totalPages - 1)}>{tCurrent('auto.remoteMySQL.ixvu31')}</button>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className="mysql-result-empty">
                    <strong>{tCurrent('auto.remoteMySQL.8p0dx3')}</strong>
                    <span>{tCurrent('auto.remoteMySQL.vpza2y')}</span>
                  </div>
                )}
              </>
            ) : null}
          </section>
        </main>
      </div>

      {pendingEdit ? createPortal(
        <div className="mysql-modal-backdrop" role="presentation">
          <div className="mysql-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="mysql-edit-title">
            <div className="mysql-edit-dialog-header">
              <strong id="mysql-edit-title">{tCurrent('auto.remoteMySQL.5pj76l')}</strong>
              <span>{pendingEdit.table.database}.{pendingEdit.table.name}</span>
            </div>
            <div className="mysql-edit-summary">
              <div>
                <span>{tCurrent('auto.remoteMySQL.vomz89')}</span>
                <strong>{pendingEdit.column}</strong>
              </div>
              <div>
                <span>{tCurrent('auto.remoteMySQL.12o2s46')}</span>
                <code>{formatCellValue(pendingEdit.oldValue)}</code>
              </div>
              <div>
                <span>{tCurrent('auto.remoteMySQL.1wg5cdl')}</span>
                <code>{formatCellValue(pendingEdit.newValue)}</code>
              </div>
              <div>
                <span>{tCurrent('auto.remoteMySQL.bxakay')}</span>
                <code>{pendingEdit.pkColumns.map((pkColumn, index) => `${pkColumn}=${formatCellValue(pendingEdit.pkValues[index])}`).join(' AND ')}</code>
              </div>
            </div>
            <p className="mysql-edit-warning">{tCurrent('auto.remoteMySQL.p32txr')}</p>
            <div className="mysql-edit-actions">
              <button type="button" onClick={() => setPendingEdit(null)} disabled={editSaving}>{tCurrent('auto.remoteMySQL.1589w37')}</button>
              <button type="button" className="primary" onClick={() => void handleConfirmCellSave()} disabled={editSaving}>
                {editSaving ? tCurrent('auto.remoteMySQL.xwkgei') : tCurrent('auto.remoteMySQL.1k3x0w3')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}

export default RemoteMySQL;
