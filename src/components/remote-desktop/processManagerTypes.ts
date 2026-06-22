import type { MessageId } from '../../i18n';
import type { RemoteSystemType } from './types';

export type RemoteProcessManagerSortKey =
  | 'pid'
  | 'ppid'
  | 'user'
  | 'cpu'
  | 'memory'
  | 'state'
  | 'startTime'
  | 'runtime'
  | 'command';

export type RemoteProcessManagerViewMode = 'table' | 'tree';

export type SortDir = 'asc' | 'desc';

export interface RemoteProcessManagerLaunchOptions {
  pid?: number;
  search?: string;
  user?: string;
  sortKey?: RemoteProcessManagerSortKey;
  sortDir?: SortDir;
  viewMode?: RemoteProcessManagerViewMode;
}

export interface RemoteProcessManagerProps {
  connectionId: string;
  settings: ShellDeskAppSettings;
  systemType?: RemoteSystemType;
  launchOptions?: RemoteProcessManagerLaunchOptions;
}

export interface RemoteProcessEntry {
  pid: number;
  ppid?: number;
  user?: string;
  cpuPercent?: number;
  cpuSeconds?: number;
  memoryPercent?: number;
  memoryMb?: number;
  state?: string;
  startTime?: string;
  runtime?: string;
  cpuTime?: string;
  tty?: string;
  vszKb?: number;
  rssKb?: number;
  command: string;
  executablePath?: string;
}

export interface ProcessDetail {
  pid: number;
  cwd?: string;
  executablePath?: string;
  ports: string[];
  loadedAt: number;
  error?: string;
}

export interface ProcessRow {
  process: RemoteProcessEntry;
  depth: number;
}

export interface SignalDefinition {
  value: string;
  name: string;
  label: string;
  descriptionId: MessageId;
}

export interface PendingSignal {
  pid: number;
  command: string;
  signal: SignalDefinition;
}

export interface ProcessContextMenuState {
  x: number;
  y: number;
  process: RemoteProcessEntry;
}

export type ProcessAiReportPhase = 'idle' | 'preparing' | 'requesting' | 'streaming' | 'done' | 'error';

export interface ProcessAiSnapshot {
  text: string;
  includedCount: number;
  omittedCount: number;
}

export interface ProcessAiInsight {
  pid: number;
  content: string;
  error?: string;
}
