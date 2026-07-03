import type { AppLanguage, MessageId } from '../../i18n';
import type { RemoteTerminalLaunchOptions } from './RemoteTerminal';
import type { RemoteSystemType } from './types';

export interface RemoteSettingsProps {
  connectionId: string;
  systemType?: RemoteSystemType;
  initialTab?: SettingsTab;
  initialTabRequestId?: number;
  onOpenTerminal?: (launchOptions?: RemoteTerminalLaunchOptions) => void;
}

export type SettingsTab = 'systeminfo' | 'network' | 'update' | 'package-sources' | 'hosts' | 'route' | 'loginsessions' | 'users';

export interface SettingsTabDef {
  key: SettingsTab;
  labelId: MessageId;
  icon: string;
  descriptionId: MessageId;
}

export interface SettingsGroup {
  labelId: MessageId;
  tabs: SettingsTabDef[];
}

export interface RemoteSettingsSectionState<T> {
  loaded: boolean;
  loading: boolean;
  current?: T;
  draft?: T;
  error?: string;
  success?: string;
}

export interface SettingsConfirmDialogConfig {
  title: string;
  message: string;
  detail?: string;
  preview?: string;
  confirmLabel?: string;
  tone?: 'primary' | 'warning' | 'danger';
  onConfirm: () => void | Promise<void>;
}

export interface SettingsHostStatus {
  systemLabel: string;
  userLabel: string;
  privilegeLabel: string;
  privilegeTone: 'ready' | 'warning' | 'danger' | 'unknown';
  hint: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type RemoteSettingsCommandContext = (command: string) => Promise<CommandResult>;

export interface NetworkInterface {
  name: string;
  state: 'UP' | 'DOWN';
  mac: string;
  mtu: number;
  addresses: Array<{ addr: string; family: 'inet' | 'inet6'; prefixLen: number }>;
  raw: string;
}

export interface IfaceEditState {
  method: 'static' | 'dhcp';
  address: string;
  netmask: string;
  gateway: string;
}

export interface DnsConfig {
  servers: string[];
  search: string;
  raw: string;
}

export interface RouteEntry {
  destination: string;
  gateway?: string;
  dev?: string;
  raw: string;
}

export interface SysInfoItem {
  key: string;
  label: string;
  icon: string;
  value: string;
  detail?: string;
}

export interface CpuInfoSummary {
  model: string;
  logicalCpus: string;
  physicalCores: string;
  threadsPerCore: string;
  sockets: string;
}

export interface MemoryInfoSummary {
  total: string;
  used: string;
  free: string;
  shared: string;
  cache: string;
  available: string;
  usagePercent: number | null;
}

export interface DiskInfoSummary {
  total: string;
  available: string;
}

export interface SettingsNetworkHostnameDialogProps {
  hostnameDraft: string;
  language: AppLanguage;
  onClose: () => void;
  onSave: () => void;
  setHostnameDraft: (value: string) => void;
}
