import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import DismissibleAlert from './DismissibleAlert';
import RemoteFilePicker from './RemoteFilePicker';
import type { RemoteSystemType } from './types';

interface RemoteSqliteProps {
  connectionId: string;
  initialFilePath?: string;
  systemType?: RemoteSystemType;
}

type SqliteStatus = 'disconnected' | 'opening' | 'connected' | 'error';
type SqliteMessageType = 'info' | 'success' | 'warning' | 'error';
type SqlitePanel = 'data' | 'schema';

interface SqliteMessage {
  type: SqliteMessageType;
  text: string;
}

interface SqliteResultMeta {
  sql: string;
  source: 'object' | 'query';
  object?: ShellDeskSqliteObject;
  columns: ShellDeskSqliteColumn[];
  queryTime: number;
  createdAt: number;
  rowidAvailable: boolean;
  writeStatement: boolean;
}

interface SqliteHistoryItem {
  id: string;
  sql: string;
  status: 'success' | 'error';
  rowCount?: number;
  queryTime: number;
  error?: string;
  createdAt: number;
}

interface EditingCell {
  rowIndex: number;
  column: string;
  value: string;
}

interface PendingCellEdit {
  table: string;
  rowIndex: number;
  column: string;
  oldValue: unknown;
  newValue: unknown;
  target: ShellDeskSqliteUpdateTarget;
}

interface PendingWriteSql {
  sql: string;
}

const pageSize = 100;
const tablePreviewLimit = 500;
const maxHistoryItems = 12;
const rowidColumn = '__shelldesk_rowid';

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
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

function createGenericColumns(names: string[]): ShellDeskSqliteColumn[] {
  return names.map((name) => ({
    name,
    type: '',
    nullable: true,
    pk: false,
    defaultValue: null,
  }));
}

function isSqliteWriteStatement(sql: string): boolean {
  if (/^\s*pragma\b/i.test(sql)) {
    return /^\s*pragma\s+[^;=]+=/i.test(sql);
  }

  return /^\s*(insert|update|delete|replace|alter|drop|create|vacuum|reindex|attach|detach)\b/i.test(sql);
}

function getObjectTypeLabel(type: string): string {
  switch (type) {
    case 'table': return '表';
    case 'view': return '视图';
    case 'index': return '索引';
    default: return type;
  }
}

function getObjectTypeMark(type: string): string {
  switch (type) {
    case 'table': return 'T';
    case 'view': return 'V';
    case 'index': return 'I';
    default: return '?';
  }
}

function getFileName(filePath: string): string {
  return filePath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || filePath;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left === null || left === undefined) return right === null || right === undefined;
  if (right === null || right === undefined) return false;
  return String(left) === String(right);
}

function RemoteSqlite({ connectionId, initialFilePath, systemType }: RemoteSqliteProps) {
  const api = window.guiSSH;
  const sqliteIdRef = useRef('');
  const autoOpenRef = useRef(false);
  const sqlRef = useRef<HTMLTextAreaElement | null>(null);

  const [status, setStatus] = useState<SqliteStatus>('disconnected');
  const [errorMessage, setErrorMessage] = useState('');
  const [message, setMessage] = useState<SqliteMessage | null>(null);
  const [sqliteId, setSqliteId] = useState('');
  const [filePath, setFilePath] = useState(initialFilePath ?? '');
  const [recentFiles, setRecentFiles] = useState<string[]>(initialFilePath ? [initialFilePath] : []);
  const [objects, setObjects] = useState<ShellDeskSqliteObject[]>([]);
  const [objectsLoading, setObjectsLoading] = useState(false);
  const [objectSearch, setObjectSearch] = useState('');
  const [selectedObject, setSelectedObject] = useState<ShellDeskSqliteObject | null>(null);
  const [columns, setColumns] = useState<ShellDeskSqliteColumn[]>([]);
  const [schemaSql, setSchemaSql] = useState('');
  const [activePanel, setActivePanel] = useState<SqlitePanel>('data');
  const [sql, setSql] = useState('');
  const [queryResult, setQueryResult] = useState<ShellDeskSqliteQueryResult | null>(null);
  const [resultMeta, setResultMeta] = useState<SqliteResultMeta | null>(null);
  const [queryRunning, setQueryRunning] = useState(false);
  const [history, setHistory] = useState<SqliteHistoryItem[]>([]);
  const [editingCell, setEditingCell] = useState<EditingCell | null>(null);
  const [pendingEdit, setPendingEdit] = useState<PendingCellEdit | null>(null);
  const [pendingWrite, setPendingWrite] = useState<PendingWriteSql | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [page, setPage] = useState(0);
  const [filePickerVisible, setFilePickerVisible] = useState(false);

  const isReady = status === 'connected';

  const filteredGroups = useMemo(() => {
    const keyword = objectSearch.trim().toLowerCase();
    const groups = ['table', 'view', 'index'].map((type) => ({
      type,
      items: objects.filter((item) => item.type === type && (!keyword || item.name.toLowerCase().includes(keyword) || item.tableName.toLowerCase().includes(keyword))),
    }));

    return groups.filter((group) => group.items.length > 0 || !keyword);
  }, [objectSearch, objects]);

  const visibleColumns = useMemo(() => {
    return queryResult?.columns.filter((column) => column !== rowidColumn) ?? [];
  }, [queryResult]);

  const pagedRows = useMemo(() => {
    if (!queryResult) return [];
    return queryResult.rows.slice(page * pageSize, (page + 1) * pageSize);
  }, [page, queryResult]);

  const totalPages = useMemo(() => {
    if (!queryResult) return 0;
    return Math.ceil(queryResult.rows.length / pageSize);
  }, [queryResult]);

  const primaryKeys = useMemo(() => {
    return columns.filter((column) => column.pk).map((column) => column.name);
  }, [columns]);

  const isResultEditable = Boolean(
    resultMeta?.source === 'object' &&
    resultMeta.object?.type === 'table' &&
    queryResult &&
    (primaryKeys.length > 0 || resultMeta.rowidAvailable),
  );

  const resetWorkspace = useCallback(() => {
    setObjects([]);
    setObjectsLoading(false);
    setObjectSearch('');
    setSelectedObject(null);
    setColumns([]);
    setSchemaSql('');
    setActivePanel('data');
    setSql('');
    setQueryResult(null);
    setResultMeta(null);
    setMessage(null);
    setEditingCell(null);
    setPendingEdit(null);
    setPendingWrite(null);
    setPage(0);
  }, []);

  const addHistoryItem = useCallback((item: Omit<SqliteHistoryItem, 'id' | 'createdAt'>) => {
    setHistory((prev) => [
      {
        ...item,
        id: createId('sqlite-history'),
        createdAt: Date.now(),
      },
      ...prev,
    ].slice(0, maxHistoryItems));
  }, []);

  const refreshObjects = useCallback(async (sqliteIdOverride?: string) => {
    const activeSqliteId = sqliteIdOverride ?? sqliteId;

    if (!api?.connections || !activeSqliteId) return;

    setObjectsLoading(true);
    setMessage(null);

    try {
      const nextObjects = await api.connections.sqliteObjects(connectionId, activeSqliteId);
      setObjects(nextObjects);
      setMessage({ type: 'success', text: '对象列表已刷新。' });
    } catch (error) {
      setMessage({ type: 'error', text: getErrorMessage(error) });
    } finally {
      setObjectsLoading(false);
    }
  }, [api, connectionId, sqliteId]);

  const openDatabase = useCallback(async (nextFilePath: string) => {
    if (!api?.connections || !nextFilePath.trim()) return;

    setStatus('opening');
    setErrorMessage('');
    setMessage(null);
    resetWorkspace();

    try {
      const result = await api.connections.sqliteOpen(connectionId, nextFilePath.trim());
      sqliteIdRef.current = result.sqliteId;
      setSqliteId(result.sqliteId);
      setFilePath(result.filePath);
      setRecentFiles((prev) => [result.filePath, ...prev.filter((item) => item !== result.filePath)].slice(0, 5));
      setStatus('connected');
      setSql("SELECT name, type FROM sqlite_master WHERE type IN ('table','view','index') ORDER BY type, name LIMIT 50;");
      await refreshObjects(result.sqliteId);
    } catch (error) {
      setStatus('error');
      setErrorMessage(getErrorMessage(error));
    }
  }, [api, connectionId, refreshObjects, resetWorkspace]);

  const handleOpen = useCallback(() => {
    void openDatabase(filePath);
  }, [filePath, openDatabase]);

  const handleClose = useCallback(async () => {
    if (!api?.connections || !sqliteId) return;

    try {
      await api.connections.sqliteClose(connectionId, sqliteId);
    } catch {
      // ignore close errors
    }

    sqliteIdRef.current = '';
    setStatus('disconnected');
    setSqliteId('');
    resetWorkspace();
  }, [api, connectionId, resetWorkspace, sqliteId]);

  const handleSelectObject = useCallback(async (object: ShellDeskSqliteObject) => {
    if (!api?.connections || !sqliteId) return;

    const isDataObject = object.type === 'table' || object.type === 'view';
    const fallbackSql = `SELECT * FROM ${quoteSqliteIdentifier(object.name)} LIMIT ${tablePreviewLimit};`;
    const preferredSql = object.type === 'table'
      ? `SELECT rowid AS ${quoteSqliteIdentifier(rowidColumn)}, * FROM ${quoteSqliteIdentifier(object.name)} LIMIT ${tablePreviewLimit};`
      : fallbackSql;
    const startTime = performance.now();

    setSelectedObject(object);
    setColumns([]);
    setSchemaSql(object.sql ?? '');
    setMessage(null);
    setPage(0);
    setActivePanel(isDataObject ? 'data' : 'schema');
    setSql(fallbackSql);
    setQueryResult(null);
    setResultMeta(null);

    try {
      const schema = await api.connections.sqliteSchema(connectionId, sqliteId, object.type, object.name);
      setSchemaSql(schema.sql || object.sql || '');
    } catch {
      setSchemaSql(object.sql || '');
    }

    if (!isDataObject) {
      return;
    }

    try {
      const nextColumns = await api.connections.sqliteColumns(connectionId, sqliteId, object.name);
      let nextResult: ShellDeskSqliteQueryResult;
      let rowidAvailable = false;
      let executedSql = preferredSql;

      try {
        nextResult = await api.connections.sqliteQuery(connectionId, sqliteId, preferredSql);
        rowidAvailable = nextResult.columns.includes(rowidColumn);
      } catch (error) {
        if (object.type !== 'table') throw error;
        executedSql = fallbackSql;
        nextResult = await api.connections.sqliteQuery(connectionId, sqliteId, fallbackSql);
      }

      const queryTime = Math.round(performance.now() - startTime);

      setColumns(nextColumns);
      setQueryResult(nextResult);
      setResultMeta({
        sql: executedSql,
        source: 'object',
        object,
        columns: nextColumns,
        queryTime,
        createdAt: Date.now(),
        rowidAvailable,
        writeStatement: false,
      });
      setSql(executedSql);
      addHistoryItem({
        sql: executedSql,
        status: 'success',
        rowCount: nextResult.rows.length,
        queryTime,
      });
    } catch (error) {
      const queryTime = Math.round(performance.now() - startTime);
      const text = getErrorMessage(error);
      setMessage({ type: 'error', text });
      addHistoryItem({
        sql: fallbackSql,
        status: 'error',
        error: text,
        queryTime,
      });
    }
  }, [addHistoryItem, api, connectionId, sqliteId]);

  const executeSql = useCallback(async (sqlText: string) => {
    if (!api?.connections || !sqliteId || !sqlText.trim()) return;

    const statement = sqlText.trim();
    const writeStatement = isSqliteWriteStatement(statement);
    const startTime = performance.now();

    setQueryRunning(true);
    setMessage(null);
    setPage(0);
    setEditingCell(null);

    try {
      const result = await api.connections.sqliteQuery(connectionId, sqliteId, statement);
      const queryTime = Math.round(performance.now() - startTime);

      setQueryResult(result);
      setColumns(createGenericColumns(result.columns));
      setResultMeta({
        sql: statement,
        source: 'query',
        columns: createGenericColumns(result.columns),
        queryTime,
        createdAt: Date.now(),
        rowidAvailable: false,
        writeStatement,
      });
      setActivePanel('data');
      setMessage({
        type: 'success',
        text: writeStatement ? '写入语句已执行。' : `查询完成，返回 ${result.rows.length} 行。`,
      });
      addHistoryItem({
        sql: statement,
        status: 'success',
        rowCount: result.rows.length,
        queryTime,
      });

      if (/^\s*(create|drop|alter|reindex|vacuum)\b/i.test(statement)) {
        await refreshObjects();
      }
    } catch (error) {
      const queryTime = Math.round(performance.now() - startTime);
      const text = getErrorMessage(error);
      setQueryResult(null);
      setResultMeta(null);
      setMessage({ type: 'error', text });
      addHistoryItem({
        sql: statement,
        status: 'error',
        error: text,
        queryTime,
      });
    } finally {
      setQueryRunning(false);
    }
  }, [addHistoryItem, api, connectionId, refreshObjects, sqliteId]);

  const handleExecuteSql = useCallback(() => {
    if (!sql.trim()) return;

    if (isSqliteWriteStatement(sql)) {
      setPendingWrite({ sql: sql.trim() });
      return;
    }

    void executeSql(sql);
  }, [executeSql, sql]);

  const handleSqlKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      handleExecuteSql();
    }
  }, [handleExecuteSql]);

  const handleUseHistory = useCallback((item: SqliteHistoryItem) => {
    setSql(item.sql);
    sqlRef.current?.focus();
  }, []);

  const createUpdateTarget = useCallback((row: Record<string, unknown>): ShellDeskSqliteUpdateTarget | null => {
    if (primaryKeys.length > 0 && primaryKeys.every((column) => row[column] !== undefined)) {
      return {
        pkColumns: primaryKeys,
        pkValues: primaryKeys.map((column) => row[column]),
      };
    }

    if (row[rowidColumn] !== undefined && row[rowidColumn] !== null) {
      return { rowid: row[rowidColumn] };
    }

    return null;
  }, [primaryKeys]);

  const handleCellEdit = useCallback((rowIndex: number, column: string, currentValue: unknown) => {
    if (!isResultEditable || !resultMeta?.object) {
      setMessage({ type: 'info', text: '只有左侧表对象打开的结果集，且能识别主键或 rowid 时才支持编辑。' });
      return;
    }

    if (primaryKeys.includes(column)) {
      setMessage({ type: 'info', text: '主键列不允许直接编辑。' });
      return;
    }

    setEditingCell({
      rowIndex,
      column,
      value: currentValue === null || currentValue === undefined ? '' : String(currentValue),
    });
  }, [isResultEditable, primaryKeys, resultMeta]);

  const prepareCellSave = useCallback(() => {
    if (!editingCell || !queryResult || !resultMeta?.object) return;

    const row = queryResult.rows[editingCell.rowIndex];
    const target = row ? createUpdateTarget(row) : null;
    const oldValue = row?.[editingCell.column];
    const newValue = editingCell.value === '' ? null : editingCell.value;

    setEditingCell(null);

    if (!row || !target) {
      setMessage({ type: 'error', text: '无法定位要更新的 SQLite 行。' });
      return;
    }

    if (valuesEqual(oldValue, newValue)) {
      return;
    }

    setPendingEdit({
      table: resultMeta.object.name,
      rowIndex: editingCell.rowIndex,
      column: editingCell.column,
      oldValue,
      newValue,
      target,
    });
  }, [createUpdateTarget, editingCell, queryResult, resultMeta]);

  const handleCellKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      prepareCellSave();
    } else if (event.key === 'Escape') {
      setEditingCell(null);
    }
  }, [prepareCellSave]);

  const handleConfirmCellSave = useCallback(async () => {
    if (!pendingEdit || !api?.connections || !sqliteId || !queryResult) return;

    setEditSaving(true);
    setMessage(null);

    try {
      const result = await api.connections.sqliteUpdateCell(
        connectionId,
        sqliteId,
        pendingEdit.table,
        pendingEdit.column,
        pendingEdit.newValue,
        pendingEdit.target,
      );

      if (result.affectedRows <= 0) {
        setMessage({ type: 'warning', text: '更新语句未影响任何行，可能目标行已变化。' });
      } else {
        setQueryResult((prev) => {
          if (!prev) return prev;
          const nextRows = [...prev.rows];
          nextRows[pendingEdit.rowIndex] = {
            ...nextRows[pendingEdit.rowIndex],
            [pendingEdit.column]: pendingEdit.newValue,
          };
          return { ...prev, rows: nextRows };
        });
        setMessage({ type: 'success', text: `已更新 ${pendingEdit.column}。` });
      }
      setPendingEdit(null);
    } catch (error) {
      setMessage({ type: 'error', text: getErrorMessage(error) });
    } finally {
      setEditSaving(false);
    }
  }, [api, connectionId, pendingEdit, queryResult, sqliteId]);

  const handleConfirmWriteSql = useCallback(async () => {
    if (!pendingWrite) return;

    const statement = pendingWrite.sql;
    setPendingWrite(null);
    await executeSql(statement);
  }, [executeSql, pendingWrite]);

  useEffect(() => {
    if (!initialFilePath || autoOpenRef.current) return;

    autoOpenRef.current = true;
    void openDatabase(initialFilePath);
  }, [initialFilePath, openDatabase]);

  useEffect(() => {
    return () => {
      const activeSqliteId = sqliteIdRef.current;

      if (activeSqliteId && api?.connections) {
        api.connections.sqliteClose(connectionId, activeSqliteId).catch(() => {});
      }
    };
  }, [api, connectionId]);

  if (!isReady) {
    return (
      <>
        <div className="sqlite-connect-panel">
          <form
            className="sqlite-connect-card"
            onSubmit={(event) => {
              event.preventDefault();
              handleOpen();
            }}
          >
            <div className="sqlite-connect-heading">
              <span className="sqlite-connect-mark">SQL</span>
              <div>
                <h3>{initialFilePath ? '打开 SQLite 数据库' : 'SQLite 数据库管理'}</h3>
                <p className="sqlite-connect-hint">选择远程文件并进入表、视图、索引工作区</p>
              </div>
            </div>
            {errorMessage ? (
              <DismissibleAlert className="sqlite-error-banner" onDismiss={() => setErrorMessage('')} role="alert">
                {errorMessage}
              </DismissibleAlert>
            ) : null}
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
                <button type="button" className="sqlite-browse-btn" onClick={() => setFilePickerVisible(true)} disabled={status === 'opening'}>
                  选择
                </button>
              </div>
            </label>
            {recentFiles.length > 0 ? (
              <div className="sqlite-recent-files">
                <span>最近文件</span>
                {recentFiles.map((recentPath) => (
                  <button key={recentPath} type="button" onClick={() => setFilePath(recentPath)} title={recentPath}>
                    {getFileName(recentPath)}
                  </button>
                ))}
              </div>
            ) : null}
            <button type="submit" className="sqlite-connect-btn" disabled={status === 'opening' || !filePath.trim()}>
              {status === 'opening' ? '打开中...' : '打开数据库'}
            </button>
          </form>
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
    <>
      <div className="sqlite-layout">
        <aside className="sqlite-sidebar">
          <div className="sqlite-sidebar-header">
            <div>
              <strong>对象浏览</strong>
              <span>{objects.length} 个对象</span>
            </div>
            <button type="button" onClick={() => void refreshObjects()} disabled={objectsLoading} title="刷新对象">
              {objectsLoading ? '...' : '↻'}
            </button>
          </div>
          <div className="sqlite-object-search">
            <input
              type="search"
              value={objectSearch}
              onChange={(event) => setObjectSearch(event.target.value)}
              placeholder="搜索表、视图或索引"
              spellCheck={false}
            />
            {objectSearch ? <button type="button" onClick={() => setObjectSearch('')} title="清空搜索">×</button> : null}
          </div>
          <div className="sqlite-tree">
            {filteredGroups.map((group) => (
              <div key={group.type} className="sqlite-tree-group">
                <div className="sqlite-tree-group-title">
                  <span>{getObjectTypeLabel(group.type)}</span>
                  <em>{group.items.length}</em>
                </div>
                {group.items.map((object) => (
                  <button
                    key={`${object.type}:${object.name}`}
                    type="button"
                    className={`sqlite-tree-object-btn ${selectedObject?.type === object.type && selectedObject.name === object.name ? 'selected' : ''}`}
                    onClick={() => void handleSelectObject(object)}
                    title={object.tableName && object.tableName !== object.name ? `${object.name} · ${object.tableName}` : object.name}
                  >
                    <span className={`sqlite-tree-mark type-${object.type}`}>{getObjectTypeMark(object.type)}</span>
                    <span className="sqlite-tree-name">{object.name}</span>
                    {object.tableName && object.tableName !== object.name ? <em>{object.tableName}</em> : null}
                  </button>
                ))}
                {group.items.length === 0 ? <div className="sqlite-tree-empty">无对象</div> : null}
              </div>
            ))}
          </div>
          <div className="sqlite-history">
            <div className="sqlite-history-title">
              <strong>查询历史</strong>
              <span>{history.length}</span>
            </div>
            <div className="sqlite-history-list">
              {history.length === 0 ? (
                <div className="sqlite-history-empty">执行查询后会记录在这里</div>
              ) : history.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`sqlite-history-item ${item.status}`}
                  onClick={() => handleUseHistory(item)}
                  title={item.error ?? item.sql}
                >
                  <span className="sqlite-history-sql">{formatSqlPreview(item.sql, 34)}</span>
                  <span className="sqlite-history-meta">
                    {formatTimestamp(item.createdAt)} · {item.status === 'success' ? `${item.rowCount ?? 0} 行` : '错误'} · {item.queryTime}ms
                  </span>
                </button>
              ))}
            </div>
          </div>
        </aside>

        <main className="sqlite-main">
          <div className="sqlite-topbar">
            <div className="sqlite-file-summary">
              <span className="sqlite-status-dot" />
              <strong title={filePath}>{getFileName(filePath)}</strong>
              <span title={filePath}>{filePath}</span>
            </div>
            <button type="button" className="sqlite-disconnect-btn" onClick={() => void handleClose()} title="关闭数据库">关闭</button>
          </div>

          <section className="sqlite-editor-area">
            <div className="sqlite-editor-toolbar">
              <button type="button" className="sqlite-run-btn" onClick={handleExecuteSql} disabled={queryRunning || !sql.trim()}>
                {queryRunning ? '执行中...' : '执行'}
              </button>
              <span className="sqlite-editor-hint">Ctrl+Enter 执行</span>
              {selectedObject ? (
                <span className="sqlite-active-object">
                  {getObjectTypeLabel(selectedObject.type)}: {selectedObject.name}
                </span>
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
          </section>

          <section className="sqlite-result-area">
            <div className="sqlite-workspace-tabs" role="tablist" aria-label="SQLite 工作区">
              <button type="button" className={activePanel === 'data' ? 'active' : ''} onClick={() => setActivePanel('data')}>数据</button>
              <button type="button" className={activePanel === 'schema' ? 'active' : ''} onClick={() => setActivePanel('schema')}>Schema</button>
            </div>
            {message ? (
              <DismissibleAlert
                className={`sqlite-message-banner ${message.type}`}
                onDismiss={() => setMessage(null)}
                role={message.type === 'error' ? 'alert' : 'status'}
              >
                {message.text}
              </DismissibleAlert>
            ) : null}

            {activePanel === 'schema' ? (
              <div className="sqlite-schema-panel">
                {selectedObject ? (
                  <>
                    <div className="sqlite-schema-heading">
                      <strong>{selectedObject.name}</strong>
                      <span>{getObjectTypeLabel(selectedObject.type)}{selectedObject.tableName ? ` · ${selectedObject.tableName}` : ''}</span>
                    </div>
                    {columns.length > 0 ? (
                      <div className="sqlite-column-grid">
                        {columns.map((column) => (
                          <div key={column.name} className="sqlite-column-card">
                            <strong>{column.name}</strong>
                            <span>{column.type || 'ANY'}</span>
                            {column.pk ? <em>PK</em> : null}
                            {!column.nullable ? <em>NN</em> : null}
                          </div>
                        ))}
                      </div>
                    ) : null}
                    <pre className="sqlite-schema-sql">{schemaSql || '该对象没有 schema SQL。'}</pre>
                  </>
                ) : (
                  <div className="sqlite-result-placeholder">
                    <strong>选择对象查看 Schema</strong>
                    <span>左侧对象树包含表、视图和索引。</span>
                  </div>
                )}
              </div>
            ) : queryResult ? (
              <>
                <div className={`sqlite-result-info ${resultMeta?.writeStatement ? 'write' : ''}`}>
                  <span>{resultMeta?.writeStatement ? '写入完成' : `${queryResult.rows.length} 行`}</span>
                  <span>{resultMeta?.queryTime ?? 0}ms</span>
                  <span>{resultMeta?.object ? `${getObjectTypeLabel(resultMeta.object.type)} ${resultMeta.object.name}` : 'SQL 结果'}</span>
                  <span>
                    {isResultEditable
                      ? primaryKeys.length > 0 ? `可编辑 · 主键 ${primaryKeys.join(', ')}` : '可编辑 · rowid'
                      : resultMeta?.source === 'object' ? '只读 · 未识别主键或 rowid' : '只读 · 手写 SQL'}
                  </span>
                </div>
                {visibleColumns.length > 0 ? (
                  <>
                    <div className="sqlite-table-wrapper">
                      <table className="sqlite-data-table">
                        <thead>
                          <tr>
                            <th className="sqlite-row-num">#</th>
                            {visibleColumns.map((column) => {
                              const meta = columns.find((item) => item.name === column);
                              return (
                                <th key={column}>
                                  <span>{column}</span>
                                  {meta?.pk ? <em>PK</em> : null}
                                  {meta?.type ? <small>{meta.type}</small> : null}
                                </th>
                              );
                            })}
                          </tr>
                        </thead>
                        <tbody>
                          {pagedRows.map((row, rowIndex) => {
                            const globalRowIndex = page * pageSize + rowIndex;

                            return (
                              <tr key={globalRowIndex}>
                                <td className="sqlite-row-num">{globalRowIndex + 1}</td>
                                {visibleColumns.map((column) => {
                                  const cellValue = row[column];
                                  const isEditing = editingCell?.rowIndex === globalRowIndex && editingCell.column === column;
                                  const isEditableColumn = isResultEditable && !primaryKeys.includes(column);

                                  if (isEditing) {
                                    return (
                                      <td key={column} className="sqlite-cell-editing">
                                        <input
                                          type="text"
                                          value={editingCell.value}
                                          onChange={(event) => setEditingCell({ ...editingCell, value: event.target.value })}
                                          onKeyDown={handleCellKeyDown}
                                          onBlur={prepareCellSave}
                                          autoFocus
                                          className="sqlite-cell-input"
                                        />
                                      </td>
                                    );
                                  }

                                  return (
                                    <td
                                      key={column}
                                      className={`${cellValue === null ? 'sqlite-cell-null' : ''} ${isEditableColumn ? 'sqlite-cell-editable' : ''}`}
                                      onDoubleClick={() => handleCellEdit(globalRowIndex, column, cellValue)}
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
                  <div className="sqlite-result-empty">
                    <strong>查询已执行</strong>
                    <span>该语句没有返回表格数据。</span>
                  </div>
                )}
              </>
            ) : (
              <div className="sqlite-result-placeholder">
                <strong>选择对象或执行 SQL</strong>
                <span>表和视图预览默认限制 {tablePreviewLimit} 行。</span>
              </div>
            )}
          </section>
        </main>
      </div>

      {pendingEdit ? createPortal(
        <div className="sqlite-modal-backdrop" role="presentation">
          <div className="sqlite-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="sqlite-edit-title">
            <div className="sqlite-edit-dialog-header">
              <strong id="sqlite-edit-title">确认更新单元格</strong>
              <span>{pendingEdit.table}</span>
            </div>
            <div className="sqlite-edit-summary">
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
                <span>定位</span>
                <code>
                  {pendingEdit.target.pkColumns?.length
                    ? pendingEdit.target.pkColumns.map((column, index) => `${column}=${formatCellValue(pendingEdit.target.pkValues?.[index])}`).join(' AND ')
                    : `rowid=${formatCellValue(pendingEdit.target.rowid)}`}
                </code>
              </div>
            </div>
            <p className="sqlite-edit-warning">该操作会直接修改远程 SQLite 文件。数据库被锁定时会保留当前查询上下文。</p>
            <div className="sqlite-edit-actions">
              <button type="button" onClick={() => setPendingEdit(null)} disabled={editSaving}>取消</button>
              <button type="button" className="primary" onClick={() => void handleConfirmCellSave()} disabled={editSaving}>
                {editSaving ? '提交中...' : '确认更新'}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}

      {pendingWrite ? createPortal(
        <div className="sqlite-modal-backdrop" role="presentation">
          <div className="sqlite-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="sqlite-write-title">
            <div className="sqlite-edit-dialog-header">
              <strong id="sqlite-write-title">确认执行写入 SQL</strong>
              <span>{getFileName(filePath)}</span>
            </div>
            <p className="sqlite-write-sql">{formatSqlPreview(pendingWrite.sql, 180)}</p>
            <p className="sqlite-edit-warning">写入语句会修改远程数据库文件，请确认已了解该语句影响范围。</p>
            <div className="sqlite-edit-actions">
              <button type="button" onClick={() => setPendingWrite(null)} disabled={queryRunning}>取消</button>
              <button type="button" className="primary" onClick={() => void handleConfirmWriteSql()} disabled={queryRunning}>
                {queryRunning ? '执行中...' : '确认执行'}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}

export default RemoteSqlite;
