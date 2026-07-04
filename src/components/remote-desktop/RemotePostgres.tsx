import { type ChangeEvent, type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { indentWithTab } from '@codemirror/commands';
import { PostgreSQL, sql } from '@codemirror/lang-sql';
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
  isWriteStatement,
  quoteIdentifier,
  useContextMenu,
} from './databaseUtils';
import DismissibleAlert from './DismissibleAlert';
import { loadRemoteConnectionProfile, readProfileString, saveRemoteConnectionProfile } from './remoteConnectionProfiles';
import { tCurrent } from '../../i18n';

interface RemotePostgresProps {
  connectionId: string;
  hostId: string;
}

type PostgresStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
type PostgresMessageType = 'info' | 'success' | 'error';
type PostgresResultStatus = 'success' | 'error';

interface TableInfo {
  schema: string;
  name: string;
  type: string;
}

interface PostgresMessage {
  type: PostgresMessageType;
  text: string;
}

interface PostgresQueryTab {
  id: string;
  title: string;
  sql: string;
  running: boolean;
}

interface PostgresResultTab {
  id: string;
  title: string;
  subtitle: string;
  sql: string;
  status: PostgresResultStatus;
  result?: ShellDeskPostgresQueryResult;
  error?: string;
  queryTime: number;
  createdAt: number;
  table?: TableInfo;
  columns: ShellDeskPostgresColumn[];
}

interface PostgresHistoryItem {
  id: string;
  sql: string;
  status: PostgresResultStatus;
  queryTime: number;
  rowCount?: number;
  error?: string;
  createdAt: number;
}

interface PostgresSortState {
  resultId: string;
  column: string;
  direction: 'asc' | 'desc';
}

interface PostgresRowEntry {
  row: Record<string, unknown>;
  index: number;
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

type PostgresContextMenuTarget =
  | { type: 'database'; database: string }
  | { type: 'table'; table: ShellDeskPostgresTable };

interface PostgresContextMenuState {
  x: number;
  y: number;
  target: PostgresContextMenuTarget;
}

interface PgSchemaColumn {
  id: string;
  name: string;
  type: string;
  length: string;
  nullable: boolean;
  defaultValue: string;
  comment: string;
}

interface PgSchemaIndex {
  id: string;
  type: 'INDEX' | 'UNIQUE';
  columns: string[];
  name: string;
}

interface PgSchemaForeignKey {
  id: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
  onDelete: string;
  onUpdate: string;
}

interface PgCreateTableState {
  open: boolean;
  schema: string;
  tableName: string;
  comment: string;
  columns: PgSchemaColumn[];
  primaryKeyColumns: string[];
  indexes: PgSchemaIndex[];
  foreignKeys: PgSchemaForeignKey[];
  showAdvanced: boolean;
  executing: boolean;
}

interface ImportDataState {
  open: boolean;
  mode: 'csv' | 'json';
  targetTable: string;
  csvText: string;
  jsonText: string;
  preview: Record<string, string>[];
  columns: string[];
  executing: boolean;
  progress: { current: number; total: number } | null;
}

const tablePreviewLimit = 50;
const pageSize = 100;
const maxHistoryItems = 12;
const maxResultTabs = 10;
const defaultPort = 5432;
const postgresColumnTypes = [
  'INTEGER',
  'BIGINT',
  'SMALLINT',
  'TEXT',
  'VARCHAR',
  'CHAR',
  'BOOLEAN',
  'DATE',
  'TIMESTAMP',
  'TIMESTAMPTZ',
  'NUMERIC',
  'REAL',
  'DOUBLE PRECISION',
  'JSON',
  'JSONB',
  'UUID',
  'BYTEA',
  'INTERVAL',
  'INET',
  'CIDR',
  'MACADDR',
];
const postgresTypesWithoutLength = new Set([
  'INTEGER',
  'BIGINT',
  'SMALLINT',
  'TEXT',
  'BOOLEAN',
  'DATE',
  'TIMESTAMP',
  'TIMESTAMPTZ',
  'REAL',
  'DOUBLE PRECISION',
  'JSON',
  'JSONB',
  'UUID',
  'BYTEA',
  'INTERVAL',
  'INET',
  'CIDR',
  'MACADDR',
]);
const postgresForeignKeyActions = ['RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION'];
const importEditorTarget = '__sql_editor__';

function getShellDeskEditorTheme(): 'light' | 'dark' {
  if (typeof document === 'undefined') {
    return 'dark';
  }

  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

function createQueryTab(index: number, sqlText = 'SELECT current_database(), now();'): PostgresQueryTab {
  return {
    id: createId('pg-query'),
    title: `查询 ${index}`,
    sql: sqlText,
    running: false,
  };
}

function createInitialQueryState(): { tabs: PostgresQueryTab[]; activeId: string } {
  const tab = createQueryTab(1);
  return { tabs: [tab], activeId: tab.id };
}

function quotePgString(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          value += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        value += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === ',') {
      row.push(value);
      value = '';
      continue;
    }
    if (char === '\n') {
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
      continue;
    }
    if (char === '\r') {
      continue;
    }
    value += char;
  }

  if (inQuotes) {
    throw new Error(tCurrent('auto.remotePostgres.importCsvUnclosedQuote'));
  }
  if (value || row.length > 0) {
    row.push(value);
    rows.push(row);
  }

  return rows.filter((item) => item.some((cell) => cell.trim()));
}

function normalizeImportPreviewValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function parseImportCsv(text: string): { columns: string[]; rows: Record<string, unknown>[]; preview: Record<string, string>[] } {
  const parsedRows = parseCsvRows(text.trim());
  const columns = parsedRows[0]?.map((column) => column.trim()).filter(Boolean) ?? [];
  if (columns.length === 0 || parsedRows.length <= 1) {
    return { columns, rows: [], preview: [] };
  }

  const rows = parsedRows.slice(1).map((row) => {
    const entry: Record<string, unknown> = {};
    columns.forEach((column, index) => {
      entry[column] = row[index] ?? '';
    });
    return entry;
  });

  return {
    columns,
    rows,
    preview: rows.slice(0, 5).map((row) => Object.fromEntries(columns.map((column) => [column, normalizeImportPreviewValue(row[column])]))),
  };
}

function parseImportJson(text: string): { columns: string[]; rows: Record<string, unknown>[]; preview: Record<string, string>[] } {
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(tCurrent('auto.remotePostgres.importJsonMustBeArray'));
  }

  const rows = parsed.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(tCurrent('auto.remotePostgres.importJsonItemsMustBeObjects'));
    }
    return item as Record<string, unknown>;
  });
  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));

  return {
    columns,
    rows,
    preview: rows.slice(0, 5).map((row) => Object.fromEntries(columns.map((column) => [column, normalizeImportPreviewValue(row[column])]))),
  };
}

function quotePgImportValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'object') return quotePgString(JSON.stringify(value));
  return quotePgString(String(value));
}

function buildPgInsertSql(schema: string, table: string, columns: string[], rows: Record<string, unknown>[]): string {
  const tableIdentifier = `${quoteIdentifier(schema || 'public', 'postgres')}.${quoteIdentifier(table, 'postgres')}`;
  const columnSql = columns.map((column) => quoteIdentifier(column, 'postgres')).join(', ');
  const valuesSql = rows
    .map((row) => `(${columns.map((column) => quotePgImportValue(row[column])).join(', ')})`)
    .join(', ');
  return `INSERT INTO ${tableIdentifier} (${columnSql}) VALUES ${valuesSql};`;
}

function createPgSchemaColumn(): PgSchemaColumn {
  return {
    id: createId('pg-column'),
    name: '',
    type: 'INTEGER',
    length: '',
    nullable: false,
    defaultValue: '',
    comment: '',
  };
}

function createPgSchemaIndex(): PgSchemaIndex {
  return {
    id: createId('pg-index'),
    type: 'INDEX',
    columns: [],
    name: '',
  };
}

function createPgSchemaForeignKey(): PgSchemaForeignKey {
  return {
    id: createId('pg-fk'),
    columns: [],
    refSchema: 'public',
    refTable: '',
    refColumns: [],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  };
}

function quotePgDefaultValue(value: string): string {
  const trimmed = value.trim();

  if (!trimmed) return '';
  if (/^null$/i.test(trimmed)) return 'NULL';
  if (/^(current_timestamp|current_date|current_time)(\(\))?$/i.test(trimmed)) return trimmed;
  if (/^(uuid_generate_v4|gen_random_uuid|now)\(\)$/i.test(trimmed)) return trimmed;
  if (/^-?\d+(\.\d+)?$/u.test(trimmed)) return trimmed;
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toUpperCase();

  return quotePgString(trimmed);
}

function sanitizePgColumnLength(type: string, length: string): string {
  const normalizedType = type.toUpperCase();
  const trimmed = length.trim();

  if (!trimmed || postgresTypesWithoutLength.has(normalizedType)) return '';
  return trimmed.replace(/[^\d,]/gu, '').replace(/,+/gu, ',').replace(/^,|,$/gu, '');
}

function quotePgQualifiedIdentifier(schema: string, name: string): string {
  return `${quoteIdentifier(schema || 'public', 'postgres')}.${quoteIdentifier(name || 'table_name', 'postgres')}`;
}

function buildPgColumnDefinition(column: PgSchemaColumn, primaryKeyColumns: string[]): string {
  const columnName = column.name.trim();
  const normalizedType = column.type.toUpperCase();
  const defaultValue = quotePgDefaultValue(column.defaultValue);
  const length = sanitizePgColumnLength(normalizedType, column.length);
  const isSinglePrimaryKey = primaryKeyColumns.length === 1 && primaryKeyColumns[0] === columnName;
  const isSerial = (normalizedType === 'INTEGER' || normalizedType === 'BIGINT') && /^(serial|bigserial)$/i.test(column.defaultValue.trim());
  const type = isSerial
    ? (normalizedType === 'BIGINT' ? 'BIGSERIAL' : 'SERIAL')
    : length ? `${normalizedType}(${length})` : normalizedType;
  const parts = [
    quoteIdentifier(columnName, 'postgres'),
    type,
    column.nullable ? 'NULL' : 'NOT NULL',
  ];

  if (!isSerial && defaultValue) {
    parts.push(`DEFAULT ${defaultValue}`);
  }
  if (isSinglePrimaryKey) {
    parts.push('PRIMARY KEY');
  }

  return parts.join(' ');
}

function buildPgIndexName(index: PgSchemaIndex, tableName: string): string {
  if (index.name.trim()) return index.name.trim();
  const suffix = index.columns.join('_') || index.id.replace(/^pg-index[-_]?/iu, '');
  return `${index.type === 'UNIQUE' ? 'uniq' : 'idx'}_${tableName}_${suffix}`.replace(/[^a-zA-Z0-9_]/gu, '_').slice(0, 63);
}

function generateCreateTableStatements(state: PgCreateTableState): string[] {
  const schema = state.schema.trim() || 'public';
  const tableName = state.tableName.trim() || 'table_name';
  const tableIdentifier = quotePgQualifiedIdentifier(schema, tableName);
  const definitions = state.columns
    .filter((column) => column.name.trim())
    .map((column) => `  ${buildPgColumnDefinition(column, state.primaryKeyColumns)}`);
  const primaryKeyColumns = state.primaryKeyColumns.filter((column) => (
    state.columns.some((item) => item.name.trim() === column) && state.primaryKeyColumns.length !== 1
  ));

  if (primaryKeyColumns.length > 0) {
    definitions.push(`  PRIMARY KEY (${primaryKeyColumns.map((column) => quoteIdentifier(column, 'postgres')).join(', ')})`);
  }

  state.foreignKeys.forEach((foreignKey) => {
    const keyColumns = foreignKey.columns.filter((column) => state.columns.some((item) => item.name.trim() === column));
    const refColumns = foreignKey.refColumns.filter((column) => column.trim());
    if (keyColumns.length === 0 || !foreignKey.refTable.trim() || refColumns.length === 0) return;

    const parts = [
      `FOREIGN KEY (${keyColumns.map((column) => quoteIdentifier(column, 'postgres')).join(', ')})`,
      `REFERENCES ${quotePgQualifiedIdentifier(foreignKey.refSchema.trim() || 'public', foreignKey.refTable.trim())} (${refColumns.map((column) => quoteIdentifier(column.trim(), 'postgres')).join(', ')})`,
    ];
    if (foreignKey.onDelete) parts.push(`ON DELETE ${foreignKey.onDelete}`);
    if (foreignKey.onUpdate) parts.push(`ON UPDATE ${foreignKey.onUpdate}`);
    definitions.push(`  ${parts.join(' ')}`);
  });

  const statements: string[] = [
    [
      `CREATE TABLE ${tableIdentifier} (`,
      definitions.length > 0 ? definitions.join(',\n') : '  "id" INTEGER NOT NULL',
      ');',
    ].join('\n'),
  ];

  state.indexes.forEach((index) => {
    const indexColumns = index.columns.filter((column) => state.columns.some((item) => item.name.trim() === column));
    if (indexColumns.length === 0) return;
    const indexType = index.type === 'UNIQUE' ? 'CREATE UNIQUE INDEX' : 'CREATE INDEX';
    statements.push(`${indexType} ${quoteIdentifier(buildPgIndexName(index, tableName), 'postgres')} ON ${tableIdentifier} (${indexColumns.map((column) => quoteIdentifier(column, 'postgres')).join(', ')});`);
  });

  if (state.comment.trim()) {
    statements.push(`COMMENT ON TABLE ${tableIdentifier} IS ${quotePgString(state.comment.trim())};`);
  }

  return statements;
}

function generateCreateTableSql(state: PgCreateTableState): string {
  return generateCreateTableStatements(state).join('\n');
}

function validateCreateTableState(state: PgCreateTableState): string | null {
  const seenColumnNames = new Set<string>();

  for (const column of state.columns) {
    const columnName = column.name.trim();
    if (!columnName) continue;

    const normalizedColumnName = columnName.toLowerCase();
    if (seenColumnNames.has(normalizedColumnName)) {
      return tCurrent('auto.remotePostgres.duplicateColumn', { name: columnName });
    }
    seenColumnNames.add(normalizedColumnName);
  }

  return null;
}

function translateForeignKeyAction(action: string): string {
  return action;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left === null || left === undefined) return right === null || right === undefined;
  if (right === null || right === undefined) return false;
  return String(left) === String(right);
}

function createExplainSql(sqlText: string): string {
  const statement = sqlText.trim().replace(/;+\s*$/, '');

  if (/^explain\b/i.test(statement)) {
    return statement;
  }

  return `EXPLAIN ${statement}`;
}

function describeResult(result: ShellDeskPostgresQueryResult): string {
  if (result.columns.length === 0) return `已执行${result.rowCount !== undefined ? ` · ${result.rowCount} 行受影响` : ''}`;
  return `${result.rowCount ?? result.rows.length} 行`;
}

function comparePostgresCellValues(left: unknown, right: unknown): number {
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

function serializeImportTarget(table: TableInfo): string {
  return JSON.stringify({ schema: table.schema, name: table.name, type: table.type });
}

function parseImportTarget(value: string): TableInfo | null {
  if (!value || value === importEditorTarget) return null;

  try {
    const parsed = JSON.parse(value) as Partial<TableInfo>;
    if (typeof parsed.schema === 'string' && typeof parsed.name === 'string') {
      return {
        schema: parsed.schema,
        name: parsed.name,
        type: typeof parsed.type === 'string' ? parsed.type : 'BASE TABLE',
      };
    }
  } catch {
    return null;
  }

  return null;
}

function formatImportTarget(table: TableInfo | null): string {
  return table ? `${table.schema}.${table.name}` : '';
}

function RemotePostgres({ connectionId, hostId }: RemotePostgresProps) {
  const api = window.guiSSH?.connections;
  const initialQueryStateRef = useRef(createInitialQueryState());
  const postgresIdRef = useRef('');
  const editorRef = useRef<ReactCodeMirrorRef>(null);
  const createTablePreviousFocusRef = useRef<Element | null>(null);
  const importPreviousFocusRef = useRef<Element | null>(null);
  const importFileInputRef = useRef<HTMLInputElement | null>(null);

  const [status, setStatus] = useState<PostgresStatus>('disconnected');
  const [error, setError] = useState('');
  const [message, setMessage] = useState<PostgresMessage | null>(null);
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
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [queryTabs, setQueryTabs] = useState<PostgresQueryTab[]>(initialQueryStateRef.current.tabs);
  const [activeQueryId, setActiveQueryId] = useState(initialQueryStateRef.current.activeId);
  const [resultTabs, setResultTabs] = useState<PostgresResultTab[]>([]);
  const [activeResultId, setActiveResultId] = useState('');
  const [history, setHistory] = useState<PostgresHistoryItem[]>([]);
  const [page, setPage] = useState(0);
  const [sortState, setSortState] = useState<PostgresSortState | null>(null);
  const [editingCell, setEditingCell] = useState<EditingCell | null>(null);
  const [pendingEdit, setPendingEdit] = useState<PendingEdit | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editorTheme, setEditorTheme] = useState<'light' | 'dark'>(getShellDeskEditorTheme);
  const [contextMenu, setContextMenu] = useState<PostgresContextMenuState | null>(null);
  const [createTableState, setCreateTableState] = useState<PgCreateTableState>({
    open: false,
    schema: 'public',
    tableName: '',
    comment: '',
    columns: [],
    primaryKeyColumns: [],
    indexes: [],
    foreignKeys: [],
    showAdvanced: false,
    executing: false,
  });
  const [importDataState, setImportDataState] = useState<ImportDataState>({
    open: false,
    mode: 'csv',
    targetTable: '',
    csvText: '',
    jsonText: '',
    preview: [],
    columns: [],
    executing: false,
    progress: null,
  });

  const isConnected = status === 'connected';

  const activeQueryTab = useMemo(() => {
    return queryTabs.find((tab) => tab.id === activeQueryId) ?? queryTabs[0];
  }, [activeQueryId, queryTabs]);

  const activeResultTab = useMemo(() => {
    return resultTabs.find((tab) => tab.id === activeResultId) ?? null;
  }, [activeResultId, resultTabs]);

  const activeResult = activeResultTab?.result ?? null;
  const activeResultColumns = activeResultTab?.columns ?? [];
  const activeResultPrimaryKeys = useMemo(() => {
    return activeResultColumns.filter((column) => column.isPrimaryKey).map((column) => column.name);
  }, [activeResultColumns]);
  const isActiveResultEditable = Boolean(activeResultTab?.table && activeResultPrimaryKeys.length > 0);
  const canRunActiveQuery = Boolean(activeQueryTab?.sql.trim()) && !activeQueryTab?.running;
  const canExplainActiveQuery = canRunActiveQuery && !isWriteStatement(activeQueryTab?.sql.trim() ?? '', 'postgres');
  const createTableSqlPreview = useMemo(() => generateCreateTableSql(createTableState), [createTableState]);
  const importTargetTables = useMemo(() => {
    return Object.values(tablesBySchema)
      .flat()
      .map((table) => ({ schema: table.schema, name: table.name, type: table.type }));
  }, [tablesBySchema]);

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

  const sortedRowEntries = useMemo<PostgresRowEntry[]>(() => {
    if (!activeResult) return [];
    const entries = activeResult.rows.map((row, index) => ({ row, index }));

    if (!sortState || sortState.resultId !== activeResultTab?.id) {
      return entries;
    }

    const direction = sortState.direction === 'asc' ? 1 : -1;
    return entries.sort((left, right) => {
      const result = comparePostgresCellValues(left.row[sortState.column], right.row[sortState.column]);
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
    setSchemas([]);
    setExpandedSchemas(new Set());
    setTablesBySchema({});
    setObjectSearch('');
    setSelectedTable(null);
    setSchemaLoading(false);
    setQueryTabs(nextQueryState.tabs);
    setActiveQueryId(nextQueryState.activeId);
    setResultTabs([]);
    setActiveResultId('');
    setHistory([]);
    setPage(0);
    setSortState(null);
    setEditingCell(null);
    setPendingEdit(null);
    setMessage(null);
    setContextMenu(null);
    setCreateTableState((current) => ({ ...current, open: false, executing: false }));
    setImportDataState((current) => ({ ...current, open: false, executing: false, progress: null }));
  }, []);

  const addHistoryItem = useCallback((item: Omit<PostgresHistoryItem, 'id' | 'createdAt'>) => {
    setHistory((items) => [
      {
        ...item,
        id: createId('pg-history'),
        createdAt: Date.now(),
      },
      ...items,
    ].slice(0, maxHistoryItems));
  }, []);

  const addResultTab = useCallback((tab: PostgresResultTab) => {
    setResultTabs((items) => [...items, tab].slice(-maxResultTabs));
    setActiveResultId(tab.id);
    setPage(0);
    setSortState(null);
    setEditingCell(null);
  }, []);

  const setQueryRunning = useCallback((queryId: string, running: boolean) => {
    setQueryTabs((items) => items.map((tab) => (tab.id === queryId ? { ...tab, running } : tab)));
  }, []);

  const updateActiveQuerySql = useCallback((sqlText: string) => {
    setQueryTabs((items) => items.map((tab) => (tab.id === activeQueryId ? { ...tab, sql: sqlText } : tab)));
  }, [activeQueryId]);

  const disconnect = useCallback(async () => {
    if (!api || !postgresIdRef.current) return;

    const currentId = postgresIdRef.current;
    postgresIdRef.current = '';
    await api.postgresDisconnect(connectionId, currentId).catch(() => false);
  }, [api, connectionId]);

  useEffect(() => () => {
    void disconnect();
  }, [disconnect]);

  const loadSchemas = useCallback(async (nextPostgresId: string) => {
    if (!api) return;

    setSchemaLoading(true);
    setTablesBySchema({});
    setSelectedTable(null);

    try {
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
    } finally {
      setSchemaLoading(false);
    }
  }, [api, connectionId]);

  const openPostgresDatabase = useCallback(async (nextDb: string, initial = false) => {
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
    setMessage(initial ? null : { type: 'info', text: `正在切换数据库：${targetDb}` });

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
      const text = tCurrent(
        result.alreadyConnected ? 'postgres.connection.reused' : 'postgres.connection.success',
        {
          transport: describeDatabaseTransport(result.transport),
          user: user || 'postgres',
          host: host || '127.0.0.1',
          port: nextPort,
          database: targetDb,
        },
      );
      setMessage({ type: 'success', text: appendDatabaseFallbackReason(text, result.fallbackReason) });
    } catch (error) {
      if (createdPostgresId) {
        await api.postgresDisconnect(connectionId, createdPostgresId).catch(() => false);
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
  }, [api, connectionId, database, host, hostId, loadSchemas, password, port, user]);

  const connect = useCallback(async () => {
    await openPostgresDatabase(database || 'postgres', true);
  }, [database, openPostgresDatabase]);

  const handleDisconnect = useCallback(async () => {
    await disconnect();
    setStatus('disconnected');
    setPostgresId('');
    resetWorkspaceState();
  }, [disconnect, resetWorkspaceState]);

  const toggleSchema = useCallback(async (schema: string) => {
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
  }, [api, connectionId, postgresId, tablesBySchema]);

  const addQueryTab = useCallback((seedSql?: string) => {
    setQueryTabs((items) => {
      const tab = createQueryTab(items.length + 1, seedSql ?? '');
      setActiveQueryId(tab.id);
      return [...items, tab];
    });
  }, []);

  const closeQueryTab = useCallback((queryId: string) => {
    setQueryTabs((items) => {
      if (items.length === 1) return items;

      const removedIndex = items.findIndex((tab) => tab.id === queryId);
      const next = items.filter((tab) => tab.id !== queryId);

      if (activeQueryId === queryId) {
        setActiveQueryId(next[Math.max(0, removedIndex - 1)]?.id ?? next[0].id);
      }

      return next;
    });
  }, [activeQueryId]);

  const closeResultTab = useCallback((resultId: string) => {
    setResultTabs((items) => {
      const removedIndex = items.findIndex((tab) => tab.id === resultId);
      const next = items.filter((tab) => tab.id !== resultId);

      if (activeResultId === resultId) {
        setActiveResultId(next[Math.max(0, removedIndex - 1)]?.id ?? next[0]?.id ?? '');
      }

      return next;
    });
  }, [activeResultId]);

  const handleUseHistory = useCallback((item: PostgresHistoryItem) => {
    addQueryTab(item.sql);
  }, [addQueryTab]);

  const runQuery = useCallback(async (
    sqlText = activeQueryTab?.sql ?? '',
    options: { table?: TableInfo; title?: string; subtitle?: string; explain?: boolean } = {},
  ) => {
    if (!api || !postgresId || !activeQueryTab) return;
    const statement = sqlText.trim();
    if (!statement) {
      setError(tCurrent('auto.remotePostgres.18it23g'));
      return;
    }

    const queryId = activeQueryTab.id;
    setQueryRunning(queryId, true);
    setError('');
    setMessage(null);
    setPage(0);
    const startedAt = performance.now();

    try {
      const result = await api.postgresQuery(connectionId, postgresId, statement);
      const durationMs = Math.round(performance.now() - startedAt);
      const columns = options.table
        ? await api.postgresColumns(connectionId, postgresId, options.table.schema, options.table.name)
        : createGenericColumns(result.columns, 'postgres');
      const tab: PostgresResultTab = {
        id: createId('pg-result'),
        title: options.title ?? (isWriteStatement(statement, 'postgres') ? '写入结果' : formatSqlPreview(statement, 28)),
        subtitle: options.subtitle ?? database,
        sql: statement,
        status: 'success',
        result,
        queryTime: durationMs,
        createdAt: Date.now(),
        table: options.table,
        columns,
      };

      addResultTab(tab);
      addHistoryItem({
        sql: statement,
        status: 'success',
        rowCount: result.rowCount ?? result.rows.length,
        queryTime: durationMs,
      });
      setMessage({ type: 'success', text: `已执行 · ${result.rowCount ?? result.rows.length} 行 · ${durationMs}ms` });
    } catch (error) {
      const durationMs = Math.round(performance.now() - startedAt);
      const text = getErrorMessage(error);
      addResultTab({
        id: createId('pg-result'),
        title: options.explain ? 'EXPLAIN 失败' : '执行失败',
        subtitle: database,
        sql: statement,
        status: 'error',
        error: text,
        queryTime: durationMs,
        createdAt: Date.now(),
        columns: [],
      });
      addHistoryItem({
        sql: statement,
        status: 'error',
        error: text,
        queryTime: durationMs,
      });
      setError(text);
    } finally {
      setQueryRunning(queryId, false);
    }
  }, [activeQueryTab, addHistoryItem, addResultTab, api, connectionId, database, postgresId, setQueryRunning]);

  const handleExecuteSql = useCallback(() => {
    void runQuery();
  }, [runQuery]);

  const handleExplainSql = useCallback(() => {
    if (!activeQueryTab?.sql.trim()) return;
    const sourceSql = activeQueryTab.sql.trim();
    if (isWriteStatement(sourceSql, 'postgres')) {
      setMessage({ type: 'info', text: 'EXPLAIN 仅用于查询语句，请先选择 SELECT/SHOW 等只读 SQL。' });
      return;
    }

    void runQuery(createExplainSql(sourceSql), {
      title: `EXPLAIN ${formatSqlPreview(sourceSql, 20)}`,
      subtitle: database,
      explain: true,
    });
  }, [activeQueryTab, database, runQuery]);

  const selectTable = useCallback(async (table: ShellDeskPostgresTable) => {
    const tableInfo = { schema: table.schema, name: table.name, type: table.type };
    const previewSql = `SELECT * FROM ${quoteIdentifier(table.schema, 'postgres')}.${quoteIdentifier(table.name, 'postgres')} LIMIT ${tablePreviewLimit};`;
    setSelectedTable(tableInfo);
    updateActiveQuerySql(previewSql);
    await runQuery(previewSql, {
      table: tableInfo,
      title: table.name,
      subtitle: `${table.schema} · LIMIT ${tablePreviewLimit}`,
    });
  }, [runQuery, updateActiveQuerySql]);

  const showDatabaseInfo = useCallback(() => {
    const infoSql = [
      'SELECT',
      '  current_database() AS "数据库",',
      '  pg_encoding_to_char(encoding) AS "编码",',
      '  datcollate AS "排序规则",',
      '  pg_size_pretty(pg_database_size(datname)) AS "大小"',
      'FROM pg_database',
      'WHERE datname = current_database();',
    ].join('\n');
    setContextMenu(null);
    setSelectedTable(null);
    updateActiveQuerySql(infoSql);
    void runQuery(infoSql, { title: `${database} 信息`, subtitle: database });
  }, [database, runQuery, updateActiveQuerySql]);

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
    updateActiveQuerySql(structureSql);
    setQueryRunning(activeQueryTab.id, true);
    setError('');
    setMessage(null);

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
      addResultTab({
        id: createId('pg-result'),
        title: `${table.name} 结构`,
        subtitle: table.schema,
        sql: structureSql,
        status: 'success',
        result,
        queryTime: durationMs,
        createdAt: Date.now(),
        table: tableInfo,
        columns: createGenericColumns(result.columns, 'postgres'),
      });
      addHistoryItem({
        sql: structureSql,
        status: 'success',
        rowCount: nextColumns.length,
        queryTime: durationMs,
      });
      setMessage({ type: 'success', text: `表结构已加载：${table.schema}.${table.name}` });
    } catch (error) {
      const durationMs = Math.round(performance.now() - startedAt);
      const text = getErrorMessage(error);
      setError(text);
      addHistoryItem({
        sql: structureSql,
        status: 'error',
        error: text,
        queryTime: durationMs,
      });
    } finally {
      setQueryRunning(activeQueryTab.id, false);
    }
  }, [activeQueryTab, addHistoryItem, addResultTab, api, connectionId, postgresId, setQueryRunning, updateActiveQuerySql]);

  const exportQueryResult = useCallback(async (format: DatabaseExportFormat) => {
    if (!activeResult || activeResult.rows.length === 0) return;

    setError('');
    setMessage(null);

    try {
      const filePath = await exportDatabaseRows({
        sourceName: 'PostgreSQL',
        format,
        columns: activeResult.columns,
        rows: sortedRowEntries.map((entry) => entry.row),
        fileBaseName: activeResultTab?.title ?? database,
        metadata: {
          database,
          table: activeResultTab?.table ? `${activeResultTab.table.schema}.${activeResultTab.table.name}` : '',
          sql: activeResultTab?.sql ?? '',
          rowCount: activeResult.rowCount ?? activeResult.rows.length,
        },
      });

      if (filePath) {
        setMessage({ type: 'success', text: `查询结果已导出：${filePath}` });
      }
    } catch (error) {
      setError(getErrorMessage(error));
    }
  }, [activeResult, activeResultTab, database, sortedRowEntries]);

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

  const handleCellEdit = useCallback((rowIndex: number, column: string, currentValue: unknown) => {
    if (!activeResultTab || !activeResult || !activeResultTab.table) {
      setMessage({ type: 'info', text: '只有表预览结果支持单元格编辑。' });
      return;
    }

    if (activeResultPrimaryKeys.length === 0) {
      setMessage({ type: 'info', text: '当前表没有主键，暂不支持安全编辑。' });
      return;
    }

    if (activeResultPrimaryKeys.includes(column)) {
      setMessage({ type: 'info', text: '主键列不能直接编辑。' });
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
    if (!pendingEdit || !api || !postgresId) return;

    setEditSaving(true);
    setMessage(null);
    setError('');

    try {
      const result = await api.postgresUpdateCell(
        connectionId,
        postgresId,
        pendingEdit.table.schema,
        pendingEdit.table.name,
        pendingEdit.column,
        pendingEdit.newValue,
        pendingEdit.pkColumns,
        pendingEdit.pkValues,
      );

      if (result.affectedRows > 0) {
        setResultTabs((items) => items.map((tab) => {
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

      setMessage({ type: result.affectedRows === 1 ? 'success' : 'info', text: `已更新 ${result.affectedRows ?? 0} 行` });
      setPendingEdit(null);
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setEditSaving(false);
    }
  }, [api, connectionId, pendingEdit, postgresId]);

  const handleCellKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      prepareCellSave();
    } else if (event.key === 'Escape') {
      setEditingCell(null);
    }
  }, [prepareCellSave]);

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
  }, [contextMenu, selectTable, showDatabaseInfo, showTableStructure]);

  const openCreateTableDialog = useCallback((schema?: string) => {
    const targetSchema = schema || (schemas.includes('public') ? 'public' : schemas[0]) || 'public';

    createTablePreviousFocusRef.current = typeof document === 'undefined' ? null : document.activeElement;
    setCreateTableState({
      open: true,
      schema: targetSchema,
      tableName: '',
      comment: '',
      columns: [createPgSchemaColumn()],
      primaryKeyColumns: [],
      indexes: [],
      foreignKeys: [],
      showAdvanced: false,
      executing: false,
    });
  }, [schemas]);

  const closeCreateTableDialog = useCallback(() => {
    setCreateTableState((current) => ({ ...current, open: false, executing: false }));
  }, []);

  const refreshImportPreview = useCallback((mode: ImportDataState['mode'], text: string) => {
    if (!text.trim()) {
      setImportDataState((current) => ({ ...current, preview: [], columns: [] }));
      return;
    }

    try {
      const parsed = mode === 'csv' ? parseImportCsv(text) : parseImportJson(text);
      setImportDataState((current) => ({ ...current, preview: parsed.preview, columns: parsed.columns }));
    } catch {
      setImportDataState((current) => ({ ...current, preview: [], columns: [] }));
    }
  }, []);

  const openImportDialog = useCallback(() => {
    const targetTable = selectedTable ?? activeResultTab?.table ?? importTargetTables[0] ?? null;
    const targetValue = targetTable ? serializeImportTarget(targetTable) : '';

    importPreviousFocusRef.current = typeof document === 'undefined' ? null : document.activeElement;
    if (targetTable && (!tablesBySchema[targetTable.schema] || tablesBySchema[targetTable.schema].length === 0)) {
      void toggleSchema(targetTable.schema);
    }
    setImportDataState((current) => ({
      ...current,
      open: true,
      targetTable: targetValue,
      executing: false,
      progress: null,
    }));
  }, [activeResultTab, importTargetTables, selectedTable, tablesBySchema, toggleSchema]);

  const closeImportDialog = useCallback(() => {
    setImportDataState((current) => ({ ...current, open: false, executing: false, progress: null }));
  }, []);

  const updateImportText = useCallback((mode: ImportDataState['mode'], text: string) => {
    setImportDataState((current) => ({
      ...current,
      mode,
      csvText: mode === 'csv' ? text : current.csvText,
      jsonText: mode === 'json' ? text : current.jsonText,
      progress: null,
    }));
    refreshImportPreview(mode, text);
  }, [refreshImportPreview]);

  const handleImportFileSelected = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      const mode: ImportDataState['mode'] = file.name.endsWith('.json') ? 'json' : 'csv';
      setImportDataState((current) => ({
        ...current,
        mode,
        csvText: mode === 'csv' ? text : current.csvText,
        jsonText: mode === 'json' ? text : current.jsonText,
        progress: null,
      }));
      refreshImportPreview(mode, text);
    };
    reader.readAsText(file);

    event.target.value = '';
  }, [refreshImportPreview]);

  const updateImportMode = useCallback((mode: ImportDataState['mode']) => {
    setImportDataState((current) => ({ ...current, mode, progress: null }));
    refreshImportPreview(mode, mode === 'csv' ? importDataState.csvText : importDataState.jsonText);
  }, [importDataState.csvText, importDataState.jsonText, refreshImportPreview]);

  const getImportTargetTable = useCallback((): TableInfo | null => {
    if (importDataState.targetTable === importEditorTarget) {
      return selectedTable ?? activeResultTab?.table ?? null;
    }
    return parseImportTarget(importDataState.targetTable);
  }, [activeResultTab, importDataState.targetTable, selectedTable]);

  const handleExecuteImport = useCallback(async () => {
    if (!api || !postgresId) return;

    const table = getImportTargetTable();
    const text = importDataState.mode === 'csv' ? importDataState.csvText : importDataState.jsonText;

    if (!table) {
      setMessage({ type: 'error', text: tCurrent('auto.remotePostgres.importNoTable') });
      return;
    }
    if (!text.trim()) {
      setMessage({ type: 'error', text: tCurrent('auto.remotePostgres.importNoData') });
      return;
    }

    let parsed: { columns: string[]; rows: Record<string, unknown>[]; preview: Record<string, string>[] };
    try {
      parsed = importDataState.mode === 'csv' ? parseImportCsv(text) : parseImportJson(text);
    } catch (error) {
      setMessage({ type: 'error', text: tCurrent('auto.remotePostgres.importParseError', { error: getErrorMessage(error) }) });
      return;
    }

    if (parsed.columns.length === 0 || parsed.rows.length === 0) {
      setMessage({ type: 'error', text: tCurrent('auto.remotePostgres.importNoData') });
      return;
    }

    const batchSize = parsed.rows.length > 50 ? 100 : parsed.rows.length;
    const startTime = performance.now();
    let importedRows = 0;
    let lastResult: ShellDeskPostgresQueryResult = { columns: [], rows: [], rowCount: 0 };
    const sqlStatements: string[] = [];

    setMessage(null);
    setError('');
    setImportDataState((current) => ({
      ...current,
      executing: true,
      progress: { current: 0, total: parsed.rows.length },
      preview: parsed.preview,
      columns: parsed.columns,
    }));

    try {
      for (let index = 0; index < parsed.rows.length; index += batchSize) {
        const batch = parsed.rows.slice(index, index + batchSize);
        const sqlText = buildPgInsertSql(table.schema, table.name, parsed.columns, batch);
        sqlStatements.push(sqlText);
        lastResult = await api.postgresQuery(connectionId, postgresId, sqlText);
        importedRows += batch.length;
        setImportDataState((current) => ({ ...current, progress: { current: importedRows, total: parsed.rows.length } }));
      }

      const queryTime = Math.round(performance.now() - startTime);
      const result: ShellDeskPostgresQueryResult = { ...lastResult, rowCount: importedRows };
      addResultTab({
        id: createId('pg-result'),
        title: table.name,
        subtitle: `${database} · ${table.schema}`,
        sql: sqlStatements.join('\n'),
        status: 'success',
        result,
        queryTime,
        createdAt: Date.now(),
        table,
        columns: createGenericColumns(result.columns, 'postgres'),
      });
      addHistoryItem({
        sql: sqlStatements.join('\n'),
        status: 'success',
        rowCount: importedRows,
        queryTime,
      });
      setMessage({ type: 'success', text: tCurrent('auto.remotePostgres.importSuccess', { count: importedRows, table: formatImportTarget(table) }) });
      setImportDataState((current) => ({ ...current, executing: false, progress: { current: importedRows, total: parsed.rows.length } }));
    } catch (error) {
      const text = getErrorMessage(error);
      const queryTime = Math.round(performance.now() - startTime);
      addResultTab({
        id: createId('pg-result'),
        title: '执行失败',
        subtitle: database,
        sql: sqlStatements.join('\n'),
        status: 'error',
        error: text,
        queryTime,
        createdAt: Date.now(),
        columns: [],
      });
      addHistoryItem({
        sql: sqlStatements.join('\n'),
        status: 'error',
        error: text,
        queryTime,
      });
      setMessage({ type: 'error', text: tCurrent('auto.remotePostgres.importFailed', { error: text }) });
      setImportDataState((current) => ({ ...current, executing: false }));
    }
  }, [addHistoryItem, addResultTab, api, connectionId, database, getImportTargetTable, importDataState.csvText, importDataState.jsonText, importDataState.mode, postgresId]);

  const updateCreateTableColumn = useCallback(<Key extends keyof PgSchemaColumn,>(
    columnId: string,
    key: Key,
    value: PgSchemaColumn[Key],
  ) => {
    setCreateTableState((current) => {
      const previousColumn = current.columns.find((column) => column.id === columnId);
      const previousName = previousColumn?.name.trim() ?? '';
      const nextName = key === 'name' ? String(value).trim() : previousName;
      const nextColumns = current.columns.map((column) => (column.id === columnId ? { ...column, [key]: value } : column));

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
    setCreateTableState((current) => ({ ...current, columns: [...current.columns, createPgSchemaColumn()] }));
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

  const updateSchemaIndex = useCallback((indexId: string, patch: Partial<PgSchemaIndex>) => {
    setCreateTableState((current) => ({
      ...current,
      indexes: current.indexes.map((index) => (index.id === indexId ? { ...index, ...patch } : index)),
    }));
  }, []);

  const updateSchemaForeignKey = useCallback((foreignKeyId: string, patch: Partial<PgSchemaForeignKey>) => {
    setCreateTableState((current) => ({
      ...current,
      foreignKeys: current.foreignKeys.map((foreignKey) => (foreignKey.id === foreignKeyId ? { ...foreignKey, ...patch } : foreignKey)),
    }));
  }, []);

  const handleExecuteCreateTable = useCallback(async () => {
    if (!api || !postgresId) return;

    if (!createTableState.tableName.trim()) {
      setMessage({ type: 'error', text: tCurrent('auto.remotePostgres.pleaseFillTableName') });
      return;
    }
    if (createTableState.columns.length === 0) {
      setMessage({ type: 'error', text: tCurrent('auto.remotePostgres.pleaseAddColumns') });
      return;
    }
    if (createTableState.columns.some((column) => !column.name.trim())) {
      setMessage({ type: 'error', text: tCurrent('auto.remotePostgres.invalidColumnName') });
      return;
    }
    const validationError = validateCreateTableState(createTableState);
    if (validationError) {
      setMessage({ type: 'error', text: validationError });
      return;
    }

    const statements = generateCreateTableStatements(createTableState);
    const sqlText = statements.join('\n');
    const startTime = performance.now();
    setCreateTableState((current) => ({ ...current, executing: true }));
    setMessage(null);
    setError('');

    try {
      let result: ShellDeskPostgresQueryResult = { columns: [], rows: [], rowCount: 0 };
      for (const statement of statements) {
        result = await api.postgresQuery(connectionId, postgresId, statement);
      }
      const queryTime = Math.round(performance.now() - startTime);
      addResultTab({
        id: createId('pg-result'),
        title: createTableState.tableName.trim(),
        subtitle: createTableState.schema || database,
        sql: sqlText,
        status: 'success',
        result,
        queryTime,
        createdAt: Date.now(),
        columns: createGenericColumns(result.columns, 'postgres'),
      });
      addHistoryItem({
        sql: sqlText,
        status: 'success',
        rowCount: result.rowCount ?? result.rows.length,
        queryTime,
      });
      const schema = createTableState.schema || 'public';
      setExpandedSchemas((current) => new Set(current).add(schema));
      const tables = await api.postgresTables(connectionId, postgresId, schema);
      setTablesBySchema((current) => ({ ...current, [schema]: tables }));
      setCreateTableState((current) => ({ ...current, open: false, executing: false }));
      setMessage({ type: 'success', text: tCurrent('auto.remotePostgres.tableCreated', { table: createTableState.tableName.trim() }) });
    } catch (error) {
      const text = getErrorMessage(error);
      const queryTime = Math.round(performance.now() - startTime);
      addResultTab({
        id: createId('pg-result'),
        title: tCurrent('auto.remotePostgres.createTable'),
        subtitle: createTableState.schema || database,
        sql: sqlText,
        status: 'error',
        error: text,
        queryTime,
        createdAt: Date.now(),
        columns: [],
      });
      addHistoryItem({
        sql: sqlText,
        status: 'error',
        error: text,
        queryTime,
      });
      setMessage({ type: 'error', text: tCurrent('auto.remotePostgres.createTableFailed', { error: text }) });
      setCreateTableState((current) => ({ ...current, executing: false }));
    }
  }, [addHistoryItem, addResultTab, api, connectionId, createTableState, database, postgresId]);

  const editorExtensions = useMemo<Extension[]>(() => [
    keymap.of([
      indentWithTab,
      {
        key: 'Mod-Enter',
        run: () => {
          handleExecuteSql();
          return true;
        },
      },
    ]),
    sql({ dialect: PostgreSQL }),
    EditorView.theme({
      '&': {
        height: '100%',
        minHeight: '0',
        backgroundColor: 'rgba(5, 10, 16, 0.36)',
        color: 'var(--pg-text)',
        fontSize: '12px',
      },
      '.cm-scroller': {
        backgroundColor: 'rgba(5, 10, 16, 0.36)',
        fontFamily: 'var(--font-mono, "Cascadia Mono", Consolas, monospace)',
        lineHeight: '20px',
      },
      '.cm-content': {
        padding: '10px 0',
        caretColor: 'var(--pg-text)',
      },
      '.cm-line': {
        padding: '0 10px',
      },
      '.cm-gutters': {
        borderRight: '1px solid var(--pg-border)',
        backgroundColor: 'rgba(8, 13, 20, 0.72)',
        color: 'var(--pg-muted)',
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'transparent',
        color: 'var(--pg-accent)',
      },
      '.cm-activeLine': {
        backgroundColor: 'rgba(115, 183, 255, 0.09)',
      },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
        backgroundColor: 'rgba(115, 183, 255, 0.25)',
      },
      '&.cm-focused': {
        outline: 'none',
      },
    }, {
      dark: editorTheme === 'dark',
    }),
  ], [editorTheme, handleExecuteSql]);

  useEffect(() => {
    postgresIdRef.current = postgresId;
  }, [postgresId]);

  useEffect(() => {
    return window.guiSSH?.events?.onDatabaseTunnelIdleTimeout((payload) => {
      if (
        payload.kind !== 'postgres' ||
        payload.connectionId !== connectionId ||
        payload.sessionId !== postgresIdRef.current
      ) {
        return;
      }

      postgresIdRef.current = '';
      setPostgresId('');
      setStatus('disconnected');
      resetWorkspaceState();
      setError(`数据库连接已因空闲超过 ${payload.idleMinutes} 分钟自动断开。`);
    });
  }, [connectionId, resetWorkspaceState]);

  useEffect(() => {
    setPage(0);
    setEditingCell(null);
  }, [activeResultId]);

  useEffect(() => {
    if (isConnected) {
      editorRef.current?.view?.focus();
    }
  }, [activeQueryId, isConnected]);

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

  useEffect(() => {
    if (!importDataState.open) return undefined;

    return () => {
      const previousFocus = importPreviousFocusRef.current;
      importPreviousFocusRef.current = null;
      if (previousFocus instanceof HTMLElement) {
        previousFocus.focus();
      }
    };
  }, [importDataState.open]);

  useEffect(() => {
    if (!importDataState.open || typeof document === 'undefined') return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || importDataState.executing) return;
      event.preventDefault();
      closeImportDialog();
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [closeImportDialog, importDataState.executing, importDataState.open]);

  useContextMenu(contextMenu, setContextMenu);

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
            <button type="button" className="postgres-connect-btn" onClick={() => void connect()} disabled={status === 'connecting'}>
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
          <div className="postgres-editor-actions">
            <button type="button" onClick={() => openCreateTableDialog()} disabled={!isConnected} title={tCurrent('auto.remotePostgres.createTable')}>
              +
            </button>
            <button type="button" onClick={openImportDialog} disabled={!isConnected} title={tCurrent('auto.remotePostgres.importData')}>
              ⇧
            </button>
            <button type="button" onClick={() => void loadSchemas(postgresId)} disabled={schemaLoading}>
              {schemaLoading ? '...' : tCurrent('auto.remotePostgres.12qo56a')}
            </button>
          </div>
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
              <button type="button" className="postgres-schema-btn" onClick={() => void toggleSchema(schema)}>
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
                      onClick={() => void selectTable(table)}
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
              <button key={item.id} type="button" className={item.status} onClick={() => handleUseHistory(item)} title={item.sql}>
                <strong>{formatSqlPreview(item.sql, 80)}</strong>
                <span>{new Date(item.createdAt).toLocaleTimeString(getShellDeskLocale())} · {item.queryTime} ms{item.rowCount !== undefined ? ` · ${item.rowCount} 行` : ''}</span>
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
          <button type="button" className="postgres-disconnect-btn" onClick={() => void handleDisconnect()}>{tCurrent('auto.remotePostgres.a4u4dk')}</button>
        </header>

        {error ? (
          <DismissibleAlert className="postgres-message error" onDismiss={() => setError('')} role="alert">
            {error}
          </DismissibleAlert>
        ) : null}
        {message ? (
          <DismissibleAlert className={`postgres-message ${message.type === 'error' ? 'error' : 'info'}`} onDismiss={() => setMessage(null)} role={message.type === 'error' ? 'alert' : 'status'}>
            {message.text}
          </DismissibleAlert>
        ) : null}

        <section className="postgres-editor">
          <div className="postgres-query-tabs" role="tablist" aria-label="PostgreSQL 查询标签">
            {queryTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeQueryId === tab.id}
                className={`postgres-query-tab ${activeQueryId === tab.id ? 'active' : ''}`}
                onClick={() => setActiveQueryId(tab.id)}
              >
                <span>{tab.title}</span>
                {tab.running ? <em>{tCurrent('auto.remotePostgres.6svkbt')}</em> : null}
                {queryTabs.length > 1 ? (
                  <span
                    role="button"
                    tabIndex={0}
                    className="postgres-tab-close"
                    onClick={(event) => {
                      event.stopPropagation();
                      closeQueryTab(tab.id);
                    }}
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
            <button type="button" className="postgres-add-tab-btn" onClick={() => addQueryTab()} title="新建查询">+</button>
          </div>
          <div className="postgres-editor-toolbar">
            <span>{tCurrent('auto.remotePostgres.cj2ebw')}</span>
            <div className="postgres-editor-actions">
              <button type="button" onClick={handleExecuteSql} disabled={!canRunActiveQuery}>{activeQueryTab?.running ? tCurrent('auto.remotePostgres.6svkbt') : tCurrent('auto.remotePostgres.6x8ukm')}</button>
              <button type="button" onClick={handleExplainSql} disabled={!canExplainActiveQuery}>EXPLAIN</button>
            </div>
          </div>
          <CodeMirror
            ref={editorRef}
            className="postgres-sql-editor"
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
            extensions={editorExtensions}
            onChange={updateActiveQuerySql}
            placeholder="SELECT * FROM public.example LIMIT 20;"
            aria-label="PostgreSQL SQL 编辑器"
          />
        </section>

        <section className="postgres-result">
          <div className="postgres-result-tabs">
            {resultTabs.length === 0 ? (
              <span className="postgres-result-tabs-empty">{tCurrent('auto.remotePostgres.q9h21m')}</span>
            ) : resultTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`postgres-result-tab ${activeResultId === tab.id ? 'active' : ''} ${tab.status}`}
                onClick={() => setActiveResultId(tab.id)}
                title={tab.sql}
              >
                <span>{tab.title}</span>
                <em>{tab.status === 'success' && tab.result ? describeResult(tab.result) : '错误'}</em>
                <span
                  role="button"
                  tabIndex={0}
                  className="postgres-tab-close"
                  onClick={(event) => {
                    event.stopPropagation();
                    closeResultTab(tab.id);
                  }}
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
            <div className="postgres-placeholder">{tCurrent('auto.remotePostgres.3ifoef')}</div>
          ) : activeResultTab.status === 'error' ? (
            <div className="postgres-result-error-panel">
              <strong>执行失败</strong>
              <code>{formatSqlPreview(activeResultTab.sql, 120)}</code>
              <p>{activeResultTab.error}</p>
              <span>{activeResultTab.queryTime}ms · {new Date(activeResultTab.createdAt).toLocaleTimeString(getShellDeskLocale())}</span>
            </div>
          ) : activeResult ? (
            <>
              <div className="postgres-result-head">
                <div className="database-result-title">
                  <strong>{describeResult(activeResult)}</strong>
                  <span>{activeResultTab.queryTime}ms · {activeResultTab.subtitle}</span>
                  <span>
                    {isActiveResultEditable
                      ? `可编辑，主键：${activeResultPrimaryKeys.join(', ')}`
                      : activeResultTab.table ? '当前表没有主键，结果只读' : '查询结果只读'}
                  </span>
                </div>
                <div className="database-export-actions" aria-label={tCurrent('db.query.exportAria')}>
                  <button type="button" className="database-export-button" onClick={openImportDialog}>{tCurrent('auto.remotePostgres.importData')}</button>
                  <button type="button" className="database-export-button" onClick={() => void exportQueryResult('json')} disabled={activeResult.rows.length === 0}>{tCurrent('db.query.exportJson')}</button>
                  <button type="button" className="database-export-button" onClick={() => void exportQueryResult('csv')} disabled={activeResult.rows.length === 0}>{tCurrent('db.query.exportCsv')}</button>
                </div>
              </div>
              {activeResult.columns.length > 0 ? (
                <>
                  <div className="postgres-table-wrap">
                    <table className="postgres-data-table">
                      <thead>
                        <tr>
                          <th className="postgres-row-num">#</th>
                          {activeResult.columns.map((column) => {
                            const meta = activeResultColumns.find((item) => item.name === column);
                            const activeSort = sortState?.resultId === activeResultTab.id && sortState.column === column ? sortState.direction : null;
                            return (
                              <th key={column}>
                                <button
                                  type="button"
                                  className={`postgres-sort-button ${activeSort ? 'active' : ''}`}
                                  onClick={() => toggleResultSort(column)}
                                  title={`按 ${column} 排序`}
                                >
                                  <span>{column}{meta?.isPrimaryKey ? <small>PK</small> : null}</span>
                                  <em>{activeSort === 'asc' ? '▲' : activeSort === 'desc' ? '▼' : ''}</em>
                                </button>
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
                              <td className="postgres-row-num">{displayRowIndex + 1}</td>
                              {activeResult.columns.map((column) => {
                                const cellValue = row[column];
                                const isEditing = editingCell?.rowIndex === sourceRowIndex && editingCell.column === column;
                                const isEditableColumn = isActiveResultEditable && !activeResultPrimaryKeys.includes(column);

                                if (isEditing) {
                                  return (
                                    <td key={column} className="postgres-cell-editing">
                                      <div className="mysql-cell-editbox">
                                        <input
                                          type="text"
                                          value={editingCell.isNull ? '' : editingCell.value}
                                          onChange={(event) => setEditingCell({ ...editingCell, value: event.target.value, isNull: false })}
                                          onKeyDown={handleCellKeyDown}
                                          onBlur={prepareCellSave}
                                          autoFocus
                                          className="postgres-cell-input"
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
                                    className={`${cellValue === null ? 'postgres-cell-null' : ''} ${isEditableColumn ? 'postgres-cell-editable' : ''}`}
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
                    <div className="postgres-pagination">
                      <button type="button" disabled={page === 0} onClick={() => setPage(0)}>首页</button>
                      <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button>
                      <span>{page + 1} / {totalPages}</span>
                      <button type="button" disabled={page >= totalPages - 1} onClick={() => setPage(page + 1)}>下一页</button>
                      <button type="button" disabled={page >= totalPages - 1} onClick={() => setPage(totalPages - 1)}>末页</button>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="postgres-placeholder">语句已执行，没有返回结果集</div>
              )}
            </>
          ) : null}
        </section>
      </main>

      {createTableState.open ? createPortal(
        <div className="schema-dialog-overlay" role="presentation">
          <div className="schema-dialog" role="dialog" aria-modal="true" aria-labelledby="postgres-create-table-title">
            <div className="schema-dialog-header">
              <h3 id="postgres-create-table-title">
                {tCurrent('auto.remotePostgres.createTableTitle', { schema: createTableState.schema || 'public' })}
              </h3>
              <button
                type="button"
                onClick={closeCreateTableDialog}
                disabled={createTableState.executing}
                aria-label={tCurrent('auto.remotePostgres.cancel')}
              >
                ×
              </button>
            </div>

            <div className="schema-form-grid">
              <label className="schema-field">
                <span>{tCurrent('auto.remotePostgres.schema')}</span>
                <select
                  value={createTableState.schema}
                  onChange={(event) => setCreateTableState((current) => ({ ...current, schema: event.target.value }))}
                >
                  {(schemas.length > 0 ? schemas : ['public']).map((schema) => (
                    <option key={schema} value={schema}>{schema}</option>
                  ))}
                </select>
              </label>
              <label className="schema-field">
                <span>{tCurrent('auto.remotePostgres.tableName')}</span>
                <input
                  type="text"
                  value={createTableState.tableName}
                  onChange={(event) => setCreateTableState((current) => ({ ...current, tableName: event.target.value }))}
                  placeholder={tCurrent('auto.remotePostgres.tableName')}
                  autoFocus
                />
              </label>
              <label className="schema-field schema-field-wide">
                <span>{tCurrent('auto.remotePostgres.comment')}</span>
                <input
                  type="text"
                  value={createTableState.comment}
                  onChange={(event) => setCreateTableState((current) => ({ ...current, comment: event.target.value }))}
                />
              </label>
            </div>

            <div className="schema-section">
              <div className="schema-section-header">
                <strong>{tCurrent('auto.remotePostgres.columnName')}</strong>
                <button type="button" onClick={addCreateTableColumn}>{tCurrent('auto.remotePostgres.addColumn')}</button>
              </div>
              <div className="schema-columns-scroll">
                <table className="schema-columns-table">
                  <thead>
                    <tr>
                      <th>{tCurrent('auto.remotePostgres.primaryKey')}</th>
                      <th>{tCurrent('auto.remotePostgres.columnName')}</th>
                      <th>{tCurrent('auto.remotePostgres.columnType')}</th>
                      <th>{tCurrent('auto.remotePostgres.columnLength')}</th>
                      <th>{tCurrent('auto.remotePostgres.nullable')}</th>
                      <th>{tCurrent('auto.remotePostgres.defaultValue')}</th>
                      <th>{tCurrent('auto.remotePostgres.comment')}</th>
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
                              title={tCurrent('auto.remotePostgres.primaryKey')}
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
                              {postgresColumnTypes.map((type) => (
                                <option key={type} value={type}>{type}</option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <input
                              type="text"
                              value={column.length}
                              onChange={(event) => updateCreateTableColumn(column.id, 'length', event.target.value)}
                              disabled={postgresTypesWithoutLength.has(column.type.toUpperCase())}
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
                              placeholder={column.type === 'INTEGER' ? 'SERIAL' : ''}
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
                              {tCurrent('auto.remotePostgres.removeColumn')}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <button
              type="button"
              className="schema-collapse-toggle"
              onClick={() => setCreateTableState((current) => ({ ...current, showAdvanced: !current.showAdvanced }))}
            >
              {createTableState.showAdvanced ? '▾' : '▸'} {tCurrent('auto.remotePostgres.index')} / {tCurrent('auto.remotePostgres.foreignKey')}
            </button>

            {createTableState.showAdvanced ? (
              <div className="schema-relations-grid">
                <section className="schema-subsection">
                  <div className="schema-section-header">
                    <strong>{tCurrent('auto.remotePostgres.index')}</strong>
                    <button
                      type="button"
                      onClick={() => setCreateTableState((current) => ({ ...current, indexes: [...current.indexes, createPgSchemaIndex()] }))}
                      title={tCurrent('auto.remotePostgres.addIndex')}
                    >
                      {tCurrent('auto.remotePostgres.addIndex')}
                    </button>
                  </div>
                  {createTableState.indexes.map((index) => (
                    <div key={index.id} className="schema-inline-editor">
                      <label className="schema-field">
                        <span>{tCurrent('auto.remotePostgres.indexType')}</span>
                        <select value={index.type} onChange={(event) => updateSchemaIndex(index.id, { type: event.target.value as PgSchemaIndex['type'] })}>
                          <option value="INDEX">{tCurrent('auto.remotePostgres.index')}</option>
                          <option value="UNIQUE">{tCurrent('auto.remotePostgres.unique')}</option>
                        </select>
                      </label>
                      <label className="schema-field">
                        <span>{tCurrent('auto.remotePostgres.columnName')}</span>
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
                        <span>{tCurrent('auto.remotePostgres.indexName')}</span>
                        <input type="text" value={index.name} onChange={(event) => updateSchemaIndex(index.id, { name: event.target.value })} />
                      </label>
                      <button
                        type="button"
                        onClick={() => setCreateTableState((current) => ({ ...current, indexes: current.indexes.filter((item) => item.id !== index.id) }))}
                      >
                        {tCurrent('auto.remotePostgres.removeIndex')}
                      </button>
                    </div>
                  ))}
                </section>

                <section className="schema-subsection">
                  <div className="schema-section-header">
                    <strong>{tCurrent('auto.remotePostgres.foreignKey')}</strong>
                    <button
                      type="button"
                      onClick={() => setCreateTableState((current) => ({ ...current, foreignKeys: [...current.foreignKeys, createPgSchemaForeignKey()] }))}
                      title={tCurrent('auto.remotePostgres.addForeignKey')}
                    >
                      {tCurrent('auto.remotePostgres.addForeignKey')}
                    </button>
                  </div>
                  {createTableState.foreignKeys.map((foreignKey) => (
                    <div key={foreignKey.id} className="schema-inline-editor">
                      <label className="schema-field">
                        <span>{tCurrent('auto.remotePostgres.columnName')}</span>
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
                        <span>{tCurrent('auto.remotePostgres.referenceSchema')}</span>
                        <select value={foreignKey.refSchema} onChange={(event) => updateSchemaForeignKey(foreignKey.id, { refSchema: event.target.value })}>
                          {(schemas.length > 0 ? schemas : ['public']).map((schema) => (
                            <option key={schema} value={schema}>{schema}</option>
                          ))}
                        </select>
                      </label>
                      <label className="schema-field">
                        <span>{tCurrent('auto.remotePostgres.referenceTable')}</span>
                        <input type="text" value={foreignKey.refTable} onChange={(event) => updateSchemaForeignKey(foreignKey.id, { refTable: event.target.value })} />
                      </label>
                      <button
                        type="button"
                        onClick={() => updateSchemaForeignKey(foreignKey.id, {
                          refSchema: createTableState.schema || 'public',
                          refTable: createTableState.tableName.trim(),
                        })}
                        disabled={!createTableState.tableName.trim()}
                      >
                        {tCurrent('auto.remotePostgres.selfReference')}
                      </button>
                      <label className="schema-field">
                        <span>{tCurrent('auto.remotePostgres.referenceColumn')}</span>
                        <input
                          type="text"
                          value={foreignKey.refColumns.join(', ')}
                          onChange={(event) => updateSchemaForeignKey(foreignKey.id, {
                            refColumns: event.target.value.split(',').map((column) => column.trim()).filter(Boolean),
                          })}
                        />
                      </label>
                      <label className="schema-field">
                        <span>{tCurrent('auto.remotePostgres.onDelete')}</span>
                        <select value={foreignKey.onDelete} onChange={(event) => updateSchemaForeignKey(foreignKey.id, { onDelete: event.target.value })}>
                          {postgresForeignKeyActions.map((action) => (
                            <option key={action} value={action}>{translateForeignKeyAction(action)}</option>
                          ))}
                        </select>
                      </label>
                      <label className="schema-field">
                        <span>{tCurrent('auto.remotePostgres.onUpdate')}</span>
                        <select value={foreignKey.onUpdate} onChange={(event) => updateSchemaForeignKey(foreignKey.id, { onUpdate: event.target.value })}>
                          {postgresForeignKeyActions.map((action) => (
                            <option key={action} value={action}>{translateForeignKeyAction(action)}</option>
                          ))}
                        </select>
                      </label>
                      <button
                        type="button"
                        onClick={() => setCreateTableState((current) => ({ ...current, foreignKeys: current.foreignKeys.filter((item) => item.id !== foreignKey.id) }))}
                      >
                        {tCurrent('auto.remotePostgres.removeForeignKey')}
                      </button>
                    </div>
                  ))}
                </section>
              </div>
            ) : null}

            <label className="schema-field schema-preview-field">
              <span>{tCurrent('auto.remotePostgres.sqlPreview')}</span>
              <textarea className="schema-preview" value={createTableSqlPreview} readOnly rows={8} />
            </label>

            <div className="schema-actions">
              <button type="button" onClick={closeCreateTableDialog} disabled={createTableState.executing}>
                {tCurrent('auto.remotePostgres.cancel')}
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => void handleExecuteCreateTable()}
                disabled={createTableState.executing}
              >
                {createTableState.executing ? tCurrent('auto.remotePostgres.6svkbt') : tCurrent('auto.remotePostgres.executeCreate')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}

      {importDataState.open ? createPortal(
        <div className="schema-dialog-overlay" role="presentation">
          <div className="schema-dialog mysql-import-dialog" role="dialog" aria-modal="true" aria-labelledby="postgres-import-title">
            <div className="schema-dialog-header">
              <h3 id="postgres-import-title">
                {tCurrent('auto.remotePostgres.importDialogTitle', { table: formatImportTarget(getImportTargetTable()) || '-' })}
              </h3>
              <button
                type="button"
                onClick={closeImportDialog}
                disabled={importDataState.executing}
                aria-label={tCurrent('auto.remotePostgres.cancel')}
              >
                ×
              </button>
            </div>

            <div className="schema-form-grid">
              <label className="schema-field schema-field-wide">
                <span>{tCurrent('auto.remotePostgres.importTargetTable')}</span>
                <select
                  value={importDataState.targetTable}
                  onChange={(event) => setImportDataState((current) => ({ ...current, targetTable: event.target.value, progress: null }))}
                  disabled={importDataState.executing}
                >
                  <option value="">{tCurrent('auto.remotePostgres.importNoTable')}</option>
                  <option value={importEditorTarget}>{tCurrent('auto.remotePostgres.importFromSqlEditor')}</option>
                  {importTargetTables.map((table) => {
                    const value = serializeImportTarget(table);
                    const label = formatImportTarget(table);
                    return <option key={value} value={value}>{label}</option>;
                  })}
                </select>
              </label>
            </div>

            <div className="mysql-import-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={importDataState.mode === 'csv'}
                className={importDataState.mode === 'csv' ? 'active' : ''}
                onClick={() => updateImportMode('csv')}
                disabled={importDataState.executing}
              >
                {tCurrent('auto.remotePostgres.importCsvTab')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={importDataState.mode === 'json'}
                className={importDataState.mode === 'json' ? 'active' : ''}
                onClick={() => updateImportMode('json')}
                disabled={importDataState.executing}
              >
                {tCurrent('auto.remotePostgres.importJsonTab')}
              </button>
            </div>

            <div className="schema-import-file-row">
              <input
                type="file"
                ref={importFileInputRef}
                style={{ display: 'none' }}
                accept=".csv,.json"
                onChange={handleImportFileSelected}
              />
              <button type="button" onClick={() => importFileInputRef.current?.click()} disabled={importDataState.executing}>
                {tCurrent('auto.remotePostgres.importSelectFile')}
              </button>
            </div>

            <label className="schema-field schema-preview-field">
              <span>
                {importDataState.mode === 'csv'
                  ? tCurrent('auto.remotePostgres.importPasteCsv')
                  : tCurrent('auto.remotePostgres.importPasteJson')}
              </span>
              <textarea
                value={importDataState.mode === 'csv' ? importDataState.csvText : importDataState.jsonText}
                onChange={(event) => updateImportText(importDataState.mode, event.target.value)}
                disabled={importDataState.executing}
                rows={8}
                autoFocus
              />
            </label>

            <div className="schema-section">
              <div className="schema-section-header">
                <strong>{tCurrent('auto.remotePostgres.importPreview')}</strong>
                {importDataState.progress ? (
                  <span className="mysql-import-progress">
                    {tCurrent('auto.remotePostgres.importProgress', {
                      current: importDataState.progress.current,
                      total: importDataState.progress.total,
                    })}
                  </span>
                ) : null}
              </div>
              <div className="mysql-import-preview">
                {importDataState.columns.length > 0 && importDataState.preview.length > 0 ? (
                  <table>
                    <thead>
                      <tr>
                        {importDataState.columns.map((column) => (
                          <th key={column}>{column}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {importDataState.preview.map((row, rowIndex) => (
                        <tr key={`${rowIndex}-${importDataState.columns.join('|')}`}>
                          {importDataState.columns.map((column) => (
                            <td key={column}>{row[column] ?? ''}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="mysql-import-empty">{tCurrent('auto.remotePostgres.importNoData')}</div>
                )}
              </div>
            </div>

            <div className="schema-actions">
              <button type="button" onClick={closeImportDialog} disabled={importDataState.executing}>
                {tCurrent('auto.remotePostgres.cancel')}
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => void handleExecuteImport()}
                disabled={importDataState.executing}
              >
                {importDataState.executing ? tCurrent('auto.remotePostgres.6svkbt') : tCurrent('auto.remotePostgres.importExecute')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}

      {pendingEdit ? createPortal(
        <div className="postgres-modal-backdrop" role="presentation">
          <div className="postgres-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="postgres-edit-title">
            <div className="postgres-edit-dialog-header">
              <strong id="postgres-edit-title">确认更新单元格</strong>
              <span>{pendingEdit.table.schema}.{pendingEdit.table.name}</span>
            </div>
            <div className="postgres-edit-summary">
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
                <span>条件</span>
                <code>{pendingEdit.pkColumns.map((pkColumn, index) => `${pkColumn}=${formatCellValue(pendingEdit.pkValues[index])}`).join(' AND ')}</code>
              </div>
            </div>
            <p className="postgres-edit-warning">将通过主键条件执行 UPDATE，请确认当前行仍然是目标记录。</p>
            <div className="postgres-edit-actions">
              <button type="button" onClick={() => setPendingEdit(null)} disabled={editSaving}>取消</button>
              <button type="button" className="primary" onClick={() => void handleConfirmCellSave()} disabled={editSaving}>
                {editSaving ? '保存中...' : '确认保存'}
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
