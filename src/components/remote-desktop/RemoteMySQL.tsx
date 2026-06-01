import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import DismissibleAlert from './DismissibleAlert';

interface RemoteMySQLProps {
  connectionId: string;
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
const tablePreviewLimit = 500;
const maxResultTabs = 10;
const maxHistoryItems = 12;

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createQueryTab(index: number, sql = 'SELECT 1;'): MysqlQueryTab {
  return {
    id: createId('query'),
    title: `查询 ${index}`,
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
  if (!compact) return '空查询';
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
    const insertText = result.insertId ? ` · 插入 ID ${result.insertId}` : '';
    return `影响 ${result.affectedRows} 行${insertText}`;
  }
  return `${result.rows.length} 行`;
}

function RemoteMySQL({ connectionId }: RemoteMySQLProps) {
  const api = window.guiSSH;
  const initialQueryStateRef = useRef(createInitialQueryState());
  const mysqlIdRef = useRef('');
  const sqlRef = useRef<HTMLTextAreaElement | null>(null);

  const [status, setStatus] = useState<MysqlStatus>('disconnected');
  const [errorMessage, setErrorMessage] = useState('');
  const [message, setMessage] = useState<MysqlMessage | null>(null);
  const [mysqlId, setMysqlId] = useState('');
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState(String(defaultPort));
  const [user, setUser] = useState('root');
  const [password, setPassword] = useState('');
  const [initialDatabase, setInitialDatabase] = useState('');
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
      setMessage({ type: 'success', text: '对象列表已刷新。' });

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

    try {
      const result = await api.connections.mysqlConnect(connectionId, {
        host: host || '127.0.0.1',
        port: parseInt(port, 10) || defaultPort,
        user: user || 'root',
        password,
        database: initialDatabase.trim() || undefined,
      });

      setMysqlId(result.mysqlId);
      setStatus('connected');

      const dbs = await api.connections.mysqlDatabases(connectionId, result.mysqlId);
      const requestedDb = initialDatabase.trim();
      const nextActiveDb = requestedDb && dbs.includes(requestedDb) ? requestedDb : dbs[0] ?? '';
      const nextExpanded = nextActiveDb ? new Set([nextActiveDb]) : new Set<string>();
      const nextTables: Record<string, string[]> = {};

      if (nextActiveDb) {
        try {
          nextTables[nextActiveDb] = await api.connections.mysqlTables(connectionId, result.mysqlId, nextActiveDb);
        } catch {
          nextTables[nextActiveDb] = [];
        }
      }

      setDatabases(dbs);
      setActiveDb(nextActiveDb);
      setExpandedDbs(nextExpanded);
      setDbTables(nextTables);
      setMessage({
        type: 'success',
        text: `已通过 ${result.transport === 'ssh-exec' ? '远程 TCP 代理' : 'SSH 隧道'}连接到 ${user || 'root'}@${host || '127.0.0.1'}:${parseInt(port, 10) || defaultPort}。`,
      });
    } catch (error) {
      setStatus('error');
      setErrorMessage(getErrorMessage(error));
    }
  }, [api, connectionId, host, initialDatabase, password, port, user]);

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
        title: isWriteStatement(sqlText) ? '写操作结果' : formatSqlPreview(sqlText, 28),
        subtitle: database ? `库 ${database}` : '未指定库',
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
        setMessage({ type: 'success', text: `写操作已完成，影响 ${result.affectedRows} 行。` });
      }
    } catch (error) {
      const queryTime = Math.round(performance.now() - startTime);
      const text = getErrorMessage(error);

      addResultTab({
        id: createId('result'),
        title: '查询错误',
        subtitle: database ? `库 ${database}` : '未指定库',
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

  const handleCellEdit = useCallback((rowIndex: number, column: string, currentValue: unknown) => {
    if (!activeResultTab || !activeResult || !activeResultTab.table) {
      setMessage({ type: 'info', text: '只有从左侧表对象打开的结果集支持单元格编辑，手写 SQL 结果保持只读。' });
      return;
    }

    if (activeResultPrimaryKeys.length === 0) {
      setMessage({ type: 'info', text: '当前表没有可识别主键，结果集保持只读。' });
      return;
    }

    if (activeResultPrimaryKeys.includes(column)) {
      setMessage({ type: 'info', text: '主键列不允许直接修改。' });
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
        text: `更新已提交，影响 ${result.affectedRows} 行。`,
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
              <h3>连接 MySQL 数据库</h3>
              <p className="mysql-connect-hint">经当前 SSH 会话转发到远程 MySQL 或兼容数据库</p>
            </div>
          </div>
          {errorMessage ? (
            <DismissibleAlert className="mysql-error-banner" onDismiss={() => setErrorMessage('')} role="alert">
              {errorMessage}
            </DismissibleAlert>
          ) : null}
          <div className="mysql-connect-grid">
            <label className="mysql-field">
              <span>主机</span>
              <input
                type="text"
                value={host}
                onChange={(event) => setHost(event.target.value)}
                placeholder="127.0.0.1"
                disabled={status === 'connecting'}
              />
            </label>
            <label className="mysql-field">
              <span>端口</span>
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
              <span>用户名</span>
              <input
                type="text"
                value={user}
                onChange={(event) => setUser(event.target.value)}
                placeholder="root"
                disabled={status === 'connecting'}
              />
            </label>
            <label className="mysql-field">
              <span>默认库</span>
              <input
                type="text"
                value={initialDatabase}
                onChange={(event) => setInitialDatabase(event.target.value)}
                placeholder="可选"
                disabled={status === 'connecting'}
              />
            </label>
          </div>
          <label className="mysql-field">
            <span>密码</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="留空表示无密码"
              disabled={status === 'connecting'}
            />
          </label>
          <div className="mysql-tunnel-note">
            <span>SSH 通道</span>
            <strong>{host || '127.0.0.1'}:{parseInt(port, 10) || defaultPort}</strong>
            <em>转发失败时会自动尝试远程 TCP 代理</em>
          </div>
          <button
            type="submit"
            className="mysql-connect-btn"
            disabled={status === 'connecting'}
          >
            {status === 'connecting' ? '连接中...' : '连接数据库'}
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
              <strong>对象浏览</strong>
              <span>{databases.length} 个数据库</span>
            </div>
            <button type="button" onClick={() => void refreshDatabases()} disabled={schemaLoading} title="刷新对象">
              {schemaLoading ? '...' : '↻'}
            </button>
          </div>
          <div className="mysql-object-search">
            <input
              type="search"
              value={objectSearch}
              onChange={(event) => setObjectSearch(event.target.value)}
              placeholder="搜索库或表"
              spellCheck={false}
            />
            {objectSearch ? (
              <button type="button" onClick={() => setObjectSearch('')} title="清空搜索">×</button>
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
                      title="刷新该库"
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
                      {loading ? <div className="mysql-tree-loading">加载中...</div> : null}
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
                        <div className="mysql-tree-empty">无匹配表</div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
            {filteredDatabases.length === 0 ? <div className="mysql-tree-empty">没有匹配的对象</div> : null}
          </div>
          <div className="mysql-history">
            <div className="mysql-history-title">
              <strong>查询历史</strong>
              <span>{history.length}</span>
            </div>
            <div className="mysql-history-list">
              {history.length === 0 ? (
                <div className="mysql-history-empty">执行查询后会记录在这里</div>
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
                    {item.status === 'success' ? ` · ${item.affectedRows !== undefined ? `影响 ${item.affectedRows}` : `${item.rowCount ?? 0} 行`}` : ' · 错误'}
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
              <span>经 SSH 连接 {connectionId.slice(0, 8)}</span>
            </div>
            <div className="mysql-topbar-actions">
              <span className="mysql-active-db">当前库: {activeDb || '未选择'}</span>
              <button type="button" className="mysql-disconnect-btn" onClick={() => void handleDisconnect()} title="断开连接">断开</button>
            </div>
          </div>

          <section className="mysql-editor-area">
            <div className="mysql-query-tabs" role="tablist" aria-label="SQL 查询标签">
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
                  {tab.running ? <em>执行中</em> : null}
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
              <button type="button" className="mysql-add-tab-btn" onClick={() => handleAddQueryTab()} title="新建查询">+</button>
            </div>
            <div className="mysql-editor-toolbar">
              <button
                type="button"
                className="mysql-run-btn"
                onClick={() => void handleExecuteSql()}
                disabled={!canRunActiveQuery}
              >
                {activeQueryTab?.running ? '执行中...' : '执行'}
              </button>
              <span className="mysql-editor-hint">Ctrl+Enter 执行</span>
              <select
                className="mysql-db-select"
                value={activeDb}
                onChange={(event) => setActiveDb(event.target.value)}
                title="选择查询默认库"
              >
                <option value="">未选择库</option>
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
              placeholder="输入 SQL 语句..."
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
                <span className="mysql-result-tabs-empty">结果</span>
              ) : resultTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className={`mysql-result-tab ${activeResultId === tab.id ? 'active' : ''} ${tab.status}`}
                  onClick={() => setActiveResultId(tab.id)}
                  title={tab.sql}
                >
                  <span>{tab.title}</span>
                  <em>{tab.status === 'success' && tab.result ? describeResult(tab.result) : '错误'}</em>
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
                <strong>选择表或执行 SQL</strong>
                <span>表预览默认限制 {tablePreviewLimit} 行；手写 SQL 结果默认只读。</span>
              </div>
            ) : activeResultTab.status === 'error' ? (
              <div className="mysql-result-error-panel">
                <strong>查询失败</strong>
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
                      ? `可编辑 · 主键 ${activeResultPrimaryKeys.join(', ')}`
                      : activeResultTab.table ? '只读 · 未识别主键' : '只读 · SQL 结果'}
                  </span>
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
                        <button type="button" disabled={page === 0} onClick={() => setPage(0)}>首页</button>
                        <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button>
                        <span>{page + 1} / {totalPages}</span>
                        <button type="button" disabled={page >= totalPages - 1} onClick={() => setPage(page + 1)}>下一页</button>
                        <button type="button" disabled={page >= totalPages - 1} onClick={() => setPage(totalPages - 1)}>末页</button>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className="mysql-result-empty">
                    <strong>查询已执行</strong>
                    <span>该语句没有返回表格数据。</span>
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
              <strong id="mysql-edit-title">确认更新单元格</strong>
              <span>{pendingEdit.table.database}.{pendingEdit.table.name}</span>
            </div>
            <div className="mysql-edit-summary">
              <div>
                <span>字段</span>
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
                <span>目标行</span>
                <code>{pendingEdit.pkColumns.map((pkColumn, index) => `${pkColumn}=${formatCellValue(pendingEdit.pkValues[index])}`).join(' AND ')}</code>
              </div>
            </div>
            <p className="mysql-edit-warning">更新会根据主键定位单行。请确认目标行和字段变化无误后再提交。</p>
            <div className="mysql-edit-actions">
              <button type="button" onClick={() => setPendingEdit(null)} disabled={editSaving}>取消</button>
              <button type="button" className="primary" onClick={() => void handleConfirmCellSave()} disabled={editSaving}>
                {editSaving ? '提交中...' : '确认更新'}
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
