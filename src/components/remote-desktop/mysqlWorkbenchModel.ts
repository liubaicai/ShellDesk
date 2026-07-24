import { getShellDeskLocale } from './desktopUtils';
import {
  type DatabaseImportState,
  parseDatabaseImportCsv,
  parseDatabaseImportJson,
} from './databaseImportUtils';
import { createId, quoteIdentifier } from './databaseUtils';
import { tCurrent } from '../../i18n';

export interface RemoteMySQLProps {
  connectionId: string;
  hostId: string;
}

export interface MysqlConnectionForm {
  host: string;
  port: string;
  user: string;
  password: string;
  initialDatabase: string;
}

export type MysqlStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export type MysqlMessageType = 'info' | 'success' | 'error';
export type MysqlResultStatus = 'success' | 'error';

export interface TableInfo {
  database: string;
  name: string;
}

export interface MysqlMessage {
  type: MysqlMessageType;
  text: string;
}

export interface MysqlQueryTab {
  id: string;
  title: string;
  sql: string;
  running: boolean;
}

export interface MysqlResultTab {
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

export interface MysqlHistoryItem {
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

export interface MysqlSortState {
  resultId: string;
  column: string;
  direction: 'asc' | 'desc';
}

export interface MysqlRowEntry {
  row: Record<string, unknown>;
  index: number;
}

export type MysqlContextMenuTarget =
  | { type: 'database'; database: string }
  | { type: 'table'; database: string; table: string };

export interface MysqlContextMenuState {
  x: number;
  y: number;
  target: MysqlContextMenuTarget;
}

export interface SchemaColumn {
  id: string;
  name: string;
  type: string;
  length: string;
  nullable: boolean;
  defaultValue: string;
  autoIncrement: boolean;
  comment: string;
}

export interface SchemaIndex {
  id: string;
  type: 'INDEX' | 'UNIQUE' | 'FULLTEXT' | 'SPATIAL';
  columns: string[];
  name: string;
}

export interface SchemaForeignKey {
  id: string;
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete: string;
  onUpdate: string;
}

export type CreateTableMode = 'create' | 'edit';

export interface CreateTableSnapshot {
  mode: CreateTableMode;
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
}

export interface CreateTableState extends CreateTableSnapshot {
  open: boolean;
  executing: boolean;
  dialogError: string;
  original?: CreateTableSnapshot;
}

export interface DatabaseDialogState {
  open: boolean;
  mode: 'create' | 'drop';
  name: string;
  target: string;
  executing: boolean;
  error: string;
}

export type ImportDataState = DatabaseImportState;

export type MysqlContextMenuAction = 'database-info' | 'create-table' | 'drop-database' | 'query-table' | 'table-structure' | 'edit-table';

export const defaultPort = 3306;
export const pageSize = 100;
export const tablePreviewLimit = 50;
export const maxResultTabs = 10;
export const maxHistoryItems = 12;
export const mysqlColumnTypes = ['INT', 'BIGINT', 'VARCHAR', 'TEXT', 'BOOLEAN', 'DATE', 'DATETIME', 'TIMESTAMP', 'FLOAT', 'DOUBLE', 'DECIMAL', 'BLOB', 'JSON', 'ENUM'];
export const mysqlEngines = ['InnoDB', 'MyISAM', 'MEMORY', 'CSV', 'ARCHIVE'];
export const mysqlCharsets = ['utf8mb4', 'utf8', 'utf8mb3', 'latin1', 'ascii', 'utf16', 'utf32'];
export const mysqlForeignKeyActions = ['RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION'];
export const mysqlIntegerTypes = new Set(['INT', 'BIGINT', 'SMALLINT', 'TINYINT', 'MEDIUMINT']);
export const mysqlTypesWithoutLength = new Set(['DATE', 'DATETIME', 'TIMESTAMP', 'TEXT', 'BOOLEAN', 'JSON', 'BLOB']);
export const importEditorTarget = '__sql_editor__';
export const protectedMysqlDatabases = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

export function isProtectedMysqlDatabase(database: string): boolean {
  return protectedMysqlDatabases.has(database.trim().toLowerCase());
}

export function createSchemaColumn(): SchemaColumn {
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

export function createSchemaIndex(): SchemaIndex {
  return {
    id: createId('index'),
    type: 'INDEX',
    columns: [],
    name: '',
  };
}

export function createSchemaForeignKey(): SchemaForeignKey {
  return {
    id: createId('fk'),
    name: '',
    columns: [],
    refTable: '',
    refColumns: [],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  };
}

export function quoteMysqlDefaultValue(value: string): string {
  const trimmed = value.trim();

  if (!trimmed) return '';
  if (/^null$/i.test(trimmed)) return 'NULL';
  if (/^(current_timestamp|current_date|current_time)(\(\))?$/i.test(trimmed)) return trimmed;
  if (/^(uuid|now)\(\)$/i.test(trimmed)) return trimmed;
  if (/^-?\d+(\.\d+)?$/u.test(trimmed)) return trimmed;

  return quoteMysqlString(trimmed);
}

export function isMysqlEnumValueList(value: string): boolean {
  const quotedValue = String.raw`'(?:''|\\.|[^'\\])*'`;
  return new RegExp(`^${quotedValue}(?:\\s*,\\s*${quotedValue})*$`, 'u').test(value.trim());
}

export function sanitizeMysqlColumnLength(type: string, length: string): string {
  const normalizedType = type.toUpperCase();
  const trimmed = length.trim();

  if (!trimmed || mysqlTypesWithoutLength.has(normalizedType)) return '';
  if (normalizedType === 'ENUM' && isMysqlEnumValueList(trimmed)) return trimmed;

  return trimmed.replace(/[^\d,]/gu, '').replace(/,+/gu, ',').replace(/^,|,$/gu, '');
}

export function quoteMysqlQualifiedIdentifier(identifier: string): string {
  const parts = identifier.trim().split('.').map((part) => part.trim()).filter(Boolean);
  return parts.length > 1
    ? parts.map((part) => quoteIdentifier(part, 'mysql')).join('.')
    : quoteIdentifier(identifier.trim(), 'mysql');
}

export function getForeignKeyConstraintName(foreignKey: SchemaForeignKey): string {
  if (foreignKey.name.trim()) return foreignKey.name.trim();
  const suffix = foreignKey.id.replace(/^fk[-_]?/iu, '').replace(/[^a-z0-9_]/giu, '_').slice(0, 61);
  return `fk_${suffix || Math.random().toString(36).slice(2, 8)}`;
}

export function buildMysqlColumnDefinition(column: SchemaColumn): string {
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

  return parts.join(' ');
}

export function buildMysqlIndexDefinition(index: SchemaIndex, columns: SchemaColumn[]): string | null {
  const indexColumns = index.columns.filter((column) => columns.some((item) => item.name.trim() === column));
  if (indexColumns.length === 0) return null;

  const name = index.name.trim() ? ` ${quoteIdentifier(index.name.trim(), 'mysql')}` : '';
  return `${index.type}${name} (${indexColumns.map((column) => quoteIdentifier(column, 'mysql')).join(', ')})`;
}

export function buildMysqlForeignKeyDefinition(foreignKey: SchemaForeignKey, columns: SchemaColumn[]): string | null {
  const keyColumns = foreignKey.columns.filter((column) => columns.some((item) => item.name.trim() === column));
  const refColumns = foreignKey.refColumns.filter((column) => column.trim());
  if (keyColumns.length === 0 || !foreignKey.refTable.trim() || refColumns.length === 0) return null;

  const constraintName = quoteIdentifier(getForeignKeyConstraintName(foreignKey), 'mysql');
  const parts = [
    `CONSTRAINT ${constraintName} FOREIGN KEY (${keyColumns.map((column) => quoteIdentifier(column, 'mysql')).join(', ')})`,
    `REFERENCES ${quoteMysqlQualifiedIdentifier(foreignKey.refTable)} (${refColumns.map((column) => quoteIdentifier(column.trim(), 'mysql')).join(', ')})`,
  ];

  if (foreignKey.onDelete) {
    parts.push(`ON DELETE ${foreignKey.onDelete}`);
  }
  if (foreignKey.onUpdate) {
    parts.push(`ON UPDATE ${foreignKey.onUpdate}`);
  }

  return parts.join(' ');
}

export function validateCreateTableState(state: CreateTableState): string | null {
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

export function generateCreateTableSql(state: CreateTableState): string {
  const tableName = state.tableName.trim();
  const databaseName = state.database.trim();
  const qualifiedTableName = databaseName
    ? `${quoteIdentifier(databaseName, 'mysql')}.${quoteIdentifier(tableName || 'table_name', 'mysql')}`
    : quoteIdentifier(tableName || 'table_name', 'mysql');
  const definitions: string[] = state.columns
    .filter((column) => column.name.trim())
    .map((column) => `  ${buildMysqlColumnDefinition(column)}`);
  const primaryKeyColumns = state.primaryKeyColumns.filter((column) => state.columns.some((item) => item.name.trim() === column));

  if (primaryKeyColumns.length > 0) {
    definitions.push(`  PRIMARY KEY (${primaryKeyColumns.map((column) => quoteIdentifier(column, 'mysql')).join(', ')})`);
  }

  state.indexes.forEach((index) => {
    const definition = buildMysqlIndexDefinition(index, state.columns);
    if (definition) definitions.push(`  ${definition}`);
  });

  state.foreignKeys.forEach((foreignKey) => {
    const definition = buildMysqlForeignKeyDefinition(foreignKey, state.columns);
    if (definition) definitions.push(`  ${definition}`);
  });

  const options = [`ENGINE=${state.engine || 'InnoDB'}`];
  if (state.charset) {
    options.push(`DEFAULT CHARSET=${state.charset}`);
  }
  if (state.comment.trim()) {
    options.push(`COMMENT=${quoteMysqlString(state.comment.trim())}`);
  }

  return [
    `CREATE TABLE ${qualifiedTableName} (`,
    definitions.length > 0 ? definitions.join(',\n') : '  `id` INT NOT NULL',
    `) ${options.join(' ')};`,
  ].join('\n');
}

export function splitMysqlTopLevelList(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let quote: "'" | '"' | '`' | null = null;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const previous = value[index - 1];

    if (quote) {
      current += char;
      if (char === quote && previous !== '\\') {
        if (quote !== "'" || value[index + 1] !== "'") {
          quote = null;
        } else {
          current += value[index + 1];
          index += 1;
        }
      }
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      current += char;
      continue;
    }
    if (char === '(') {
      depth += 1;
      current += char;
      continue;
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }
    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }

  if (current.trim()) parts.push(current.trim());
  return parts;
}

export function unquoteMysqlIdentifier(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('`') && trimmed.endsWith('`')) {
    return trimmed.slice(1, -1).replace(/``/gu, '`');
  }
  return trimmed;
}

export function unquoteMysqlString(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/gu, "'").replace(/\\'/gu, "'");
  }
  return trimmed;
}

export function parseMysqlIdentifierList(value: string): string[] {
  return splitMysqlTopLevelList(value)
    .map((item) => item.trim().match(/^`((?:``|[^`])+)`/u)?.[0] ?? item.trim().split(/\s+/u)[0])
    .map(unquoteMysqlIdentifier)
    .filter(Boolean);
}

export function findMysqlMatchingParen(value: string, openIndex: number): number {
  let depth = 0;
  let quote: "'" | '"' | '`' | null = null;

  for (let index = openIndex; index < value.length; index += 1) {
    const char = value[index];
    const previous = value[index - 1];

    if (quote) {
      if (char === quote && previous !== '\\') {
        if (quote !== "'" || value[index + 1] !== "'") {
          quote = null;
        } else {
          index += 1;
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
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

export function splitMysqlColumnType(body: string): { type: string; length: string; attributes: string } | null {
  const typeMatch = body.match(/^([a-zA-Z0-9_]+)/u);
  if (!typeMatch) return null;

  const type = typeMatch[1].toUpperCase();
  const afterType = body.slice(typeMatch[0].length).trimStart();
  if (!afterType.startsWith('(')) {
    return { type, length: '', attributes: afterType };
  }

  const offset = body.length - afterType.length;
  const closeIndex = findMysqlMatchingParen(body, offset);
  if (closeIndex < 0) {
    return { type, length: '', attributes: afterType };
  }

  return {
    type,
    length: body.slice(offset + 1, closeIndex),
    attributes: body.slice(closeIndex + 1).trim(),
  };
}

export function parseCreateTableColumn(definition: string): SchemaColumn | null {
  const match = definition.match(/^`((?:``|[^`])+)`\s+(.+)$/u);
  if (!match) return null;

  const name = unquoteMysqlIdentifier(`\`${match[1]}\``);
  const body = match[2].trim();
  const parsedType = splitMysqlColumnType(body);
  if (!parsedType) return null;

  const { type, length, attributes } = parsedType;
  const defaultMatch = attributes.match(/\bDEFAULT\s+((?:'(?:''|\\.|[^'\\])*')|(?:[^\s,]+))/iu);
  const commentMatch = attributes.match(/\bCOMMENT\s+('(?:''|\\.|[^'\\])*')/iu);

  return {
    id: createId('column'),
    name,
    type,
    length,
    nullable: !/\bNOT\s+NULL\b/iu.test(attributes),
    defaultValue: defaultMatch ? unquoteMysqlString(defaultMatch[1]) : '',
    autoIncrement: /\bAUTO_INCREMENT\b/iu.test(attributes),
    comment: commentMatch ? unquoteMysqlString(commentMatch[1]) : '',
  };
}

export function parseCreateTableSql(sql: string): CreateTableState {
  const tableNameMatch = sql.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:`[^`]+`\.)?(`(?:``|[^`])+`|[^\s(]+)\s*\(/iu);
  const tableName = tableNameMatch ? unquoteMysqlIdentifier(tableNameMatch[1]) : '';
  const openIndex = sql.indexOf('(');
  const closeIndex = openIndex >= 0 ? findMysqlMatchingParen(sql, openIndex) : -1;
  if (openIndex < 0 || closeIndex <= openIndex) {
    throw new Error('parse table structure error');
  }

  const definitions = splitMysqlTopLevelList(sql.slice(openIndex + 1, closeIndex));
  const options = sql.slice(closeIndex + 1);
  const engine = options.match(/\bENGINE\s*=\s*([^\s;]+)/iu)?.[1] ?? 'InnoDB';
  const charset = options.match(/\bDEFAULT\s+CHARSET\s*=\s*([^\s;]+)/iu)?.[1] ?? options.match(/\bCHARSET\s*=\s*([^\s;]+)/iu)?.[1] ?? '';
  const comment = options.match(/\bCOMMENT\s*=\s*('(?:''|\\.|[^'\\])*')/iu)?.[1] ?? '';
  const columns: SchemaColumn[] = [];
  const primaryKeyColumns: string[] = [];
  const indexes: SchemaIndex[] = [];
  const foreignKeys: SchemaForeignKey[] = [];

  definitions.forEach((definition) => {
    const trimmed = definition.trim();
    if (trimmed.startsWith('`')) {
      const column = parseCreateTableColumn(trimmed);
      if (column) columns.push(column);
      return;
    }

    const primaryMatch = trimmed.match(/^PRIMARY\s+KEY\s*(?:`[^`]+`)?\s*\((.+)\)$/iu);
    if (primaryMatch) {
      primaryKeyColumns.push(...parseMysqlIdentifierList(primaryMatch[1]));
      return;
    }

    const foreignMatch = trimmed.match(/^(?:CONSTRAINT\s+(`(?:``|[^`])+`|\S+)\s+)?FOREIGN\s+KEY\s*\((.+?)\)\s+REFERENCES\s+((?:`(?:``|[^`])+`|\w+)(?:\.(?:`(?:``|[^`])+`|\w+))?)\s*\((.+?)\)(.*)$/iu);
    if (foreignMatch) {
      const tail = foreignMatch[5] ?? '';
      foreignKeys.push({
        id: createId('fk'),
        name: foreignMatch[1] ? unquoteMysqlIdentifier(foreignMatch[1]) : '',
        columns: parseMysqlIdentifierList(foreignMatch[2]),
        refTable: foreignMatch[3].split('.').map(unquoteMysqlIdentifier).join('.'),
        refColumns: parseMysqlIdentifierList(foreignMatch[4]),
        onDelete: tail.match(/\bON\s+DELETE\s+(RESTRICT|CASCADE|SET\s+NULL|NO\s+ACTION)\b/iu)?.[1].toUpperCase().replace(/\s+/gu, ' ') ?? 'RESTRICT',
        onUpdate: tail.match(/\bON\s+UPDATE\s+(RESTRICT|CASCADE|SET\s+NULL|NO\s+ACTION)\b/iu)?.[1].toUpperCase().replace(/\s+/gu, ' ') ?? 'RESTRICT',
      });
      return;
    }

    const indexMatch = trimmed.match(/^(UNIQUE|FULLTEXT|SPATIAL)?\s*(?:KEY|INDEX)\s+(`(?:``|[^`])+`|\S+)?\s*\((.+)\)$/iu);
    if (indexMatch) {
      indexes.push({
        id: createId('index'),
        type: (indexMatch[1]?.toUpperCase() as SchemaIndex['type'] | undefined) ?? 'INDEX',
        name: indexMatch[2] ? unquoteMysqlIdentifier(indexMatch[2]) : '',
        columns: parseMysqlIdentifierList(indexMatch[3]),
      });
    }
  });

  return {
    mode: 'edit',
    open: false,
    database: '',
    tableName,
    engine,
    charset,
    comment: comment ? unquoteMysqlString(comment) : '',
    columns,
    primaryKeyColumns,
    indexes,
    foreignKeys,
    showAdvanced: true,
    executing: false,
    dialogError: '',
  };
}

export function normalizeSchemaColumn(column: SchemaColumn) {
  return {
    name: column.name.trim(),
    type: column.type.toUpperCase(),
    length: sanitizeMysqlColumnLength(column.type, column.length),
    nullable: column.nullable,
    defaultValue: column.defaultValue.trim(),
    autoIncrement: column.autoIncrement,
    comment: column.comment.trim(),
  };
}

export function normalizeSchemaIndex(index: SchemaIndex, normalizeColumnName: (column: string) => string = (column) => column) {
  return {
    type: index.type,
    name: index.name.trim(),
    columns: index.columns.map(normalizeColumnName),
  };
}

export function normalizeSchemaForeignKey(foreignKey: SchemaForeignKey, normalizeColumnName: (column: string) => string = (column) => column) {
  return {
    name: getForeignKeyConstraintName(foreignKey),
    columns: foreignKey.columns.map(normalizeColumnName),
    refTable: foreignKey.refTable.trim(),
    refColumns: foreignKey.refColumns,
    onDelete: foreignKey.onDelete,
    onUpdate: foreignKey.onUpdate,
  };
}

export function isSchemaEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function generateAlterTableStatements(original: CreateTableSnapshot, modified: CreateTableState): string[] {
  const tableName = quoteIdentifier(original.tableName.trim() || modified.tableName.trim() || 'table_name', 'mysql');
  const statements: string[] = [];
  const originalColumns = new Map(original.columns.map((column) => [column.id, column]));
  const modifiedColumns = new Map(modified.columns.map((column) => [column.id, column]));
  const renamedColumns = new Map<string, string>();
  const trimColumnName = (column: string) => column.trim();
  const normalizeRenamedColumnName = (column: string) => {
    const trimmed = column.trim();
    return renamedColumns.get(trimmed.toLowerCase()) ?? trimmed;
  };

  original.columns.forEach((column) => {
    const modifiedColumn = modifiedColumns.get(column.id);
    if (!modifiedColumn || !modifiedColumn.name.trim()) {
      statements.push(`ALTER TABLE ${tableName} DROP COLUMN ${quoteIdentifier(column.name.trim(), 'mysql')};`);
    }
  });

  modified.columns.filter((column) => column.name.trim()).forEach((column) => {
    const originalColumn = originalColumns.get(column.id);
    if (!originalColumn) {
      statements.push(`ALTER TABLE ${tableName} ADD COLUMN ${buildMysqlColumnDefinition(column)};`);
      return;
    }
    if (originalColumn.name.trim() !== column.name.trim()) {
      renamedColumns.set(originalColumn.name.trim().toLowerCase(), column.name.trim());
      statements.push(`ALTER TABLE ${tableName} CHANGE COLUMN ${quoteIdentifier(originalColumn.name.trim(), 'mysql')} ${buildMysqlColumnDefinition(column)};`);
      return;
    }
    if (!isSchemaEqual(normalizeSchemaColumn(originalColumn), normalizeSchemaColumn(column))) {
      statements.push(`ALTER TABLE ${tableName} MODIFY COLUMN ${buildMysqlColumnDefinition(column)};`);
    }
  });

  const getIndexKey = (index: SchemaIndex, normalizeColumnName: (column: string) => string = trimColumnName): string => {
    const name = index.name.trim();
    return name ? name.toLowerCase() : `${index.type}:${index.columns.map(normalizeColumnName).join(',')}`.toLowerCase();
  };
  const originalIndexes = new Map(original.indexes.map((index) => [getIndexKey(index, normalizeRenamedColumnName), index]));
  const modifiedIndexes = new Map(modified.indexes.map((index) => [getIndexKey(index), index]));
  originalIndexes.forEach((index, key) => {
    if (!modifiedIndexes.has(key)) {
      statements.push(`ALTER TABLE ${tableName} DROP INDEX ${quoteIdentifier(index.name.trim(), 'mysql')};`);
    }
  });
  modifiedIndexes.forEach((index, key) => {
    const originalIndex = originalIndexes.get(key);
    if (!originalIndex) {
      const definition = buildMysqlIndexDefinition(index, modified.columns);
      if (definition) statements.push(`ALTER TABLE ${tableName} ADD ${definition};`);
      return;
    }
    if (!isSchemaEqual(normalizeSchemaIndex(originalIndex, normalizeRenamedColumnName), normalizeSchemaIndex(index, trimColumnName))) {
      statements.push(`ALTER TABLE ${tableName} DROP INDEX ${quoteIdentifier(originalIndex.name.trim(), 'mysql')};`);
      const definition = buildMysqlIndexDefinition(index, modified.columns);
      if (definition) statements.push(`ALTER TABLE ${tableName} ADD ${definition};`);
    }
  });

  const originalForeignKeys = new Map(original.foreignKeys.map((foreignKey) => [getForeignKeyConstraintName(foreignKey).toLowerCase(), foreignKey]));
  const modifiedForeignKeys = new Map(modified.foreignKeys.map((foreignKey) => [getForeignKeyConstraintName(foreignKey).toLowerCase(), foreignKey]));
  originalForeignKeys.forEach((foreignKey, key) => {
    if (!modifiedForeignKeys.has(key)) {
      statements.push(`ALTER TABLE ${tableName} DROP FOREIGN KEY ${quoteIdentifier(getForeignKeyConstraintName(foreignKey), 'mysql')};`);
    }
  });
  modifiedForeignKeys.forEach((foreignKey, key) => {
    const originalForeignKey = originalForeignKeys.get(key);
    if (!originalForeignKey) {
      const definition = buildMysqlForeignKeyDefinition(foreignKey, modified.columns);
      if (definition) statements.push(`ALTER TABLE ${tableName} ADD ${definition};`);
      return;
    }
    if (!isSchemaEqual(normalizeSchemaForeignKey(originalForeignKey, normalizeRenamedColumnName), normalizeSchemaForeignKey(foreignKey, trimColumnName))) {
      statements.push(`ALTER TABLE ${tableName} DROP FOREIGN KEY ${quoteIdentifier(getForeignKeyConstraintName(originalForeignKey), 'mysql')};`);
      const definition = buildMysqlForeignKeyDefinition(foreignKey, modified.columns);
      if (definition) statements.push(`ALTER TABLE ${tableName} ADD ${definition};`);
    }
  });

  // Primary key change detection
  const originalPK = new Set(original.primaryKeyColumns.map((col) => normalizeRenamedColumnName(col).toLowerCase()).filter(Boolean));
  const modifiedPK = new Set(modified.primaryKeyColumns.map((col) => col.trim().toLowerCase()).filter(Boolean));
  const pkChanged = originalPK.size !== modifiedPK.size
    || [...originalPK].some((col) => !modifiedPK.has(col));
  if (pkChanged) {
    if (originalPK.size > 0) {
      statements.push(`ALTER TABLE ${tableName} DROP PRIMARY KEY;`);
    }
    if (modifiedPK.size > 0) {
      const pkColumns = modified.primaryKeyColumns
        .filter((col) => col.trim())
        .map((col) => quoteIdentifier(col.trim(), 'mysql'));
      if (pkColumns.length > 0) {
        statements.push(`ALTER TABLE ${tableName} ADD PRIMARY KEY (${pkColumns.join(', ')});`);
      }
    }
  }

  if ((original.engine || 'InnoDB') !== (modified.engine || 'InnoDB')) {
    statements.push(`ALTER TABLE ${tableName} ENGINE=${modified.engine || 'InnoDB'};`);
  }
  if ((original.charset || '') !== (modified.charset || '') && modified.charset) {
    statements.push(`ALTER TABLE ${tableName} DEFAULT CHARSET=${modified.charset};`);
  }
  if ((original.comment || '') !== (modified.comment || '')) {
    statements.push(`ALTER TABLE ${tableName} COMMENT=${quoteMysqlString(modified.comment.trim())};`);
  }

  return statements;
}

export function generateAlterTableSql(original: CreateTableSnapshot, modified: CreateTableState): string {
  return generateAlterTableStatements(original, modified).join('\n');
}

export function translateForeignKeyAction(action: string): string {
  if (action === 'CASCADE') return tCurrent('auto.remoteMySQL.cascade');
  if (action === 'SET NULL') return tCurrent('auto.remoteMySQL.setNull');
  if (action === 'NO ACTION') return tCurrent('auto.remoteMySQL.noAction');
  return tCurrent('auto.remoteMySQL.restrict');
}

export function getShellDeskEditorTheme(): 'light' | 'dark' {
  if (typeof document === 'undefined') {
    return 'dark';
  }

  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

export function createQueryTab(index: number, sql = 'SELECT 1;'): MysqlQueryTab {
  return {
    id: createId('query'),
    title: tCurrent('auto.remoteMySQL.1vq2agf', { value0: index }),
    sql,
    running: false,
  };
}

export function createInitialQueryState(): { tabs: MysqlQueryTab[]; activeId: string } {
  const tab = createQueryTab(1);
  return { tabs: [tab], activeId: tab.id };
}

export function quoteMysqlString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

export function parseImportCsv(text: string) {
  return parseDatabaseImportCsv(text, tCurrent('auto.remoteMySQL.importCsvUnclosedQuote'));
}

export function parseImportJson(text: string) {
  return parseDatabaseImportJson(text, {
    mustBeArray: tCurrent('auto.remoteMySQL.importJsonMustBeArray'),
    itemsMustBeObjects: tCurrent('auto.remoteMySQL.importJsonItemsMustBeObjects'),
  });
}

export function quoteMysqlImportValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'object') return quoteMysqlString(JSON.stringify(value));
  return quoteMysqlString(String(value));
}

export function buildMysqlInsertSql(table: string, columns: string[], rows: Record<string, unknown>[]): string {
  const columnSql = columns.map((column) => quoteIdentifier(column, 'mysql')).join(', ');
  const valuesSql = rows
    .map((row) => `(${columns.map((column) => quoteMysqlImportValue(row[column])).join(', ')})`)
    .join(', ');

  return `INSERT INTO ${quoteIdentifier(table, 'mysql')} (${columnSql}) VALUES ${valuesSql};`;
}

export function valuesEqual(left: unknown, right: unknown): boolean {
  if (left === null || left === undefined) return right === null || right === undefined;
  if (right === null || right === undefined) return false;
  return String(left) === String(right);
}

export function getColumnMeta(columns: ShellDeskMysqlColumn[], name: string): ShellDeskMysqlColumn | undefined {
  return columns.find((column) => column.name === name);
}

export function describeResult(result: ShellDeskMysqlQueryResult): string {
  if (result.affectedRows !== undefined) {
    const insertText = result.insertId ? tCurrent('auto.remoteMySQL.12xfbkn', { value0: result.insertId }) : '';
    return tCurrent('auto.remoteMySQL.4g1j50', { value0: result.affectedRows, value1: insertText });
  }
  return tCurrent('auto.remoteMySQL.18tehe0', { value0: result.rows.length });
}

export function createExplainSql(sqlText: string): string {
  const statement = sqlText.trim().replace(/;+\s*$/, '');

  if (/^explain\b/i.test(statement)) {
    return statement;
  }

  return `EXPLAIN ${statement}`;
}

export function compareMysqlCellValues(left: unknown, right: unknown): number {
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
