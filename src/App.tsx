import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';

import RemoteDesktop from './RemoteDesktopShell';
import NavIcon, { type NavIconName } from './components/navigation/NavIcon';
import type { RemoteConnectionInfo } from './components/remote-desktop/types';
import KeysPage from './pages/KeysPage';
import LogsPage from './pages/LogsPage';
import SettingsPage from './pages/SettingsPage';

const hostsStorageKey = 'gui-ssh:hosts';
const keysStorageKey = 'gui-ssh:keys';
const bookmarkStorageKeyPrefix = 'gui-ssh:browser-bookmarks:';
const ungroupedKey = '__ungrouped__';
const defaultAppSettings: GuiSshAppSettings = {
  language: 'zh-CN',
  interfaceFont: 'Space Grotesk',
  theme: 'dark',
  accentColor: '#43c7ff',
  defaultHostView: 'grid',
  rememberPasswords: true,
  rememberKeyPassphrases: true,
  terminalFontSize: 13,
  terminalCursorStyle: 'block',
  terminalScrollback: 10000,
  terminalCopyOnSelect: true,
};

type AppPage = 'hosts' | 'keys' | 'logs' | 'settings';

const navigationItems: ReadonlyArray<{ page: Exclude<AppPage, 'settings'>; icon: NavIconName; label: string }> = [
  { page: 'hosts', icon: 'hosts', label: '主机' },
  { page: 'keys', icon: 'keys', label: '密钥' },
  { page: 'logs', icon: 'logs', label: '日志' },
];

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

interface LegacyStoredKey {
  id: string;
  name: string;
  keyPath: string;
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

function isLegacyStoredSshKey(value: unknown): value is LegacyStoredKey {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const key = value as Partial<LegacyStoredKey>;
  return (
    typeof key.id === 'string' &&
    typeof key.name === 'string' &&
    typeof key.keyPath === 'string' &&
    typeof key.passphrase === 'string' &&
    typeof key.createdAt === 'string' &&
    typeof key.updatedAt === 'string'
  );
}

function readStoredSshKeys(): LegacyStoredKey[] {
  try {
    const rawKeys = window.localStorage.getItem(keysStorageKey);

    if (!rawKeys) {
      return [];
    }

    const parsedKeys: unknown = JSON.parse(rawKeys);

    if (!Array.isArray(parsedKeys)) {
      return [];
    }

    return parsedKeys.filter(isLegacyStoredSshKey);
  } catch {
    return [];
  }
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
  group: string;
  tags: string[];
  note: string;
  createdAt: string;
  updatedAt: string;
}

type StoredHost = Omit<Host, 'authMethod' | 'password' | 'keyId' | 'keyPath' | 'passphrase'> &
  Partial<Pick<Host, 'authMethod' | 'password' | 'keyId' | 'keyPath' | 'passphrase'>>;

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

type ViewMode = 'grid' | 'list';
type AuthMethod = 'password' | 'key';

interface ConnectionClosedPayload {
  connectionId: string;
  reason?: string;
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
  password: string;
  passphrase: string;
  saveCredential: boolean;
}

const emptyHostForm: HostFormState = {
  name: '',
  address: '',
  port: '22',
  username: '',
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
  password: '',
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

function getAuthLabel(host: Pick<Host, 'authMethod' | 'password'>, key: SshKey | null) {
  if (host.authMethod === 'key') {
    if (!key) {
      return '密钥登录';
    }

    return key.passphrase ? `密钥 · ${key.name} · 口令已保存` : `密钥 · ${key.name}`;
  }

  return host.password ? '密码登录 · 已保存' : '密码登录';
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

function readLegacyBookmarkCollections(): GuiSshBrowserBookmarkCollection[] {
  try {
    return Object.keys(window.localStorage)
      .filter((key) => key.startsWith(bookmarkStorageKeyPrefix))
      .map((storageKey) => {
        const rawValue = window.localStorage.getItem(storageKey);

        if (!rawValue) {
          return null;
        }

        const parsedValue: unknown = JSON.parse(rawValue);

        if (!Array.isArray(parsedValue)) {
          return null;
        }

        const bookmarks = parsedValue.filter((bookmark): bookmark is GuiSshBrowserBookmark => {
          if (!bookmark || typeof bookmark !== 'object') {
            return false;
          }

          const value = bookmark as Partial<GuiSshBrowserBookmark>;
          return (
            typeof value.id === 'string' &&
            typeof value.title === 'string' &&
            typeof value.url === 'string' &&
            typeof value.createdAt === 'string' &&
            typeof value.updatedAt === 'string'
          );
        });

        return {
          scope: storageKey.slice(bookmarkStorageKeyPrefix.length),
          bookmarks,
          updatedAt: new Date().toISOString(),
        };
      })
      .filter((collection): collection is GuiSshBrowserBookmarkCollection => Boolean(collection));
  } catch {
    return [];
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
    group: form.group.trim(),
    tags: parseTags(form.tags),
    note: form.note.trim(),
    createdAt: now,
    updatedAt: now,
  };
}

function updateHostFromForm(host: Host, form: HostFormState, selectedKey: SshKey | null): Host {
  return {
    ...host,
    name: form.name.trim(),
    address: form.address.trim(),
    port: Number(form.port),
    username: form.username.trim(),
    authMethod: form.authMethod,
    password: form.authMethod === 'password' ? form.password : '',
    keyId: form.authMethod === 'key' ? selectedKey?.id ?? '' : '',
    keyPath: '',
    passphrase: '',
    group: form.group.trim(),
    tags: parseTags(form.tags),
    note: form.note.trim(),
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
  const [hosts, setHosts] = useState<Host[]>(readStoredHosts);
  const [sshKeys, setSshKeys] = useState<SshKey[]>([]);
  const [form, setForm] = useState<HostFormState>(emptyHostForm);
  const [keyForm, setKeyForm] = useState<KeyFormState>(emptyKeyForm);
  const [editingHostId, setEditingHostId] = useState<string | null>(null);
  const [editingKeyId, setEditingKeyId] = useState<string | null>(null);
  const [keyEditorMode, setKeyEditorMode] = useState<KeyEditorMode>('import');
  const [activePage, setActivePage] = useState<AppPage>('hosts');
  const [searchQuery, setSearchQuery] = useState('');
  const [keySearchQuery, setKeySearchQuery] = useState('');
  const [activeGroupKey, setActiveGroupKey] = useState<string | null>(null);
  const [formError, setFormError] = useState('');
  const [keyFormError, setKeyFormError] = useState('');
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [isKeyEditorOpen, setIsKeyEditorOpen] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>(defaultAppSettings.defaultHostView);
  const [settings, setSettings] = useState<GuiSshAppSettings>(defaultAppSettings);
  const [storageInfo, setStorageInfo] = useState<GuiSshStorageInfo | null>(null);
  const [bookmarkCount, setBookmarkCount] = useState(0);
  const [isVaultReady, setIsVaultReady] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [connection, setConnection] = useState<RemoteConnectionInfo | null>(null);
  const [windowConnectionId] = useState(readWindowConnectionId);
  const [windowConnectionError, setWindowConnectionError] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [credentialHost, setCredentialHost] = useState<Host | null>(null);
  const [credentialForm, setCredentialForm] = useState<CredentialFormState>(emptyCredentialForm);
  const [credentialError, setCredentialError] = useState('');
  const [isConfigTransferPending, setIsConfigTransferPending] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState<DeleteConfirmationRequest | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const lastPersistedCollectionsRef = useRef('');
  const platform = window.guiSSH?.platform;
  const windowControls = window.guiSSH?.window;
  const vaultControls = window.guiSSH?.vault;
  const showWindowControls = Boolean(windowControls) && platform !== 'darwin';
  const isConnectionWindow = Boolean(windowConnectionId);
  const titlebarConnectionAddress = connection
    ? `${connection.host.username}@${connection.host.address}:${connection.host.port}`
    : '';
  const editingHost = hosts.find((host) => host.id === editingHostId) ?? null;
  const editingKey = sshKeys.find((key) => key.id === editingKeyId) ?? null;

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

    return Array.from(groups.values()).sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
  }, [hosts]);

  const filteredHosts = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    return hosts.filter((host) => {
      const hostKey = sshKeys.find((key) => key.id === host.keyId) ?? null;
      const matchesGroup = !activeGroupKey || getHostGroupKey(host) === activeGroupKey;
      const matchesQuery =
        !query ||
        [host.name, host.address, host.username, host.group, host.note, hostKey?.name, hostKey?.fingerprint, hostKey?.algorithm, getAuthLabel(host, hostKey), ...host.tags]
          .join(' ')
          .toLowerCase()
          .includes(query);

      return matchesGroup && matchesQuery;
    });
  }, [activeGroupKey, hosts, searchQuery, sshKeys]);

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

  const getSelectedSshKey = (host: Host) => sshKeys.find((key) => key.id === host.keyId) ?? null;

  const applyVaultSnapshot = (snapshot: GuiSshVaultSnapshot, options: { updateCollections?: boolean } = {}) => {
    const { updateCollections = true } = options;

    if (updateCollections) {
      const nextHosts = snapshot.hosts.filter(isStoredHost).map(normalizeStoredHost);
      const nextKeys = snapshot.sshKeys.filter(isStoredSshKey);

      setHosts(nextHosts);
      setSshKeys(nextKeys);
      lastPersistedCollectionsRef.current = JSON.stringify({
        hosts: nextHosts,
        sshKeys: nextKeys,
        settings: snapshot.settings,
      });
    }

    setSettings(snapshot.settings);
    setStorageInfo(snapshot.storage);
    setBookmarkCount(snapshot.browserBookmarks.reduce((total: number, collection: GuiSshBrowserBookmarkCollection) => total + collection.bookmarks.length, 0));
    setViewMode(snapshot.settings.defaultHostView);
    setIsVaultReady(true);
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
      return;
    }

    let disposed = false;

    const loadSnapshot = async () => {
      try {
        const snapshot = !isConnectionWindow
          ? await vaultControls.migrateLegacyData({
              hosts: readStoredHosts(),
              sshKeys: readStoredSshKeys() as unknown as GuiSshStoredKeyRecord[],
              settings: defaultAppSettings,
              browserBookmarks: readLegacyBookmarkCollections(),
            })
          : await vaultControls.getSnapshot();

        if (!disposed) {
          applyVaultSnapshot(snapshot);
        }
      } catch (error) {
        if (!disposed) {
          setIsVaultReady(true);
          setStatusMessage(`读取本地数据失败：${getErrorMessage(error)}`);
        }
      }
    };

    void loadSnapshot();

    return () => {
      disposed = true;
    };
  }, [isConnectionWindow, vaultControls]);

  useEffect(() => {
    if (!vaultControls || !isVaultReady) {
      return;
    }

    const payload = { hosts, sshKeys, settings };
    const serializedPayload = JSON.stringify(payload);

    if (serializedPayload === lastPersistedCollectionsRef.current) {
      return;
    }

    let cancelled = false;

    void vaultControls.saveCollections(payload).then((snapshot) => {
      if (cancelled) {
        return;
      }

      lastPersistedCollectionsRef.current = serializedPayload;
      setStorageInfo(snapshot.storage);
      setBookmarkCount(snapshot.browserBookmarks.reduce((total: number, collection: GuiSshBrowserBookmarkCollection) => total + collection.bookmarks.length, 0));
    }).catch((error: unknown) => {
      if (!cancelled) {
        setStatusMessage(`保存本地数据失败：${getErrorMessage(error)}`);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [hosts, isVaultReady, settings, sshKeys, vaultControls]);

  useEffect(() => {
    if (!statusMessage) {
      return;
    }

    const timer = window.setTimeout(() => setStatusMessage(''), 1000);
    return () => window.clearTimeout(timer);
  }, [statusMessage]);

  useEffect(() => {
    const root = document.documentElement;
    const prefersLight = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches;
    const effectiveTheme = settings.theme === 'system' ? (prefersLight ? 'light' : 'dark') : settings.theme;
    const isLightTheme = effectiveTheme === 'light';

    root.style.setProperty('--accent', settings.accentColor);
    root.style.setProperty('--accent-strong', settings.accentColor);
    root.style.setProperty('--bg', isLightTheme ? '#eef3f8' : '#0b111a');
    root.style.setProperty('--chrome', isLightTheme ? '#f8fafc' : '#1b222b');
    root.style.setProperty('--sidebar', isLightTheme ? '#e4ebf3' : '#20262f');
    root.style.setProperty('--sidebar-active', isLightTheme ? '#d5e0ec' : '#3a3f49');
    root.style.setProperty('--surface', isLightTheme ? '#ffffff' : '#111820');
    root.style.setProperty('--surface-soft', isLightTheme ? '#f6f9fc' : '#161e28');
    root.style.setProperty('--surface-strong', isLightTheme ? '#e8eef5' : '#1a2330');
    root.style.setProperty('--surface-elevated', isLightTheme ? '#f5f8fc' : '#141b25');
    root.style.setProperty('--surface-input', isLightTheme ? '#ffffff' : '#1a212c');
    root.style.setProperty('--surface-control', isLightTheme ? '#e8eef5' : '#202733');
    root.style.setProperty('--surface-hover', isLightTheme ? '#eef5fc' : '#141d28');
    root.style.setProperty('--surface-icon', isLightTheme ? '#dceaf8' : '#12334a');
    root.style.setProperty('--surface-panel', isLightTheme ? '#f7fbff' : '#151d28');
    root.style.setProperty('--surface-empty', isLightTheme ? 'rgba(16, 32, 51, 0.02)' : 'rgba(255, 255, 255, 0.025)');
    root.style.setProperty('--surface-pill', isLightTheme ? '#dce5ef' : '#1d2632');
    root.style.setProperty('--surface-success-soft', isLightTheme ? 'rgba(34, 160, 90, 0.08)' : 'rgba(119, 244, 197, 0.08)');
    root.style.setProperty('--surface-success-border', isLightTheme ? 'rgba(34, 160, 90, 0.22)' : 'rgba(119, 244, 197, 0.22)');
    root.style.setProperty('--text-success', isLightTheme ? '#1a8a55' : '#d8fff1');
    root.style.setProperty('--toast-bg', isLightTheme ? 'rgba(247, 251, 255, 0.96)' : 'rgba(12, 23, 34, 0.92)');
    root.style.setProperty('--toast-text', isLightTheme ? '#1a6d94' : '#c6efff');
    root.style.setProperty('--text', isLightTheme ? '#18263a' : '#edf4ff');
    root.style.setProperty('--muted', isLightTheme ? '#627890' : '#8b9aad');
    root.style.setProperty('--muted-strong', isLightTheme ? '#415874' : '#bfcede');
    root.style.setProperty('--border', isLightTheme ? 'rgba(20, 42, 68, 0.1)' : 'rgba(139, 164, 195, 0.14)');
    root.style.setProperty('--border-strong', isLightTheme ? 'rgba(20, 42, 68, 0.18)' : 'rgba(139, 164, 195, 0.28)');
    root.style.setProperty('--window-border', isLightTheme ? 'rgba(20, 42, 68, 0.08)' : 'rgba(255, 255, 255, 0.04)');
    root.style.setProperty('--window-divider', isLightTheme ? 'rgba(20, 42, 68, 0.08)' : 'rgba(255, 255, 255, 0.05)');
    root.style.setProperty('--chrome-hover', isLightTheme ? 'rgba(20, 42, 68, 0.06)' : 'rgba(255, 255, 255, 0.08)');
    root.style.setProperty('--danger-hover-bg', isLightTheme ? 'rgba(200, 48, 78, 0.12)' : 'rgba(255, 111, 143, 0.18)');
    root.style.setProperty('--danger-hover-text', isLightTheme ? '#d63a5e' : '#ffd8e1');
    root.style.setProperty('--danger-soft', isLightTheme ? 'rgba(200, 48, 78, 0.08)' : 'rgba(255, 111, 143, 0.12)');
    root.style.setProperty('--danger-border', isLightTheme ? 'rgba(200, 48, 78, 0.32)' : 'rgba(255, 111, 143, 0.42)');
    root.style.setProperty('--danger-text-soft', isLightTheme ? '#c8304e' : '#ffd3dc');
    root.style.setProperty('--focus-border', isLightTheme ? 'rgba(45, 140, 200, 0.5)' : 'rgba(67, 199, 255, 0.46)');
    root.style.setProperty('--focus-ring', isLightTheme ? 'rgba(45, 140, 200, 0.1)' : 'rgba(67, 199, 255, 0.1)');
    root.style.setProperty('--accent-soft', isLightTheme ? 'rgba(45, 140, 200, 0.12)' : 'rgba(67, 199, 255, 0.14)');
    root.style.setProperty('--accent-border', isLightTheme ? 'rgba(45, 140, 200, 0.4)' : 'rgba(67, 199, 255, 0.42)');
    root.style.setProperty('--accent-strong-border', isLightTheme ? 'rgba(45, 140, 200, 0.5)' : 'rgba(67, 199, 255, 0.56)');
    root.style.setProperty('--shadow', isLightTheme ? 'rgba(43, 67, 92, 0.12)' : 'rgba(0, 0, 0, 0.34)');
    root.style.setProperty('--shadow-soft', isLightTheme ? '0 6px 18px rgba(43, 67, 92, 0.08)' : '0 12px 28px rgba(0, 0, 0, 0.16)');
    root.style.setProperty('--shadow-float', isLightTheme ? '0 12px 28px rgba(43, 67, 92, 0.16)' : '0 18px 36px rgba(0, 0, 0, 0.32)');
    root.style.setProperty('--shadow-panel', isLightTheme ? '0 16px 48px rgba(43, 67, 92, 0.16)' : '0 24px 70px rgba(0, 0, 0, 0.42)');
    root.style.setProperty('--shadow-panel-strong', isLightTheme ? '0 16px 48px rgba(43, 67, 92, 0.18)' : '0 24px 70px rgba(0, 0, 0, 0.46)');
    root.style.setProperty('--toggle-off', isLightTheme ? '#cdd6e0' : '#202938');
    root.style.colorScheme = isLightTheme ? 'light' : 'dark';
    root.setAttribute('data-theme', effectiveTheme);
    document.body.style.fontFamily = `"${settings.interfaceFont}", "Segoe UI Variable", "Segoe UI", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif`;
  }, [settings]);

  useEffect(() => {
    if (!connection || !window.guiSSH?.events) {
      return;
    }

    return window.guiSSH.events.onConnectionClosed((payload: ConnectionClosedPayload) => {
      if (payload.connectionId === connection.id) {
        const message = payload.reason || 'SSH 连接已断开。';
        addLog('connection', 'warning', `连接断开：${connection.host.address}`, message);
        setConnection(null);
        setStatusMessage(message);
        setWindowConnectionError(message);

        if (isConnectionWindow) {
          void windowControls?.close();
        }
      }
    });
  }, [connection, isConnectionWindow, windowControls]);

  useEffect(() => {
    if (!window.guiSSH?.events.onVaultChanged || !vaultControls) {
      return;
    }

    return window.guiSSH.events.onVaultChanged((payload) => {
      if (payload.kind !== 'bookmarks' && !isConnectionWindow) {
        return;
      }

      void vaultControls.getSnapshot().then((snapshot) => {
        applyVaultSnapshot(snapshot, { updateCollections: isConnectionWindow });
      }).catch(() => undefined);
    });
  }, [isConnectionWindow, vaultControls]);

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
    void windowControls?.toggleMaximize();
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

  const openCredentialDialog = (host: Host, message = '') => {
    const selectedKey = host.authMethod === 'key' ? getSelectedSshKey(host) : null;

    setCredentialHost(host);
    setCredentialForm({
      password: host.password,
      passphrase: selectedKey?.passphrase ?? host.passphrase,
      saveCredential: host.authMethod === 'password' ? settings.rememberPasswords : settings.rememberKeyPassphrases,
    });
    setCredentialError(message);
  };

  const closeCredentialDialog = () => {
    setCredentialHost(null);
    setCredentialForm(emptyCredentialForm);
    setCredentialError('');
  };

  const submitHost = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const selectedKey = sshKeys.find((key) => key.id === form.keyId) ?? null;
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

  const connectHost = async (host: Host, credentials?: CredentialFormState) => {
    if (!window.guiSSH?.connections) {
      setStatusMessage('当前运行环境不支持 SSH 连接。');
      return false;
    }

    const selectedKey = host.authMethod === 'key' ? getSelectedSshKey(host) : null;

    if (host.authMethod === 'key' && !selectedKey && !host.keyId && !host.keyPath) {
      setStatusMessage('该主机未选择有效密钥。');
      return false;
    }

    const hostForConnection: Host = credentials
      ? {
          ...host,
          password: host.authMethod === 'password' ? credentials.password : host.password,
          keyPath: host.authMethod === 'key' ? host.keyPath : '',
          passphrase: host.authMethod === 'key' ? credentials.passphrase : host.passphrase,
        }
      : {
          ...host,
          keyPath: host.authMethod === 'key' ? host.keyPath : '',
          passphrase: host.authMethod === 'key' ? selectedKey?.passphrase ?? host.passphrase : '',
        };

    setIsConnecting(true);
    setStatusMessage(`正在连接 ${host.name}...`);

    try {
      const nextConnection = await window.guiSSH.connections.connect(hostForConnection);

      if (credentials?.saveCredential) {
        setHosts((currentHosts) =>
          currentHosts.map((currentHost) =>
            currentHost.id === host.id
              ? {
                  ...currentHost,
                  password: host.authMethod === 'password' ? credentials.password : currentHost.password,
                  updatedAt: new Date().toISOString(),
                }
              : currentHost,
          ),
        );

        if (host.authMethod === 'key' && selectedKey) {
          setSshKeys((currentKeys) => currentKeys.map((key) => (
            key.id === selectedKey.id
              ? { ...key, passphrase: credentials.passphrase, updatedAt: new Date().toISOString() }
              : key
          )));
        }
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
      return true;
    } catch (error) {
      const message = getErrorMessage(error);
      addLog('connection', 'error', `连接失败：${host.name}`, `${host.username}@${host.address}:${host.port} — ${message}`);
      setStatusMessage(`连接失败：${message}`);

      if (isAuthFailureMessage(message)) {
        openCredentialDialog(hostForConnection, message);
      }

      return false;
    } finally {
      setIsConnecting(false);
    }
  };

  const connectCommandBarInput = async () => {
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
      await connectHost(matchedHost);
      return;
    }

    const now = new Date().toISOString();
    const quickConnectHost: Host = {
      id: `quick-connect:${parsedCommand.username}@${parsedCommand.address}:${parsedCommand.port}`,
      name: `${parsedCommand.username}@${parsedCommand.address}`,
      address: parsedCommand.address,
      port: parsedCommand.port,
      username: parsedCommand.username,
      authMethod: parsedCommand.keyPath ? 'key' : 'password',
      password: '',
      keyId: '',
      keyPath: parsedCommand.keyPath,
      passphrase: '',
      group: '',
      tags: [],
      note: '',
      createdAt: now,
      updatedAt: now,
    };

    if (quickConnectHost.authMethod === 'password') {
      openCredentialDialog(quickConnectHost, '请输入该连接的 SSH 密码后继续。');
      return;
    }

    await connectHost(quickConnectHost);
  };

  const submitCredentialConnection = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!credentialHost) {
      return;
    }

    if (credentialHost.authMethod === 'password' && !credentialForm.password) {
      setCredentialError('请输入 SSH 密码。');
      return;
    }

    await connectHost(credentialHost, credentialForm);
  };

  const clearFilters = () => {
    setActiveGroupKey(null);
    setSearchQuery('');
  };

  const changeViewMode = (nextViewMode: ViewMode) => {
    setViewMode(nextViewMode);
    setSettings((currentSettings: GuiSshAppSettings) => (
      currentSettings.defaultHostView === nextViewMode
        ? currentSettings
        : { ...currentSettings, defaultHostView: nextViewMode }
    ));
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

  return (
    <div className="app-shell">
      <header className="top-chrome drag-region">
        <div className="workspace-title">
          {connection ? (
            <>
              <strong>GUI-SSH Desktop</strong>
              <span>{titlebarConnectionAddress}</span>
              <span>SOCKS :{connection.proxyPort}</span>
            </>
          ) : (
            'GUI-SSH'
          )}
        </div>

        {showWindowControls ? (
          <div className="titlebar-controls no-drag">
            <button type="button" aria-label="最小化" onClick={minimizeWindow}>−</button>
            <button type="button" aria-label="最大化" onClick={toggleMaximizeWindow}>□</button>
            <button type="button" aria-label="关闭" className="danger" onClick={closeWindow}>×</button>
          </div>
        ) : null}
      </header>

      {statusMessage ? <div className="status-toast no-drag" role="status">{statusMessage}</div> : null}

      {connection ? (
        <RemoteDesktop connection={connection} settings={settings} />
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
          <div className="brand-panel">
            <span className="brand-logo">GS</span>
            <strong>GUI-SSH</strong>
          </div>

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
              <span>查找</span>
              <input
                type="search"
                placeholder="查找主机或 ssh user@hostname / ssh -p 2222 user@host"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void connectCommandBarInput();
                  }
                }}
              />
            </label>

            <button type="button" className="command-button" onClick={connectCommandBarInput} disabled={isConnecting}>
              {isConnecting ? '连接中...' : '连接'}
            </button>

            <div className="view-switch" aria-label="视图切换">
              <button type="button" className={viewMode === 'grid' ? 'active' : ''} onClick={() => changeViewMode('grid')}>网格</button>
              <button type="button" className={viewMode === 'list' ? 'active' : ''} onClick={() => changeViewMode('list')}>列表</button>
            </div>

            <button type="button" className="primary-action" onClick={openCreateHost}>+ 新建主机</button>
          </div>

          <section className="vault-content">
            <div className="content-filter-row">
              <button type="button" className={`filter-tab ${!activeGroupKey && !searchQuery ? 'active' : ''}`} onClick={clearFilters}>
                全部主机
              </button>
              <span>{activeGroupName ? `当前分组：${activeGroupName}` : `${hosts.length} 台主机`}</span>
            </div>
            <section className="vault-section">
              <div className="section-heading">
                <h2>分组</h2>
                <span>共 {hostGroups.length} 个</span>
              </div>

              {hostGroups.length ? (
                <div className="group-grid">
                  {hostGroups.map((group) => (
                    <button
                      key={group.key}
                      type="button"
                      className={`group-card ${activeGroupKey === group.key ? 'active' : ''}`}
                      onClick={() => setActiveGroupKey(group.key)}
                    >
                      <span className="group-icon">G</span>
                      <span>
                        <strong>{group.name}</strong>
                        <small>{group.count} 台主机</small>
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="empty-inline">添加主机后会自动生成分组。</div>
              )}
            </section>

            <section className="vault-section host-section">
              <div className="section-heading">
                <h2>主机</h2>
                <span>{filteredHosts.length} 条 <b>0 个在线</b></span>
              </div>

              {filteredHosts.length ? (
                <div className={`host-grid ${viewMode}`}>
                  {filteredHosts.map((host) => (
                    <article
                      key={host.id}
                      className="host-card"
                      onDoubleClick={() => {
                        if (host.authMethod === 'password' && !host.password) {
                          openCredentialDialog(host, '请输入该主机的 SSH 密码后连接。');
                          return;
                        }

                        void connectHost(host);
                      }}
                    >
                      <button type="button" className="host-card-main">
                        <span className="host-avatar">S</span>
                        <span className="host-summary">
                          <strong>{host.name}</strong>
                          <small>{host.username ? `${host.username}@` : ''}{host.address}:{host.port}</small>
                          <span>{host.group || '未分组'} · {host.tags.length ? host.tags.join(' / ') : '无标签'}</span>
                        </span>
                      </button>
                      <span className="host-card-actions">
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
                  ))}
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
              onSettingsChange={(nextSettings) => setSettings(nextSettings)}
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

                {formError ? <div className="error-banner">{formError}</div> : null}

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

                {keyFormError ? <div className="error-banner">{keyFormError}</div> : null}

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
                {credentialHost.authMethod === 'password' ? (
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
                    <div className="credential-note">
                      当前使用密钥登录：{getSelectedSshKey(credentialHost)?.name ?? '未命名密钥'}
                    </div>
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

                <label className="check-field">
                  <input
                    type="checkbox"
                    checked={credentialForm.saveCredential}
                    onChange={(event) => updateCredentialField('saveCredential', event.target.checked)}
                  />
                  <span>连接成功后保存到此主机配置</span>
                </label>

                {credentialError ? <div className="error-banner">{credentialError}</div> : null}

                <div className="form-actions">
                  <button type="submit" className="primary-action" disabled={isConnecting}>
                    {isConnecting ? '连接中...' : '连接'}
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
