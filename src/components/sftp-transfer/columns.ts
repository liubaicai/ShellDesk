import type { TransferPaneKind } from './types';

export const localSftpColumnChoices: ShellDeskSftpFileColumn[] = ['name', 'size', 'type', 'modifiedAt'];
export const remoteSftpColumnChoices: ShellDeskSftpFileColumn[] = ['name', 'size', 'type', 'permissions', 'modifiedAt'];

export function normalizeSftpColumns(
  kind: TransferPaneKind,
  columns: readonly ShellDeskSftpFileColumn[],
) {
  const choices = kind === 'local' ? localSftpColumnChoices : remoteSftpColumnChoices;
  const configured = new Set(columns);
  return choices.filter((column) => column === 'name' || configured.has(column));
}

export function toggleSftpColumn(
  kind: TransferPaneKind,
  columns: readonly ShellDeskSftpFileColumn[],
  column: ShellDeskSftpFileColumn,
  visible: boolean,
) {
  const configured = new Set(normalizeSftpColumns(kind, columns));
  if (visible) configured.add(column);
  else if (column !== 'name') configured.delete(column);
  return normalizeSftpColumns(kind, [...configured]);
}
