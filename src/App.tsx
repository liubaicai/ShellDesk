import { Fragment, type FormEvent, lazy, type PointerEvent as ReactPointerEvent, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  ChevronDown,
  Folder,
  LayoutGrid,
  LayoutList,
  Monitor,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightOpen,
  Plus,
  RefreshCw,
  Search,
  Server,
  Terminal,
} from 'lucide-react';

import appIconUrl from './assets/images/icon.png';
import DismissibleAlert from './components/DismissibleAlert';
import HostListPanel from './components/HostListPanel';
import HostImportWizard from './components/HostImportWizard';
import HostImportMenuActions from './components/HostImportMenuActions';
import HostMetadataFields, { useHostMetadataOptions } from './components/HostMetadataFields';
import GlobalTransferCenter from './components/transfers/GlobalTransferCenter';
import {
  type AuthMethod,
  compareHostsByHostListSortMode,
  type ConnectionClosedPayload,
  type ConnectionErrorNotice,
  type ConnectionHost,
  type ConnectionLaunchSource,
  type ConnectionLaunchTarget,
  type ConnectionReconnectingPayload,
  type ConnectionRestoredPayload,
  createHostFromForm,
  createHostInfoSnapshot,
  createId,
  type CredentialFormState,
  defaultKeepaliveIntervalSeconds,
  type DeleteConfirmationRequest,
  emptyCredentialForm,
  emptyHostForm,
  emptyKeyForm,
  formatHostInfoTime,
  formatRelativeTime,
  formatUpdateReadyVersion,
  getAuthLabel,
  getErrorMessage,
  getHostChipClassName,
  getHostConnectionStateView,
  getHostCpuCoreValue,
  getHostDetailValue,
  getHostDiskTotalValue,
  getHostGroupKey,
  getHostMemoryTotalValue,
  getHostSystemLabel,
  getHostSystemType,
  getKeyNameFromPath,
  getLogHostMeta,
  getProxyConfigEndpoint,
  getProxyConfigTypeLabel,
  getUpdateReadyVersionKey,
  type Host,
  type HostConnectionStatus,
  type HostFormState,
  type HostGroup,
  type HostListSortMode,
  hostListSortModeLabelIds,
  hostListSortModes,
  type HostPageSize,
  hostPageSizeOptions,
  type HostStatusFilter,
  hostSystemLabels,
  type HostSystemType,
  type HostViewMode,
  isAuthFailureMessage,
  isHostPageSize,
  isRootLoginUsername,
  isStoredHost,
  isStoredSshKey,
  type KeyEditorMode,
  type KeyFormState,
  type LogCategory,
  type LogEntry,
  type LogHostMeta,
  type LogLevel,
  normalizeStoredHosts,
  protectHostInfoFromStaleSnapshot,
  readDismissedUpdateReadyVersion,
  readHostListSortMode,
  readHostPageSize,
  readSideNavCollapsed,
  readStoredHosts,
  readStoredTerminalSnippets,
  sanitizeHostJumpHostReferences,
  type SettingsUpdate,
  sortHostsByListOrder,
  type SshKey,
  storeDismissedUpdateReadyVersion,
  storeHostListSortMode,
  storeHostPageSize,
  storeSideNavCollapsed,
  storeTerminalSnippets,
  toFormState,
  toKeyFormState,
  updateHostFromForm,
  updateSshKeyFromForm,
  validateHostForm,
  validateKeyForm,
  type VaultCollectionsSavePayload,
} from './appHostModel';
import { useHostImportWorkflow } from './features/hosts/useHostImportWorkflow';
import { HostSystemIcon, ShellDeskNavIcon } from './components/AppNavigationIcons';
import type { NavIconName } from './components/navigation/NavIcon';
import type { RemoteConnectionInfo } from './components/remote-desktop/types';
import {
  createLatestRequestGate,
  createLatestWinsSingleFlightQueue,
  isCollectionsSnapshotCurrent,
  type LatestWinsSingleFlightQueue,
} from './features/vault/latestSaveQueue';
import { getAppLocale, getCurrentAppLanguage, loadFullMessageCatalog, preloadFullMessageCatalog, t, useShellDeskI18n, type AppLanguage } from './i18n';
import { useRuntimeAppearance } from './theme/useRuntimeAppearance';
import { createInitialAppSettings, defaultAppSettings, fetchBackendDefaults } from './appDefaultSettings';
import { shouldPreserveCurrentRemoteDesktopLayout } from './remoteDesktopLayout';
import {
  persistRemoteDesktopLayoutShadow,
  protectSettingsFromStaleSnapshot,
  readPersistedRemoteDesktopLayoutShadow,
  readRemoteDesktopLayoutShadow,
  remoteDesktopLayoutShadowPreferenceKey,
  storeRemoteDesktopLayoutShadow,
} from './appSettingsSnapshot';

export type { LogCategory, LogEntry, LogLevel } from './appHostModel';

const RemoteDesktop = lazy(() =>
  Promise.all([loadFullMessageCatalog(), import('./RemoteDesktopShell')]).then(([, module]) => module));
const KeysPage = lazy(() =>
  Promise.all([loadFullMessageCatalog(), import('./pages/KeysPage')]).then(([, module]) => module));
const SnippetsPage = lazy(() =>
  Promise.all([loadFullMessageCatalog(), import('./pages/SnippetsPage')]).then(([, module]) => module));
const ProxyProfilesPage = lazy(() =>
  Promise.all([loadFullMessageCatalog(), import('./pages/ProxyProfilesPage')]).then(([, module]) => module));
const KnownHostsPage = lazy(() =>
  Promise.all([loadFullMessageCatalog(), import('./pages/KnownHostsPage')]).then(([, module]) => module));
const LogsPage = lazy(() =>
  Promise.all([loadFullMessageCatalog(), import('./pages/LogsPage')]).then(([, module]) => module));
const SettingsPage = lazy(() =>
  Promise.all([loadFullMessageCatalog(), import('./pages/SettingsPage')]).then(([, module]) => module));
const AgentWorkspace = lazy(() =>
  Promise.all([loadFullMessageCatalog(), import('./pages/AgentWorkspace')]).then(([, module]) => module));
const SftpTransferWindow = lazy(() => import('./components/sftp-transfer/SftpTransferWindow'));

const maxRenderedLogEntries = 5_000;
type AppPage = 'hosts' | 'keys' | 'snippets' | 'proxies' | 'known-hosts' | 'logs' | 'settings';
type SyncNotice = Pick<
  ShellDeskSyncResult,
  | 'conflictCount'
  | 'conflicts'
  | 'config'
  | 'emptyVaultSummary'
  | 'shrinkSummary'
  | 'resolution'
> & {
  kind: 'conflict' | 'empty-vault' | 'shrink';
};
type UpdateReadyNotice = Pick<ShellDeskUpdateStatus, 'version' | 'releaseDate' | 'releaseNotes'>;
type ShellDeskNavIconName = NavIconName;
type VaultCollectionsSaveRequest = {
  payload: VaultCollectionsSavePayload;
  serialized: string;
};

type NavigationItem = {
  key: 'hosts' | 'snippets' | 'known-hosts' | 'keys' | 'proxies' | 'logs';
  page: Extract<AppPage, 'hosts' | 'snippets' | 'known-hosts' | 'keys' | 'proxies' | 'logs'>;
  icon: ShellDeskNavIconName;
  label: Record<AppLanguage, string>;
};

const navigationItems: ReadonlyArray<NavigationItem> = [
  { key: 'hosts', page: 'hosts', icon: 'hosts', label: { 'zh-CN': '主机', 'en-US': 'Hosts' } },
  { key: 'snippets', page: 'snippets', icon: 'snippets', label: { 'zh-CN': '代码片段', 'en-US': 'Snippets' } },
  { key: 'keys', page: 'keys', icon: 'keys', label: { 'zh-CN': '密钥对', 'en-US': 'Key pairs' } },
  { key: 'known-hosts', page: 'known-hosts', icon: 'known-hosts', label: { 'zh-CN': '已知主机', 'en-US': 'Known hosts' } },
  { key: 'proxies', page: 'proxies', icon: 'proxies', label: { 'zh-CN': '代理', 'en-US': 'Proxies' } },
  { key: 'logs', page: 'logs', icon: 'logs', label: { 'zh-CN': '日志', 'en-US': 'Logs' } },
];

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

function readWindowConnectionId() {
  return new URLSearchParams(window.location.search).get('connectionId')?.trim() ?? '';
}

function isAgentWorkspaceWindow() {
  return new URLSearchParams(window.location.search).get('agentWorkspace') === '1';
}

function isSftpTransferWorkspaceWindow() {
  return new URLSearchParams(window.location.search).get('sftpTransfer') === '1';
}

function readDesktopAppRequest(): ShellDeskDesktopAppKey | undefined {
  const value = new URLSearchParams(window.location.search).get('desktopApp')?.trim();
  return value ? value as ShellDeskDesktopAppKey : undefined;
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
  const isAgentWorkspace = isAgentWorkspaceWindow();
  const isSftpTransferWorkspace = isSftpTransferWorkspaceWindow();
  const desktopAppRequest = readDesktopAppRequest();
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
  const [proxyProfiles, setProxyProfiles] = useState<ShellDeskProxyProfile[]>(() => (
    initialPublicSnapshot ? initialPublicSnapshot.proxyProfiles : []
  ));
  const [knownHosts, setKnownHosts] = useState<ShellDeskKnownHost[]>(() => (
    initialPublicSnapshot ? initialPublicSnapshot.knownHosts : []
  ));
  const [form, setForm] = useState<HostFormState>(emptyHostForm);
  const [keyForm, setKeyForm] = useState<KeyFormState>(emptyKeyForm);
  const [editingHostId, setEditingHostId] = useState<string | null>(null);
  const [editingKeyId, setEditingKeyId] = useState<string | null>(null);
  const [keyEditorMode, setKeyEditorMode] = useState<KeyEditorMode>('import');
  const [activePage, setActivePage] = useState<AppPage>('hosts');
  const [searchQuery, setSearchQuery] = useState('');
  const [quickConnectInput, setQuickConnectInput] = useState('');
  const [keySearchQuery, setKeySearchQuery] = useState('');
  const [activeGroupKey, setActiveGroupKey] = useState<string | null>(null);
  const [hostStatusFilter, setHostStatusFilter] = useState<HostStatusFilter>('all');
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  const [hostListSortMode, setHostListSortMode] = useState<HostListSortMode>(readHostListSortMode);
  const [hostPageSize, setHostPageSize] = useState<HostPageSize>(readHostPageSize);
  const [hostPage, setHostPage] = useState(1);
  const [isSideNavCollapsed, setIsSideNavCollapsed] = useState(readSideNavCollapsed);
  const [formError, setFormError] = useState('');
  const [keyFormError, setKeyFormError] = useState('');
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [isKeyEditorOpen, setIsKeyEditorOpen] = useState(false);
  const [settings, setSettings] = useState<ShellDeskAppSettings>(() => {
    if (initialPublicSnapshot) {
      const layoutShadow = readRemoteDesktopLayoutShadow();

      if (layoutShadow && shouldPreserveCurrentRemoteDesktopLayout(layoutShadow, initialPublicSnapshot.settings.remoteDesktopLayout)) {
        return {
          ...initialPublicSnapshot.settings,
          remoteDesktopLayout: layoutShadow,
        };
      }

      return initialPublicSnapshot.settings;
    }

    const initialSettings = createInitialAppSettings();

    if (window.guiSSH?.vault) {
      return initialSettings;
    }

    return {
      ...initialSettings,
      terminalSnippets: readStoredTerminalSnippets(defaultAppSettings.terminalSnippets),
    };
  });
  useRuntimeAppearance({
    theme: settings.theme,
    accentColor: settings.accentColor,
    interfaceFont: settings.interfaceFont,
  });
  const [storageInfo, setStorageInfo] = useState<ShellDeskStorageInfo | null>(initialPublicSnapshot?.storage ?? null);
  const [bookmarkCount, setBookmarkCount] = useState(() => (
    initialPublicSnapshot?.browserBookmarks.reduce((total, collection) => total + collection.bookmarks.length, 0) ?? 0
  ));
  const [isVaultReady, setIsVaultReady] = useState(Boolean(initialPublicSnapshot) || !window.guiSSH?.vault);
  const [isVaultHydrated, setIsVaultHydrated] = useState(!window.guiSSH?.vault);
  const [statusMessage, setStatusMessage] = useState('');
  const [connection, setConnection] = useState<RemoteConnectionInfo | null>(null);
  const [windowConnectionId] = useState(readWindowConnectionId);
  const [isWindowMaximized, setIsWindowMaximized] = useState(false);
  const titlebarPointerGestureRef = useRef<{ pointerId: number; originX: number; originY: number } | null>(null);
  const [windowConnectionError, setWindowConnectionError] = useState('');
  const [connectingHostId, setConnectingHostId] = useState<string | null>(null);
  const [isQuickConnecting, setIsQuickConnecting] = useState(false);
  const [isCredentialConnecting, setIsCredentialConnecting] = useState(false);
  const [isLocalOpening, setIsLocalOpening] = useState(false);
  const [connectionErrorNotice, setConnectionErrorNotice] = useState<ConnectionErrorNotice | null>(null);
  const [isCloseToTrayPromptOpen, setIsCloseToTrayPromptOpen] = useState(false);
  const [isCloseToTrayPromptPending, setIsCloseToTrayPromptPending] = useState(false);
  const [keyboardInteractiveRequest, setKeyboardInteractiveRequest] = useState<ShellDeskKeyboardInteractiveRequest | null>(null);
  const [keyboardInteractiveResponses, setKeyboardInteractiveResponses] = useState<string[]>([]);
  const [isKeyboardInteractivePending, setIsKeyboardInteractivePending] = useState(false);
  const [hostKeyVerificationRequest, setHostKeyVerificationRequest] = useState<ShellDeskHostKeyVerificationRequest | null>(null);
  const [isHostKeyVerificationPending, setIsHostKeyVerificationPending] = useState(false);
  const [syncConflictCount, setSyncConflictCount] = useState(0);
  const [syncConflictNotice, setSyncConflictNotice] = useState<SyncNotice | null>(null);
  const [syncResolutionPending, setSyncResolutionPending] = useState<ShellDeskSyncConflictResolution | ShellDeskSyncEmptyVaultResolution | 'allowShrink' | ''>('');
  const [syncResolutionError, setSyncResolutionError] = useState('');
  const [updateReadyNotice, setUpdateReadyNotice] = useState<UpdateReadyNotice | null>(null);
  const [updateInstallPending, setUpdateInstallPending] = useState(false);
  const [updateInstallError, setUpdateInstallError] = useState('');
  const [appInfo, setAppInfo] = useState<ShellDeskAppInfo | null>(null);
  const [settingsUpdateCheckRequestId, setSettingsUpdateCheckRequestId] = useState(0);
  const [settingsSectionRequest, setSettingsSectionRequest] = useState<{ section: 'ai'; id: number } | null>(null);
  const [credentialHost, setCredentialHost] = useState<ConnectionHost | null>(null);
  const [credentialLaunchTarget, setCredentialLaunchTarget] = useState<ConnectionLaunchTarget>('desktop');
  const [credentialForm, setCredentialForm] = useState<CredentialFormState>(emptyCredentialForm);
  const [credentialError, setCredentialError] = useState('');
  const [isConfigTransferPending, setIsConfigTransferPending] = useState(false);
  const [hostInfoDialogHostId, setHostInfoDialogHostId] = useState<string | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState<DeleteConfirmationRequest | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const hostsRef = useRef(hosts);
  const sshKeysRef = useRef(sshKeys);
  const proxyProfilesRef = useRef(proxyProfiles);
  const knownHostsRef = useRef(knownHosts);
  const settingsRef = useRef(settings);
  const lastPersistedCollectionsRef = useRef('');
  const collectionsRevisionRef = useRef(0);
  const collectionsSnapshotRequestGate = useMemo(createLatestRequestGate, []);
  const platform = window.guiSSH?.platform;
  const windowControls = window.guiSSH?.window;
  const vaultControls = window.guiSSH?.vault;
  const vaultControlsRef = useRef(vaultControls);
  // This queue owns broad collections payloads; knownHosts-only writes remain independent.
  const collectionsSaveQueueRef = useRef<LatestWinsSingleFlightQueue<VaultCollectionsSaveRequest> | null>(null);
  if (!collectionsSaveQueueRef.current) {
    collectionsSaveQueueRef.current = createLatestWinsSingleFlightQueue({
      getKey: (request) => request.serialized,
      save: async (request) => {
        const currentVaultControls = vaultControlsRef.current;
        if (!currentVaultControls) {
          throw new Error('Vault controls are unavailable.');
        }

        const snapshot = await currentVaultControls.saveCollections(request.payload);
        lastPersistedCollectionsRef.current = request.serialized;
        setStorageInfo(snapshot.storage);
        setBookmarkCount(snapshot.browserBookmarks.reduce(
          (total: number, collection: ShellDeskBrowserBookmarkCollection) => total + collection.bookmarks.length,
          0,
        ));
      },
      onError: (error) => {
        const currentLanguage = getCurrentAppLanguage();
        setStatusMessage(t('app.status.saveLocalFailed', currentLanguage, {
          error: getErrorMessage(error, currentLanguage),
        }));
      },
    });
  }
  const collectionsSaveQueue = collectionsSaveQueueRef.current;
  const beginCollectionsSnapshotRequest = useCallback(() => ({
    requestId: collectionsSnapshotRequestGate.begin(),
    revision: collectionsRevisionRef.current,
  }), [collectionsSnapshotRequestGate]);
  const isCurrentCollectionsSnapshotRequest = useCallback((
    request: { requestId: number; revision: number },
  ) => (
    collectionsSnapshotRequestGate.isCurrent(request.requestId)
    && isCollectionsSnapshotCurrent(
      request.revision,
      collectionsRevisionRef.current,
      collectionsSaveQueue.hasWork(),
    )
  ), [collectionsSaveQueue, collectionsSnapshotRequestGate]);
  const appLanguage = settings.language;
  const appLocale = getAppLocale(appLanguage);
  const hostViewMode: HostViewMode = settings.defaultHostView === 'grid' ? 'grid' : 'list';
  const isMacOS = platform === 'darwin';
  const showWindowControls = Boolean(windowControls) && !isMacOS;
  const isConnectionWindow = Boolean(windowConnectionId);
  const isLocalDesktopConnection = connection?.kind === 'local';
  const titlebarConnectionAddress = connection
    ? isLocalDesktopConnection
      ? `${connection.host.username}@${connection.host.address}`
      : `${connection.host.username}@${connection.host.address}:${connection.host.port}`
    : '';
  const isConnectionPending = Boolean(connectingHostId) || isQuickConnecting || isCredentialConnecting || isLocalOpening;
  const editingHost = hosts.find((host) => host.id === editingHostId) ?? null;
  const editingKey = sshKeys.find((key) => key.id === editingKeyId) ?? null;
  const sshKeyById = useMemo(() => new Map(sshKeys.map((key) => [key.id, key])), [sshKeys]);
  const hostById = useMemo(() => new Map(hosts.map((host) => [host.id, host])), [hosts]);
  const proxyProfileById = useMemo(() => new Map(proxyProfiles.map((profile) => [profile.id, profile])), [proxyProfiles]);
  const jumpHostOptions = useMemo(
    () => hosts.filter((host) => host.id !== editingHostId && host.canBeJumpHost && !host.jumpHostId),
    [editingHostId, hosts],
  );
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
  const { hostGroupOptions, hostTagOptions } = useHostMetadataOptions(hostGroups, hosts, appLocale);

  const hostStatusCounts = useMemo(() => {
    const counts = { all: hosts.length, ready: 0, failed: 0, never: 0 };

    for (const host of hosts) {
      if (host.lastConnectionStatus === 'failed') {
        counts.failed += 1;
      } else if (host.lastConnectionStatus === 'success') {
        counts.ready += 1;
      } else {
        counts.never += 1;
      }
    }

    return counts;
  }, [hosts]);

  const latestConnectedHost = useMemo(() => {
    let latest: Host | null = null;

    for (const host of hosts) {
      if (!host.lastConnectionAt) {
        continue;
      }

      if (!latest || host.lastConnectionAt > latest.lastConnectionAt) {
        latest = host;
      }
    }

    return latest;
  }, [hosts]);

  const filteredHosts = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    return hosts.filter((host) => {
      const matchesStatus =
        hostStatusFilter === 'all' ||
        (hostStatusFilter === 'failed' && host.lastConnectionStatus === 'failed') ||
        (hostStatusFilter === 'ready' && host.lastConnectionStatus === 'success') ||
        (hostStatusFilter === 'never' && host.lastConnectionStatus !== 'failed' && host.lastConnectionStatus !== 'success');
      const hostKey = sshKeyById.get(host.keyId) ?? null;
      const jumpHost = host.jumpHostId ? hostById.get(host.jumpHostId) ?? null : null;
      const proxyProfile = host.proxyProfileId ? proxyProfileById.get(host.proxyProfileId) ?? null : null;
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
          host.hostInfo?.systemName,
          host.hostInfo?.items.map((item) => `${item.label} ${item.value}`).join(' '),
          hostKey?.name,
          hostKey?.fingerprint,
          hostKey?.algorithm,
          jumpHost?.name,
          jumpHost?.address,
          proxyProfile?.label,
          getProxyConfigEndpoint(proxyProfile?.config),
          getProxyConfigTypeLabel(proxyProfile?.config),
          getAuthLabel(host, hostKey, appLanguage),
          ...host.tags,
        ]
          .join(' ')
          .toLowerCase()
          .includes(query);

      return matchesStatus && matchesGroup && matchesQuery;
    }).sort((left, right) => compareHostsByHostListSortMode(left, right, hostListSortMode, appLocale));
  }, [activeGroupKey, appLanguage, appLocale, hostById, hostListSortMode, hostStatusFilter, hosts, proxyProfileById, searchQuery, sshKeyById]);
  const hostPageCount = Math.max(1, Math.ceil(filteredHosts.length / hostPageSize));
  const currentHostPage = Math.min(hostPage, hostPageCount);
  const pagedHosts = useMemo(() => {
    const pageStart = (currentHostPage - 1) * hostPageSize;

    return filteredHosts.slice(pageStart, pageStart + hostPageSize);
  }, [currentHostPage, filteredHosts, hostPageSize]);
  const hostPageNumbers = useMemo(() => {
    const visibleCount = Math.min(hostPageCount, 5);
    const startPage = Math.min(
      Math.max(1, currentHostPage - Math.floor(visibleCount / 2)),
      Math.max(1, hostPageCount - visibleCount + 1),
    );

    return Array.from({ length: visibleCount }, (_, index) => startPage + index);
  }, [currentHostPage, hostPageCount]);

  const filteredKeys = useMemo(() => {
    const query = keySearchQuery.trim().toLowerCase();

    return sshKeys.filter((key) => {
      if (!query) {
        return true;
      }

      return [key.name, key.algorithm, key.fingerprint].join(' ').toLowerCase().includes(query);
    });
  }, [keySearchQuery, sshKeys]);

  const selectedHost = useMemo(() => {
    if (!selectedHostId) {
      return null;
    }

    return filteredHosts.find((host) => host.id === selectedHostId) ?? null;
  }, [filteredHosts, selectedHostId]);
  const hostInfoDialogHost = hostInfoDialogHostId
    ? hosts.find((host) => host.id === hostInfoDialogHostId) ?? null
    : null;
  const hostInfoDialogTimeItems = hostInfoDialogHost
    ? [
        {
          key: 'createdAt',
          label: t('app.host.info.createdAt', appLanguage),
          value: hostInfoDialogHost.createdAt,
        },
        {
          key: 'updatedAt',
          label: t('app.host.info.updatedAt', appLanguage),
          value: hostInfoDialogHost.updatedAt,
        },
        {
          key: 'lastConnectionAt',
          label: t('app.host.info.lastConnectionAt', appLanguage),
          value: hostInfoDialogHost.lastConnectionAt,
          emptyLabel: t('app.host.info.neverConnected', appLanguage),
        },
        ...(hostInfoDialogHost.hostInfo
          ? [
              {
                key: 'collectedAt',
                label: t('app.host.info.collectedAt', appLanguage),
                value: hostInfoDialogHost.hostInfo.collectedAt,
              },
            ]
          : []),
      ]
    : [];

  const getSelectedSshKey = (host: Pick<Host, 'keyId'>) => sshKeyById.get(host.keyId) ?? null;

  const applyVaultSnapshot = (snapshot: ShellDeskVaultSnapshot, options: { updateCollections?: boolean; hydrated?: boolean } = {}) => {
    const { updateCollections = true, hydrated = true } = options;

    const nextSettings = protectSettingsFromStaleSnapshot(snapshot.settings, settingsRef.current);
    const shouldRepairPersistedSettings = nextSettings !== snapshot.settings;

    if (updateCollections) {
      const nextHosts = protectHostInfoFromStaleSnapshot(
        normalizeStoredHosts(snapshot.hosts.filter(isStoredHost)),
        hostsRef.current,
      );
      const nextKeys = snapshot.sshKeys.filter(isStoredSshKey);
      const nextProxyProfiles = snapshot.proxyProfiles;
      const nextKnownHosts = snapshot.knownHosts;

      hostsRef.current = nextHosts;
      sshKeysRef.current = nextKeys;
      proxyProfilesRef.current = nextProxyProfiles;
      knownHostsRef.current = nextKnownHosts;
      setHosts(nextHosts);
      setSshKeys(nextKeys);
      setProxyProfiles(nextProxyProfiles);
      setKnownHosts(nextKnownHosts);

      if (hydrated) {
        lastPersistedCollectionsRef.current = JSON.stringify({
          hosts: nextHosts,
          sshKeys: nextKeys,
          proxyProfiles: nextProxyProfiles,
          settings: shouldRepairPersistedSettings ? snapshot.settings : nextSettings,
        });
      }
    }

    settingsRef.current = nextSettings;
    storeRemoteDesktopLayoutShadow(nextSettings.remoteDesktopLayout);
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
        proxyProfiles: proxyProfilesRef.current,
        settings: nextSettings,
      });
    }
  };

  const scheduleCollectionsSave = useCallback((payload: VaultCollectionsSavePayload, serialized: string) => {
    collectionsSaveQueue.enqueue({ payload, serialized });
  }, [collectionsSaveQueue]);

  const queueCollectionsSaveIfChanged = useCallback((payload: VaultCollectionsSavePayload) => {
    if (!vaultControls || !isVaultReady || !isVaultHydrated) {
      return;
    }

    const serializedPayload = JSON.stringify(payload);

    if (
      serializedPayload === lastPersistedCollectionsRef.current
      && !collectionsSaveQueue.hasWork()
    ) {
      return;
    }

    scheduleCollectionsSave(payload, serializedPayload);
  }, [collectionsSaveQueue, isVaultHydrated, isVaultReady, scheduleCollectionsSave, vaultControls]);

  const persistCurrentCollections = useCallback(async () => {
    if (!vaultControls || !isVaultReady || !isVaultHydrated) {
      return;
    }

    const payload: VaultCollectionsSavePayload = {
      hosts: hostsRef.current,
      sshKeys: sshKeysRef.current,
      proxyProfiles: proxyProfilesRef.current,
      settings: settingsRef.current,
    };
    const serializedPayload = JSON.stringify(payload);

    if (
      serializedPayload === lastPersistedCollectionsRef.current
      && !collectionsSaveQueue.hasWork()
    ) {
      return;
    }

    await collectionsSaveQueue.drain({ payload, serialized: serializedPayload });
  }, [collectionsSaveQueue, isVaultHydrated, isVaultReady, vaultControls]);

  const commitCollectionsState = useCallback((
    nextHosts: Host[],
    nextSshKeys: SshKey[],
    nextSettings: ShellDeskAppSettings,
    nextProxyProfiles: ShellDeskProxyProfile[] = proxyProfilesRef.current,
    nextKnownHosts: ShellDeskKnownHost[] = knownHostsRef.current,
  ) => {
    const orderedHosts = sortHostsByListOrder(sanitizeHostJumpHostReferences(nextHosts));

    // Invalidate any vault snapshot requested before this local mutation, even if its save
    // finishes and the single-flight queue becomes idle before the snapshot response arrives.
    collectionsRevisionRef.current += 1;
    hostsRef.current = orderedHosts;
    sshKeysRef.current = nextSshKeys;
    proxyProfilesRef.current = nextProxyProfiles;
    knownHostsRef.current = nextKnownHosts;
    settingsRef.current = nextSettings;
    storeRemoteDesktopLayoutShadow(nextSettings.remoteDesktopLayout);
    setHosts(orderedHosts);
    setSshKeys(nextSshKeys);
    setProxyProfiles(nextProxyProfiles);
    setKnownHosts(nextKnownHosts);
    setSettings(nextSettings);
    if (!vaultControls) {
      storeTerminalSnippets(nextSettings.terminalSnippets ?? []);
    }
    queueCollectionsSaveIfChanged({
      hosts: orderedHosts,
      sshKeys: nextSshKeys,
      proxyProfiles: nextProxyProfiles,
      settings: nextSettings,
    });
  }, [queueCollectionsSaveIfChanged, vaultControls]);

  const commitHosts = useCallback((nextHosts: Host[]) => {
    commitCollectionsState(nextHosts, sshKeysRef.current, settingsRef.current);
  }, [commitCollectionsState]);

  const commitSshKeys = useCallback((nextSshKeys: SshKey[]) => {
    commitCollectionsState(hostsRef.current, nextSshKeys, settingsRef.current);
  }, [commitCollectionsState]);

  const commitProxyProfiles = useCallback((nextProxyProfiles: ShellDeskProxyProfile[], nextHosts: Host[] = hostsRef.current) => {
    commitCollectionsState(nextHosts, sshKeysRef.current, settingsRef.current, nextProxyProfiles, knownHostsRef.current);
  }, [commitCollectionsState]);

  const commitKnownHosts = useCallback((nextKnownHosts: ShellDeskKnownHost[], nextHosts: Host[] = hostsRef.current) => {
    commitCollectionsState(nextHosts, sshKeysRef.current, settingsRef.current, proxyProfilesRef.current, nextKnownHosts);
    if (!vaultControls || !isVaultReady || !isVaultHydrated) {
      return;
    }

    void vaultControls.saveCollections({ knownHosts: nextKnownHosts }).then((snapshot) => {
      setStorageInfo(snapshot.storage);
      setBookmarkCount(snapshot.browserBookmarks.reduce((total: number, collection: ShellDeskBrowserBookmarkCollection) => total + collection.bookmarks.length, 0));
    }).catch((error: unknown) => {
      const currentLanguage = getCurrentAppLanguage();
      setStatusMessage(t('app.status.saveLocalFailed', currentLanguage, { error: getErrorMessage(error, currentLanguage) }));
    });
  }, [commitCollectionsState, isVaultHydrated, isVaultReady, vaultControls]);

  const refreshHosts = async () => {
    if (!vaultControls) {
      const nextHosts = readStoredHosts();
      hostsRef.current = nextHosts;
      setHosts(nextHosts);
      setStatusMessage(t('app.status.hostsRefreshed', appLanguage, { count: String(nextHosts.length) }));
      return;
    }

    try {
      const request = beginCollectionsSnapshotRequest();
      const snapshot = await vaultControls.getSnapshot();
      if (!isCurrentCollectionsSnapshotRequest(request)) {
        return;
      }
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
        kind: 'conflict',
        conflictCount: pendingCount,
        conflicts,
        config,
        emptyVaultSummary: null,
        shrinkSummary: null,
        resolution: '',
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
    proxyProfilesRef.current = proxyProfiles;
  }, [proxyProfiles]);

  useEffect(() => {
    knownHostsRef.current = knownHosts;
  }, [knownHosts]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    vaultControlsRef.current = vaultControls;
  }, [vaultControls]);

  useEffect(() => {
    if (!isAgentWorkspace || !vaultControls?.getPublicSnapshot) {
      return undefined;
    }

    let disposed = false;
    let isSyncing = false;
    const syncAppearance = () => {
      if (disposed || isSyncing) return;
      isSyncing = true;
      void vaultControls.getPublicSnapshot().then((snapshot) => {
        if (disposed) return;
        const incoming = snapshot.settings;
        setSettings((current) => {
          if (current.theme === incoming.theme && current.accentColor === incoming.accentColor) {
            return current;
          }
          const nextSettings = { ...current, theme: incoming.theme, accentColor: incoming.accentColor };
          settingsRef.current = nextSettings;
          return nextSettings;
        });
      }).catch(() => undefined).finally(() => {
        isSyncing = false;
      });
    };

    syncAppearance();
    const timer = window.setInterval(syncAppearance, 800);
    window.addEventListener('focus', syncAppearance);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', syncAppearance);
    };
  }, [isAgentWorkspace, vaultControls]);

  useEffect(() => {
    fetchBackendDefaults().then((backendDefaults) => {
      if (Object.keys(backendDefaults).length > 0) {
        setSettings((prev) => {
          const nextSettings = { ...backendDefaults, ...prev };
          settingsRef.current = nextSettings;
          storeRemoteDesktopLayoutShadow(nextSettings.remoteDesktopLayout);
          return nextSettings;
        });
      }
    });
  }, []);

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
      const hydrationRevision = collectionsRevisionRef.current;
      let renderedPublicSnapshot = Boolean(initialPublicSnapshotRef.current);
      const persistedLayoutShadow = await readPersistedRemoteDesktopLayoutShadow();

      if (!disposed && persistedLayoutShadow) {
        storeRemoteDesktopLayoutShadow(persistedLayoutShadow);
      }

      if (!renderedPublicSnapshot) {
        try {
          const publicSnapshotRequest = beginCollectionsSnapshotRequest();
          const publicSnapshot = typeof vaultControls.getPublicSnapshot === 'function'
            ? await vaultControls.getPublicSnapshot()
            : null;

          if (
            !disposed
            && publicSnapshot
            && collectionsSnapshotRequestGate.isCurrent(publicSnapshotRequest.requestId)
            && hydrationRevision === collectionsRevisionRef.current
            && !collectionsSaveQueue.hasWork()
          ) {
            renderedPublicSnapshot = true;
            applyVaultSnapshot(publicSnapshot, { hydrated: false });
          }
        } catch {
          // Fall back to the full vault read below.
        }
      }

      try {
        const fullSnapshotRequest = beginCollectionsSnapshotRequest();
        const snapshot = await vaultControls.getSnapshot();

        if (
          !disposed
          && collectionsSnapshotRequestGate.isCurrent(fullSnapshotRequest.requestId)
          && hydrationRevision === collectionsRevisionRef.current
          && !collectionsSaveQueue.hasWork()
        ) {
          applyVaultSnapshot(snapshot);
        } else if (
          !disposed
          && collectionsSnapshotRequestGate.isCurrent(fullSnapshotRequest.requestId)
        ) {
          const payload: VaultCollectionsSavePayload = {
            hosts: hostsRef.current,
            sshKeys: sshKeysRef.current,
            proxyProfiles: proxyProfilesRef.current,
            settings: settingsRef.current,
          };
          const serialized = JSON.stringify(payload);
          setStorageInfo(snapshot.storage);
          setBookmarkCount(snapshot.browserBookmarks.reduce(
            (total, collection) => total + collection.bookmarks.length,
            0,
          ));
          setIsVaultReady(true);
          setIsVaultHydrated(true);
          collectionsSaveQueue.enqueue({ payload, serialized });
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
  }, [
    beginCollectionsSnapshotRequest,
    collectionsSaveQueue,
    collectionsSnapshotRequestGate,
    isConnectionWindow,
    vaultControls,
  ]);

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

      if (result.needsEmptyVaultResolution) {
        setSyncConflictCount(result.emptyVaultSummary?.remoteRecords ?? 0);
        setSyncConflictNotice({
          kind: 'empty-vault',
          conflictCount: result.emptyVaultSummary?.remoteRecords ?? 0,
          conflicts: [],
          config: result.config,
          emptyVaultSummary: result.emptyVaultSummary,
          shrinkSummary: null,
          resolution: '',
        });
        setSyncResolutionError('');
        return;
      }

      if (result.needsShrinkConfirmation) {
        setSyncConflictCount(result.shrinkSummary?.lostRecords ?? 0);
        setSyncConflictNotice({
          kind: 'shrink',
          conflictCount: result.shrinkSummary?.lostRecords ?? 0,
          conflicts: result.conflicts,
          config: result.config,
          emptyVaultSummary: null,
          shrinkSummary: result.shrinkSummary,
          resolution: result.resolution,
        });
        setSyncResolutionError('');
        return;
      }

      if (result.needsResolution) {
        setSyncConflictCount(result.conflictCount);
        setSyncConflictNotice({
          kind: 'conflict',
          conflictCount: result.conflictCount,
          conflicts: result.conflicts,
          config: result.config,
          emptyVaultSummary: null,
          shrinkSummary: null,
          resolution: '',
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

    const getInfo = window.guiSSH?.app?.getInfo;
    let disposed = false;

    void getInfo?.()
      .then((info) => {
        if (!disposed) {
          setAppInfo(info);
        }
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
    };
  }, [isConnectionWindow]);

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
    storeHostListSortMode(hostListSortMode);
  }, [hostListSortMode]);

  useEffect(() => {
    storeHostPageSize(hostPageSize);
  }, [hostPageSize]);

  useEffect(() => {
    storeSideNavCollapsed(isSideNavCollapsed);
  }, [isSideNavCollapsed]);

  useEffect(() => {
    setHostPage(1);
  }, [activeGroupKey, hostListSortMode, hostPageSize, hostStatusFilter, hostViewMode, searchQuery]);

  useEffect(() => {
    if (selectedHostId && !filteredHosts.some((host) => host.id === selectedHostId)) {
      setSelectedHostId(null);
    }
  }, [filteredHosts, selectedHostId]);

  useEffect(() => {
    if (hostPage > hostPageCount) {
      setHostPage(hostPageCount);
    }
  }, [hostPage, hostPageCount]);

  useEffect(() => {
    const logsControls = window.guiSSH?.logs;

    if (!logsControls || !isVaultReady || isConnectionWindow) {
      return;
    }

    void logsControls.getEntries().then((entries) => {
      setLogs(entries as unknown as LogEntry[]);
    }).catch(() => undefined);
  }, [isConnectionWindow, isVaultReady]);

  useEffect(() => {
    queueCollectionsSaveIfChanged({ hosts, sshKeys, proxyProfiles, settings });
  }, [hosts, proxyProfiles, queueCollectionsSaveIfChanged, settings, sshKeys]);

  useEffect(() => {
    const closeOpenHostCardMenus = (target: EventTarget | null) => {
      const targetNode = target instanceof Node ? target : null;

      document.querySelectorAll<HTMLDetailsElement>('details.host-card-menu[open], details.toolbar-more-menu[open]').forEach((menu) => {
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
    if (!hostInfoDialogHostId) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setHostInfoDialogHostId(null);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [hostInfoDialogHostId]);

  useEffect(() => {
    if (isConnectionWindow || !window.guiSSH?.events.onLogsChanged) {
      return undefined;
    }

    return window.guiSSH.events.onLogsChanged((payload) => {
      if (payload.kind === 'clear') {
        setLogs([]);
        return;
      }

      if (payload.kind === 'append' && payload.entry) {
        const entry = payload.entry as LogEntry;
        setLogs((current) => {
          if (current.some((currentEntry) => currentEntry.id === entry.id)) {
            return current;
          }

          const next = [entry, ...current];
          return next.length > maxRenderedLogEntries ? next.slice(0, maxRenderedLogEntries) : next;
        });
        return;
      }

      void window.guiSSH?.logs?.getEntries().then((entries) => {
        setLogs(entries as unknown as LogEntry[]);
      }).catch(() => undefined);
    });
  }, [isConnectionWindow]);

  useEffect(() => {
    const handleExternalLogEntry = (event: Event) => {
      const entry = (event as CustomEvent<LogEntry>).detail;

      if (!entry || typeof entry.id !== 'string' || typeof entry.message !== 'string') {
        return;
      }

      setLogs((current) => {
        if (current.some((currentEntry) => currentEntry.id === entry.id)) {
          return current;
        }

        const next = [entry, ...current];
        return next.length > maxRenderedLogEntries ? next.slice(0, maxRenderedLogEntries) : next;
      });
    };

    window.addEventListener('shelldesk:log-entry', handleExternalLogEntry);
    return () => window.removeEventListener('shelldesk:log-entry', handleExternalLogEntry);
  }, []);

  useEffect(() => {
    if (!statusMessage) {
      return;
    }

    const timer = window.setTimeout(() => setStatusMessage(''), 5000);
    return () => window.clearTimeout(timer);
  }, [statusMessage]);

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
    if (!window.guiSSH?.events) {
      return undefined;
    }

    const removeKeyboardInteractive = window.guiSSH.events.onKeyboardInteractive((payload) => {
      setKeyboardInteractiveRequest(payload);
      setKeyboardInteractiveResponses(payload.prompts.map(() => ''));
      setIsKeyboardInteractivePending(false);
    });
    const removeHostKeyVerification = window.guiSSH.events.onHostKeyVerification((payload) => {
      setHostKeyVerificationRequest(payload);
      setIsHostKeyVerificationPending(false);
    });

    return () => {
      removeKeyboardInteractive();
      removeHostKeyVerification();
    };
  }, []);

  useEffect(() => {
    if (!connection || !window.guiSSH?.events) {
      return;
    }

    const removeClosed = window.guiSSH.events.onConnectionClosed((payload: ConnectionClosedPayload) => {
      if (payload.connectionId === connection.id) {
        const message = payload.reason || t('app.connection.closedDefault', appLanguage);
        const time = new Date().toLocaleTimeString(appLocale);
        addLog('connection', 'warning', t('app.connection.closedLog', appLanguage, { host: connection.host.address }), `${time} - ${message}`, getLogHostMeta(connection.host));
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
      addLog('connection', 'success', t('app.connection.restoredLog', appLanguage, { host: connection.host.address }), `${time} - ${t('app.connection.restoredDetail', appLanguage)}`, getLogHostMeta(connection.host));
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
    if (!window.guiSSH?.events) {
      return undefined;
    }

    return window.guiSSH.events.onCloseToTrayPrompt(() => {
      if (settingsRef.current.minimizeToTrayOnClose || settingsRef.current.minimizeToTrayPromptedOnClose) {
        void windowControls?.close();
        return;
      }

      setIsCloseToTrayPromptOpen(true);
    });
  }, [windowControls]);

  useEffect(() => {
    if (isConnectionWindow || !window.guiSSH?.events.onOpenAiSettings) {
      return undefined;
    }

    return window.guiSSH.events.onOpenAiSettings(() => {
      setConnection(null);
      setActivePage('settings');
      setSettingsSectionRequest((current) => ({ section: 'ai', id: (current?.id ?? 0) + 1 }));
      preloadFullMessageCatalog();
    });
  }, [isConnectionWindow]);

  useEffect(() => {
    if (!window.guiSSH?.events.onVaultChanged || !vaultControls) {
      return;
    }

    return window.guiSSH.events.onVaultChanged((payload) => {
      if (payload.kind === 'preference' && payload.key === remoteDesktopLayoutShadowPreferenceKey) {
        return;
      }

      if (payload.kind === 'hostKeyTrust' || payload.kind === 'sync') {
        const request = beginCollectionsSnapshotRequest();
        void vaultControls.getSnapshot().then((snapshot) => {
          if (!isCurrentCollectionsSnapshotRequest(request)) {
            return;
          }

          knownHostsRef.current = snapshot.knownHosts;
          setKnownHosts(snapshot.knownHosts);

          if (
            payload.kind === 'sync'
            && !collectionsSaveQueue.hasWork()
          ) {
            applyVaultSnapshot(snapshot);
          }
        }).catch(() => undefined);
        return;
      }

      if (payload.kind !== 'vault' && payload.kind !== 'bookmarks' && !isConnectionWindow) {
        return;
      }

      if (collectionsSaveQueue.hasWork()) {
        return;
      }

      const request = beginCollectionsSnapshotRequest();
      void vaultControls.getSnapshot().then((snapshot) => {
        if (!isCurrentCollectionsSnapshotRequest(request)) {
          return;
        }

        applyVaultSnapshot(snapshot, { updateCollections: isConnectionWindow || payload.kind === 'vault' });
      }).catch(() => undefined);
    });
  }, [
    beginCollectionsSnapshotRequest,
    collectionsSaveQueue,
    isConnectionWindow,
    isCurrentCollectionsSnapshotRequest,
    vaultControls,
  ]);

  useEffect(() => {
    if (!window.guiSSH?.events.onHostKeyTrusted) {
      return;
    }

    return window.guiSSH.events.onHostKeyTrusted((payload) => {
      setHostKeyVerificationRequest((current) => {
        if (
          current &&
          current.hostname === payload.hostname &&
          current.port === payload.port
        ) {
          setIsHostKeyVerificationPending(false);
          return null;
        }
        return current;
      });
    });
  }, []);

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
  const updateRemoteDesktopSettings = useCallback((nextSettings: ShellDeskAppSettings) => {
    persistRemoteDesktopLayoutShadow(nextSettings.remoteDesktopLayout);
    void updateSettingsAndPersist(nextSettings);
  }, [updateSettingsAndPersist]);
  const addLog = (category: LogCategory, level: LogLevel, message: string, detail = '', hostMeta: LogHostMeta = {}) => {
    const entry: LogEntry = {
      id: createId(),
      timestamp: new Date().toISOString(),
      category,
      level,
      message,
      detail,
      ...hostMeta,
    };
    setLogs((current) => {
      const next = [entry, ...current];
      return next.length > maxRenderedLogEntries ? next.slice(0, maxRenderedLogEntries) : next;
    });

    void window.guiSSH?.logs?.appendEntry(entry as unknown as ShellDeskLogEntry).catch(() => undefined);
  };

  const hostImport = useHostImportWorkflow({
    language: appLanguage,
    readHosts: () => hostsRef.current,
    commitHosts: (nextHosts) => commitCollectionsState(nextHosts, sshKeysRef.current, settingsRef.current),
    createId,
    setStatusMessage,
    addLog,
  });
  const clearLogs = () => {
    setLogs([]);
    void window.guiSSH?.logs?.clearEntries().catch(() => undefined);
  };

  const minimizeWindow = () => {
    void windowControls?.minimize();
  };

  const startWindowDragging = () => {
    void windowControls?.startDragging().catch(() => undefined);
  };

  const handleTitlebarPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }

    titlebarPointerGestureRef.current = {
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleTitlebarPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = titlebarPointerGestureRef.current;

    if (!gesture || gesture.pointerId !== event.pointerId || (event.buttons & 1) === 0) {
      return;
    }

    if (Math.hypot(event.clientX - gesture.originX, event.clientY - gesture.originY) < 4) {
      return;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    titlebarPointerGestureRef.current = null;
    startWindowDragging();
    event.preventDefault();
  };

  const finishTitlebarPointerGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (titlebarPointerGestureRef.current?.pointerId !== event.pointerId) {
      return;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    titlebarPointerGestureRef.current = null;
  };

  const toggleMaximizeWindow = () => {
    void windowControls?.toggleMaximize().then((maximized) => {
      setIsWindowMaximized(maximized);
    }).catch(() => undefined);
  };

  const closeWindow = () => {
    void windowControls?.close();
  };

  const resolveCloseToTrayPrompt = async (enableMinimizeToTray: boolean) => {
    if (isCloseToTrayPromptPending) {
      return;
    }

    setIsCloseToTrayPromptPending(true);

    try {
      await updateSettingsAndPersist((currentSettings) => ({
        ...currentSettings,
        minimizeToTrayOnClose: enableMinimizeToTray,
        minimizeToTrayPromptedOnClose: true,
      }));
      setIsCloseToTrayPromptOpen(false);
      await windowControls?.close();
    } catch (error) {
      setStatusMessage(t('app.closeToTrayPrompt.saveFailed', appLanguage, { error: getErrorMessage(error, appLanguage) }));
    } finally {
      setIsCloseToTrayPromptPending(false);
    }
  };

  const updateKeyboardInteractiveResponse = (index: number, value: string) => {
    setKeyboardInteractiveResponses((currentResponses) => {
      const nextResponses = [...currentResponses];
      nextResponses[index] = value;
      return nextResponses;
    });
  };

  const submitKeyboardInteractive = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const request = keyboardInteractiveRequest;
    const respond = window.guiSSH?.connections?.respondKeyboardInteractive;

    if (!request || !respond || isKeyboardInteractivePending) {
      return;
    }

    setIsKeyboardInteractivePending(true);
    void respond({
      requestId: request.requestId,
      responses: request.prompts.map((_prompt, index) => keyboardInteractiveResponses[index] ?? ''),
    }).catch((error) => {
      setStatusMessage(getErrorMessage(error, appLanguage));
    }).finally(() => {
      setIsKeyboardInteractivePending(false);
      setKeyboardInteractiveRequest((currentRequest) => (
        currentRequest?.requestId === request.requestId ? null : currentRequest
      ));
    });
  };

  const cancelKeyboardInteractive = () => {
    const request = keyboardInteractiveRequest;

    if (!request) {
      return;
    }

    setKeyboardInteractiveRequest(null);
    setKeyboardInteractiveResponses([]);
    setIsKeyboardInteractivePending(false);
    void window.guiSSH?.connections?.respondKeyboardInteractive({
      requestId: request.requestId,
      cancel: true,
    }).catch(() => undefined);
  };

  const respondHostKeyVerification = (accept: boolean, addToKnownHosts = false) => {
    const request = hostKeyVerificationRequest;
    const respond = window.guiSSH?.connections?.respondHostKeyVerification;

    if (!request || !respond || isHostKeyVerificationPending) {
      return;
    }

    setIsHostKeyVerificationPending(true);
    void respond({
      requestId: request.requestId,
      accept,
      addToKnownHosts,
    }).then(() => {
      if (!accept || !addToKnownHosts) {
        return;
      }

      const host = request.port ? `${request.hostname}:${request.port}` : request.hostname;
      addLog(
        'key',
        'success',
        t('app.hostKey.trustedLog', appLanguage, { host }),
        request.fingerprint ? `${request.keyType || 'SSH'} ${request.fingerprint}` : '',
        {
          hostName: request.hostname,
          hostAddress: request.hostname,
        },
      );
    }).catch((error) => {
      setStatusMessage(getErrorMessage(error, appLanguage));
    }).finally(() => {
      setIsHostKeyVerificationPending(false);
      setHostKeyVerificationRequest((currentRequest) => (
        currentRequest?.requestId === request.requestId ? null : currentRequest
      ));
    });
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
          kind: 'conflict',
          conflictCount: result.conflictCount,
          conflicts: result.conflicts,
          config: result.config,
          emptyVaultSummary: null,
          shrinkSummary: null,
          resolution: '',
        });
        setSyncResolutionError(t('app.sync.conflict.stillPending', appLanguage, { count: String(result.conflictCount) }));
        return;
      }

      if (result.needsShrinkConfirmation) {
        setSyncConflictCount(result.shrinkSummary?.lostRecords ?? 0);
        setSyncConflictNotice({
          kind: 'shrink',
          conflictCount: result.shrinkSummary?.lostRecords ?? 0,
          conflicts: result.conflicts,
          config: result.config,
          emptyVaultSummary: null,
          shrinkSummary: result.shrinkSummary,
          resolution: result.resolution,
        });
        setSyncResolutionError(t('app.sync.shrink.needsConfirmation', appLanguage, {
          lost: String(result.shrinkSummary?.lostRecords ?? 0),
        }));
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

  const resolveSyncEmptyVault = async (emptyVaultResolution: ShellDeskSyncEmptyVaultResolution) => {
    const syncControls = window.guiSSH?.sync;

    if (!syncControls) {
      setSyncResolutionError(t('app.sync.conflict.noApi', appLanguage));
      return;
    }

    setSyncResolutionPending(emptyVaultResolution);
    setSyncResolutionError('');

    try {
      const result = await syncControls.runNow({ emptyVaultResolution });

      if (result.snapshot) {
        applyVaultSnapshot(result.snapshot);
      }

      if (result.needsEmptyVaultResolution) {
        setSyncResolutionError(t('app.sync.emptyVault.stillPending', appLanguage));
        return;
      }

      if (result.needsShrinkConfirmation) {
        setSyncConflictCount(result.shrinkSummary?.lostRecords ?? 0);
        setSyncConflictNotice({
          kind: 'shrink',
          conflictCount: result.shrinkSummary?.lostRecords ?? 0,
          conflicts: result.conflicts,
          config: result.config,
          emptyVaultSummary: null,
          shrinkSummary: result.shrinkSummary,
          resolution: result.resolution,
        });
        return;
      }

      setSyncConflictCount(0);
      setSyncConflictNotice(null);
      setStatusMessage(t(
        emptyVaultResolution === 'restoreRemote' ? 'app.sync.emptyVault.restoredRemote' : 'app.sync.emptyVault.keptEmpty',
        appLanguage,
      ));
    } catch (error) {
      setSyncResolutionError(t('app.sync.conflict.resolveFailed', appLanguage, { error: getErrorMessage(error, appLanguage) }));
    } finally {
      setSyncResolutionPending('');
    }
  };

  const confirmSyncShrink = async () => {
    const syncControls = window.guiSSH?.sync;
    const pendingNotice = syncConflictNotice;

    if (!syncControls || pendingNotice?.kind !== 'shrink') {
      setSyncResolutionError(t('app.sync.conflict.noApi', appLanguage));
      return;
    }

    setSyncResolutionPending('allowShrink');
    setSyncResolutionError('');

    try {
      const result = await syncControls.runNow({
        conflictResolution: pendingNotice.resolution || undefined,
        shrinkResolution: 'allow',
      });

      if (result.snapshot) {
        applyVaultSnapshot(result.snapshot);
      }

      if (result.needsResolution || result.needsEmptyVaultResolution || result.needsShrinkConfirmation) {
        setSyncResolutionError(t('app.sync.shrink.stillPending', appLanguage));
        return;
      }

      setSyncConflictCount(0);
      setSyncConflictNotice(null);
      setStatusMessage(t('app.sync.shrink.confirmed', appLanguage, {
        count: String(result.deleted),
      }));
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

  const openCredentialDialog = (host: ConnectionHost, message = '', launchTarget: ConnectionLaunchTarget = 'desktop') => {
    const selectedKey = host.authMethod === 'key' ? getSelectedSshKey(host) : null;
    const authMethod: AuthMethod = host.authMethod === 'key' ? 'key' : 'password';

    setCredentialHost(host);
    setCredentialLaunchTarget(launchTarget);
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
    setCredentialLaunchTarget('desktop');
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
    const validationError = validateHostForm(form, sshKeys, hostsRef.current, editingHostId, proxyProfilesRef.current, appLanguage);

    if (validationError) {
      setFormError(validationError);
      return;
    }

    if (editingHost) {
      const updatedHost = updateHostFromForm(editingHost, form, selectedKey);
      commitHosts(hostsRef.current.map((host) => (host.id === editingHost.id ? updatedHost : host)));
      addLog('host', 'success', t('app.host.updateLog', appLanguage, { name: updatedHost.name }), `${updatedHost.username}@${updatedHost.address}:${updatedHost.port}`, getLogHostMeta(updatedHost));
      setStatusMessage(t('app.host.updatedStatus', appLanguage, { name: updatedHost.name }));
    } else {
      const nextHost = createHostFromForm(form, selectedKey);
      commitHosts([nextHost, ...hostsRef.current]);
      addLog('host', 'success', t('app.host.addLog', appLanguage, { name: nextHost.name }), `${nextHost.username}@${nextHost.address}:${nextHost.port}`, getLogHostMeta(nextHost));
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

  const quickAssignHostGroup = useCallback((host: Host, group: string) => {
    const nextGroup = group.trim();

    if (!nextGroup || host.group === nextGroup) {
      return;
    }

    commitHosts(hostsRef.current.map((currentHost) => (
      currentHost.id === host.id
        ? { ...currentHost, group: nextGroup, updatedAt: new Date().toISOString() }
        : currentHost
    )));
    setStatusMessage(appLanguage === 'zh-CN'
      ? `已将“${host.name}”加入分组“${nextGroup}”`
      : `Moved "${host.name}" to group "${nextGroup}"`);
  }, [appLanguage, commitHosts]);

  const quickAddHostTag = useCallback((host: Host, tag: string) => {
    const nextTag = tag.trim();

    if (!nextTag || host.tags.some((currentTag) => currentTag.toLocaleLowerCase() === nextTag.toLocaleLowerCase())) {
      return;
    }

    commitHosts(hostsRef.current.map((currentHost) => (
      currentHost.id === host.id
        ? { ...currentHost, tags: [...currentHost.tags, nextTag].slice(0, 8), updatedAt: new Date().toISOString() }
        : currentHost
    )));
    setStatusMessage(appLanguage === 'zh-CN'
      ? `已为“${host.name}”添加标签“${nextTag}”`
      : `Added tag "${nextTag}" to "${host.name}"`);
  }, [appLanguage, commitHosts]);

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
    addLog('host', 'info', t('app.host.deleteLog', appLanguage, { name: host.name }), `${host.username}@${host.address}:${host.port}`, getLogHostMeta(host));
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

  const closeNearestDetailsMenu = (trigger: HTMLElement | null) => {
    const details = trigger?.closest('details');

    if (details instanceof HTMLDetailsElement) {
      details.open = false;
    }
  };

  const collectHostInfoAfterConnection = async (
    host: Pick<Host, 'address' | 'id' | 'systemName' | 'systemType'>,
    connectionInfo: RemoteConnectionInfo,
    systemType: HostSystemType,
    systemName: string,
  ) => {
    const connections = window.guiSSH?.connections;

    if (!connections?.getSystemInfo || !hostsRef.current.some((currentHost) => currentHost.id === host.id)) {
      return;
    }

    try {
      const report = await connections.getSystemInfo(connectionInfo.id);
      const snapshot = createHostInfoSnapshot(host, report, systemType, systemName);

      if (!snapshot) {
        return;
      }

      commitHosts(hostsRef.current.map((currentHost): Host => {
        if (currentHost.id !== host.id || currentHost.address !== host.address) {
          return currentHost;
        }

        return {
          ...currentHost,
          systemType: snapshot.systemType !== 'unknown' ? snapshot.systemType : currentHost.systemType,
          systemName: snapshot.systemName || currentHost.systemName,
          hostInfo: snapshot,
        };
      }));
    } catch (error) {
      console.info(`[shelldesk] host info collection failed for ${host.address}:`, getErrorMessage(error));
    }
  };

  const connectHost = async (
    host: ConnectionHost,
    credentials?: CredentialFormState,
    launchSource: ConnectionLaunchSource = 'host-card',
    launchTarget: ConnectionLaunchTarget = 'desktop',
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

      let refreshedKnownHosts: ShellDeskKnownHost[] | null = null;

      if (vaultControls?.getSnapshot) {
        try {
          const request = beginCollectionsSnapshotRequest();
          const snapshot = await vaultControls.getSnapshot();
          if (isCurrentCollectionsSnapshotRequest(request)) {
            refreshedKnownHosts = snapshot.knownHosts;
            setStorageInfo(snapshot.storage);
            setBookmarkCount(snapshot.browserBookmarks.reduce((total, collection) => total + collection.bookmarks.length, 0));
          }
        } catch (snapshotError) {
          console.warn('[shelldesk] failed to refresh known hosts after connection:', snapshotError);
        }
      }

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
      const nextSshKeys = credentials?.saveCredential && effectiveAuthMethod === 'key' && selectedKey
        ? sshKeysRef.current.map((key) => (
            key.id === selectedKey.id
              ? { ...key, passphrase: credentials.passphrase, updatedAt: connectionFinishedAt }
              : key
          ))
        : sshKeysRef.current;
      const nextKnownHosts = refreshedKnownHosts ?? knownHostsRef.current;

      commitCollectionsState(nextHosts, nextSshKeys, settingsRef.current, proxyProfilesRef.current, nextKnownHosts);
      void collectHostInfoAfterConnection(host, nextConnection, detectedSystemType, detectedSystemName);

      if (isConnectionWindow) {
        setConnection({ ...nextConnection, host: nextConnection.host ?? hostForConnection });
        addLog('connection', 'success', t('app.connection.successLog', appLanguage, { host: host.name }), `${host.username}@${host.address}:${host.port}`, getLogHostMeta(host));
        setStatusMessage(t('app.connection.successStatus', appLanguage, { host: host.name }));
      } else {
        try {
          const openWindow = launchTarget === 'sftp-transfer'
            ? window.guiSSH.app?.openSftpTransferWindow
            : window.guiSSH.app?.openConnectionWindow;
          if (!openWindow) {
            throw new Error(t('app.connection.windowUnsupported', appLanguage));
          }
          await openWindow(nextConnection.id);
        } catch (windowError) {
          if (launchTarget === 'desktop') {
            setConnection({ ...nextConnection, host: nextConnection.host ?? hostForConnection });
            console.error('[shelldesk] failed to open connection window; falling back to current window:', windowError);
          } else {
            void window.guiSSH.connections.disconnect(nextConnection.id).catch(() => undefined);
            throw windowError;
          }
        }
        addLog('connection', 'success', t('app.connection.openWindowLog', appLanguage, { host: host.name }), `${host.username}@${host.address}:${host.port}`, getLogHostMeta(host));
        setStatusMessage(t('app.connection.openWindowStatus', appLanguage, { host: host.name }));
      }

      closeCredentialDialog();
      setConnectionErrorNotice(null);
      return true;
    } catch (error) {
      const message = getErrorMessage(error, appLanguage);
      markHostConnectionResult(hostForConnection, 'failed', message);
      addLog('connection', 'error', t('app.connection.failedLog', appLanguage, { host: host.name }), `${host.username}@${host.address}:${host.port} - ${message}`, getLogHostMeta(host));
      showConnectionError(hostForConnection, message);

      if (isAuthFailureMessage(message)) {
        openCredentialDialog(hostForConnection, message, launchTarget);
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

  const openLocalDesktop = async () => {
    if (isConnectionPending) {
      return false;
    }

    if (!window.guiSSH?.connections?.openLocal) {
      const message = t('app.connection.localUnsupported', appLanguage);
      setStatusMessage(message);
      addLog('connection', 'error', t('app.connection.localOpenFailedLog', appLanguage), message);
      return false;
    }

    setIsLocalOpening(true);
    setConnectionErrorNotice(null);
    preloadFullMessageCatalog();

    try {
      const nextConnection = await window.guiSSH.connections.openLocal();

      if (isConnectionWindow) {
        setConnection(nextConnection);
      } else {
        try {
          if (!window.guiSSH.app?.openConnectionWindow) {
            throw new Error(t('app.connection.windowUnsupported', appLanguage));
          }
          await window.guiSSH.app.openConnectionWindow(nextConnection.id);
        } catch (windowError) {
          setConnection(nextConnection);
          console.error('[shelldesk] failed to open local connection window; falling back to current window:', windowError);
        }
      }

      addLog('connection', 'success', t('app.connection.localOpenLog', appLanguage), nextConnection.host.systemName || nextConnection.host.address, getLogHostMeta(nextConnection.host));
      setStatusMessage(t('app.connection.localOpenStatus', appLanguage));
      return true;
    } catch (error) {
      const message = getErrorMessage(error, appLanguage);
      addLog('connection', 'error', t('app.connection.localOpenFailedLog', appLanguage), message);
      setStatusMessage(t('app.connection.localOpenFailedStatus', appLanguage, { error: message }));
      return false;
    } finally {
      setIsLocalOpening(false);
    }
  };

  const openHostFromList = (host: ConnectionHost) => {
    if (isConnectionPending) {
      return;
    }

    if (host.authMethod === 'password' && !host.password) {
      openCredentialDialog(host, t('app.connection.passwordPrompt', appLanguage), 'desktop');
      return;
    }

    void connectHost(host, undefined, 'host-card');
  };

  const openSftpTransferFromList = (host: ConnectionHost) => {
    if (isConnectionPending) {
      return;
    }

    if (host.authMethod === 'password' && !host.password) {
      openCredentialDialog(host, t('app.connection.passwordPrompt', appLanguage), 'sftp-transfer');
      return;
    }

    void connectHost(host, undefined, 'host-card', 'sftp-transfer');
  };

  const connectCommandBarInput = async () => {
    if (isConnectionPending) {
      return;
    }

    const parsedCommand = parseQuickConnectCommand(quickConnectInput);

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
      proxyProfileId: '',
      systemType: 'unknown',
      systemName: '',
      hostInfo: null,
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

    await connectHost(credentialHost, credentialForm, 'credential', credentialLaunchTarget);
  };

  const openNavigationItem = (item: NavigationItem) => {
    if (item.key === 'hosts') {
      setActivePage('hosts');
      return;
    }

    setActivePage(item.page);
    preloadFullMessageCatalog();
  };

  const isNavigationItemActive = (item: NavigationItem) => {
    if (item.key === 'hosts') {
      return activePage === 'hosts';
    }

    return activePage === item.page;
  };

  const toggleSideNav = () => {
    setIsSideNavCollapsed((current) => !current);
  };

  const sideNavToggleLabel = t(isSideNavCollapsed ? 'app.nav.expand' : 'app.nav.collapse', appLanguage);

  const openAgentWorkspace = () => {
    if (!window.guiSSH?.app?.openAgentWindow) {
      setStatusMessage(appLanguage === 'zh-CN' ? '当前环境不支持打开 Agent 工作台。' : 'This environment cannot open the Agent workspace.');
      return;
    }

    void window.guiSSH.app.openAgentWindow().catch((error) => {
      setStatusMessage(getErrorMessage(error, appLanguage));
    });
  };

  const selectHostGroup = (groupKey: string | null) => {
    setActivePage('hosts');
    setActiveGroupKey(groupKey);
  };

  const updateHostViewMode = (viewMode: HostViewMode) => {
    if (settingsRef.current.defaultHostView === viewMode) {
      return;
    }

    const nextSettings: ShellDeskAppSettings = {
      ...settingsRef.current,
      defaultHostView: viewMode,
    };

    commitCollectionsState(hostsRef.current, sshKeysRef.current, nextSettings);
    setStatusMessage(viewMode === 'grid'
      ? (appLanguage === 'zh-CN' ? '已切换到卡片模式' : 'Switched to card view')
      : (appLanguage === 'zh-CN' ? '已切换到列表模式' : 'Switched to list view'));
  };

  const goToHostPage = (page: number) => {
    setHostPage(Math.min(Math.max(1, page), hostPageCount));
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
  const syncNoticeKind = syncConflictNotice?.kind ?? 'conflict';
  const syncConflictBadgeLabel = syncConflictCount
    ? syncNoticeKind === 'empty-vault'
      ? t('app.sync.emptyVault.badge', appLanguage, { count: String(syncConflictCount) })
      : syncNoticeKind === 'shrink'
        ? t('app.sync.shrink.badge', appLanguage, { count: String(syncConflictCount) })
        : t('app.sync.conflict.badge', appLanguage, { count: String(syncConflictCount) })
    : '';
  const syncNoticeTitle = syncNoticeKind === 'empty-vault'
    ? t('app.sync.emptyVault.title', appLanguage)
    : syncNoticeKind === 'shrink'
      ? t('app.sync.shrink.title', appLanguage)
      : t('app.sync.conflict.title', appLanguage);
  const syncNoticeSummary = syncNoticeKind === 'empty-vault'
    ? t('app.sync.emptyVault.summary', appLanguage, { count: String(syncConflictNotice?.emptyVaultSummary?.remoteRecords ?? 0) })
    : syncNoticeKind === 'shrink'
      ? t('app.sync.shrink.summary', appLanguage, {
          lost: String(syncConflictNotice?.shrinkSummary?.lostRecords ?? 0),
          baseline: String(syncConflictNotice?.shrinkSummary?.baselineRecords ?? 0),
          next: String(syncConflictNotice?.shrinkSummary?.mergedRecords ?? 0),
        })
      : t('app.sync.conflict.summary', appLanguage, { count: String(syncConflictNotice?.conflictCount ?? 0) });
  const shouldShowSyncConflictNotice = Boolean(syncConflictNotice) && !connection && !isConnectionWindow && activePage !== 'settings';
  const formattedUpdateReadyVersion = formatUpdateReadyVersion(updateReadyNotice?.version);
  const updateReadyVersionLabel = formattedUpdateReadyVersion
    ? formattedUpdateReadyVersion
    : t('app.update.ready.versionUnknown', appLanguage);
  const shouldShowUpdateReadyNotice = Boolean(updateReadyNotice) && !shouldShowSyncConflictNotice && !connection && !isConnectionWindow && activePage !== 'settings';
  const footerVersionText = appInfo?.version
    ? (appLanguage === 'zh-CN' ? `版本 ${appInfo.version}` : `Version ${appInfo.version}`)
    : (appLanguage === 'zh-CN' ? '版本 --' : 'Version --');
  const hostKeyFingerprintLabel = hostKeyVerificationRequest?.fingerprint
    ? `SHA256:${hostKeyVerificationRequest.fingerprint.replace(/^SHA256:/i, '')}`
    : '';
  const knownHostFingerprintLabel = hostKeyVerificationRequest?.knownFingerprint
    ? `SHA256:${hostKeyVerificationRequest.knownFingerprint.replace(/^SHA256:/i, '')}`
    : '';
  const hostKeyVerificationChanged = hostKeyVerificationRequest?.status === 'changed';

  return (
    <div className={isMacOS ? 'app-shell app-shell-macos' : 'app-shell'}>
      <header className="top-chrome drag-region">
        <div
          className="titlebar-drag-surface no-drag"
          aria-hidden="true"
          onPointerDown={handleTitlebarPointerDown}
          onPointerMove={handleTitlebarPointerMove}
          onPointerUp={finishTitlebarPointerGesture}
          onPointerCancel={finishTitlebarPointerGesture}
          onDoubleClick={toggleMaximizeWindow}
        />
        <div className={`workspace-title ${connection ? 'has-connection' : 'app-only'}`} aria-label={connection ? undefined : 'ShellDesk'}>
          <img className="app-window-icon" src={appIconUrl} alt="" />
          {connection ? (
            <>
              <strong>ShellDesk</strong>
              <span>{titlebarConnectionAddress}</span>
              {isLocalDesktopConnection ? (
                <span>{t('app.connection.localBadge', appLanguage)}</span>
              ) : connection.proxyPort > 0 ? (
                <span>SOCKS :{connection.proxyPort}</span>
              ) : null}
            </>
          ) : null}
        </div>

        <div className="titlebar-actions no-drag">
          <GlobalTransferCenter language={appLanguage} />
          {showWindowControls ? (
            <div className="titlebar-controls">
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
        </div>
      </header>

      {statusMessage ? <div className="status-toast no-drag" role="status">{statusMessage}</div> : null}
      {hostImport.isOpen ? <HostImportWizard language={appLanguage} existingHosts={hosts} onApply={hostImport.apply} onClose={hostImport.close} /> : null}
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
      {isCloseToTrayPromptOpen ? createPortal(
        <div className="ssh-security-overlay no-drag" role="presentation">
          <div className="ssh-security-dialog" role="dialog" aria-modal="true" aria-labelledby="close-to-tray-title">
            <div className="ssh-security-mark" aria-hidden="true">?</div>
            <div className="ssh-security-copy">
              <strong id="close-to-tray-title">{t('app.closeToTrayPrompt.title', appLanguage)}</strong>
              <p>{t('app.closeToTrayPrompt.summary', appLanguage)}</p>
            </div>
            <div className="ssh-security-actions">
              <button
                type="button"
                onClick={() => void resolveCloseToTrayPrompt(false)}
                disabled={isCloseToTrayPromptPending}
              >
                {t('app.closeToTrayPrompt.exit', appLanguage)}
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => void resolveCloseToTrayPrompt(true)}
                disabled={isCloseToTrayPromptPending}
              >
                {t('app.closeToTrayPrompt.enable', appLanguage)}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
      {keyboardInteractiveRequest ? createPortal(
        <div className="ssh-security-overlay no-drag" role="presentation">
          <form className="ssh-security-dialog" role="dialog" aria-modal="true" aria-labelledby="keyboard-interactive-title" onSubmit={submitKeyboardInteractive}>
            <div className="ssh-security-mark" aria-hidden="true">#</div>
            <div className="ssh-security-copy">
              <strong id="keyboard-interactive-title">{keyboardInteractiveRequest.name || t('app.mfa.title', appLanguage)}</strong>
              <span>{keyboardInteractiveRequest.username}@{keyboardInteractiveRequest.hostname}:{keyboardInteractiveRequest.port}</span>
              <p>{keyboardInteractiveRequest.instructions || t('app.mfa.summary', appLanguage)}</p>
              <div className="ssh-security-fields">
                {keyboardInteractiveRequest.prompts.map((prompt, index) => (
                  <label key={`${keyboardInteractiveRequest.requestId}:${index}`}>
                    <span>{prompt.prompt || t('app.mfa.prompt', appLanguage, { index: String(index + 1) })}</span>
                    <input
                      autoFocus={index === 0}
                      type={prompt.echo ? 'text' : 'password'}
                      value={keyboardInteractiveResponses[index] ?? ''}
                      onChange={(event) => updateKeyboardInteractiveResponse(index, event.target.value)}
                      disabled={isKeyboardInteractivePending}
                    />
                  </label>
                ))}
              </div>
            </div>
            <div className="ssh-security-actions">
              <button type="button" onClick={cancelKeyboardInteractive} disabled={isKeyboardInteractivePending}>{t('common.cancel', appLanguage)}</button>
              <button type="submit" className="primary" disabled={isKeyboardInteractivePending}>
                {isKeyboardInteractivePending ? t('app.mfa.verifying', appLanguage) : t('app.mfa.submit', appLanguage)}
              </button>
            </div>
          </form>
        </div>,
        document.body,
      ) : null}
      {hostKeyVerificationRequest ? createPortal(
        <div className="ssh-security-overlay no-drag" role="presentation">
          <div className={`ssh-security-dialog host-key-dialog ${hostKeyVerificationChanged ? 'changed' : ''}`} role="alertdialog" aria-modal="true" aria-labelledby="host-key-title">
            <div className="ssh-security-mark" aria-hidden="true">{hostKeyVerificationChanged ? '!' : '◆'}</div>
            <div className="ssh-security-copy">
              <strong id="host-key-title">
                {hostKeyVerificationChanged ? t('app.hostKey.changedTitle', appLanguage) : t('app.hostKey.unknownTitle', appLanguage)}
              </strong>
              <span>{hostKeyVerificationRequest.username}@{hostKeyVerificationRequest.hostname}:{hostKeyVerificationRequest.port}</span>
              <p>
                {hostKeyVerificationChanged
                  ? t('app.hostKey.changedSummary', appLanguage)
                  : t('app.hostKey.unknownSummary', appLanguage)}
              </p>
              <div className="ssh-security-fingerprints">
                <span>{t('app.hostKey.fingerprint', appLanguage, { keyType: hostKeyVerificationRequest.keyType || 'SSH' })}</span>
                <code>{hostKeyFingerprintLabel}</code>
                {knownHostFingerprintLabel ? (
                  <>
                    <span>{t('app.hostKey.savedFingerprint', appLanguage)}</span>
                    <code>{knownHostFingerprintLabel}</code>
                  </>
                ) : null}
              </div>
            </div>
            <div className="ssh-security-actions">
              <button type="button" onClick={() => respondHostKeyVerification(false)} disabled={isHostKeyVerificationPending}>{t('common.cancel', appLanguage)}</button>
              <button type="button" onClick={() => respondHostKeyVerification(true, false)} disabled={isHostKeyVerificationPending}>
                {t('app.hostKey.continueOnce', appLanguage)}
              </button>
              <button type="button" className="primary" onClick={() => respondHostKeyVerification(true, true)} disabled={isHostKeyVerificationPending}>
                {hostKeyVerificationChanged ? t('app.hostKey.updateAndContinue', appLanguage) : t('app.hostKey.trustAndContinue', appLanguage)}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
      {shouldShowSyncConflictNotice && syncConflictNotice ? createPortal(
        <div className="sync-conflict-popover no-drag" role="alertdialog" aria-modal="false" aria-labelledby="sync-conflict-title">
          {syncConflictNotice.kind === 'conflict' ? (
            <button
              type="button"
              className="sync-conflict-close"
              aria-label={t('app.sync.conflict.dismiss', appLanguage)}
              onClick={() => setSyncConflictNotice(null)}
            >
              ×
            </button>
          ) : null}
          <span className="sync-conflict-mark" aria-hidden="true">!</span>
          <div className="sync-conflict-copy">
            <strong id="sync-conflict-title">{syncNoticeTitle}</strong>
            <p>{syncNoticeSummary}</p>
            {syncConflictNotice.kind === 'empty-vault' ? (
              <div className="sync-conflict-preview">
                <span>
                  <b>{t('app.sync.emptyVault.remoteItems', appLanguage, { count: String(syncConflictNotice.emptyVaultSummary?.remoteRecords ?? 0) })}</b>
                  <small>{t('app.sync.emptyVault.localItems', appLanguage, { count: String(syncConflictNotice.emptyVaultSummary?.localRecords ?? 0) })}</small>
                </span>
              </div>
            ) : syncConflictNotice.kind === 'shrink' ? (
              <div className="sync-conflict-preview">
                <span>
                  <b>{t('app.sync.shrink.lostItems', appLanguage, { count: String(syncConflictNotice.shrinkSummary?.lostRecords ?? 0) })}</b>
                  <small>{t('app.sync.shrink.counts', appLanguage, {
                    baseline: String(syncConflictNotice.shrinkSummary?.baselineRecords ?? 0),
                    next: String(syncConflictNotice.shrinkSummary?.mergedRecords ?? 0),
                  })}</small>
                </span>
              </div>
            ) : syncConflictPreview.length ? (
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
              {syncConflictNotice.kind === 'empty-vault' ? (
                <>
                  <button
                    type="button"
                    onClick={() => void resolveSyncEmptyVault('keepEmpty')}
                    disabled={Boolean(syncResolutionPending)}
                  >
                    {syncResolutionPending === 'keepEmpty' ? t('app.sync.emptyVault.keepEmptyLoading', appLanguage) : t('app.sync.emptyVault.keepEmpty', appLanguage)}
                  </button>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => void resolveSyncEmptyVault('restoreRemote')}
                    disabled={Boolean(syncResolutionPending)}
                  >
                    {syncResolutionPending === 'restoreRemote' ? t('app.sync.emptyVault.restoreRemoteLoading', appLanguage) : t('app.sync.emptyVault.restoreRemote', appLanguage)}
                  </button>
                </>
              ) : syncConflictNotice.kind === 'shrink' ? (
                <button
                  type="button"
                  className="primary"
                  onClick={() => void confirmSyncShrink()}
                  disabled={Boolean(syncResolutionPending)}
                >
                  {syncResolutionPending === 'allowShrink' ? t('app.sync.shrink.confirmLoading', appLanguage) : t('app.sync.shrink.confirm', appLanguage)}
                </button>
              ) : (
                <>
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
                </>
              )}
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

      {isAgentWorkspace ? (
        <Suspense fallback={<LazyContentFallback language={appLanguage} />}>
          <AgentWorkspace
            hosts={hosts}
            settings={settings}
            language={appLanguage}
            onOpenSettings={() => void window.guiSSH?.app?.openMainAiSettings?.()}
            onReturnToHostManagement={() => void window.guiSSH?.app?.showMainWindow?.()}
          />
        </Suspense>
      ) : connection && isSftpTransferWorkspace ? (
        <Suspense fallback={<LazyContentFallback language={appLanguage} />}>
          <SftpTransferWindow connection={connection} language={appLanguage} />
        </Suspense>
      ) : connection ? (
        <Suspense fallback={<RemoteDesktopLoadingFallback language={appLanguage} />}>
          <RemoteDesktop connection={connection} settings={settings} onSettingsChange={updateRemoteDesktopSettings} initialAppKey={desktopAppRequest} />
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
        <aside className={`side-nav ${isSideNavCollapsed ? 'collapsed' : ''}`}>
          <div className="side-nav-header">
            <span className="side-nav-brand">ShellDesk</span>
            <button
              type="button"
              className="side-nav-toggle"
              onClick={toggleSideNav}
              aria-label={sideNavToggleLabel}
              title={sideNavToggleLabel}
              aria-expanded={!isSideNavCollapsed}
            >
              <span className="side-nav-toggle-icon" aria-hidden="true">
                <PanelLeftOpen className="side-nav-toggle-open" />
                <PanelLeftClose className="side-nav-toggle-close" />
              </span>
            </button>
          </div>
          <nav className="feature-nav" aria-label={t('app.nav.feature', appLanguage)}>
            {navigationItems.map((item) => (
              <Fragment key={item.key}>
                <button
                  type="button"
                  className={`feature-nav-item ${isNavigationItemActive(item) ? 'active' : ''}`}
                  onClick={() => openNavigationItem(item)}
                  onFocus={item.key === 'hosts' ? undefined : preloadFullMessageCatalog}
                  onMouseEnter={item.key === 'hosts' ? undefined : preloadFullMessageCatalog}
                  title={isSideNavCollapsed ? item.label[appLanguage] : undefined}
                >
                  <span className="nav-icon"><ShellDeskNavIcon name={item.icon} /></span>
                  <span className="side-nav-label">{item.label[appLanguage]}</span>
                </button>
                {item.key === 'hosts' ? <button
                  type="button"
                  className="feature-nav-item"
                  onClick={openAgentWorkspace}
                  onFocus={preloadFullMessageCatalog}
                  onMouseEnter={preloadFullMessageCatalog}
                  title={isSideNavCollapsed ? (appLanguage === 'zh-CN' ? 'AI 工作台' : 'AI workspace') : undefined}
                >
                  <span className="nav-icon"><ShellDeskNavIcon name="agent" /></span>
                  <span className="side-nav-label">{appLanguage === 'zh-CN' ? 'AI 工作台' : 'AI workspace'}</span>
                </button> : null}
              </Fragment>
            ))}
          </nav>

          <button
            type="button"
            className={`settings-entry ${activePage === 'settings' ? 'active' : ''} ${syncConflictCount ? 'has-sync-conflict' : ''}`}
            onClick={() => setActivePage('settings')}
            onFocus={preloadFullMessageCatalog}
            onMouseEnter={preloadFullMessageCatalog}
            title={isSideNavCollapsed ? t('app.nav.settings', appLanguage) : (syncConflictBadgeLabel || undefined)}
          >
            <span className="nav-icon"><ShellDeskNavIcon name="settings" /></span>
            <span className="side-nav-label">{t('app.nav.settings', appLanguage)}</span>
            {syncConflictCount ? <span className="settings-sync-dot" aria-label={syncConflictBadgeLabel} /> : null}
          </button>

        </aside>

        <main className="vault-page">
          {activePage === 'hosts' ? (
            <>
              <section className="vault-content hosts-content hosts-workbench">
                <section className="hosts-table-area" aria-label={t('app.host.all', appLanguage)}>
                  <div className="hosts-list-controls">
                    <div className="hosts-list-toolbar">
                      <label className="quick-connect-field">
                        <Terminal aria-hidden="true" />
                        <input
                          type="text"
                          placeholder="ssh user@host -p 22 -i ~/.ssh/id_rsa"
                          value={quickConnectInput}
                          onChange={(event) => setQuickConnectInput(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              void connectCommandBarInput();
                            }
                          }}
                        />
                      </label>

                      <button type="button" className="primary-action quick-connect-button" onClick={() => void connectCommandBarInput()} disabled={isConnectionPending}>
                        {isQuickConnecting ? t('app.host.connectingButton', appLanguage) : t('app.host.connectButton', appLanguage)}
                      </button>

                      <button
                        type="button"
                        className="command-button local-connect-button"
                        onClick={() => void openLocalDesktop()}
                        disabled={isConnectionPending}
                      >
                        <Monitor aria-hidden="true" />
                        {isLocalOpening ? t('app.host.localOpeningButton', appLanguage) : (appLanguage === 'zh-CN' ? '本地连接' : 'Local')}
                      </button>

                      <label className="host-search-field">
                        <Search aria-hidden="true" />
                        <input
                          type="search"
                          placeholder={appLanguage === 'zh-CN' ? '搜索主机名称、IP 或标签' : 'Search host name, IP, or tags'}
                          value={searchQuery}
                          onChange={(event) => setSearchQuery(event.target.value)}
                        />
                      </label>

                      <span className="hosts-list-toolbar-spacer" />

                      <div className="host-view-switch" role="group" aria-label={appLanguage === 'zh-CN' ? '主机视图切换' : 'Host view switch'}>
                        <button
                          type="button"
                          className={hostViewMode === 'grid' ? 'active' : ''}
                          aria-pressed={hostViewMode === 'grid'}
                          title={appLanguage === 'zh-CN' ? '卡片模式' : 'Card view'}
                          aria-label={appLanguage === 'zh-CN' ? '卡片模式' : 'Card view'}
                          onClick={() => updateHostViewMode('grid')}
                        >
                          <LayoutGrid aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className={hostViewMode === 'list' ? 'active' : ''}
                          aria-pressed={hostViewMode === 'list'}
                          title={appLanguage === 'zh-CN' ? '列表模式' : 'List view'}
                          aria-label={appLanguage === 'zh-CN' ? '列表模式' : 'List view'}
                          onClick={() => updateHostViewMode('list')}
                        >
                          <LayoutList aria-hidden="true" />
                        </button>
                      </div>

                      <button type="button" className="toolbar-icon-button" onClick={() => void refreshHosts()} aria-label={t('app.host.refreshList', appLanguage)} title={t('app.host.refreshList', appLanguage)}>
                        <RefreshCw aria-hidden="true" />
                      </button>

                      <button type="button" className="primary-action host-add-button" onClick={openCreateHost}>
                        <Plus aria-hidden="true" />
                        <span>{appLanguage === 'zh-CN' ? '添加主机' : 'Add host'}</span>
                      </button>

                      <details className="toolbar-more-menu">
                        <summary className="toolbar-icon-button" aria-label={t('app.host.actions', appLanguage)}>
                          <MoreHorizontal aria-hidden="true" />
                        </summary>
                        <div className="toolbar-menu-panel">
                          {hostListSortModes.map((sortMode) => (
                            <button
                              key={sortMode}
                              type="button"
                              className={hostListSortMode === sortMode ? 'active' : ''}
                              onClick={(event) => {
                                setHostListSortMode(sortMode);
                                closeNearestDetailsMenu(event.currentTarget);
                              }}
                            >
                              {hostListSortMode === sortMode ? <Check aria-hidden="true" /> : <span className="toolbar-menu-spacer" aria-hidden="true" />}
                              {t(hostListSortModeLabelIds[sortMode], appLanguage)}
                            </button>
                          ))}
                          <HostImportMenuActions
                            language={appLanguage}
                            rollbackCount={hostImport.rollback ? hostImport.rollback.added + hostImport.rollback.replaced : 0}
                            onOpen={hostImport.open}
                            onUndo={hostImport.undo}
                            onCloseMenu={closeNearestDetailsMenu}
                          />
                        </div>
                      </details>
                    </div>

                    <div className="host-status-strip" role="group" aria-label={appLanguage === 'zh-CN' ? '主机状态总览' : 'Host status overview'}>
                      {([
                        ['all', hostStatusCounts.all, 'app.host.overview.all'],
                        ['ready', hostStatusCounts.ready, 'app.host.overview.ready'],
                        ['failed', hostStatusCounts.failed, 'app.host.overview.failed'],
                        ['never', hostStatusCounts.never, 'app.host.overview.never'],
                      ] as const).map(([filterKey, count, labelId]) => (
                        <button
                          key={filterKey}
                          type="button"
                          className={`host-status-chip status-${filterKey} ${hostStatusFilter === filterKey ? 'active' : ''}`}
                          aria-pressed={hostStatusFilter === filterKey}
                          onClick={() => setHostStatusFilter((current) => (current === filterKey ? 'all' : filterKey))}
                        >
                          <i aria-hidden="true" />
                          <span>{t(labelId, appLanguage)}</span>
                          <b>{count}</b>
                        </button>
                      ))}
                      <span className="host-status-latest">
                        {latestConnectedHost
                          ? t('app.host.overview.latest', appLanguage, { name: latestConnectedHost.name })
                          : t('app.host.info.neverConnected', appLanguage)}
                      </span>
                    </div>
                  </div>

                  <div className="hosts-body">
                    <aside className="host-group-rail" aria-label={t('app.host.group.title', appLanguage)}>
                      <h3>{t('app.host.group.title', appLanguage)}</h3>
                      <button
                        type="button"
                        className={`host-group-rail-item ${activeGroupKey ? '' : 'active'}`}
                        onClick={() => selectHostGroup(null)}
                      >
                        <Folder aria-hidden="true" />
                        <span>{appLanguage === 'zh-CN' ? '全部主机' : 'All hosts'}</span>
                        <b>{hosts.length}</b>
                      </button>
                      {hostGroups.map((group) => (
                        <button
                          key={group.key}
                          type="button"
                          className={`host-group-rail-item ${activeGroupKey === group.key ? 'active' : ''}`}
                          onClick={() => selectHostGroup(group.key)}
                        >
                          <Folder aria-hidden="true" />
                          <span>{group.name}</span>
                          <b>{group.count}</b>
                        </button>
                      ))}
                    </aside>

                    <HostListPanel
                      hosts={hosts}
                      filteredHosts={filteredHosts}
                      pagedHosts={pagedHosts}
                      isVaultReady={isVaultReady}
                      appLanguage={appLanguage}
                      hostViewMode={hostViewMode}
                      selectedHostId={selectedHost?.id ?? null}
                      onSelectHost={setSelectedHostId}
                      onOpenHost={openHostFromList}
                      onOpenSftp={openSftpTransferFromList}
                      onDeleteHost={deleteHost}
                      onEditHost={startEditingHost}
                      onQuickAssignGroup={quickAssignHostGroup}
                      onQuickAddTag={quickAddHostTag}
                      groupOptions={hostGroupOptions}
                      tagOptions={hostTagOptions}
                      hostPage={currentHostPage}
                      hostPageCount={hostPageCount}
                      hostPageNumbers={hostPageNumbers}
                      hostPageSize={hostPageSize}
                      hostPageSizeOptions={hostPageSizeOptions}
                      onPageSizeChange={(pageSize) => setHostPageSize(isHostPageSize(pageSize) ? pageSize : 20)}
                      onPageChange={goToHostPage}
                      isHostConnecting={(hostId) => connectingHostId === hostId}
                      proxyProfileById={proxyProfileById}
                      closeHostCardMenu={closeHostCardMenu}
                      formatRelativeTime={formatRelativeTime}
                      getHostChipClassName={getHostChipClassName}
                      getHostConnectionStateView={getHostConnectionStateView}
                      getHostSystemLabel={getHostSystemLabel}
                      getProxyConfigTypeLabel={getProxyConfigTypeLabel}
                      renderHostSystemIcon={(host) => (
                        <HostSystemIcon systemName={getHostSystemLabel(host, appLanguage)} systemType={host.systemType} />
                      )}
                    />
                  </div>
                </section>

                <aside className="host-detail-panel" aria-label={appLanguage === 'zh-CN' ? '主机详情' : 'Host details'}>
                  {selectedHost ? (() => {
                    const connectionState = getHostConnectionStateView(selectedHost, appLanguage);
                    const selectedKey = getSelectedSshKey(selectedHost);
                    const proxyProfile = selectedHost.proxyProfileId ? proxyProfileById.get(selectedHost.proxyProfileId) ?? null : null;
                    const detailAuthLabel = getAuthLabel(selectedHost, selectedKey, appLanguage);
                    const basicRows = [
                      [appLanguage === 'zh-CN' ? '主机/IP' : 'Host/IP', selectedHost.address],
                      [appLanguage === 'zh-CN' ? '用户' : 'User', selectedHost.username],
                      [appLanguage === 'zh-CN' ? '端口' : 'Port', String(selectedHost.port)],
                      [appLanguage === 'zh-CN' ? '分组' : 'Group', selectedHost.group || t('app.host.group.ungrouped', appLanguage)],
                      [appLanguage === 'zh-CN' ? '描述' : 'Description', selectedHost.note || '-'],
                    ] as const;
                    const connectionRows = [
                      [appLanguage === 'zh-CN' ? '最近连接' : 'Last connection', selectedHost.lastConnectionAt ? formatHostInfoTime(selectedHost.lastConnectionAt, appLanguage) : t('app.host.info.neverConnected', appLanguage)],
                      [appLanguage === 'zh-CN' ? '首次添加' : 'Created', formatHostInfoTime(selectedHost.createdAt, appLanguage)],
                      [appLanguage === 'zh-CN' ? '更新时间' : 'Updated', formatHostInfoTime(selectedHost.updatedAt, appLanguage)],
                      [appLanguage === 'zh-CN' ? '登录方式' : 'Auth', detailAuthLabel],
                      [appLanguage === 'zh-CN' ? '密钥对' : 'Key', selectedKey?.name || selectedHost.keyPath || '-'],
                      [appLanguage === 'zh-CN' ? '代理' : 'Proxy', proxyProfile?.label || '-'],
                    ] as const;
                    const systemRows = [
                      ['OS', getHostDetailValue(selectedHost, 'os', getHostSystemLabel(selectedHost, appLanguage))],
                      [appLanguage === 'zh-CN' ? 'CPU 核心' : 'CPU cores', getHostCpuCoreValue(selectedHost, appLanguage)],
                      [appLanguage === 'zh-CN' ? '内存' : 'Memory', getHostMemoryTotalValue(selectedHost)],
                      [appLanguage === 'zh-CN' ? '硬盘' : 'Disk', getHostDiskTotalValue(selectedHost)],
                      [appLanguage === 'zh-CN' ? '内核' : 'Kernel', getHostDetailValue(selectedHost, 'kernel', '-')],
                      [appLanguage === 'zh-CN' ? '架构' : 'Arch', getHostDetailValue(selectedHost, 'arch', '-')],
                      [appLanguage === 'zh-CN' ? '运行时间' : 'Uptime', getHostDetailValue(selectedHost, 'uptime', '-')],
                      [appLanguage === 'zh-CN' ? '负载' : 'Load', getHostDetailValue(selectedHost, 'load', '-')],
                    ] as const;

                    return (
                      <>
                        <header className="host-detail-header">
                          <HostSystemIcon systemName={getHostSystemLabel(selectedHost, appLanguage)} systemType={selectedHost.systemType} />
                          <span>
                            <strong>{selectedHost.name}</strong>
                            <small className={`host-row-state ${connectionState.className}`}><i aria-hidden="true" />{connectionState.label}</small>
                          </span>
                          <button type="button" className="host-detail-close" onClick={() => setSelectedHostId(null)} aria-label={appLanguage === 'zh-CN' ? '清除选择' : 'Clear selection'}>
                            <PanelRightOpen aria-hidden="true" />
                          </button>
                        </header>

                        <div className="host-detail-actions">
                          <button type="button" className="primary-action" disabled={isConnectionPending} onClick={() => openHostFromList(selectedHost)}>
                            <Terminal aria-hidden="true" />
                            {appLanguage === 'zh-CN' ? '打开工作台' : 'Open workbench'}
                          </button>
                        </div>

                        <section className="host-detail-section">
                          <h3>{appLanguage === 'zh-CN' ? '基本信息' : 'Basic info'}<ChevronDown aria-hidden="true" /></h3>
                          <dl>
                            {basicRows.map(([label, value]) => (
                              <div key={label}>
                                <dt>{label}</dt>
                                <dd>{value}</dd>
                              </div>
                            ))}
                            <div>
                              <dt>{appLanguage === 'zh-CN' ? '标签' : 'Tags'}</dt>
                              <dd className="host-detail-tags">
                                {(selectedHost.tags.length ? selectedHost.tags : ['-']).map((tag) => (
                                  <span key={`${selectedHost.id}:detail:${tag}`} className={getHostChipClassName('tag', tag, Boolean(selectedHost.tags.length))}>{tag}</span>
                                ))}
                              </dd>
                            </div>
                          </dl>
                        </section>

                        <section className="host-detail-section">
                          <h3>{appLanguage === 'zh-CN' ? '连接信息' : 'Connection info'}<ChevronDown aria-hidden="true" /></h3>
                          <dl>
                            {connectionRows.map(([label, value]) => (
                              <div key={label}>
                                <dt>{label}</dt>
                                <dd>{value}</dd>
                              </div>
                            ))}
                          </dl>
                        </section>

                        <section className="host-detail-section">
                          <h3>{appLanguage === 'zh-CN' ? '系统信息' : 'System info'}<ChevronDown aria-hidden="true" /></h3>
                          <dl>
                            {systemRows.map(([label, value]) => (
                              <div key={label}>
                                <dt>{label}</dt>
                                <dd>{value}</dd>
                              </div>
                            ))}
                          </dl>
                        </section>
                      </>
                    );
                  })() : (
                    <div className="host-detail-empty">
                      <Server aria-hidden="true" />
                      <strong>{appLanguage === 'zh-CN' ? '选择一台主机' : 'Select a host'}</strong>
                      <span>{appLanguage === 'zh-CN' ? '主机详情会显示在这里。' : 'Host details appear here.'}</span>
                    </div>
                  )}
                </aside>
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
          ) : activePage === 'proxies' ? (
            <Suspense fallback={<LazyContentFallback language={appLanguage} />}>
              <ProxyProfilesPage
                hosts={hosts}
                proxyProfiles={proxyProfiles}
                onProxyProfilesChange={(nextProxyProfiles, nextHosts = hostsRef.current) => {
                  commitProxyProfiles(nextProxyProfiles, nextHosts as Host[]);
                }}
              />
            </Suspense>
          ) : activePage === 'known-hosts' ? (
            <Suspense fallback={<LazyContentFallback language={appLanguage} />}>
              <KnownHostsPage
                hosts={hosts}
                knownHosts={knownHosts}
                onKnownHostsChange={(nextKnownHosts, nextHosts = hostsRef.current) => {
                  commitKnownHosts(nextKnownHosts, nextHosts as Host[]);
                }}
              />
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
                updateCheckRequestId={settingsUpdateCheckRequestId}
                initialSection={settingsSectionRequest?.section}
                sectionRequestId={settingsSectionRequest?.id}
                onInitialSectionApplied={() => setSettingsSectionRequest(null)}
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
                    onChange={(event) => {
                      updateFormField('jumpHostId', event.target.value);
                      if (event.target.value) {
                        updateFormField('proxyProfileId', '');
                      }
                    }}
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

                <label className="field">
                  <span>{appLanguage === 'zh-CN' ? '代理' : 'Proxy'}</span>
                  <select
                    value={form.proxyProfileId}
                    onChange={(event) => {
                      updateFormField('proxyProfileId', event.target.value);
                      if (event.target.value) {
                        updateFormField('jumpHostId', '');
                      }
                    }}
                  >
                    <option value="">{appLanguage === 'zh-CN' ? '直连，不使用代理' : 'Direct, no proxy'}</option>
                    {proxyProfiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.label} · {getProxyConfigTypeLabel(profile.config)} · {getProxyConfigEndpoint(profile.config)}
                      </option>
                    ))}
                  </select>
                  <small className="field-note">
                    {proxyProfiles.length
                      ? (appLanguage === 'zh-CN' ? '代理用于目标主机直连；选择后将取消跳板机。' : 'Proxy is used for direct target connections; choosing one clears the jump host.')
                      : (appLanguage === 'zh-CN' ? '暂无代理配置；可在左侧“代理”页面添加。' : 'No proxy profiles yet. Add one from the Proxies page.')}
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

                <div className="host-form-check-block">
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={form.keepaliveEnabled}
                      onChange={(event) => updateFormField('keepaliveEnabled', event.target.checked)}
                    />
                    <span>{t('host.ssh.keepalive', appLanguage)}</span>
                  </label>
                  <small className="field-note">{t('host.ssh.keepaliveDescription', appLanguage)}</small>
                </div>

                {form.keepaliveEnabled ? (
                  <label className="field">
                    <span>{t('host.ssh.keepaliveInterval', appLanguage)}</span>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      inputMode="numeric"
                      value={form.keepaliveIntervalSeconds}
                      onChange={(event) => updateFormField('keepaliveIntervalSeconds', event.target.value)}
                      placeholder={String(defaultKeepaliveIntervalSeconds)}
                    />
                  </label>
                ) : null}

                <HostMetadataFields
                  appLanguage={appLanguage} group={form.group} tags={form.tags}
                  groupOptions={hostGroupOptions} tagOptions={hostTagOptions}
                  onChange={updateFormField}
                />

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
                  <DismissibleAlert className="error-banner" onDismiss={() => setFormError('')} role="alert" source="HostEditor">
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
                  <DismissibleAlert className="error-banner" onDismiss={() => setKeyFormError('')} role="alert" source="KeyEditor">
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
                  <DismissibleAlert className="error-banner" onDismiss={() => setCredentialError('')} role="alert" source="CredentialDialog">
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

          {hostInfoDialogHost ? createPortal(
            <div className="host-info-modal-overlay no-drag" role="presentation" onClick={() => setHostInfoDialogHostId(null)}>
              <section
                className="host-info-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby="host-info-modal-title"
                onClick={(event) => event.stopPropagation()}
              >
                <header className="host-info-modal-header">
                  <HostSystemIcon systemName={getHostSystemLabel(hostInfoDialogHost, appLanguage)} systemType={hostInfoDialogHost.systemType} />
                  <div>
                    <span>{t('app.host.info.title', appLanguage)}</span>
                    <strong id="host-info-modal-title">{hostInfoDialogHost.name}</strong>
                    <small>{hostInfoDialogHost.username}@{hostInfoDialogHost.address}:{hostInfoDialogHost.port}</small>
                  </div>
                  <button type="button" onClick={() => setHostInfoDialogHostId(null)} aria-label={t('app.host.info.close', appLanguage)}>×</button>
                </header>

                <div className="host-info-timeline">
                  {hostInfoDialogTimeItems.map((item) => (
                    <div key={item.key} className="host-info-time">
                      <span>{item.label}</span>
                      {item.value ? (
                        <time dateTime={item.value}>{formatHostInfoTime(item.value, appLanguage)}</time>
                      ) : (
                        <strong>{item.emptyLabel ?? '-'}</strong>
                      )}
                    </div>
                  ))}
                </div>

                {hostInfoDialogHost.hostInfo ? (
                  <dl className="host-info-list">
                    {hostInfoDialogHost.hostInfo.items.map((item) => (
                      <div key={`${item.key}-${item.label}`} className="host-info-item">
                        <dt>
                          {item.icon ? <span aria-hidden="true">{item.icon}</span> : null}
                          {item.label}
                        </dt>
                        <dd>{item.value || '-'}</dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <div className="host-info-empty">
                    <span>INFO</span>
                    <h3>{t('app.host.info.emptyTitle', appLanguage)}</h3>
                    <p>{t('app.host.info.emptyDescription', appLanguage)}</p>
                  </div>
                )}
              </section>
            </div>,
            document.body,
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
        <footer className="app-status-footer no-drag">
          <span><i aria-hidden="true" />{appLanguage === 'zh-CN' ? '就绪' : 'Ready'}</span>
          <span></span>
          <span>{appLanguage === 'zh-CN' ? `${hosts.length} 台主机` : `${hosts.length} hosts`}</span>
          <span>{appLanguage === 'zh-CN' ? `${proxyProfiles.length} 个代理` : `${proxyProfiles.length} proxies`}</span>
          <span>{footerVersionText}</span>
          <button
            type="button"
            onClick={() => {
              setActivePage('settings');
              preloadFullMessageCatalog();
              setSettingsUpdateCheckRequestId((currentRequestId) => currentRequestId + 1);
            }}
          >
            {appLanguage === 'zh-CN' ? '检查更新' : 'Check updates'}
          </button>
        </footer>
      </div>
      )}
    </div>
  );
}

export default App;
