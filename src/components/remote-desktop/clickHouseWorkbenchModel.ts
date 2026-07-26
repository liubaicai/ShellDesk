import { getShellDeskLocale } from './desktopUtils';
import {
  parseDatabaseImportCsv,
  parseDatabaseImportJson,
  readDatabaseImportValue,
} from './database-import/databaseImportUtils';
import { createId, quoteIdentifier } from './databaseUtils';
import { tCurrent } from '../../i18n';

export interface RemoteClickHouseProps {
  connectionId: string;
  hostId: string;
}

export interface ClickHouseConnectionForm {
  host: string;
  port: string;
  secure: boolean;
  user: string;
  password: string;
  initialDatabase: string;
}

export type ClickHouseStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export type ClickHouseMessageType = 'info' | 'success' | 'error';
export type ClickHouseResultStatus = 'success' | 'error';

export interface TableInfo extends ShellDeskClickHouseTable {
  database: string;
}

export interface ClickHouseMessage {
  type: ClickHouseMessageType;
  text: string;
}

export interface ClickHouseQueryTab {
  id: string;
  title: string;
  sql: string;
  running: boolean;
}

export interface ClickHouseResultTab {
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

export interface ClickHouseHistoryItem {
  id: string;
  sql: string;
  database?: string;
  status: ClickHouseResultStatus;
  queryTime: number;
  rowCount?: number;
  error?: string;
  createdAt: number;
}

export interface ClickHouseRowEntry {
  row: Record<string, unknown>;
  sourceIndex: number;
}

export interface ClickHouseSortState {
  resultId: string;
  column: string;
  direction: 'asc' | 'desc';
}

export interface ClickHouseEditingCell {
  rowIndex: number;
  column: string;
  value: string;
  isNull: boolean;
}

export interface ClickHousePendingEdit {
  resultId: string;
  table: TableInfo;
  rowIndex: number;
  column: string;
  oldValue: unknown;
  newValue: unknown;
  pkColumns: string[];
  pkValues: unknown[];
  error?: string;
}

export type ClickHouseContextMenuTarget =
  | { type: 'database'; database: string }
  | { type: 'table'; database: string; table: ShellDeskClickHouseTable };

export interface ClickHouseContextMenuState {
  x: number;
  y: number;
  target: ClickHouseContextMenuTarget;
}

export interface ClickHouseDatabaseDialogState {
  open: boolean;
  mode: 'create' | 'drop';
  name: string;
  target: string;
  executing: boolean;
  error: string;
}

export interface ChSchemaColumn {
  id: string;
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string;
  comment: string;
  codec: string;
}

export interface ChCreateTableState {
  mode: 'create' | 'edit';
  open: boolean;
  tableName: string;
  engine: string;
  orderByColumns: string[];
  partitionBy: string;
  comment: string;
  columns: ChSchemaColumn[];
  executing: boolean;
  dialogError: string;
  original?: ChCreateTableState;
}

export const defaultHttpPort = 8123;
export const defaultHttpsPort = 8443;
export const pageSize = 100;
export const tablePreviewLimit = 50;
export const maxResultTabs = 10;
export const maxHistoryItems = 12;
export const importEditorTarget = '__sql_editor__';
export const importTargetSeparator = '\u001f';
export const protectedClickHouseDatabases = new Set(['information_schema', 'system']);
export const clickHouseEngines = ['MergeTree()', 'ReplacingMergeTree()', 'SummingMergeTree()', 'AggregatingMergeTree()', 'Log', 'Memory'];
export const clickHouseColumnTypes = [
  'Int8',
  'Int16',
  'Int32',
  'Int64',
  'UInt8',
  'UInt16',
  'UInt32',
  'UInt64',
  'Float32',
  'Float64',
  'String',
  'FixedString(N)',
  'DateTime',
  'Date',
  'DateTime64',
  'UUID',
  'Decimal(P,S)',
  'Array(T)',
  'Map(K,V)',
  'Tuple',
  'JSON',
  'IPv4',
  'IPv6',
  'Enum8',
  'Enum16',
];
export const clickHouseCodecs = ['', 'LZ4', 'ZSTD', 'ZSTD(3)', 'Delta', 'DoubleDelta', 'Gorilla', 'T64'];

export function isProtectedClickHouseDatabase(database: string): boolean {
  return protectedClickHouseDatabases.has(database.trim().toLowerCase());
}

export function createChSchemaColumn(overrides: Partial<ChSchemaColumn> = {}): ChSchemaColumn {
  return {
    id: createId('ch-column'),
    name: '',
    type: 'String',
    nullable: false,
    defaultValue: '',
    comment: '',
    codec: '',
    ...overrides,
  };
}

export function createChCreateTableState(): ChCreateTableState {
  return {
    mode: 'create',
    open: false,
    tableName: '',
    engine: 'MergeTree()',
    orderByColumns: ['id'],
    partitionBy: '',
    comment: '',
    columns: [
      createChSchemaColumn({ name: 'id', type: 'Int32' }),
      createChSchemaColumn({ name: 'name', type: 'String' }),
      createChSchemaColumn({ name: 'created_at', type: 'DateTime', defaultValue: 'now()' }),
    ],
    executing: false,
    dialogError: '',
  };
}

export function validateChCreateTableState(state: ChCreateTableState): string | null {
  const seenColumnNames = new Set<string>();
  for (const column of state.columns) {
    const columnName = column.name.trim();
    if (!columnName) continue;
    const normalizedColumnName = columnName.toLowerCase();
    if (seenColumnNames.has(normalizedColumnName)) {
      return tCurrent('auto.remoteClickHouse.duplicateColumn', { name: columnName });
    }
    seenColumnNames.add(normalizedColumnName);
  }
  return null;
}

export function createQueryTab(index: number, sql = 'SELECT version() AS version;'): ClickHouseQueryTab {
  return {
    id: createId('query'),
    title: tCurrent('clickhouse.query.tabTitle', { index }),
    sql,
    running: false,
  };
}

export function createInitialQueryState(): { tabs: ClickHouseQueryTab[]; activeId: string } {
  const tab = createQueryTab(1);
  return { tabs: [tab], activeId: tab.id };
}

export function quoteClickHouseString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export function quoteClickHouseQualifiedTable(database: string, tableName: string): string {
  const trimmedDatabase = database.trim();
  const trimmedTable = tableName.trim() || 'table_name';

  if (trimmedTable.includes('.')) {
    return trimmedTable
      .split('.')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => quoteIdentifier(part.replace(/^`|`$/gu, '').replace(/``/gu, '`'), 'clickhouse'))
      .join('.');
  }

  return trimmedDatabase
    ? `${quoteIdentifier(trimmedDatabase, 'clickhouse')}.${quoteIdentifier(trimmedTable, 'clickhouse')}`
    : quoteIdentifier(trimmedTable, 'clickhouse');
}

export function buildClickHouseColumnDefinition(column: ChSchemaColumn): string {
  const columnType = column.nullable && !/^Nullable\s*\(/i.test(column.type.trim())
    ? `Nullable(${column.type.trim() || 'String'})`
    : column.type.trim() || 'String';
  const parts = [
    quoteIdentifier(column.name.trim() || 'column_name', 'clickhouse'),
    columnType,
  ];

  if (column.defaultValue.trim()) {
    parts.push('DEFAULT', column.defaultValue.trim());
  }

  if (column.codec.trim()) {
    parts.push(`CODEC(${column.codec.trim()})`);
  }

  if (column.comment.trim()) {
    parts.push('COMMENT', quoteClickHouseString(column.comment.trim()));
  }

  return `  ${parts.join(' ')}`;
}

export function buildClickHouseAlterColumnDefinition(column: ChSchemaColumn): string {
  return buildClickHouseColumnDefinition(column).trim();
}

export function findClickHouseMatchingParen(sql: string, openIndex: number): number {
  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;

  for (let index = openIndex; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];

    if (quote) {
      if (char === '\\' && quote === "'") {
        index += 1;
      } else if (char === quote) {
        if ((quote === "'" && next === "'") || (quote === '`' && next === '`')) {
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

export function splitClickHouseTopLevelList(value: string): string[] {
  const items: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];

    if (quote) {
      if (char === '\\' && quote === "'") {
        index += 1;
      } else if (char === quote) {
        if ((quote === "'" && next === "'") || (quote === '`' && next === '`')) {
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth = Math.max(0, depth - 1);
    } else if (char === ',' && depth === 0) {
      items.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }

  const tail = value.slice(start).trim();
  if (tail) items.push(tail);
  return items;
}

export function unquoteClickHouseIdentifier(identifier: string): string {
  const trimmed = identifier.trim();
  if (trimmed.startsWith('`') && trimmed.endsWith('`')) {
    return trimmed.slice(1, -1).replace(/``/gu, '`');
  }
  return trimmed;
}

export function unquoteClickHouseString(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("'") || !trimmed.endsWith("'")) return trimmed;

  let result = '';
  for (let index = 1; index < trimmed.length - 1; index += 1) {
    const char = trimmed[index];
    const next = trimmed[index + 1];
    if (char === '\\' && next) {
      result += next;
      index += 1;
    } else if (char === "'" && next === "'") {
      result += "'";
      index += 1;
    } else {
      result += char;
    }
  }
  return result;
}

export function findClickHouseTopLevelKeyword(value: string, keyword: string, fromIndex = 0): number {
  const upperValue = value.toUpperCase();
  const upperKeyword = keyword.toUpperCase();
  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;

  for (let index = fromIndex; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];

    if (quote) {
      if (char === '\\' && quote === "'") {
        index += 1;
      } else if (char === quote) {
        if ((quote === "'" && next === "'") || (quote === '`' && next === '`')) {
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') {
      depth += 1;
      continue;
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0 && upperValue.startsWith(upperKeyword, index)) {
      const before = index === 0 ? '' : value[index - 1];
      const after = value[index + keyword.length] ?? '';
      if (!/[a-z0-9_]/iu.test(before) && !/[a-z0-9_]/iu.test(after)) return index;
    }
  }

  return -1;
}

export function extractClickHouseClause(options: string, keyword: string): string {
  const start = findClickHouseTopLevelKeyword(options, keyword);
  if (start < 0) return '';

  const nextKeywords = ['ENGINE', 'ORDER BY', 'PARTITION BY', 'PRIMARY KEY', 'SAMPLE BY', 'TTL', 'COMMENT', 'SETTINGS'];
  const valueStart = start + keyword.length;
  const nextStart = nextKeywords
    .filter((item) => item !== keyword)
    .map((item) => findClickHouseTopLevelKeyword(options, item, valueStart))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0] ?? options.length;

  return options.slice(valueStart, nextStart).replace(/;+$/u, '').trim();
}

export function parseClickHouseIdentifierList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed || /^tuple\s*\(\s*\)$/iu.test(trimmed)) return [];
  const inner = trimmed.startsWith('(') && findClickHouseMatchingParen(trimmed, 0) === trimmed.length - 1
    ? trimmed.slice(1, -1)
    : trimmed;

  return splitClickHouseTopLevelList(inner).map(unquoteClickHouseIdentifier).filter(Boolean);
}

export function parseClickHouseCreateTableColumn(definition: string): ChSchemaColumn | null {
  const match = definition.match(/^(`(?:``|[^`])+`|[a-zA-Z_][\w]*)\s+(.+)$/su);
  if (!match) return null;

  const name = unquoteClickHouseIdentifier(match[1]);
  const body = match[2].trim().replace(/,$/u, '');
  const keywordPositions = ['DEFAULT', 'CODEC', 'COMMENT']
    .map((keyword) => ({ keyword, index: findClickHouseTopLevelKeyword(body, keyword) }))
    .filter((entry) => entry.index >= 0)
    .sort((left, right) => left.index - right.index);
  const typeEnd = keywordPositions[0]?.index ?? body.length;
  let type = body.slice(0, typeEnd).trim();
  let nullable = false;

  const nullableMatch = type.match(/^Nullable\s*\((.*)\)$/isu);
  if (nullableMatch) {
    nullable = true;
    type = nullableMatch[1].trim();
  }

  const getAttribute = (keyword: string): string => {
    const position = keywordPositions.find((entry) => entry.keyword === keyword);
    if (!position) return '';
    const nextPosition = keywordPositions.find((entry) => entry.index > position.index)?.index ?? body.length;
    return body.slice(position.index + keyword.length, nextPosition).trim();
  };

  const codecValue = getAttribute('CODEC');
  const codec = codecValue.startsWith('(') && findClickHouseMatchingParen(codecValue, 0) === codecValue.length - 1
    ? codecValue.slice(1, -1).trim()
    : codecValue;

  return createChSchemaColumn({
    name,
    type: type || 'String',
    nullable,
    defaultValue: getAttribute('DEFAULT'),
    codec,
    comment: unquoteClickHouseString(getAttribute('COMMENT')),
  });
}

export function parseClickHouseCreateTableSql(sql: string): ChCreateTableState {
  const createMatch = sql.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\s\S]+?)\s*\(/iu);
  const openIndex = createMatch ? sql.indexOf('(', createMatch.index) : -1;
  const closeIndex = openIndex >= 0 ? findClickHouseMatchingParen(sql, openIndex) : -1;
  if (!createMatch || openIndex < 0 || closeIndex <= openIndex) {
    throw new Error('parse table structure error');
  }

  const rawTableName = createMatch[1].replace(/\s+ON\s+CLUSTER\s+.+$/iu, '').trim();
  const tableName = rawTableName
    .split('.')
    .map(unquoteClickHouseIdentifier)
    .filter(Boolean)
    .join('.');
  const columns = splitClickHouseTopLevelList(sql.slice(openIndex + 1, closeIndex))
    .map((definition) => parseClickHouseCreateTableColumn(definition.trim()))
    .filter((column): column is ChSchemaColumn => Boolean(column));
  const options = sql.slice(closeIndex + 1);
  const engine = extractClickHouseClause(options, 'ENGINE').replace(/^=\s*/u, '').trim() || 'MergeTree()';
  const orderByColumns = parseClickHouseIdentifierList(extractClickHouseClause(options, 'ORDER BY'));
  const partitionBy = extractClickHouseClause(options, 'PARTITION BY');
  const comment = unquoteClickHouseString(extractClickHouseClause(options, 'COMMENT'));

  return {
    ...createChCreateTableState(),
    mode: 'edit',
    tableName,
    engine,
    orderByColumns,
    partitionBy,
    comment,
    columns,
  };
}

export function normalizeClickHouseSchemaValue(value: string): string {
  return value.trim().replace(/\s+/gu, ' ');
}

export function areClickHouseColumnsEqual(left: ChSchemaColumn, right: ChSchemaColumn): boolean {
  return left.name.trim() === right.name.trim()
    && normalizeClickHouseSchemaValue(left.type) === normalizeClickHouseSchemaValue(right.type)
    && left.nullable === right.nullable
    && normalizeClickHouseSchemaValue(left.defaultValue) === normalizeClickHouseSchemaValue(right.defaultValue)
    && normalizeClickHouseSchemaValue(left.codec) === normalizeClickHouseSchemaValue(right.codec)
    && left.comment.trim() === right.comment.trim();
}

export function generateClickHouseAlterStatements(original: ChCreateTableState, modified: ChCreateTableState): string[] {
  const tableName = quoteClickHouseQualifiedTable('', modified.tableName || original.tableName);
  const originalColumns = new Map(original.columns.map((column) => [column.id, column]));
  const modifiedColumns = new Map(modified.columns.map((column) => [column.id, column]));
  const renamedColumns = new Map<string, string>();
  const statements: string[] = [];

  original.columns.forEach((column) => {
    const originalName = column.name.trim();
    const modifiedColumn = modifiedColumns.get(column.id);
    const modifiedName = modifiedColumn?.name.trim() ?? '';
    if (!originalName) return;

    if (!modifiedColumn || !modifiedName) {
      statements.push(`ALTER TABLE ${tableName} DROP COLUMN ${quoteIdentifier(originalName, 'clickhouse')};`);
      return;
    }

    if (originalName !== modifiedName) {
      renamedColumns.set(originalName.toLowerCase(), modifiedName);
      statements.push(`ALTER TABLE ${tableName} RENAME COLUMN ${quoteIdentifier(originalName, 'clickhouse')} TO ${quoteIdentifier(modifiedName, 'clickhouse')};`);
    }
  });

  modified.columns.forEach((column) => {
    const columnName = column.name.trim();
    if (!columnName) return;
    const originalColumn = originalColumns.get(column.id);
    if (!originalColumn) {
      statements.push(`ALTER TABLE ${tableName} ADD COLUMN ${buildClickHouseAlterColumnDefinition(column)};`);
    } else if (!areClickHouseColumnsEqual({ ...originalColumn, name: column.name }, column)) {
      statements.push(`ALTER TABLE ${tableName} MODIFY COLUMN ${buildClickHouseAlterColumnDefinition(column)};`);
    }
  });

  const normalizeRenamedColumnName = (column: string) => {
    const trimmed = column.trim();
    return renamedColumns.get(trimmed.toLowerCase()) ?? trimmed;
  };
  const originalOrderBy = original.orderByColumns.map(normalizeRenamedColumnName).filter(Boolean);
  const modifiedOrderBy = modified.orderByColumns.map((column) => column.trim()).filter(Boolean);
  if (originalOrderBy.join('\n') !== modifiedOrderBy.join('\n')) {
    const expression = modifiedOrderBy.length > 0
      ? `(${modifiedOrderBy.map((column) => quoteIdentifier(column, 'clickhouse')).join(', ')})`
      : 'tuple()';
    statements.push(`ALTER TABLE ${tableName} MODIFY ORDER BY ${expression};`);
  }

  if (original.comment.trim() !== modified.comment.trim()) {
    statements.push(`ALTER TABLE ${tableName} MODIFY COMMENT ${quoteClickHouseString(modified.comment.trim())};`);
  }

  return statements;
}

export function generateClickHouseCreateTableSql(state: ChCreateTableState, database: string): string {
  const columnDefinitions = state.columns.map(buildClickHouseColumnDefinition);
  const availableColumns = new Set(state.columns.map((column) => column.name.trim()).filter(Boolean));
  const orderByColumns = state.orderByColumns.filter((column) => availableColumns.has(column));
  const tableOptions = [
    `ENGINE = ${state.engine || 'MergeTree()'}`,
    `ORDER BY (${orderByColumns.map((column) => quoteIdentifier(column, 'clickhouse')).join(', ') || 'tuple()'})`,
  ];

  if (state.partitionBy.trim()) {
    tableOptions.push(`PARTITION BY ${state.partitionBy.trim()}`);
  }

  if (state.comment.trim()) {
    tableOptions.push(`COMMENT ${quoteClickHouseString(state.comment.trim())}`);
  }

  return [
    `CREATE TABLE ${quoteClickHouseQualifiedTable(database, state.tableName)} (`,
    columnDefinitions.join(',\n'),
    ')',
    ...tableOptions,
    ';',
  ].join('\n');
}

export function toClickHouseLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return quoteClickHouseString(String(value));
}

export function parseImportCsv(text: string) {
  return parseDatabaseImportCsv(text, tCurrent('auto.remoteClickHouse.importCsvUnclosedQuote'));
}

export function parseImportJson(text: string) {
  return parseDatabaseImportJson(text, {
    mustBeArray: tCurrent('auto.remoteClickHouse.importJsonMustBeArray'),
    itemsMustBeObjects: tCurrent('auto.remoteClickHouse.importJsonItemsMustBeObjects'),
  });
}

export function quoteClickHouseImportValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'object') return quoteClickHouseString(JSON.stringify(value));
  return quoteClickHouseString(String(value));
}

export function buildClickHouseInsertSql(database: string, table: string, columns: string[], rows: Record<string, unknown>[]): string {
  const tableIdentifier = quoteClickHouseQualifiedTable(database, table);
  const columnSql = columns.map((column) => quoteIdentifier(column, 'clickhouse')).join(', ');
  const valuesSql = rows
    .map((row) => `(${columns.map((column) => (
      quoteClickHouseImportValue(readDatabaseImportValue(row, column))
    )).join(', ')})`)
    .join(', ');
  return `INSERT INTO ${tableIdentifier} (${columnSql}) FORMAT Values ${valuesSql};`;
}

export function encodeImportTarget(database: string, table: string): string {
  return `${database}${importTargetSeparator}${table}`;
}

export function decodeImportTarget(value: string): { database: string; table: string } | null {
  const separatorIndex = value.indexOf(importTargetSeparator);
  if (separatorIndex < 0) return null;
  const database = value.slice(0, separatorIndex);
  const table = value.slice(separatorIndex + importTargetSeparator.length);
  return database && table ? { database, table } : null;
}

export function valuesEqual(left: unknown, right: unknown): boolean {
  if (left === null || left === undefined) return right === null || right === undefined;
  if (right === null || right === undefined) return false;
  return String(left) === String(right);
}

export function createExplainSql(sqlText: string): string {
  const statement = sqlText.trim().replace(/;+\s*$/, '');

  if (/^explain\b/i.test(statement)) {
    return statement;
  }

  return `EXPLAIN ${statement}`;
}

export function formatCount(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  return new Intl.NumberFormat(getShellDeskLocale()).format(value);
}

export function formatBytes(value: number | null | undefined): string {
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

export function getColumnMeta(columns: ShellDeskClickHouseColumn[], name: string): ShellDeskClickHouseColumn | undefined {
  return columns.find((column) => column.name === name);
}

export function getColumnBadge(column?: ShellDeskClickHouseColumn): string {
  if (!column) return '';
  if (column.isPrimaryKey) return 'PK';
  if (column.isSortingKey) return 'SORT';
  return '';
}

export function describeResult(result: ShellDeskClickHouseQueryResult): string {
  if (result.columns.length === 0) return tCurrent('clickhouse.query.executed');
  return tCurrent('clickhouse.query.rows', { count: formatCount(result.rowCount ?? result.rows.length) });
}

export function describeStatistics(statistics?: ShellDeskClickHouseQueryStatistics): string {
  if (!statistics) return '';
  const parts = [
    statistics.rowsRead ? tCurrent('clickhouse.query.rowsRead', { count: formatCount(statistics.rowsRead) }) : '',
    statistics.bytesRead ? formatBytes(statistics.bytesRead) : '',
  ].filter(Boolean);

  return parts.join(' · ');
}

export function compareClickHouseCellValues(left: unknown, right: unknown): number {
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
