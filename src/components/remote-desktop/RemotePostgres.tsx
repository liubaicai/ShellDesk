import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getErrorMessage } from './desktopUtils';

interface RemotePostgresProps {
  connectionId: string;
}

type PostgresStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

interface TableInfo {
  schema: string;
  name: string;
  type: string;
}

interface QueryHistoryItem {
  id: string;
  sql: string;
  status: 'success' | 'error';
  rowCount?: number;
  error?: string;
  durationMs: number;
  createdAt: string;
}

const tablePreviewLimit = 500;
const maxHistoryItems = 12;

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function quotePgIdentifier(identifier: string) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function formatCellValue(value: unknown) {
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

function createGenericColumns(names: string[]): ShellDeskPostgresColumn[] {
  return names.map((name) => ({
    name,
    dataType: '',
    nullable: true,
    defaultValue: null,
    isPrimaryKey: false,
  }));
}

function RemotePostgres({ connectionId }: RemotePostgresProps) {
  const api = window.guiSSH?.connections;
  const postgresIdRef = useRef('');
  const sqlRef = useRef<HTMLTextAreaElement | null>(null);
  const [status, setStatus] = useState<PostgresStatus>('disconnected');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [postgresId, setPostgresId] = useState('');
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState('5432');
  const [user, setUser] = useState('postgres');
  const [password, setPassword] = useState('');
  const [database, setDatabase] = useState('postgres');
  const [databases, setDatabases] = useState<string[]>([]);
  const [schemas, setSchemas] = useState<string[]>([]);
  const [expandedSchemas, setExpandedSchemas] = useState<Set<string>>(new Set());
  const [tablesBySchema, setTablesBySchema] = useState<Record<string, ShellDeskPostgresTable[]>>({});
  const [objectSearch, setObjectSearch] = useState('');
  const [selectedTable, setSelectedTable] = useState<TableInfo | null>(null);
  const [columns, setColumns] = useState<ShellDeskPostgresColumn[]>([]);
  const [sql, setSql] = useState('SELECT current_database(), now();');
  const [queryResult, setQueryResult] = useState<ShellDeskPostgresQueryResult | null>(null);
  const [queryColumns, setQueryColumns] = useState<ShellDeskPostgresColumn[]>([]);
  const [queryRunning, setQueryRunning] = useState(false);
  const [history, setHistory] = useState<QueryHistoryItem[]>([]);

  const isConnected = status === 'connected';

  const filteredSchemas = useMemo(() => {
    const keyword = objectSearch.trim().toLowerCase();
    return schemas
      .map((schema) => {
        const tables = tablesBySchema[schema] ?? [];
        if (!keyword) return { schema, tables };
        const schemaMatches = schema.toLowerCase().includes(keyword);
        const filteredTables = schemaMatches ? tables : tables.filter((table) => table.name.toLowerCase().includes(keyword));
        return { schema, tables: filteredTables };
      })
      .filter((group) => !keyword || group.schema.toLowerCase().includes(keyword) || group.tables.length > 0);
  }, [objectSearch, schemas, tablesBySchema]);

  const disconnect = useCallback(async () => {
    if (!api || !postgresIdRef.current) {
      return;
    }

    const currentId = postgresIdRef.current;
    postgresIdRef.current = '';
    await api.postgresDisconnect(connectionId, currentId).catch(() => false);
  }, [api, connectionId]);

  useEffect(() => () => {
    void disconnect();
  }, [disconnect]);

  const loadSchemas = useCallback(async (nextPostgresId: string) => {
    if (!api) return;

    const [nextDatabases, nextSchemas] = await Promise.all([
      api.postgresDatabases(connectionId, nextPostgresId),
      api.postgresSchemas(connectionId, nextPostgresId),
    ]);

    setDatabases(nextDatabases);
    setSchemas(nextSchemas);
    setExpandedSchemas(new Set(nextSchemas[0] ? [nextSchemas[0]] : []));
    if (nextSchemas[0]) {
      const tables = await api.postgresTables(connectionId, nextPostgresId, nextSchemas[0]);
      setTablesBySchema({ [nextSchemas[0]]: tables });
    }
  }, [api, connectionId]);

  const connect = async () => {
    if (!api) {
      setError('ShellDesk IPC 未就绪。');
      return;
    }

    setStatus('connecting');
    setError('');
    setNotice('');

    try {
      const result = await api.postgresConnect(connectionId, {
        host,
        port: Number.parseInt(port, 10) || 5432,
        user,
        password,
        database,
      });
      postgresIdRef.current = result.postgresId;
      setPostgresId(result.postgresId);
      await loadSchemas(result.postgresId);
      setStatus('connected');
      setNotice(result.alreadyConnected ? '已复用 PostgreSQL 连接。' : 'PostgreSQL 已连接。');
    } catch (error) {
      setStatus('error');
      setError(getErrorMessage(error));
    }
  };

  const handleDisconnect = async () => {
    await disconnect();
    setStatus('disconnected');
    setPostgresId('');
    setDatabases([]);
    setSchemas([]);
    setTablesBySchema({});
    setSelectedTable(null);
    setColumns([]);
    setQueryResult(null);
    setNotice('PostgreSQL 已断开。');
  };

  const toggleSchema = async (schema: string) => {
    if (!api || !postgresId) return;

    setExpandedSchemas((current) => {
      const next = new Set(current);
      if (next.has(schema)) next.delete(schema);
      else next.add(schema);
      return next;
    });

    if (!tablesBySchema[schema]) {
      try {
        const tables = await api.postgresTables(connectionId, postgresId, schema);
        setTablesBySchema((current) => ({ ...current, [schema]: tables }));
      } catch (error) {
        setError(getErrorMessage(error));
      }
    }
  };

  const runQuery = useCallback(async (nextSql = sql, table?: TableInfo) => {
    if (!api || !postgresId) return;
    const statement = nextSql.trim();
    if (!statement) {
      setError('请输入 SQL。');
      return;
    }

    setQueryRunning(true);
    setError('');
    setNotice('');
    const startedAt = performance.now();

    try {
      const result = await api.postgresQuery(connectionId, postgresId, statement);
      const durationMs = Math.round(performance.now() - startedAt);
      const nextColumns = table
        ? await api.postgresColumns(connectionId, postgresId, table.schema, table.name)
        : createGenericColumns(result.columns);
      const historyItem: QueryHistoryItem = {
        id: createId('pg-history'),
        sql: statement,
        status: 'success',
        rowCount: result.rowCount ?? result.rows.length,
        durationMs,
        createdAt: new Date().toLocaleTimeString('zh-CN'),
      };
      setQueryResult(result);
      setQueryColumns(nextColumns);
      setHistory((items) => [historyItem, ...items].slice(0, maxHistoryItems));
      setNotice(`查询完成，${result.rowCount ?? result.rows.length} 行，${durationMs} ms。`);
    } catch (error) {
      const durationMs = Math.round(performance.now() - startedAt);
      const message = getErrorMessage(error);
      const historyItem: QueryHistoryItem = {
        id: createId('pg-history'),
        sql: statement,
        status: 'error',
        error: message,
        durationMs,
        createdAt: new Date().toLocaleTimeString('zh-CN'),
      };
      setError(message);
      setHistory((items) => [historyItem, ...items].slice(0, maxHistoryItems));
    } finally {
      setQueryRunning(false);
    }
  }, [api, connectionId, postgresId, sql]);

  const selectTable = async (table: ShellDeskPostgresTable) => {
    if (!api || !postgresId) return;

    const tableInfo = { schema: table.schema, name: table.name, type: table.type };
    const previewSql = `SELECT * FROM ${quotePgIdentifier(table.schema)}.${quotePgIdentifier(table.name)} LIMIT ${tablePreviewLimit};`;
    setSelectedTable(tableInfo);
    setSql(previewSql);

    try {
      const nextColumns = await api.postgresColumns(connectionId, postgresId, table.schema, table.name);
      setColumns(nextColumns);
      await runQuery(previewSql, tableInfo);
    } catch (error) {
      setError(getErrorMessage(error));
    }
  };

  const handleSqlKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      void runQuery();
    }
  };

  if (!api) {
    return <section className="postgres-manager"><div className="postgres-placeholder">ShellDesk IPC 未就绪。</div></section>;
  }

  if (!isConnected) {
    return (
      <section className="postgres-manager">
        <div className="postgres-connect-panel">
          <div className="postgres-connect-card">
            <div className="postgres-connect-heading">
              <span className="postgres-connect-mark">PG</span>
              <div>
                <h3>连接 PostgreSQL</h3>
                <p>通过当前 SSH 连接建立隧道，默认连接 127.0.0.1:5432。</p>
              </div>
            </div>
            {error ? <div className="postgres-message error">{error}</div> : null}
            <div className="postgres-connect-grid">
              <label><span>主机</span><input value={host} onChange={(event) => setHost(event.target.value)} /></label>
              <label><span>端口</span><input value={port} inputMode="numeric" onChange={(event) => setPort(event.target.value)} /></label>
              <label><span>用户</span><input value={user} onChange={(event) => setUser(event.target.value)} /></label>
              <label><span>数据库</span><input value={database} onChange={(event) => setDatabase(event.target.value)} /></label>
              <label className="wide"><span>密码</span><input value={password} type="password" onChange={(event) => setPassword(event.target.value)} /></label>
            </div>
            <button type="button" className="postgres-connect-btn" onClick={connect} disabled={status === 'connecting'}>
              {status === 'connecting' ? '连接中' : '连接'}
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="postgres-manager">
      <aside className="postgres-sidebar">
        <div className="postgres-sidebar-head">
          <div>
            <strong>对象树</strong>
            <span>{database} · {databases.length} DB</span>
          </div>
          <button type="button" onClick={() => loadSchemas(postgresId)}>刷新</button>
        </div>
        <input className="postgres-object-search" value={objectSearch} onChange={(event) => setObjectSearch(event.target.value)} placeholder="搜索 schema / table" />
        <div className="postgres-object-tree">
          {filteredSchemas.map(({ schema, tables }) => (
            <div key={schema} className="postgres-schema-group">
              <button type="button" className="postgres-schema-btn" onClick={() => toggleSchema(schema)}>
                <span>{expandedSchemas.has(schema) ? '-' : '+'}</span>
                <strong>{schema}</strong>
                <em>{tablesBySchema[schema]?.length ?? 0}</em>
              </button>
              {expandedSchemas.has(schema) ? (
                <div className="postgres-table-list">
                  {(tablesBySchema[schema] ?? tables).map((table) => (
                    <button
                      key={`${table.schema}.${table.name}`}
                      type="button"
                      className={selectedTable?.schema === table.schema && selectedTable.name === table.name ? 'active' : ''}
                      onClick={() => selectTable(table)}
                    >
                      <span>{table.type === 'VIEW' ? 'V' : 'T'}</span>
                      <strong>{table.name}</strong>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </aside>

      <main className="postgres-main">
        <header className="postgres-topbar">
          <div className="postgres-connection-summary">
            <span className="postgres-status-dot" />
            <strong>{user}@{host}:{port}</strong>
            <span>{database}</span>
          </div>
          <button type="button" className="postgres-disconnect-btn" onClick={handleDisconnect}>断开</button>
        </header>

        {error ? <div className="postgres-message error">{error}</div> : null}
        {notice ? <div className="postgres-message info">{notice}</div> : null}

        <section className="postgres-editor">
          <div className="postgres-editor-toolbar">
            <span>Ctrl+Enter 执行</span>
            <button type="button" onClick={() => runQuery()} disabled={queryRunning}>{queryRunning ? '执行中' : '执行 SQL'}</button>
          </div>
          <textarea ref={sqlRef} value={sql} onChange={(event) => setSql(event.target.value)} onKeyDown={handleSqlKeyDown} spellCheck={false} />
        </section>

        <section className="postgres-result">
          <div className="postgres-result-head">
            <strong>结果</strong>
            <span>{queryResult ? `${queryResult.rows.length} 行` : '尚无结果'}</span>
          </div>
          {queryResult ? (
            <div className="postgres-table-wrap">
              <table className="postgres-data-table">
                <thead>
                  <tr>
                    <th>#</th>
                    {queryResult.columns.map((column) => {
                      const meta = queryColumns.find((item) => item.name === column);
                      return <th key={column}>{column}{meta?.isPrimaryKey ? <small>PK</small> : null}</th>;
                    })}
                  </tr>
                </thead>
                <tbody>
                  {queryResult.rows.slice(0, 200).map((row, rowIndex) => (
                    <tr key={`pg-row-${rowIndex}`}>
                      <td className="postgres-row-num">{rowIndex + 1}</td>
                      {queryResult.columns.map((column) => (
                        <td key={`${rowIndex}-${column}`} title={formatCellValue(row[column])}>{formatCellValue(row[column])}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="postgres-placeholder">执行 SQL 或选择表后显示结果。</div>
          )}
        </section>
      </main>

      <aside className="postgres-detail">
        <div className="postgres-detail-section">
          <strong>表结构</strong>
          {selectedTable ? <span>{selectedTable.schema}.{selectedTable.name}</span> : <span>未选择表</span>}
        </div>
        <div className="postgres-column-list">
          {columns.map((column) => (
            <div key={column.name} className="postgres-column-item">
              <strong>{column.name}</strong>
              <span>{column.dataType}{column.nullable ? '' : ' · NOT NULL'}{column.isPrimaryKey ? ' · PK' : ''}</span>
            </div>
          ))}
          {!columns.length ? <div className="postgres-placeholder small">暂无列信息。</div> : null}
        </div>
        <div className="postgres-detail-section">
          <strong>查询历史</strong>
          <span>{history.length} 条</span>
        </div>
        <div className="postgres-history-list">
          {history.map((item) => (
            <button key={item.id} type="button" className={item.status} onClick={() => setSql(item.sql)}>
              <strong>{item.sql.replace(/\s+/g, ' ').slice(0, 80)}</strong>
              <span>{item.createdAt} · {item.durationMs} ms{item.rowCount !== undefined ? ` · ${item.rowCount} 行` : ''}</span>
            </button>
          ))}
        </div>
      </aside>
    </section>
  );
}

export default RemotePostgres;
