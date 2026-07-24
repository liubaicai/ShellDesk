import { getShellDeskLocale } from './desktopUtils';
import { parseDatabaseImportCsv, parseDatabaseImportJson } from './databaseImportUtils';
import { createId, quoteIdentifier } from './databaseUtils';
import { tCurrent } from '../../i18n';

export interface RemotePostgresProps {
  connectionId: string;
  hostId: string;
}

export type PostgresStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export type PostgresMessageType = 'info' | 'success' | 'error';
export type PostgresResultStatus = 'success' | 'error';

export interface TableInfo {
  schema: string;
  name: string;
  type: string;
}

export interface PostgresMessage {
  type: PostgresMessageType;
  text: string;
}

export interface PostgresQueryTab {
  id: string;
  title: string;
  sql: string;
  running: boolean;
}

export interface PostgresResultTab {
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

export interface PostgresHistoryItem {
  id: string;
  sql: string;
  status: PostgresResultStatus;
  queryTime: number;
  rowCount?: number;
  error?: string;
  createdAt: number;
}

export interface PostgresSortState {
  resultId: string;
  column: string;
  direction: 'asc' | 'desc';
}

export interface PostgresRowEntry {
  row: Record<string, unknown>;
  index: number;
}

export interface EditingCell {
  rowIndex: number;
  column: string;
  value: string;
  isNull: boolean;
}

export interface PendingEdit {
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

export type PostgresContextMenuTarget =
  | { type: 'database'; database: string }
  | { type: 'table'; table: ShellDeskPostgresTable };

export interface PostgresContextMenuState {
  x: number;
  y: number;
  target: PostgresContextMenuTarget;
}

export interface PgSchemaColumn {
  id: string;
  name: string;
  type: string;
  length: string;
  nullable: boolean;
  defaultValue: string;
  comment: string;
}

export interface PgSchemaIndex {
  id: string;
  type: 'INDEX' | 'UNIQUE';
  columns: string[];
  name: string;
}

export interface PgSchemaForeignKey {
  id: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
  onDelete: string;
  onUpdate: string;
}

export interface PgCreateTableState {
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
  dialogError: string;
}

export interface ImportDataState {
  open: boolean;
  mode: 'csv' | 'json';
  targetTable: string;
  csvText: string;
  jsonText: string;
  preview: Record<string, string>[];
  columns: string[];
  executing: boolean;
  progress: { current: number; total: number } | null;
  error: string;
}

export const tablePreviewLimit = 50;
export const pageSize = 100;
export const maxHistoryItems = 12;
export const maxResultTabs = 10;
export const defaultPort = 5432;
export const postgresColumnTypes = [
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
export const postgresTypesWithoutLength = new Set([
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
export const postgresForeignKeyActions = ['RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION'];
export const importEditorTarget = '__sql_editor__';

export function getShellDeskEditorTheme(): 'light' | 'dark' {
  if (typeof document === 'undefined') {
    return 'dark';
  }

  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

export function createQueryTab(index: number, sqlText = 'SELECT current_database(), now();'): PostgresQueryTab {
  return {
    id: createId('pg-query'),
    title: `查询 ${index}`,
    sql: sqlText,
    running: false,
  };
}

export function createInitialQueryState(): { tabs: PostgresQueryTab[]; activeId: string } {
  const tab = createQueryTab(1);
  return { tabs: [tab], activeId: tab.id };
}

export function quotePgString(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

export function parseImportCsv(text: string) {
  return parseDatabaseImportCsv(text, tCurrent('auto.remotePostgres.importCsvUnclosedQuote'));
}

export function parseImportJson(text: string) {
  return parseDatabaseImportJson(text, {
    mustBeArray: tCurrent('auto.remotePostgres.importJsonMustBeArray'),
    itemsMustBeObjects: tCurrent('auto.remotePostgres.importJsonItemsMustBeObjects'),
  });
}

export function quotePgImportValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'object') return quotePgString(JSON.stringify(value));
  return quotePgString(String(value));
}

export function buildPgInsertSql(schema: string, table: string, columns: string[], rows: Record<string, unknown>[]): string {
  const tableIdentifier = `${quoteIdentifier(schema || 'public', 'postgres')}.${quoteIdentifier(table, 'postgres')}`;
  const columnSql = columns.map((column) => quoteIdentifier(column, 'postgres')).join(', ');
  const valuesSql = rows
    .map((row) => `(${columns.map((column) => quotePgImportValue(row[column])).join(', ')})`)
    .join(', ');
  return `INSERT INTO ${tableIdentifier} (${columnSql}) VALUES ${valuesSql};`;
}

export function createPgSchemaColumn(): PgSchemaColumn {
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

export function createPgSchemaIndex(): PgSchemaIndex {
  return {
    id: createId('pg-index'),
    type: 'INDEX',
    columns: [],
    name: '',
  };
}

export function createPgSchemaForeignKey(): PgSchemaForeignKey {
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

export function quotePgDefaultValue(value: string): string {
  const trimmed = value.trim();

  if (!trimmed) return '';
  if (/^null$/i.test(trimmed)) return 'NULL';
  if (/^(current_timestamp|current_date|current_time)(\(\))?$/i.test(trimmed)) return trimmed;
  if (/^(uuid_generate_v4|gen_random_uuid|now)\(\)$/i.test(trimmed)) return trimmed;
  if (/^-?\d+(\.\d+)?$/u.test(trimmed)) return trimmed;
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toUpperCase();

  return quotePgString(trimmed);
}

export function sanitizePgColumnLength(type: string, length: string): string {
  const normalizedType = type.toUpperCase();
  const trimmed = length.trim();

  if (!trimmed || postgresTypesWithoutLength.has(normalizedType)) return '';
  return trimmed.replace(/[^\d,]/gu, '').replace(/,+/gu, ',').replace(/^,|,$/gu, '');
}

export function quotePgQualifiedIdentifier(schema: string, name: string): string {
  return `${quoteIdentifier(schema || 'public', 'postgres')}.${quoteIdentifier(name || 'table_name', 'postgres')}`;
}

export function buildPgColumnDefinition(column: PgSchemaColumn, primaryKeyColumns: string[]): string {
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

export function buildPgIndexName(index: PgSchemaIndex, tableName: string): string {
  if (index.name.trim()) return index.name.trim();
  const suffix = index.columns.join('_') || index.id.replace(/^pg-index[-_]?/iu, '');
  return `${index.type === 'UNIQUE' ? 'uniq' : 'idx'}_${tableName}_${suffix}`.replace(/[^a-zA-Z0-9_]/gu, '_').slice(0, 63);
}

export function generateCreateTableStatements(state: PgCreateTableState): string[] {
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

export function generateCreateTableSql(state: PgCreateTableState): string {
  return generateCreateTableStatements(state).join('\n');
}

export function validateCreateTableState(state: PgCreateTableState): string | null {
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

export function translateForeignKeyAction(action: string): string {
  return action;
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

export function describeResult(result: ShellDeskPostgresQueryResult): string {
  if (result.columns.length === 0) return `已执行${result.rowCount !== undefined ? ` · ${result.rowCount} 行受影响` : ''}`;
  return `${result.rowCount ?? result.rows.length} 行`;
}

export function comparePostgresCellValues(left: unknown, right: unknown): number {
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

export function serializeImportTarget(table: TableInfo): string {
  return JSON.stringify({ schema: table.schema, name: table.name, type: table.type });
}

export function parseImportTarget(value: string): TableInfo | null {
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

export function formatImportTarget(table: TableInfo | null): string {
  return table ? `${table.schema}.${table.name}` : '';
}
