import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getErrorMessage } from './desktopUtils';

interface RemoteMySQLProps {
  connectionId: string;
}

type MysqlStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

interface TableInfo {
  database: string;
  name: string;
}

const defaultPort = 3306;

function RemoteMySQL({ connectionId }: RemoteMySQLProps) {
  const api = window.guiSSH;
  const [status, setStatus] = useState<MysqlStatus>('disconnected');
  const [errorMessage, setErrorMessage] = useState('');
  const [mysqlId, setMysqlId] = useState('');
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState(String(defaultPort));
  const [user, setUser] = useState('root');
  const [password, setPassword] = useState('');
  const [databases, setDatabases] = useState<string[]>([]);
  const [expandedDbs, setExpandedDbs] = useState<Set<string>>(new Set());
  const [dbTables, setDbTables] = useState<Record<string, string[]>>({});
  const [selectedTable, setSelectedTable] = useState<TableInfo | null>(null);
  const [columns, setColumns] = useState<GuiSshMysqlColumn[]>([]);
  const [sql, setSql] = useState('');
  const [queryResult, setQueryResult] = useState<GuiSshMysqlQueryResult | null>(null);
  const [queryError, setQueryError] = useState('');
  const [queryRunning, setQueryRunning] = useState(false);
  const [queryTime, setQueryTime] = useState(0);
  const [activeDb, setActiveDb] = useState('');
  const [editingCell, setEditingCell] = useState<{ rowIndex: number; column: string; value: string } | null>(null);
  const [page, setPage] = useState(0);
  const pageSize = 100;
  const sqlRef = useRef<HTMLTextAreaElement | null>(null);

  const isReady = status === 'connected';

  const handleConnect = useCallback(async () => {
    if (!api?.connections) return;

    setStatus('connecting');
    setErrorMessage('');

    try {
      const result = await api.connections.mysqlConnect(connectionId, {
        host: host || '127.0.0.1',
        port: parseInt(port, 10) || defaultPort,
        user: user || 'root',
        password,
      });

      setMysqlId(result.mysqlId);
      setStatus('connected');

      const dbs = await api.connections.mysqlDatabases(connectionId, result.mysqlId);
      setDatabases(dbs);

      if (dbs.length > 0) {
        setActiveDb(dbs[0]);
      }
    } catch (error) {
      setStatus('error');
      setErrorMessage(getErrorMessage(error));
    }
  }, [api, connectionId, host, port, user, password]);

  const handleDisconnect = useCallback(async () => {
    if (!api?.connections || !mysqlId) return;

    try {
      await api.connections.mysqlDisconnect(connectionId, mysqlId);
    } catch {
      // ignore
    }

    setStatus('disconnected');
    setMysqlId('');
    setDatabases([]);
    setExpandedDbs(new Set());
    setDbTables({});
    setSelectedTable(null);
    setColumns([]);
    setQueryResult(null);
    setQueryError('');
    setSql('');
    setActiveDb('');
  }, [api, connectionId, mysqlId]);

  const toggleDatabase = useCallback(async (db: string) => {
    const next = new Set(expandedDbs);

    if (next.has(db)) {
      next.delete(db);
      setExpandedDbs(next);
      return;
    }

    next.add(db);
    setExpandedDbs(next);

    if (!dbTables[db] && api?.connections) {
      try {
        const tables = await api.connections.mysqlTables(connectionId, mysqlId, db);
        setDbTables((prev) => ({ ...prev, [db]: tables }));
      } catch {
        // ignore
      }
    }
  }, [api, connectionId, mysqlId, expandedDbs, dbTables]);

  const handleSelectTable = useCallback(async (database: string, table: string) => {
    if (!api?.connections) return;

    setSelectedTable({ database, name: table });
    setActiveDb(database);
    setQueryError('');
    setPage(0);

    try {
      const cols = await api.connections.mysqlColumns(connectionId, mysqlId, database, table);
      setColumns(cols);

      const result = await api.connections.mysqlQuery(connectionId, mysqlId, `SELECT * FROM \`${table}\` LIMIT 500`, database);
      setQueryResult(result);
      setQueryTime(0);
    } catch (error) {
      setQueryError(getErrorMessage(error));
      setQueryResult(null);
      setColumns([]);
    }
  }, [api, connectionId, mysqlId]);

  const handleExecuteSql = useCallback(async () => {
    if (!api?.connections || !sql.trim()) return;

    setQueryRunning(true);
    setQueryError('');
    setPage(0);
    const startTime = performance.now();

    try {
      const result = await api.connections.mysqlQuery(connectionId, mysqlId, sql.trim(), activeDb || undefined);
      setQueryResult(result);
      setColumns(result.columns.map((name) => ({ name, type: '', nullable: false, key: '', default: null, extra: '', comment: '' })));
      setQueryTime(Math.round(performance.now() - startTime));
    } catch (error) {
      setQueryError(getErrorMessage(error));
      setQueryResult(null);
    } finally {
      setQueryRunning(false);
    }
  }, [api, connectionId, mysqlId, sql, activeDb]);

  const handleCellEdit = useCallback((rowIndex: number, column: string, currentValue: unknown) => {
    setEditingCell({ rowIndex, column, value: currentValue === null || currentValue === undefined ? '' : String(currentValue) });
  }, []);

  const handleCellSave = useCallback(async () => {
    if (!editingCell || !selectedTable || !api?.connections) return;

    const row = queryResult?.rows[editingCell.rowIndex];

    if (!row) return;

    const pkColumns = columns.filter((c) => c.key === 'PRI').map((c) => c.name);

    if (pkColumns.length === 0) {
      setQueryError('该表没有主键，无法编辑单元格。');
      setEditingCell(null);
      return;
    }

    const pkValues = pkColumns.map((col) => row[col]);
    const newValue = editingCell.value === '' ? null : editingCell.value;

    try {
      await api.connections.mysqlUpdateCell(
        connectionId,
        mysqlId,
        selectedTable.database,
        selectedTable.name,
        pkColumns[0],
        pkValues[0],
        editingCell.column,
        newValue,
        pkColumns.length > 1 ? pkColumns : undefined,
        pkColumns.length > 1 ? pkValues : undefined,
      );

      setQueryResult((prev) => {
        if (!prev) return prev;
        const nextRows = [...prev.rows];
        nextRows[editingCell.rowIndex] = { ...nextRows[editingCell.rowIndex], [editingCell.column]: newValue };
        return { ...prev, rows: nextRows };
      });
    } catch (error) {
      setQueryError(getErrorMessage(error));
    }

    setEditingCell(null);
  }, [api, connectionId, mysqlId, editingCell, selectedTable, queryResult, columns]);

  const handleCellKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleCellSave();
    } else if (event.key === 'Escape') {
      setEditingCell(null);
    }
  }, [handleCellSave]);

  const handleSqlKeyDown = useCallback((event: React.KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      handleExecuteSql();
    }
  }, [handleExecuteSql]);

  const pagedRows = useMemo(() => {
    if (!queryResult) return [];
    return queryResult.rows.slice(page * pageSize, (page + 1) * pageSize);
  }, [queryResult, page]);

  const totalPages = useMemo(() => {
    if (!queryResult) return 0;
    return Math.ceil(queryResult.rows.length / pageSize);
  }, [queryResult]);

  useEffect(() => {
    return () => {
      if (mysqlId && api?.connections) {
        api.connections.mysqlDisconnect(connectionId, mysqlId).catch(() => {});
      }
    };
  }, []);

  if (!isReady) {
    return (
      <div className="mysql-connect-panel">
        <div className="mysql-connect-card">
          <h3>连接 MySQL 数据库</h3>
          <p className="mysql-connect-hint">通过 SSH 隧道安全连接目标机器的 MySQL</p>
          {errorMessage ? <div className="mysql-error-banner">{errorMessage}</div> : null}
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
            <span>密码</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="留空表示无密码"
              disabled={status === 'connecting'}
            />
          </label>
          <button
            type="button"
            className="mysql-connect-btn"
            onClick={handleConnect}
            disabled={status === 'connecting'}
          >
            {status === 'connecting' ? '连接中...' : '连接'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mysql-layout">
      <aside className="mysql-sidebar">
        <div className="mysql-sidebar-header">
          <strong>数据库</strong>
          <span className="mysql-connection-badge" title={`${user}@${host}:${port}`}>{host}</span>
          <button type="button" className="mysql-disconnect-btn" onClick={handleDisconnect} title="断开连接">断开</button>
        </div>
        <div className="mysql-tree">
          {databases.map((db) => (
            <div key={db} className="mysql-tree-db">
              <button
                type="button"
                className={`mysql-tree-db-btn ${expandedDbs.has(db) ? 'expanded' : ''} ${activeDb === db ? 'active' : ''}`}
                onClick={() => { toggleDatabase(db); setActiveDb(db); }}
              >
                <span className="mysql-tree-arrow">{expandedDbs.has(db) ? '▼' : '▶'}</span>
                <span className="mysql-tree-icon">🗄️</span>
                {db}
              </button>
              {expandedDbs.has(db) ? (
                <div className="mysql-tree-tables">
                  {(dbTables[db] ?? []).map((table) => (
                    <button
                      key={table}
                      type="button"
                      className={`mysql-tree-table-btn ${selectedTable?.database === db && selectedTable.name === table ? 'selected' : ''}`}
                      onClick={() => handleSelectTable(db, table)}
                    >
                      <span className="mysql-tree-icon">📋</span>
                      {table}
                    </button>
                  ))}
                  {dbTables[db] === undefined ? <div className="mysql-tree-loading">加载中...</div> : null}
                  {dbTables[db] !== undefined && dbTables[db].length === 0 ? <div className="mysql-tree-empty">无表</div> : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </aside>
      <div className="mysql-main">
        <div className="mysql-editor-area">
          <div className="mysql-editor-toolbar">
            <button
              type="button"
              className="mysql-run-btn"
              onClick={handleExecuteSql}
              disabled={queryRunning || !sql.trim()}
            >
              {queryRunning ? '执行中...' : '▶ 执行'}
            </button>
            <span className="mysql-editor-hint">Ctrl+Enter 执行</span>
            {activeDb ? (
              <span className="mysql-active-db">当前库: {activeDb}</span>
            ) : null}
          </div>
          <textarea
            ref={sqlRef}
            className="mysql-sql-editor"
            value={sql}
            onChange={(event) => setSql(event.target.value)}
            onKeyDown={handleSqlKeyDown}
            placeholder="输入 SQL 语句..."
            spellCheck={false}
          />
        </div>
        <div className="mysql-result-area">
          {queryError ? <div className="mysql-error-banner">{queryError}</div> : null}
          {queryResult ? (
            <>
              <div className="mysql-result-info">
                {queryResult.affectedRows !== undefined
                  ? `影响 ${queryResult.affectedRows} 行`
                  : `${queryResult.rows.length} 行`}
                {queryResult.insertId ? ` · 插入 ID: ${queryResult.insertId}` : ''}
                {queryTime > 0 ? ` · ${queryTime}ms` : ''}
                {selectedTable ? ` · ${selectedTable.database}.${selectedTable.name}` : ''}
              </div>
              {queryResult.columns.length > 0 ? (
                <>
                  <div className="mysql-table-wrapper">
                    <table className="mysql-data-table">
                      <thead>
                        <tr>
                          <th className="mysql-row-num">#</th>
                          {queryResult.columns.map((col) => (
                            <th key={col}>{col}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {pagedRows.map((row, rowIdx) => {
                          const globalRowIdx = page * pageSize + rowIdx;

                          return (
                            <tr key={globalRowIdx}>
                              <td className="mysql-row-num">{globalRowIdx + 1}</td>
                              {queryResult.columns.map((col) => {
                                const cellValue = row[col];
                                const isEditing = editingCell?.rowIndex === globalRowIdx && editingCell.column === col;

                                if (isEditing) {
                                  return (
                                    <td key={col} className="mysql-cell-editing">
                                      <input
                                        type="text"
                                        value={editingCell.value}
                                        onChange={(event) => setEditingCell({ ...editingCell, value: event.target.value })}
                                        onKeyDown={handleCellKeyDown}
                                        onBlur={handleCellSave}
                                        autoFocus
                                        className="mysql-cell-input"
                                      />
                                    </td>
                                  );
                                }

                                return (
                                  <td
                                    key={col}
                                    className={cellValue === null ? 'mysql-cell-null' : ''}
                                    onDoubleClick={() => handleCellEdit(globalRowIdx, col, cellValue)}
                                    title={cellValue === null ? 'NULL' : String(cellValue)}
                                  >
                                    {cellValue === null ? <em>NULL</em> : String(cellValue)}
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
                <div className="mysql-result-empty">查询已执行，无返回数据。</div>
              )}
            </>
          ) : (
            <div className="mysql-result-placeholder">
              {queryRunning ? '正在执行查询...' : '执行 SQL 查询以查看结果'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default RemoteMySQL;
