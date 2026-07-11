import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

type EventCallback<T = unknown> = (payload: T) => void;

type TauriRuntimeWindow = Window & {
  __TAURI_INTERNALS__?: unknown;
};

const previewUnsupportedMessage = '当前浏览器预览环境不支持原生桌面能力，请在 Tauri 桌面窗口中使用。';

function detectPlatform(): NodeJS.Platform {
  const value = navigator.userAgent.toLowerCase();

  if (value.includes('windows')) return 'win32';
  if (value.includes('mac os') || value.includes('macintosh')) return 'darwin';
  if (value.includes('linux')) return 'linux';
  return 'linux';
}

function createRequestId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isTauriRuntime() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in (window as TauriRuntimeWindow);
}

function createPreviewRemoteDesktopLayout(): ShellDeskRemoteDesktopLayout {
  return {
    appCatalogVersion: 14,
    sortMode: 'custom',
    items: [
      { id: 'app:files', type: 'app', appKey: 'files' },
      { id: 'app:terminal', type: 'app', appKey: 'terminal' },
      { id: 'app:notepad', type: 'app', appKey: 'notepad' },
      { id: 'app:code-editor', type: 'app', appKey: 'code-editor' },
      { id: 'app:browser', type: 'app', appKey: 'browser' },
      { id: 'app:service-manager', type: 'app', appKey: 'service-manager' },
      { id: 'app:container-manager', type: 'app', appKey: 'container-manager' },
      { id: 'app:k8s-manager', type: 'app', appKey: 'k8s-manager' },
      { id: 'app:procmanager', type: 'app', appKey: 'procmanager' },
      { id: 'app:ai-chat', type: 'app', appKey: 'ai-chat' },
      { id: 'app:settings', type: 'app', appKey: 'settings' },
    ],
    removedAppKeys: [],
  };
}

// 预览模式默认设置。Rust 后端 vault.rs::default_settings() 为唯一权威源。
// 本处硬编码仅用于无后端的预览模式，保持与后端一致。
// 一致性检查：node scripts/check-default-settings-parity.cjs
function createPreviewSettings(): ShellDeskAppSettings {
  return {
    language: 'zh-CN',
    interfaceFont: 'Microsoft YaHei UI',
    theme: 'dark',
    accentColor: '#0f6bff',
    defaultHostView: 'grid',
    minimizeToTrayOnClose: false,
    minimizeToTrayPromptedOnClose: false,
    autoUpdateEnabled: true,
    desktopWallpaperMode: 'preset',
    desktopWallpaperPresetId: 'default',
    desktopWallpaperDataUrl: '',
    desktopWallpaperName: '',
    remoteDesktopDockPosition: 'bottom',
    remoteDesktopDockSize: 'medium',
    remoteDesktopDockAutoHide: 'never',
    remoteDesktopDockPinnedApps: ['files', 'terminal', 'browser'],
    remoteDesktopLayout: createPreviewRemoteDesktopLayout(),
    rememberPasswords: true,
    rememberKeyPassphrases: true,
    aiProvider: 'openai',
    aiProviderName: 'OpenAI',
    aiApiFormat: 'openai',
    aiApiBaseUrl: 'https://api.openai.com/v1',
    aiApiKey: '',
    aiModel: '',
    webSearchEnabled: false,
    webSearchProvider: 'tavily',
    webSearchApiKey: '',
    webSearchApiBaseUrl: 'https://api.tavily.com',
    webSearchMaxResults: 5,
    terminalFontSize: 13,
    terminalFontFamily: 'Cascadia Mono',
    terminalFontWeight: 400,
    terminalFontWeightBold: 700,
    terminalLigatures: true,
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
    terminalPreferTmux: false,
    terminalSnippets: [],
  };
}

function createPreviewVaultSnapshot(): ShellDeskVaultSnapshot {
  return {
    hosts: [],
    sshKeys: [],
    proxyProfiles: [],
    knownHosts: [],
    settings: createPreviewSettings(),
    browserBookmarks: [],
    storage: {
      path: '',
      configPath: '',
      vaultPath: '',
      protected: false,
      protectionLabel: 'none',
    },
  };
}

let previewVaultSnapshot = createPreviewVaultSnapshot();

function createPreviewSyncConfig(): ShellDeskSyncPublicConfig {
  return {
    enabled: false,
    provider: 'webdav',
    webdavUrl: '',
    webdavUsername: '',
    webdavRemotePath: '',
    ignoreCertificateErrors: false,
    intervalMinutes: 60,
    syncOnStartup: false,
    lastSyncAt: '',
    lastSyncStatus: 'idle',
    lastSyncMessage: '',
    lastConflictCount: 0,
    deviceId: 'browser-preview',
    hasWebDavPassword: false,
    hasSyncPassphrase: false,
  };
}

function createPreviewUpdateStatus(): ShellDeskUpdateStatus {
  return {
    status: 'idle',
    percent: 0,
    error: null,
    version: null,
    releaseNotes: '',
    releaseDate: null,
    isChecking: false,
    supported: false,
    unsupportedReason: previewUnsupportedMessage,
    checkedAt: null,
  };
}

function unsupportedPreviewIpc(channel: string): Promise<never> {
  return Promise.reject(new Error(`${previewUnsupportedMessage}（${channel}）`));
}

async function previewIpc<T = unknown>(channel: string, args: unknown[]): Promise<T> {
  switch (channel) {
    case 'app:get-info':
      return {
        name: 'shelldesk',
        productName: 'ShellDesk',
        version: '1.0.0',
        description: 'ShellDesk',
        homepage: '',
        author: '',
        platform: detectPlatform(),
        arch: 'unknown',
        isPackaged: false,
      } satisfies ShellDeskAppInfo as T;

    case 'app:check-for-updates':
      return {
        repository: '',
        currentVersion: '1.0.0',
        latestVersion: '1.0.0',
        updateAvailable: false,
        releaseName: '',
        releaseTag: '',
        releaseUrl: '',
        releaseDate: null,
        latestYmlUrl: '',
        downloadName: '',
        downloadUrl: null,
        downloadSize: 0,
        checkedAt: new Date().toISOString(),
      } satisfies ShellDeskUpdateCheckResult as T;

    case 'app:check-for-update-download':
      return { available: false, supported: false, error: previewUnsupportedMessage } satisfies ShellDeskAutoUpdateCheckResult as T;

    case 'app:download-update':
      return { success: false, error: previewUnsupportedMessage } satisfies ShellDeskUpdateActionResult as T;

    case 'app:install-update':
      return false as T;

    case 'app:get-update-status':
      return createPreviewUpdateStatus() as T;

    case 'app:open-external': {
      const url = typeof args[0] === 'string' ? args[0] : '';
      if (url) {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
      return null as T;
    }

    case 'window:is-maximized':
    case 'window:toggle-maximize':
      return false as T;

    case 'window:show':
    case 'window:start-dragging':
    case 'window:minimize':
    case 'window:close':
      return null as T;

    case 'vault:get-public-snapshot':
    case 'vault:get-snapshot':
      return previewVaultSnapshot as T;

    case 'vault:save-collections': {
      const payload = (args[0] ?? {}) as ShellDeskVaultCollectionsPayload;
      previewVaultSnapshot = {
        ...previewVaultSnapshot,
        hosts: payload.hosts ?? previewVaultSnapshot.hosts,
        sshKeys: payload.sshKeys ?? previewVaultSnapshot.sshKeys,
        proxyProfiles: payload.proxyProfiles ?? previewVaultSnapshot.proxyProfiles,
        knownHosts: payload.knownHosts ?? previewVaultSnapshot.knownHosts,
        settings: payload.settings ?? previewVaultSnapshot.settings,
      };
      return previewVaultSnapshot as T;
    }

    case 'vault:get-bookmarks':
      return [] as T;

    case 'vault:save-bookmarks':
      return (Array.isArray(args[1]) ? args[1] : []) as T;

    case 'vault:get-remote-connection-profile':
      return null as T;

    case 'vault:save-remote-connection-profile':
      return ((args[2] ?? {}) as ShellDeskRemoteConnectionProfileValues) as T;

    case 'logs:get-entries':
    case 'logs:clear-entries':
    case 'logs:save-entries':
    case 'logs:append-entry':
      return [] as T;

    case 'preferences:get':
      return null as T;

    case 'preferences:set':
      return (args[1] ?? null) as T;

    case 'system:list-fonts':
      return [] as T;

    case 'system:read-known-hosts':
      return { content: '', paths: [] } satisfies ShellDeskKnownHostsReadResult as T;

    case 'sync:get-config':
    case 'sync:save-config':
      return createPreviewSyncConfig() as T;

    case 'sync:test-webdav':
      return { ok: false, checkedAt: new Date().toISOString(), message: previewUnsupportedMessage } satisfies ShellDeskWebDavTestResult as T;

    case 'sync:run-now':
      return {
        ok: false,
        needsResolution: false,
        needsEmptyVaultResolution: false,
        needsShrinkConfirmation: false,
        resolution: '',
        emptyVaultResolution: '',
        shrinkResolution: '',
        syncedAt: new Date().toISOString(),
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        conflictCount: 0,
        conflicts: [],
        conflictSummary: [],
        summary: {
          localRecords: 0,
          remoteRecords: 0,
          mergedRecords: 0,
          tombstones: 0,
          uploaded: 0,
          downloaded: 0,
          deleted: 0,
          conflictCount: 0,
          conflictsByType: [],
          recordsByType: {},
        },
        emptyVaultSummary: null,
        shrinkSummary: null,
        snapshot: null,
        config: createPreviewSyncConfig(),
      } satisfies ShellDeskSyncResult as T;

    case 'ai:list-models':
      return { endpoint: '', models: [] } satisfies ShellDeskAiModelListResult as T;

    case 'ai:chat':
    case 'ai:chat-stream':
      return { endpoint: '', content: previewUnsupportedMessage } satisfies ShellDeskAiChatResult as T;

    case 'ai:web-search':
      return {
        endpoint: '',
        query: '',
        provider: 'tavily',
        results: [],
      } satisfies ShellDeskWebSearchResult as T;

    case 'connection:get-ipc-capabilities':
      return { terminalSessions: false, terminalBinary: false } satisfies ShellDeskIpcCapabilities as T;

    case 'connection:browser-resolve-url': {
      const url = typeof args[1] === 'string' ? args[1] : 'about:blank';
      return { url, browserUrl: url, proxied: false, mode: 'direct' } as T;
    }

    case 'connection:disconnect':
    case 'connection:close-terminal':
      return true as T;

    default:
      return unsupportedPreviewIpc(channel);
  }
}

async function ipc<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  // TODO: Replace free-form channel strings and unknown args with a typed channel map
  // so each IPC channel carries its expected argument tuple and return type.
  if (!isTauriRuntime()) {
    return previewIpc<T>(channel, args);
  }

  return invoke<T>('ipc_dispatch', { channel, args });
}

function onTauriEvent<T = unknown>(channel: string, callback: EventCallback<T>) {
  if (!isTauriRuntime()) {
    void channel;
    void callback;
    return () => {};
  }

  let disposed = false;
  let dispose: (() => void) | undefined;

  void listen<T>(channel, (event) => {
    callback(event.payload);
  })
    .then((unlisten) => {
      if (disposed) {
        unlisten();
        return;
      }

      dispose = unlisten;
    })
    .catch((error) => {
      console.error(`ShellDesk failed to listen for Tauri event "${channel}".`, error);
    });

  return () => {
    disposed = true;
    dispose?.();
  };
}

function chatStream(request: ShellDeskAiChatRequest, callbacks: ShellDeskAiChatStreamCallbacks = {}) {
  const streamId = createRequestId('ai-stream');
  const removeChunkListener = onTauriEvent<{ streamId?: string; chunk?: string }>('ai:chat-stream:chunk', (payload) => {
    if (payload?.streamId === streamId && typeof payload.chunk === 'string') {
      callbacks.onChunk?.(payload.chunk);
    }
  });

  return ipc<ShellDeskAiChatResult>('ai:chat-stream', { ...(request as object), streamId }).finally(() => {
    removeChunkListener();
  });
}

function runCommandStream(
  connectionId: string,
  command: string,
  stdin?: string,
  callbacks: { onChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void } = {},
  options?: unknown,
) {
  const streamId = createRequestId('command-stream');
  const removeChunkListener = onTauriEvent<{
    streamId?: string;
    chunk?: string;
    stream?: string;
  }>('connection:run-command-stream:chunk', (payload) => {
    if (payload?.streamId === streamId && typeof payload.chunk === 'string') {
      callbacks.onChunk?.(payload.chunk, payload.stream === 'stderr' ? 'stderr' : 'stdout');
    }
  });

  return ipc<{ stdout: string; stderr: string; code: number }>(
    'connection:run-command-stream',
    connectionId,
    command,
    stdin,
    streamId,
    options,
  ).finally(() => {
    removeChunkListener();
  });
}

async function connectHost(host: ShellDeskHostConnectionRequest) {
  const result = await ipc<{ ok?: boolean; error?: string; connection?: ShellDeskConnectionInfo }>('connection:connect', host);

  if (!result?.ok) {
    throw new Error(result?.error || 'SSH 连接失败。');
  }

  if (!result.connection) {
    throw new Error('SSH 连接失败。');
  }

  return result.connection;
}

async function openLocalConnection() {
  const result = await ipc<{ ok?: boolean; error?: string; connection?: ShellDeskConnectionInfo }>('connection:open-local');

  if (!result?.ok) {
    throw new Error(result?.error || '打开本地模式失败。');
  }

  return result.connection as ShellDeskConnectionInfo;
}

const initialPublicVaultSnapshotPromise = ipc<ShellDeskVaultSnapshot>('vault:get-public-snapshot');
let shouldUseInitialPublicVaultSnapshot = true;

initialPublicVaultSnapshotPromise.catch(() => undefined);

function getPublicVaultSnapshot() {
  if (shouldUseInitialPublicVaultSnapshot) {
    return initialPublicVaultSnapshotPromise.finally(() => {
      shouldUseInitialPublicVaultSnapshot = false;
    });
  }

  return ipc<ShellDeskVaultSnapshot>('vault:get-public-snapshot');
}

window.guiSSH = {
  appName: 'ShellDesk',
  platform: detectPlatform(),
  app: {
    getInfo: () => ipc('app:get-info'),
    checkForUpdates: () => ipc('app:check-for-updates'),
    checkForUpdateDownload: () => ipc('app:check-for-update-download'),
    downloadUpdate: () => ipc('app:download-update'),
    installUpdate: () => ipc('app:install-update'),
    getUpdateStatus: () => ipc('app:get-update-status'),
    openExternal: (url) => ipc('app:open-external', url),
    openConnectionWindow: (connectionId, desktopApp) => ipc('app:open-connection-window', connectionId, desktopApp),
    openAgentWindow: () => ipc('app:open-agent-window'),
    openMainAiSettings: () => ipc('app:open-main-ai-settings'),
    showMainWindow: () => ipc('app:show-main-window'),
  },
  window: {
    show: () => ipc('window:show'),
    startDragging: () => ipc('window:start-dragging'),
    minimize: () => ipc('window:minimize'),
    toggleMaximize: () => ipc('window:toggle-maximize'),
    isMaximized: () => ipc('window:is-maximized'),
    close: () => ipc('window:close'),
  },
  files: {
    selectPrivateKeyFile: () => ipc('dialog:select-private-key'),
    selectPublicKeyFile: () => ipc('dialog:select-public-key'),
    importConfig: () => ipc('config:import'),
    exportConfig: () => ipc('config:export'),
    saveTextFile: (payload) => ipc('dialog:save-text-file', payload),
  },
  vault: {
    initialPublicSnapshot: null,
    getDefaultSettings: () => ipc<ShellDeskAppSettings>('vault:get-default-settings'),
    getPublicSnapshot: getPublicVaultSnapshot,
    getSnapshot: () => ipc<ShellDeskVaultSnapshot>('vault:get-snapshot'),
    saveCollections: (payload) => ipc('vault:save-collections', payload),
    importKeyPair: (payload) => ipc('vault:import-key-pair', payload),
    generateRsaKeyPair: (payload) => ipc('vault:generate-rsa-key-pair', payload),
    getBookmarks: (scope) => ipc('vault:get-bookmarks', scope),
    saveBookmarks: (scope, bookmarks) => ipc('vault:save-bookmarks', scope, bookmarks),
    getRemoteConnectionProfile: (hostId, appKey) => ipc('vault:get-remote-connection-profile', hostId, appKey),
    saveRemoteConnectionProfile: (hostId, appKey, values) => ipc('vault:save-remote-connection-profile', hostId, appKey, values),
  },
  logs: {
    getEntries: () => ipc('logs:get-entries'),
    clearEntries: () => ipc('logs:clear-entries'),
    saveEntries: (entries) => ipc('logs:save-entries', entries),
    appendEntry: (entry) => ipc('logs:append-entry', entry),
  },
  preferences: {
    get: (key) => ipc('preferences:get', key),
    set: (key, value) => ipc('preferences:set', key, value),
  },
  system: {
    listFonts: () => ipc('system:list-fonts'),
    readKnownHosts: () => ipc('system:read-known-hosts'),
    testProxy: (payload) => ipc('system:test-proxy', payload),
  },
  ai: {
    listModels: (request) => ipc('ai:list-models', request),
    chat: (request) => ipc('ai:chat', request),
    chatStream,
    webSearch: (request) => ipc('ai:web-search', request),
  },
  agentSessions: {
    get: () => ipc('agent-sessions:get'),
    save: (session) => ipc('agent-sessions:save', session),
    delete: (sessionId) => ipc('agent-sessions:delete', sessionId),
  },
  sync: {
    getConfig: () => ipc('sync:get-config'),
    saveConfig: (config) => ipc('sync:save-config', config),
    testWebDav: (config) => ipc('sync:test-webdav', config),
    runNow: (config) => ipc('sync:run-now', config),
  },
  connections: {
    connect: connectHost,
    openLocal: openLocalConnection,
    respondKeyboardInteractive: (payload) => ipc('connection:keyboard-interactive-response', payload),
    respondHostKeyVerification: (payload) => ipc('connection:host-key-response', payload),
    getInfo: (connectionId) => ipc('connection:get-info', connectionId),
    disconnect: (connectionId) => ipc('connection:disconnect', connectionId),
    getIpcCapabilities: () => ipc<ShellDeskIpcCapabilities>('connection:get-ipc-capabilities').catch(() => ({ terminalSessions: false })),
    trustBrowserCertificate: (partition, url) => ipc('connection:trust-browser-certificate', partition, url),
    resolveBrowserUrl: (connectionId, url) => ipc('connection:browser-resolve-url', connectionId, url),
    startTerminal: (connectionId, terminalId, columns, rows, options) => ipc('connection:start-terminal', connectionId, terminalId, columns, rows, options),
    writeTerminal: (connectionId, terminalId, data, options) => ipc('connection:write-terminal', connectionId, terminalId, data, options),
    writeTerminalBytes: (connectionId, terminalId, data) => ipc('connection:write-terminal-binary', connectionId, terminalId, data),
    resizeTerminal: (connectionId, terminalId, columns, rows, options) => ipc('connection:resize-terminal', connectionId, terminalId, columns, rows, options),
    closeTerminal: (connectionId, terminalId) => ipc<boolean>('connection:close-terminal', connectionId, terminalId).catch(() => false),
    listDirectory: (connectionId, remotePath, options) => ipc('connection:list-directory', connectionId, remotePath, options),
    createDirectory: (connectionId, remotePath, options) => ipc('connection:create-directory', connectionId, remotePath, options),
    deletePath: (connectionId, remotePath, entryType, options) => ipc('connection:delete-path', connectionId, remotePath, entryType, options),
    renamePath: (connectionId, oldPath, newPath, options) => ipc('connection:rename-path', connectionId, oldPath, newPath, options),
    createFile: (connectionId, remotePath, options) => ipc('connection:create-file', connectionId, remotePath, options),
    readFile: (connectionId, remotePath, options) => ipc('connection:read-file', connectionId, remotePath, options),
    writeFile: (connectionId, remotePath, content, options) => ipc('connection:write-file', connectionId, remotePath, content, options),
    downloadFile: (connectionId, remotePath, options) => ipc('connection:download-file', connectionId, remotePath, options),
    downloadPaths: (connectionId, remotePaths, options) => ipc('connection:download-paths', connectionId, remotePaths, options),
    selectUploadFiles: () => ipc('connection:select-upload-files'),
    selectUploadFolders: () => ipc('connection:select-upload-folders'),
    uploadFile: (connectionId, remotePath, options) => ipc('connection:upload-file', connectionId, remotePath, options),
    uploadFiles: (connectionId, remotePath, options) => ipc('connection:upload-files', connectionId, remotePath, options),
    uploadPaths: (connectionId, remotePath, options) => ipc('connection:upload-paths', connectionId, remotePath, options),
    uploadLocalPaths: (connectionId, remotePath, items, options) => ipc('connection:upload-local-paths', connectionId, remotePath, items, options),
    cancelTransfer: (connectionId, queueId) => ipc('connection:cancel-transfer', connectionId, queueId),
    checkSftp: (connectionId) => ipc('connection:check-sftp', connectionId),
    selectZmodemUploadFiles: () => ipc('connection:zmodem-select-upload-files'),
    readZmodemUploadFile: (fileId, offset, length) => ipc('connection:zmodem-read-upload-file', fileId, offset, length),
    releaseZmodemUploadFiles: (fileIds) => ipc('connection:zmodem-release-upload-files', fileIds),
    saveZmodemFile: (fileName, content) => ipc('connection:zmodem-save-file', fileName, content),
    compress: (connectionId, sourcePaths, format, destPath) => ipc('connection:compress', connectionId, sourcePaths, format, destPath),
    decompress: (connectionId, archivePath, destDir) => ipc('connection:decompress', connectionId, archivePath, destDir),
    statPath: (connectionId, remotePath, options) => ipc('connection:stat-path', connectionId, remotePath, options),
    setPathPermissions: (connectionId, remotePath, options) => ipc('connection:set-path-permissions', connectionId, remotePath, options),
    getStatus: (connectionId) => ipc('connection:get-status', connectionId),
    getSystemInfo: (connectionId) => ipc('connection:get-system-info', connectionId),
    getMetrics: (connectionId) => ipc('connection:get-metrics', connectionId),
    getMonitorPersistenceStatus: (connectionId) => ipc('connection:get-monitor-persistence-status', connectionId),
    setMonitorPersistenceEnabled: (connectionId, enabled) => ipc('connection:set-monitor-persistence-enabled', connectionId, enabled),
    getMonitorHistory: (connectionId, sinceMs, limit) => ipc('connection:get-monitor-history', connectionId, sinceMs, limit),
    setMonitorThresholds: (connectionId, thresholds) => ipc('connection:set-monitor-thresholds', connectionId, thresholds),
    runCommand: (connectionId, command, stdin, options) => ipc('connection:run-command', connectionId, command, stdin, options),
    runCommandStream,
    httpTunnelGet: (request) => ipc('connection:http-tunnel-get', request),
    httpTunnelPost: (request) => ipc('connection:http-tunnel-post', request),
    httpTunnelPut: (request) => ipc('connection:http-tunnel-put', request),
    httpTunnelDelete: (request) => ipc('connection:http-tunnel-delete', request),
    mysqlConnect: (connectionId, config) => ipc('connection:mysql-connect', connectionId, config),
    mysqlDisconnect: (connectionId, mysqlId) => ipc('connection:mysql-disconnect', connectionId, mysqlId),
    mysqlDatabases: (connectionId, mysqlId) => ipc('connection:mysql-databases', connectionId, mysqlId),
    mysqlTables: (connectionId, mysqlId, database) => ipc('connection:mysql-tables', connectionId, mysqlId, database),
    mysqlColumns: (connectionId, mysqlId, database, table) => ipc('connection:mysql-columns', connectionId, mysqlId, database, table),
    mysqlQuery: (connectionId, mysqlId, sql, database) => ipc('connection:mysql-query', connectionId, mysqlId, sql, database),
    mysqlUpdateCell: (connectionId, mysqlId, database, table, pkColumn, pkValue, column, newValue, pkColumns, pkValues) =>
      ipc('connection:mysql-update-cell', connectionId, mysqlId, database, table, pkColumn, pkValue, column, newValue, pkColumns, pkValues),
    clickhouseConnect: (connectionId, config) => ipc('connection:clickhouse-connect', connectionId, config),
    clickhouseDisconnect: (connectionId, clickhouseId) => ipc('connection:clickhouse-disconnect', connectionId, clickhouseId),
    clickhouseDatabases: (connectionId, clickhouseId) => ipc('connection:clickhouse-databases', connectionId, clickhouseId),
    clickhouseTables: (connectionId, clickhouseId, database) => ipc('connection:clickhouse-tables', connectionId, clickhouseId, database),
    clickhouseColumns: (connectionId, clickhouseId, database, table) => ipc('connection:clickhouse-columns', connectionId, clickhouseId, database, table),
    clickhouseQuery: (connectionId, clickhouseId, sql, database) => ipc('connection:clickhouse-query', connectionId, clickhouseId, sql, database),
    postgresConnect: (connectionId, config) => ipc('connection:postgres-connect', connectionId, config),
    postgresDisconnect: (connectionId, postgresId) => ipc('connection:postgres-disconnect', connectionId, postgresId),
    postgresDatabases: (connectionId, postgresId) => ipc('connection:postgres-databases', connectionId, postgresId),
    postgresSchemas: (connectionId, postgresId) => ipc('connection:postgres-schemas', connectionId, postgresId),
    postgresTables: (connectionId, postgresId, schema) => ipc('connection:postgres-tables', connectionId, postgresId, schema),
    postgresColumns: (connectionId, postgresId, schema, table) => ipc('connection:postgres-columns', connectionId, postgresId, schema, table),
    postgresQuery: (connectionId, postgresId, sql) => ipc('connection:postgres-query', connectionId, postgresId, sql),
    postgresUpdateCell: (connectionId, postgresId, schema, table, column, newValue, pkColumns, pkValues) =>
      ipc('connection:postgres-update-cell', connectionId, postgresId, schema, table, column, newValue, pkColumns, pkValues),
    mongoConnect: (connectionId, config) => ipc('connection:mongo-connect', connectionId, config),
    mongoDisconnect: (connectionId, mongoId) => ipc('connection:mongo-disconnect', connectionId, mongoId),
    mongoDatabases: (connectionId, mongoId) => ipc('connection:mongo-databases', connectionId, mongoId),
    mongoCollections: (connectionId, mongoId, database) => ipc('connection:mongo-collections', connectionId, mongoId, database),
    mongoIndexes: (connectionId, mongoId, database, collection) => ipc('connection:mongo-indexes', connectionId, mongoId, database, collection),
    mongoQuery: (connectionId, mongoId, request) => ipc('connection:mongo-query', connectionId, mongoId, request),
    redisConnect: (connectionId, config) => ipc('connection:redis-connect', connectionId, config),
    redisDisconnect: (connectionId, redisId) => ipc('connection:redis-disconnect', connectionId, redisId),
    redisScan: (connectionId, redisId, options) => ipc('connection:redis-scan', connectionId, redisId, options),
    redisKeys: (connectionId, redisId, pattern) => ipc('connection:redis-keys', connectionId, redisId, pattern),
    redisGetValue: (connectionId, redisId, key) => ipc('connection:redis-get-value', connectionId, redisId, key),
    redisSetValue: (connectionId, redisId, key, value, type) => ipc('connection:redis-set-value', connectionId, redisId, key, value, type),
    redisDeleteKey: (connectionId, redisId, key) => ipc('connection:redis-delete-key', connectionId, redisId, key),
    redisRemoveListItem: (connectionId, redisId, key, index) => ipc('connection:redis-remove-list-item', connectionId, redisId, key, index),
    redisCommand: (connectionId, redisId, command, args) => ipc('connection:redis-command', connectionId, redisId, command, args),
    vncProbe: (connectionId, config) => ipc('connection:vnc-probe', connectionId, config),
    vncStart: (connectionId, config) => ipc('connection:vnc-start', connectionId, config),
    vncStop: (connectionId, vncId) => ipc('connection:vnc-stop', connectionId, vncId),
    sqliteOpen: (connectionId, filePath, options) => ipc('connection:sqlite-open', connectionId, filePath, options),
    sqliteClose: (connectionId, sqliteId) => ipc('connection:sqlite-close', connectionId, sqliteId),
    sqliteTables: (connectionId, sqliteId, options) => ipc('connection:sqlite-tables', connectionId, sqliteId, options),
    sqliteObjects: (connectionId, sqliteId, options) => ipc('connection:sqlite-objects', connectionId, sqliteId, options),
    sqliteColumns: (connectionId, sqliteId, table, options) => ipc('connection:sqlite-columns', connectionId, sqliteId, table, options),
    sqliteSchema: (connectionId, sqliteId, objectType, objectName, options) => ipc('connection:sqlite-schema', connectionId, sqliteId, objectType, objectName, options),
    sqliteQuery: (connectionId, sqliteId, sql, options) => ipc('connection:sqlite-query', connectionId, sqliteId, sql, options),
    sqliteUpdateCell: (connectionId, sqliteId, table, column, newValue, target, options) =>
      ipc('connection:sqlite-update-cell', connectionId, sqliteId, table, column, newValue, target, options),
  },
  events: {
    onTerminalData: (callback) => onTauriEvent('terminal:data', callback),
    onTerminalExit: (callback) => onTauriEvent('terminal:exit', callback),
    onVncDiagnostic: (callback) => onTauriEvent('vnc:diagnostic', callback),
    onConnectionClosed: (callback) => onTauriEvent('connection:closed', callback),
    onConnectionReconnecting: (callback) => onTauriEvent('connection:reconnecting', callback),
    onConnectionRestored: (callback) => onTauriEvent('connection:restored', callback),
    onKeyboardInteractive: (callback) => onTauriEvent('connection:keyboard-interactive', callback),
    onHostKeyVerification: (callback) => onTauriEvent('connection:host-key-verification', callback),
    onHostKeyTrusted: (callback) => onTauriEvent('connection:host-key-trusted', callback),
    onDatabaseTunnelIdleTimeout: (callback) => onTauriEvent('database:tunnel-idle-timeout', callback),
    onWindowMaximizedChange: (callback) => onTauriEvent('window:maximize-state-changed', callback),
    onCloseToTrayPrompt: (callback) => onTauriEvent('window:close-to-tray-prompt', callback),
    onOpenAiSettings: (callback) => onTauriEvent('app:open-ai-settings', callback),
    onDesktopAppOpen: (callback) => onTauriEvent('desktop:open-app', callback),
    onLogsChanged: (callback) => onTauriEvent('logs:changed', callback),
    onVaultChanged: (callback) => onTauriEvent('vault:changed', callback),
    onSyncChanged: (callback) => onTauriEvent('sync:changed', callback),
    onTransferProgress: (callback) => onTauriEvent('transfer:progress', callback),
    onTransferEnd: (callback) => onTauriEvent('transfer:end', callback),
    onUpdateAvailable: (callback) => onTauriEvent('app:update:available', callback),
    onUpdateNotAvailable: (callback) => onTauriEvent('app:update:not-available', callback),
    onUpdateDownloadProgress: (callback) => onTauriEvent('app:update:download-progress', callback),
    onUpdateDownloaded: (callback) => onTauriEvent('app:update:downloaded', callback),
    onUpdateError: (callback) => onTauriEvent('app:update:error', callback),
  },
};
