import { getAppLocale, getCurrentAppLanguage, t, type MessageId } from './i18n';

const hostsStorageKey = 'shelldesk:hosts';
const hostListSortModeStorageKey = 'shelldesk:host-list-sort-mode';
const hostPageSizeStorageKey = 'shelldesk:host-page-size';
const sideNavCollapsedStorageKey = 'shelldesk:side-nav-collapsed';
const terminalSnippetsStorageKey = 'shelldesk:terminal-snippets';
const dismissedUpdateReadyVersionStorageKey = 'shelldesk:update-ready-dismissed-version';
const terminalSnippetLanguageChoices = new Set([
  'plaintext',
  'javascript',
  'typescript',
  'html',
  'xml',
  'css',
  'json',
  'yaml',
  'bash',
  'powershell',
  'bat',
  'markdown',
  'sql',
  'python',
  'go',
  'rust',
  'java',
  'c',
  'cpp',
  'php',
  'ruby',
  'ini',
  'nginx',
  'dockerfile',
  'diff',
]);
export const ungroupedKey = '__ungrouped__';
export const hostPageSizeOptions = [10, 20, 50, 100] as const;
export type HostPageSize = (typeof hostPageSizeOptions)[number];

function normalizeTerminalSnippetLanguage(value: unknown) {
  return typeof value === 'string' && terminalSnippetLanguageChoices.has(value)
    ? value
    : 'bash';
}

export type HostViewMode = ShellDeskAppSettings['defaultHostView'];
export type HostListSortMode =
  | 'lastConnectionDesc'
  | 'createdDesc'
  | 'createdAsc'
  | 'updatedDesc'
  | 'updatedAsc'
  | 'nameAsc'
  | 'nameDesc'
  | 'addressAsc';

export type HostSystemType =
  | 'unknown'
  | 'windows'
  | 'macos'
  | 'synology'
  | 'ubuntu'
  | 'debian'
  | 'redhat'
  | 'centos'
  | 'fedora'
  | 'rocky'
  | 'almalinux'
  | 'oracle'
  | 'amazon'
  | 'arch'
  | 'manjaro'
  | 'alpine'
  | 'opensuse'
  | 'linuxmint'
  | 'kali'
  | 'raspbian'
  | 'gentoo'
  | 'nixos'
  | 'popos'
  | 'elementary'
  | 'linux'
  | 'unix';

export const hostListSortModes: ReadonlyArray<HostListSortMode> = [
  'lastConnectionDesc',
  'createdDesc',
  'createdAsc',
  'updatedDesc',
  'updatedAsc',
  'nameAsc',
  'nameDesc',
  'addressAsc',
];

export const hostListSortModeLabelIds: Record<HostListSortMode, MessageId> = {
  lastConnectionDesc: 'app.host.sort.lastConnectionDesc',
  createdDesc: 'app.host.sort.createdDesc',
  createdAsc: 'app.host.sort.createdAsc',
  updatedDesc: 'app.host.sort.updatedDesc',
  updatedAsc: 'app.host.sort.updatedAsc',
  nameAsc: 'app.host.sort.nameAsc',
  nameDesc: 'app.host.sort.nameDesc',
  addressAsc: 'app.host.sort.addressAsc',
};

export const hostSystemLabels: Record<HostSystemType, string> = {
  unknown: '',
  windows: 'Windows',
  macos: 'macOS',
  synology: 'Synology DSM',
  ubuntu: 'Ubuntu',
  debian: 'Debian',
  redhat: 'Red Hat Enterprise Linux',
  centos: 'CentOS',
  fedora: 'Fedora',
  rocky: 'Rocky Linux',
  almalinux: 'AlmaLinux',
  oracle: 'Oracle Linux',
  amazon: 'Amazon Linux',
  arch: 'Arch Linux',
  manjaro: 'Manjaro',
  alpine: 'Alpine Linux',
  opensuse: 'openSUSE / SUSE',
  linuxmint: 'Linux Mint',
  kali: 'Kali Linux',
  raspbian: 'Raspberry Pi OS',
  gentoo: 'Gentoo',
  nixos: 'NixOS',
  popos: 'Pop!_OS',
  elementary: 'elementary OS',
  linux: 'Linux',
  unix: 'Unix',
};

export const hostSystemNamePatterns: ReadonlyArray<[HostSystemType, RegExp]> = [
  ['windows', /windows/i],
  ['macos', /mac\s?os|darwin/i],
  ['synology', /synology|diskstation|dsm(?:\s|$)/i],
  ['ubuntu', /ubuntu/i],
  ['debian', /debian/i],
  ['redhat', /red\s*hat|rhel/i],
  ['centos', /centos/i],
  ['fedora', /fedora/i],
  ['rocky', /rocky/i],
  ['almalinux', /alma\s*linux|almalinux/i],
  ['oracle', /oracle\s+linux/i],
  ['amazon', /amazon\s+linux|amzn/i],
  ['arch', /arch\s+linux/i],
  ['manjaro', /manjaro/i],
  ['alpine', /alpine/i],
  ['opensuse', /opensuse|open\s*suse|suse/i],
  ['linuxmint', /linux\s*mint/i],
  ['kali', /kali/i],
  ['raspbian', /raspbian|raspberry\s*pi/i],
  ['gentoo', /gentoo/i],
  ['nixos', /nixos/i],
  ['popos', /pop!_?os|pop\s*os/i],
  ['elementary', /elementary/i],
  ['linux', /linux/i],
  ['unix', /unix/i],
];

export function getHostSystemType(value: unknown, systemName?: unknown): HostSystemType {
  const normalizedValue = typeof value === 'string' ? value.toLowerCase() : '';

  if (normalizedValue in hostSystemLabels && normalizedValue !== 'unknown') {
    return normalizedValue as HostSystemType;
  }

  if (typeof systemName === 'string') {
    const matchedSystem = hostSystemNamePatterns.find(([, pattern]) => pattern.test(systemName));
    if (matchedSystem) {
      return matchedSystem[0];
    }
  }

  return 'unknown';
}

export interface SshKey {
  id: string;
  name: string;
  source: 'imported' | 'generated';
  algorithm: string;
  fingerprint: string;
  publicKey: string;
  passphrase: string;
  createdAt: string;
  updatedAt: string;
}

export interface KeyFormState {
  name: string;
  privateKeyPath: string;
  publicKeyPath: string;
  passphrase: string;
  modulusLength: '2048' | '3072' | '4096';
}

export const emptyKeyForm: KeyFormState = {
  name: '',
  privateKeyPath: '',
  publicKeyPath: '',
  passphrase: '',
  modulusLength: '4096',
};

export const keyPathSeparators = /[\\/]+/;

export function getKeyNameFromPath(keyPath: string) {
  const fileName = keyPath.split(keyPathSeparators).filter(Boolean).pop() ?? 'SSH Key';
  return fileName.replace(/\.(pem|key|ppk|openssh)$/i, '') || fileName;
}

export function isStoredSshKey(value: unknown): value is SshKey {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const key = value as Partial<SshKey>;
  return (
    typeof key.id === 'string' &&
    typeof key.name === 'string' &&
    (key.source === 'imported' || key.source === 'generated') &&
    typeof key.algorithm === 'string' &&
    typeof key.fingerprint === 'string' &&
    typeof key.publicKey === 'string' &&
    typeof key.passphrase === 'string' &&
    typeof key.createdAt === 'string' &&
    typeof key.updatedAt === 'string'
  );
}

export type KeyEditorMode = 'import' | 'generate' | 'edit';

export function validateKeyForm(form: KeyFormState, mode: KeyEditorMode, language: ShellDeskAppSettings['language']) {
  const name = form.name.trim();

  if (!name) {
    return t('app.key.validation.nameRequired', language);
  }

  if (name.length > 80 || form.passphrase.length > 4096) {
    return t('app.key.validation.tooLong', language);
  }

  if (mode === 'import') {
    if (!form.privateKeyPath.trim()) {
      return t('app.key.validation.privateKeyRequired', language);
    }

    if (form.privateKeyPath.trim().length > 1024 || form.publicKeyPath.trim().length > 1024) {
      return t('app.key.validation.pathTooLong', language);
    }
  }

  if (mode === 'generate' && !['2048', '3072', '4096'].includes(form.modulusLength)) {
    return t('app.key.validation.invalidRsaBits', language);
  }

  return '';
}

export function updateSshKeyFromForm(key: SshKey, form: KeyFormState): SshKey {
  return {
    ...key,
    name: form.name.trim(),
    passphrase: form.passphrase,
    updatedAt: new Date().toISOString(),
  };
}

export function toKeyFormState(key: SshKey): KeyFormState {
  return {
    name: key.name,
    privateKeyPath: '',
    publicKeyPath: '',
    passphrase: key.passphrase,
    modulusLength: '4096',
  };
}

export type AuthMethod = 'password' | 'key';
export type ConnectionAuthMethod = AuthMethod | 'agent';
export type HostConnectionStatus = 'unknown' | 'success' | 'failed';
export type HostStatusFilter = 'all' | 'ready' | 'failed' | 'never';
export type PrivilegeMode = 'sudo' | 'su-root';
export const defaultKeepaliveIntervalSeconds = 15;
export const defaultKeepaliveIntervalMs = defaultKeepaliveIntervalSeconds * 1000;

export interface HostInfoItem {
  key: string;
  label: string;
  icon?: string;
  value: string;
}

export interface HostInfoSnapshot {
  address: string;
  collectedAt: string;
  systemType: HostSystemType;
  systemName: string;
  items: HostInfoItem[];
}

export interface Host {
  id: string;
  name: string;
  address: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  password: string;
  keyId: string;
  keyPath: string;
  passphrase: string;
  privilegeMode: PrivilegeMode;
  rootPassword: string;
  jumpHostId: string;
  canBeJumpHost: boolean;
  proxyProfileId: string;
  keepaliveEnabled?: boolean;
  keepaliveIntervalMs?: number;
  systemType: HostSystemType;
  systemName: string;
  hostInfo: HostInfoSnapshot | null;
  group: string;
  tags: string[];
  note: string;
  lastConnectionStatus: HostConnectionStatus;
  lastConnectionAt: string;
  lastConnectionError: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionHost extends Omit<Host, 'authMethod'> {
  authMethod: ConnectionAuthMethod;
}

export interface VaultCollectionsSavePayload {
  hosts: Host[];
  sshKeys: SshKey[];
  proxyProfiles: ShellDeskProxyProfile[];
  settings: ShellDeskAppSettings;
}

export type SettingsUpdate = ShellDeskAppSettings | ((currentSettings: ShellDeskAppSettings) => ShellDeskAppSettings);

export interface ConnectionErrorNotice {
  hostName: string;
  endpoint: string;
  message: string;
}

export type ConnectionLaunchSource = 'host-card' | 'quick-connect' | 'credential';
export type ConnectionLaunchTarget = 'desktop' | 'sftp-transfer';

export type StoredHost = Omit<Host, 'authMethod' | 'password' | 'keyId' | 'keyPath' | 'passphrase' | 'privilegeMode' | 'rootPassword' | 'jumpHostId' | 'canBeJumpHost' | 'proxyProfileId' | 'keepaliveEnabled' | 'keepaliveIntervalMs' | 'systemType' | 'systemName' | 'hostInfo' | 'lastConnectionStatus' | 'lastConnectionAt' | 'lastConnectionError'> &
  Partial<Pick<Host, 'authMethod' | 'password' | 'keyId' | 'keyPath' | 'passphrase' | 'privilegeMode' | 'rootPassword' | 'jumpHostId' | 'canBeJumpHost' | 'proxyProfileId' | 'keepaliveEnabled' | 'keepaliveIntervalMs' | 'systemType' | 'systemName' | 'lastConnectionStatus' | 'lastConnectionAt' | 'lastConnectionError'>> & {
    hostInfo?: unknown;
  };

export interface HostFormState {
  name: string;
  address: string;
  port: string;
  username: string;
  authMethod: AuthMethod;
  password: string;
  keyId: string;
  keyPath: string;
  passphrase: string;
  privilegeMode: PrivilegeMode;
  rootPassword: string;
  jumpHostId: string;
  canBeJumpHost: boolean;
  proxyProfileId: string;
  keepaliveEnabled: boolean;
  keepaliveIntervalSeconds: string;
  group: string;
  tags: string;
  note: string;
}

export interface HostGroup {
  key: string;
  name: string;
  count: number;
}

export type DeleteConfirmationRequest =
  | { kind: 'host'; host: Host }
  | { kind: 'host-jump-blocked'; host: Host; dependentHosts: Host[] }
  | { kind: 'ssh-key'; key: SshKey; relatedHostCount: number };

export interface ConnectionClosedPayload {
  connectionId: string;
  reason?: string;
}

export interface ConnectionReconnectingPayload {
  connectionId: string;
  reason?: string;
}

export interface ConnectionRestoredPayload {
  connectionId: string;
}

export type LogCategory = 'connection' | 'host' | 'key' | 'config' | 'system';
export type LogLevel = 'info' | 'success' | 'warning' | 'error';

export interface LogHostMeta {
  hostId?: string;
  hostName?: string;
  hostAddress?: string;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  category: LogCategory;
  level: LogLevel;
  message: string;
  detail: string;
  component?: string;
  hostId?: string;
  hostName?: string;
  hostAddress?: string;
}

export interface CredentialFormState {
  authMethod: AuthMethod;
  password: string;
  keyId: string;
  passphrase: string;
  saveCredential: boolean;
}

export const emptyHostForm: HostFormState = {
  name: '',
  address: '',
  port: '22',
  username: 'root',
  authMethod: 'password',
  password: '',
  keyId: '',
  keyPath: '',
  passphrase: '',
  privilegeMode: 'sudo',
  rootPassword: '',
  jumpHostId: '',
  canBeJumpHost: false,
  proxyProfileId: '',
  keepaliveEnabled: true,
  keepaliveIntervalSeconds: String(defaultKeepaliveIntervalSeconds),
  group: '',
  tags: '',
  note: '',
};

export const emptyCredentialForm: CredentialFormState = {
  authMethod: 'password',
  password: '',
  keyId: '',
  passphrase: '',
  saveCredential: true,
};

export function createId() {
  if ('randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function getErrorMessage(error: unknown, language: ShellDeskAppSettings['language'] = getCurrentAppLanguage()) {
  if (error instanceof Error && error.message) {
    return error.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
  }

  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }

  return t('app.error.operationFailed', language);
}

export function isAuthFailureMessage(message: string) {
  return /\u8ba4\u8bc1\u5931\u8d25|authentication methods failed|password|private key|passphrase|\u5bc6\u94a5|\u53e3\u4ee4/i.test(message);
}

export function getLogHostMeta(host: { id?: string; name?: string; address?: string }): LogHostMeta {
  return {
    hostId: host.id,
    hostName: host.name || host.address,
    hostAddress: host.address,
  };
}

export function parseTags(value: string) {
  return value
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 8);
}

export function formatTags(tags: string[]) {
  return tags.join(', ');
}

export const hostChipToneCount = 12;

export function getHostChipToneClass(value: string, kind: 'group' | 'tag') {
  const normalized = value.trim().toLowerCase();

  if (!normalized) {
    return '';
  }

  let hash = kind === 'group' ? 17 : 53;

  for (let index = 0; index < normalized.length; index += 1) {
    hash = (hash * 31 + normalized.charCodeAt(index)) >>> 0;
  }

  return `tone-${hash % hostChipToneCount}`;
}

export function getHostChipClassName(kind: 'group' | 'tag', value: string, active: boolean) {
  return `host-chip ${kind}-chip ${active ? getHostChipToneClass(value, kind) : 'muted'}`;
}

export function getAuthMethod(value: unknown): AuthMethod {
  return value === 'key' ? 'key' : 'password';
}

export function getPrivilegeMode(value: unknown): PrivilegeMode {
  return value === 'su-root' ? 'su-root' : 'sudo';
}

export function isRootLoginUsername(username: string) {
  return username.trim().toLowerCase() === 'root';
}

export function getHostConnectionStatus(value: unknown): HostConnectionStatus {
  return value === 'success' || value === 'failed' ? value : 'unknown';
}

export function getKeepaliveIntervalMs(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : defaultKeepaliveIntervalMs;
}

export function readHostInfoItem(value: unknown): HostInfoItem | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const item = value as Partial<HostInfoItem>;
  const key = typeof item.key === 'string' ? item.key.trim().slice(0, 80) : '';
  const label = typeof item.label === 'string' ? item.label.trim().slice(0, 80) : '';
  const icon = typeof item.icon === 'string' ? item.icon.trim().slice(0, 16) : '';
  const itemValue = typeof item.value === 'string' ? item.value.replace(/\0/g, '').slice(0, 20000).trim() : '';

  if (!key || !label) {
    return null;
  }

  return {
    key,
    label,
    ...(icon ? { icon } : {}),
    value: itemValue,
  };
}

export function getHostInfoSnapshot(value: unknown): HostInfoSnapshot | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const snapshot = value as Partial<HostInfoSnapshot>;
  const collectedAt = typeof snapshot.collectedAt === 'string' ? snapshot.collectedAt.trim() : '';
  const items = Array.isArray(snapshot.items)
    ? snapshot.items.slice(0, 32).map(readHostInfoItem).filter((item): item is HostInfoItem => Boolean(item))
    : [];

  if (!collectedAt || !items.length) {
    return null;
  }

  return {
    address: typeof snapshot.address === 'string' ? snapshot.address.trim().slice(0, 255) : '',
    collectedAt,
    systemType: getHostSystemType(snapshot.systemType, snapshot.systemName),
    systemName: typeof snapshot.systemName === 'string' ? snapshot.systemName.trim().slice(0, 160) : '',
    items,
  };
}

export function formatHostInfoTime(value: string, language: ShellDeskAppSettings['language']) {
  const timestamp = Date.parse(value);

  if (!Number.isFinite(timestamp)) {
    return value || '-';
  }

  return new Date(timestamp).toLocaleString(getAppLocale(language));
}

export function formatRelativeTime(value: string, language: ShellDeskAppSettings['language']) {
  const timestamp = Date.parse(value);

  if (!Number.isFinite(timestamp)) {
    return language === 'zh-CN' ? '从未连接' : 'Never';
  }

  const diffSeconds = (timestamp - Date.now()) / 1000;
  const absSeconds = Math.abs(diffSeconds);
  const thresholds: ReadonlyArray<{ unit: Intl.RelativeTimeFormatUnit; seconds: number }> = [
    { unit: 'year', seconds: 60 * 60 * 24 * 365 },
    { unit: 'month', seconds: 60 * 60 * 24 * 30 },
    { unit: 'day', seconds: 60 * 60 * 24 },
    { unit: 'hour', seconds: 60 * 60 },
    { unit: 'minute', seconds: 60 },
  ];
  const match = thresholds.find((item) => absSeconds >= item.seconds) ?? { unit: 'second' as const, seconds: 1 };
  const valueForUnit = Math.round(diffSeconds / match.seconds);

  return new Intl.RelativeTimeFormat(getAppLocale(language), { numeric: 'auto' }).format(valueForUnit, match.unit);
}

export function getHostInfoItemValue(host: Pick<Host, 'hostInfo'>, key: string) {
  return host.hostInfo?.items.find((item) => item.key === key)?.value.trim() ?? '';
}

export function getFirstHostInfoLine(value: string) {
  const prettyNameMatch = /^PRETTY_NAME=(?<name>.+)$/m.exec(value);

  if (prettyNameMatch?.groups?.name) {
    return prettyNameMatch.groups.name.replace(/^["']|["']$/g, '').trim();
  }

  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? '';
}

export function getSystemNameFromHostInfoItems(items: HostInfoItem[]) {
  const osValue = items.find((item) => item.key === 'os')?.value.trim() ?? '';
  return getFirstHostInfoLine(osValue);
}

export function getHostDetailValue(host: Host, key: string, fallback: string) {
  const value = getFirstHostInfoLine(getHostInfoItemValue(host, key));
  return value || fallback;
}

export function parseColonSeparatedHostInfo(raw: string) {
  const values = new Map<string, string>();

  for (const line of raw.split(/\r?\n/)) {
    const separatorIndex = line.indexOf(':');

    if (separatorIndex < 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();

    if (key && value) {
      values.set(key, value);
    }
  }

  return values;
}

export function parsePositiveInteger(value: string) {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function multiplyPositiveIntegers(left: string, right: string) {
  const leftValue = parsePositiveInteger(left);
  const rightValue = parsePositiveInteger(right);
  return leftValue && rightValue ? leftValue * rightValue : null;
}

export function formatHostCpuCores(value: number, language: ShellDeskAppSettings['language']) {
  return language === 'zh-CN' ? `${value} 核` : `${value} cores`;
}

export function getHostCpuCoreValue(host: Host, language: ShellDeskAppSettings['language']) {
  const dedicatedValue = parsePositiveInteger(getHostInfoItemValue(host, 'cpuCores'));

  if (dedicatedValue) {
    return formatHostCpuCores(dedicatedValue, language);
  }

  const rawCpu = getHostInfoItemValue(host, 'cpu');

  if (!rawCpu) {
    return '-';
  }

  const windowsCores = rawCpu.match(/\bCores:\s*(\d+)/i)?.[1];
  const localLogicalCores = rawCpu.match(/逻辑核心\s*(\d+)/)?.[1];
  const values = parseColonSeparatedHostInfo(rawCpu);
  const physicalCores = multiplyPositiveIntegers(
    values.get('Socket(s)') ?? '',
    values.get('Core(s) per socket') ?? '',
  );
  const fallbackCores = parsePositiveInteger(windowsCores ?? localLogicalCores ?? values.get('CPU(s)') ?? '');
  const cores = physicalCores ?? fallbackCores;

  return cores ? formatHostCpuCores(cores, language) : '-';
}

export function parseHostCapacityBytes(rawValue: string) {
  const match = rawValue.trim().match(/^([\d.]+)\s*([kmgtp]?i?)?b?$/i);

  if (!match) {
    return null;
  }

  const value = Number.parseFloat(match[1]);

  if (!Number.isFinite(value)) {
    return null;
  }

  const unit = (match[2] || '').toLowerCase();
  const multipliers: Record<string, number> = {
    '': 1,
    k: 1024,
    ki: 1024,
    m: 1024 ** 2,
    mi: 1024 ** 2,
    g: 1024 ** 3,
    gi: 1024 ** 3,
    t: 1024 ** 4,
    ti: 1024 ** 4,
    p: 1024 ** 5,
    pi: 1024 ** 5,
  };

  return value * (multipliers[unit] ?? 1);
}

export function formatHostCapacity(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '';
  }

  const gib = bytes / 1024 / 1024 / 1024;

  if (gib >= 1024) {
    return `${Number((gib / 1024).toFixed(1))} TB`;
  }

  return `${Number(gib.toFixed(1))} GB`;
}

export function getFirstCapacityValue(rawValue: string) {
  const match = rawValue.match(/([\d.]+)\s*([kmgtp](?:i)?b?|[kmgtp]b)\b/i);
  return match ? `${match[1]} ${match[2]}` : '';
}

export function formatHostCapacityValue(rawValue: string) {
  const value = getFirstCapacityValue(rawValue);

  if (!value) {
    return '';
  }

  const bytes = parseHostCapacityBytes(value);
  return bytes ? formatHostCapacity(bytes) : value.toUpperCase();
}

export function getHostMemoryTotalValue(host: Host) {
  const dedicatedValue = formatHostCapacityValue(getHostInfoItemValue(host, 'memoryTotal'));

  if (dedicatedValue) {
    return dedicatedValue;
  }

  const rawMemory = getHostInfoItemValue(host, 'memory');

  if (!rawMemory) {
    return '-';
  }

  const labeledTotal = rawMemory.match(/(?:Total|总计)\s*:?\s*([\d.]+\s*(?:[kmgtp]?i?b?|[kmgtp]b))/i)?.[1];

  if (labeledTotal) {
    return formatHostCapacityValue(labeledTotal) || labeledTotal;
  }

  const memLine = rawMemory.split(/\r?\n/).find((line) => /^Mem:\s+/i.test(line.trim()));
  const totalFromFree = memLine?.trim().split(/\s+/)[1] ?? '';

  return formatHostCapacityValue(totalFromFree) || '-';
}

export function getHostDiskTotalValue(host: Host) {
  const dedicatedValue = formatHostCapacityValue(getHostInfoItemValue(host, 'diskTotal'));

  if (dedicatedValue) {
    return dedicatedValue;
  }

  const rawDisk = getHostInfoItemValue(host, 'disk');

  if (!rawDisk) {
    return '-';
  }

  let totalBytes = 0;
  const seenFilesystems = new Set<string>();

  for (const line of rawDisk.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);

    if (parts.length < 6 || /^filesystem$/i.test(parts[0])) {
      continue;
    }

    if (seenFilesystems.has(parts[0])) {
      continue;
    }

    const bytes = parseHostCapacityBytes(parts[1]);

    if (bytes) {
      seenFilesystems.add(parts[0]);
      totalBytes += bytes;
    }
  }

  if (totalBytes > 0) {
    return formatHostCapacity(totalBytes);
  }

  let totalSizeGb = 0;

  for (const line of rawDisk.split(/\r?\n/)) {
    if (/^(DeviceID|[-\s]+$)/i.test(line.trim())) {
      continue;
    }

    const sizeMatch = line.match(/\s(\d+(?:\.\d+)?)\s+\d+(?:\.\d+)?\s*$/);

    if (sizeMatch) {
      totalSizeGb += Number.parseFloat(sizeMatch[1]);
    }
  }

  return totalSizeGb > 0 ? formatHostCapacity(totalSizeGb * 1024 ** 3) : '-';
}

export function createHostInfoSnapshot(
  host: Pick<Host, 'address' | 'systemName' | 'systemType'>,
  report: ShellDeskRemoteSystemInfoReport,
  systemType: HostSystemType,
  systemName: string,
): HostInfoSnapshot | null {
  const items = Array.isArray(report.items)
    ? report.items.slice(0, 32).map(readHostInfoItem).filter((item): item is HostInfoItem => Boolean(item))
    : [];

  if (!items.length) {
    return null;
  }

  const collectedSystemName = getSystemNameFromHostInfoItems(items);
  const effectiveSystemName = collectedSystemName || systemName || host.systemName;
  const systemTypeSource = collectedSystemName ? 'unknown' : systemType !== 'unknown' ? systemType : host.systemType;
  const effectiveSystemType = getHostSystemType(systemTypeSource, effectiveSystemName);

  return {
    address: host.address,
    collectedAt: report.refreshedAt || new Date().toISOString(),
    systemType: effectiveSystemType,
    systemName: effectiveSystemName,
    items,
  };
}

export function getAuthLabel(host: Pick<Host, 'authMethod' | 'password'>, key: SshKey | null, language: ShellDeskAppSettings['language']) {
  if (host.authMethod === 'key') {
    if (!key) {
      return t('app.auth.keyLogin', language);
    }

    return key.passphrase
      ? t('app.auth.keyWithPassphrase', language, { name: key.name })
      : t('app.auth.keyWithName', language, { name: key.name });
  }

  return host.password ? t('app.auth.passwordSaved', language) : t('app.auth.passwordLogin', language);
}

export function getHostSystemLabel(host: Pick<Host, 'systemName' | 'systemType'>, language: ShellDeskAppSettings['language']) {
  return host.systemName || hostSystemLabels[host.systemType] || t('app.system.unknown', language);
}

export function getHostConnectionStateView(host: Pick<Host, 'lastConnectionStatus' | 'lastConnectionAt' | 'lastConnectionError'>, language: ShellDeskAppSettings['language']) {
  if (host.lastConnectionStatus === 'failed') {
    const failureDetail = host.lastConnectionError ? `: ${host.lastConnectionError}` : '';
    const failureTime = host.lastConnectionAt ? ` (${host.lastConnectionAt})` : '';

    return {
      className: 'not-ready',
      label: t('app.host.status.notReady', language),
      title: t('app.host.status.lastFailure', language, { time: failureTime, detail: failureDetail }),
    };
  }

  return {
    className: 'ready',
    label: t('app.host.status.ready', language),
    title: host.lastConnectionStatus === 'success' ? t('app.host.status.lastSuccess', language) : t('app.host.status.configReady', language),
  };
}

export function getProxyConfigEndpoint(config: ShellDeskProxyConfig | undefined) {
  if (!config) {
    return '';
  }

  if (config.type === 'command') {
    return 'ProxyCommand';
  }

  return `${config.host}:${config.port}`;
}

export function getProxyConfigTypeLabel(config: ShellDeskProxyConfig | undefined) {
  if (!config) {
    return '';
  }

  return config.type === 'command' ? 'ProxyCommand' : config.type.toUpperCase();
}

export function isStoredHost(value: unknown): value is StoredHost {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const host = value as Partial<StoredHost>;
  return (
    typeof host.id === 'string' &&
    typeof host.name === 'string' &&
    typeof host.address === 'string' &&
    typeof host.port === 'number' &&
    Number.isInteger(host.port) &&
    typeof host.username === 'string' &&
    typeof host.group === 'string' &&
    Array.isArray(host.tags) &&
    host.tags.every((tag) => typeof tag === 'string') &&
    typeof host.note === 'string' &&
    typeof host.createdAt === 'string' &&
    typeof host.updatedAt === 'string'
  );
}

export function normalizeStoredHost(host: StoredHost): Host {
  const hostInfo = getHostInfoSnapshot(host.hostInfo);
  const normalizedAddress = host.address.trim();

  return {
    ...host,
    authMethod: getAuthMethod(host.authMethod),
    password: typeof host.password === 'string' ? host.password : '',
    keyId: typeof host.keyId === 'string' ? host.keyId : '',
    keyPath: typeof host.keyPath === 'string' ? host.keyPath : '',
    passphrase: typeof host.passphrase === 'string' ? host.passphrase : '',
    privilegeMode: getPrivilegeMode(host.privilegeMode),
    rootPassword: getPrivilegeMode(host.privilegeMode) === 'su-root' && typeof host.rootPassword === 'string' ? host.rootPassword : '',
    address: normalizedAddress,
    jumpHostId: typeof host.jumpHostId === 'string' ? host.jumpHostId : '',
    canBeJumpHost: host.canBeJumpHost === true,
    proxyProfileId: typeof host.proxyProfileId === 'string' ? host.proxyProfileId : '',
    keepaliveEnabled: host.keepaliveEnabled !== false,
    keepaliveIntervalMs: getKeepaliveIntervalMs(host.keepaliveIntervalMs),
    systemType: getHostSystemType(host.systemType, host.systemName),
    systemName: typeof host.systemName === 'string' ? host.systemName : '',
    hostInfo: hostInfo && (!hostInfo.address || hostInfo.address === normalizedAddress) ? hostInfo : null,
    lastConnectionStatus: getHostConnectionStatus(host.lastConnectionStatus),
    lastConnectionAt: typeof host.lastConnectionAt === 'string' ? host.lastConnectionAt : '',
    lastConnectionError: typeof host.lastConnectionError === 'string' ? host.lastConnectionError : '',
  };
}

export function protectHostInfoFromStaleSnapshot(incomingHosts: Host[], currentHosts: Host[]) {
  if (!currentHosts.length) {
    return incomingHosts;
  }

  const currentHostById = new Map(currentHosts.map((host) => [host.id, host]));

  return incomingHosts.map((incomingHost): Host => {
    const currentHost = currentHostById.get(incomingHost.id);

    if (!currentHost || currentHost.address !== incomingHost.address) {
      return incomingHost;
    }

    const shouldKeepHostInfo = !incomingHost.hostInfo && Boolean(currentHost.hostInfo);
    const shouldKeepLastConnection =
      Boolean(currentHost.lastConnectionAt) &&
      getSortableTimestamp(currentHost.lastConnectionAt) > getSortableTimestamp(incomingHost.lastConnectionAt);
    const shouldKeepUpdatedAt = getSortableTimestamp(currentHost.updatedAt) > getSortableTimestamp(incomingHost.updatedAt);

    if (!shouldKeepHostInfo && !shouldKeepLastConnection && !shouldKeepUpdatedAt) {
      return incomingHost;
    }

    return {
      ...incomingHost,
      ...(shouldKeepHostInfo
        ? {
            hostInfo: currentHost.hostInfo,
            systemType: incomingHost.systemType === 'unknown' ? currentHost.systemType : incomingHost.systemType,
            systemName: incomingHost.systemName || currentHost.systemName,
          }
        : {}),
      ...(shouldKeepLastConnection
        ? {
            lastConnectionStatus: currentHost.lastConnectionStatus,
            lastConnectionAt: currentHost.lastConnectionAt,
            lastConnectionError: currentHost.lastConnectionError,
          }
        : {}),
      ...(shouldKeepUpdatedAt ? { updatedAt: currentHost.updatedAt } : {}),
    };
  });
}

export function getSortableTimestamp(value: string) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

export function compareHostsByListOrder(left: Pick<Host, 'id' | 'createdAt' | 'updatedAt'>, right: Pick<Host, 'id' | 'createdAt' | 'updatedAt'>) {
  const createdDiff = getSortableTimestamp(right.createdAt) - getSortableTimestamp(left.createdAt);

  if (createdDiff !== 0) {
    return createdDiff;
  }

  const updatedDiff = getSortableTimestamp(right.updatedAt) - getSortableTimestamp(left.updatedAt);

  if (updatedDiff !== 0) {
    return updatedDiff;
  }

  return left.id.localeCompare(right.id);
}

export function sortHostsByListOrder(hosts: Host[]) {
  return [...hosts].sort(compareHostsByListOrder);
}

export function preserveReferencedJumpHostCapability(hosts: Host[]) {
  const hostsById = new Map(hosts.map((host) => [host.id, host]));
  const referencedJumpHostIds = new Set(hosts
    .map((host) => {
      const jumpHostId = host.jumpHostId.trim();
      const jumpHost = jumpHostId ? hostsById.get(jumpHostId) : null;

      return jumpHost && jumpHost.id !== host.id ? jumpHost.id : '';
    })
    .filter(Boolean));

  return hosts.map((host): Host => (
    referencedJumpHostIds.has(host.id) && !host.canBeJumpHost
      ? { ...host, canBeJumpHost: true }
      : host
  ));
}

export function sanitizeHostJumpHostReferences(hosts: Host[]) {
  const hostsWithJumpCapability = preserveReferencedJumpHostCapability(hosts);
  const hostsById = new Map(hostsWithJumpCapability.map((host) => [host.id, host]));
  const directOrExistingHosts = hostsWithJumpCapability.map((host): Host => {
    const jumpHostId = host.jumpHostId.trim();
    const jumpHost = jumpHostId ? hostsById.get(jumpHostId) : null;

    if (!jumpHostId || jumpHostId === host.id || !jumpHost || !jumpHost.canBeJumpHost) {
      return {
        ...host,
        jumpHostId: '',
      };
    }

    return {
      ...host,
      jumpHostId,
    };
  });
  const normalizedHostsById = new Map(directOrExistingHosts.map((host) => [host.id, host]));

  return directOrExistingHosts.map((host): Host => {
    const jumpHost = host.jumpHostId ? normalizedHostsById.get(host.jumpHostId) : null;

    if (!host.jumpHostId || !jumpHost || jumpHost.jumpHostId) {
      return {
        ...host,
        jumpHostId: '',
      };
    }

    return {
      ...host,
      jumpHostId: host.jumpHostId,
    };
  });
}

export function normalizeStoredHosts(hosts: StoredHost[]) {
  return sortHostsByListOrder(sanitizeHostJumpHostReferences(hosts.map(normalizeStoredHost)));
}

export function isHostListSortMode(value: unknown): value is HostListSortMode {
  return typeof value === 'string' && hostListSortModes.includes(value as HostListSortMode);
}

export function readHostListSortMode(): HostListSortMode {
  try {
    return getHostListSortMode(window.localStorage.getItem(hostListSortModeStorageKey));
  } catch {
    return 'createdDesc';
  }
}

export function storeHostListSortMode(sortMode: HostListSortMode) {
  try {
    window.localStorage.setItem(hostListSortModeStorageKey, sortMode);
  } catch {
    // Ignore localStorage write failures in restricted environments.
  }
}

export function getHostListSortMode(value: unknown): HostListSortMode {
  return isHostListSortMode(value) ? value : 'createdDesc';
}

export function isHostPageSize(value: unknown): value is HostPageSize {
  return typeof value === 'number' && hostPageSizeOptions.includes(value as HostPageSize);
}

export function readHostPageSize(): HostPageSize {
  try {
    const storedValue = Number(window.localStorage.getItem(hostPageSizeStorageKey));

    return isHostPageSize(storedValue) ? storedValue : 20;
  } catch {
    return 20;
  }
}

export function storeHostPageSize(pageSize: HostPageSize) {
  try {
    window.localStorage.setItem(hostPageSizeStorageKey, String(pageSize));
  } catch {
    // Ignore localStorage write failures in restricted environments.
  }
}

export function readSideNavCollapsed(): boolean {
  try {
    return window.localStorage.getItem(sideNavCollapsedStorageKey) === 'true';
  } catch {
    return false;
  }
}

export function storeSideNavCollapsed(collapsed: boolean) {
  try {
    window.localStorage.setItem(sideNavCollapsedStorageKey, collapsed ? 'true' : 'false');
  } catch {
    // Ignore localStorage write failures in restricted environments.
  }
}

export function getUpdateReadyVersionKey(status: Pick<ShellDeskUpdateStatus, 'version'>) {
  return (status.version || 'unknown').trim() || 'unknown';
}

export function formatUpdateReadyVersion(version: string | null | undefined) {
  const trimmedVersion = version?.trim();

  if (!trimmedVersion) {
    return '';
  }

  return trimmedVersion.toLowerCase().startsWith('v') ? trimmedVersion : `v${trimmedVersion}`;
}

export function readDismissedUpdateReadyVersion() {
  try {
    return window.localStorage.getItem(dismissedUpdateReadyVersionStorageKey) || '';
  } catch {
    return '';
  }
}

export function storeDismissedUpdateReadyVersion(versionKey: string) {
  try {
    window.localStorage.setItem(dismissedUpdateReadyVersionStorageKey, versionKey);
  } catch {
    // Ignore localStorage write failures in restricted environments.
  }
}

export function compareHostText(left: string, right: string, locale: string) {
  return left.localeCompare(right, locale, { numeric: true, sensitivity: 'base' });
}

export function compareHostsByHostListSortMode(left: Host, right: Host, sortMode: HostListSortMode, locale: string) {
  switch (sortMode) {
    case 'lastConnectionDesc': {
      const lastConnectionDiff = getSortableTimestamp(right.lastConnectionAt) - getSortableTimestamp(left.lastConnectionAt);
      return lastConnectionDiff || compareHostsByListOrder(left, right);
    }
    case 'createdAsc': {
      const createdDiff = getSortableTimestamp(left.createdAt) - getSortableTimestamp(right.createdAt);
      return createdDiff || left.id.localeCompare(right.id);
    }
    case 'updatedDesc': {
      const updatedDiff = getSortableTimestamp(right.updatedAt) - getSortableTimestamp(left.updatedAt);
      return updatedDiff || compareHostsByListOrder(left, right);
    }
    case 'updatedAsc': {
      const updatedDiff = getSortableTimestamp(left.updatedAt) - getSortableTimestamp(right.updatedAt);
      return updatedDiff || compareHostsByListOrder(left, right);
    }
    case 'nameAsc': {
      const nameDiff = compareHostText(left.name, right.name, locale);
      return nameDiff || compareHostsByListOrder(left, right);
    }
    case 'nameDesc': {
      const nameDiff = compareHostText(right.name, left.name, locale);
      return nameDiff || compareHostsByListOrder(left, right);
    }
    case 'addressAsc': {
      const addressDiff = compareHostText(`${left.address}:${left.port}`, `${right.address}:${right.port}`, locale);
      return addressDiff || compareHostsByListOrder(left, right);
    }
    case 'createdDesc':
    default:
      return compareHostsByListOrder(left, right);
  }
}

export function readStoredHosts(): Host[] {
  try {
    const rawHosts = window.localStorage.getItem(hostsStorageKey);

    if (!rawHosts) {
      return [];
    }

    const parsedHosts: unknown = JSON.parse(rawHosts);

    if (!Array.isArray(parsedHosts)) {
      return [];
    }

    return normalizeStoredHosts(parsedHosts.filter(isStoredHost));
  } catch {
    return [];
  }
}

export function readStoredTerminalSnippets(fallbackSnippets: ShellDeskTerminalSnippet[]) {
  try {
    const rawSnippets = window.localStorage.getItem(terminalSnippetsStorageKey);

    if (!rawSnippets) {
      return fallbackSnippets;
    }

    const parsedSnippets: unknown = JSON.parse(rawSnippets);

    if (!Array.isArray(parsedSnippets)) {
      return fallbackSnippets;
    }

    const snippets: ShellDeskTerminalSnippet[] = [];
    const seenIds = new Set<string>();

    for (const rawSnippet of parsedSnippets.slice(0, 80)) {
      if (!rawSnippet || typeof rawSnippet !== 'object') {
        continue;
      }

      const snippet = rawSnippet as Partial<ShellDeskTerminalSnippet>;
      const label = typeof snippet.label === 'string' ? snippet.label.trim().slice(0, 80) : '';
      const command = typeof snippet.command === 'string' ? snippet.command.trimEnd().slice(0, 20000) : '';

      if (!label || !command) {
        continue;
      }

      const rawId = typeof snippet.id === 'string' ? snippet.id.slice(0, 128) : '';
      const id = rawId && !seenIds.has(rawId) ? rawId : createId();
      seenIds.add(id);

      snippets.push({
        id,
        label,
        command,
        group: typeof snippet.group === 'string' ? snippet.group.trim().slice(0, 80) : '',
        language: normalizeTerminalSnippetLanguage(snippet.language),
        shortcut: typeof snippet.shortcut === 'string' ? snippet.shortcut.replace(/\s*\+\s*/g, ' + ').trim().slice(0, 80) : '',
        createdAt: typeof snippet.createdAt === 'string' ? snippet.createdAt.slice(0, 64) : new Date().toISOString(),
        updatedAt: typeof snippet.updatedAt === 'string' ? snippet.updatedAt.slice(0, 64) : new Date().toISOString(),
      });
    }

    return snippets.length ? snippets : fallbackSnippets;
  } catch {
    return fallbackSnippets;
  }
}

export function storeTerminalSnippets(snippets: ShellDeskTerminalSnippet[]) {
  try {
    window.localStorage.setItem(terminalSnippetsStorageKey, JSON.stringify(snippets));
  } catch {
    // Ignore localStorage write failures in restricted environments.
  }
}

export function validateHostForm(
  form: HostFormState,
  keys: SshKey[],
  hosts: Host[],
  editingHostId: string | null,
  proxyProfiles: ShellDeskProxyProfile[],
  language: ShellDeskAppSettings['language'],
) {
  const port = Number(form.port);
  const selectedKey = keys.find((key) => key.id === form.keyId);
  const jumpHostId = form.jumpHostId.trim();

  if (!form.name.trim()) {
    return t('app.host.validation.nameRequired', language);
  }

  if (!form.address.trim()) {
    return t('app.host.validation.addressRequired', language);
  }

  if (!form.username.trim()) {
    return t('app.host.validation.usernameRequired', language);
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return t('app.host.validation.invalidPort', language);
  }

  if (form.name.trim().length > 80) {
    return t('app.host.validation.nameTooLong', language);
  }

  if (form.address.trim().length > 255) {
    return t('app.host.validation.addressTooLong', language);
  }

  if (form.username.trim().length > 128) {
    return t('app.host.validation.usernameTooLong', language);
  }

  if (form.authMethod === 'key' && !selectedKey) {
    return t('app.host.validation.keyRequired', language);
  }

  if (jumpHostId) {
    const jumpHost = hosts.find((host) => host.id === jumpHostId) ?? null;

    if (jumpHostId === editingHostId) {
      return t('app.host.validation.jumpHostSelf', language);
    }

    if (!jumpHost) {
      return t('app.host.validation.jumpHostMissing', language);
    }

    if (!jumpHost.canBeJumpHost) {
      return t('app.host.validation.jumpHostUnavailable', language);
    }

    if (jumpHost.jumpHostId) {
      return t('app.host.validation.jumpHostNested', language);
    }
  }

  if (jumpHostId && form.proxyProfileId.trim()) {
    return language === 'zh-CN'
      ? '当前不能同时为目标主机选择代理和跳板机。'
      : 'A target host cannot use a proxy and a jump host at the same time.';
  }

  if (form.proxyProfileId.trim() && !proxyProfiles.some((profile) => profile.id === form.proxyProfileId.trim())) {
    return language === 'zh-CN'
      ? '请选择有效的代理配置。'
      : 'Choose a valid proxy profile.';
  }

  if (editingHostId && !form.canBeJumpHost) {
    const isUsedAsJumpHost = hosts.some((host) => host.id !== editingHostId && host.jumpHostId === editingHostId);

    if (isUsedAsJumpHost) {
      return t('app.host.validation.jumpHostInUse', language);
    }
  }

  if (form.password.length > 4096) {
    return t('app.host.validation.passwordTooLong', language);
  }

  if (form.rootPassword.length > 4096) {
    return t('app.host.validation.rootPasswordTooLong', language);
  }

  if (!isRootLoginUsername(form.username) && form.privilegeMode === 'su-root' && !form.rootPassword) {
    return t('app.host.validation.rootPasswordRequired', language);
  }

  return '';
}

export function createHostFromForm(form: HostFormState, selectedKey: SshKey | null): Host {
  const now = new Date().toISOString();
  const rootLogin = isRootLoginUsername(form.username);
  const privilegeMode = rootLogin ? 'sudo' : form.privilegeMode;
  const keepaliveIntervalMs = (parsePositiveInteger(form.keepaliveIntervalSeconds) ?? defaultKeepaliveIntervalSeconds) * 1000;

  return {
    id: createId(),
    name: form.name.trim(),
    address: form.address.trim(),
    port: Number(form.port),
    username: form.username.trim(),
    authMethod: form.authMethod,
    password: form.authMethod === 'password' ? form.password : '',
    keyId: form.authMethod === 'key' ? selectedKey?.id ?? '' : '',
    keyPath: '',
    passphrase: '',
    privilegeMode,
    rootPassword: privilegeMode === 'su-root' ? form.rootPassword : '',
    jumpHostId: form.jumpHostId.trim(),
    canBeJumpHost: form.canBeJumpHost,
    proxyProfileId: form.proxyProfileId.trim(),
    keepaliveEnabled: form.keepaliveEnabled,
    keepaliveIntervalMs,
    systemType: 'unknown',
    systemName: '',
    hostInfo: null,
    group: form.group.trim(),
    tags: parseTags(form.tags),
    note: form.note.trim(),
    lastConnectionStatus: 'unknown',
    lastConnectionAt: '',
    lastConnectionError: '',
    createdAt: now,
    updatedAt: now,
  };
}

export function updateHostFromForm(host: Host, form: HostFormState, selectedKey: SshKey | null): Host {
  const nextAddress = form.address.trim();
  const addressChanged = host.address !== nextAddress;
  const endpointChanged =
    addressChanged ||
    host.port !== Number(form.port) ||
    host.username !== form.username.trim();
  const nextJumpHostId = form.jumpHostId.trim();
  const nextProxyProfileId = form.proxyProfileId.trim();
  const jumpHostChanged = host.jumpHostId !== nextJumpHostId;
  const proxyProfileChanged = host.proxyProfileId !== nextProxyProfileId;
  const nextPassword = form.authMethod === 'password' ? form.password : '';
  const nextKeyId = form.authMethod === 'key' ? selectedKey?.id ?? '' : '';
  const rootLogin = isRootLoginUsername(form.username);
  const nextPrivilegeMode: PrivilegeMode = rootLogin ? 'sudo' : form.privilegeMode;
  const nextRootPassword = nextPrivilegeMode === 'su-root' ? form.rootPassword : '';
  const nextKeepaliveIntervalMs = (parsePositiveInteger(form.keepaliveIntervalSeconds) ?? defaultKeepaliveIntervalSeconds) * 1000;
  const connectionProfileChanged =
    endpointChanged ||
    jumpHostChanged ||
    proxyProfileChanged ||
    host.authMethod !== form.authMethod ||
    host.password !== nextPassword ||
    host.keyId !== nextKeyId ||
    host.privilegeMode !== nextPrivilegeMode ||
    host.rootPassword !== nextRootPassword ||
    host.keepaliveEnabled !== form.keepaliveEnabled ||
    getKeepaliveIntervalMs(host.keepaliveIntervalMs) !== nextKeepaliveIntervalMs;

  return {
    ...host,
    name: form.name.trim(),
    address: nextAddress,
    port: Number(form.port),
    username: form.username.trim(),
    authMethod: form.authMethod,
    password: nextPassword,
    keyId: nextKeyId,
    keyPath: '',
    passphrase: '',
    privilegeMode: nextPrivilegeMode,
    rootPassword: nextRootPassword,
    jumpHostId: nextJumpHostId,
    canBeJumpHost: form.canBeJumpHost,
    proxyProfileId: nextProxyProfileId,
    keepaliveEnabled: form.keepaliveEnabled,
    keepaliveIntervalMs: nextKeepaliveIntervalMs,
    systemType: addressChanged ? 'unknown' : host.systemType,
    systemName: addressChanged ? '' : host.systemName,
    hostInfo: addressChanged ? null : host.hostInfo,
    group: form.group.trim(),
    tags: parseTags(form.tags),
    note: form.note.trim(),
    lastConnectionStatus: addressChanged || connectionProfileChanged ? 'unknown' : host.lastConnectionStatus,
    lastConnectionAt: addressChanged ? '' : host.lastConnectionAt,
    lastConnectionError: addressChanged || connectionProfileChanged ? '' : host.lastConnectionError,
    updatedAt: new Date().toISOString(),
  };
}

export function toFormState(host: Host): HostFormState {
  return {
    name: host.name,
    address: host.address,
    port: String(host.port),
    username: host.username,
    authMethod: host.authMethod,
    password: host.password,
    keyId: host.keyId,
    keyPath: host.keyPath,
    passphrase: host.passphrase,
    privilegeMode: host.privilegeMode,
    rootPassword: host.rootPassword,
    jumpHostId: host.jumpHostId,
    canBeJumpHost: host.canBeJumpHost,
    proxyProfileId: host.proxyProfileId,
    keepaliveEnabled: host.keepaliveEnabled === true,
    keepaliveIntervalSeconds: String(Math.max(1, Math.round(getKeepaliveIntervalMs(host.keepaliveIntervalMs) / 1000))),
    group: host.group,
    tags: formatTags(host.tags),
    note: host.note,
  };
}

export function getHostGroupKey(host: Host) {
  return host.group || ungroupedKey;
}
