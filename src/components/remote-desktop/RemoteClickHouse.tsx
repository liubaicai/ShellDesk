import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import DismissibleAlert from './DismissibleAlert';
import { loadRemoteConnectionProfile, readProfileBoolean, readProfileString, saveRemoteConnectionProfile } from './remoteConnectionProfiles';

interface RemoteClickHouseProps {
  connectionId: string;
  hostId: string;
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

const defaultHttpPort = 8123;
const defaultHttpsPort = 8443;
const pageSize = 100;
const tablePreviewLimit = 500;
const maxResultTabs = 10;
const maxHistoryItems = 12;

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createQueryTab(index: number, sql = 'SELECT version() AS version;'): ClickHouseQueryTab {
  return {
    id: createId('query'),
    title: `查询 ${index}`,
    sql,
    running: false,
  };
}

function createInitialQueryState(): { tabs: ClickHouseQueryTab[]; activeId: string } {
  const tab = createQueryTab(1);
  return { tabs: [tab], activeId: tab.id };
}

function quoteClickHouseIdentifier(identifier: string): string {
  return `\`${identifier.replace(/`/g, '``')}\``;
}

function formatSqlPreview(sql: string, length = 56): string {
  const compact = sql.replace(/\s+/g, ' ').trim();
  if (!compact) return '空 SQL';
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

function createGenericColumns(names: string[]): ShellDeskClickHouseColumn[] {
  return names.map((name) => ({
    name,
    type: '',
    defaultKind: '',
    defaultExpression: '',
    comment: '',
    isPrimaryKey: false,
    isSortingKey: false,
  }));
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

function isWriteStatement(sql: string): boolean {
  return /^\s*(insert|alter|drop|truncate|create|rename|attach|detach|optimize|kill|exchange)\b/i.test(sql);
}

function describeResult(result: ShellDeskClickHouseQueryResult): string {
  if (result.columns.length === 0) return '已执行';
  return `${formatCount(result.rowCount ?? result.rows.length)} 行`;
}

function describeStatistics(statistics?: ShellDeskClickHouseQueryStatistics): string {
  if (!statistics) return '';
  const parts = [
    statistics.rowsRead ? `读取 ${formatCount(statistics.rowsRead)} 行` : '',
    statistics.bytesRead ? formatBytes(statistics.bytesRead) : '',
  ].filter(Boolean);

  return parts.join(' · ');
}

function RemoteClickHouse({ connectionId, hostId }: RemoteClickHouseProps) {
  const api = window.guiSSH;
  const initialQueryStateRef = useRef(createInitialQueryState());
  const clickhouseIdRef = useRef('');
  const sqlRef = useRef<HTMLTextAreaElement | null>(null);

  const [status, setStatus] = useState<ClickHouseStatus>('disconnected');
  const [errorMessage, setErrorMessage] = useState('');
  const [message, setMessage] = useState<ClickHouseMessage | null>(null);
  const [clickhouseId, setClickhouseId] = useState('');
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState(String(defaultHttpPort));
  const [secure, setSecure] = useState(false);
  const [user, setUser] = useState('default');
  const [password, setPassword] = useState('');
  const [initialDatabase, setInitialDatabase] = useState('');
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
  const canRunActiveQuery = Boolean(activeQueryTab?.sql.trim()) && !activeQueryTab?.running;
  const displayPort = parseInt(port, 10) || (secure ? defaultHttpsPort : defaultHttpPort);
  const isNativeTcpPort = displayPort === 9000;

  useEffect(() => {
    let disposed = false;

    void loadRemoteConnectionProfile(hostId, 'clickhouse').then((profile) => {
      if (disposed || !profile) return;

      setHost(readProfileString(profile, 'host', '127.0.0.1'));
      setPort(readProfileString(profile, 'port', String(defaultHttpPort)));
      setUser(readProfileString(profile, 'user', 'default'));
      setPassword(readProfileString(profile, 'password', ''));
      setInitialDatabase(readProfileString(profile, 'initialDatabase', ''));
      setSecure(readProfileBoolean(profile, 'secure', false));
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
    setPage(0);
    setMessage(null);
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
      setMessage({ type: 'success', text: 'ClickHouse 元数据已刷新。' });

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

    try {
      const result = await api.connections.clickhouseConnect(connectionId, {
        host: host || '127.0.0.1',
        port: displayPort,
        user: user || 'default',
        password,
        database: initialDatabase.trim() || undefined,
        secure,
      });

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

      const dbs = await api.connections.clickhouseDatabases(connectionId, result.clickhouseId);
      const requestedDb = initialDatabase.trim();
      const nextActiveDb = requestedDb && dbs.includes(requestedDb)
        ? requestedDb
        : dbs.includes('default')
          ? 'default'
          : dbs[0] ?? '';
      const nextExpanded = nextActiveDb ? new Set([nextActiveDb]) : new Set<string>();
      const nextTables: Record<string, ShellDeskClickHouseTable[]> = {};

      if (nextActiveDb) {
        try {
          nextTables[nextActiveDb] = await api.connections.clickhouseTables(connectionId, result.clickhouseId, nextActiveDb);
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
        text: `已通过 ${result.transport === 'ssh-exec' ? '远程 TCP 代理' : 'SSH 隧道'} 连接 ${user || 'default'}@${host || '127.0.0.1'}:${displayPort}。`,
      });
    } catch (error) {
      setStatus('error');
      setErrorMessage(getErrorMessage(error));
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
    const previewSql = `SELECT * FROM ${quoteClickHouseIdentifier(database)}.${quoteClickHouseIdentifier(table.name)} LIMIT ${tablePreviewLimit};`;
    const startTime = performance.now();

    setSelectedTable(tableInfo);
    setActiveDb(database);
    setMessage(null);
    setPage(0);
    updateActiveQuerySql(previewSql);

    try {
      const cols = await api.connections.clickhouseColumns(connectionId, clickhouseId, database, table.name);
      setTableColumns(cols);

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
        columns: cols,
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

  const handleExecuteSql = useCallback(async () => {
    if (!api?.connections || !clickhouseId || !activeQueryTab?.sql.trim()) return;

    const sqlText = activeQueryTab.sql.trim();
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
        title: isWriteStatement(sqlText) ? '写入语句' : formatSqlPreview(sqlText, 28),
        subtitle: database ? `数据库：${database}` : '未指定数据库',
        sql: sqlText,
        database,
        status: 'success',
        result,
        queryTime,
        createdAt: Date.now(),
        columns: createGenericColumns(result.columns),
      });
      addHistoryItem({
        sql: sqlText,
        database,
        status: 'success',
        queryTime,
        rowCount,
      });

      if (result.columns.length === 0) {
        setMessage({ type: 'success', text: 'ClickHouse 语句已执行。' });
      }
    } catch (error) {
      const queryTime = Math.round(performance.now() - startTime);
      const text = getErrorMessage(error);

      addResultTab({
        id: createId('result'),
        title: '查询失败',
        subtitle: database ? `数据库：${database}` : '未指定数据库',
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

  const handleSqlKeyDown = useCallback((event: React.KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      void handleExecuteSql();
    }
  }, [handleExecuteSql]);

  useEffect(() => {
    clickhouseIdRef.current = clickhouseId;
  }, [clickhouseId]);

  useEffect(() => {
    setPage(0);
  }, [activeResultId]);

  useEffect(() => {
    if (isReady) {
      sqlRef.current?.focus();
    }
  }, [activeQueryId, isReady]);

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
                <h3>连接 ClickHouse</h3>
                <p className="mysql-connect-hint">通过当前 SSH 会话转发到远程 ClickHouse HTTP 接口</p>
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
                <span>HTTP 端口</span>
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
                <span>用户名</span>
                <input
                  type="text"
                  value={user}
                  onChange={(event) => setUser(event.target.value)}
                  placeholder="default"
                  disabled={status === 'connecting'}
                />
              </label>
              <label className="mysql-field">
                <span>默认数据库</span>
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
              <span>密码</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="可留空"
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
              <span>远程目标</span>
              <strong>{secure ? 'https' : 'http'}://{host || '127.0.0.1'}:{displayPort}</strong>
              <em>通过当前 SSH 连接访问，不暴露到本机网络外</em>
            </div>
            {isNativeTcpPort ? (
              <div className="clickhouse-port-warning" role="status">
                9000 是 ClickHouse 原生 TCP 端口；本组件使用 HTTP 接口，请改用 8123，或开启 HTTPS / TLS 后使用 8443。
              </div>
            ) : null}
            <button
              type="submit"
              className="mysql-connect-btn"
              disabled={status === 'connecting'}
            >
              {status === 'connecting' ? '连接中...' : '连接数据库'}
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
              <strong>对象浏览</strong>
              <span>{databases.length} 个数据库</span>
            </div>
            <button type="button" onClick={() => void refreshDatabases()} disabled={schemaLoading} title="刷新数据库列表">
              {schemaLoading ? '...' : '↻'}
            </button>
          </div>
          <div className="mysql-object-search">
            <input
              type="search"
              value={objectSearch}
              onChange={(event) => setObjectSearch(event.target.value)}
              placeholder="搜索数据库、表或引擎"
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
                      title="刷新此数据库"
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
                      {loading ? <div className="mysql-tree-loading">加载表...</div> : null}
                      {!loading && visibleTables.map((table) => {
                        const tableMeta = [table.engine, formatCount(table.totalRows)].filter((value) => value && value !== '-').join(' · ');
                        return (
                          <div key={table.name}>
                            <button
                              type="button"
                              className={`mysql-tree-table-btn ${selectedTable?.database === database && selectedTable.name === table.name ? 'selected' : ''}`}
                              onClick={() => void handleSelectTable(database, table)}
                              title={tableMeta || table.name}
                            >
                              <span className="mysql-tree-icon">T</span>
                              <span className="mysql-tree-name">{table.name}</span>
                              {table.engine ? <span className="clickhouse-table-engine">{table.engine}</span> : null}
                            </button>
                            {selectedTable?.database === database && selectedTable.name === table.name && tableColumns.length > 0 ? (
                              <div className="mysql-column-list">
                                {tableColumns.map((column) => {
                                  const badge = getColumnBadge(column);
                                  return (
                                    <div key={column.name} className="mysql-column-item" title={column.comment || column.defaultExpression || column.type}>
                                      <span className="mysql-column-name">{column.name}</span>
                                      <span className="mysql-column-type">{column.type}</span>
                                      {badge ? <span className="mysql-column-key">{badge}</span> : null}
                                    </div>
                                  );
                                })}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                      {!loading && dbTables[database] !== undefined && visibleTables.length === 0 ? (
                        <div className="mysql-tree-empty">没有匹配的表</div>
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
              <strong>执行历史</strong>
              <span>{history.length}</span>
            </div>
            <div className="mysql-history-list">
              {history.length === 0 ? (
                <div className="mysql-history-empty">暂无历史</div>
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
                    {item.status === 'success' ? ` · ${formatCount(item.rowCount ?? 0)} 行` : ' · 失败'}
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
              <span>连接 {connectionId.slice(0, 8)}</span>
            </div>
            <div className="mysql-topbar-actions">
              <span className="mysql-active-db">当前数据库：{activeDb || '未选择'}</span>
              <button type="button" className="mysql-disconnect-btn" onClick={() => void handleDisconnect()} title="断开 ClickHouse">
                断开
              </button>
            </div>
          </div>

          <section className="mysql-editor-area">
            <div className="mysql-query-tabs" role="tablist" aria-label="ClickHouse 查询标签">
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
                  {tab.running ? <em>运行中</em> : null}
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
              <button type="button" className="mysql-add-tab-btn" onClick={() => handleAddQueryTab()} title="新建查询">+</button>
            </div>
            <div className="mysql-editor-toolbar">
              <button
                type="button"
                className="mysql-run-btn"
                onClick={() => void handleExecuteSql()}
                disabled={!canRunActiveQuery}
              >
                {activeQueryTab?.running ? '执行中...' : '运行'}
              </button>
              <span className="mysql-editor-hint">Ctrl/⌘ + Enter</span>
              <select
                className="mysql-db-select"
                value={activeDb}
                onChange={(event) => setActiveDb(event.target.value)}
                title="选择查询默认数据库"
              >
                <option value="">未选择数据库</option>
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
              placeholder="SELECT * FROM system.tables LIMIT 20;"
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
                <span className="mysql-result-tabs-empty">结果会显示在这里</span>
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
                <strong>选择表或运行 SQL</strong>
                <span>表预览默认读取前 {tablePreviewLimit} 行</span>
              </div>
            ) : activeResultTab.status === 'error' ? (
              <div className="mysql-result-error-panel">
                <strong>执行失败</strong>
                <code>{formatSqlPreview(activeResultTab.sql, 120)}</code>
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
                  <span>{activeResultTab.table ? '表预览只读' : '结果集只读'}</span>
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
                              return (
                                <th key={column}>
                                  <span className="mysql-col-name">{column}</span>
                                  {badge ? <span className="mysql-col-key">{badge}</span> : null}
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

                                  return (
                                    <td
                                      key={column}
                                      className={cellValue === null ? 'mysql-cell-null' : ''}
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
                    <strong>没有结果集</strong>
                    <span>ClickHouse 已返回空响应或语句不产生行数据</span>
                  </div>
                )}
              </>
            ) : null}
          </section>
        </main>
      </div>
    </div>
  );
}

export default RemoteClickHouse;
