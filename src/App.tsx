import { type FormEvent, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import appIconUrl from './assets/images/icon.png';
import DismissibleAlert from './components/DismissibleAlert';
import NavIcon, { type NavIconName } from './components/navigation/NavIcon';
import type { RemoteConnectionInfo } from './components/remote-desktop/types';
import { buildFontStack } from './fontUtils';
import { getAppLocale, getCurrentAppLanguage, getSystemLanguage, loadFullMessageCatalog, preloadFullMessageCatalog, t, useShellDeskI18n, type AppLanguage, type MessageId } from './i18n';

const RemoteDesktop = lazy(() =>
  Promise.all([loadFullMessageCatalog(), import('./RemoteDesktopShell')]).then(([, module]) => module));
const KeysPage = lazy(() =>
  Promise.all([loadFullMessageCatalog(), import('./pages/KeysPage')]).then(([, module]) => module));
const SnippetsPage = lazy(() =>
  Promise.all([loadFullMessageCatalog(), import('./pages/SnippetsPage')]).then(([, module]) => module));
const LogsPage = lazy(() =>
  Promise.all([loadFullMessageCatalog(), import('./pages/LogsPage')]).then(([, module]) => module));
const SettingsPage = lazy(() =>
  Promise.all([loadFullMessageCatalog(), import('./pages/SettingsPage')]).then(([, module]) => module));

const hostsStorageKey = 'shelldesk:hosts';
const terminalSnippetsStorageKey = 'shelldesk:terminal-snippets';
const hostGroupPanelCollapsedStorageKey = 'shelldesk:host-groups-collapsed';
const hostListSortModeStorageKey = 'shelldesk:host-list-sort-mode';
const dismissedUpdateReadyVersionStorageKey = 'shelldesk:update-ready-dismissed-version';
const ungroupedKey = '__ungrouped__';
const remoteDesktopAppCatalogVersion = 3;
const remoteDesktopAppCatalogMigrationKeys: ShellDeskDesktopAppKey[] = [
  'git-manager',
  'web-server-manager',
  'mongo',
  'search-cluster',
  'message-queue',
  's3-browser',
  'disk-manager',
];
const defaultRemoteDesktopLayout: ShellDeskRemoteDesktopLayout = {
  appCatalogVersion: remoteDesktopAppCatalogVersion,
  sortMode: 'custom',
  items: [
    { id: 'app:files', type: 'app', appKey: 'files' },
    { id: 'app:terminal', type: 'app', appKey: 'terminal' },
    { id: 'app:browser', type: 'app', appKey: 'browser' },
    { id: 'app:settings', type: 'app', appKey: 'settings' },
  ],
};

function createDefaultTerminalSnippets(language: AppLanguage): ShellDeskTerminalSnippet[] {
  const isChinese = language === 'zh-CN';
  const timestamp = '2026-01-01T00:00:00.000Z';
  const group = isChinese ? '常用巡检' : 'Common Checks';
  const snippets = isChinese
    ? [
        ['system-overview', '系统概览', 'uname -a && uptime'],
        ['disk-usage', '磁盘占用', 'df -h'],
        ['memory-usage', '内存占用', 'free -h'],
        ['listening-ports', '监听端口', 'ss -tulpen || netstat -tulpen'],
        ['recent-logins', '最近登录', 'last -a | head -20'],
      ]
    : [
        ['system-overview', 'System overview', 'uname -a && uptime'],
        ['disk-usage', 'Disk usage', 'df -h'],
        ['memory-usage', 'Memory usage', 'free -h'],
        ['listening-ports', 'Listening ports', 'ss -tulpen || netstat -tulpen'],
        ['recent-logins', 'Recent logins', 'last -a | head -20'],
      ];

  return snippets.map(([id, label, command]) => ({
    id: `builtin:${id}`,
    label,
    command,
    group,
    shortcut: '',
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
}

const defaultAppLanguage = getSystemLanguage();

const defaultAppSettings: ShellDeskAppSettings = {
  language: defaultAppLanguage,
  interfaceFont: 'Microsoft YaHei UI',
  theme: 'dark',
  accentColor: '#43c7ff',
  defaultHostView: 'grid',
  minimizeToTrayOnClose: true,
  desktopWallpaperMode: 'preset',
  desktopWallpaperPresetId: 'default',
  desktopWallpaperDataUrl: '',
  desktopWallpaperName: '',
  remoteDesktopLayout: defaultRemoteDesktopLayout,
  rememberPasswords: true,
  rememberKeyPassphrases: true,
  aiProvider: 'openai',
  aiProviderName: 'OpenAI',
  aiApiFormat: 'openai',
  aiApiBaseUrl: 'https://api.openai.com/v1',
  aiApiKey: '',
  aiModel: '',
  terminalFontSize: 13,
  terminalFontFamily: 'Cascadia Mono',
  terminalFontWeight: 400,
  terminalFontWeightBold: 700,
  terminalFontLigatures: true,
  terminalLineHeight: 1.2,
  terminalTheme: 'shelldesk-dark',
  terminalCursorBlink: true,
  terminalCursorStyle: 'block',
  terminalCursorInactiveStyle: 'outline',
  terminalScrollback: 10000,
  terminalScrollSensitivity: 1,
  terminalFastScrollSensitivity: 5,
  terminalScrollOnUserInput: true,
  terminalScrollOnEraseInDisplay: true,
  terminalCopyOnSelect: true,
  terminalRightClickPaste: true,
  terminalAltClickMovesCursor: true,
  terminalBracketedPasteMode: true,
  terminalMinimumContrastRatio: 1,
  terminalScreenReaderMode: false,
  terminalSnippets: createDefaultTerminalSnippets(defaultAppLanguage),
};

type AppPage = 'hosts' | 'keys' | 'snippets' | 'logs' | 'settings';
type HostListSortMode = 'createdDesc' | 'createdAsc' | 'updatedDesc' | 'updatedAsc' | 'nameAsc' | 'nameDesc' | 'addressAsc';
type SyncConflictNotice = Pick<ShellDeskSyncResult, 'conflictCount' | 'conflicts' | 'config'>;
type UpdateReadyNotice = Pick<ShellDeskUpdateStatus, 'version' | 'releaseDate' | 'releaseNotes'>;
type HostSystemType =
  | 'unknown'
  | 'windows'
  | 'macos'
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

const navigationItems: ReadonlyArray<{ page: Exclude<AppPage, 'settings'>; icon: NavIconName; labelId: MessageId }> = [
  { page: 'hosts', icon: 'hosts', labelId: 'app.nav.hosts' },
  { page: 'keys', icon: 'keys', labelId: 'app.nav.keys' },
  { page: 'snippets', icon: 'snippets', labelId: 'app.nav.snippets' },
  { page: 'logs', icon: 'logs', labelId: 'app.nav.logs' },
];

const hostListSortModes: ReadonlyArray<HostListSortMode> = [
  'createdDesc',
  'createdAsc',
  'updatedDesc',
  'updatedAsc',
  'nameAsc',
  'nameDesc',
  'addressAsc',
];

const hostListSortModeLabelIds: Record<HostListSortMode, MessageId> = {
  createdDesc: 'app.host.sort.createdDesc',
  createdAsc: 'app.host.sort.createdAsc',
  updatedDesc: 'app.host.sort.updatedDesc',
  updatedAsc: 'app.host.sort.updatedAsc',
  nameAsc: 'app.host.sort.nameAsc',
  nameDesc: 'app.host.sort.nameDesc',
  addressAsc: 'app.host.sort.addressAsc',
};

const hostSystemLabels: Record<HostSystemType, string> = {
  unknown: '',
  windows: 'Windows',
  macos: 'macOS',
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

function LazyContentFallback({ language }: { language: AppLanguage }) {
  return (
    <div className="empty-state">
      <span>LOADING</span>
      <h3>{t('desktop.window.loading', language)}</h3>
    </div>
  );
}

function RemoteDesktopLoadingFallback({ language }: { language: AppLanguage }) {
  return (
    <main className="remote-desktop-page remote-desktop-boot-page no-drag">
      <section className="remote-desktop-surface remote-desktop-boot-surface" role="status" aria-label={t('desktop.window.loading', language)}>
        <span className="remote-desktop-boot-status">{t('desktop.window.loading', language)}</span>
        <div className="remote-desktop-boot-icons" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </div>
        <div className="remote-desktop-boot-window" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className="remote-desktop-boot-dock" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </section>
    </main>
  );
}

function getHostSystemType(value: unknown, systemName?: unknown): HostSystemType {
  const normalizedValue = typeof value === 'string' ? value.toLowerCase() : '';

  if (normalizedValue in hostSystemLabels && normalizedValue !== 'unknown') {
    return normalizedValue as HostSystemType;
  }

  if (typeof systemName === 'string' && /windows/i.test(systemName)) {
    return 'windows';
  }

  if (typeof systemName === 'string' && /mac\s?os|darwin/i.test(systemName)) {
    return 'macos';
  }

  return 'unknown';
}

function readHexColorChannels(hexColor: string) {
  const match = /^#(?<red>[0-9a-f]{2})(?<green>[0-9a-f]{2})(?<blue>[0-9a-f]{2})$/i.exec(hexColor);

  if (!match?.groups) {
    return { red: 67, green: 199, blue: 255 };
  }

  return {
    red: Number.parseInt(match.groups.red, 16),
    green: Number.parseInt(match.groups.green, 16),
    blue: Number.parseInt(match.groups.blue, 16),
  };
}

function toRgba(hexColor: string, alpha: number) {
  const { red, green, blue } = readHexColorChannels(hexColor);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function getReadableTextColor(hexColor: string) {
  const { red, green, blue } = readHexColorChannels(hexColor);
  const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;

  return luminance > 0.72 ? '#0b1220' : '#ffffff';
}

function getRemoteDesktopLayoutAppKeys(items: ShellDeskDesktopLayoutItem[]) {
  return new Set(items.flatMap((item) => (item.type === 'app' ? [item.appKey] : item.appKeys)));
}

function shouldPreserveCurrentRemoteDesktopLayout(
  currentLayout: ShellDeskRemoteDesktopLayout,
  incomingLayout: ShellDeskRemoteDesktopLayout,
) {
  const currentAppKeys = getRemoteDesktopLayoutAppKeys(currentLayout.items);
  const incomingAppKeys = getRemoteDesktopLayoutAppKeys(incomingLayout.items);

  return remoteDesktopAppCatalogMigrationKeys.some((appKey) => currentAppKeys.has(appKey) && !incomingAppKeys.has(appKey));
}

function protectRemoteDesktopLayoutFromStaleSnapshot(
  incomingSettings: ShellDeskAppSettings,
  currentSettings: ShellDeskAppSettings,
) {
  if (!shouldPreserveCurrentRemoteDesktopLayout(currentSettings.remoteDesktopLayout, incomingSettings.remoteDesktopLayout)) {
    return incomingSettings;
  }

  return {
    ...incomingSettings,
    remoteDesktopLayout: currentSettings.remoteDesktopLayout,
  };
}

function readTerminalSnippetRevision(snippet: ShellDeskTerminalSnippet) {
  const updatedAt = Date.parse(snippet.updatedAt);
  const createdAt = Date.parse(snippet.createdAt);

  return Math.max(
    Number.isFinite(updatedAt) ? updatedAt : 0,
    Number.isFinite(createdAt) ? createdAt : 0,
  );
}

function protectTerminalSnippetsFromStaleSnapshot(
  incomingSettings: ShellDeskAppSettings,
  currentSettings: ShellDeskAppSettings,
) {
  const incomingSnippets = incomingSettings.terminalSnippets ?? [];
  const currentSnippets = currentSettings.terminalSnippets ?? [];

  if (!currentSnippets.length) {
    return incomingSettings;
  }

  const incomingById = new Map(incomingSnippets.map((snippet) => [snippet.id, snippet]));
  const protectedSnippetIds = new Set<string>();

  for (const currentSnippet of currentSnippets) {
    const incomingSnippet = incomingById.get(currentSnippet.id);
    const currentRevision = readTerminalSnippetRevision(currentSnippet);

    if (incomingSnippet) {
      if (currentRevision > readTerminalSnippetRevision(incomingSnippet)) {
        protectedSnippetIds.add(currentSnippet.id);
      }
    } else {
      protectedSnippetIds.add(currentSnippet.id);
    }
  }

  if (!protectedSnippetIds.size) {
    return incomingSettings;
  }

  const nextSnippets: ShellDeskTerminalSnippet[] = [];
  const addedIds = new Set<string>();

  for (const currentSnippet of currentSnippets) {
    if (protectedSnippetIds.has(currentSnippet.id)) {
      nextSnippets.push(currentSnippet);
      addedIds.add(currentSnippet.id);
      continue;
    }

    const incomingSnippet = incomingById.get(currentSnippet.id);

    if (incomingSnippet) {
      nextSnippets.push(incomingSnippet);
      addedIds.add(incomingSnippet.id);
    }
  }

  for (const incomingSnippet of incomingSnippets) {
    if (!addedIds.has(incomingSnippet.id)) {
      nextSnippets.push(incomingSnippet);
    }
  }

  return {
    ...incomingSettings,
    terminalSnippets: nextSnippets,
  };
}

function protectSettingsFromStaleSnapshot(
  incomingSettings: ShellDeskAppSettings,
  currentSettings: ShellDeskAppSettings,
) {
  return protectTerminalSnippetsFromStaleSnapshot(
    protectRemoteDesktopLayoutFromStaleSnapshot(incomingSettings, currentSettings),
    currentSettings,
  );
}

const hostSystemIconUrls: Record<HostSystemType, string> = {
  unknown: new URL('./assets/os-icons/unknown.png', import.meta.url).href,
  windows: new URL('./assets/os-icons/windows.png', import.meta.url).href,
  macos: new URL('./assets/os-icons/macos.png', import.meta.url).href,
  ubuntu: new URL('./assets/os-icons/ubuntu.png', import.meta.url).href,
  debian: new URL('./assets/os-icons/debian.png', import.meta.url).href,
  redhat: new URL('./assets/os-icons/redhat.png', import.meta.url).href,
  centos: new URL('./assets/os-icons/centos.png', import.meta.url).href,
  fedora: new URL('./assets/os-icons/fedora.png', import.meta.url).href,
  rocky: new URL('./assets/os-icons/rocky.png', import.meta.url).href,
  almalinux: new URL('./assets/os-icons/almalinux.png', import.meta.url).href,
  oracle: new URL('./assets/os-icons/oracle.png', import.meta.url).href,
  amazon: new URL('./assets/os-icons/amazon.png', import.meta.url).href,
  arch: new URL('./assets/os-icons/arch.png', import.meta.url).href,
  manjaro: new URL('./assets/os-icons/manjaro.png', import.meta.url).href,
  alpine: new URL('./assets/os-icons/alpine.png', import.meta.url).href,
  opensuse: new URL('./assets/os-icons/opensuse.png', import.meta.url).href,
  linuxmint: new URL('./assets/os-icons/linuxmint.png', import.meta.url).href,
  kali: new URL('./assets/os-icons/kali.png', import.meta.url).href,
  raspbian: new URL('./assets/os-icons/raspbian.png', import.meta.url).href,
  gentoo: new URL('./assets/os-icons/gentoo.png', import.meta.url).href,
  nixos: new URL('./assets/os-icons/nixos.png', import.meta.url).href,
  popos: new URL('./assets/os-icons/popos.png', import.meta.url).href,
  elementary: new URL('./assets/os-icons/elementary.png', import.meta.url).href,
  linux: new URL('./assets/os-icons/linux.png', import.meta.url).href,
  unix: new URL('./assets/os-icons/unix.png', import.meta.url).href,
};

function HostSystemIcon({ systemName, systemType }: { systemName: string; systemType: HostSystemType }) {
  const effectiveSystemType = systemType === 'unknown' ? getHostSystemType(systemType, systemName) : systemType;
  const label = systemName || hostSystemLabels[effectiveSystemType];

  return (
    <span className={`host-avatar host-system-icon host-system-${effectiveSystemType}`} title={label} aria-label={label}>
      <img src={hostSystemIconUrls[effectiveSystemType]} alt="" draggable={false} />
    </span>
  );
}

function HostGroupIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M4.75 8.35c0-1.28 1.04-2.32 2.32-2.32h3.1l1.48 1.72h5.28c1.28 0 2.32 1.04 2.32 2.32v.8H4.75V8.35Z"
        fill="currentColor"
        opacity="0.2"
      />
      <path
        d="M4.75 10.25h14.5v5.38c0 1.28-1.04 2.32-2.32 2.32H7.07a2.32 2.32 0 0 1-2.32-2.32v-5.38Z"
        fill="currentColor"
        opacity="0.32"
      />
      <path
        d="M4.75 10.25V8.35c0-1.28 1.04-2.32 2.32-2.32h3.1l1.48 1.72h5.28c1.28 0 2.32 1.04 2.32 2.32v5.56c0 1.28-1.04 2.32-2.32 2.32H7.07a2.32 2.32 0 0 1-2.32-2.32v-5.38Z"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.55"
      />
      <path
        d="M8.25 12.85h4.85M8.25 15.15h2.8"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.55"
      />
      <path d="M15.2 14.95h2.3" stroke="currentColor" strokeLinecap="round" strokeWidth="1.55" />
      <circle cx="16.35" cy="14.95" r="1.15" fill="currentColor" />
    </svg>
  );
}

interface SshKey {
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

interface KeyFormState {
  name: string;
  privateKeyPath: string;
  publicKeyPath: string;
  passphrase: string;
  modulusLength: '2048' | '3072' | '4096';
}

const emptyKeyForm: KeyFormState = {
  name: '',
  privateKeyPath: '',
  publicKeyPath: '',
  passphrase: '',
  modulusLength: '4096',
};

const keyPathSeparators = /[\\/]+/;

function getKeyNameFromPath(keyPath: string) {
  const fileName = keyPath.split(keyPathSeparators).filter(Boolean).pop() ?? 'SSH Key';
  return fileName.replace(/\.(pem|key|ppk|openssh)$/i, '') || fileName;
}

function isStoredSshKey(value: unknown): value is SshKey {
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

type KeyEditorMode = 'import' | 'generate' | 'edit';

function validateKeyForm(form: KeyFormState, mode: KeyEditorMode, language: ShellDeskAppSettings['language']) {
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

function updateSshKeyFromForm(key: SshKey, form: KeyFormState): SshKey {
  return {
    ...key,
    name: form.name.trim(),
    passphrase: form.passphrase,
    updatedAt: new Date().toISOString(),
  };
}

function toKeyFormState(key: SshKey): KeyFormState {
  return {
    name: key.name,
    privateKeyPath: '',
    publicKeyPath: '',
    passphrase: key.passphrase,
    modulusLength: '4096',
  };
}

type AuthMethod = 'password' | 'key';
type ConnectionAuthMethod = AuthMethod | 'agent';
type HostConnectionStatus = 'unknown' | 'success' | 'failed';
type PrivilegeMode = 'sudo' | 'su-root';

interface Host {
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
  systemType: HostSystemType;
  systemName: string;
  group: string;
  tags: string[];
  note: string;
  lastConnectionStatus: HostConnectionStatus;
  lastConnectionAt: string;
  lastConnectionError: string;
  createdAt: string;
  updatedAt: string;
}

interface ConnectionHost extends Omit<Host, 'authMethod'> {
  authMethod: ConnectionAuthMethod;
}

interface VaultCollectionsSavePayload {
  hosts: Host[];
  sshKeys: SshKey[];
  settings: ShellDeskAppSettings;
}

type SettingsUpdate = ShellDeskAppSettings | ((currentSettings: ShellDeskAppSettings) => ShellDeskAppSettings);

interface ConnectionErrorNotice {
  hostName: string;
  endpoint: string;
  message: string;
}

type ConnectionLaunchSource = 'host-card' | 'quick-connect' | 'credential';

type StoredHost = Omit<Host, 'authMethod' | 'password' | 'keyId' | 'keyPath' | 'passphrase' | 'privilegeMode' | 'rootPassword' | 'jumpHostId' | 'canBeJumpHost' | 'systemType' | 'systemName' | 'lastConnectionStatus' | 'lastConnectionAt' | 'lastConnectionError'> &
  Partial<Pick<Host, 'authMethod' | 'password' | 'keyId' | 'keyPath' | 'passphrase' | 'privilegeMode' | 'rootPassword' | 'jumpHostId' | 'canBeJumpHost' | 'systemType' | 'systemName' | 'lastConnectionStatus' | 'lastConnectionAt' | 'lastConnectionError'>>;

interface HostFormState {
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
  group: string;
  tags: string;
  note: string;
}

interface HostGroup {
  key: string;
  name: string;
  count: number;
}

type DeleteConfirmationRequest =
  | { kind: 'host'; host: Host }
  | { kind: 'host-jump-blocked'; host: Host; dependentHosts: Host[] }
  | { kind: 'ssh-key'; key: SshKey; relatedHostCount: number };

interface ConnectionClosedPayload {
  connectionId: string;
  reason?: string;
}

interface ConnectionReconnectingPayload {
  connectionId: string;
  reason?: string;
}

interface ConnectionRestoredPayload {
  connectionId: string;
}

export type LogCategory = 'connection' | 'host' | 'key' | 'config' | 'system';
export type LogLevel = 'info' | 'success' | 'warning' | 'error';

export interface LogEntry {
  id: string;
  timestamp: string;
  category: LogCategory;
  level: LogLevel;
  message: string;
  detail: string;
}

interface CredentialFormState {
  authMethod: AuthMethod;
  password: string;
  keyId: string;
  passphrase: string;
  saveCredential: boolean;
}

const emptyHostForm: HostFormState = {
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
  group: '',
  tags: '',
  note: '',
};

const emptyCredentialForm: CredentialFormState = {
  authMethod: 'password',
  password: '',
  keyId: '',
  passphrase: '',
  saveCredential: true,
};

function createId() {
  if ('randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getErrorMessage(error: unknown, language: ShellDeskAppSettings['language'] = getCurrentAppLanguage()) {
  if (error instanceof Error && error.message) {
    return error.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
  }

  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }

  return t('app.error.operationFailed', language);
}

function isAuthFailureMessage(message: string) {
  return /\u8ba4\u8bc1\u5931\u8d25|authentication methods failed|password|private key|passphrase|\u5bc6\u94a5|\u53e3\u4ee4/i.test(message);
}

function shouldHoldStatusMessage(message: string) {
  return /\u5931\u8d25|\u8d85\u65f6|\u65ad\u5f00|\u62d2\u7edd|\u91cd\u7f6e|\u4e0d\u53ef\u7528|\u65e0\u6548|fail|timeout|disconnect|closed|refused|reset|unavailable|invalid/i.test(message);
}

function parseTags(value: string) {
  return value
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function formatTags(tags: string[]) {
  return tags.join(', ');
}

function getAuthMethod(value: unknown): AuthMethod {
  return value === 'key' ? 'key' : 'password';
}

function getPrivilegeMode(value: unknown): PrivilegeMode {
  return value === 'su-root' ? 'su-root' : 'sudo';
}

function isRootLoginUsername(username: string) {
  return username.trim().toLowerCase() === 'root';
}

function getHostConnectionStatus(value: unknown): HostConnectionStatus {
  return value === 'success' || value === 'failed' ? value : 'unknown';
}

function getAuthLabel(host: Pick<Host, 'authMethod' | 'password'>, key: SshKey | null, language: ShellDeskAppSettings['language']) {
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

function getHostSystemLabel(host: Pick<Host, 'systemName' | 'systemType'>, language: ShellDeskAppSettings['language']) {
  return host.systemName || hostSystemLabels[host.systemType] || t('app.system.unknown', language);
}

function getHostConnectionStateView(host: Pick<Host, 'lastConnectionStatus' | 'lastConnectionAt' | 'lastConnectionError'>, language: ShellDeskAppSettings['language']) {
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

function isStoredHost(value: unknown): value is StoredHost {
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

function normalizeStoredHost(host: StoredHost): Host {
  return {
    ...host,
    authMethod: getAuthMethod(host.authMethod),
    password: typeof host.password === 'string' ? host.password : '',
    keyId: typeof host.keyId === 'string' ? host.keyId : '',
    keyPath: typeof host.keyPath === 'string' ? host.keyPath : '',
    passphrase: typeof host.passphrase === 'string' ? host.passphrase : '',
    privilegeMode: getPrivilegeMode(host.privilegeMode),
    rootPassword: getPrivilegeMode(host.privilegeMode) === 'su-root' && typeof host.rootPassword === 'string' ? host.rootPassword : '',
    jumpHostId: typeof host.jumpHostId === 'string' ? host.jumpHostId : '',
    canBeJumpHost: host.canBeJumpHost === true,
    systemType: getHostSystemType(host.systemType, host.systemName),
    systemName: typeof host.systemName === 'string' ? host.systemName : '',
    lastConnectionStatus: getHostConnectionStatus(host.lastConnectionStatus),
    lastConnectionAt: typeof host.lastConnectionAt === 'string' ? host.lastConnectionAt : '',
    lastConnectionError: typeof host.lastConnectionError === 'string' ? host.lastConnectionError : '',
  };
}

function getSortableTimestamp(value: string) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function compareHostsByListOrder(left: Pick<Host, 'id' | 'createdAt' | 'updatedAt'>, right: Pick<Host, 'id' | 'createdAt' | 'updatedAt'>) {
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

function sortHostsByListOrder(hosts: Host[]) {
  return [...hosts].sort(compareHostsByListOrder);
}

function preserveReferencedJumpHostCapability(hosts: Host[]) {
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

function sanitizeHostJumpHostReferences(hosts: Host[]) {
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

function normalizeStoredHosts(hosts: StoredHost[]) {
  return sortHostsByListOrder(sanitizeHostJumpHostReferences(hosts.map(normalizeStoredHost)));
}

function isHostListSortMode(value: unknown): value is HostListSortMode {
  return typeof value === 'string' && hostListSortModes.includes(value as HostListSortMode);
}

function readHostListSortMode(): HostListSortMode {
  try {
    return getHostListSortMode(window.localStorage.getItem(hostListSortModeStorageKey));
  } catch {
    return 'createdDesc';
  }
}

function storeHostListSortMode(sortMode: HostListSortMode) {
  try {
    window.localStorage.setItem(hostListSortModeStorageKey, sortMode);
  } catch {
    // Ignore localStorage write failures in restricted environments.
  }
}

function getHostListSortMode(value: unknown): HostListSortMode {
  return isHostListSortMode(value) ? value : 'createdDesc';
}

function getUpdateReadyVersionKey(status: Pick<ShellDeskUpdateStatus, 'version'>) {
  return (status.version || 'unknown').trim() || 'unknown';
}

function formatUpdateReadyVersion(version: string | null | undefined) {
  const trimmedVersion = version?.trim();

  if (!trimmedVersion) {
    return '';
  }

  return trimmedVersion.toLowerCase().startsWith('v') ? trimmedVersion : `v${trimmedVersion}`;
}

function readDismissedUpdateReadyVersion() {
  try {
    return window.localStorage.getItem(dismissedUpdateReadyVersionStorageKey) || '';
  } catch {
    return '';
  }
}

function storeDismissedUpdateReadyVersion(versionKey: string) {
  try {
    window.localStorage.setItem(dismissedUpdateReadyVersionStorageKey, versionKey);
  } catch {
    // Ignore localStorage write failures in restricted environments.
  }
}

function compareHostText(left: string, right: string, locale: string) {
  return left.localeCompare(right, locale, { numeric: true, sensitivity: 'base' });
}

function compareHostsByHostListSortMode(left: Host, right: Host, sortMode: HostListSortMode, locale: string) {
  switch (sortMode) {
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

function readStoredHosts(): Host[] {
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

function readStoredTerminalSnippets(fallbackSnippets: ShellDeskTerminalSnippet[]) {
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

function storeTerminalSnippets(snippets: ShellDeskTerminalSnippet[]) {
  try {
    window.localStorage.setItem(terminalSnippetsStorageKey, JSON.stringify(snippets));
  } catch {
    // Ignore localStorage write failures in restricted environments.
  }
}

function readHostGroupPanelCollapsed() {
  try {
    const storedValue = window.localStorage.getItem(hostGroupPanelCollapsedStorageKey);

    return storedValue == null ? true : storedValue === 'true';
  } catch {
    return true;
  }
}

function storeHostGroupPanelCollapsed(collapsed: boolean) {
  try {
    window.localStorage.setItem(hostGroupPanelCollapsedStorageKey, collapsed ? 'true' : 'false');
  } catch {
    // Ignore localStorage write failures in restricted environments.
  }
}

function validateHostForm(
  form: HostFormState,
  keys: SshKey[],
  hosts: Host[],
  editingHostId: string | null,
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

function createHostFromForm(form: HostFormState, selectedKey: SshKey | null): Host {
  const now = new Date().toISOString();
  const rootLogin = isRootLoginUsername(form.username);
  const privilegeMode = rootLogin ? 'sudo' : form.privilegeMode;

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
    systemType: 'unknown',
    systemName: '',
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

function updateHostFromForm(host: Host, form: HostFormState, selectedKey: SshKey | null): Host {
  const endpointChanged =
    host.address !== form.address.trim() ||
    host.port !== Number(form.port) ||
    host.username !== form.username.trim();
  const nextJumpHostId = form.jumpHostId.trim();
  const jumpHostChanged = host.jumpHostId !== nextJumpHostId;
  const nextPassword = form.authMethod === 'password' ? form.password : '';
  const nextKeyId = form.authMethod === 'key' ? selectedKey?.id ?? '' : '';
  const rootLogin = isRootLoginUsername(form.username);
  const nextPrivilegeMode: PrivilegeMode = rootLogin ? 'sudo' : form.privilegeMode;
  const nextRootPassword = nextPrivilegeMode === 'su-root' ? form.rootPassword : '';
  const connectionProfileChanged =
    endpointChanged ||
    jumpHostChanged ||
    host.authMethod !== form.authMethod ||
    host.password !== nextPassword ||
    host.keyId !== nextKeyId ||
    host.privilegeMode !== nextPrivilegeMode ||
    host.rootPassword !== nextRootPassword;

  return {
    ...host,
    name: form.name.trim(),
    address: form.address.trim(),
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
    systemType: endpointChanged || jumpHostChanged ? 'unknown' : host.systemType,
    systemName: endpointChanged || jumpHostChanged ? '' : host.systemName,
    group: form.group.trim(),
    tags: parseTags(form.tags),
    note: form.note.trim(),
    lastConnectionStatus: connectionProfileChanged ? 'unknown' : host.lastConnectionStatus,
    lastConnectionAt: connectionProfileChanged ? '' : host.lastConnectionAt,
    lastConnectionError: connectionProfileChanged ? '' : host.lastConnectionError,
    updatedAt: new Date().toISOString(),
  };
}

function toFormState(host: Host): HostFormState {
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
    group: host.group,
    tags: formatTags(host.tags),
    note: host.note,
  };
}

function getHostGroupKey(host: Host) {
  return host.group || ungroupedKey;
}

function readWindowConnectionId() {
  return new URLSearchParams(window.location.search).get('connectionId')?.trim() ?? '';
}

function tokenizeQuickConnectInput(value: string) {
  return Array.from(value.matchAll(/"([^"]*)"|'([^']*)'|[^\s]+/g), (match) => match[1] ?? match[2] ?? match[0]);
}

function isValidQuickConnectPort(value: string) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function parseQuickConnectDestination(value: string) {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return null;
  }

  const atIndex = trimmedValue.lastIndexOf('@');
  const userPart = atIndex >= 0 ? trimmedValue.slice(0, atIndex).trim() : '';
  const hostPart = atIndex >= 0 ? trimmedValue.slice(atIndex + 1).trim() : trimmedValue;
  const lastColonIndex = hostPart.lastIndexOf(':');
  const hasPortSuffix = lastColonIndex > 0 && hostPart.indexOf(']') === -1;
  const address = hasPortSuffix ? hostPart.slice(0, lastColonIndex).trim() : hostPart.trim();
  const portText = hasPortSuffix ? hostPart.slice(lastColonIndex + 1).trim() : '';

  if (!userPart || !address) {
    return null;
  }

  if (portText && !isValidQuickConnectPort(portText)) {
    return null;
  }

  return {
    username: userPart,
    address,
    port: portText ? Number(portText) : 22,
    keyPath: '',
  };
}

function parseQuickConnectCommand(value: string) {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return null;
  }

  if (!trimmedValue.startsWith('ssh ')) {
    return parseQuickConnectDestination(trimmedValue);
  }

  const tokens = tokenizeQuickConnectInput(trimmedValue);

  if (!tokens.length || tokens[0] !== 'ssh') {
    return null;
  }

  let username = '';
  let address = '';
  let port = 22;
  let keyPath = '';

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token === '-p' || token === '-l' || token === '-i') {
      const nextToken = tokens[index + 1];

      if (!nextToken) {
        return null;
      }

      if (token === '-p') {
        if (!isValidQuickConnectPort(nextToken)) {
          return null;
        }

        port = Number(nextToken);
      } else if (token === '-l') {
        username = nextToken.trim();
      } else {
        keyPath = nextToken.trim();
      }

      index += 1;
      continue;
    }

    if (token.startsWith('-p') && token.length > 2) {
      const inlinePort = token.slice(2);

      if (!isValidQuickConnectPort(inlinePort)) {
        return null;
      }

      port = Number(inlinePort);
      continue;
    }

    if (token.startsWith('-l') && token.length > 2) {
      username = token.slice(2).trim();
      continue;
    }

    if (token.startsWith('-i') && token.length > 2) {
      keyPath = token.slice(2).trim();
      continue;
    }

    if (token.startsWith('-')) {
      return null;
    }

    if (address) {
      return null;
    }

    const destination = parseQuickConnectDestination(username ? `${username}@${token}` : token);

    if (!destination) {
      return null;
    }

    username = destination.username;
    address = destination.address;

    if (destination.port !== 22) {
      port = destination.port;
    }
  }

  if (!username || !address) {
    return null;
  }

  return {
    username,
    address,
    port,
    keyPath,
  };
}

function App() {
  const initialPublicSnapshotRef = useRef<ShellDeskVaultSnapshot | null>(window.guiSSH?.vault?.initialPublicSnapshot ?? null);
  const initialPublicSnapshot = initialPublicSnapshotRef.current;
  const [hosts, setHosts] = useState<Host[]>(() => (
    initialPublicSnapshot
      ? normalizeStoredHosts(initialPublicSnapshot.hosts.filter(isStoredHost))
      : (window.guiSSH?.vault ? [] : readStoredHosts())
  ));
  const [sshKeys, setSshKeys] = useState<SshKey[]>(() => (
    initialPublicSnapshot ? initialPublicSnapshot.sshKeys.filter(isStoredSshKey) : []
  ));
  const [form, setForm] = useState<HostFormState>(emptyHostForm);
  const [keyForm, setKeyForm] = useState<KeyFormState>(emptyKeyForm);
  const [editingHostId, setEditingHostId] = useState<string | null>(null);
  const [editingKeyId, setEditingKeyId] = useState<string | null>(null);
  const [keyEditorMode, setKeyEditorMode] = useState<KeyEditorMode>('import');
  const [activePage, setActivePage] = useState<AppPage>('hosts');
  const [searchQuery, setSearchQuery] = useState('');
  const [keySearchQuery, setKeySearchQuery] = useState('');
  const [activeGroupKey, setActiveGroupKey] = useState<string | null>(null);
  const [isHostGroupPanelCollapsed, setIsHostGroupPanelCollapsed] = useState(readHostGroupPanelCollapsed);
  const [hostListSortMode, setHostListSortMode] = useState<HostListSortMode>(readHostListSortMode);
  const [formError, setFormError] = useState('');
  const [keyFormError, setKeyFormError] = useState('');
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [isKeyEditorOpen, setIsKeyEditorOpen] = useState(false);
  const [settings, setSettings] = useState<ShellDeskAppSettings>(() => {
    if (initialPublicSnapshot) {
      return initialPublicSnapshot.settings;
    }

    if (window.guiSSH?.vault) {
      return defaultAppSettings;
    }

    return {
      ...defaultAppSettings,
      terminalSnippets: readStoredTerminalSnippets(defaultAppSettings.terminalSnippets),
    };
  });
  const [storageInfo, setStorageInfo] = useState<ShellDeskStorageInfo | null>(initialPublicSnapshot?.storage ?? null);
  const [bookmarkCount, setBookmarkCount] = useState(() => (
    initialPublicSnapshot?.browserBookmarks.reduce((total, collection) => total + collection.bookmarks.length, 0) ?? 0
  ));
  const [isVaultReady, setIsVaultReady] = useState(Boolean(initialPublicSnapshot) || !window.guiSSH?.vault);
  const [isVaultHydrated, setIsVaultHydrated] = useState(!window.guiSSH?.vault);
  const [isLogsReady, setIsLogsReady] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [connection, setConnection] = useState<RemoteConnectionInfo | null>(null);
  const [windowConnectionId] = useState(readWindowConnectionId);
  const [isWindowMaximized, setIsWindowMaximized] = useState(false);
  const [windowConnectionError, setWindowConnectionError] = useState('');
  const [connectingHostId, setConnectingHostId] = useState<string | null>(null);
  const [isQuickConnecting, setIsQuickConnecting] = useState(false);
  const [isCredentialConnecting, setIsCredentialConnecting] = useState(false);
  const [connectionErrorNotice, setConnectionErrorNotice] = useState<ConnectionErrorNotice | null>(null);
  const [syncConflictCount, setSyncConflictCount] = useState(0);
  const [syncConflictNotice, setSyncConflictNotice] = useState<SyncConflictNotice | null>(null);
  const [syncResolutionPending, setSyncResolutionPending] = useState<ShellDeskSyncConflictResolution | ''>('');
  const [syncResolutionError, setSyncResolutionError] = useState('');
  const [updateReadyNotice, setUpdateReadyNotice] = useState<UpdateReadyNotice | null>(null);
  const [updateInstallPending, setUpdateInstallPending] = useState(false);
  const [updateInstallError, setUpdateInstallError] = useState('');
  const [credentialHost, setCredentialHost] = useState<ConnectionHost | null>(null);
  const [credentialForm, setCredentialForm] = useState<CredentialFormState>(emptyCredentialForm);
  const [credentialError, setCredentialError] = useState('');
  const [isConfigTransferPending, setIsConfigTransferPending] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState<DeleteConfirmationRequest | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const hostsRef = useRef(hosts);
  const sshKeysRef = useRef(sshKeys);
  const settingsRef = useRef(settings);
  const lastPersistedCollectionsRef = useRef('');
  const collectionsSaveInFlightRef = useRef(false);
  const collectionsSaveInFlightSerializedRef = useRef('');
  const collectionsSavePromiseRef = useRef<Promise<void> | null>(null);
  const pendingCollectionsSaveRef = useRef<{ payload: VaultCollectionsSavePayload; serialized: string } | null>(null);
  const lastPersistedLogsRef = useRef('');
  const platform = window.guiSSH?.platform;
  const windowControls = window.guiSSH?.window;
  const vaultControls = window.guiSSH?.vault;
  const isMacOS = platform === 'darwin';
  const showWindowControls = Boolean(windowControls) && !isMacOS;
  const isConnectionWindow = Boolean(windowConnectionId);
  const titlebarConnectionAddress = connection
    ? `${connection.host.username}@${connection.host.address}:${connection.host.port}`
    : '';
  const isConnectionPending = Boolean(connectingHostId) || isQuickConnecting || isCredentialConnecting;
  const editingHost = hosts.find((host) => host.id === editingHostId) ?? null;
  const editingKey = sshKeys.find((key) => key.id === editingKeyId) ?? null;
  const sshKeyById = useMemo(() => new Map(sshKeys.map((key) => [key.id, key])), [sshKeys]);
  const hostById = useMemo(() => new Map(hosts.map((host) => [host.id, host])), [hosts]);
  const jumpHostOptions = useMemo(
    () => hosts.filter((host) => host.id !== editingHostId && host.canBeJumpHost && !host.jumpHostId),
    [editingHostId, hosts],
  );
  const appLanguage = settings.language;
  const appLocale = getAppLocale(appLanguage);

  useShellDeskI18n(appLanguage);

  const hostGroups = useMemo<HostGroup[]>(() => {
    const groups = new Map<string, HostGroup>();

    for (const host of hosts) {
      const key = getHostGroupKey(host);
      const name = host.group || t('app.host.group.ungrouped', appLanguage);
      const currentGroup = groups.get(key);

      groups.set(key, {
        key,
        name,
        count: (currentGroup?.count ?? 0) + 1,
      });
    }

    return Array.from(groups.values()).sort((left, right) => left.name.localeCompare(right.name, appLocale));
  }, [appLanguage, appLocale, hosts]);

  const filteredHosts = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    return hosts.filter((host) => {
      const hostKey = sshKeyById.get(host.keyId) ?? null;
      const jumpHost = host.jumpHostId ? hostById.get(host.jumpHostId) ?? null : null;
      const matchesGroup = !activeGroupKey || getHostGroupKey(host) === activeGroupKey;
      const matchesQuery =
        !query ||
        [
          host.name,
          host.address,
          host.username,
          host.group,
          host.note,
          host.systemName,
          hostSystemLabels[host.systemType],
          hostKey?.name,
          hostKey?.fingerprint,
          hostKey?.algorithm,
          jumpHost?.name,
          jumpHost?.address,
          getAuthLabel(host, hostKey, appLanguage),
          ...host.tags,
        ]
          .join(' ')
          .toLowerCase()
          .includes(query);

      return matchesGroup && matchesQuery;
    }).sort((left, right) => compareHostsByHostListSortMode(left, right, hostListSortMode, appLocale));
  }, [activeGroupKey, appLanguage, appLocale, hostById, hostListSortMode, hosts, searchQuery, sshKeyById]);

  const filteredKeys = useMemo(() => {
    const query = keySearchQuery.trim().toLowerCase();

    return sshKeys.filter((key) => {
      if (!query) {
        return true;
      }

      return [key.name, key.algorithm, key.fingerprint].join(' ').toLowerCase().includes(query);
    });
  }, [keySearchQuery, sshKeys]);

  const activeGroupName = hostGroups.find((group) => group.key === activeGroupKey)?.name;

  const getSelectedSshKey = (host: Pick<Host, 'keyId'>) => sshKeyById.get(host.keyId) ?? null;

  const applyVaultSnapshot = (snapshot: ShellDeskVaultSnapshot, options: { updateCollections?: boolean; hydrated?: boolean } = {}) => {
    const { updateCollections = true, hydrated = true } = options;

    const nextSettings = protectSettingsFromStaleSnapshot(snapshot.settings, settingsRef.current);
    const shouldRepairPersistedSettings = nextSettings !== snapshot.settings;

    if (updateCollections) {
      const nextHosts = normalizeStoredHosts(snapshot.hosts.filter(isStoredHost));
      const nextKeys = snapshot.sshKeys.filter(isStoredSshKey);

      hostsRef.current = nextHosts;
      sshKeysRef.current = nextKeys;
      setHosts(nextHosts);
      setSshKeys(nextKeys);

      if (hydrated) {
        lastPersistedCollectionsRef.current = JSON.stringify({
          hosts: nextHosts,
          sshKeys: nextKeys,
          settings: shouldRepairPersistedSettings ? snapshot.settings : nextSettings,
        });
      }
    }

    settingsRef.current = nextSettings;
    setSettings(nextSettings);
    setStorageInfo(snapshot.storage);
    setBookmarkCount(snapshot.browserBookmarks.reduce((total: number, collection: ShellDeskBrowserBookmarkCollection) => total + collection.bookmarks.length, 0));
    setIsVaultReady(true);

    if (hydrated) {
      setIsVaultHydrated(true);
    }

    if (shouldRepairPersistedSettings) {
      queueCollectionsSaveIfChanged({
        hosts: hostsRef.current,
        sshKeys: sshKeysRef.current,
        settings: nextSettings,
      });
    }
  };

  const flushCollectionsSave = useCallback(() => {
    if (!vaultControls || collectionsSaveInFlightRef.current) {
      return;
    }

    const pendingSave = pendingCollectionsSaveRef.current;

    if (!pendingSave) {
      return;
    }

    pendingCollectionsSaveRef.current = null;
    collectionsSaveInFlightRef.current = true;
    collectionsSaveInFlightSerializedRef.current = pendingSave.serialized;

    const savePromise = vaultControls.saveCollections(pendingSave.payload).then((snapshot) => {
      lastPersistedCollectionsRef.current = pendingSave.serialized;
      setStorageInfo(snapshot.storage);
      setBookmarkCount(snapshot.browserBookmarks.reduce((total: number, collection: ShellDeskBrowserBookmarkCollection) => total + collection.bookmarks.length, 0));
    }).catch((error: unknown) => {
      const currentLanguage = getCurrentAppLanguage();
      setStatusMessage(t('app.status.saveLocalFailed', currentLanguage, { error: getErrorMessage(error, currentLanguage) }));
    }).finally(() => {
      collectionsSaveInFlightRef.current = false;
      collectionsSaveInFlightSerializedRef.current = '';
      if (collectionsSavePromiseRef.current === savePromise) {
        collectionsSavePromiseRef.current = null;
      }

      if (pendingCollectionsSaveRef.current) {
        flushCollectionsSave();
      }
    });

    collectionsSavePromiseRef.current = savePromise;
    void savePromise;
  }, [vaultControls]);

  const scheduleCollectionsSave = useCallback((payload: VaultCollectionsSavePayload, serialized: string) => {
    if (pendingCollectionsSaveRef.current?.serialized === serialized) {
      return;
    }

    if (collectionsSaveInFlightSerializedRef.current === serialized) {
      pendingCollectionsSaveRef.current = null;
      return;
    }

    pendingCollectionsSaveRef.current = { payload, serialized };
    flushCollectionsSave();
  }, [flushCollectionsSave]);

  const queueCollectionsSaveIfChanged = useCallback((payload: VaultCollectionsSavePayload) => {
    if (!vaultControls || !isVaultReady || !isVaultHydrated) {
      return;
    }

    const serializedPayload = JSON.stringify(payload);

    if (serializedPayload === lastPersistedCollectionsRef.current) {
      return;
    }

    scheduleCollectionsSave(payload, serializedPayload);
  }, [isVaultHydrated, isVaultReady, scheduleCollectionsSave, vaultControls]);

  const persistCurrentCollections = useCallback(async () => {
    if (!vaultControls || !isVaultReady || !isVaultHydrated) {
      return;
    }

    if (collectionsSavePromiseRef.current) {
      await collectionsSavePromiseRef.current;
    }

    const payload: VaultCollectionsSavePayload = {
      hosts: hostsRef.current,
      sshKeys: sshKeysRef.current,
      settings: settingsRef.current,
    };
    const serializedPayload = JSON.stringify(payload);

    if (serializedPayload === lastPersistedCollectionsRef.current) {
      return;
    }

    pendingCollectionsSaveRef.current = null;
    collectionsSaveInFlightRef.current = true;
    collectionsSaveInFlightSerializedRef.current = serializedPayload;

    const savePromise = vaultControls.saveCollections(payload).then((snapshot) => {
      lastPersistedCollectionsRef.current = serializedPayload;
      setStorageInfo(snapshot.storage);
      setBookmarkCount(snapshot.browserBookmarks.reduce((total: number, collection: ShellDeskBrowserBookmarkCollection) => total + collection.bookmarks.length, 0));
    }).finally(() => {
      collectionsSaveInFlightRef.current = false;
      collectionsSaveInFlightSerializedRef.current = '';
      if (collectionsSavePromiseRef.current === savePromise) {
        collectionsSavePromiseRef.current = null;
      }

      if (pendingCollectionsSaveRef.current) {
        flushCollectionsSave();
      }
    });

    collectionsSavePromiseRef.current = savePromise;
    await savePromise;
  }, [flushCollectionsSave, isVaultHydrated, isVaultReady, vaultControls]);

  const commitCollectionsState = useCallback((
    nextHosts: Host[],
    nextSshKeys: SshKey[],
    nextSettings: ShellDeskAppSettings,
  ) => {
    const orderedHosts = sortHostsByListOrder(sanitizeHostJumpHostReferences(nextHosts));

    hostsRef.current = orderedHosts;
    sshKeysRef.current = nextSshKeys;
    settingsRef.current = nextSettings;
    setHosts(orderedHosts);
    setSshKeys(nextSshKeys);
    setSettings(nextSettings);
    if (!vaultControls) {
      storeTerminalSnippets(nextSettings.terminalSnippets ?? []);
    }
    queueCollectionsSaveIfChanged({ hosts: orderedHosts, sshKeys: nextSshKeys, settings: nextSettings });
  }, [queueCollectionsSaveIfChanged, vaultControls]);

  const commitHosts = useCallback((nextHosts: Host[]) => {
    commitCollectionsState(nextHosts, sshKeysRef.current, settingsRef.current);
  }, [commitCollectionsState]);

  const commitSshKeys = useCallback((nextSshKeys: SshKey[]) => {
    commitCollectionsState(hostsRef.current, nextSshKeys, settingsRef.current);
  }, [commitCollectionsState]);

  const refreshHosts = async () => {
    if (!vaultControls) {
      const nextHosts = readStoredHosts();
      hostsRef.current = nextHosts;
      setHosts(nextHosts);
      setStatusMessage(t('app.status.hostsRefreshed', appLanguage, { count: String(nextHosts.length) }));
      return;
    }

    try {
      const snapshot = await vaultControls.getSnapshot();
      applyVaultSnapshot(snapshot);
      setStatusMessage(t('app.status.hostsRefreshed', appLanguage, { count: String(snapshot.hosts.length) }));
    } catch (error) {
      setStatusMessage(t('app.status.refreshHostsFailed', appLanguage, { error: getErrorMessage(error, appLanguage) }));
    }
  };

  const updateSyncConflictNotice = useCallback((config: ShellDeskSyncPublicConfig, conflicts: ShellDeskSyncConflict[] = []) => {
    const pendingCount = config.lastConflictCount > 0 ? config.lastConflictCount : 0;

    setSyncConflictCount(pendingCount);

    if (pendingCount) {
      setSyncConflictNotice({
        conflictCount: pendingCount,
        conflicts,
        config,
      });
    } else {
      setSyncConflictNotice(null);
      setSyncResolutionError('');
    }
  }, []);

  const showUpdateReadyNotice = useCallback((status: ShellDeskUpdateStatus) => {
    if (status.status !== 'ready') {
      return;
    }

    const versionKey = getUpdateReadyVersionKey(status);

    if (readDismissedUpdateReadyVersion() === versionKey) {
      return;
    }

    setUpdateReadyNotice({
      version: status.version,
      releaseDate: status.releaseDate,
      releaseNotes: status.releaseNotes,
    });
    setUpdateInstallError('');
  }, []);

  useEffect(() => {
    hostsRef.current = hosts;
  }, [hosts]);

  useEffect(() => {
    sshKeysRef.current = sshKeys;
  }, [sshKeys]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    if (!windowConnectionId) {
      return;
    }

    if (!window.guiSSH?.connections) {
      setWindowConnectionError(t('app.connection.windowUnsupported', appLanguage));
      return;
    }

    let disposed = false;

    window.guiSSH.connections
      .getInfo(windowConnectionId)
      .then((nextConnection) => {
        if (!disposed) {
          setConnection(nextConnection);
          setWindowConnectionError('');
        }
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setWindowConnectionError(getErrorMessage(error));
        }
      });

    return () => {
      disposed = true;
    };
  }, [appLanguage, windowConnectionId]);

  useEffect(() => {
    if (!vaultControls) {
      setIsVaultReady(true);
      setIsVaultHydrated(true);
      return;
    }

    let disposed = false;

    const loadSnapshot = async () => {
      let renderedPublicSnapshot = Boolean(initialPublicSnapshotRef.current);

      if (!renderedPublicSnapshot) {
        try {
          const publicSnapshot = typeof vaultControls.getPublicSnapshot === 'function'
            ? await vaultControls.getPublicSnapshot()
            : null;

          if (!disposed && publicSnapshot) {
            renderedPublicSnapshot = true;
            applyVaultSnapshot(publicSnapshot, { hydrated: false });
          }
        } catch {
          // Fall back to the full vault read below.
        }
      }

      try {
        const snapshot = await vaultControls.getSnapshot();

        if (!disposed) {
          applyVaultSnapshot(snapshot);
        }
      } catch (error) {
        if (!disposed) {
          setIsVaultReady(true);
          const currentLanguage = getCurrentAppLanguage();
          setStatusMessage(t(
            renderedPublicSnapshot ? 'app.status.readCredentialsFailed' : 'app.status.readLocalFailed',
            currentLanguage,
            { error: getErrorMessage(error, currentLanguage) },
          ));
        }
      }
    };

    void loadSnapshot();

    return () => {
      disposed = true;
    };
  }, [isConnectionWindow, vaultControls]);

  useEffect(() => {
    if (isConnectionWindow) {
      return undefined;
    }

    const syncControls = window.guiSSH?.sync;
    const syncEvents = window.guiSSH?.events;
    let disposed = false;

    void syncControls?.getConfig()
      .then((config) => {
        if (!disposed) {
          updateSyncConflictNotice(config);
        }
      })
      .catch(() => undefined);

    const removeSyncChanged = syncEvents?.onSyncChanged?.((result) => {
      if (disposed) {
        return;
      }

      if (result.needsResolution) {
        setSyncConflictCount(result.conflictCount);
        setSyncConflictNotice({
          conflictCount: result.conflictCount,
          conflicts: result.conflicts,
          config: result.config,
        });
        setSyncResolutionError('');
        return;
      }

      updateSyncConflictNotice(result.config);
    });

    return () => {
      disposed = true;
      removeSyncChanged?.();
    };
  }, [isConnectionWindow, updateSyncConflictNotice]);

  useEffect(() => {
    if (isConnectionWindow) {
      return undefined;
    }

    const appControls = window.guiSSH?.app;
    const eventControls = window.guiSSH?.events;
    let disposed = false;

    void appControls?.getUpdateStatus?.()
      .then((status) => {
        if (!disposed) {
          showUpdateReadyNotice(status);
        }
      })
      .catch(() => undefined);

    const removeUpdateDownloaded = eventControls?.onUpdateDownloaded?.((status) => {
      if (!disposed) {
        showUpdateReadyNotice(status);
      }
    });

    return () => {
      disposed = true;
      removeUpdateDownloaded?.();
    };
  }, [isConnectionWindow, showUpdateReadyNotice]);

  useEffect(() => {
    storeHostGroupPanelCollapsed(isHostGroupPanelCollapsed);
  }, [isHostGroupPanelCollapsed]);

  useEffect(() => {
    storeHostListSortMode(hostListSortMode);
  }, [hostListSortMode]);

  useEffect(() => {
    const logsControls = window.guiSSH?.logs;

    if (!logsControls || !isVaultReady || isConnectionWindow) {
      return;
    }

    void logsControls.getEntries().then((entries) => {
      setLogs(entries as unknown as LogEntry[]);
      lastPersistedLogsRef.current = JSON.stringify(entries);
      setIsLogsReady(true);
    }).catch(() => {
      setIsLogsReady(true);
    });
  }, [isConnectionWindow, isVaultReady]);

  useEffect(() => {
    queueCollectionsSaveIfChanged({ hosts, sshKeys, settings });
  }, [hosts, queueCollectionsSaveIfChanged, settings, sshKeys]);

  useEffect(() => {
    const closeOpenHostCardMenus = (target: EventTarget | null) => {
      const targetNode = target instanceof Node ? target : null;

      document.querySelectorAll<HTMLDetailsElement>('details.host-card-menu[open]').forEach((menu) => {
        if (targetNode && menu.contains(targetNode)) {
          return;
        }

        menu.open = false;
      });
    };

    const handlePointerDown = (event: PointerEvent) => {
      closeOpenHostCardMenus(event.target);
    };

    const handleFocusIn = (event: FocusEvent) => {
      closeOpenHostCardMenus(event.target);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeOpenHostCardMenus(null);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  useEffect(() => {
    const logsControls = window.guiSSH?.logs;

    if (!logsControls || !isLogsReady || isConnectionWindow) {
      return;
    }

    const serialized = JSON.stringify(logs);

    if (serialized === lastPersistedLogsRef.current) {
      return;
    }

    lastPersistedLogsRef.current = serialized;

    void logsControls.saveEntries(logs as unknown as ShellDeskLogEntry[]).catch(() => undefined);
  }, [logs, isConnectionWindow, isLogsReady]);

  useEffect(() => {
    if (!statusMessage) {
      return;
    }

    const delay = shouldHoldStatusMessage(statusMessage) ? 8000 : 2400;
    const timer = window.setTimeout(() => setStatusMessage(''), delay);
    return () => window.clearTimeout(timer);
  }, [statusMessage]);

  useEffect(() => {
    const root = document.documentElement;
    const prefersLight = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches;
    const effectiveTheme = settings.theme === 'system' ? (prefersLight ? 'light' : 'dark') : settings.theme;
    const isLightTheme = effectiveTheme === 'light';
    const accentColor = settings.accentColor;
    const accentContrast = getReadableTextColor(accentColor);

    root.style.setProperty('--accent', accentColor);
    root.style.setProperty('--accent-strong', accentColor);
    root.style.setProperty('--accent-contrast', accentContrast);
    root.style.setProperty('--bg', isLightTheme ? '#e7edf5' : '#0e131c');
    root.style.setProperty('--chrome', isLightTheme ? '#dfe7f1' : '#22272f');
    root.style.setProperty('--sidebar', isLightTheme ? '#dde6f0' : '#22272f');
    root.style.setProperty('--sidebar-active', isLightTheme ? '#ccd8e6' : '#3a3f49');
    root.style.setProperty('--surface', isLightTheme ? '#f8fafc' : '#111722');
    root.style.setProperty('--surface-soft', isLightTheme ? '#eef3f8' : '#151b26');
    root.style.setProperty('--surface-strong', isLightTheme ? '#dfe7f1' : '#202631');
    root.style.setProperty('--surface-elevated', isLightTheme ? '#edf2f7' : '#111722');
    root.style.setProperty('--surface-input', isLightTheme ? '#f8fafc' : '#202631');
    root.style.setProperty('--surface-control', isLightTheme ? '#e4ebf4' : '#151b25');
    root.style.setProperty('--surface-hover', isLightTheme ? '#e5edf6' : 'rgba(255, 255, 255, 0.06)');
    root.style.setProperty('--surface-icon', isLightTheme ? '#d2e1f1' : '#143149');
    root.style.setProperty('--surface-panel', isLightTheme ? '#f2f6fb' : 'rgba(17, 23, 34, 0.98)');
    root.style.setProperty('--surface-empty', isLightTheme ? 'rgba(16, 32, 51, 0.035)' : 'rgba(255, 255, 255, 0.035)');
    root.style.setProperty('--surface-pill', isLightTheme ? '#d2dce8' : '#171d28');
    root.style.setProperty('--surface-success-soft', isLightTheme ? 'rgba(34, 160, 90, 0.08)' : 'rgba(119, 244, 197, 0.08)');
    root.style.setProperty('--surface-success-border', isLightTheme ? 'rgba(34, 160, 90, 0.22)' : 'rgba(119, 244, 197, 0.22)');
    root.style.setProperty('--text-success', isLightTheme ? '#1a8a55' : '#d8fff1');
    root.style.setProperty('--toast-bg', isLightTheme ? 'rgba(241, 246, 251, 0.96)' : 'rgba(17, 23, 34, 0.94)');
    root.style.setProperty('--toast-text', isLightTheme ? '#1a6d94' : '#d8f4ff');
    root.style.setProperty('--text', isLightTheme ? '#18263a' : '#f4f7fb');
    root.style.setProperty('--muted', isLightTheme ? '#627890' : '#939cab');
    root.style.setProperty('--muted-strong', isLightTheme ? '#415874' : '#c3cad5');
    root.style.setProperty('--text-secondary', isLightTheme ? '#657489' : '#aeb7c6');
    root.style.setProperty('--text-muted', isLightTheme ? '#7b8797' : '#778292');
    root.style.setProperty('--border', isLightTheme ? 'rgba(20, 42, 68, 0.14)' : 'rgba(178, 188, 205, 0.13)');
    root.style.setProperty('--border-strong', isLightTheme ? 'rgba(20, 42, 68, 0.22)' : 'rgba(178, 188, 205, 0.24)');
    root.style.setProperty('--window-border', isLightTheme ? 'rgba(20, 42, 68, 0.1)' : 'rgba(178, 188, 205, 0.18)');
    root.style.setProperty('--window-divider', isLightTheme ? 'rgba(20, 42, 68, 0.1)' : 'rgba(178, 188, 205, 0.12)');
    root.style.setProperty('--chrome-hover', isLightTheme ? 'rgba(20, 42, 68, 0.06)' : 'rgba(255, 255, 255, 0.08)');
    root.style.setProperty('--danger-hover-bg', isLightTheme ? 'rgba(200, 48, 78, 0.12)' : 'rgba(255, 111, 143, 0.18)');
    root.style.setProperty('--danger-hover-text', isLightTheme ? '#d63a5e' : '#ffd8e1');
    root.style.setProperty('--danger-soft', isLightTheme ? 'rgba(200, 48, 78, 0.08)' : 'rgba(255, 111, 143, 0.12)');
    root.style.setProperty('--danger-border', isLightTheme ? 'rgba(200, 48, 78, 0.32)' : 'rgba(255, 111, 143, 0.42)');
    root.style.setProperty('--danger-text-soft', isLightTheme ? '#c8304e' : '#ffd3dc');
    root.style.setProperty('--focus-border', toRgba(accentColor, isLightTheme ? 0.5 : 0.46));
    root.style.setProperty('--focus-ring', toRgba(accentColor, isLightTheme ? 0.1 : 0.12));
    root.style.setProperty('--accent-soft', toRgba(accentColor, isLightTheme ? 0.12 : 0.16));
    root.style.setProperty('--accent-border', toRgba(accentColor, isLightTheme ? 0.36 : 0.42));
    root.style.setProperty('--accent-strong-border', toRgba(accentColor, isLightTheme ? 0.5 : 0.58));
    root.style.setProperty('--shadow', isLightTheme ? 'rgba(43, 67, 92, 0.12)' : 'rgba(0, 0, 0, 0.34)');
    root.style.setProperty('--shadow-soft', isLightTheme ? '0 6px 18px rgba(43, 67, 92, 0.08)' : '0 18px 42px rgba(0, 0, 0, 0.18)');
    root.style.setProperty('--shadow-float', isLightTheme ? '0 12px 28px rgba(43, 67, 92, 0.16)' : '0 18px 36px rgba(0, 0, 0, 0.32)');
    root.style.setProperty('--shadow-panel', isLightTheme ? '0 16px 48px rgba(43, 67, 92, 0.16)' : '0 24px 70px rgba(0, 0, 0, 0.42)');
    root.style.setProperty('--shadow-panel-strong', isLightTheme ? '0 16px 48px rgba(43, 67, 92, 0.18)' : '0 24px 70px rgba(0, 0, 0, 0.46)');
    root.style.setProperty('--toggle-off', isLightTheme ? '#c3cedb' : '#232b3b');
    root.style.colorScheme = isLightTheme ? 'light' : 'dark';
    root.setAttribute('data-theme', effectiveTheme);
    const interfaceFontFamily = buildFontStack(settings.interfaceFont, [
      'Microsoft YaHei UI',
      'Microsoft YaHei',
      'PingFang SC',
      'Hiragino Sans GB',
      'Noto Sans CJK SC',
      'Source Han Sans SC',
      'Segoe UI Variable',
      'Segoe UI',
      'ui-sans-serif',
      'system-ui',
      '-apple-system',
      'BlinkMacSystemFont',
      'sans-serif',
    ]);
    root.style.setProperty('--interface-font-family', interfaceFontFamily);
    document.body.style.fontFamily = interfaceFontFamily;
  }, [settings]);

  useEffect(() => {
    if (!windowControls) {
      return;
    }

    let isMounted = true;
    void windowControls.isMaximized().then((maximized) => {
      if (isMounted) {
        setIsWindowMaximized(maximized);
      }
    }).catch(() => undefined);

    const unsubscribe = window.guiSSH?.events.onWindowMaximizedChange((payload) => {
      setIsWindowMaximized(Boolean(payload.maximized));
    });

    return () => {
      isMounted = false;
      unsubscribe?.();
    };
  }, [windowControls]);

  useEffect(() => {
    if (!connection || !window.guiSSH?.events) {
      return;
    }

    const removeClosed = window.guiSSH.events.onConnectionClosed((payload: ConnectionClosedPayload) => {
      if (payload.connectionId === connection.id) {
        const message = payload.reason || t('app.connection.closedDefault', appLanguage);
        const time = new Date().toLocaleTimeString(appLocale);
        addLog('connection', 'warning', t('app.connection.closedLog', appLanguage, { host: connection.host.address }), `${time} - ${message}`);
        setStatusMessage(message);
        // Keep the window open so the user can see why the connection dropped.
        setWindowConnectionError(`${time} - ${message}`);
      }
    });
    const removeReconnecting = window.guiSSH.events.onConnectionReconnecting((payload: ConnectionReconnectingPayload) => {
      if (payload.connectionId !== connection.id) {
        return;
      }

      const message = payload.reason || t('app.connection.closedAutoReconnect', appLanguage);
      setStatusMessage(message);
    });
    const removeRestored = window.guiSSH.events.onConnectionRestored((payload: ConnectionRestoredPayload) => {
      if (payload.connectionId !== connection.id) {
        return;
      }

      const time = new Date().toLocaleTimeString(appLocale);
      addLog('connection', 'success', t('app.connection.restoredLog', appLanguage, { host: connection.host.address }), `${time} - ${t('app.connection.restoredDetail', appLanguage)}`);
      setWindowConnectionError('');
      setStatusMessage(t('app.connection.restoredStatus', appLanguage));
    });

    return () => {
      removeClosed();
      removeReconnecting();
      removeRestored();
    };
  }, [appLanguage, appLocale, connection, isConnectionWindow, windowControls]);

  useEffect(() => {
    if (!window.guiSSH?.events.onVaultChanged || !vaultControls) {
      return;
    }

    return window.guiSSH.events.onVaultChanged((payload) => {
      if (payload.kind !== 'vault' && payload.kind !== 'bookmarks' && !isConnectionWindow) {
        return;
      }

      if (collectionsSaveInFlightRef.current || pendingCollectionsSaveRef.current) {
        return;
      }

      void vaultControls.getSnapshot().then((snapshot) => {
        applyVaultSnapshot(snapshot, { updateCollections: isConnectionWindow || payload.kind === 'vault' });
      }).catch(() => undefined);
    });
  }, [isConnectionWindow, vaultControls]);

  const updateSettings = useCallback((nextSettings: ShellDeskAppSettings) => {
    commitCollectionsState(hostsRef.current, sshKeysRef.current, nextSettings);
  }, [commitCollectionsState]);

  const updateSettingsAndPersist = useCallback(async (settingsUpdate: SettingsUpdate) => {
    const nextSettings = typeof settingsUpdate === 'function'
      ? settingsUpdate(settingsRef.current)
      : settingsUpdate;

    commitCollectionsState(hostsRef.current, sshKeysRef.current, nextSettings);
    await persistCurrentCollections();
  }, [commitCollectionsState, persistCurrentCollections]);

  const addLog = (category: LogCategory, level: LogLevel, message: string, detail = '') => {
    setLogs((current) => {
      const entry: LogEntry = {
        id: createId(),
        timestamp: new Date().toISOString(),
        category,
        level,
        message,
        detail,
      };
      const next = [entry, ...current];
      return next.length > 500 ? next.slice(0, 500) : next;
    });
  };

  const clearLogs = () => {
    setLogs([]);
  };

  const minimizeWindow = () => {
    void windowControls?.minimize();
  };

  const toggleMaximizeWindow = () => {
    void windowControls?.toggleMaximize().then((maximized) => {
      setIsWindowMaximized(maximized);
    }).catch(() => undefined);
  };

  const closeWindow = () => {
    void windowControls?.close();
  };

  const resolveSyncConflict = async (resolution: ShellDeskSyncConflictResolution) => {
    const syncControls = window.guiSSH?.sync;

    if (!syncControls) {
      setSyncResolutionError(t('app.sync.conflict.noApi', appLanguage));
      return;
    }

    setSyncResolutionPending(resolution);
    setSyncResolutionError('');

    try {
      const result = await syncControls.runNow({ conflictResolution: resolution });

      if (result.snapshot) {
        applyVaultSnapshot(result.snapshot);
      }

      if (result.needsResolution) {
        setSyncConflictCount(result.conflictCount);
        setSyncConflictNotice({
          conflictCount: result.conflictCount,
          conflicts: result.conflicts,
          config: result.config,
        });
        setSyncResolutionError(t('app.sync.conflict.stillPending', appLanguage, { count: String(result.conflictCount) }));
        return;
      }

      setSyncConflictCount(0);
      setSyncConflictNotice(null);
      setStatusMessage(t(
        resolution === 'local' ? 'app.sync.conflict.resolvedLocal' : 'app.sync.conflict.resolvedRemote',
        appLanguage,
        { count: String(result.conflictCount) },
      ));
    } catch (error) {
      setSyncResolutionError(t('app.sync.conflict.resolveFailed', appLanguage, { error: getErrorMessage(error, appLanguage) }));
    } finally {
      setSyncResolutionPending('');
    }
  };

  const dismissUpdateReadyNotice = () => {
    if (updateReadyNotice) {
      storeDismissedUpdateReadyVersion(getUpdateReadyVersionKey(updateReadyNotice));
    }

    setUpdateReadyNotice(null);
    setUpdateInstallError('');
  };

  const installDownloadedUpdate = async () => {
    const install = window.guiSSH?.app?.installUpdate;

    if (!install) {
      setUpdateInstallError(t('app.update.ready.noApi', appLanguage));
      return;
    }

    setUpdateInstallPending(true);
    setUpdateInstallError('');

    try {
      await install();
    } catch (error) {
      setUpdateInstallError(t('app.update.ready.installFailed', appLanguage, { error: getErrorMessage(error, appLanguage) }));
    } finally {
      setUpdateInstallPending(false);
    }
  };

  const resetForm = () => {
    setForm(emptyHostForm);
    setEditingHostId(null);
    setFormError('');
  };

  const resetKeyForm = () => {
    setKeyForm(emptyKeyForm);
    setEditingKeyId(null);
    setKeyFormError('');
  };

  const openCreateHost = () => {
    resetForm();
    setIsEditorOpen(true);
  };

  const closeEditor = () => {
    resetForm();
    setIsEditorOpen(false);
  };

  const openCreateKey = () => {
    resetKeyForm();
    setKeyEditorMode('generate');
    setIsKeyEditorOpen(true);
    setActivePage('keys');
  };

  const openImportKey = () => {
    resetKeyForm();
    setKeyEditorMode('import');
    setIsKeyEditorOpen(true);
    setActivePage('keys');
  };

  const closeKeyEditor = () => {
    resetKeyForm();
    setIsKeyEditorOpen(false);
  };

  const updateFormField = <Field extends keyof HostFormState>(field: Field, value: HostFormState[Field]) => {
    setForm((currentForm) => ({ ...currentForm, [field]: value }));
    setFormError('');
  };

  const updateKeyFormField = <Field extends keyof KeyFormState>(field: Field, value: KeyFormState[Field]) => {
    setKeyForm((currentForm) => ({ ...currentForm, [field]: value }));
    setKeyFormError('');
  };

  const selectPrivateKeyFileForKeyForm = async () => {
    const filePath = await window.guiSSH?.files.selectPrivateKeyFile();

    if (!filePath) {
      return;
    }

    setKeyForm((currentForm) => ({
      ...currentForm,
      privateKeyPath: filePath,
      publicKeyPath: currentForm.publicKeyPath || `${filePath}.pub`,
      name: currentForm.name.trim() ? currentForm.name : getKeyNameFromPath(filePath),
    }));
    setKeyFormError('');
  };

  const selectPublicKeyFileForKeyForm = async () => {
    const filePath = await window.guiSSH?.files.selectPublicKeyFile();

    if (!filePath) {
      return;
    }

    setKeyForm((currentForm) => ({
      ...currentForm,
      publicKeyPath: filePath,
    }));
    setKeyFormError('');
  };

  const submitKey = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const mode = editingKey ? 'edit' : keyEditorMode;
    const validationError = validateKeyForm(keyForm, mode, appLanguage);

    if (validationError) {
      setKeyFormError(validationError);
      return;
    }

    if (editingKey) {
      const updatedKey = updateSshKeyFromForm(editingKey, keyForm);
      commitSshKeys(sshKeysRef.current.map((key) => (key.id === editingKey.id ? updatedKey : key)));
      addLog('key', 'success', t('app.key.updateLog', appLanguage, { name: updatedKey.name }));
      setStatusMessage(t('app.key.updatedStatus', appLanguage, { name: updatedKey.name }));
      closeKeyEditor();
      return;
    }

    if (!vaultControls) {
      setKeyFormError(t('app.key.unsupportedVault', appLanguage));
      return;
    }

    const creationMode = keyEditorMode;

    try {
      await persistCurrentCollections();

      const { snapshot, key } = creationMode === 'generate'
        ? await vaultControls.generateRsaKeyPair({
            name: keyForm.name.trim(),
            passphrase: keyForm.passphrase,
            modulusLength: Number(keyForm.modulusLength),
          })
        : await vaultControls.importKeyPair({
            name: keyForm.name.trim(),
            privateKeyPath: keyForm.privateKeyPath.trim(),
            publicKeyPath: keyForm.publicKeyPath.trim(),
            passphrase: keyForm.passphrase,
          });

      applyVaultSnapshot(snapshot);
      addLog('key', 'success', t(creationMode === 'generate' ? 'app.key.generateLog' : 'app.key.importLog', appLanguage, { name: key.name }));
      setStatusMessage(t(creationMode === 'generate' ? 'app.key.generatedStatus' : 'app.key.importedStatus', appLanguage, { name: key.name }));
      closeKeyEditor();
    } catch (error: unknown) {
      setKeyFormError(getErrorMessage(error, appLanguage));
    }
  };

  const startEditingKey = (key: SshKey) => {
    setEditingKeyId(key.id);
    setKeyForm(toKeyFormState(key));
    setKeyEditorMode('edit');
    setKeyFormError('');
    setIsKeyEditorOpen(true);
  };

  const copyPublicKey = async (key: SshKey) => {
    if (!key.publicKey) {
      setStatusMessage(t('app.key.noPublicKey', appLanguage, { name: key.name }));
      return;
    }

    try {
      await navigator.clipboard.writeText(key.publicKey);
      setStatusMessage(t('app.key.copiedPublicKey', appLanguage, { name: key.name }));
    } catch (error) {
      setStatusMessage(t('app.key.copyFailed', appLanguage, { error: getErrorMessage(error, appLanguage) }));
    }
  };

  const deleteSshKey = (key: SshKey) => {
    const relatedHosts = hostsRef.current.filter((host) => host.keyId === key.id);
    setDeleteConfirmation({ kind: 'ssh-key', key, relatedHostCount: relatedHosts.length });
  };

  const confirmDeleteSshKey = (key: SshKey) => {
    const relatedHosts = hostsRef.current.filter((host) => host.keyId === key.id);
    const nextSshKeys = sshKeysRef.current.filter((currentKey) => currentKey.id !== key.id);
    const nextHosts: Host[] = relatedHosts.length
      ? hostsRef.current.map((host): Host => (
        host.keyId === key.id
          ? {
              ...host,
              authMethod: 'password',
              keyId: '',
              keyPath: '',
              passphrase: '',
              password: '',
              updatedAt: new Date().toISOString(),
            }
          : host
      ))
      : hostsRef.current;

    commitCollectionsState(nextHosts, nextSshKeys, settingsRef.current);

    if (editingKeyId === key.id) {
      closeKeyEditor();
    }

    addLog('key', 'info', t('app.key.deleteLog', appLanguage, { name: key.name }), relatedHosts.length ? t('app.key.deleteRelatedHosts', appLanguage, { count: String(relatedHosts.length) }) : '');
    setStatusMessage(t('app.key.deletedStatus', appLanguage, { name: key.name }));
  };

  const updateCredentialField = <Field extends keyof CredentialFormState>(
    field: Field,
    value: CredentialFormState[Field],
  ) => {
    setCredentialForm((currentForm) => ({ ...currentForm, [field]: value }));
    setCredentialError('');
  };

  const updateCredentialAuthMethod = (authMethod: AuthMethod) => {
    setCredentialForm((currentForm) => {
      const selectedKey = sshKeyById.get(currentForm.keyId) ??
        (credentialHost?.authMethod === 'key' && credentialHost.keyPath ? null : sshKeys[0] ?? null);

      return {
        ...currentForm,
        authMethod,
        keyId: authMethod === 'key' ? selectedKey?.id ?? '' : currentForm.keyId,
        passphrase: authMethod === 'key' ? selectedKey?.passphrase ?? currentForm.passphrase : currentForm.passphrase,
        saveCredential: authMethod === 'password' ? settings.rememberPasswords : settings.rememberKeyPassphrases,
      };
    });
    setCredentialError('');
  };

  const updateCredentialKeyId = (keyId: string) => {
    const selectedKey = sshKeyById.get(keyId) ?? null;

    setCredentialForm((currentForm) => ({
      ...currentForm,
      keyId,
      passphrase: selectedKey?.passphrase ?? '',
    }));
    setCredentialError('');
  };

  const openCredentialDialog = (host: ConnectionHost, message = '') => {
    const selectedKey = host.authMethod === 'key' ? getSelectedSshKey(host) : null;
    const authMethod: AuthMethod = host.authMethod === 'key' ? 'key' : 'password';

    setCredentialHost(host);
    setCredentialForm({
      authMethod,
      password: host.password,
      keyId: authMethod === 'key' ? selectedKey?.id ?? '' : sshKeys[0]?.id ?? '',
      passphrase: selectedKey?.passphrase ?? host.passphrase,
      saveCredential: authMethod === 'password' ? settings.rememberPasswords : settings.rememberKeyPassphrases,
    });
    setCredentialError(message);
  };

  const closeCredentialDialog = () => {
    setCredentialHost(null);
    setCredentialForm(emptyCredentialForm);
    setCredentialError('');
  };

  const showConnectionError = (host: Pick<ConnectionHost, 'name' | 'username' | 'address' | 'port'>, message: string) => {
    setConnectionErrorNotice({
      hostName: host.name || host.address,
      endpoint: `${host.username}@${host.address}:${host.port}`,
      message,
    });
    setStatusMessage('');
  };

  const markHostConnectionResult = (
    host: Pick<ConnectionHost, 'id'>,
    status: Exclude<HostConnectionStatus, 'unknown'>,
    errorMessage = '',
  ) => {
    const timestamp = new Date().toISOString();

    commitHosts(hostsRef.current.map((currentHost): Host => (
      currentHost.id === host.id
        ? {
            ...currentHost,
            lastConnectionStatus: status,
            lastConnectionAt: timestamp,
            lastConnectionError: status === 'failed' ? errorMessage : '',
          }
        : currentHost
    )));
  };

  const submitHost = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const selectedKey = sshKeyById.get(form.keyId) ?? null;
    const validationError = validateHostForm(form, sshKeys, hostsRef.current, editingHostId, appLanguage);

    if (validationError) {
      setFormError(validationError);
      return;
    }

    if (editingHost) {
      const updatedHost = updateHostFromForm(editingHost, form, selectedKey);
      commitHosts(hostsRef.current.map((host) => (host.id === editingHost.id ? updatedHost : host)));
      addLog('host', 'success', t('app.host.updateLog', appLanguage, { name: updatedHost.name }), `${updatedHost.username}@${updatedHost.address}:${updatedHost.port}`);
      setStatusMessage(t('app.host.updatedStatus', appLanguage, { name: updatedHost.name }));
    } else {
      const nextHost = createHostFromForm(form, selectedKey);
      commitHosts([nextHost, ...hostsRef.current]);
      addLog('host', 'success', t('app.host.addLog', appLanguage, { name: nextHost.name }), `${nextHost.username}@${nextHost.address}:${nextHost.port}`);
      setStatusMessage(t('app.host.addedStatus', appLanguage, { name: nextHost.name }));
    }

    closeEditor();
  };

  const startEditingHost = (host: Host) => {
    setEditingHostId(host.id);
    setForm(toFormState(host));
    setFormError('');
    setIsEditorOpen(true);
  };

  const deleteHost = (host: Host) => {
    const dependentHosts = hostsRef.current.filter((currentHost) => currentHost.jumpHostId === host.id);

    if (dependentHosts.length) {
      setDeleteConfirmation({ kind: 'host-jump-blocked', host, dependentHosts });
      return;
    }

    setDeleteConfirmation({ kind: 'host', host });
  };

  const confirmDeleteHost = (host: Host) => {
    const nextHosts = hostsRef.current.filter((currentHost) => currentHost.id !== host.id);
    commitHosts(nextHosts);
    addLog('host', 'info', t('app.host.deleteLog', appLanguage, { name: host.name }), `${host.username}@${host.address}:${host.port}`);
    setStatusMessage(t('app.host.deletedStatus', appLanguage, { name: host.name }));

    if (editingHostId === host.id) {
      closeEditor();
    }
  };

  const confirmPendingDelete = () => {
    if (!deleteConfirmation) {
      return;
    }

    if (deleteConfirmation.kind === 'host-jump-blocked') {
      setDeleteConfirmation(null);
      return;
    }

    if (deleteConfirmation.kind === 'ssh-key') {
      confirmDeleteSshKey(deleteConfirmation.key);
    } else {
      confirmDeleteHost(deleteConfirmation.host);
    }

    setDeleteConfirmation(null);
  };

  const closeHostCardMenu = (trigger: HTMLElement | null) => {
    const details = trigger?.closest('details');

    if (details instanceof HTMLDetailsElement) {
      details.open = false;
    }
  };

  const connectHost = async (
    host: ConnectionHost,
    credentials?: CredentialFormState,
    launchSource: ConnectionLaunchSource = 'host-card',
  ) => {
    if (isConnectionPending) {
      return false;
    }

    if (!window.guiSSH?.connections) {
      const message = t('app.connection.unsupportedSsh', appLanguage);
      markHostConnectionResult(host, 'failed', message);
      showConnectionError(host, message);
      return false;
    }

    const effectiveAuthMethod = credentials?.authMethod ?? host.authMethod;
    const selectedKey = effectiveAuthMethod === 'key'
      ? sshKeyById.get(credentials?.keyId || host.keyId) ?? null
      : null;
    const shouldUseHostKeyPath = effectiveAuthMethod === 'key' && !selectedKey && Boolean(host.keyPath);

    if (effectiveAuthMethod === 'key' && !selectedKey && !shouldUseHostKeyPath) {
      const message = t('app.connection.noValidKey', appLanguage);
      markHostConnectionResult(host, 'failed', message);
      showConnectionError(host, message);
      return false;
    }

    const hostForConnection: ConnectionHost = {
      ...host,
      authMethod: effectiveAuthMethod,
      password: effectiveAuthMethod === 'password' ? credentials?.password ?? host.password : '',
      keyId: effectiveAuthMethod === 'key' ? selectedKey?.id ?? '' : '',
      keyPath: effectiveAuthMethod === 'key' && !selectedKey ? host.keyPath : '',
      passphrase: effectiveAuthMethod === 'key'
        ? credentials?.passphrase ?? selectedKey?.passphrase ?? host.passphrase
        : '',
    };

    if (launchSource === 'quick-connect') {
      setIsQuickConnecting(true);
    } else if (launchSource === 'credential') {
      setIsCredentialConnecting(true);
    } else {
      setConnectingHostId(host.id);
    }

    setConnectionErrorNotice(null);
    preloadFullMessageCatalog();

    try {
      const nextConnection = await window.guiSSH.connections.connect(hostForConnection);
      const detectedSystemType = getHostSystemType(nextConnection.host?.systemType, nextConnection.host?.systemName);
      const detectedSystemName = typeof nextConnection.host?.systemName === 'string' ? nextConnection.host.systemName : '';
      const hasDetectedSystem = detectedSystemType !== 'unknown' || Boolean(detectedSystemName);
      const connectionFinishedAt = new Date().toISOString();

      const nextHosts = hostsRef.current.map((currentHost): Host =>
        currentHost.id === host.id
          ? {
              ...currentHost,
              ...(credentials?.saveCredential
                ? {
                    authMethod: effectiveAuthMethod === 'key' ? 'key' : 'password',
                    password: effectiveAuthMethod === 'password' ? credentials.password : '',
                    keyId: effectiveAuthMethod === 'key' ? selectedKey?.id ?? currentHost.keyId : '',
                    keyPath: effectiveAuthMethod === 'key' && !selectedKey ? host.keyPath : '',
                    passphrase: effectiveAuthMethod === 'key' && !selectedKey ? credentials.passphrase : '',
                  }
                : {}),
              ...(hasDetectedSystem
                ? {
                    systemType: detectedSystemType,
                    systemName: detectedSystemName,
                  }
                : {}),
              lastConnectionStatus: 'success',
              lastConnectionAt: connectionFinishedAt,
              lastConnectionError: '',
              ...(credentials?.saveCredential || hasDetectedSystem
                ? { updatedAt: connectionFinishedAt }
                : {}),
            }
          : currentHost,
      );
      let nextSshKeys = sshKeysRef.current;

      if (credentials?.saveCredential && effectiveAuthMethod === 'key' && selectedKey) {
        nextSshKeys = sshKeysRef.current.map((key) => (
          key.id === selectedKey.id
            ? { ...key, passphrase: credentials.passphrase, updatedAt: connectionFinishedAt }
            : key
        ));
      }

      commitCollectionsState(nextHosts, nextSshKeys, settingsRef.current);

      if (isConnectionWindow) {
        setConnection({ ...nextConnection, host: nextConnection.host ?? hostForConnection });
        addLog('connection', 'success', t('app.connection.successLog', appLanguage, { host: host.name }), `${host.username}@${host.address}:${host.port}`);
        setStatusMessage(t('app.connection.successStatus', appLanguage, { host: host.name }));
      } else {
        addLog('connection', 'success', t('app.connection.openWindowLog', appLanguage, { host: host.name }), `${host.username}@${host.address}:${host.port}`);
        setStatusMessage(t('app.connection.openWindowStatus', appLanguage, { host: host.name }));
      }

      closeCredentialDialog();
      setConnectionErrorNotice(null);
      return true;
    } catch (error) {
      const message = getErrorMessage(error, appLanguage);
      markHostConnectionResult(hostForConnection, 'failed', message);
      addLog('connection', 'error', t('app.connection.failedLog', appLanguage, { host: host.name }), `${host.username}@${host.address}:${host.port} - ${message}`);
      showConnectionError(hostForConnection, message);

      if (isAuthFailureMessage(message)) {
        openCredentialDialog(hostForConnection, message);
      }

      return false;
    } finally {
      if (launchSource === 'quick-connect') {
        setIsQuickConnecting(false);
      } else if (launchSource === 'credential') {
        setIsCredentialConnecting(false);
      } else {
        setConnectingHostId((currentHostId) => (currentHostId === host.id ? null : currentHostId));
      }
    }
  };

  const openHostFromList = (host: ConnectionHost) => {
    if (isConnectionPending) {
      return;
    }

    if (host.authMethod === 'password' && !host.password) {
      openCredentialDialog(host, t('app.connection.passwordPrompt', appLanguage));
      return;
    }

    void connectHost(host, undefined, 'host-card');
  };

  const connectCommandBarInput = async () => {
    if (isConnectionPending) {
      return;
    }

    const parsedCommand = parseQuickConnectCommand(searchQuery);

    if (!parsedCommand) {
      setStatusMessage(t('app.connection.invalidSshCommand', appLanguage));
      return;
    }

    const matchedHost = hosts.find((host) => (
      host.address === parsedCommand.address &&
      host.port === parsedCommand.port &&
      host.username === parsedCommand.username
    ));

    if (matchedHost && !parsedCommand.keyPath) {
      await connectHost(matchedHost, undefined, 'quick-connect');
      return;
    }

    const now = new Date().toISOString();
    const quickConnectHost: ConnectionHost = {
      id: `quick-connect:${parsedCommand.username}@${parsedCommand.address}:${parsedCommand.port}`,
      name: `${parsedCommand.username}@${parsedCommand.address}`,
      address: parsedCommand.address,
      port: parsedCommand.port,
      username: parsedCommand.username,
      authMethod: parsedCommand.keyPath ? 'key' : 'agent',
      password: '',
      keyId: '',
      keyPath: parsedCommand.keyPath,
      passphrase: '',
      privilegeMode: 'sudo',
      rootPassword: '',
      jumpHostId: '',
      canBeJumpHost: false,
      systemType: 'unknown',
      systemName: '',
      group: '',
      tags: [],
      note: '',
      lastConnectionStatus: 'unknown',
      lastConnectionAt: '',
      lastConnectionError: '',
      createdAt: now,
      updatedAt: now,
    };

    await connectHost(quickConnectHost, undefined, 'quick-connect');
  };

  const submitCredentialConnection = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!credentialHost || isConnectionPending) {
      return;
    }

    if (credentialForm.authMethod === 'password' && !credentialForm.password) {
      setCredentialError(t('app.connection.credentialPasswordRequired', appLanguage));
      return;
    }

    if (
      credentialForm.authMethod === 'key' &&
      !credentialForm.keyId &&
      !(credentialHost.authMethod === 'key' && credentialHost.keyPath)
    ) {
      setCredentialError(t('app.connection.credentialKeyRequired', appLanguage));
      return;
    }

    await connectHost(credentialHost, credentialForm, 'credential');
  };

  const clearFilters = () => {
    setActiveGroupKey(null);
    setSearchQuery('');
  };

  const toggleHostGroupPanel = () => {
    setIsHostGroupPanelCollapsed((current) => !current);
  };

  const exportConfig = async () => {
    if (!window.guiSSH?.files.exportConfig) {
      setStatusMessage(t('app.config.exportUnsupported', appLanguage));
      return;
    }

    setIsConfigTransferPending(true);

    try {
      const filePath = await window.guiSSH.files.exportConfig();

      if (!filePath) {
        return;
      }

      setStatusMessage(t('app.config.exportedStatus', appLanguage, { hostCount: String(hosts.length), keyCount: String(sshKeys.length), bookmarkCount: String(bookmarkCount) }));
      addLog('config', 'success', t('app.config.exportLog', appLanguage), t('app.config.exportDetail', appLanguage, { hostCount: String(hosts.length), keyCount: String(sshKeys.length), bookmarkCount: String(bookmarkCount) }));
    } catch (error) {
      addLog('config', 'error', t('app.config.exportFailedLog', appLanguage), getErrorMessage(error, appLanguage));
      setStatusMessage(t('app.config.exportFailedStatus', appLanguage, { error: getErrorMessage(error, appLanguage) }));
    } finally {
      setIsConfigTransferPending(false);
    }
  };

  const importConfig = async () => {
    if (!window.guiSSH?.files.importConfig) {
      setStatusMessage(t('app.config.importUnsupported', appLanguage));
      return;
    }

    setIsConfigTransferPending(true);

    try {
      const importedConfig = await window.guiSSH.files.importConfig();

      if (!importedConfig) {
        return;
      }

      if (!importedConfig.hosts.length && !importedConfig.sshKeys.length) {
        setStatusMessage(t('app.config.importEmpty', appLanguage));
        return;
      }

      closeEditor();
      closeKeyEditor();
      closeCredentialDialog();
      applyVaultSnapshot(importedConfig);
      const importedBookmarkCount = importedConfig.browserBookmarks.reduce((total, collection) => total + collection.bookmarks.length, 0);
      setStatusMessage(t('app.config.importedStatus', appLanguage, { hostCount: String(importedConfig.hosts.length), keyCount: String(importedConfig.sshKeys.length), bookmarkCount: String(importedBookmarkCount) }));
      addLog('config', 'success', t('app.config.importLog', appLanguage), t('app.config.importDetail', appLanguage, { hostCount: String(importedConfig.hosts.length), keyCount: String(importedConfig.sshKeys.length) }));
    } catch (error) {
      addLog('config', 'error', t('app.config.importFailedLog', appLanguage), getErrorMessage(error, appLanguage));
      setStatusMessage(t('app.config.importFailedStatus', appLanguage, { error: getErrorMessage(error, appLanguage) }));
    } finally {
      setIsConfigTransferPending(false);
    }
  };

  const credentialSelectedKey = credentialHost
    ? sshKeyById.get(credentialForm.keyId) ?? null
    : null;
  const credentialCanUseCurrentKeyFile = Boolean(
    credentialHost?.authMethod === 'key' && credentialHost.keyPath && !credentialForm.keyId,
  );
  const credentialCanUseKeyAuth = sshKeys.length > 0 || credentialCanUseCurrentKeyFile;
  const credentialSaveLabel = credentialHost && hosts.some((host) => host.id === credentialHost.id)
    ? t('app.credential.saveHostPassword', appLanguage)
    : credentialForm.authMethod === 'key'
      ? t('app.credential.saveKeyPassphrase', appLanguage)
      : t('app.credential.rememberPassword', appLanguage);
  const maximizeWindowLabel = t(isWindowMaximized ? 'app.titlebar.restore' : 'app.titlebar.maximize', appLanguage);
  const hostGroupToggleLabel = t(isHostGroupPanelCollapsed ? 'app.host.groupsShow' : 'app.host.groupsHide', appLanguage);
  const hostEditorTitle = t(editingHost ? 'app.host.editor.editAria' : 'app.host.editor.newAria', appLanguage);
  const hostFormUsesRootLogin = isRootLoginUsername(form.username);
  const keyEditorTitle = editingKey
    ? t('app.key.editor.editTitle', appLanguage)
    : t(keyEditorMode === 'generate' ? 'app.key.editor.generateTitle' : 'app.key.editor.importTitle', appLanguage);
  const keyEditorSummary = editingKey
    ? editingKey.name
    : t(keyEditorMode === 'generate' ? 'app.key.editor.generateSummary' : 'app.key.editor.importSummary', appLanguage);
  const blockedJumpHostPreview = deleteConfirmation?.kind === 'host-jump-blocked'
    ? deleteConfirmation.dependentHosts.slice(0, 3)
    : [];
  const blockedJumpHostMoreCount = deleteConfirmation?.kind === 'host-jump-blocked'
    ? Math.max(0, deleteConfirmation.dependentHosts.length - blockedJumpHostPreview.length)
    : 0;
  const blockedJumpHostMoreLabel = blockedJumpHostMoreCount
    ? t('app.deleteConfirm.hostJumpInUseMore', appLanguage, { count: String(blockedJumpHostMoreCount) })
    : '';
  const blockedJumpHostNames = blockedJumpHostPreview
    .map((host) => host.name)
    .join(appLanguage === 'zh-CN' ? '、' : ', ');
  const isHostDeleteBlocked = deleteConfirmation?.kind === 'host-jump-blocked';
  const deleteConfirmationMessage = deleteConfirmation
    ? deleteConfirmation.kind === 'host-jump-blocked'
      ? t('app.deleteConfirm.hostJumpInUse', appLanguage, {
          name: deleteConfirmation.host.name,
          hosts: blockedJumpHostNames,
          more: blockedJumpHostMoreLabel,
        })
      : deleteConfirmation.kind === 'ssh-key'
      ? deleteConfirmation.relatedHostCount
        ? t('app.deleteConfirm.keyWithHosts', appLanguage, { name: deleteConfirmation.key.name, count: String(deleteConfirmation.relatedHostCount) })
        : t('app.deleteConfirm.key', appLanguage, { name: deleteConfirmation.key.name })
      : t('app.deleteConfirm.host', appLanguage, { name: deleteConfirmation.host.name })
    : '';
  const syncConflictPreview = syncConflictNotice?.conflicts.slice(0, 2) ?? [];
  const syncConflictHiddenCount = syncConflictPreview.length
    ? Math.max(0, (syncConflictNotice?.conflictCount ?? 0) - syncConflictPreview.length)
    : 0;
  const syncConflictBadgeLabel = syncConflictCount
    ? t('app.sync.conflict.badge', appLanguage, { count: String(syncConflictCount) })
    : '';
  const shouldShowSyncConflictNotice = Boolean(syncConflictNotice) && !connection && !isConnectionWindow && activePage !== 'settings';
  const formattedUpdateReadyVersion = formatUpdateReadyVersion(updateReadyNotice?.version);
  const updateReadyVersionLabel = formattedUpdateReadyVersion
    ? formattedUpdateReadyVersion
    : t('app.update.ready.versionUnknown', appLanguage);
  const shouldShowUpdateReadyNotice = Boolean(updateReadyNotice) && !shouldShowSyncConflictNotice && !connection && !isConnectionWindow && activePage !== 'settings';

  return (
    <div className={isMacOS ? 'app-shell app-shell-macos' : 'app-shell'}>
      <header className="top-chrome drag-region">
        <div className="workspace-title">
          <img className="app-window-icon" src={appIconUrl} alt="" />
          {connection ? (
            <>
              <strong>ShellDesk</strong>
              <span>{titlebarConnectionAddress}</span>
              <span>SOCKS :{connection.proxyPort}</span>
            </>
          ) : (
            'ShellDesk'
          )}
        </div>

        {showWindowControls ? (
          <div className="titlebar-controls no-drag">
            <button type="button" className="titlebar-button minimize" aria-label={t('app.titlebar.minimize', appLanguage)} title={t('app.titlebar.minimize', appLanguage)} onClick={minimizeWindow}>−</button>
            <button
              type="button"
              className={`titlebar-button maximize ${isWindowMaximized ? 'restore' : ''}`}
              aria-label={maximizeWindowLabel}
              title={maximizeWindowLabel}
              onClick={toggleMaximizeWindow}
            >
              <span className={`window-control-icon ${isWindowMaximized ? 'restore' : 'maximize'}`} aria-hidden="true" />
            </button>
            <button type="button" className="titlebar-button danger" aria-label={t('app.titlebar.close', appLanguage)} title={t('app.titlebar.close', appLanguage)} onClick={closeWindow}>×</button>
          </div>
        ) : null}
      </header>

      {statusMessage ? <div className="status-toast no-drag" role="status">{statusMessage}</div> : null}
      {connectionErrorNotice ? createPortal(
        <div className="connection-error-overlay no-drag" role="presentation">
          <div className="connection-error-dialog" role="alertdialog" aria-modal="false" aria-labelledby="connection-error-title">
            <span className="connection-error-mark" aria-hidden="true">!</span>
            <div className="connection-error-copy">
              <strong id="connection-error-title">{t('app.connection.errorTitle', appLanguage, { host: connectionErrorNotice.hostName })}</strong>
              <span>{connectionErrorNotice.endpoint}</span>
              <p>{connectionErrorNotice.message}</p>
            </div>
            <button type="button" onClick={() => setConnectionErrorNotice(null)}>{t('common.close', appLanguage)}</button>
          </div>
        </div>,
        document.body,
      ) : null}
      {shouldShowSyncConflictNotice && syncConflictNotice ? createPortal(
        <div className="sync-conflict-popover no-drag" role="alertdialog" aria-modal="false" aria-labelledby="sync-conflict-title">
          <button
            type="button"
            className="sync-conflict-close"
            aria-label={t('app.sync.conflict.dismiss', appLanguage)}
            onClick={() => setSyncConflictNotice(null)}
          >
            ×
          </button>
          <span className="sync-conflict-mark" aria-hidden="true">!</span>
          <div className="sync-conflict-copy">
            <strong id="sync-conflict-title">{t('app.sync.conflict.title', appLanguage)}</strong>
            <p>{t('app.sync.conflict.summary', appLanguage, { count: String(syncConflictNotice.conflictCount) })}</p>
            {syncConflictPreview.length ? (
              <div className="sync-conflict-preview">
                {syncConflictPreview.map((conflict) => (
                  <span key={`${conflict.type}:${conflict.id}`}>
                    <b>{conflict.name}</b>
                    <small>{conflict.reason}</small>
                  </span>
                ))}
              </div>
            ) : (
              <small className="sync-conflict-muted">{t('app.sync.conflict.noDetails', appLanguage)}</small>
            )}
            {syncConflictHiddenCount > 0 ? (
              <small className="sync-conflict-muted">{t('app.sync.conflict.more', appLanguage, { count: String(syncConflictHiddenCount) })}</small>
            ) : null}
            {syncResolutionError ? <small className="sync-conflict-error">{syncResolutionError}</small> : null}
            <div className="sync-conflict-actions">
              <button type="button" onClick={() => { setActivePage('settings'); preloadFullMessageCatalog(); }}>
                {t('app.sync.conflict.openSettings', appLanguage)}
              </button>
              <button
                type="button"
                onClick={() => void resolveSyncConflict('remote')}
                disabled={Boolean(syncResolutionPending)}
              >
                {syncResolutionPending === 'remote' ? t('app.sync.conflict.keepRemoteLoading', appLanguage) : t('app.sync.conflict.keepRemote', appLanguage)}
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => void resolveSyncConflict('local')}
                disabled={Boolean(syncResolutionPending)}
              >
                {syncResolutionPending === 'local' ? t('app.sync.conflict.keepLocalLoading', appLanguage) : t('app.sync.conflict.keepLocal', appLanguage)}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
      {shouldShowUpdateReadyNotice && updateReadyNotice ? createPortal(
        <div className="sync-conflict-popover update-ready-popover no-drag" role="alertdialog" aria-modal="false" aria-labelledby="update-ready-title">
          <button
            type="button"
            className="sync-conflict-close"
            aria-label={t('app.update.ready.later', appLanguage)}
            onClick={dismissUpdateReadyNotice}
            disabled={updateInstallPending}
          >
            ×
          </button>
          <span className="sync-conflict-mark" aria-hidden="true">↑</span>
          <div className="sync-conflict-copy">
            <strong id="update-ready-title">{t('app.update.ready.title', appLanguage)}</strong>
            <p>{t('app.update.ready.summary', appLanguage, { version: updateReadyVersionLabel })}</p>
            {updateInstallError ? <small className="sync-conflict-error">{updateInstallError}</small> : null}
            <div className="sync-conflict-actions">
              <button type="button" onClick={installDownloadedUpdate} disabled={updateInstallPending}>
                {updateInstallPending ? t('app.update.ready.installing', appLanguage) : t('app.update.ready.installNow', appLanguage)}
              </button>
              <button type="button" className="primary" onClick={dismissUpdateReadyNotice} disabled={updateInstallPending}>
                {t('app.update.ready.later', appLanguage)}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}

      {connection ? (
        <Suspense fallback={<RemoteDesktopLoadingFallback language={appLanguage} />}>
          <RemoteDesktop connection={connection} settings={settings} onSettingsChange={updateSettings} />
        </Suspense>
      ) : isConnectionWindow ? (
        <main className="vault-page no-drag">
          <div className="empty-state">
            <span>{windowConnectionError ? 'CLOSED' : 'OPENING'}</span>
            <h3>{windowConnectionError ? t('app.connection.windowUnavailable', appLanguage) : t('app.connection.windowOpening', appLanguage)}</h3>
            <p>{windowConnectionError || t('app.connection.readingSshInfo', appLanguage)}</p>
            {windowConnectionError ? (
              <button type="button" className="command-button" onClick={closeWindow}>{t('app.connection.closeWindow', appLanguage)}</button>
            ) : null}
          </div>
        </main>
      ) : (
      <div className="app-layout">
        <aside className="side-nav">
          <nav className="feature-nav" aria-label={t('app.nav.feature', appLanguage)}>
            {navigationItems.map((item) => (
              <button
                key={item.page}
                type="button"
                className={`feature-nav-item ${activePage === item.page ? 'active' : ''}`}
                onClick={() => setActivePage(item.page)}
                onFocus={item.page === 'hosts' ? undefined : preloadFullMessageCatalog}
                onMouseEnter={item.page === 'hosts' ? undefined : preloadFullMessageCatalog}
              >
                <span className="nav-icon"><NavIcon name={item.icon} /></span>
                {t(item.labelId, appLanguage)}
              </button>
            ))}
          </nav>

          <button
            type="button"
            className={`settings-entry ${activePage === 'settings' ? 'active' : ''} ${syncConflictCount ? 'has-sync-conflict' : ''}`}
            onClick={() => setActivePage('settings')}
            onFocus={preloadFullMessageCatalog}
            onMouseEnter={preloadFullMessageCatalog}
            title={syncConflictBadgeLabel || undefined}
          >
            <span className="nav-icon"><NavIcon name="settings" /></span>
            {t('app.nav.settings', appLanguage)}
            {syncConflictCount ? <span className="settings-sync-dot" aria-label={syncConflictBadgeLabel} /> : null}
          </button>
        </aside>

        <main className="vault-page">
          {activePage === 'hosts' ? (
            <>
          <div className="command-bar no-drag">
            <label className="global-search">
              <span className="search-icon" aria-hidden="true">⌕</span>
              <input
                type="search"
                placeholder={t('app.host.search.placeholder', appLanguage)}
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void connectCommandBarInput();
                  }
                }}
              />
              <kbd>Ctrl + K</kbd>
            </label>

            <button type="button" className="command-button" onClick={connectCommandBarInput} disabled={isConnectionPending}>
              {isQuickConnecting ? t('app.host.connectingButton', appLanguage) : t('app.host.connectButton', appLanguage)}
            </button>

            <button type="button" className="primary-action" onClick={openCreateHost}>{t('app.host.new', appLanguage)}</button>
          </div>

          <section className={`vault-content hosts-content ${isHostGroupPanelCollapsed ? 'groups-collapsed' : ''}`}>
            <aside
              id="hosts-group-panel"
              className="hosts-group-panel"
              aria-label={t('app.host.groups.aria', appLanguage)}
              aria-hidden={isHostGroupPanelCollapsed}
              inert={isHostGroupPanelCollapsed ? true : undefined}
            >
              <button type="button" className={`filter-tab all-hosts-filter ${!activeGroupKey && !searchQuery ? 'active' : ''}`} onClick={clearFilters}>
                <span>{t('app.host.all', appLanguage)}</span>
                <b>{hosts.length}</b>
              </button>

              <div className="section-heading group-panel-heading">
                <h2>{t('app.host.group.title', appLanguage)}</h2>
                <button type="button" className="group-add-button" onClick={openCreateHost} aria-label={t('app.host.new', appLanguage)}>
                  +
                </button>
              </div>

              {!isVaultReady ? (
                <div className="empty-inline">{t('app.host.groupsLoading', appLanguage)}</div>
              ) : hostGroups.length ? (
                <div className="group-grid group-list">
                  {hostGroups.map((group) => (
                    <button
                      key={group.key}
                      type="button"
                      className={`group-card ${activeGroupKey === group.key ? 'active' : ''}`}
                      onClick={() => setActiveGroupKey(group.key)}
                    >
                      <span className="group-icon" aria-hidden="true"><HostGroupIcon /></span>
                      <strong>{group.name}</strong>
                      <small>{group.count}</small>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="empty-inline">{t('app.host.groupsEmpty', appLanguage)}</div>
              )}
            </aside>

            <section className="vault-section host-section hosts-list-panel">
              <div className="section-heading host-list-heading">
                <div className="host-list-title">
                  <button
                    type="button"
                    className={`group-panel-toggle-button ${isHostGroupPanelCollapsed ? 'collapsed' : ''}`}
                    onClick={toggleHostGroupPanel}
                    aria-label={hostGroupToggleLabel}
                    aria-expanded={!isHostGroupPanelCollapsed}
                    aria-controls="hosts-group-panel"
                    title={hostGroupToggleLabel}
                  >
                    <span aria-hidden="true">{isHostGroupPanelCollapsed ? '☰' : '‹'}</span>
                  </button>
                  <h2>{activeGroupName || t('app.host.all', appLanguage)} <b>{filteredHosts.length}</b></h2>
                </div>
                <span className="host-list-controls">
                  {t('app.host.count', appLanguage, { count: String(filteredHosts.length) })}
                  <label className="host-sort-control">
                    <select
                      value={hostListSortMode}
                      onChange={(event) => setHostListSortMode(getHostListSortMode(event.target.value))}
                      aria-label={t('app.host.sort.aria', appLanguage)}
                    >
                      {hostListSortModes.map((sortMode) => (
                        <option key={sortMode} value={sortMode}>{t(hostListSortModeLabelIds[sortMode], appLanguage)}</option>
                      ))}
                    </select>
                  </label>
                  <button type="button" className="host-refresh-button" onClick={() => void refreshHosts()} aria-label={t('app.host.refreshList', appLanguage)}>
                    <span aria-hidden="true">↻</span>
                  </button>
                </span>
              </div>

              <div className="host-list-scroll">
                {!isVaultReady ? (
                  <div className="empty-state">
                    <span>LOADING</span>
                    <h3>{t('app.host.loadingTitle', appLanguage)}</h3>
                    <p>{t('app.host.loadingDescription', appLanguage)}</p>
                  </div>
                ) : filteredHosts.length ? (
                  <div className="host-grid grid">
                    {filteredHosts.map((host) => {
                      const connectionState = getHostConnectionStateView(host, appLanguage);
                      const isHostConnecting = connectingHostId === host.id;
                      const jumpHost = host.jumpHostId ? hostById.get(host.jumpHostId) ?? null : null;

                      return (
                        <article
                          key={host.id}
                          className={`host-card ${isHostConnecting ? 'connecting' : ''}`}
                          aria-busy={isHostConnecting}
                        >
                          <button
                            type="button"
                            className="host-card-main"
                            title={t('app.host.openHint', appLanguage)}
                            disabled={isConnectionPending}
                            onDoubleClick={() => openHostFromList(host)}
                          >
                            <HostSystemIcon systemName={getHostSystemLabel(host, appLanguage)} systemType={host.systemType} />
                            <span className="host-summary">
                              <strong>{host.name}</strong>
                              <small>
                                {jumpHost ? (
                                  <span
                                    className="host-jump-inline"
                                    title={t('app.host.jumpVia', appLanguage, { host: jumpHost.name })}
                                    aria-label={t('app.host.jumpVia', appLanguage, { host: jumpHost.name })}
                                  >
                                    ↪
                                  </span>
                                ) : null}
                                <span className="host-endpoint">{host.username ? `${host.username}@` : ''}{host.address}:{host.port}</span>
                              </small>
                              <span className="host-card-tags">
                                {/* <em>SSH</em> */}
                                {(host.authMethod === 'password' && host.password) || host.authMethod === 'key' ? (
                                  <span className="credential-icon" title={host.authMethod === 'key' ? t('app.auth.keyLogin', appLanguage) : t('app.host.passwordSavedTitle', appLanguage)}>🔑</span>
                                ) : null}
                                <em className={!host.group ? 'host-card-tag-placeholder' : undefined}>{host.group || t('app.host.group.ungrouped', appLanguage)}</em>
                                <em className={!host.tags.length ? 'host-card-tag-placeholder' : undefined}>{host.tags.length ? host.tags.join(' / ') : t('app.host.noTags', appLanguage)}</em>
                              </span>
                            </span>
                          </button>
                          {isHostConnecting ? (
                            <div className="host-card-loading" role="status" aria-live="polite">
                              <span className="host-card-spinner" aria-hidden="true" />
                              <strong>{t('app.host.connecting', appLanguage)}</strong>
                              <small>{host.username}@{host.address}:{host.port}</small>
                            </div>
                          ) : null}
                          <span className="host-card-actions">
                            <span
                              className={`host-connection-state ${connectionState.className}`}
                              title={connectionState.title}
                              aria-label={connectionState.title}
                            >
                              <i aria-hidden="true" />
                              {connectionState.label}
                            </span>
                            <details className="host-card-menu" onClick={(event) => event.stopPropagation()}>
                              <summary aria-label={t('app.host.actions', appLanguage)}>⋯</summary>
                              <div className="host-card-menu-panel">
                                <button
                                  type="button"
                                  disabled={isConnectionPending}
                                  onClick={(event) => {
                                    closeHostCardMenu(event.currentTarget);
                                    openHostFromList(host);
                                  }}
                                >
                                  {t('app.host.open', appLanguage)}
                                </button>
                                <button
                                  type="button"
                                  onClick={(event) => {
                                    closeHostCardMenu(event.currentTarget);
                                    startEditingHost(host);
                                  }}
                                >
                                  {t('app.host.edit', appLanguage)}
                                </button>
                                <button
                                  type="button"
                                  className="danger-text"
                                  onClick={(event) => {
                                    closeHostCardMenu(event.currentTarget);
                                    deleteHost(host);
                                  }}
                                >
                                  {t('app.host.delete', appLanguage)}
                                </button>
                              </div>
                            </details>
                          </span>
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <div className="empty-state">
                    <span>EMPTY</span>
                    <h3>{t(hosts.length ? 'app.host.emptyNoMatchesTitle' : 'app.host.emptyNoHostsTitle', appLanguage)}</h3>
                    <p>{t(hosts.length ? 'app.host.emptyNoMatchesDescription' : 'app.host.emptyNoHostsDescription', appLanguage)}</p>
                  </div>
                )}
              </div>
            </section>

          </section>
            </>
          ) : activePage === 'keys' ? (
            <Suspense fallback={<LazyContentFallback language={appLanguage} />}>
              <KeysPage
                keySearchQuery={keySearchQuery}
                filteredKeys={filteredKeys}
                sshKeys={sshKeys}
                onSearchChange={setKeySearchQuery}
                onImportPrivateKey={openImportKey}
                onCreateKey={openCreateKey}
                onEditKey={startEditingKey}
                onDeleteKey={deleteSshKey}
                onCopyPublicKey={copyPublicKey}
              />
            </Suspense>
          ) : activePage === 'snippets' ? (
            <Suspense fallback={<LazyContentFallback language={appLanguage} />}>
              <SnippetsPage settings={settings} onSettingsChange={updateSettingsAndPersist} />
            </Suspense>
          ) : activePage === 'logs' ? (
            <Suspense fallback={<LazyContentFallback language={appLanguage} />}>
              <LogsPage logs={logs} onClearLogs={clearLogs} />
            </Suspense>
          ) : (
            <Suspense fallback={<LazyContentFallback language={appLanguage} />}>
              <SettingsPage
                hostCount={hosts.length}
                keyCount={sshKeys.length}
                bookmarkCount={bookmarkCount}
                settings={settings}
                storageInfo={storageInfo}
                isConfigTransferPending={isConfigTransferPending}
                onSettingsChange={updateSettings}
                onImportConfig={importConfig}
                onExportConfig={exportConfig}
              />
            </Suspense>
          )}

          {isEditorOpen && activePage === 'hosts' ? (
            <aside className="editor-panel no-drag" aria-label={hostEditorTitle}>
              <div className="editor-header">
                <span>
                  <strong>{hostEditorTitle}</strong>
                  <small>{editingHost ? editingHost.name : t('app.host.editor.savedToVault', appLanguage)}</small>
                </span>
                <div className="editor-header-actions">
                  <button type="submit" className="editor-header-submit" form="host-editor-form">
                    {editingHost ? t('app.host.saveChanges', appLanguage) : t('app.host.addSubmit', appLanguage)}
                  </button>
                  <button type="button" className="editor-header-clear" onClick={resetForm}>
                    {t('app.form.clear', appLanguage)}
                  </button>
                  <button type="button" className="editor-header-close" onClick={closeEditor} aria-label={t('app.host.editor.close', appLanguage)}>×</button>
                </div>
              </div>

              <form id="host-editor-form" className="host-form" onSubmit={submitHost}>
                <label className="field">
                  <span>{t('app.host.field.name', appLanguage)}</span>
                  <input
                    value={form.name}
                    maxLength={80}
                    onChange={(event) => updateFormField('name', event.target.value)}
                    placeholder={t('app.host.field.namePlaceholder', appLanguage)}
                  />
                </label>

                <label className="field">
                  <span>{t('app.host.field.address', appLanguage)}</span>
                  <input
                    value={form.address}
                    maxLength={255}
                    onChange={(event) => updateFormField('address', event.target.value)}
                    placeholder={t('app.host.field.addressPlaceholder', appLanguage)}
                  />
                </label>

                <div className="editor-grid">
                  <label className="field">
                    <span>{t('app.host.field.username', appLanguage)}</span>
                    <input
                      value={form.username}
                      onChange={(event) => updateFormField('username', event.target.value)}
                      placeholder="root"
                    />
                  </label>

                  <label className="field">
                    <span>{t('app.host.field.port', appLanguage)}</span>
                    <input
                      value={form.port}
                      inputMode="numeric"
                      onChange={(event) => updateFormField('port', event.target.value)}
                      placeholder="22"
                    />
                  </label>
                </div>

                <div className="auth-method-section">
                  <span className="field-label">{t('app.host.field.authMethod', appLanguage)}</span>
                  <div className="auth-switch" role="group" aria-label={t('app.host.field.authMethod', appLanguage)}>
                    <button
                      type="button"
                      className={form.authMethod === 'password' ? 'active' : ''}
                      onClick={() => {
                        updateFormField('authMethod', 'password');
                        updateFormField('keyId', '');
                        updateFormField('keyPath', '');
                        updateFormField('passphrase', '');
                      }}
                    >
                      <strong>{t('app.auth.passwordLogin', appLanguage)}</strong>
                      <small>{t('app.host.auth.passwordSummary', appLanguage)}</small>
                    </button>
                    <button
                      type="button"
                      className={form.authMethod === 'key' ? 'active' : ''}
                      onClick={() => {
                        updateFormField('authMethod', 'key');
                        updateFormField('password', '');
                      }}
                    >
                      <strong>{t('app.auth.keyLogin', appLanguage)}</strong>
                      <small>{t('app.host.auth.keySummary', appLanguage)}</small>
                    </button>
                  </div>
                </div>

                {form.authMethod === 'key' ? (
                  <label className="field">
                    <span>{t('app.host.field.selectKey', appLanguage)}</span>
                    <select
                      value={form.keyId}
                      onChange={(event) => updateFormField('keyId', event.target.value)}
                    >
                      <option value="">{t('app.host.field.selectKeyOption', appLanguage)}</option>
                      {sshKeys.map((key) => (
                        <option key={key.id} value={key.id}>{key.name} · {key.fingerprint || key.algorithm}</option>
                      ))}
                    </select>
                    {!sshKeys.length ? <small className="field-note">{t('app.host.field.needKeyFirst', appLanguage)}</small> : null}
                  </label>
                ) : (
                  <label className="field">
                    <span>{t('app.host.field.password', appLanguage)}</span>
                    <input
                      type="password"
                      value={form.password}
                      onChange={(event) => updateFormField('password', event.target.value)}
                      placeholder={t('app.host.field.passwordPlaceholder', appLanguage)}
                    />
                  </label>
                )}

                {!hostFormUsesRootLogin ? (
                  <>
                    <div className="auth-method-section privilege-section">
                      <span className="field-label">{t('app.host.field.privilegeMode', appLanguage)}</span>
                      <div className="auth-switch privilege-switch" role="group" aria-label={t('app.host.field.privilegeMode', appLanguage)}>
                        <button
                          type="button"
                          className={form.privilegeMode === 'sudo' ? 'active' : ''}
                          aria-pressed={form.privilegeMode === 'sudo'}
                          title={t('app.host.privilege.sudoSummary', appLanguage)}
                          onClick={() => {
                            updateFormField('privilegeMode', 'sudo');
                            updateFormField('rootPassword', '');
                          }}
                        >
                          <strong>{t('app.host.privilege.sudo', appLanguage)}</strong>
                          <small>{t('app.host.privilege.sudoSummary', appLanguage)}</small>
                        </button>
                        <button
                          type="button"
                          className={form.privilegeMode === 'su-root' ? 'active' : ''}
                          aria-pressed={form.privilegeMode === 'su-root'}
                          title={t('app.host.privilege.suRootSummary', appLanguage)}
                          onClick={() => updateFormField('privilegeMode', 'su-root')}
                        >
                          <strong>{t('app.host.privilege.suRoot', appLanguage)}</strong>
                          <small>{t('app.host.privilege.suRootSummary', appLanguage)}</small>
                        </button>
                      </div>
                    </div>

                    {form.privilegeMode === 'su-root' ? (
                      <label className="field">
                        <span>{t('app.host.field.rootPassword', appLanguage)}</span>
                        <input
                          type="password"
                          value={form.rootPassword}
                          onChange={(event) => updateFormField('rootPassword', event.target.value)}
                          placeholder={t('app.host.field.rootPasswordPlaceholder', appLanguage)}
                        />
                        <small className="field-note">{t('app.host.field.rootPasswordHint', appLanguage)}</small>
                      </label>
                    ) : null}
                  </>
                ) : null}

                <label className="field">
                  <span>{t('app.host.field.jumpHost', appLanguage)}</span>
                  <select
                    value={form.jumpHostId}
                    onChange={(event) => updateFormField('jumpHostId', event.target.value)}
                  >
                    <option value="">{t('app.host.field.jumpHostDirect', appLanguage)}</option>
                    {jumpHostOptions.map((host) => (
                      <option key={host.id} value={host.id}>{host.name} · {host.username}@{host.address}:{host.port}</option>
                    ))}
                  </select>
                  <small className="field-note">
                    {jumpHostOptions.length
                      ? t('app.host.field.jumpHostHint', appLanguage)
                      : t('app.host.field.jumpHostEmpty', appLanguage)}
                  </small>
                </label>

                <div className="host-form-check-block">
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={form.canBeJumpHost}
                      onChange={(event) => updateFormField('canBeJumpHost', event.target.checked)}
                    />
                    <span>{t('app.host.field.canBeJumpHost', appLanguage)}</span>
                  </label>
                  <small className="field-note">{t('app.host.field.canBeJumpHostHint', appLanguage)}</small>
                </div>

                <label className="field">
                  <span>{t('app.host.field.group', appLanguage)}</span>
                  <input
                    value={form.group}
                    onChange={(event) => updateFormField('group', event.target.value)}
                    placeholder="AWS / Production / Lab"
                  />
                </label>

                <label className="field">
                  <span>{t('app.host.field.tags', appLanguage)}</span>
                  <input
                    value={form.tags}
                    onChange={(event) => updateFormField('tags', event.target.value)}
                    placeholder="linux, prod, db"
                  />
                </label>

                <label className="field">
                  <span>{t('app.host.field.note', appLanguage)}</span>
                  <textarea
                    value={form.note}
                    onChange={(event) => updateFormField('note', event.target.value)}
                    placeholder={t('app.host.field.notePlaceholder', appLanguage)}
                    rows={4}
                  />
                </label>

                {formError ? (
                  <DismissibleAlert className="error-banner" onDismiss={() => setFormError('')} role="alert">
                    {formError}
                  </DismissibleAlert>
                ) : null}

              </form>
            </aside>
          ) : null}

          {isKeyEditorOpen && activePage === 'keys' ? (
            <aside className="editor-panel no-drag" aria-label={editingKey ? t('app.key.editor.editAria', appLanguage) : t('app.key.editor.newAria', appLanguage)}>
              <div className="editor-header">
                <span>
                  <strong>{keyEditorTitle}</strong>
                  <small>{keyEditorSummary}</small>
                </span>
                <button type="button" onClick={closeKeyEditor} aria-label={t('app.key.editor.close', appLanguage)}>×</button>
              </div>

              <form className="host-form" onSubmit={submitKey}>
                <label className="field">
                  <span>{t('app.key.field.name', appLanguage)}</span>
                  <input
                    value={keyForm.name}
                    maxLength={80}
                    onChange={(event) => updateKeyFormField('name', event.target.value)}
                    placeholder={t('app.key.field.namePlaceholder', appLanguage)}
                  />
                </label>

                {!editingKey && keyEditorMode === 'generate' ? (
                  <label className="field">
                    <span>{t('app.key.field.rsaBits', appLanguage)}</span>
                    <select
                      value={keyForm.modulusLength}
                      onChange={(event) => updateKeyFormField('modulusLength', event.target.value as KeyFormState['modulusLength'])}
                    >
                      <option value="2048">2048</option>
                      <option value="3072">3072</option>
                      <option value="4096">4096</option>
                    </select>
                  </label>
                ) : null}

                {!editingKey && keyEditorMode === 'import' ? (
                  <>
                    <label className="field">
                      <span>{t('app.key.field.privateKey', appLanguage)}</span>
                      <div className="file-picker-row">
                        <input value={keyForm.privateKeyPath} readOnly placeholder={t('app.key.field.privateKeyPlaceholder', appLanguage)} />
                        <button type="button" className="command-button" onClick={selectPrivateKeyFileForKeyForm}>
                          {t('app.key.field.chooseFile', appLanguage)}
                        </button>
                      </div>
                    </label>

                    <label className="field">
                      <span>{t('app.key.field.publicKey', appLanguage)}</span>
                      <div className="file-picker-row">
                        <input value={keyForm.publicKeyPath} readOnly placeholder={t('app.key.field.publicKeyPlaceholder', appLanguage)} />
                        <button type="button" className="command-button" onClick={selectPublicKeyFileForKeyForm}>
                          {t('app.key.field.chooseFile', appLanguage)}
                        </button>
                      </div>
                    </label>
                  </>
                ) : null}

                {editingKey ? (
                  <>
                    <label className="field">
                      <span>{t('app.key.field.algorithm', appLanguage)}</span>
                      <input value={editingKey.algorithm || 'SSH'} readOnly />
                    </label>

                    <label className="field">
                      <span>{t('app.key.field.fingerprint', appLanguage)}</span>
                      <input value={editingKey.fingerprint || t('app.key.field.notGenerated', appLanguage)} readOnly />
                    </label>
                  </>
                ) : null}

                <label className="field">
                  <span>{editingKey ? t('app.key.field.savedPassphrase', appLanguage) : t('app.key.field.passphrase', appLanguage)}</span>
                  <input
                    type="password"
                    value={keyForm.passphrase}
                    onChange={(event) => updateKeyFormField('passphrase', event.target.value)}
                    placeholder={editingKey ? t('app.key.field.savedPassphrasePlaceholder', appLanguage) : t('app.key.field.passphrasePlaceholder', appLanguage)}
                  />
                </label>

                {keyFormError ? (
                  <DismissibleAlert className="error-banner" onDismiss={() => setKeyFormError('')} role="alert">
                    {keyFormError}
                  </DismissibleAlert>
                ) : null}

                <div className="form-actions">
                  <button type="submit" className="primary-action">
                    {editingKey ? t('app.host.saveChanges', appLanguage) : keyEditorMode === 'generate' ? t('app.key.submit.generate', appLanguage) : t('app.key.submit.import', appLanguage)}
                  </button>
                  <button type="button" className="command-button" onClick={resetKeyForm}>{t('app.form.clear', appLanguage)}</button>
                </div>
              </form>
            </aside>
          ) : null}

          {credentialHost ? (
            <aside className="credential-panel no-drag" aria-label={t('app.credential.panel', appLanguage)}>
              <div className="editor-header">
                <span>
                  <strong>{t('app.credential.panel', appLanguage)}</strong>
                  <small>{credentialHost.username}@{credentialHost.address}:{credentialHost.port}</small>
                </span>
                <button type="button" onClick={closeCredentialDialog} aria-label={t('app.credential.close', appLanguage)}>×</button>
              </div>

              <form className="host-form" onSubmit={submitCredentialConnection}>
                <div className="auth-method-section">
                  <span className="field-label">{t('app.credential.authMethod', appLanguage)}</span>
                  <div className="auth-switch" role="group" aria-label={t('app.credential.authMethod', appLanguage)}>
                    <button
                      type="button"
                      className={credentialForm.authMethod === 'password' ? 'active' : ''}
                      onClick={() => updateCredentialAuthMethod('password')}
                    >
                      <strong>{t('app.credential.password', appLanguage)}</strong>
                      <small>{t('app.credential.passwordSummary', appLanguage)}</small>
                    </button>
                    <button
                      type="button"
                      className={credentialForm.authMethod === 'key' ? 'active' : ''}
                      onClick={() => updateCredentialAuthMethod('key')}
                      disabled={!credentialCanUseKeyAuth}
                    >
                      <strong>{t('app.credential.key', appLanguage)}</strong>
                      <small>{t('app.credential.keySummary', appLanguage)}</small>
                    </button>
                  </div>
                </div>

                {credentialForm.authMethod === 'password' ? (
                  <label className="field">
                    <span>{t('app.credential.sshPassword', appLanguage)}</span>
                    <input
                      type="password"
                      value={credentialForm.password}
                      onChange={(event) => updateCredentialField('password', event.target.value)}
                      placeholder={t('app.credential.sshPasswordPlaceholder', appLanguage)}
                      autoFocus
                    />
                  </label>
                ) : (
                  <>
                    {sshKeys.length ? (
                      <label className="field">
                        <span>{t('app.host.field.selectKey', appLanguage)}</span>
                        <select
                          value={credentialForm.keyId}
                          onChange={(event) => updateCredentialKeyId(event.target.value)}
                          autoFocus
                        >
                          <option value="">{t('app.host.field.selectKeyOption', appLanguage)}</option>
                          {sshKeys.map((key) => (
                            <option key={key.id} value={key.id}>{key.name} · {key.fingerprint || key.algorithm}</option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    {credentialSelectedKey ? (
                      <div className="credential-note">
                        {t('app.credential.currentKey', appLanguage, { name: credentialSelectedKey.name })}
                      </div>
                    ) : credentialCanUseCurrentKeyFile ? (
                      <div className="credential-note">
                        {t('app.credential.currentKeyPath', appLanguage, { path: credentialHost.keyPath })}
                      </div>
                    ) : (
                      <div className="credential-note">
                        {t('app.credential.needKeyFirst', appLanguage)}
                      </div>
                    )}
                    <label className="field">
                      <span>{t('app.credential.keyPassphrase', appLanguage)}</span>
                      <input
                        type="password"
                        value={credentialForm.passphrase}
                        onChange={(event) => updateCredentialField('passphrase', event.target.value)}
                        placeholder={t('app.credential.passphrasePlaceholder', appLanguage)}
                        autoFocus
                      />
                    </label>
                  </>
                )}

                {hosts.some((host) => host.id === credentialHost.id) || (credentialForm.authMethod === 'key' && credentialSelectedKey) ? (
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={credentialForm.saveCredential}
                      onChange={(event) => updateCredentialField('saveCredential', event.target.checked)}
                    />
                    <span>{credentialSaveLabel}</span>
                  </label>
                ) : null}

                {credentialError ? (
                  <DismissibleAlert className="error-banner" onDismiss={() => setCredentialError('')} role="alert">
                    {credentialError}
                  </DismissibleAlert>
                ) : null}

                <div className="form-actions">
                  <button type="submit" className="primary-action" disabled={isConnectionPending}>
                    {isCredentialConnecting ? t('app.host.connectingButton', appLanguage) : t('app.host.connectButton', appLanguage)}
                  </button>
                  <button type="button" className="command-button" onClick={closeCredentialDialog}>{t('common.cancel', appLanguage)}</button>
                </div>
              </form>
            </aside>
          ) : null}

          {deleteConfirmation ? (
            <div className="notepad-modal-overlay no-drag" role="presentation" onClick={() => setDeleteConfirmation(null)}>
              <div className="notepad-modal" role="alertdialog" aria-modal="true" aria-labelledby="delete-confirm-title" onClick={(event) => event.stopPropagation()}>
                <div id="delete-confirm-title" className="notepad-modal-title">
                  {t(isHostDeleteBlocked ? 'app.deleteConfirm.blockedTitle' : 'app.deleteConfirm.title', appLanguage)}
                </div>
                <div className="notepad-modal-message">{deleteConfirmationMessage}</div>
                <div className="notepad-modal-actions">
                  {isHostDeleteBlocked ? (
                    <button type="button" className="notepad-modal-btn primary" onClick={() => setDeleteConfirmation(null)}>{t('common.close', appLanguage)}</button>
                  ) : (
                    <>
                      <button type="button" className="notepad-modal-btn" onClick={() => setDeleteConfirmation(null)}>{t('common.cancel', appLanguage)}</button>
                      <button type="button" className="notepad-modal-btn danger" onClick={confirmPendingDelete}>{t('app.host.delete', appLanguage)}</button>
                    </>
                  )}
                </div>
              </div>
            </div>
          ) : null}
        </main>
      </div>
      )}
    </div>
  );
}

export default App;
