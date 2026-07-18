export type TransferPaneKind = 'local' | 'remote';
export type TransferTaskStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'canceled';

export interface TransferFileEntry extends ShellDeskRemoteFileEntry {
  mode?: number;
  owner?: string | number;
  group?: string | number;
  permissions?: string;
}

export interface TransferPaneState {
  path: string;
  draftPath: string;
  entries: TransferFileEntry[];
  selectedNames: Set<string>;
  history: string[];
  historyIndex: number;
  search: string;
  sortField: 'name' | 'size' | 'type' | 'modifiedAt';
  sortDirection: 'asc' | 'desc';
  loading: boolean;
  error: string;
}

export interface SftpTransferTask {
  id: string;
  direction: 'upload' | 'download';
  label: string;
  sourcePaths: string[];
  targetPath: string;
  plannedSize?: number;
  plannedFileCount?: number;
  conflictPolicy?: 'overwrite' | 'skip';
  status: TransferTaskStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  progress?: ShellDeskTransferProgress;
  speed?: number;
  error?: string;
}

export interface SftpTransferConflict {
  source: TransferFileEntry;
  destination: TransferFileEntry;
}

export interface SftpTransferConflictDialog {
  direction: 'upload' | 'download';
  entries: TransferFileEntry[];
  summaries: ShellDeskSftpTransferSummary[];
  conflicts: SftpTransferConflict[];
}

export interface FileOperationDialog {
  kind: 'new-folder' | 'new-file' | 'rename' | 'delete' | 'properties' | 'sync';
  pane: TransferPaneKind;
  entries: TransferFileEntry[];
  value?: string;
  stat?: ShellDeskRemotePathStat;
  loading?: boolean;
  error?: string;
}
