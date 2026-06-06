import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import DismissibleAlert from './DismissibleAlert';
import RemoteFilePicker from './RemoteFilePicker';
import { clearCachedSudoPassword, getCachedSudoOptions, setCachedSudoPassword } from './sudoPrompt';
import type { RemoteSystemType } from './types';
import { tCurrent } from '../../i18n';

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

interface SqliteSudoPrompt {
  operation: string;
  target: string;
  error: string;
  password: string;
}

const pageSize = 100;
const tablePreviewLimit = 500;
const maxHistoryItems = 12;
const rowidColumn = '__shelldesk_rowid';
const elevationErrorPrefixes = [
  'SHELLDESK_ELEVATION_REQUIRED:',
  'SHELLDESK_ELEVATION_AUTH_FAILED:',
];

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function formatSqlPreview(sql: string, length = 56): string {
  const compact = sql.replace(/\s+/g, ' ').trim();
  if (!compact) return tCurrent('auto.remoteSqlite.18ivnwu');
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
    case 'table': return tCurrent('auto.remoteSqlite.1tjg76f');
    case 'view': return tCurrent('auto.remoteSqlite.z4lltx');
    case 'index': return tCurrent('auto.remoteSqlite.1lig4k0');
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

function shouldPromptForSudoPassword(error: unknown) {
  const message = getErrorMessage(error);

  if (elevationErrorPrefixes.some((prefix) => message.startsWith(prefix))) {
    return true;
  }

  return /sudo.*password|password.*sudo|a password is required|authentication failure|sorry, try again/i.test(message);
}

function getPrivilegeErrorMessage(error: unknown) {
  const message = getErrorMessage(error);
  const prefix = elevationErrorPrefixes.find((candidate) => message.startsWith(candidate));

  return prefix ? message.slice(prefix.length).trim() || message : message;
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
  const sudoPasswordInputRef = useRef<HTMLInputElement | null>(null);
  const sudoPromptResolverRef = useRef<((password: string | null) => void) | null>(null);

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
  const [sudoPrompt, setSudoPrompt] = useState<SqliteSudoPrompt | null>(null);

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

  const requestSudoPassword = useCallback((
    operation: string,
    target: string,
    error: string,
  ) => new Promise<string | null>((resolve) => {
    sudoPromptResolverRef.current?.(null);
    sudoPromptResolverRef.current = resolve;
    setSudoPrompt({
      operation,
      target,
      error,
      password: '',
    });
  }), []);

  const resolveSudoPrompt = useCallback((password: string | null) => {
    sudoPromptResolverRef.current?.(password);
    sudoPromptResolverRef.current = null;
    setSudoPrompt(null);
  }, []);

  const runWithSudoRetry = useCallback(async <T,>(
    operation: string,
    target: string,
    run: (options?: ShellDeskSudoPasswordOptions) => Promise<T>,
    useStoredPassword = true,
  ): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (systemType === 'windows' || !shouldPromptForSudoPassword(error)) {
        throw error;
      }

      let lastError = getPrivilegeErrorMessage(error);
      const cachedOptions = useStoredPassword ? getCachedSudoOptions(connectionId) : undefined;

      if (cachedOptions) {
        try {
          return await run(cachedOptions);
        } catch (cachedError) {
          if (!shouldPromptForSudoPassword(cachedError)) {
            throw cachedError;
          }

          clearCachedSudoPassword(connectionId);
          lastError = getPrivilegeErrorMessage(cachedError);
        }
      }

      for (;;) {
        const sudoPassword = await requestSudoPassword(operation, target, lastError);

        if (sudoPassword === null) {
          throw new Error(lastError);
        }

        try {
          const result = await run({ sudoPassword });
          setCachedSudoPassword(connectionId, sudoPassword);
          return result;
        } catch (retryError) {
          if (!shouldPromptForSudoPassword(retryError)) {
            throw retryError;
          }

          clearCachedSudoPassword(connectionId);
          lastError = getPrivilegeErrorMessage(retryError);
        }
      }
    }
  }, [connectionId, requestSudoPassword, systemType]);

  useEffect(() => {
    if (sudoPrompt) {
      sudoPasswordInputRef.current?.focus();
    }
  }, [sudoPrompt?.operation, sudoPrompt?.target]);

  useEffect(() => () => {
    sudoPromptResolverRef.current?.(null);
    sudoPromptResolverRef.current = null;
  }, []);

  const refreshObjects = useCallback(async (sqliteIdOverride?: string) => {
    const activeSqliteId = sqliteIdOverride ?? sqliteId;

    if (!api?.connections || !activeSqliteId) return;

    setObjectsLoading(true);
    setMessage(null);

    try {
      const nextObjects = await runWithSudoRetry(
        tCurrent('sqlite.sudo.operation.refresh'),
        filePath || activeSqliteId,
        (options) => api.connections.sqliteObjects(connectionId, activeSqliteId, options),
      );
      setObjects(nextObjects);
      setMessage({ type: 'success', text: tCurrent('auto.remoteSqlite.1cb3a9') });
    } catch (error) {
      setMessage({ type: 'error', text: getErrorMessage(error) });
    } finally {
      setObjectsLoading(false);
    }
  }, [api, connectionId, filePath, runWithSudoRetry, sqliteId]);

  const openDatabase = useCallback(async (nextFilePath: string) => {
    if (!api?.connections || !nextFilePath.trim()) return;

    const trimmedPath = nextFilePath.trim();
    setStatus('opening');
    setErrorMessage('');
    setMessage(null);
    resetWorkspace();

    try {
      const result = await runWithSudoRetry(
        tCurrent('sqlite.sudo.operation.open'),
        trimmedPath,
        (options) => api.connections.sqliteOpen(connectionId, trimmedPath, options),
      );
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
  }, [api, connectionId, refreshObjects, resetWorkspace, runWithSudoRetry]);

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
      const schema = await runWithSudoRetry(
        tCurrent('sqlite.sudo.operation.schema'),
        filePath,
        (options) => api.connections.sqliteSchema(connectionId, sqliteId, object.type, object.name, options),
      );
      setSchemaSql(schema.sql || object.sql || '');
    } catch {
      setSchemaSql(object.sql || '');
    }

    if (!isDataObject) {
      return;
    }

    try {
      const nextColumns = await runWithSudoRetry(
        tCurrent('sqlite.sudo.operation.schema'),
        filePath,
        (options) => api.connections.sqliteColumns(connectionId, sqliteId, object.name, options),
      );
      let nextResult: ShellDeskSqliteQueryResult;
      let rowidAvailable = false;
      let executedSql = preferredSql;

      try {
        nextResult = await runWithSudoRetry(
          tCurrent('sqlite.sudo.operation.query'),
          filePath,
          (options) => api.connections.sqliteQuery(connectionId, sqliteId, preferredSql, options),
        );
        rowidAvailable = nextResult.columns.includes(rowidColumn);
      } catch (error) {
        if (object.type !== 'table') throw error;
        executedSql = fallbackSql;
        nextResult = await runWithSudoRetry(
          tCurrent('sqlite.sudo.operation.query'),
          filePath,
          (options) => api.connections.sqliteQuery(connectionId, sqliteId, fallbackSql, options),
        );
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
  }, [addHistoryItem, api, connectionId, filePath, runWithSudoRetry, sqliteId]);

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
      const result = await runWithSudoRetry(
        tCurrent('sqlite.sudo.operation.query'),
        filePath,
        (options) => api.connections.sqliteQuery(connectionId, sqliteId, statement, options),
      );
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
        text: writeStatement ? tCurrent('auto.remoteSqlite.w6wj8s') : tCurrent('auto.remoteSqlite.1bkgqz9', { value0: result.rows.length }),
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
  }, [addHistoryItem, api, connectionId, filePath, refreshObjects, runWithSudoRetry, sqliteId]);

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
      setMessage({ type: 'info', text: tCurrent('auto.remoteSqlite.1wmtlu9') });
      return;
    }

    if (primaryKeys.includes(column)) {
      setMessage({ type: 'info', text: tCurrent('auto.remoteSqlite.133xgxb') });
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
      setMessage({ type: 'error', text: tCurrent('auto.remoteSqlite.ae9ydc') });
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
      const result = await runWithSudoRetry(
        tCurrent('sqlite.sudo.operation.update'),
        filePath,
        (options) => api.connections.sqliteUpdateCell(
          connectionId,
          sqliteId,
          pendingEdit.table,
          pendingEdit.column,
          pendingEdit.newValue,
          pendingEdit.target,
          options,
        ),
      );

      if (result.affectedRows <= 0) {
        setMessage({ type: 'warning', text: tCurrent('auto.remoteSqlite.1hypi28') });
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
        setMessage({ type: 'success', text: tCurrent('auto.remoteSqlite.1n0fqgo', { value0: pendingEdit.column }) });
      }
      setPendingEdit(null);
    } catch (error) {
      setMessage({ type: 'error', text: getErrorMessage(error) });
    } finally {
      setEditSaving(false);
    }
  }, [api, connectionId, filePath, pendingEdit, queryResult, runWithSudoRetry, sqliteId]);

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

  const sudoPromptPortal = sudoPrompt ? createPortal(
    <div className="notepad-modal-overlay" role="presentation" onClick={() => resolveSudoPrompt(null)}>
      <form
        className="notepad-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sqlite-sudo-title"
        onSubmit={(event) => {
          event.preventDefault();
          resolveSudoPrompt(sudoPrompt.password);
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div id="sqlite-sudo-title" className="notepad-modal-title">{tCurrent('sqlite.sudo.title')}</div>
        <div className="notepad-modal-message">
          {tCurrent('sqlite.sudo.message', {
            operation: sudoPrompt.operation,
            target: sudoPrompt.target,
          })}
        </div>
        {sudoPrompt.error ? <div className="notepad-modal-message">{sudoPrompt.error}</div> : null}
        <label className="notepad-modal-field">
          <span>{tCurrent('sqlite.sudo.password')}</span>
          <input
            ref={sudoPasswordInputRef}
            className="notepad-modal-input"
            type="password"
            value={sudoPrompt.password}
            autoComplete="current-password"
            onChange={(event) => setSudoPrompt((current) => current ? { ...current, password: event.target.value } : current)}
          />
        </label>
        <div className="notepad-modal-actions">
          <button type="button" className="notepad-modal-btn" onClick={() => resolveSudoPrompt(null)}>{tCurrent('auto.remoteSqlite.1589w37')}</button>
          <button type="submit" className="notepad-modal-btn primary">{tCurrent('sqlite.sudo.continue')}</button>
        </div>
      </form>
    </div>,
    document.body,
  ) : null;

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
                <h3>{initialFilePath ? tCurrent('auto.remoteSqlite.1x733v9') : tCurrent('auto.remoteSqlite.ushqjl')}</h3>
                <p className="sqlite-connect-hint">{tCurrent('auto.remoteSqlite.1mnccbf')}</p>
              </div>
            </div>
            {errorMessage ? (
              <DismissibleAlert className="sqlite-error-banner" onDismiss={() => setErrorMessage('')} role="alert">
                {errorMessage}
              </DismissibleAlert>
            ) : null}
            <label className="sqlite-field">
              <span>{tCurrent('auto.remoteSqlite.ctpleq')}</span>
              <div className="sqlite-path-input-row">
                <input
                  type="text"
                  value={filePath}
                  onChange={(event) => setFilePath(event.target.value)}
                  placeholder="/path/to/database.db"
                  disabled={status === 'opening'}
                />
                <button type="button" className="sqlite-browse-btn" onClick={() => setFilePickerVisible(true)} disabled={status === 'opening'}>
                  {tCurrent('auto.remoteSqlite.qlswjb')}</button>
              </div>
            </label>
            {recentFiles.length > 0 ? (
              <div className="sqlite-recent-files">
                <span>{tCurrent('auto.remoteSqlite.1vw8bwz')}</span>
                {recentFiles.map((recentPath) => (
                  <button key={recentPath} type="button" onClick={() => setFilePath(recentPath)} title={recentPath}>
                    {getFileName(recentPath)}
                  </button>
                ))}
              </div>
            ) : null}
            <button type="submit" className="sqlite-connect-btn" disabled={status === 'opening' || !filePath.trim()}>
              {status === 'opening' ? tCurrent('auto.remoteSqlite.1kvliz9') : tCurrent('auto.remoteSqlite.29a8ad')}
            </button>
          </form>
        </div>
        <RemoteFilePicker
          connectionId={connectionId}
          systemType={systemType}
          mode="open"
          title={tCurrent('auto.remoteSqlite.6gz0bb')}
          visible={filePickerVisible}
          onConfirm={(selectedPath) => {
            setFilePickerVisible(false);
            setFilePath(selectedPath);
          }}
          onCancel={() => setFilePickerVisible(false)}
        />
        {sudoPromptPortal}
      </>
    );
  }

  return (
    <>
      <div className="sqlite-layout">
        <aside className="sqlite-sidebar">
          <div className="sqlite-sidebar-header">
            <div>
              <strong>{tCurrent('auto.remoteSqlite.dzec2g')}</strong>
              <span>{objects.length} {tCurrent('auto.remoteSqlite.13jip7b')}</span>
            </div>
            <button type="button" onClick={() => void refreshObjects()} disabled={objectsLoading} title={tCurrent('auto.remoteSqlite.oj1z9s')}>
              {objectsLoading ? '...' : '↻'}
            </button>
          </div>
          <div className="sqlite-object-search">
            <input
              type="search"
              value={objectSearch}
              onChange={(event) => setObjectSearch(event.target.value)}
              placeholder={tCurrent('auto.remoteSqlite.46zdab')}
              spellCheck={false}
            />
            {objectSearch ? <button type="button" onClick={() => setObjectSearch('')} title={tCurrent('auto.remoteSqlite.18bjen0')}>×</button> : null}
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
                {group.items.length === 0 ? <div className="sqlite-tree-empty">{tCurrent('auto.remoteSqlite.a1k4p')}</div> : null}
              </div>
            ))}
          </div>
          <div className="sqlite-history">
            <div className="sqlite-history-title">
              <strong>{tCurrent('auto.remoteSqlite.air9hy')}</strong>
              <span>{history.length}</span>
            </div>
            <div className="sqlite-history-list">
              {history.length === 0 ? (
                <div className="sqlite-history-empty">{tCurrent('auto.remoteSqlite.mkpr6n')}</div>
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
                    {formatTimestamp(item.createdAt)} · {item.status === 'success' ? tCurrent('auto.remoteSqlite.18tehe0', { value0: item.rowCount ?? 0 }) : tCurrent('auto.remoteSqlite.v9pftt')} · {item.queryTime}ms
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
            <button type="button" className="sqlite-disconnect-btn" onClick={() => void handleClose()} title={tCurrent('auto.remoteSqlite.yzmgm0')}>{tCurrent('auto.remoteSqlite.g0fanx')}</button>
          </div>

          <section className="sqlite-editor-area">
            <div className="sqlite-editor-toolbar">
              <button type="button" className="sqlite-run-btn" onClick={handleExecuteSql} disabled={queryRunning || !sql.trim()}>
                {queryRunning ? tCurrent('auto.remoteSqlite.e2byz1') : tCurrent('auto.remoteSqlite.6azgji')}
              </button>
              <span className="sqlite-editor-hint">{tCurrent('auto.remoteSqlite.cj2ebw')}</span>
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
              placeholder={tCurrent('auto.remoteSqlite.1bvo5bt')}
              spellCheck={false}
            />
          </section>

          <section className="sqlite-result-area">
            <div className="sqlite-workspace-tabs" role="tablist" aria-label={tCurrent('auto.remoteSqlite.avpwck')}>
              <button type="button" className={activePanel === 'data' ? 'active' : ''} onClick={() => setActivePanel('data')}>{tCurrent('auto.remoteSqlite.adup77')}</button>
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
                    <pre className="sqlite-schema-sql">{schemaSql || tCurrent('auto.remoteSqlite.3nm0f')}</pre>
                  </>
                ) : (
                  <div className="sqlite-result-placeholder">
                    <strong>{tCurrent('auto.remoteSqlite.j6kkls')}</strong>
                    <span>{tCurrent('auto.remoteSqlite.oodm6h')}</span>
                  </div>
                )}
              </div>
            ) : queryResult ? (
              <>
                <div className={`sqlite-result-info ${resultMeta?.writeStatement ? 'write' : ''}`}>
                  <span>{resultMeta?.writeStatement ? tCurrent('auto.remoteSqlite.pnzml3') : tCurrent('auto.remoteSqlite.18tehe02', { value0: queryResult.rows.length })}</span>
                  <span>{resultMeta?.queryTime ?? 0}ms</span>
                  <span>{resultMeta?.object ? `${getObjectTypeLabel(resultMeta.object.type)} ${resultMeta.object.name}` : tCurrent('auto.remoteSqlite.sjr2ya')}</span>
                  <span>
                    {isResultEditable
                      ? primaryKeys.length > 0 ? tCurrent('auto.remoteSqlite.zacxkg', { value0: primaryKeys.join(', ') }) : tCurrent('auto.remoteSqlite.zfahz')
                      : resultMeta?.source === 'object' ? tCurrent('auto.remoteSqlite.11g20o2') : tCurrent('auto.remoteSqlite.1g60mb5')}
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
                        <button type="button" disabled={page === 0} onClick={() => setPage(0)}>{tCurrent('auto.remoteSqlite.1ow5v10')}</button>
                        <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>{tCurrent('auto.remoteSqlite.mtyn6e')}</button>
                        <span>{page + 1} / {totalPages}</span>
                        <button type="button" disabled={page >= totalPages - 1} onClick={() => setPage(page + 1)}>{tCurrent('auto.remoteSqlite.1yw313l')}</button>
                        <button type="button" disabled={page >= totalPages - 1} onClick={() => setPage(totalPages - 1)}>{tCurrent('auto.remoteSqlite.ixvu31')}</button>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className="sqlite-result-empty">
                    <strong>{tCurrent('auto.remoteSqlite.8p0dx3')}</strong>
                    <span>{tCurrent('auto.remoteSqlite.vpza2y')}</span>
                  </div>
                )}
              </>
            ) : (
              <div className="sqlite-result-placeholder">
                <strong>{tCurrent('auto.remoteSqlite.lcteg6')}</strong>
                <span>{tCurrent('auto.remoteSqlite.1xowp13')}{tablePreviewLimit} {tCurrent('auto.remoteSqlite.1nb4i6j')}</span>
              </div>
            )}
          </section>
        </main>
      </div>

      {pendingEdit ? createPortal(
        <div className="sqlite-modal-backdrop" role="presentation">
          <div className="sqlite-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="sqlite-edit-title">
            <div className="sqlite-edit-dialog-header">
              <strong id="sqlite-edit-title">{tCurrent('auto.remoteSqlite.5pj76l')}</strong>
              <span>{pendingEdit.table}</span>
            </div>
            <div className="sqlite-edit-summary">
              <div>
                <span>{tCurrent('auto.remoteSqlite.vomz89')}</span>
                <strong>{pendingEdit.column}</strong>
              </div>
              <div>
                <span>{tCurrent('auto.remoteSqlite.12o2s46')}</span>
                <code>{formatCellValue(pendingEdit.oldValue)}</code>
              </div>
              <div>
                <span>{tCurrent('auto.remoteSqlite.1wg5cdl')}</span>
                <code>{formatCellValue(pendingEdit.newValue)}</code>
              </div>
              <div>
                <span>{tCurrent('auto.remoteSqlite.10tg474')}</span>
                <code>
                  {pendingEdit.target.pkColumns?.length
                    ? pendingEdit.target.pkColumns.map((column, index) => `${column}=${formatCellValue(pendingEdit.target.pkValues?.[index])}`).join(' AND ')
                    : `rowid=${formatCellValue(pendingEdit.target.rowid)}`}
                </code>
              </div>
            </div>
            <p className="sqlite-edit-warning">{tCurrent('auto.remoteSqlite.gyrwjf')}</p>
            <div className="sqlite-edit-actions">
              <button type="button" onClick={() => setPendingEdit(null)} disabled={editSaving}>{tCurrent('auto.remoteSqlite.1589w37')}</button>
              <button type="button" className="primary" onClick={() => void handleConfirmCellSave()} disabled={editSaving}>
                {editSaving ? tCurrent('auto.remoteSqlite.xwkgei') : tCurrent('auto.remoteSqlite.1k3x0w3')}
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
              <strong id="sqlite-write-title">{tCurrent('auto.remoteSqlite.1nifixi')}</strong>
              <span>{getFileName(filePath)}</span>
            </div>
            <p className="sqlite-write-sql">{formatSqlPreview(pendingWrite.sql, 180)}</p>
            <p className="sqlite-edit-warning">{tCurrent('auto.remoteSqlite.18e5rud')}</p>
            <div className="sqlite-edit-actions">
              <button type="button" onClick={() => setPendingWrite(null)} disabled={queryRunning}>{tCurrent('auto.remoteSqlite.1589w372')}</button>
              <button type="button" className="primary" onClick={() => void handleConfirmWriteSql()} disabled={queryRunning}>
                {queryRunning ? tCurrent('auto.remoteSqlite.e2byz12') : tCurrent('auto.remoteSqlite.1lw0tr0')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}

      {sudoPromptPortal}
    </>
  );
}

export default RemoteSqlite;
