import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getErrorMessage } from './desktopUtils';
import RemoteFilePicker from './RemoteFilePicker';
import type { RemoteSystemType } from './types';

interface RemoteSqliteProps {
  connectionId: string;
  initialFilePath?: string;
  systemType?: RemoteSystemType;
}

type SqliteStatus = 'disconnected' | 'opening' | 'connected' | 'error';

function RemoteSqlite({ connectionId, initialFilePath, systemType }: RemoteSqliteProps) {
  const api = window.guiSSH;
  const [status, setStatus] = useState<SqliteStatus>('disconnected');
  const [errorMessage, setErrorMessage] = useState('');
  const [sqliteId, setSqliteId] = useState('');
  const [filePath, setFilePath] = useState(initialFilePath ?? '');
  const [tables, setTables] = useState<string[]>([]);
  const [selectedTable, setSelectedTable] = useState('');
  const [columns, setColumns] = useState<ShellDeskSqliteColumn[]>([]);
  const [sql, setSql] = useState('');
  const [queryResult, setQueryResult] = useState<ShellDeskSqliteQueryResult | null>(null);
  const [queryError, setQueryError] = useState('');
  const [queryRunning, setQueryRunning] = useState(false);
  const [queryTime, setQueryTime] = useState(0);
  const [editingCell, setEditingCell] = useState<{ rowIndex: number; column: string; value: string } | null>(null);
  const [page, setPage] = useState(0);
  const [filePickerVisible, setFilePickerVisible] = useState(false);
  const pageSize = 100;
  const sqlRef = useRef<HTMLTextAreaElement | null>(null);

  const isReady = status === 'connected';

  const handleOpen = useCallback(async () => {
    if (!api?.connections || !filePath.trim()) return;
    setStatus('opening');
    setErrorMessage('');
    try {
      const result = await api.connections.sqliteOpen(connectionId, filePath.trim());
      setSqliteId(result.sqliteId);
      setFilePath(result.filePath);
      setStatus('connected');
      const tbls = await api.connections.sqliteTables(connectionId, result.sqliteId);
      setTables(tbls);
    } catch (error) {
      setStatus('error');
      setErrorMessage(getErrorMessage(error));
    }
  }, [api, connectionId, filePath]);

  const handleClose = useCallback(async () => {
    if (!api?.connections || !sqliteId) return;
    try { await api.connections.sqliteClose(connectionId, sqliteId); } catch { /* ignore */ }
    setStatus('disconnected');
    setSqliteId('');
    setTables([]);
    setSelectedTable('');
    setColumns([]);
    setQueryResult(null);
    setQueryError('');
    setSql('');
  }, [api, connectionId, sqliteId]);

  const handleSelectTable = useCallback(async (table: string) => {
    if (!api?.connections) return;
    setSelectedTable(table);
    setQueryError('');
    setPage(0);
    try {
      const cols = await api.connections.sqliteColumns(connectionId, sqliteId, table);
      setColumns(cols);
      const result = await api.connections.sqliteQuery(connectionId, sqliteId, `SELECT * FROM "${table}"`);
      setQueryResult(result);
      setQueryTime(0);
    } catch (error) {
      setQueryError(getErrorMessage(error));
      setQueryResult(null);
      setColumns([]);
    }
  }, [api, connectionId, sqliteId]);

  const handleExecuteSql = useCallback(async () => {
    if (!api?.connections || !sql.trim()) return;
    setQueryRunning(true);
    setQueryError('');
    setPage(0);
    const startTime = performance.now();
    try {
      const result = await api.connections.sqliteQuery(connectionId, sqliteId, sql.trim());
      setQueryResult(result);
      if (result.columns.length > 0) {
        // Try to get column info if SELECT on a known table
        const upperSql = sql.trim().toUpperCase();
        const fromMatch = upperSql.match(/FROM\s+"?(\w+)"?/i);
        if (fromMatch) {
          try {
            const cols = await api.connections.sqliteColumns(connectionId, sqliteId, fromMatch[1]);
            setColumns(cols);
          } catch {
            setColumns(result.columns.map((name) => ({ name, type: '', nullable: true, pk: false, defaultValue: null })));
          }
        } else {
          setColumns(result.columns.map((name) => ({ name, type: '', nullable: true, pk: false, defaultValue: null })));
        }
      }
      setQueryTime(Math.round(performance.now() - startTime));
    } catch (error) {
      setQueryError(getErrorMessage(error));
      setQueryResult(null);
    } finally {
      setQueryRunning(false);
    }
  }, [api, connectionId, sqliteId, sql]);

  const handleCellEdit = useCallback((rowIndex: number, column: string, currentValue: unknown) => {
    setEditingCell({ rowIndex, column, value: currentValue === null || currentValue === undefined ? '' : String(currentValue) });
  }, []);

  const handleCellSave = useCallback(async () => {
    if (!editingCell || !selectedTable || !api?.connections || !queryResult) return;
    const row = queryResult.rows[editingCell.rowIndex];
    if (!row) return;
    const pkCols = columns.filter((c) => c.pk).map((c) => c.name);
    if (pkCols.length === 0) {
      setQueryError('该表没有主键，无法编辑单元格。');
      setEditingCell(null);
      return;
    }
    // SQLite uses rowid if no explicit PK, but PRAGMA table_info shows pk
    const pkColumn = pkCols[0];
    const pkValue = row[pkColumn];
    const newValue = editingCell.value === '' ? null : editingCell.value;
    try {
      const colDef = columns.find((c) => c.name === editingCell.column);
      if (colDef && colDef.pk) {
        throw new Error('不允许修改主键列。');
      }
      await api.connections.sqliteQuery(
        connectionId,
        sqliteId,
        `UPDATE "${selectedTable}" SET "${editingCell.column}" = ${newValue === null ? 'NULL' : `'${String(newValue).replace(/'/g, "''")}'`} WHERE "${pkColumn}" = '${String(pkValue).replace(/'/g, "''")}'`,
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
  }, [api, connectionId, sqliteId, editingCell, selectedTable, queryResult, columns]);

  const handleCellKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Enter') { event.preventDefault(); handleCellSave(); }
    else if (event.key === 'Escape') { setEditingCell(null); }
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
    if (initialFilePath && initialFilePath.trim() && status === 'disconnected') {
      setFilePath(initialFilePath);
      // Auto-open after a tick to ensure state is set
      const timer = setTimeout(() => {
        if (!api?.connections) return;
        setStatus('opening');
        setErrorMessage('');
        api.connections.sqliteOpen(connectionId, initialFilePath.trim()).then((result) => {
          setSqliteId(result.sqliteId);
          setFilePath(result.filePath);
          setStatus('connected');
          return api.connections.sqliteTables(connectionId, result.sqliteId);
        }).then((tbls) => {
          setTables(tbls);
        }).catch((error) => {
          setStatus('error');
          setErrorMessage(getErrorMessage(error));
        });
      }, 100);
      return () => clearTimeout(timer);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (sqliteId && api?.connections) {
        api.connections.sqliteClose(connectionId, sqliteId).catch(() => {});
      }
    };
  }, []);

  if (!isReady) {
    return (
      <>
        <div className="sqlite-connect-panel">
          <div className="sqlite-connect-card">
            <h3>{initialFilePath ? '打开 SQLite 数据库' : 'SQLite 数据库管理'}</h3>
            <p className="sqlite-connect-hint">通过 SSH 远程连接并管理 SQLite 文件数据库</p>
            {errorMessage ? <div className="sqlite-error-banner">{errorMessage}</div> : null}
            <label className="sqlite-field">
              <span>数据库文件路径</span>
              <div className="sqlite-path-input-row">
                <input
                  type="text"
                  value={filePath}
                  onChange={(event) => setFilePath(event.target.value)}
                  placeholder="/path/to/database.db"
                  disabled={status === 'opening'}
                />
                <button
                  type="button"
                  className="sqlite-browse-btn"
                  onClick={() => setFilePickerVisible(true)}
                  disabled={status === 'opening'}
                >
                  选择...
                </button>
              </div>
            </label>
            <button
              type="button"
              className="sqlite-connect-btn"
              onClick={handleOpen}
              disabled={status === 'opening' || !filePath.trim()}
            >
              {status === 'opening' ? '打开中...' : '打开'}
            </button>
          </div>
        </div>
        <RemoteFilePicker
          connectionId={connectionId}
          systemType={systemType}
          mode="open"
          title="选择 SQLite 数据库文件"
          visible={filePickerVisible}
          onConfirm={(selectedPath) => {
            setFilePickerVisible(false);
            setFilePath(selectedPath);
          }}
          onCancel={() => setFilePickerVisible(false)}
        />
      </>
    );
  }

  return (
    <div className="sqlite-layout">
      <aside className="sqlite-sidebar">
        <div className="sqlite-sidebar-header">
          <strong>表</strong>
          <span className="sqlite-path-badge" title={filePath}>
            {filePath.split('/').pop() || filePath}
          </span>
          <button type="button" className="sqlite-disconnect-btn" onClick={handleClose} title="关闭数据库">关闭</button>
        </div>
        <div className="sqlite-tree">
          {tables.map((table) => (
            <button
              key={table}
              type="button"
              className={`sqlite-tree-table-btn ${selectedTable === table ? 'selected' : ''}`}
              onClick={() => handleSelectTable(table)}
            >
              <span className="sqlite-tree-icon">📋</span>
              {table}
            </button>
          ))}
          {tables.length === 0 ? <div className="sqlite-tree-empty">无表</div> : null}
        </div>
      </aside>
      <div className="sqlite-main">
        <div className="sqlite-editor-area">
          <div className="sqlite-editor-toolbar">
            <button
              type="button"
              className="sqlite-run-btn"
              onClick={handleExecuteSql}
              disabled={queryRunning || !sql.trim()}
            >
              {queryRunning ? '执行中...' : '▶ 执行'}
            </button>
            <span className="sqlite-editor-hint">Ctrl+Enter 执行</span>
            {selectedTable ? (
              <span className="sqlite-active-table">当前表: {selectedTable}</span>
            ) : null}
          </div>
          <textarea
            ref={sqlRef}
            className="sqlite-sql-editor"
            value={sql}
            onChange={(event) => setSql(event.target.value)}
            onKeyDown={handleSqlKeyDown}
            placeholder="输入 SQL 语句..."
            spellCheck={false}
          />
        </div>
        <div className="sqlite-result-area">
          {queryError ? <div className="sqlite-error-banner">{queryError}</div> : null}
          {queryResult ? (
            <>
              <div className="sqlite-result-info">
                {queryResult.rows.length} 行
                {queryTime > 0 ? ` · ${queryTime}ms` : ''}
                {selectedTable ? ` · ${selectedTable}` : ''}
              </div>
              {queryResult.columns.length > 0 ? (
                <>
                  <div className="sqlite-table-wrapper">
                    <table className="sqlite-data-table">
                      <thead>
                        <tr>
                          <th className="sqlite-row-num">#</th>
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
                              <td className="sqlite-row-num">{globalRowIdx + 1}</td>
                              {queryResult.columns.map((col) => {
                                const cellValue = row[col];
                                const isEditing = editingCell?.rowIndex === globalRowIdx && editingCell.column === col;
                                if (isEditing) {
                                  return (
                                    <td key={col} className="sqlite-cell-editing">
                                      <input
                                        type="text"
                                        value={editingCell.value}
                                        onChange={(event) => setEditingCell({ ...editingCell, value: event.target.value })}
                                        onKeyDown={handleCellKeyDown}
                                        onBlur={handleCellSave}
                                        autoFocus
                                        className="sqlite-cell-input"
                                      />
                                    </td>
                                  );
                                }
                                return (
                                  <td
                                    key={col}
                                    className={cellValue === null ? 'sqlite-cell-null' : ''}
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
                    <div className="sqlite-pagination">
                      <button type="button" disabled={page === 0} onClick={() => setPage(0)}>首页</button>
                      <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button>
                      <span>{page + 1} / {totalPages}</span>
                      <button type="button" disabled={page >= totalPages - 1} onClick={() => setPage(page + 1)}>下一页</button>
                      <button type="button" disabled={page >= totalPages - 1} onClick={() => setPage(totalPages - 1)}>末页</button>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="sqlite-result-empty">查询已执行，无返回数据。</div>
              )}
            </>
          ) : (
            <div className="sqlite-result-placeholder">
              {queryRunning ? '正在执行查询...' : '执行 SQL 查询以查看结果'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default RemoteSqlite;
