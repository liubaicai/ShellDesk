import { type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { indentWithTab } from '@codemirror/commands';
import { MySQL, sql } from '@codemirror/lang-sql';
import type { Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';

import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import { exportDatabaseRows, type DatabaseExportFormat } from './databaseExport';
import {
  appendDatabaseFallbackReason,
  createGenericColumns,
  createId,
  describeDatabaseTransport,
  formatCellValue,
  formatSqlPreview,
  formatTimestamp,
  isWriteStatement,
  quoteIdentifier,
  useContextMenu,
} from './databaseUtils';
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
  isNull: boolean;
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

interface MysqlSortState {
  resultId: string;
  column: string;
  direction: 'asc' | 'desc';
}

interface MysqlRowEntry {
  row: Record<string, unknown>;
  index: number;
}

type MysqlContextMenuTarget =
  | { type: 'database'; database: string }
  | { type: 'table'; database: string; table: string };

interface MysqlContextMenuState {
  x: number;
  y: number;
  target: MysqlContextMenuTarget;
}

interface SchemaColumn {
  id: string;
  name: string;
  type: string;
  length: string;
  nullable: boolean;
  defaultValue: string;
  autoIncrement: boolean;
  comment: string;
}

interface SchemaIndex {
  id: string;
  type: 'INDEX' | 'UNIQUE' | 'FULLTEXT' | 'SPATIAL';
  columns: string[];
  name: string;
}

interface SchemaForeignKey {
  id: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete: string;
  onUpdate: string;
}

interface CreateTableState {
  open: boolean;
  database: string;
  tableName: string;
  engine: string;
  charset: string;
  comment: string;
  columns: SchemaColumn[];
  primaryKeyColumns: string[];
  indexes: SchemaIndex[];
  foreignKeys: SchemaForeignKey[];
  showAdvanced: boolean;
  executing: boolean;
}

const defaultPort = 3306;
const pageSize = 100;
const tablePreviewLimit = 50;
const maxResultTabs = 10;
const maxHistoryItems = 12;
const mysqlColumnTypes = ['INT', 'BIGINT', 'VARCHAR', 'TEXT', 'BOOLEAN', 'DATE', 'DATETIME', 'TIMESTAMP', 'FLOAT', 'DOUBLE', 'DECIMAL', 'BLOB', 'JSON', 'ENUM'];
const mysqlEngines = ['InnoDB', 'MyISAM', 'MEMORY', 'CSV', 'ARCHIVE'];
const mysqlCharsets = ['utf8mb4', 'utf8', 'utf8mb3', 'latin1', 'ascii', 'utf16', 'utf32'];
const mysqlForeignKeyActions = ['RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION'];
const mysqlIntegerTypes = new Set(['INT', 'BIGINT', 'SMALLINT', 'TINYINT', 'MEDIUMINT']);
const mysqlTypesWithoutLength = new Set(['DATE', 'DATETIME', 'TIMESTAMP', 'TEXT', 'BOOLEAN', 'JSON', 'BLOB']);

function createSchemaColumn(): SchemaColumn {
  return {
    id: createId('column'),
    name: '',
    type: 'INT',
    length: '',
    nullable: false,
    defaultValue: '',
    autoIncrement: false,
    comment: '',
  };
}

function createSchemaIndex(): SchemaIndex {
  return {
    id: createId('index'),
    type: 'INDEX',
    columns: [],
    name: '',
  };
}

function createSchemaForeignKey(): SchemaForeignKey {
  return {
    id: createId('fk'),
    columns: [],
    refTable: '',
    refColumns: [],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  };
}

function quoteMysqlDefaultValue(value: string): string {
  const trimmed = value.trim();

  if (!trimmed) return '';
  if (/^null$/i.test(trimmed)) return 'NULL';
  if (/^(current_timestamp|current_date|current_time)(\(\))?$/i.test(trimmed)) return trimmed;
  if (/^(uuid|now)\(\)$/i.test(trimmed)) return trimmed;
  if (/^-?\d+(\.\d+)?$/u.test(trimmed)) return trimmed;

  return quoteMysqlString(trimmed);
}

function isMysqlEnumValueList(value: string): boolean {
  const quotedValue = String.raw`'(?:''|\\.|[^'\\])*'`;
  return new RegExp(`^${quotedValue}(?:\\s*,\\s*${quotedValue})*$`, 'u').test(value.trim());
}

function sanitizeMysqlColumnLength(type: string, length: string): string {
  const normalizedType = type.toUpperCase();
  const trimmed = length.trim();

  if (!trimmed || mysqlTypesWithoutLength.has(normalizedType)) return '';
  if (normalizedType === 'ENUM' && isMysqlEnumValueList(trimmed)) return trimmed;

  return trimmed.replace(/[^\d,]/gu, '').replace(/,+/gu, ',').replace(/^,|,$/gu, '');
}

function quoteMysqlQualifiedIdentifier(identifier: string): string {
  const parts = identifier.trim().split('.').map((part) => part.trim()).filter(Boolean);
  return parts.length > 1
    ? parts.map((part) => quoteIdentifier(part, 'mysql')).join('.')
    : quoteIdentifier(identifier.trim(), 'mysql');
}

function getForeignKeyConstraintName(foreignKey: SchemaForeignKey): string {
  const suffix = foreignKey.id.replace(/^fk[-_]?/iu, '').replace(/[^a-z0-9_]/giu, '_').slice(0, 61);
  return `fk_${suffix || Math.random().toString(36).slice(2, 8)}`;
}

function validateCreateTableState(state: CreateTableState): string | null {
  const seenColumnNames = new Set<string>();

  for (const column of state.columns) {
    const columnName = column.name.trim();
    if (!columnName) continue;

    const normalizedColumnName = columnName.toLowerCase();
    if (seenColumnNames.has(normalizedColumnName)) {
      return tCurrent('auto.remoteMySQL.duplicateColumn', { name: columnName });
    }
    seenColumnNames.add(normalizedColumnName);

    const normalizedType = column.type.toUpperCase();
    if (column.autoIncrement && !mysqlIntegerTypes.has(normalizedType)) {
      return tCurrent('auto.remoteMySQL.autoIncrementRequiresInt');
    }
    if (normalizedType === 'ENUM' && !isMysqlEnumValueList(column.length)) {
      return tCurrent('auto.remoteMySQL.enumRequiresValues');
    }
  }

  return null;
}

function generateCreateTableSql(state: CreateTableState): string {
  const tableName = state.tableName.trim();
  const definitions: string[] = state.columns
    .filter((column) => column.name.trim())
    .map((column) => {
      const length = sanitizeMysqlColumnLength(column.type, column.length);
      const type = length ? `${column.type}(${length})` : column.type;
      const parts = [
        quoteIdentifier(column.name.trim(), 'mysql'),
        type,
        column.nullable ? 'NULL' : 'NOT NULL',
      ];
      const defaultValue = quoteMysqlDefaultValue(column.defaultValue);

      if (defaultValue) {
        parts.push(`DEFAULT ${defaultValue}`);
      }
      if (column.autoIncrement) {
        parts.push('AUTO_INCREMENT');
      }
      if (column.comment.trim()) {
        parts.push(`COMMENT ${quoteMysqlString(column.comment.trim())}`);
      }

      return `  ${parts.join(' ')}`;
    });
  const primaryKeyColumns = state.primaryKeyColumns.filter((column) => state.columns.some((item) => item.name.trim() === column));

  if (primaryKeyColumns.length > 0) {
    definitions.push(`  PRIMARY KEY (${primaryKeyColumns.map((column) => quoteIdentifier(column, 'mysql')).join(', ')})`);
  }

  state.indexes.forEach((index) => {
    const columns = index.columns.filter((column) => state.columns.some((item) => item.name.trim() === column));
    if (columns.length === 0) return;

    const name = index.name.trim() ? ` ${quoteIdentifier(index.name.trim(), 'mysql')}` : '';
    definitions.push(`  ${index.type}${name} (${columns.map((column) => quoteIdentifier(column, 'mysql')).join(', ')})`);
  });

  state.foreignKeys.forEach((foreignKey) => {
    const columns = foreignKey.columns.filter((column) => state.columns.some((item) => item.name.trim() === column));
    const refColumns = foreignKey.refColumns.filter((column) => column.trim());
    if (columns.length === 0 || !foreignKey.refTable.trim() || refColumns.length === 0) return;

    const constraintName = quoteIdentifier(getForeignKeyConstraintName(foreignKey), 'mysql');
    const parts = [
      `  CONSTRAINT ${constraintName} FOREIGN KEY (${columns.map((column) => quoteIdentifier(column, 'mysql')).join(', ')})`,
      `REFERENCES ${quoteMysqlQualifiedIdentifier(foreignKey.refTable)} (${refColumns.map((column) => quoteIdentifier(column.trim(), 'mysql')).join(', ')})`,
    ];

    if (foreignKey.onDelete) {
      parts.push(`ON DELETE ${foreignKey.onDelete}`);
    }
    if (foreignKey.onUpdate) {
      parts.push(`ON UPDATE ${foreignKey.onUpdate}`);
    }

    definitions.push(parts.join(' '));
  });

  const options = [`ENGINE=${state.engine || 'InnoDB'}`];
  if (state.charset) {
    options.push(`DEFAULT CHARSET=${state.charset}`);
  }
  if (state.comment.trim()) {
    options.push(`COMMENT=${quoteMysqlString(state.comment.trim())}`);
  }

  return [
    `CREATE TABLE ${quoteIdentifier(tableName || 'table_name', 'mysql')} (`,
    definitions.length > 0 ? definitions.join(',\n') : '  `id` INT NOT NULL',
    `) ${options.join(' ')};`,
  ].join('\n');
}

function translateForeignKeyAction(action: string): string {
  if (action === 'CASCADE') return tCurrent('auto.remoteMySQL.cascade');
  if (action === 'SET NULL') return tCurrent('auto.remoteMySQL.setNull');
  if (action === 'NO ACTION') return tCurrent('auto.remoteMySQL.noAction');
  return tCurrent('auto.remoteMySQL.restrict');
}

function getShellDeskEditorTheme(): 'light' | 'dark' {
  if (typeof document === 'undefined') {
    return 'dark';
  }

  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
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

function quoteMysqlString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left === null || left === undefined) return right === null || right === undefined;
  if (right === null || right === undefined) return false;
  return String(left) === String(right);
}

function getColumnMeta(columns: ShellDeskMysqlColumn[], name: string): ShellDeskMysqlColumn | undefined {
  return columns.find((column) => column.name === name);
}

function describeResult(result: ShellDeskMysqlQueryResult): string {
  if (result.affectedRows !== undefined) {
    const insertText = result.insertId ? tCurrent('auto.remoteMySQL.12xfbkn', { value0: result.insertId }) : '';
    return tCurrent('auto.remoteMySQL.4g1j50', { value0: result.affectedRows, value1: insertText });
  }
  return tCurrent('auto.remoteMySQL.18tehe0', { value0: result.rows.length });
}

function createExplainSql(sqlText: string): string {
  const statement = sqlText.trim().replace(/;+\s*$/, '');

  if (/^explain\b/i.test(statement)) {
    return statement;
  }

  return `EXPLAIN ${statement}`;
}

function compareMysqlCellValues(left: unknown, right: unknown): number {
  if (left === null || left === undefined) return right === null || right === undefined ? 0 : 1;
  if (right === null || right === undefined) return -1;

  const leftNumber = typeof left === 'number' ? left : typeof left === 'string' && left.trim() ? Number(left) : Number.NaN;
  const rightNumber = typeof right === 'number' ? right : typeof right === 'string' && right.trim() ? Number(right) : Number.NaN;

  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber - rightNumber;
  }

  return String(left).localeCompare(String(right), getShellDeskLocale(), {
    numeric: true,
    sensitivity: 'base',
  });
}

function RemoteMySQL({ connectionId, hostId }: RemoteMySQLProps) {
  const api = window.guiSSH;
  const initialQueryStateRef = useRef(createInitialQueryState());
  const mysqlIdRef = useRef('');
  const sqlEditorRef = useRef<ReactCodeMirrorRef>(null);
  const createTablePreviousFocusRef = useRef<Element | null>(null);

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
  const [sortState, setSortState] = useState<MysqlSortState | null>(null);
  const [editorTheme, setEditorTheme] = useState<'light' | 'dark'>(getShellDeskEditorTheme);
  const [contextMenu, setContextMenu] = useState<MysqlContextMenuState | null>(null);
  const [createTableState, setCreateTableState] = useState<CreateTableState>({
    open: false,
    database: '',
    tableName: '',
    engine: 'InnoDB',
    charset: '',
    comment: '',
    columns: [],
    primaryKeyColumns: [],
    indexes: [],
    foreignKeys: [],
    showAdvanced: false,
    executing: false,
  });

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
  const canExplainActiveQuery = canRunActiveQuery && !isWriteStatement(activeQueryTab?.sql.trim() ?? '', 'mysql');
  const createTableSqlPreview = useMemo(() => generateCreateTableSql(createTableState), [createTableState]);

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

  const sortedRowEntries = useMemo<MysqlRowEntry[]>(() => {
    if (!activeResult) return [];
    const entries = activeResult.rows.map((row, index) => ({ row, index }));

    if (!sortState || sortState.resultId !== activeResultTab?.id) {
      return entries;
    }

    const direction = sortState.direction === 'asc' ? 1 : -1;
    return entries.sort((left, right) => {
      const result = compareMysqlCellValues(left.row[sortState.column], right.row[sortState.column]);
      return result === 0 ? left.index - right.index : result * direction;
    });
  }, [activeResult, activeResultTab?.id, sortState]);

  const pagedRows = useMemo(() => {
    if (!activeResult) return [];
    return sortedRowEntries.slice(page * pageSize, (page + 1) * pageSize);
  }, [activeResult, page, sortedRowEntries]);

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
    setSortState(null);
    setMessage(null);
    setContextMenu(null);
    setCreateTableState({
      open: false,
      database: '',
      tableName: '',
      engine: 'InnoDB',
      charset: '',
      comment: '',
      columns: [],
      primaryKeyColumns: [],
      indexes: [],
      foreignKeys: [],
      showAdvanced: false,
      executing: false,
    });
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

  const toggleResultSort = useCallback((column: string) => {
    if (!activeResultTab) return;

    setEditingCell(null);
    setPage(0);
    setSortState((current) => {
      if (!current || current.resultId !== activeResultTab.id || current.column !== column) {
        return { resultId: activeResultTab.id, column, direction: 'asc' };
      }

      if (current.direction === 'asc') {
        return { ...current, direction: 'desc' };
      }

      return null;
    });
  }, [activeResultTab]);

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
      const successMessage = tCurrent('auto.remoteMySQL.1ltkkjj', {
        value0: describeDatabaseTransport(result.transport),
        value1: user || 'root',
        value2: host || '127.0.0.1',
        value3: nextPort,
      });
      setMessage({
        type: 'success',
        text: appendDatabaseFallbackReason(successMessage, result.fallbackReason),
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

  const openDatabaseContextMenu = useCallback((event: React.MouseEvent, database: string) => {
    event.preventDefault();
    event.stopPropagation();
    setActiveDb(database);
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      target: { type: 'database', database },
    });
  }, []);

  const openTableContextMenu = useCallback((event: React.MouseEvent, database: string, table: string) => {
    event.preventDefault();
    event.stopPropagation();
    setActiveDb(database);
    setSelectedTable({ database, name: table });
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      target: { type: 'table', database, table },
    });
  }, []);

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

    const previewSql = `SELECT * FROM ${quoteIdentifier(database, 'mysql')}.${quoteIdentifier(table, 'mysql')} LIMIT ${tablePreviewLimit};`;
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

  const handleShowDatabaseInfo = useCallback(async (database: string) => {
    if (!api?.connections || !mysqlId) return;

    const sqlText = [
      'SELECT',
      '  s.SCHEMA_NAME AS `数据库`,',
      '  s.DEFAULT_CHARACTER_SET_NAME AS `默认字符集`,',
      '  s.DEFAULT_COLLATION_NAME AS `默认排序规则`,',
      '  COUNT(t.TABLE_NAME) AS `表数量`,',
      '  COALESCE(ROUND(SUM(t.DATA_LENGTH + t.INDEX_LENGTH) / 1024 / 1024, 2), 0) AS `大小MB`',
      'FROM information_schema.SCHEMATA s',
      'LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME',
      `WHERE s.SCHEMA_NAME = ${quoteMysqlString(database)}`,
      'GROUP BY s.SCHEMA_NAME, s.DEFAULT_CHARACTER_SET_NAME, s.DEFAULT_COLLATION_NAME;',
    ].join('\n');
    const startTime = performance.now();

    setActiveDb(database);
    setMessage(null);
    setPage(0);
    updateActiveQuerySql(sqlText);

    try {
      const result = await api.connections.mysqlQuery(connectionId, mysqlId, sqlText, database);
      const queryTime = Math.round(performance.now() - startTime);
      addResultTab({
        id: createId('result'),
        title: `${database} 信息`,
        subtitle: database,
        sql: sqlText,
        database,
        status: 'success',
        result,
        queryTime,
        createdAt: Date.now(),
        columns: createGenericColumns(result.columns, 'mysql'),
      });
      addHistoryItem({
        sql: sqlText,
        database,
        status: 'success',
        queryTime,
        rowCount: result.rows.length,
        affectedRows: result.affectedRows,
      });
    } catch (error) {
      const text = getErrorMessage(error);
      addResultTab({
        id: createId('result'),
        title: `${database} 信息`,
        subtitle: database,
        sql: sqlText,
        database,
        status: 'error',
        error: text,
        queryTime: Math.round(performance.now() - startTime),
        createdAt: Date.now(),
        columns: [],
      });
      setMessage({ type: 'error', text });
    }
  }, [addHistoryItem, addResultTab, api, connectionId, mysqlId, updateActiveQuerySql]);

  const handleShowTableStructure = useCallback(async (database: string, table: string) => {
    if (!api?.connections || !mysqlId) return;

    const sqlText = `SHOW FULL COLUMNS FROM ${quoteIdentifier(database, 'mysql')}.${quoteIdentifier(table, 'mysql')};`;
    const startTime = performance.now();

    setSelectedTable({ database, name: table });
    setActiveDb(database);
    setMessage(null);
    setPage(0);
    updateActiveQuerySql(sqlText);

    try {
      const cols = await api.connections.mysqlColumns(connectionId, mysqlId, database, table);
      setTableColumns(cols);
      const result: ShellDeskMysqlQueryResult = {
        columns: ['字段', '类型', '可空', '键', '默认', '额外', '注释'],
        rows: cols.map((column) => ({
          字段: column.name,
          类型: column.type,
          可空: column.nullable ? 'YES' : 'NO',
          键: column.key || '',
          默认: column.default,
          额外: column.extra || '',
          注释: column.comment || '',
        })),
        affectedRows: undefined,
      };
      const queryTime = Math.round(performance.now() - startTime);
      addResultTab({
        id: createId('result'),
        title: `${table} 结构`,
        subtitle: database,
        sql: sqlText,
        database,
        status: 'success',
        result,
        queryTime,
        createdAt: Date.now(),
        table: { database, name: table },
        columns: createGenericColumns(result.columns, 'mysql'),
      });
      addHistoryItem({
        sql: sqlText,
        database,
        status: 'success',
        queryTime,
        rowCount: result.rows.length,
      });
    } catch (error) {
      const text = getErrorMessage(error);
      setMessage({ type: 'error', text });
      addResultTab({
        id: createId('result'),
        title: `${table} 结构`,
        subtitle: database,
        sql: sqlText,
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

  const handleContextMenuAction = useCallback((action: 'database-info' | 'query-table' | 'table-structure') => {
    const target = contextMenu?.target;
    setContextMenu(null);
    if (!target) return;

    if (action === 'database-info' && target.type === 'database') {
      void handleShowDatabaseInfo(target.database);
      return;
    }

    if (target.type !== 'table') return;
    if (action === 'query-table') {
      void handleSelectTable(target.database, target.table);
    } else if (action === 'table-structure') {
      void handleShowTableStructure(target.database, target.table);
    }
  }, [contextMenu, handleSelectTable, handleShowDatabaseInfo, handleShowTableStructure]);

  const openCreateTableDialog = useCallback(() => {
    const database = activeDb || databases[0] || '';

    createTablePreviousFocusRef.current = typeof document === 'undefined' ? null : document.activeElement;
    setActiveDb(database);
    setCreateTableState({
      open: true,
      database,
      tableName: '',
      engine: 'InnoDB',
      charset: '',
      comment: '',
      columns: [createSchemaColumn()],
      primaryKeyColumns: [],
      indexes: [],
      foreignKeys: [],
      showAdvanced: false,
      executing: false,
    });
  }, [activeDb, databases]);

  const closeCreateTableDialog = useCallback(() => {
    setCreateTableState((current) => ({ ...current, open: false, executing: false }));
  }, []);

  useEffect(() => {
    if (!createTableState.open) return undefined;

    return () => {
      const previousFocus = createTablePreviousFocusRef.current;
      createTablePreviousFocusRef.current = null;
      if (previousFocus instanceof HTMLElement) {
        previousFocus.focus();
      }
    };
  }, [createTableState.open]);

  useEffect(() => {
    if (!createTableState.open || typeof document === 'undefined') return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || createTableState.executing) return;
      event.preventDefault();
      closeCreateTableDialog();
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [closeCreateTableDialog, createTableState.executing, createTableState.open]);

  const updateCreateTableColumn = useCallback(<Key extends keyof SchemaColumn,>(
    columnId: string,
    key: Key,
    value: SchemaColumn[Key],
  ) => {
    setCreateTableState((current) => {
      const previousColumn = current.columns.find((column) => column.id === columnId);
      const nextColumns = current.columns.map((column) => (column.id === columnId ? { ...column, [key]: value } : column));
      const previousName = previousColumn?.name.trim() ?? '';
      const nextName = key === 'name' ? String(value).trim() : previousName;

      if (key === 'name' && nextName) {
        const hasDuplicate = current.columns.some((column) => column.id !== columnId && column.name.trim().toLowerCase() === nextName.toLowerCase());
        if (hasDuplicate) {
          setMessage({ type: 'error', text: tCurrent('auto.remoteMySQL.duplicateColumn', { name: nextName }) });
          return current;
        }
      }

      if (key !== 'name' || !previousName || previousName === nextName) {
        return { ...current, columns: nextColumns };
      }

      return {
        ...current,
        columns: nextColumns,
        primaryKeyColumns: current.primaryKeyColumns.map((column) => (column === previousName ? nextName : column)).filter(Boolean),
        indexes: current.indexes.map((index) => ({
          ...index,
          columns: index.columns.map((column) => (column === previousName ? nextName : column)).filter(Boolean),
        })),
        foreignKeys: current.foreignKeys.map((foreignKey) => ({
          ...foreignKey,
          columns: foreignKey.columns.map((column) => (column === previousName ? nextName : column)).filter(Boolean),
        })),
      };
    });
  }, []);

  const addCreateTableColumn = useCallback(() => {
    setCreateTableState((current) => ({ ...current, columns: [...current.columns, createSchemaColumn()] }));
  }, []);

  const removeCreateTableColumn = useCallback((columnId: string) => {
    setCreateTableState((current) => {
      const removed = current.columns.find((column) => column.id === columnId);
      const removedName = removed?.name.trim() ?? '';

      return {
        ...current,
        columns: current.columns.filter((column) => column.id !== columnId),
        primaryKeyColumns: current.primaryKeyColumns.filter((column) => column !== removedName),
        indexes: current.indexes.map((index) => ({ ...index, columns: index.columns.filter((column) => column !== removedName) })),
        foreignKeys: current.foreignKeys.map((foreignKey) => ({ ...foreignKey, columns: foreignKey.columns.filter((column) => column !== removedName) })),
      };
    });
  }, []);

  const toggleCreateTablePrimaryKey = useCallback((columnName: string, checked: boolean) => {
    if (!columnName) return;

    setCreateTableState((current) => ({
      ...current,
      primaryKeyColumns: checked
        ? Array.from(new Set([...current.primaryKeyColumns, columnName]))
        : current.primaryKeyColumns.filter((column) => column !== columnName),
    }));
  }, []);

  const updateSchemaIndex = useCallback((indexId: string, patch: Partial<SchemaIndex>) => {
    setCreateTableState((current) => ({
      ...current,
      indexes: current.indexes.map((index) => (index.id === indexId ? { ...index, ...patch } : index)),
    }));
  }, []);

  const updateSchemaForeignKey = useCallback((foreignKeyId: string, patch: Partial<SchemaForeignKey>) => {
    setCreateTableState((current) => ({
      ...current,
      foreignKeys: current.foreignKeys.map((foreignKey) => (foreignKey.id === foreignKeyId ? { ...foreignKey, ...patch } : foreignKey)),
    }));
  }, []);

  const handleExecuteCreateTable = useCallback(async () => {
    if (!api?.connections || !mysqlId) return;

    if (!createTableState.tableName.trim()) {
      setMessage({ type: 'error', text: tCurrent('auto.remoteMySQL.pleaseFillTableName') });
      return;
    }
    if (createTableState.columns.length === 0) {
      setMessage({ type: 'error', text: tCurrent('auto.remoteMySQL.pleaseAddColumns') });
      return;
    }
    if (createTableState.columns.some((column) => !column.name.trim())) {
      setMessage({ type: 'error', text: tCurrent('auto.remoteMySQL.invalidColumnName') });
      return;
    }
    const validationError = validateCreateTableState(createTableState);
    if (validationError) {
      setMessage({ type: 'error', text: validationError });
      return;
    }

    const sqlText = generateCreateTableSql(createTableState);
    const database = createTableState.database || undefined;
    const startTime = performance.now();

    setCreateTableState((current) => ({ ...current, executing: true }));
    setMessage(null);

    try {
      const result = await api.connections.mysqlQuery(connectionId, mysqlId, sqlText, database);
      const queryTime = Math.round(performance.now() - startTime);

      addResultTab({
        id: createId('result'),
        title: createTableState.tableName.trim(),
        subtitle: database ? tCurrent('auto.remoteMySQL.4uvcwr', { value0: database }) : tCurrent('auto.remoteMySQL.1qglxbx'),
        sql: sqlText,
        database,
        status: 'success',
        result,
        queryTime,
        createdAt: Date.now(),
        columns: createGenericColumns(result.columns, 'mysql'),
      });
      addHistoryItem({
        sql: sqlText,
        database,
        status: 'success',
        queryTime,
        rowCount: result.rows.length,
        affectedRows: result.affectedRows,
      });
      if (database) {
        setExpandedDbs((current) => new Set(current).add(database));
        await loadTables(database, true);
      }
      setCreateTableState((current) => ({ ...current, open: false, executing: false }));
      setMessage({ type: 'success', text: tCurrent('auto.remoteMySQL.tableCreated', { table: createTableState.tableName.trim() }) });
    } catch (error) {
      const text = getErrorMessage(error);
      addResultTab({
        id: createId('result'),
        title: tCurrent('auto.remoteMySQL.wq5uqu'),
        subtitle: database ? tCurrent('auto.remoteMySQL.4uvcwr2', { value0: database }) : tCurrent('auto.remoteMySQL.1qglxbx2'),
        sql: sqlText,
        database,
        status: 'error',
        error: text,
        queryTime: Math.round(performance.now() - startTime),
        createdAt: Date.now(),
        columns: [],
      });
      addHistoryItem({
        sql: sqlText,
        database,
        status: 'error',
        queryTime: Math.round(performance.now() - startTime),
        error: text,
      });
      setMessage({ type: 'error', text: tCurrent('auto.remoteMySQL.createTableFailed', { error: text }) });
      setCreateTableState((current) => ({ ...current, executing: false }));
    }
  }, [addHistoryItem, addResultTab, api, connectionId, createTableState, loadTables, mysqlId]);

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
        title: isWriteStatement(sqlText, 'mysql') ? tCurrent('auto.remoteMySQL.11b0x22') : formatSqlPreview(sqlText, 28),
        subtitle: database ? tCurrent('auto.remoteMySQL.4uvcwr', { value0: database }) : tCurrent('auto.remoteMySQL.1qglxbx'),
        sql: sqlText,
        database,
        status: 'success',
        result,
        queryTime,
        createdAt: Date.now(),
        columns: createGenericColumns(result.columns, 'mysql'),
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

  const handleExplainSql = useCallback(async () => {
    if (!api?.connections || !mysqlId || !activeQueryTab?.sql.trim()) return;

    const sourceSql = activeQueryTab.sql.trim();
    if (isWriteStatement(sourceSql, 'mysql')) {
      setMessage({ type: 'info', text: 'EXPLAIN 仅用于查询语句，请先选择 SELECT/SHOW 等只读 SQL。' });
      return;
    }

    const sqlText = createExplainSql(sourceSql);
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
        title: `EXPLAIN ${formatSqlPreview(sourceSql, 20)}`,
        subtitle: database ? tCurrent('auto.remoteMySQL.4uvcwr', { value0: database }) : tCurrent('auto.remoteMySQL.1qglxbx'),
        sql: sqlText,
        database,
        status: 'success',
        result,
        queryTime,
        createdAt: Date.now(),
        columns: createGenericColumns(result.columns, 'mysql'),
      };

      addResultTab(resultTab);
      addHistoryItem({
        sql: sqlText,
        database,
        status: 'success',
        queryTime,
        rowCount: result.rows.length,
      });
    } catch (error) {
      const queryTime = Math.round(performance.now() - startTime);
      const text = getErrorMessage(error);

      addResultTab({
        id: createId('result'),
        title: 'EXPLAIN 失败',
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

  const mysqlEditorExtensions = useMemo<Extension[]>(() => [
    keymap.of([
      indentWithTab,
      {
        key: 'Mod-Enter',
        run: () => {
          void handleExecuteSql();
          return true;
        },
      },
    ]),
    sql({ dialect: MySQL }),
    EditorView.theme({
      '&': {
        height: '100%',
        minHeight: '0',
        backgroundColor: 'var(--surface-elevated)',
        color: 'var(--text)',
        fontSize: '13px',
      },
      '.cm-scroller': {
        backgroundColor: 'var(--surface-elevated)',
        fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, monospace',
        lineHeight: '20px',
      },
      '.cm-content': {
        padding: '10px 0',
        caretColor: 'var(--text)',
      },
      '.cm-line': {
        padding: '0 12px',
      },
      '.cm-gutters': {
        borderRight: '1px solid var(--border)',
        backgroundColor: 'var(--surface)',
        color: 'var(--text-muted)',
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'transparent',
        color: 'var(--accent)',
      },
      '.cm-activeLine': {
        backgroundColor: 'color-mix(in srgb, var(--accent) 8%, transparent)',
      },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
        backgroundColor: 'rgba(67, 199, 255, 0.25)',
      },
      '&.cm-focused': {
        outline: 'none',
      },
    }, {
      dark: editorTheme === 'dark',
    }),
  ], [editorTheme, handleExecuteSql]);

  const handleExportActiveResult = useCallback(async (format: DatabaseExportFormat) => {
    if (!activeResult || activeResult.rows.length === 0) return;

    setMessage(null);

    try {
      const filePath = await exportDatabaseRows({
        sourceName: 'MySQL',
        format,
        columns: activeResult.columns,
        rows: sortedRowEntries.map((entry) => entry.row),
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
  }, [activeResult, activeResultTab, sortedRowEntries]);

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
      isNull: currentValue === null || currentValue === undefined,
    });
  }, [activeResult, activeResultPrimaryKeys, activeResultTab]);

  const prepareCellSave = useCallback(() => {
    if (!editingCell || !activeResultTab?.result || !activeResultTab.table) return;

    const row = activeResultTab.result.rows[editingCell.rowIndex];
    if (!row) {
      setEditingCell(null);
      return;
    }

    const newValue = editingCell.isNull ? null : editingCell.value;

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

      if (result.affectedRows > 0) {
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
      }

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

  useEffect(() => {
    mysqlIdRef.current = mysqlId;
  }, [mysqlId]);

  useEffect(() => {
    return api?.events?.onDatabaseTunnelIdleTimeout((payload) => {
      if (
        payload.kind !== 'mysql' ||
        payload.connectionId !== connectionId ||
        payload.sessionId !== mysqlIdRef.current
      ) {
        return;
      }

      mysqlIdRef.current = '';
      setMysqlId('');
      setStatus('disconnected');
      resetWorkspaceState();
      setErrorMessage(`数据库连接已因空闲超过 ${payload.idleMinutes} 分钟自动断开。`);
    });
  }, [api, connectionId, resetWorkspaceState]);

  useEffect(() => {
    setPage(0);
    setEditingCell(null);
  }, [activeResultId]);

  useEffect(() => {
    if (isReady) {
      sqlEditorRef.current?.view?.focus();
    }
  }, [activeQueryId, isReady]);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return undefined;
    }

    const observer = new MutationObserver(() => setEditorTheme(getShellDeskEditorTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    return () => observer.disconnect();
  }, []);

  useContextMenu(contextMenu, setContextMenu);

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
            <div className="mysql-sidebar-actions">
              <button type="button" onClick={openCreateTableDialog} title={tCurrent('auto.remoteMySQL.createTable')}>+</button>
              <button type="button" onClick={() => void refreshDatabases()} disabled={schemaLoading} title={tCurrent('auto.remoteMySQL.oj1z9s')}>
                {schemaLoading ? '...' : '↻'}
              </button>
            </div>
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
                    onContextMenu={(event) => openDatabaseContextMenu(event, database)}
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
                            onContextMenu={(event) => openTableContextMenu(event, database, table)}
                          >
                            <span className="mysql-tree-icon">T</span>
                            <span className="mysql-tree-name">{table}</span>
                          </button>
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
              <button
                type="button"
                className="mysql-explain-btn"
                onClick={() => void handleExplainSql()}
                disabled={!canExplainActiveQuery}
              >
                EXPLAIN
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
            <CodeMirror
              ref={sqlEditorRef}
              className="mysql-sql-editor"
              value={activeQueryTab?.sql ?? ''}
              height="100%"
              basicSetup={{
                lineNumbers: true,
                foldGutter: true,
                highlightActiveLine: true,
                highlightActiveLineGutter: true,
                bracketMatching: true,
                closeBrackets: true,
                autocompletion: true,
                searchKeymap: true,
                defaultKeymap: true,
                history: true,
              }}
              theme={editorTheme}
              extensions={mysqlEditorExtensions}
              onChange={updateActiveQuerySql}
              placeholder={tCurrent('auto.remoteMySQL.1bvo5bt')}
              aria-label={tCurrent('auto.remoteMySQL.1bvo5bt')}
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
                              const activeSort = sortState?.resultId === activeResultTab.id && sortState.column === column ? sortState.direction : null;
                              return (
                                <th key={column}>
                                  <button
                                    type="button"
                                    className={`mysql-sort-button ${activeSort ? 'active' : ''}`}
                                    onClick={() => toggleResultSort(column)}
                                    title={`按 ${column} 排序`}
                                  >
                                    <span>
                                      <span className="mysql-col-name">{column}</span>
                                      {meta?.key ? <span className="mysql-col-key">{meta.key}</span> : null}
                                    </span>
                                    <span className="mysql-sort-icon" aria-hidden="true">{activeSort === 'asc' ? '▲' : activeSort === 'desc' ? '▼' : ''}</span>
                                  </button>
                                  {meta?.type ? <small>{meta.type}</small> : null}
                                </th>
                              );
                            })}
                          </tr>
                        </thead>
                        <tbody>
                          {pagedRows.map(({ row, index: sourceRowIndex }, rowIdx) => {
                            const displayRowIndex = page * pageSize + rowIdx;

                            return (
                              <tr key={`${sourceRowIndex}-${displayRowIndex}`}>
                                <td className="mysql-row-num">{displayRowIndex + 1}</td>
                                {activeResult.columns.map((column) => {
                                  const cellValue = row[column];
                                  const isEditing = editingCell?.rowIndex === sourceRowIndex && editingCell.column === column;
                                  const isEditableColumn = isActiveResultEditable && !activeResultPrimaryKeys.includes(column);

                                  if (isEditing) {
                                    return (
                                      <td key={column} className="mysql-cell-editing">
                                        <div className="mysql-cell-editbox">
                                          <input
                                            type="text"
                                            value={editingCell.isNull ? '' : editingCell.value}
                                            onChange={(event) => setEditingCell({ ...editingCell, value: event.target.value, isNull: false })}
                                            onKeyDown={handleCellKeyDown}
                                            onBlur={prepareCellSave}
                                            autoFocus
                                            className="mysql-cell-input"
                                            readOnly={editingCell.isNull}
                                          />
                                          <button
                                            type="button"
                                            className={`mysql-cell-null-toggle ${editingCell.isNull ? 'active' : ''}`}
                                            onMouseDown={(event) => event.preventDefault()}
                                            onClick={() => setEditingCell({ ...editingCell, isNull: !editingCell.isNull })}
                                          >
                                            NULL
                                          </button>
                                        </div>
                                      </td>
                                    );
                                  }

                                  return (
                                    <td
                                      key={column}
                                      className={`${cellValue === null ? 'mysql-cell-null' : ''} ${isEditableColumn ? 'mysql-cell-editable' : ''}`}
                                      onDoubleClick={() => handleCellEdit(sourceRowIndex, column, cellValue)}
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

      {createTableState.open ? createPortal(
        <div className="schema-dialog-overlay" role="presentation">
          <div className="schema-dialog" role="dialog" aria-modal="true" aria-labelledby="mysql-create-table-title">
            <div className="schema-dialog-header">
              <h3 id="mysql-create-table-title">
                {tCurrent('auto.remoteMySQL.createTableTitle', { database: createTableState.database || activeDb || '-' })}
              </h3>
              <button
                type="button"
                onClick={closeCreateTableDialog}
                disabled={createTableState.executing}
                aria-label={tCurrent('auto.remoteMySQL.cancel')}
              >
                ×
              </button>
            </div>

            <div className="schema-form-grid">
              <label className="schema-field">
                <span>{tCurrent('auto.remoteMySQL.tableName')}</span>
                <input
                  type="text"
                  value={createTableState.tableName}
                  onChange={(event) => setCreateTableState((current) => ({ ...current, tableName: event.target.value }))}
                  placeholder={tCurrent('auto.remoteMySQL.tableNamePlaceholder')}
                  autoFocus
                />
              </label>
            </div>

            <button
              type="button"
              className="schema-collapse-toggle"
              onClick={() => setCreateTableState((current) => ({ ...current, showAdvanced: !current.showAdvanced }))}
            >
              {createTableState.showAdvanced ? '▾' : '▸'} {tCurrent('auto.remoteMySQL.createTableSuffix')}
            </button>

            {createTableState.showAdvanced ? (
              <div className="schema-advanced-panel">
                <label className="schema-field">
                  <span>{tCurrent('auto.remoteMySQL.engine')}</span>
                  <select
                    value={createTableState.engine}
                    onChange={(event) => setCreateTableState((current) => ({ ...current, engine: event.target.value }))}
                  >
                    {mysqlEngines.map((engine) => (
                      <option key={engine} value={engine}>{engine}</option>
                    ))}
                  </select>
                </label>
                <label className="schema-field">
                  <span>{tCurrent('auto.remoteMySQL.charset')}</span>
                  <select
                    value={createTableState.charset}
                    onChange={(event) => setCreateTableState((current) => ({ ...current, charset: event.target.value }))}
                  >
                    <option value="">{tCurrent('auto.remoteMySQL.baseTable')}</option>
                    {mysqlCharsets.map((charset) => (
                      <option key={charset} value={charset}>{charset}</option>
                    ))}
                  </select>
                </label>
                <label className="schema-field schema-field-wide">
                  <span>{tCurrent('auto.remoteMySQL.comment')}</span>
                  <input
                    type="text"
                    value={createTableState.comment}
                    onChange={(event) => setCreateTableState((current) => ({ ...current, comment: event.target.value }))}
                  />
                </label>
              </div>
            ) : null}

            <div className="schema-section">
              <div className="schema-section-header">
                <strong>{tCurrent('auto.remoteMySQL.columnName')}</strong>
                <button type="button" onClick={addCreateTableColumn}>{tCurrent('auto.remoteMySQL.addColumn')}</button>
              </div>
              <div className="schema-columns-scroll">
                <table className="schema-columns-table">
                  <thead>
                    <tr>
                      <th>{tCurrent('auto.remoteMySQL.primaryKey')}</th>
                      <th>{tCurrent('auto.remoteMySQL.columnName')}</th>
                      <th>{tCurrent('auto.remoteMySQL.columnType')}</th>
                      <th>{tCurrent('auto.remoteMySQL.columnLength')}</th>
                      <th>{tCurrent('auto.remoteMySQL.nullable')}</th>
                      <th>{tCurrent('auto.remoteMySQL.defaultValue')}</th>
                      <th>{tCurrent('auto.remoteMySQL.autoIncrement')}</th>
                      <th>{tCurrent('auto.remoteMySQL.comment')}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {createTableState.columns.map((column) => {
                      const columnName = column.name.trim();

                      return (
                        <tr key={column.id}>
                          <td>
                            <input
                              type="checkbox"
                              checked={columnName ? createTableState.primaryKeyColumns.includes(columnName) : false}
                              onChange={(event) => toggleCreateTablePrimaryKey(columnName, event.target.checked)}
                              disabled={!columnName}
                              title={tCurrent('auto.remoteMySQL.primaryKey')}
                            />
                          </td>
                          <td>
                            <input
                              type="text"
                              value={column.name}
                              onChange={(event) => updateCreateTableColumn(column.id, 'name', event.target.value)}
                            />
                          </td>
                          <td>
                            <select value={column.type} onChange={(event) => updateCreateTableColumn(column.id, 'type', event.target.value)}>
                              {mysqlColumnTypes.map((type) => (
                                <option key={type} value={type}>{type}</option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <input
                              type="text"
                              value={column.length}
                              onChange={(event) => updateCreateTableColumn(column.id, 'length', event.target.value)}
                            />
                          </td>
                          <td>
                            <input
                              type="checkbox"
                              checked={column.nullable}
                              onChange={(event) => updateCreateTableColumn(column.id, 'nullable', event.target.checked)}
                            />
                          </td>
                          <td>
                            <input
                              type="text"
                              value={column.defaultValue}
                              onChange={(event) => updateCreateTableColumn(column.id, 'defaultValue', event.target.value)}
                            />
                          </td>
                          <td>
                            <input
                              type="checkbox"
                              checked={column.autoIncrement}
                              onChange={(event) => updateCreateTableColumn(column.id, 'autoIncrement', event.target.checked)}
                            />
                          </td>
                          <td>
                            <input
                              type="text"
                              value={column.comment}
                              onChange={(event) => updateCreateTableColumn(column.id, 'comment', event.target.value)}
                            />
                          </td>
                          <td>
                            <button type="button" onClick={() => removeCreateTableColumn(column.id)}>
                              {tCurrent('auto.remoteMySQL.removeColumn')}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="schema-relations-grid">
              <section className="schema-subsection">
                <div className="schema-section-header">
                  <strong>{tCurrent('auto.remoteMySQL.index')}</strong>
                  <button
                    type="button"
                    onClick={() => setCreateTableState((current) => ({ ...current, indexes: [...current.indexes, createSchemaIndex()] }))}
                    title={tCurrent('auto.remoteMySQL.index')}
                  >
                    +
                  </button>
                </div>
                {createTableState.indexes.map((index) => (
                  <div key={index.id} className="schema-inline-editor">
                    <label className="schema-field">
                      <span>{tCurrent('auto.remoteMySQL.indexType')}</span>
                      <select value={index.type} onChange={(event) => updateSchemaIndex(index.id, { type: event.target.value as SchemaIndex['type'] })}>
                        <option value="INDEX">{tCurrent('auto.remoteMySQL.index')}</option>
                        <option value="UNIQUE">{tCurrent('auto.remoteMySQL.unique')}</option>
                        <option value="FULLTEXT">{tCurrent('auto.remoteMySQL.fulltext')}</option>
                        <option value="SPATIAL">{tCurrent('auto.remoteMySQL.spatial')}</option>
                      </select>
                    </label>
                    <label className="schema-field">
                      <span>{tCurrent('auto.remoteMySQL.columnName')}</span>
                      <select
                        multiple
                        value={index.columns}
                        onChange={(event) => updateSchemaIndex(index.id, {
                          columns: Array.from(event.target.selectedOptions, (option) => option.value),
                        })}
                      >
                        {createTableState.columns.filter((column) => column.name.trim()).map((column) => (
                          <option key={column.id} value={column.name.trim()}>{column.name.trim()}</option>
                        ))}
                      </select>
                    </label>
                    <label className="schema-field">
                      <span>{tCurrent('auto.remoteMySQL.indexName')}</span>
                      <input type="text" value={index.name} onChange={(event) => updateSchemaIndex(index.id, { name: event.target.value })} />
                    </label>
                    <button
                      type="button"
                      onClick={() => setCreateTableState((current) => ({ ...current, indexes: current.indexes.filter((item) => item.id !== index.id) }))}
                    >
                      {tCurrent('auto.remoteMySQL.removeIndex')}
                    </button>
                  </div>
                ))}
              </section>

              <section className="schema-subsection">
                <div className="schema-section-header">
                  <strong>{tCurrent('auto.remoteMySQL.foreignKey')}</strong>
                  <button
                    type="button"
                    onClick={() => setCreateTableState((current) => ({ ...current, foreignKeys: [...current.foreignKeys, createSchemaForeignKey()] }))}
                    title={tCurrent('auto.remoteMySQL.foreignKey')}
                  >
                    +
                  </button>
                </div>
                {createTableState.foreignKeys.map((foreignKey) => (
                  <div key={foreignKey.id} className="schema-inline-editor">
                    <label className="schema-field">
                      <span>{tCurrent('auto.remoteMySQL.columnName')}</span>
                      <select
                        multiple
                        value={foreignKey.columns}
                        onChange={(event) => updateSchemaForeignKey(foreignKey.id, {
                          columns: Array.from(event.target.selectedOptions, (option) => option.value),
                        })}
                      >
                        {createTableState.columns.filter((column) => column.name.trim()).map((column) => (
                          <option key={column.id} value={column.name.trim()}>{column.name.trim()}</option>
                        ))}
                      </select>
                    </label>
                    <label className="schema-field">
                      <span>{tCurrent('auto.remoteMySQL.referenceTable')}</span>
                      <input type="text" value={foreignKey.refTable} onChange={(event) => updateSchemaForeignKey(foreignKey.id, { refTable: event.target.value })} />
                    </label>
                    <label className="schema-field">
                      <span>{tCurrent('auto.remoteMySQL.referenceColumn')}</span>
                      <input
                        type="text"
                        value={foreignKey.refColumns.join(', ')}
                        onChange={(event) => updateSchemaForeignKey(foreignKey.id, {
                          refColumns: event.target.value.split(',').map((column) => column.trim()).filter(Boolean),
                        })}
                      />
                    </label>
                    <label className="schema-field">
                      <span>{tCurrent('auto.remoteMySQL.onDelete')}</span>
                      <select value={foreignKey.onDelete} onChange={(event) => updateSchemaForeignKey(foreignKey.id, { onDelete: event.target.value })}>
                        {mysqlForeignKeyActions.map((action) => (
                          <option key={action} value={action}>{translateForeignKeyAction(action)}</option>
                        ))}
                      </select>
                    </label>
                    <label className="schema-field">
                      <span>{tCurrent('auto.remoteMySQL.onUpdate')}</span>
                      <select value={foreignKey.onUpdate} onChange={(event) => updateSchemaForeignKey(foreignKey.id, { onUpdate: event.target.value })}>
                        {mysqlForeignKeyActions.map((action) => (
                          <option key={action} value={action}>{translateForeignKeyAction(action)}</option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      onClick={() => setCreateTableState((current) => ({ ...current, foreignKeys: current.foreignKeys.filter((item) => item.id !== foreignKey.id) }))}
                    >
                      {tCurrent('auto.remoteMySQL.removeForeignKey')}
                    </button>
                  </div>
                ))}
              </section>
            </div>

            <label className="schema-field schema-preview-field">
              <span>{tCurrent('auto.remoteMySQL.sqlPreview')}</span>
              <textarea className="schema-preview" value={createTableSqlPreview} readOnly rows={8} />
            </label>

            <div className="schema-actions">
              <button type="button" onClick={closeCreateTableDialog} disabled={createTableState.executing}>
                {tCurrent('auto.remoteMySQL.cancel')}
              </button>
              <button type="button" className="primary" onClick={() => void handleExecuteCreateTable()} disabled={createTableState.executing}>
                {createTableState.executing ? tCurrent('auto.remoteMySQL.e2byz1') : tCurrent('auto.remoteMySQL.executeCreate')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}

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
            <strong>
              {contextMenu.target.type === 'database'
                ? contextMenu.target.database
                : contextMenu.target.table}
            </strong>
            <span>{contextMenu.target.type === 'database' ? '数据库' : contextMenu.target.database}</span>
          </div>
          {contextMenu.target.type === 'database' ? (
            <button type="button" role="menuitem" onClick={() => handleContextMenuAction('database-info')}>
              查看数据库信息
            </button>
          ) : (
            <>
              <button type="button" role="menuitem" onClick={() => handleContextMenuAction('query-table')}>
                查询数据
              </button>
              <button type="button" role="menuitem" onClick={() => handleContextMenuAction('table-structure')}>
                查看表结构
              </button>
            </>
          )}
        </div>,
        document.body,
      ) : null}
    </>
  );
}

export default RemoteMySQL;
