import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import { exportDatabaseRows, type DatabaseExportFormat } from './databaseExport';
import { DatabaseTunnelFields, createDefaultTunnelValue, parseTunnelValue } from './DatabaseTunnelFields';
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

const tablePreviewLimit = 50;
const maxHistoryItems = 12;
const defaultPort = 5432;

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
  const [tunnel, setTunnel] = useState(() => createDefaultTunnelValue(defaultPort));
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
      setError(tCurrent('auto.remotePostgres.g77vf3'));
      return;
    }

    setStatus('connecting');
    setError('');
    setNotice('');

    try {
      const nextPort = Number.parseInt(port, 10) || defaultPort;
      const nextDb = database || 'postgres';
      const result = await api.postgresConnect(connectionId, {
        mode: tunnel.enabled ? 'tunnel' : 'cli',
        host: host || '127.0.0.1',
        port: nextPort,
        user,
        password,
        database: nextDb,
        tunnel: parseTunnelValue(tunnel, nextPort),
      });
      postgresIdRef.current = result.postgresId;
      setPostgresId(result.postgresId);
      void saveRemoteConnectionProfile(hostId, 'postgres', {
        host: host || '127.0.0.1',
        port: String(nextPort),
        user: user || 'postgres',
        password,
        database: nextDb,
      }).catch(() => undefined);
      await loadSchemas(result.postgresId);
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
        database: nextDb,
      }));
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
            <DatabaseTunnelFields value={tunnel} defaultPort={defaultPort} onChange={setTunnel} />
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
          <div>
            <strong>{tCurrent('auto.remotePostgres.1r1l7i2')}</strong>
            <span>{database} · {databases.length} DB</span>
          </div>
          <button type="button" onClick={() => loadSchemas(postgresId)}>{tCurrent('auto.remotePostgres.12qo56a')}</button>
        </div>
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
            <div className="database-export-actions" aria-label="导出查询结果">
              <button type="button" className="database-export-button" onClick={() => void exportQueryResult('json')} disabled={!queryResult || queryResult.rows.length === 0}>导出 JSON</button>
              <button type="button" className="database-export-button" onClick={() => void exportQueryResult('csv')} disabled={!queryResult || queryResult.rows.length === 0}>导出 CSV</button>
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

      <aside className="postgres-detail">
        <div className="postgres-detail-section">
          <strong>{tCurrent('auto.remotePostgres.19ma7vc')}</strong>
          {selectedTable ? <span>{selectedTable.schema}.{selectedTable.name}</span> : <span>{tCurrent('auto.remotePostgres.1u9unt1')}</span>}
        </div>
        <div className="postgres-column-list">
          {columns.map((column) => (
            <div key={column.name} className="postgres-column-item">
              <strong>{column.name}</strong>
              <span>{column.dataType}{column.nullable ? '' : ' · NOT NULL'}{column.isPrimaryKey ? ' · PK' : ''}</span>
            </div>
          ))}
          {!columns.length ? <div className="postgres-placeholder small">{tCurrent('auto.remotePostgres.4k9mre')}</div> : null}
        </div>
        <div className="postgres-detail-section">
          <strong>{tCurrent('auto.remotePostgres.air9hy')}</strong>
          <span>{history.length} {tCurrent('auto.remotePostgres.1rfm5gs')}</span>
        </div>
        <div className="postgres-history-list">
          {history.map((item) => (
            <button key={item.id} type="button" className={item.status} onClick={() => setSql(item.sql)}>
              <strong>{item.sql.replace(/\s+/g, ' ').slice(0, 80)}</strong>
              <span>{item.createdAt} · {item.durationMs} ms{item.rowCount !== undefined ? tCurrent('auto.remotePostgres.b3e9gx', { value0: item.rowCount }) : ''}</span>
            </button>
          ))}
        </div>
      </aside>
    </section>
  );
}

export default RemotePostgres;
