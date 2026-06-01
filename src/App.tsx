import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import RemoteDesktop from './RemoteDesktopShell';
import appIconUrl from './assets/images/icon.png';
import DismissibleAlert from './components/DismissibleAlert';
import NavIcon, { type NavIconName } from './components/navigation/NavIcon';
import type { RemoteConnectionInfo } from './components/remote-desktop/types';
import { buildFontStack } from './fontUtils';
import KeysPage from './pages/KeysPage';
import LogsPage from './pages/LogsPage';
import SettingsPage from './pages/SettingsPage';
import { getAppLocale, getSystemLanguage, useShellDeskI18n } from './i18n';

const hostsStorageKey = 'shelldesk:hosts';
const hostGroupPanelCollapsedStorageKey = 'shelldesk:host-groups-collapsed';
const ungroupedKey = '__ungrouped__';
const remoteDesktopAppCatalogVersion = 2;
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
const defaultAppSettings: ShellDeskAppSettings = {
  language: getSystemLanguage(),
  interfaceFont: 'Microsoft YaHei UI',
  theme: 'dark',
  accentColor: '#43c7ff',
  defaultHostView: 'grid',
  desktopWallpaperMode: 'default',
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
};

type AppPage = 'hosts' | 'keys' | 'logs' | 'settings';
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

const navigationItems: ReadonlyArray<{ page: Exclude<AppPage, 'settings'>; icon: NavIconName; label: string }> = [
  { page: 'hosts', icon: 'hosts', label: '主机' },
  { page: 'keys', icon: 'keys', label: '密钥' },
  { page: 'logs', icon: 'logs', label: '日志' },
];

const hostSystemLabels: Record<HostSystemType, string> = {
  unknown: '未识别系统',
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

  return luminance > 0.58 ? '#0b1220' : '#ffffff';
}

const hostSystemIconUrls: Record<HostSystemType, string> = {
  unknown: new URL('./assets/os-icons/unknown.svg', import.meta.url).href,
  windows: new URL('./assets/os-icons/windows.svg', import.meta.url).href,
  macos: new URL('./assets/os-icons/macos.svg', import.meta.url).href,
  ubuntu: new URL('./assets/os-icons/ubuntu.svg', import.meta.url).href,
  debian: new URL('./assets/os-icons/debian.svg', import.meta.url).href,
  redhat: new URL('./assets/os-icons/redhat.svg', import.meta.url).href,
  centos: new URL('./assets/os-icons/centos.svg', import.meta.url).href,
  fedora: new URL('./assets/os-icons/fedora.svg', import.meta.url).href,
  rocky: new URL('./assets/os-icons/rocky.svg', import.meta.url).href,
  almalinux: new URL('./assets/os-icons/almalinux.svg', import.meta.url).href,
  oracle: new URL('./assets/os-icons/oracle.svg', import.meta.url).href,
  amazon: new URL('./assets/os-icons/amazon.svg', import.meta.url).href,
  arch: new URL('./assets/os-icons/arch.svg', import.meta.url).href,
  manjaro: new URL('./assets/os-icons/manjaro.svg', import.meta.url).href,
  alpine: new URL('./assets/os-icons/alpine.svg', import.meta.url).href,
  opensuse: new URL('./assets/os-icons/opensuse.svg', import.meta.url).href,
  linuxmint: new URL('./assets/os-icons/linuxmint.svg', import.meta.url).href,
  kali: new URL('./assets/os-icons/kali.svg', import.meta.url).href,
  raspbian: new URL('./assets/os-icons/raspbian.svg', import.meta.url).href,
  gentoo: new URL('./assets/os-icons/gentoo.svg', import.meta.url).href,
  nixos: new URL('./assets/os-icons/nixos.svg', import.meta.url).href,
  popos: new URL('./assets/os-icons/popos.svg', import.meta.url).href,
  elementary: new URL('./assets/os-icons/elementary.svg', import.meta.url).href,
  linux: new URL('./assets/os-icons/linux.svg', import.meta.url).href,
  unix: new URL('./assets/os-icons/unix.svg', import.meta.url).href,
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

function validateKeyForm(form: KeyFormState, mode: KeyEditorMode) {
  const name = form.name.trim();

  if (!name) {
    return '请输入密钥名称。';
  }

  if (name.length > 80 || form.passphrase.length > 4096) {
    return '密钥信息长度超出限制。';
  }

  if (mode === 'import') {
    if (!form.privateKeyPath.trim()) {
      return '请选择私钥文件。';
    }

    if (form.privateKeyPath.trim().length > 1024 || form.publicKeyPath.trim().length > 1024) {
      return '密钥文件路径过长。';
    }
  }

  if (mode === 'generate' && !['2048', '3072', '4096'].includes(form.modulusLength)) {
    return 'RSA 位数无效。';
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

interface ConnectionErrorNotice {
  hostName: string;
  endpoint: string;
  message: string;
}

type ConnectionLaunchSource = 'host-card' | 'quick-connect' | 'credential';

type StoredHost = Omit<Host, 'authMethod' | 'password' | 'keyId' | 'keyPath' | 'passphrase' | 'systemType' | 'systemName' | 'lastConnectionStatus' | 'lastConnectionAt' | 'lastConnectionError'> &
  Partial<Pick<Host, 'authMethod' | 'password' | 'keyId' | 'keyPath' | 'passphrase' | 'systemType' | 'systemName' | 'lastConnectionStatus' | 'lastConnectionAt' | 'lastConnectionError'>>;

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

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
  }

  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }

  return '操作失败。';
}

function isAuthFailureMessage(message: string) {
  return /认证失败|authentication methods failed|password|private key|passphrase|密钥|口令/i.test(message);
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

function getHostConnectionStatus(value: unknown): HostConnectionStatus {
  return value === 'success' || value === 'failed' ? value : 'unknown';
}

function getAuthLabel(host: Pick<Host, 'authMethod' | 'password'>, key: SshKey | null) {
  if (host.authMethod === 'key') {
    if (!key) {
      return '密钥登录';
    }

    return key.passphrase ? `密钥 · ${key.name} · 口令已保存` : `密钥 · ${key.name}`;
  }

  return host.password ? '密码登录 · 已保存' : '密码登录';
}

function getHostSystemLabel(host: Pick<Host, 'systemName' | 'systemType'>) {
  return host.systemName || hostSystemLabels[host.systemType];
}

function getHostConnectionStateView(host: Pick<Host, 'lastConnectionStatus' | 'lastConnectionAt' | 'lastConnectionError'>) {
  if (host.lastConnectionStatus === 'failed') {
    const failureDetail = host.lastConnectionError ? `：${host.lastConnectionError}` : '';
    const failureTime = host.lastConnectionAt ? `（${host.lastConnectionAt}）` : '';

    return {
      className: 'not-ready',
      label: '未就绪',
      title: `上次连接失败${failureTime}${failureDetail}`,
    };
  }

  return {
    className: 'ready',
    label: '就绪',
    title: host.lastConnectionStatus === 'success' ? '上次连接成功' : '主机配置就绪',
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
    systemType: getHostSystemType(host.systemType, host.systemName),
    systemName: typeof host.systemName === 'string' ? host.systemName : '',
    lastConnectionStatus: getHostConnectionStatus(host.lastConnectionStatus),
    lastConnectionAt: typeof host.lastConnectionAt === 'string' ? host.lastConnectionAt : '',
    lastConnectionError: typeof host.lastConnectionError === 'string' ? host.lastConnectionError : '',
  };
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

    return parsedHosts.filter(isStoredHost).map(normalizeStoredHost);
  } catch {
    return [];
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

function validateHostForm(form: HostFormState, keys: SshKey[]) {
  const port = Number(form.port);
  const selectedKey = keys.find((key) => key.id === form.keyId);

  if (!form.name.trim()) {
    return '请输入主机名称。';
  }

  if (!form.address.trim()) {
    return '请输入主机地址。';
  }

  if (!form.username.trim()) {
    return '请输入用户名。';
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return '端口必须是 1 到 65535 之间的整数。';
  }

  if (form.name.trim().length > 80) {
    return '主机名称不能超过 80 个字符。';
  }

  if (form.address.trim().length > 255) {
    return '主机地址不能超过 255 个字符。';
  }

  if (form.username.trim().length > 128) {
    return '用户名不能超过 128 个字符。';
  }

  if (form.authMethod === 'key' && !selectedKey) {
    return '选择密钥登录时需要选择已有密钥。';
  }

  if (form.password.length > 4096) {
    return '密码长度不能超过 4096 个字符。';
  }

  return '';
}

function createHostFromForm(form: HostFormState, selectedKey: SshKey | null): Host {
  const now = new Date().toISOString();

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
  const nextPassword = form.authMethod === 'password' ? form.password : '';
  const nextKeyId = form.authMethod === 'key' ? selectedKey?.id ?? '' : '';
  const connectionProfileChanged =
    endpointChanged ||
    host.authMethod !== form.authMethod ||
    host.password !== nextPassword ||
    host.keyId !== nextKeyId;

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
    systemType: endpointChanged ? 'unknown' : host.systemType,
    systemName: endpointChanged ? '' : host.systemName,
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
      ? initialPublicSnapshot.hosts.filter(isStoredHost).map(normalizeStoredHost)
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
  const [formError, setFormError] = useState('');
  const [keyFormError, setKeyFormError] = useState('');
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [isKeyEditorOpen, setIsKeyEditorOpen] = useState(false);
  const [settings, setSettings] = useState<ShellDeskAppSettings>(initialPublicSnapshot?.settings ?? defaultAppSettings);
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
  const [credentialHost, setCredentialHost] = useState<ConnectionHost | null>(null);
  const [credentialForm, setCredentialForm] = useState<CredentialFormState>(emptyCredentialForm);
  const [credentialError, setCredentialError] = useState('');
  const [isConfigTransferPending, setIsConfigTransferPending] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState<DeleteConfirmationRequest | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const lastPersistedCollectionsRef = useRef('');
  const collectionsSaveInFlightRef = useRef(false);
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
  const appLocale = getAppLocale(settings.language);

  useShellDeskI18n(settings.language);

  const hostGroups = useMemo<HostGroup[]>(() => {
    const groups = new Map<string, HostGroup>();

    for (const host of hosts) {
      const key = getHostGroupKey(host);
      const name = host.group || '未分组';
      const currentGroup = groups.get(key);

      groups.set(key, {
        key,
        name,
        count: (currentGroup?.count ?? 0) + 1,
      });
    }

    return Array.from(groups.values()).sort((left, right) => left.name.localeCompare(right.name, appLocale));
  }, [appLocale, hosts]);

  const filteredHosts = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    return hosts.filter((host) => {
      const hostKey = sshKeyById.get(host.keyId) ?? null;
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
          getAuthLabel(host, hostKey),
          ...host.tags,
        ]
          .join(' ')
          .toLowerCase()
          .includes(query);

      return matchesGroup && matchesQuery;
    });
  }, [activeGroupKey, hosts, searchQuery, sshKeyById]);

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

    if (updateCollections) {
      const nextHosts = snapshot.hosts.filter(isStoredHost).map(normalizeStoredHost);
      const nextKeys = snapshot.sshKeys.filter(isStoredSshKey);

      setHosts(nextHosts);
      setSshKeys(nextKeys);

      if (hydrated) {
        lastPersistedCollectionsRef.current = JSON.stringify({
          hosts: nextHosts,
          sshKeys: nextKeys,
          settings: snapshot.settings,
        });
      }
    }

    setSettings(snapshot.settings);
    setStorageInfo(snapshot.storage);
    setBookmarkCount(snapshot.browserBookmarks.reduce((total: number, collection: ShellDeskBrowserBookmarkCollection) => total + collection.bookmarks.length, 0));
    setIsVaultReady(true);

    if (hydrated) {
      setIsVaultHydrated(true);
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

    void vaultControls.saveCollections(pendingSave.payload).then((snapshot) => {
      lastPersistedCollectionsRef.current = pendingSave.serialized;
      setStorageInfo(snapshot.storage);
      setBookmarkCount(snapshot.browserBookmarks.reduce((total: number, collection: ShellDeskBrowserBookmarkCollection) => total + collection.bookmarks.length, 0));
    }).catch((error: unknown) => {
      setStatusMessage(`保存本地数据失败：${getErrorMessage(error)}`);
    }).finally(() => {
      collectionsSaveInFlightRef.current = false;

      if (pendingCollectionsSaveRef.current) {
        flushCollectionsSave();
      }
    });
  }, [vaultControls]);

  const scheduleCollectionsSave = useCallback((payload: VaultCollectionsSavePayload, serialized: string) => {
    pendingCollectionsSaveRef.current = { payload, serialized };
    flushCollectionsSave();
  }, [flushCollectionsSave]);

  const refreshHosts = async () => {
    if (!vaultControls) {
      const nextHosts = readStoredHosts();
      setHosts(nextHosts);
      setStatusMessage(`已刷新 ${nextHosts.length} 台主机。`);
      return;
    }

    try {
      const snapshot = await vaultControls.getSnapshot();
      applyVaultSnapshot(snapshot);
      setStatusMessage(`已刷新 ${snapshot.hosts.length} 台主机。`);
    } catch (error) {
      setStatusMessage(`刷新主机列表失败：${getErrorMessage(error)}`);
    }
  };

  useEffect(() => {
    if (!windowConnectionId) {
      return;
    }

    if (!window.guiSSH?.connections) {
      setWindowConnectionError('当前运行环境不支持连接窗口。');
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
  }, [windowConnectionId]);

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
          setStatusMessage(renderedPublicSnapshot
            ? `读取本地凭据失败：${getErrorMessage(error)}`
            : `读取本地数据失败：${getErrorMessage(error)}`);
        }
      }
    };

    void loadSnapshot();

    return () => {
      disposed = true;
    };
  }, [isConnectionWindow, vaultControls]);

  useEffect(() => {
    storeHostGroupPanelCollapsed(isHostGroupPanelCollapsed);
  }, [isHostGroupPanelCollapsed]);

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
    if (!vaultControls || !isVaultReady || !isVaultHydrated) {
      return;
    }

    const payload: VaultCollectionsSavePayload = { hosts, sshKeys, settings };
    const serializedPayload = JSON.stringify(payload);

    if (serializedPayload === lastPersistedCollectionsRef.current) {
      return;
    }

    scheduleCollectionsSave(payload, serializedPayload);
  }, [hosts, isVaultHydrated, isVaultReady, scheduleCollectionsSave, settings, sshKeys, vaultControls]);

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

    const delay = /失败|超时|断开|拒绝|重置|不可用|无效/.test(statusMessage) ? 8000 : 2400;
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
    root.style.setProperty('--bg', isLightTheme ? '#e7edf5' : '#0b111a');
    root.style.setProperty('--chrome', isLightTheme ? '#dfe7f1' : '#1b222b');
    root.style.setProperty('--sidebar', isLightTheme ? '#dde6f0' : '#20262f');
    root.style.setProperty('--sidebar-active', isLightTheme ? '#ccd8e6' : '#3a3f49');
    root.style.setProperty('--surface', isLightTheme ? '#f8fafc' : '#111820');
    root.style.setProperty('--surface-soft', isLightTheme ? '#eef3f8' : '#161e28');
    root.style.setProperty('--surface-strong', isLightTheme ? '#dfe7f1' : '#1a2330');
    root.style.setProperty('--surface-elevated', isLightTheme ? '#edf2f7' : '#141b25');
    root.style.setProperty('--surface-input', isLightTheme ? '#f8fafc' : '#1a212c');
    root.style.setProperty('--surface-control', isLightTheme ? '#e4ebf4' : '#202733');
    root.style.setProperty('--surface-hover', isLightTheme ? '#e5edf6' : '#141d28');
    root.style.setProperty('--surface-icon', isLightTheme ? '#d2e1f1' : '#12334a');
    root.style.setProperty('--surface-panel', isLightTheme ? '#f2f6fb' : '#151d28');
    root.style.setProperty('--surface-empty', isLightTheme ? 'rgba(16, 32, 51, 0.035)' : 'rgba(255, 255, 255, 0.025)');
    root.style.setProperty('--surface-pill', isLightTheme ? '#d2dce8' : '#1d2632');
    root.style.setProperty('--surface-success-soft', isLightTheme ? 'rgba(34, 160, 90, 0.08)' : 'rgba(119, 244, 197, 0.08)');
    root.style.setProperty('--surface-success-border', isLightTheme ? 'rgba(34, 160, 90, 0.22)' : 'rgba(119, 244, 197, 0.22)');
    root.style.setProperty('--text-success', isLightTheme ? '#1a8a55' : '#d8fff1');
    root.style.setProperty('--toast-bg', isLightTheme ? 'rgba(241, 246, 251, 0.96)' : 'rgba(12, 23, 34, 0.92)');
    root.style.setProperty('--toast-text', isLightTheme ? '#1a6d94' : '#c6efff');
    root.style.setProperty('--text', isLightTheme ? '#18263a' : '#edf4ff');
    root.style.setProperty('--muted', isLightTheme ? '#627890' : '#8b9aad');
    root.style.setProperty('--muted-strong', isLightTheme ? '#415874' : '#bfcede');
    root.style.setProperty('--border', isLightTheme ? 'rgba(20, 42, 68, 0.14)' : 'rgba(139, 164, 195, 0.14)');
    root.style.setProperty('--border-strong', isLightTheme ? 'rgba(20, 42, 68, 0.22)' : 'rgba(139, 164, 195, 0.28)');
    root.style.setProperty('--window-border', isLightTheme ? 'rgba(20, 42, 68, 0.1)' : 'rgba(255, 255, 255, 0.04)');
    root.style.setProperty('--window-divider', isLightTheme ? 'rgba(20, 42, 68, 0.1)' : 'rgba(255, 255, 255, 0.05)');
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
    root.style.setProperty('--shadow-soft', isLightTheme ? '0 6px 18px rgba(43, 67, 92, 0.08)' : '0 12px 28px rgba(0, 0, 0, 0.16)');
    root.style.setProperty('--shadow-float', isLightTheme ? '0 12px 28px rgba(43, 67, 92, 0.16)' : '0 18px 36px rgba(0, 0, 0, 0.32)');
    root.style.setProperty('--shadow-panel', isLightTheme ? '0 16px 48px rgba(43, 67, 92, 0.16)' : '0 24px 70px rgba(0, 0, 0, 0.42)');
    root.style.setProperty('--shadow-panel-strong', isLightTheme ? '0 16px 48px rgba(43, 67, 92, 0.18)' : '0 24px 70px rgba(0, 0, 0, 0.46)');
    root.style.setProperty('--toggle-off', isLightTheme ? '#c3cedb' : '#202938');
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
        const message = payload.reason || 'SSH 连接已断开。';
        const time = new Date().toLocaleTimeString(appLocale);
        addLog('connection', 'warning', `连接断开：${connection.host.address}`, `${time} — ${message}`);
        setStatusMessage(message);
        // 不自动关闭窗口，让用户看到断开原因
        setWindowConnectionError(`${time} — ${message}`);
      }
    });
    const removeReconnecting = window.guiSSH.events.onConnectionReconnecting((payload: ConnectionReconnectingPayload) => {
      if (payload.connectionId !== connection.id) {
        return;
      }

      const message = payload.reason || 'SSH 连接已断开，正在自动重连。';
      setStatusMessage(message);
    });
    const removeRestored = window.guiSSH.events.onConnectionRestored((payload: ConnectionRestoredPayload) => {
      if (payload.connectionId !== connection.id) {
        return;
      }

      const time = new Date().toLocaleTimeString(appLocale);
      addLog('connection', 'success', `连接恢复：${connection.host.address}`, `${time} — SSH 已自动重连。`);
      setWindowConnectionError('');
      setStatusMessage('SSH 已自动重连。');
    });

    return () => {
      removeClosed();
      removeReconnecting();
      removeRestored();
    };
  }, [appLocale, connection, isConnectionWindow, windowControls]);

  useEffect(() => {
    if (!window.guiSSH?.events.onVaultChanged || !vaultControls) {
      return;
    }

    return window.guiSSH.events.onVaultChanged((payload) => {
      if (payload.kind !== 'vault' && payload.kind !== 'bookmarks' && !isConnectionWindow) {
        return;
      }

      if (payload.kind === 'vault' && (collectionsSaveInFlightRef.current || pendingCollectionsSaveRef.current)) {
        return;
      }

      void vaultControls.getSnapshot().then((snapshot) => {
        applyVaultSnapshot(snapshot, { updateCollections: isConnectionWindow || payload.kind === 'vault' });
      }).catch(() => undefined);
    });
  }, [isConnectionWindow, vaultControls]);

  const updateSettings = useCallback((nextSettings: ShellDeskAppSettings) => {
    setSettings(nextSettings);
  }, []);

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

  const submitKey = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const mode = editingKey ? 'edit' : keyEditorMode;
    const validationError = validateKeyForm(keyForm, mode);

    if (validationError) {
      setKeyFormError(validationError);
      return;
    }

    if (editingKey) {
      const updatedKey = updateSshKeyFromForm(editingKey, keyForm);
      setSshKeys((currentKeys) => currentKeys.map((key) => (key.id === editingKey.id ? updatedKey : key)));
      addLog('key', 'success', `更新密钥：${updatedKey.name}`);
      setStatusMessage(`已更新密钥：${updatedKey.name}`);
      closeKeyEditor();
      return;
    }

    if (!vaultControls) {
      setKeyFormError('当前运行环境不支持安全密钥库。');
      return;
    }

    const action = keyEditorMode === 'generate'
      ? vaultControls.generateRsaKeyPair({
          name: keyForm.name.trim(),
          passphrase: keyForm.passphrase,
          modulusLength: Number(keyForm.modulusLength),
        })
      : vaultControls.importKeyPair({
          name: keyForm.name.trim(),
          privateKeyPath: keyForm.privateKeyPath.trim(),
          publicKeyPath: keyForm.publicKeyPath.trim(),
          passphrase: keyForm.passphrase,
        });

    action
      .then(({ snapshot, key }) => {
        applyVaultSnapshot(snapshot);
        addLog('key', 'success', keyEditorMode === 'generate' ? `生成密钥：${key.name}` : `导入密钥：${key.name}`);
        setStatusMessage(keyEditorMode === 'generate' ? `已生成密钥：${key.name}` : `已导入密钥：${key.name}`);
        closeKeyEditor();
      })
      .catch((error: unknown) => {
        setKeyFormError(getErrorMessage(error));
      });
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
      setStatusMessage(`密钥「${key.name}」当前没有可复制的公钥。`);
      return;
    }

    try {
      await navigator.clipboard.writeText(key.publicKey);
      setStatusMessage(`已复制公钥：${key.name}`);
    } catch (error) {
      setStatusMessage(`复制失败：${getErrorMessage(error)}`);
    }
  };

  const deleteSshKey = (key: SshKey) => {
    const relatedHosts = hosts.filter((host) => host.keyId === key.id);
    setDeleteConfirmation({ kind: 'ssh-key', key, relatedHostCount: relatedHosts.length });
  };

  const confirmDeleteSshKey = (key: SshKey) => {
    const relatedHosts = hosts.filter((host) => host.keyId === key.id);
    setSshKeys((currentKeys) => currentKeys.filter((currentKey) => currentKey.id !== key.id));

    if (relatedHosts.length) {
      setHosts((currentHosts) => currentHosts.map((host) => (
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
      )));
    }

    if (editingKeyId === key.id) {
      closeKeyEditor();
    }

    addLog('key', 'info', `删除密钥：${key.name}`, relatedHosts.length ? `关联 ${relatedHosts.length} 台主机已切换为密码登录` : '');
    setStatusMessage(`已删除密钥：${key.name}`);
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

    setHosts((currentHosts) => currentHosts.map((currentHost) => (
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
    const validationError = validateHostForm(form, sshKeys);

    if (validationError) {
      setFormError(validationError);
      return;
    }

    if (editingHost) {
      const updatedHost = updateHostFromForm(editingHost, form, selectedKey);
      setHosts((currentHosts) => currentHosts.map((host) => (host.id === editingHost.id ? updatedHost : host)));
      addLog('host', 'success', `更新主机：${updatedHost.name}`, `${updatedHost.username}@${updatedHost.address}:${updatedHost.port}`);
      setStatusMessage(`已更新主机：${updatedHost.name}`);
    } else {
      const nextHost = createHostFromForm(form, selectedKey);
      setHosts((currentHosts) => [nextHost, ...currentHosts]);
      addLog('host', 'success', `添加主机：${nextHost.name}`, `${nextHost.username}@${nextHost.address}:${nextHost.port}`);
      setStatusMessage(`已添加主机：${nextHost.name}`);
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
    setDeleteConfirmation({ kind: 'host', host });
  };

  const confirmDeleteHost = (host: Host) => {
    const nextHosts = hosts.filter((currentHost) => currentHost.id !== host.id);
    setHosts(nextHosts);
    addLog('host', 'info', `删除主机：${host.name}`, `${host.username}@${host.address}:${host.port}`);
    setStatusMessage(`已删除主机：${host.name}`);

    if (editingHostId === host.id) {
      closeEditor();
    }
  };

  const confirmPendingDelete = () => {
    if (!deleteConfirmation) {
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
      const message = '当前运行环境不支持 SSH 连接。';
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
      const message = '该主机未选择有效密钥。';
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

    try {
      const nextConnection = await window.guiSSH.connections.connect(hostForConnection);
      const detectedSystemType = getHostSystemType(nextConnection.host?.systemType, nextConnection.host?.systemName);
      const detectedSystemName = typeof nextConnection.host?.systemName === 'string' ? nextConnection.host.systemName : '';
      const hasDetectedSystem = detectedSystemType !== 'unknown' || Boolean(detectedSystemName);
      const connectionFinishedAt = new Date().toISOString();

      setHosts((currentHosts) =>
        currentHosts.map((currentHost) =>
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
        ),
      );

      if (credentials?.saveCredential && effectiveAuthMethod === 'key' && selectedKey) {
        setSshKeys((currentKeys) => currentKeys.map((key) => (
          key.id === selectedKey.id
            ? { ...key, passphrase: credentials.passphrase, updatedAt: connectionFinishedAt }
            : key
        )));
      }

      if (isConnectionWindow) {
        setConnection({ ...nextConnection, host: nextConnection.host ?? hostForConnection });
        addLog('connection', 'success', `连接成功：${host.name}`, `${host.username}@${host.address}:${host.port}`);
        setStatusMessage(`已连接：${host.name}`);
      } else {
        addLog('connection', 'success', `打开连接窗口：${host.name}`, `${host.username}@${host.address}:${host.port}`);
        setStatusMessage(`已打开连接窗口：${host.name}`);
      }

      closeCredentialDialog();
      setConnectionErrorNotice(null);
      return true;
    } catch (error) {
      const message = getErrorMessage(error);
      markHostConnectionResult(hostForConnection, 'failed', message);
      addLog('connection', 'error', `连接失败：${host.name}`, `${host.username}@${host.address}:${host.port} — ${message}`);
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

  const connectCommandBarInput = async () => {
    if (isConnectionPending) {
      return;
    }

    const parsedCommand = parseQuickConnectCommand(searchQuery);

    if (!parsedCommand) {
      setStatusMessage('请输入合法 SSH 命令，例如 ssh user@host、ssh -p 2222 user@host 或 user@host。');
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
      setCredentialError('请输入 SSH 密码。');
      return;
    }

    if (
      credentialForm.authMethod === 'key' &&
      !credentialForm.keyId &&
      !(credentialHost.authMethod === 'key' && credentialHost.keyPath)
    ) {
      setCredentialError('请选择 SSH 密钥。');
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
      setStatusMessage('当前运行环境不支持导出配置。');
      return;
    }

    setIsConfigTransferPending(true);

    try {
      const filePath = await window.guiSSH.files.exportConfig();

      if (!filePath) {
        return;
      }

      setStatusMessage(`已导出 ${hosts.length} 台主机、${sshKeys.length} 把密钥和 ${bookmarkCount} 条书签。`);
      addLog('config', 'success', '导出配置', `${hosts.length} 台主机、${sshKeys.length} 把密钥、${bookmarkCount} 条书签`);
    } catch (error) {
      addLog('config', 'error', '导出配置失败', getErrorMessage(error));
      setStatusMessage(`导出失败：${getErrorMessage(error)}`);
    } finally {
      setIsConfigTransferPending(false);
    }
  };

  const importConfig = async () => {
    if (!window.guiSSH?.files.importConfig) {
      setStatusMessage('当前运行环境不支持导入配置。');
      return;
    }

    setIsConfigTransferPending(true);

    try {
      const importedConfig = await window.guiSSH.files.importConfig();

      if (!importedConfig) {
        return;
      }

      if (!importedConfig.hosts.length && !importedConfig.sshKeys.length) {
        setStatusMessage('导入文件中没有可用配置。');
        return;
      }

      closeEditor();
      closeKeyEditor();
      closeCredentialDialog();
      applyVaultSnapshot(importedConfig);
      setStatusMessage(`已导入 ${importedConfig.hosts.length} 台主机、${importedConfig.sshKeys.length} 把密钥和 ${importedConfig.browserBookmarks.reduce((total, collection) => total + collection.bookmarks.length, 0)} 条书签。`);
      addLog('config', 'success', '导入配置', `${importedConfig.hosts.length} 台主机、${importedConfig.sshKeys.length} 把密钥`);
    } catch (error) {
      addLog('config', 'error', '导入配置失败', getErrorMessage(error));
      setStatusMessage(`导入失败：${getErrorMessage(error)}`);
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
    ? '连接成功后保存到此主机配置'
    : credentialForm.authMethod === 'key'
      ? '连接成功后保存密钥口令'
      : '连接成功后记住本次密码';

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
            <button type="button" className="titlebar-button minimize" aria-label="最小化" title="最小化" onClick={minimizeWindow}>−</button>
            <button
              type="button"
              className={`titlebar-button maximize ${isWindowMaximized ? 'restore' : ''}`}
              aria-label={isWindowMaximized ? '还原' : '最大化'}
              title={isWindowMaximized ? '还原' : '最大化'}
              onClick={toggleMaximizeWindow}
            >
              <span className={`window-control-icon ${isWindowMaximized ? 'restore' : 'maximize'}`} aria-hidden="true" />
            </button>
            <button type="button" className="titlebar-button danger" aria-label="关闭" title="关闭" onClick={closeWindow}>×</button>
          </div>
        ) : null}
      </header>

      {statusMessage ? <div className="status-toast no-drag" role="status">{statusMessage}</div> : null}
      {connectionErrorNotice ? createPortal(
        <div className="connection-error-overlay no-drag" role="presentation">
          <div className="connection-error-dialog" role="alertdialog" aria-modal="false" aria-labelledby="connection-error-title">
            <span className="connection-error-mark" aria-hidden="true">!</span>
            <div className="connection-error-copy">
              <strong id="connection-error-title">连接失败：{connectionErrorNotice.hostName}</strong>
              <span>{connectionErrorNotice.endpoint}</span>
              <p>{connectionErrorNotice.message}</p>
            </div>
            <button type="button" onClick={() => setConnectionErrorNotice(null)}>关闭</button>
          </div>
        </div>,
        document.body,
      ) : null}

      {connection ? (
        <RemoteDesktop connection={connection} settings={settings} onSettingsChange={updateSettings} />
      ) : isConnectionWindow ? (
        <main className="vault-page no-drag">
          <div className="empty-state">
            <span>{windowConnectionError ? 'CLOSED' : 'OPENING'}</span>
            <h3>{windowConnectionError ? '连接窗口不可用' : '正在打开连接窗口'}</h3>
            <p>{windowConnectionError || '正在读取 SSH 连接信息。'}</p>
            {windowConnectionError ? (
              <button type="button" className="command-button" onClick={closeWindow}>关闭窗口</button>
            ) : null}
          </div>
        </main>
      ) : (
      <div className="app-layout">
        <aside className="side-nav">
          <nav className="feature-nav" aria-label="功能导航">
            {navigationItems.map((item) => (
              <button
                key={item.page}
                type="button"
                className={`feature-nav-item ${activePage === item.page ? 'active' : ''}`}
                onClick={() => setActivePage(item.page)}
              >
                <span className="nav-icon"><NavIcon name={item.icon} /></span>
                {item.label}
              </button>
            ))}
          </nav>

          <button
            type="button"
            className={`settings-entry ${activePage === 'settings' ? 'active' : ''}`}
            onClick={() => setActivePage('settings')}
          >
            <span className="nav-icon"><NavIcon name="settings" /></span>
            设置
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
                placeholder="查找主机或快速连接（例如：ssh user@hostname -p 2222）"
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
              {isQuickConnecting ? '连接中...' : '连接'}
            </button>

            <button type="button" className="primary-action" onClick={openCreateHost}>+ 新建主机</button>
          </div>

          <section className={`vault-content hosts-content ${isHostGroupPanelCollapsed ? 'groups-collapsed' : ''}`}>
            <aside
              id="hosts-group-panel"
              className="hosts-group-panel"
              aria-label="主机分组"
              aria-hidden={isHostGroupPanelCollapsed}
              inert={isHostGroupPanelCollapsed ? true : undefined}
            >
              <button type="button" className={`filter-tab all-hosts-filter ${!activeGroupKey && !searchQuery ? 'active' : ''}`} onClick={clearFilters}>
                <span>全部主机</span>
                <b>{hosts.length}</b>
              </button>

              <div className="section-heading group-panel-heading">
                <h2>分组</h2>
                <button type="button" className="group-add-button" onClick={openCreateHost} aria-label="新建主机">
                  +
                </button>
              </div>

              {!isVaultReady ? (
                <div className="empty-inline">正在读取主机分组...</div>
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
                <div className="empty-inline">添加主机后会自动生成分组。</div>
              )}
            </aside>

            <section className="vault-section host-section hosts-list-panel">
              <div className="section-heading host-list-heading">
                <div className="host-list-title">
                  <button
                    type="button"
                    className={`group-panel-toggle-button ${isHostGroupPanelCollapsed ? 'collapsed' : ''}`}
                    onClick={toggleHostGroupPanel}
                    aria-label={isHostGroupPanelCollapsed ? '显示主机分组' : '隐藏主机分组'}
                    aria-expanded={!isHostGroupPanelCollapsed}
                    aria-controls="hosts-group-panel"
                    title={isHostGroupPanelCollapsed ? '显示主机分组' : '隐藏主机分组'}
                  >
                    <span aria-hidden="true">{isHostGroupPanelCollapsed ? '☰' : '‹'}</span>
                  </button>
                  <h2>{activeGroupName || '全部主机'} <b>{filteredHosts.length}</b></h2>
                </div>
                <span>
                  共 {filteredHosts.length} 个主机
                  <button type="button" className="host-refresh-button" onClick={() => void refreshHosts()} aria-label="刷新主机列表">
                    <span aria-hidden="true">↻</span>
                  </button>
                </span>
              </div>

              {!isVaultReady ? (
                <div className="empty-state">
                  <span>LOADING</span>
                  <h3>正在读取主机列表</h3>
                  <p>正在从本地安全库载入已保存的 SSH 主机。</p>
                </div>
              ) : filteredHosts.length ? (
                <div className="host-grid grid">
                  {filteredHosts.map((host) => {
                    const connectionState = getHostConnectionStateView(host);
                    const isHostConnecting = connectingHostId === host.id;

                    return (
                      <article
                        key={host.id}
                        className={`host-card ${isHostConnecting ? 'connecting' : ''}`}
                        aria-busy={isHostConnecting}
                      >
                        <button
                          type="button"
                          className="host-card-main"
                          disabled={isConnectionPending}
                          onClick={() => {
                          if (host.authMethod === 'password' && !host.password) {
                            openCredentialDialog(host, '请输入该主机的 SSH 密码后连接。');
                            return;
                          }

                          void connectHost(host, undefined, 'host-card');
                        }}
                        >
                          <HostSystemIcon systemName={getHostSystemLabel(host)} systemType={host.systemType} />
                          <span className="host-summary">
                            <strong>{host.name}</strong>
                            <small>{host.username ? `${host.username}@` : ''}{host.address}:{host.port}</small>
                            <span className="host-card-tags">
                              {/* <em>SSH</em> */}
                              <em>{host.group || '未分组'}</em>
                              <em>{host.tags.length ? host.tags.join(' / ') : '无标签'}</em>
                            </span>
                          </span>
                        </button>
                        {isHostConnecting ? (
                          <div className="host-card-loading" role="status" aria-live="polite">
                            <span className="host-card-spinner" aria-hidden="true" />
                            <strong>正在连接</strong>
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
                          {(host.authMethod === 'password' && host.password) || host.authMethod === 'key' ? (
                            <span className="credential-icon" title={host.authMethod === 'key' ? '密钥登录' : '密码已保存'}>🔑</span>
                          ) : null}
                          <details className="host-card-menu" onClick={(event) => event.stopPropagation()}>
                            <summary aria-label="主机操作">⋯</summary>
                          <div className="host-card-menu-panel">
                            <button
                              type="button"
                              onClick={(event) => {
                                closeHostCardMenu(event.currentTarget);
                                startEditingHost(host);
                              }}
                            >
                              编辑
                            </button>
                            <button
                              type="button"
                              className="danger-text"
                              onClick={(event) => {
                                closeHostCardMenu(event.currentTarget);
                                deleteHost(host);
                              }}
                            >
                              删除
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
                  <h3>{hosts.length ? '没有匹配的主机' : '主机列表为空'}</h3>
                  <p>{hosts.length ? '清空搜索或切换分组后再试。' : '点击“新建主机”添加第一台 SSH 主机。'}</p>
                </div>
              )}
            </section>

          </section>
            </>
          ) : activePage === 'keys' ? (
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
          ) : activePage === 'logs' ? (
            <LogsPage logs={logs} onClearLogs={clearLogs} />
          ) : (
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
          )}

          {isEditorOpen && activePage === 'hosts' ? (
            <aside className="editor-panel no-drag" aria-label={editingHost ? '编辑主机' : '新建主机'}>
              <div className="editor-header">
                <span>
                  <strong>{editingHost ? '编辑主机' : '新建主机'}</strong>
                  <small>{editingHost ? editingHost.name : '保存到本地 Vault'}</small>
                </span>
                <button type="button" onClick={closeEditor} aria-label="关闭表单">×</button>
              </div>

              <form className="host-form" onSubmit={submitHost}>
                <label className="field">
                  <span>主机名称</span>
                  <input
                    value={form.name}
                    maxLength={80}
                    onChange={(event) => updateFormField('name', event.target.value)}
                    placeholder="例如：Production Web"
                  />
                </label>

                <label className="field">
                  <span>地址</span>
                  <input
                    value={form.address}
                    maxLength={255}
                    onChange={(event) => updateFormField('address', event.target.value)}
                    placeholder="192.168.100.21 或 github.com"
                  />
                </label>

                <div className="editor-grid">
                  <label className="field">
                    <span>用户名</span>
                    <input
                      value={form.username}
                      onChange={(event) => updateFormField('username', event.target.value)}
                      placeholder="root"
                    />
                  </label>

                  <label className="field">
                    <span>端口</span>
                    <input
                      value={form.port}
                      inputMode="numeric"
                      onChange={(event) => updateFormField('port', event.target.value)}
                      placeholder="22"
                    />
                  </label>
                </div>

                <div className="auth-method-section">
                  <span className="field-label">登录方式</span>
                  <div className="auth-switch" role="group" aria-label="登录方式">
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
                      <strong>密码登录</strong>
                      <small>保存密码到主机信息</small>
                    </button>
                    <button
                      type="button"
                      className={form.authMethod === 'key' ? 'active' : ''}
                      onClick={() => {
                        updateFormField('authMethod', 'key');
                        updateFormField('password', '');
                      }}
                    >
                      <strong>密钥登录</strong>
                      <small>选择密钥库中的已有密钥</small>
                    </button>
                  </div>
                </div>

                {form.authMethod === 'key' ? (
                  <label className="field">
                    <span>选择密钥</span>
                    <select
                      value={form.keyId}
                      onChange={(event) => updateFormField('keyId', event.target.value)}
                    >
                      <option value="">请选择已有密钥</option>
                      {sshKeys.map((key) => (
                        <option key={key.id} value={key.id}>{key.name} · {key.fingerprint || key.algorithm}</option>
                      ))}
                    </select>
                    {!sshKeys.length ? <small className="field-note">请先到“密钥”页面新建或导入密钥。</small> : null}
                  </label>
                ) : (
                  <label className="field">
                    <span>密码</span>
                    <input
                      type="password"
                      value={form.password}
                      onChange={(event) => updateFormField('password', event.target.value)}
                      placeholder="输入并保存该主机密码"
                    />
                  </label>
                )}

                <label className="field">
                  <span>分组</span>
                  <input
                    value={form.group}
                    onChange={(event) => updateFormField('group', event.target.value)}
                    placeholder="AWS / Production / Lab"
                  />
                </label>

                <label className="field">
                  <span>标签</span>
                  <input
                    value={form.tags}
                    onChange={(event) => updateFormField('tags', event.target.value)}
                    placeholder="linux, prod, db"
                  />
                </label>

                <label className="field">
                  <span>备注</span>
                  <textarea
                    value={form.note}
                    onChange={(event) => updateFormField('note', event.target.value)}
                    placeholder="用途、跳板机、维护窗口等"
                    rows={4}
                  />
                </label>

                {formError ? (
                  <DismissibleAlert className="error-banner" onDismiss={() => setFormError('')} role="alert">
                    {formError}
                  </DismissibleAlert>
                ) : null}

                <div className="form-actions">
                  <button type="submit" className="primary-action">{editingHost ? '保存修改' : '添加主机'}</button>
                  <button type="button" className="command-button" onClick={resetForm}>清空</button>
                </div>
              </form>
            </aside>
          ) : null}

          {isKeyEditorOpen && activePage === 'keys' ? (
            <aside className="editor-panel no-drag" aria-label={editingKey ? '编辑密钥' : '新建密钥'}>
              <div className="editor-header">
                <span>
                  <strong>{editingKey ? '编辑密钥' : keyEditorMode === 'generate' ? '新建 RSA 密钥' : '导入密钥对'}</strong>
                  <small>{editingKey ? editingKey.name : keyEditorMode === 'generate' ? '生成并保存到本地加密密钥库' : '读取现有密钥文件并复制到本地加密密钥库'}</small>
                </span>
                <button type="button" onClick={closeKeyEditor} aria-label="关闭密钥表单">×</button>
              </div>

              <form className="host-form" onSubmit={submitKey}>
                <label className="field">
                  <span>密钥名称</span>
                  <input
                    value={keyForm.name}
                    maxLength={80}
                    onChange={(event) => updateKeyFormField('name', event.target.value)}
                    placeholder="例如：Production Key"
                  />
                </label>

                {!editingKey && keyEditorMode === 'generate' ? (
                  <label className="field">
                    <span>RSA 位数</span>
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
                      <span>私钥文件</span>
                      <div className="file-picker-row">
                        <input value={keyForm.privateKeyPath} readOnly placeholder="请选择 SSH 私钥文件" />
                        <button type="button" className="command-button" onClick={selectPrivateKeyFileForKeyForm}>
                          选择文件
                        </button>
                      </div>
                    </label>

                    <label className="field">
                      <span>公钥文件（可选）</span>
                      <div className="file-picker-row">
                        <input value={keyForm.publicKeyPath} readOnly placeholder="可选，默认尝试使用同名 .pub 文件" />
                        <button type="button" className="command-button" onClick={selectPublicKeyFileForKeyForm}>
                          选择文件
                        </button>
                      </div>
                    </label>
                  </>
                ) : null}

                {editingKey ? (
                  <>
                    <label className="field">
                      <span>算法</span>
                      <input value={editingKey.algorithm || 'SSH'} readOnly />
                    </label>

                    <label className="field">
                      <span>指纹</span>
                      <input value={editingKey.fingerprint || '未生成'} readOnly />
                    </label>
                  </>
                ) : null}

                <label className="field">
                  <span>{editingKey ? '保存的解锁口令（可选）' : '密钥口令（可选）'}</span>
                  <input
                    type="password"
                    value={keyForm.passphrase}
                    onChange={(event) => updateKeyFormField('passphrase', event.target.value)}
                    placeholder={editingKey ? '更新保存的解锁口令，不会重写私钥文件' : '私钥加密时填写'}
                  />
                </label>

                {keyFormError ? (
                  <DismissibleAlert className="error-banner" onDismiss={() => setKeyFormError('')} role="alert">
                    {keyFormError}
                  </DismissibleAlert>
                ) : null}

                <div className="form-actions">
                  <button type="submit" className="primary-action">
                    {editingKey ? '保存修改' : keyEditorMode === 'generate' ? '生成并保存' : '导入并保存'}
                  </button>
                  <button type="button" className="command-button" onClick={resetKeyForm}>清空</button>
                </div>
              </form>
            </aside>
          ) : null}

          {credentialHost ? (
            <aside className="credential-panel no-drag" aria-label="连接凭据">
              <div className="editor-header">
                <span>
                  <strong>连接凭据</strong>
                  <small>{credentialHost.username}@{credentialHost.address}:{credentialHost.port}</small>
                </span>
                <button type="button" onClick={closeCredentialDialog} aria-label="关闭连接凭据">×</button>
              </div>

              <form className="host-form" onSubmit={submitCredentialConnection}>
                <div className="auth-method-section">
                  <span className="field-label">认证方式</span>
                  <div className="auth-switch" role="group" aria-label="认证方式">
                    <button
                      type="button"
                      className={credentialForm.authMethod === 'password' ? 'active' : ''}
                      onClick={() => updateCredentialAuthMethod('password')}
                    >
                      <strong>密码</strong>
                      <small>输入 SSH 登录密码</small>
                    </button>
                    <button
                      type="button"
                      className={credentialForm.authMethod === 'key' ? 'active' : ''}
                      onClick={() => updateCredentialAuthMethod('key')}
                      disabled={!credentialCanUseKeyAuth}
                    >
                      <strong>密钥</strong>
                      <small>使用密钥库中的私钥</small>
                    </button>
                  </div>
                </div>

                {credentialForm.authMethod === 'password' ? (
                  <label className="field">
                    <span>SSH 密码</span>
                    <input
                      type="password"
                      value={credentialForm.password}
                      onChange={(event) => updateCredentialField('password', event.target.value)}
                      placeholder="输入该主机的 SSH 密码"
                      autoFocus
                    />
                  </label>
                ) : (
                  <>
                    {sshKeys.length ? (
                      <label className="field">
                        <span>选择密钥</span>
                        <select
                          value={credentialForm.keyId}
                          onChange={(event) => updateCredentialKeyId(event.target.value)}
                          autoFocus
                        >
                          <option value="">请选择已有密钥</option>
                          {sshKeys.map((key) => (
                            <option key={key.id} value={key.id}>{key.name} · {key.fingerprint || key.algorithm}</option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    {credentialSelectedKey ? (
                      <div className="credential-note">
                        当前使用密钥登录：{credentialSelectedKey.name}
                      </div>
                    ) : credentialCanUseCurrentKeyFile ? (
                      <div className="credential-note">
                        当前使用私钥文件：{credentialHost.keyPath}
                      </div>
                    ) : (
                      <div className="credential-note">
                        请先到“密钥”页面新建或导入密钥。
                      </div>
                    )}
                    <label className="field">
                      <span>密钥口令（私钥加密时填写）</span>
                      <input
                        type="password"
                        value={credentialForm.passphrase}
                        onChange={(event) => updateCredentialField('passphrase', event.target.value)}
                        placeholder="没有口令可留空"
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
                    {isCredentialConnecting ? '连接中...' : '连接'}
                  </button>
                  <button type="button" className="command-button" onClick={closeCredentialDialog}>取消</button>
                </div>
              </form>
            </aside>
          ) : null}

          {deleteConfirmation ? (
            <div className="notepad-modal-overlay no-drag" role="presentation" onClick={() => setDeleteConfirmation(null)}>
              <div className="notepad-modal" role="alertdialog" aria-modal="true" aria-labelledby="delete-confirm-title" onClick={(event) => event.stopPropagation()}>
                <div id="delete-confirm-title" className="notepad-modal-title">确认删除</div>
                <div className="notepad-modal-message">
                  {deleteConfirmation.kind === 'ssh-key'
                    ? deleteConfirmation.relatedHostCount
                      ? `确认删除密钥「${deleteConfirmation.key.name}」？${deleteConfirmation.relatedHostCount} 台主机正在使用该密钥，删除后会切换为密码登录。`
                      : `确认删除密钥「${deleteConfirmation.key.name}」？`
                    : `确认删除主机「${deleteConfirmation.host.name}」？`}
                </div>
                <div className="notepad-modal-actions">
                  <button type="button" className="notepad-modal-btn" onClick={() => setDeleteConfirmation(null)}>取消</button>
                  <button type="button" className="notepad-modal-btn danger" onClick={confirmPendingDelete}>删除</button>
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
