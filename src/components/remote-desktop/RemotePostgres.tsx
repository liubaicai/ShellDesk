import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import { exportDatabaseRows, type DatabaseExportFormat } from './databaseExport';
import DismissibleAlert from './DismissibleAlert';
import { loadRemoteConnectionProfile, readProfileString, saveRemoteConnectionProfile } from './remoteConnectionProfiles';
import { tCurrent } from '../../i18n';

interface RemotePostgresProps {
  connectionId: string;
  hostId: string;
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

type PostgresContextMenuTarget =
  | { type: 'database'; database: string }
  | { type: 'table'; table: ShellDeskPostgresTable };

interface PostgresContextMenuState {
  x: number;
  y: number;
  target: PostgresContextMenuTarget;
}

const tablePreviewLimit = 50;
const maxHistoryItems = 12;
const defaultPort = 5432;

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function quotePgIdentifier(identifier: string) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function quotePgString(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
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

function RemotePostgres({ connectionId, hostId }: RemotePostgresProps) {
  const api = window.guiSSH?.connections;
  const postgresIdRef = useRef('');
  const sqlRef = useRef<HTMLTextAreaElement | null>(null);
  const [status, setStatus] = useState<PostgresStatus>('disconnected');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [postgresId, setPostgresId] = useState('');
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState(String(defaultPort));
  const [user, setUser] = useState('postgres');
  const [password, setPassword] = useState('');
  const [database, setDatabase] = useState('postgres');
  const [databases, setDatabases] = useState<string[]>([]);
  const [schemas, setSchemas] = useState<string[]>([]);
  const [expandedSchemas, setExpandedSchemas] = useState<Set<string>>(new Set());
  const [tablesBySchema, setTablesBySchema] = useState<Record<string, ShellDeskPostgresTable[]>>({});
  const [objectSearch, setObjectSearch] = useState('');
  const [selectedTable, setSelectedTable] = useState<TableInfo | null>(null);
  const [sql, setSql] = useState('SELECT current_database(), now();');
  const [queryResult, setQueryResult] = useState<ShellDeskPostgresQueryResult | null>(null);
  const [queryColumns, setQueryColumns] = useState<ShellDeskPostgresColumn[]>([]);
  const [queryRunning, setQueryRunning] = useState(false);
  const [history, setHistory] = useState<QueryHistoryItem[]>([]);
  const [contextMenu, setContextMenu] = useState<PostgresContextMenuState | null>(null);

  const isConnected = status === 'connected';

  useEffect(() => {
    let disposed = false;

    void loadRemoteConnectionProfile(hostId, 'postgres').then((profile) => {
      if (disposed || !profile) return;

      setHost(readProfileString(profile, 'host', '127.0.0.1'));
      setPort(readProfileString(profile, 'port', String(defaultPort)));
      setUser(readProfileString(profile, 'user', 'postgres'));
      setPassword(readProfileString(profile, 'password', ''));
      setDatabase(readProfileString(profile, 'database', 'postgres'));
    });

    return () => {
      disposed = true;
    };
  }, [hostId]);

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

    setTablesBySchema({});
    setSelectedTable(null);
    const [nextDatabases, nextSchemas] = await Promise.all([
      api.postgresDatabases(connectionId, nextPostgresId),
      api.postgresSchemas(connectionId, nextPostgresId),
    ]);

    setDatabases(nextDatabases);
    setSchemas(nextSchemas);
    const initialSchema = nextSchemas.includes('public') ? 'public' : nextSchemas[0];
    setExpandedSchemas(new Set(initialSchema ? [initialSchema] : []));
    if (initialSchema) {
      const tables = await api.postgresTables(connectionId, nextPostgresId, initialSchema);
      setTablesBySchema({ [initialSchema]: tables });
    } else {
      setTablesBySchema({});
    }
  }, [api, connectionId]);

  const openPostgresDatabase = async (nextDb: string, initial = false) => {
    if (!api) {
      setError(tCurrent('auto.remotePostgres.g77vf3'));
      return;
    }

    const targetDb = nextDb || 'postgres';
    const previousPostgresId = postgresIdRef.current;
    if (!initial && previousPostgresId && targetDb === database) {
      await loadSchemas(previousPostgresId);
      return;
    }

    if (initial) {
      setStatus('connecting');
    }
    setError('');
    setNotice(initial ? '' : `正在切换数据库：${targetDb}`);

    let createdPostgresId = '';
    try {
      const nextPort = Number.parseInt(port, 10) || defaultPort;
      const result = await api.postgresConnect(connectionId, {
        mode: 'auto',
        host: host || '127.0.0.1',
        port: nextPort,
        user,
        password,
        database: targetDb,
      });
      createdPostgresId = result.postgresId;
      postgresIdRef.current = result.postgresId;
      setPostgresId(result.postgresId);
      setDatabase(targetDb);
      void saveRemoteConnectionProfile(hostId, 'postgres', {
        host: host || '127.0.0.1',
        port: String(nextPort),
        user: user || 'postgres',
        password,
        database: targetDb,
      }).catch(() => undefined);
      await loadSchemas(result.postgresId);
      if (previousPostgresId && previousPostgresId !== result.postgresId) {
        await api.postgresDisconnect(connectionId, previousPostgresId).catch(() => false);
      }
      setStatus('connected');
      setNotice(tCurrent(result.alreadyConnected ? 'postgres.connection.reused' : 'postgres.connection.success', {
        transport: result.transport === 'direct'
          ? tCurrent('db.transport.direct')
          : result.transport === 'ssh-exec'
            ? tCurrent('db.transport.remoteTcpProxy')
            : tCurrent('db.transport.sshTunnel'),
        user: user || 'postgres',
        host: host || '127.0.0.1',
        port: nextPort,
        database: targetDb,
      }));
    } catch (error) {
      if (createdPostgresId) {
        try {
          await api.postgresDisconnect(connectionId, createdPostgresId);
        } catch {
          // ignore cleanup errors after partial connect failure
        }
      }
      if (previousPostgresId) {
        postgresIdRef.current = previousPostgresId;
        setPostgresId(previousPostgresId);
        setStatus('connected');
      } else if (postgresIdRef.current === createdPostgresId) {
        postgresIdRef.current = '';
        setPostgresId((current) => (current === createdPostgresId ? '' : current));
        setStatus('error');
      }
      setError(getErrorMessage(error));
    }
  };

  const connect = async () => {
    await openPostgresDatabase(database || 'postgres', true);
  };

  const handleDisconnect = async () => {
    await disconnect();
    setStatus('disconnected');
    setPostgresId('');
    setDatabases([]);
    setSchemas([]);
    setTablesBySchema({});
    setSelectedTable(null);
    setQueryResult(null);
    setContextMenu(null);
    setNotice(tCurrent('auto.remotePostgres.tn34oa'));
  };

  const toggleSchema = async (schema: string) => {
    if (!api || !postgresId) return;

    setExpandedSchemas((current) => {
      const next = new Set(current);
      if (next.has(schema)) next.delete(schema);
      else next.add(schema);
      return next;
    });

    if (!tablesBySchema[schema] || tablesBySchema[schema].length === 0) {
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
      setError(tCurrent('auto.remotePostgres.18it23g'));
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
        createdAt: new Date().toLocaleTimeString(getShellDeskLocale()),
      };
      setQueryResult(result);
      setQueryColumns(nextColumns);
      setHistory((items) => [historyItem, ...items].slice(0, maxHistoryItems));
      setNotice(tCurrent('auto.remotePostgres.12l7rw3', { value0: result.rowCount ?? result.rows.length, value1: durationMs }));
    } catch (error) {
      const durationMs = Math.round(performance.now() - startedAt);
      const message = getErrorMessage(error);
      const historyItem: QueryHistoryItem = {
        id: createId('pg-history'),
        sql: statement,
        status: 'error',
        error: message,
        durationMs,
        createdAt: new Date().toLocaleTimeString(getShellDeskLocale()),
      };
      setError(message);
      setHistory((items) => [historyItem, ...items].slice(0, maxHistoryItems));
    } finally {
      setQueryRunning(false);
    }
  }, [api, connectionId, postgresId, sql]);

  const exportQueryResult = useCallback(async (format: DatabaseExportFormat) => {
    if (!queryResult || queryResult.rows.length === 0) return;

    setError('');
    setNotice('');

    try {
      const filePath = await exportDatabaseRows({
        sourceName: 'PostgreSQL',
        format,
        columns: queryResult.columns,
        rows: queryResult.rows,
        fileBaseName: selectedTable ? `${selectedTable.schema}-${selectedTable.name}` : database,
        metadata: {
          database,
          table: selectedTable ? `${selectedTable.schema}.${selectedTable.name}` : '',
          sql,
          rowCount: queryResult.rowCount ?? queryResult.rows.length,
        },
      });

      if (filePath) {
        setNotice(`查询结果已导出：${filePath}`);
      }
    } catch (error) {
      setError(getErrorMessage(error));
    }
  }, [database, queryResult, selectedTable, sql]);

  const selectTable = async (table: ShellDeskPostgresTable) => {
    if (!api || !postgresId) return;

    const tableInfo = { schema: table.schema, name: table.name, type: table.type };
    const previewSql = `SELECT * FROM ${quotePgIdentifier(table.schema)}.${quotePgIdentifier(table.name)} LIMIT ${tablePreviewLimit};`;
    setSelectedTable(tableInfo);
    setSql(previewSql);

    await runQuery(previewSql, tableInfo);
  };

  const showDatabaseInfo = useCallback(() => {
    const infoSql = [
      'SELECT',
      '  current_database() AS "数据库",',
      '  pg_encoding_to_char(encoding) AS "编码",',
      '  datcollate AS "排序规则",',
      '  pg_size_pretty(pg_database_size(datname)) AS "大小"',
      'FROM pg_database',
      `WHERE datname = current_database();`,
    ].join('\n');
    setContextMenu(null);
    setSelectedTable(null);
    setSql(infoSql);
    void runQuery(infoSql);
  }, [runQuery]);

  const showTableStructure = useCallback(async (table: ShellDeskPostgresTable) => {
    if (!api || !postgresId) return;

    const tableInfo = { schema: table.schema, name: table.name, type: table.type };
    const structureSql = [
      'SELECT column_name, data_type, is_nullable, column_default',
      'FROM information_schema.columns',
      `WHERE table_schema = ${quotePgString(table.schema)}`,
      `  AND table_name = ${quotePgString(table.name)}`,
      'ORDER BY ordinal_position;',
    ].join('\n');
    const startedAt = performance.now();

    setContextMenu(null);
    setSelectedTable(tableInfo);
    setSql(structureSql);
    setQueryRunning(true);
    setError('');
    setNotice('');

    try {
      const nextColumns = await api.postgresColumns(connectionId, postgresId, table.schema, table.name);
      const durationMs = Math.round(performance.now() - startedAt);
      const result: ShellDeskPostgresQueryResult = {
        columns: ['字段', '类型', '可空', '主键', '默认值'],
        rows: nextColumns.map((column) => ({
          字段: column.name,
          类型: column.dataType,
          可空: column.nullable ? 'YES' : 'NO',
          主键: column.isPrimaryKey ? 'YES' : '',
          默认值: column.defaultValue ?? null,
        })),
        rowCount: nextColumns.length,
      };
      setQueryResult(result);
      setQueryColumns(createGenericColumns(result.columns));
      const historyItem: QueryHistoryItem = {
        id: createId('pg-history'),
        sql: structureSql,
        status: 'success',
        rowCount: nextColumns.length,
        durationMs,
        createdAt: new Date().toLocaleTimeString(getShellDeskLocale()),
      };
      setHistory((items) => [historyItem, ...items].slice(0, maxHistoryItems));
      setNotice(`表结构已加载：${table.schema}.${table.name}`);
    } catch (error) {
      const durationMs = Math.round(performance.now() - startedAt);
      const message = getErrorMessage(error);
      setError(message);
      const historyItem: QueryHistoryItem = {
        id: createId('pg-history'),
        sql: structureSql,
        status: 'error',
        error: message,
        durationMs,
        createdAt: new Date().toLocaleTimeString(getShellDeskLocale()),
      };
      setHistory((items) => [historyItem, ...items].slice(0, maxHistoryItems));
    } finally {
      setQueryRunning(false);
    }
  }, [api, connectionId, postgresId]);

  const openDatabaseContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      target: { type: 'database', database },
    });
  }, [database]);

  const openTableContextMenu = useCallback((event: React.MouseEvent, table: ShellDeskPostgresTable) => {
    event.preventDefault();
    event.stopPropagation();
    setSelectedTable({ schema: table.schema, name: table.name, type: table.type });
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      target: { type: 'table', table },
    });
  }, []);

  const handleContextMenuAction = useCallback((action: 'database-info' | 'query-table' | 'table-structure') => {
    const target = contextMenu?.target;
    setContextMenu(null);
    if (!target) return;

    if (action === 'database-info' && target.type === 'database') {
      showDatabaseInfo();
      return;
    }

    if (target.type !== 'table') return;
    if (action === 'query-table') {
      void selectTable(target.table);
    } else if (action === 'table-structure') {
      void showTableStructure(target.table);
    }
  }, [contextMenu, showDatabaseInfo, showTableStructure]);

  useEffect(() => {
    if (!contextMenu) return undefined;

    const close = () => setContextMenu(null);
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };

    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [contextMenu]);

  const handleSqlKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      void runQuery();
    }
  };

  if (!api) {
    return <section className="postgres-manager"><div className="postgres-placeholder">{tCurrent('auto.remotePostgres.g77vf32')}</div></section>;
  }

  if (!isConnected) {
    return (
      <section className="postgres-manager">
        <div className="postgres-connect-panel">
          <div className="postgres-connect-card">
            <div className="postgres-connect-heading">
              <span className="postgres-connect-mark">PG</span>
              <div>
                <h3>{tCurrent('auto.remotePostgres.1vq1xxi')}</h3>
                <p>{tCurrent('auto.remotePostgres.11xsnap')}</p>
              </div>
            </div>
            {error ? (
              <DismissibleAlert className="postgres-message error" onDismiss={() => setError('')} role="alert">
                {error}
              </DismissibleAlert>
            ) : null}
            <div className="postgres-connect-grid">
              <label><span>{tCurrent('auto.remotePostgres.5kj63k')}</span><input value={host} onChange={(event) => setHost(event.target.value)} /></label>
              <label><span>{tCurrent('auto.remotePostgres.19ijc5j')}</span><input value={port} inputMode="numeric" onChange={(event) => setPort(event.target.value)} /></label>
              <label><span>{tCurrent('auto.remotePostgres.1in002o')}</span><input value={user} onChange={(event) => setUser(event.target.value)} /></label>
              <label><span>{tCurrent('auto.remotePostgres.tnjvy8')}</span><input value={database} onChange={(event) => setDatabase(event.target.value)} /></label>
              <label className="wide"><span>{tCurrent('auto.remotePostgres.1aph6eg')}</span><input value={password} type="password" onChange={(event) => setPassword(event.target.value)} /></label>
            </div>
            <button type="button" className="postgres-connect-btn" onClick={connect} disabled={status === 'connecting'}>
              {status === 'connecting' ? tCurrent('auto.remotePostgres.h7vocz') : tCurrent('auto.remotePostgres.8l8re4')}
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
          <div onContextMenu={openDatabaseContextMenu}>
            <strong>{tCurrent('auto.remotePostgres.1r1l7i2')}</strong>
            <span>{database} · {databases.length} DB</span>
          </div>
          <button type="button" onClick={() => loadSchemas(postgresId)}>{tCurrent('auto.remotePostgres.12qo56a')}</button>
        </div>
        {databases.length > 0 ? (
          <div className="postgres-database-list" aria-label="PostgreSQL 数据库">
            {databases.map((item) => (
              <button
                key={item}
                type="button"
                className={`postgres-database-btn ${item === database ? 'active' : ''}`}
                onClick={() => void openPostgresDatabase(item)}
                disabled={item === database}
                title={item}
              >
                <span>DB</span>
                <strong>{item}</strong>
              </button>
            ))}
          </div>
        ) : null}
        <input className="postgres-object-search" value={objectSearch} onChange={(event) => setObjectSearch(event.target.value)} placeholder={tCurrent('auto.remotePostgres.1ymokwb')} />
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
                      onContextMenu={(event) => openTableContextMenu(event, table)}
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
        <div className="postgres-history">
          <div className="postgres-history-title">
            <strong>{tCurrent('auto.remotePostgres.air9hy')}</strong>
            <span>{history.length}</span>
          </div>
          <div className="postgres-history-list">
            {history.length === 0 ? (
              <div className="postgres-history-empty">{tCurrent('auto.remotePostgres.mkpr6n')}</div>
            ) : history.map((item) => (
              <button key={item.id} type="button" className={item.status} onClick={() => setSql(item.sql)} title={item.sql}>
                <strong>{item.sql.replace(/\s+/g, ' ').slice(0, 80)}</strong>
                <span>{item.createdAt} · {item.durationMs} ms{item.rowCount !== undefined ? tCurrent('auto.remotePostgres.b3e9gx', { value0: item.rowCount }) : ''}</span>
              </button>
            ))}
          </div>
        </div>
      </aside>

      <main className="postgres-main">
        <header className="postgres-topbar">
          <div className="postgres-connection-summary">
            <span className="postgres-status-dot" />
            <strong>{user}@{host}:{port}</strong>
            <span>{database}</span>
          </div>
          <button type="button" className="postgres-disconnect-btn" onClick={handleDisconnect}>{tCurrent('auto.remotePostgres.a4u4dk')}</button>
        </header>

        {error ? (
          <DismissibleAlert className="postgres-message error" onDismiss={() => setError('')} role="alert">
            {error}
          </DismissibleAlert>
        ) : null}
        {notice ? (
          <DismissibleAlert className="postgres-message info" onDismiss={() => setNotice('')}>
            {notice}
          </DismissibleAlert>
        ) : null}

        <section className="postgres-editor">
          <div className="postgres-editor-toolbar">
            <span>{tCurrent('auto.remotePostgres.cj2ebw')}</span>
            <button type="button" onClick={() => runQuery()} disabled={queryRunning}>{queryRunning ? tCurrent('auto.remotePostgres.6svkbt') : tCurrent('auto.remotePostgres.6x8ukm')}</button>
          </div>
          <textarea ref={sqlRef} value={sql} onChange={(event) => setSql(event.target.value)} onKeyDown={handleSqlKeyDown} spellCheck={false} />
        </section>

        <section className="postgres-result">
          <div className="postgres-result-head">
            <div className="database-result-title">
              <strong>{tCurrent('auto.remotePostgres.q9h21m')}</strong>
              <span>{queryResult ? tCurrent('auto.remotePostgres.18tehe0', { value0: queryResult.rows.length }) : tCurrent('auto.remotePostgres.t9y5o0')}</span>
            </div>
            <div className="database-export-actions" aria-label={tCurrent('db.query.exportAria')}>
              <button type="button" className="database-export-button" onClick={() => void exportQueryResult('json')} disabled={!queryResult || queryResult.rows.length === 0}>{tCurrent('db.query.exportJson')}</button>
              <button type="button" className="database-export-button" onClick={() => void exportQueryResult('csv')} disabled={!queryResult || queryResult.rows.length === 0}>{tCurrent('db.query.exportCsv')}</button>
            </div>
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
            <div className="postgres-placeholder">{tCurrent('auto.remotePostgres.3ifoef')}</div>
          )}
        </section>
      </main>

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
            <span>{contextMenu.target.type === 'database' ? '数据库' : contextMenu.target.table.schema}</span>
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
    </section>
  );
}

export default RemotePostgres;
