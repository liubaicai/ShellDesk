import type { RemoteSystemType } from './types';

export interface RemoteFileExplorerProps {
  connectionId: string;
  systemType?: RemoteSystemType;
  initialPath?: string;
  onOpenFile?: (filePath: string) => void;
  onOpenSqliteFile?: (filePath: string) => void;
  onOpenTerminal?: (directoryPath: string) => void;
}

export type RemoteFileEntryType = 'directory' | 'file' | 'symlink';
export type RemoteSymlinkTargetType = RemoteFileEntryType | 'unknown';

export interface RemoteFileEntry {
  name: string;
  longname: string;
  type: RemoteFileEntryType;
  targetType?: RemoteSymlinkTargetType;
  targetPath?: string;
  size: number;
  modifiedAt: string;
}

export type FileEntry = RemoteFileEntry;
export type DirectoryEntry = RemoteFileEntry & { type: 'directory' };
export type SymlinkEntry = RemoteFileEntry & { type: 'symlink' };

export interface RemoteDirectoryResult {
  path: string;
  entries: RemoteFileEntry[];
}

export interface RemotePathStat {
  type: string;
  size: number;
  mode: number;
  owner: number;
  group: number;
  modifiedAt: string;
  accessedAt: string;
}

export type SortField = 'name' | 'modifiedAt' | 'type' | 'size';
export type SortDirection = 'asc' | 'desc';
export type SortDir = SortDirection;
export type ViewMode = 'details';

export interface ContextMenuState {
  x: number;
  y: number;
  targetEntry: RemoteFileEntry | null;
}

export type FileContextMenuState = ContextMenuState;

export interface ExplorerSudoPrompt {
  operation: string;
  target: string;
  error: string;
  password: string;
}

export type ExplorerTransferTaskStatus = 'queued' | 'running' | 'success' | 'error' | 'canceled' | 'skipped';
export type ExplorerTransferTaskType = 'upload' | 'download';

export interface ExplorerTransferTask {
  id: string;
  type: ExplorerTransferTaskType;
  label: string;
  detail: string;
  status: ExplorerTransferTaskStatus;
  createdAt: number;
  progress?: ShellDeskTransferProgress;
  error?: string;
  remotePaths?: string[];
  downloadFilePath?: string;
  uploadItems?: ShellDeskLocalUploadItem[];
  uploadTarget?: string;
}

export type TransferItem = ExplorerTransferTask;
export type TransferProgress = ShellDeskTransferProgress;

export interface ExplorerUploadConflictDialog {
  items: ShellDeskSelectedUploadItem[];
  conflicts: Array<{
    item: ShellDeskSelectedUploadItem;
    remotePath: string;
  }>;
}

export interface PermissionDialogState {
  entry: RemoteFileEntry | null;
  data: RemotePathStat | null;
  draft: string;
  recursive: boolean;
  saving: boolean;
  error: string;
}
