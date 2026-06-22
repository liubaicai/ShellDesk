import { type Dispatch, type SetStateAction, useEffect } from 'react';

import { tCurrent } from '../../i18n';
import { getShellDeskLocale } from './desktopUtils';

export type DatabaseDialect = 'mysql' | 'postgres' | 'clickhouse' | 'sqlite';

export interface DatabaseContextMenuItem {
  action: string;
  label: string;
  disabled?: boolean;
  danger?: boolean;
}

export const databaseContextMenuClassName = 'mysql-context-menu';

export function createId(prefix = 'id'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function describeDatabaseTransport(transport?: ShellDeskDatabaseTransport): string {
  switch (transport) {
    case 'direct':
      return tCurrent('db.transport.direct');
    case 'ssh-exec':
      return tCurrent('db.transport.sshExec');
    case 'ssh-forward':
      return tCurrent('db.transport.sshForward');
    case 'ssh-tunnel':
    default:
      return tCurrent('db.transport.sshTunnel');
  }
}

export function appendDatabaseFallbackReason(message: string, reason?: string | null): string {
  return reason
    ? `${message} ${tCurrent('db.connection.fallbackReason', { reason })}`
    : message;
}

export function formatSqlPreview(sql: string, maxLength = 56, emptyText?: string): string {
  const compact = sql.replace(/\s+/g, ' ').trim();
  if (!compact) return emptyText ?? tCurrent('auto.remoteMySQL.18ivnwu');
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}...` : compact;
}

interface FormatCellValueOptions {
  nullText?: string;
  compactObjects?: boolean;
  maxLength?: number;
}

export function formatCellValue(value: unknown, options: FormatCellValueOptions = {}): string {
  if (value === null) return options.nullText ?? 'NULL';
  if (value === undefined) return '';
  if (typeof value === 'object') {
    try {
      const text = options.compactObjects
        ? JSON.stringify(value, null, 2).replace(/\s+/g, ' ')
        : JSON.stringify(value);
      return options.maxLength === undefined ? text : text.slice(0, options.maxLength);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function formatTimestamp(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  const date = value instanceof Date ? value : new Date(value as string | number);
  return date.toLocaleTimeString(getShellDeskLocale(), {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function createGenericColumns(names: string[], dialect: 'mysql'): ShellDeskMysqlColumn[];
export function createGenericColumns(names: string[], dialect: 'postgres'): ShellDeskPostgresColumn[];
export function createGenericColumns(names: string[], dialect: 'clickhouse'): ShellDeskClickHouseColumn[];
export function createGenericColumns(names: string[], dialect: 'sqlite'): ShellDeskSqliteColumn[];
export function createGenericColumns(
  names: string[],
  dialect: DatabaseDialect,
): ShellDeskMysqlColumn[] | ShellDeskPostgresColumn[] | ShellDeskClickHouseColumn[] | ShellDeskSqliteColumn[] {
  switch (dialect) {
    case 'postgres':
      return names.map((name) => ({
        name,
        dataType: '',
        nullable: true,
        defaultValue: null,
        isPrimaryKey: false,
      }));
    case 'clickhouse':
      return names.map((name) => ({
        name,
        type: '',
        defaultKind: '',
        defaultExpression: '',
        comment: '',
        isPrimaryKey: false,
        isSortingKey: false,
      }));
    case 'sqlite':
      return names.map((name) => ({
        name,
        type: '',
        nullable: true,
        pk: false,
        defaultValue: null,
      }));
    case 'mysql':
    default:
      return names.map((name) => ({
        name,
        type: '',
        nullable: false,
        key: '',
        default: null,
        extra: '',
        comment: '',
      }));
  }
}

export function isWriteStatement(sql: string, dialect?: DatabaseDialect): boolean {
  if (dialect === 'sqlite' && /^\s*pragma\b/i.test(sql)) {
    return /^\s*pragma\s+[^;=]+=/i.test(sql);
  }

  if (dialect === 'clickhouse') {
    return /^\s*(insert|alter|drop|truncate|create|rename|attach|detach|optimize|kill|exchange)\b/i.test(sql);
  }

  if (dialect === 'sqlite') {
    return /^\s*(insert|update|delete|replace|alter|drop|create|vacuum|reindex|attach|detach)\b/i.test(sql);
  }

  return /^\s*(insert|update|delete|replace|alter|drop|truncate|create|rename|grant|revoke)\b/i.test(sql);
}

export function quoteIdentifier(name: string, dialect: DatabaseDialect): string {
  if (dialect === 'mysql' || dialect === 'clickhouse') {
    return `\`${name.replace(/`/g, '``')}\``;
  }

  return `"${name.replace(/"/g, '""')}"`;
}

export function useContextMenu<T>(
  contextMenu: T | null,
  setContextMenu: Dispatch<SetStateAction<T | null>>,
): void {
  useEffect(() => {
    if (!contextMenu) return undefined;

    const close = () => setContextMenu(null);
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };

    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [contextMenu, setContextMenu]);
}
