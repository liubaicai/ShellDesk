const { contextBridge, ipcRenderer } = require('electron');

const initialPublicVaultSnapshot = null;
let initialPublicVaultSnapshotPromise = ipcRenderer.invoke('vault:get-public-snapshot');
let shouldUseInitialPublicVaultSnapshot = true;

initialPublicVaultSnapshotPromise.catch(() => undefined);

function onIpc(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

function createIpcRequestId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function chatStream(request, callbacks = {}) {
  const streamId = createIpcRequestId('ai-stream');
  const removeChunkListener = onIpc('ai:chat-stream:chunk', (payload) => {
    if (payload?.streamId === streamId && typeof payload.chunk === 'string') {
      callbacks.onChunk?.(payload.chunk);
    }
  });

  return ipcRenderer.invoke('ai:chat-stream', { ...request, streamId }).finally(() => {
    removeChunkListener();
  });
}

function runCommandStream(connectionId, command, stdin, callbacks = {}, options) {
  const streamId = createIpcRequestId('command-stream');
  const removeChunkListener = onIpc('connection:run-command-stream:chunk', (payload) => {
    if (payload?.streamId === streamId && typeof payload.chunk === 'string') {
      callbacks.onChunk?.(payload.chunk, payload.stream === 'stderr' ? 'stderr' : 'stdout');
    }
  });

  return ipcRenderer.invoke('connection:run-command-stream', connectionId, command, stdin, streamId, options).finally(() => {
    removeChunkListener();
  });
}

async function connectHost(host) {
  const result = await ipcRenderer.invoke('connection:connect', host);

  if (!result?.ok) {
    throw new Error(result?.error || 'SSH 连接失败。');
  }

  return result.connection;
}

async function openLocalConnection() {
  const result = await ipcRenderer.invoke('connection:open-local');

  if (!result?.ok) {
    throw new Error(result?.error || '打开本地模式失败。');
  }

  return result.connection;
}

function getVaultSnapshot() {
  return ipcRenderer.invoke('vault:get-snapshot');
}

function getPublicVaultSnapshot() {
  if (shouldUseInitialPublicVaultSnapshot) {
    return initialPublicVaultSnapshotPromise.finally(() => {
      shouldUseInitialPublicVaultSnapshot = false;
    });
  }

  return ipcRenderer.invoke('vault:get-public-snapshot');
}

contextBridge.exposeInMainWorld('guiSSH', {
  appName: 'ShellDesk',
  platform: process.platform,
  app: {
    getInfo: () => ipcRenderer.invoke('app:get-info'),
    checkForUpdates: () => ipcRenderer.invoke('app:check-for-updates'),
    checkForUpdateDownload: () => ipcRenderer.invoke('app:check-for-update-download'),
    downloadUpdate: () => ipcRenderer.invoke('app:download-update'),
    installUpdate: () => ipcRenderer.invoke('app:install-update'),
    getUpdateStatus: () => ipcRenderer.invoke('app:get-update-status'),
    openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  },
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    close: () => ipcRenderer.invoke('window:close'),
  },
  files: {
    selectPrivateKeyFile: () => ipcRenderer.invoke('dialog:select-private-key'),
    selectPublicKeyFile: () => ipcRenderer.invoke('dialog:select-public-key'),
    importConfig: () => ipcRenderer.invoke('config:import'),
    exportConfig: () => ipcRenderer.invoke('config:export'),
    saveTextFile: (payload) => ipcRenderer.invoke('dialog:save-text-file', payload),
  },
  vault: {
    initialPublicSnapshot: initialPublicVaultSnapshot,
    getPublicSnapshot: getPublicVaultSnapshot,
    getSnapshot: getVaultSnapshot,
    saveCollections: (payload) => ipcRenderer.invoke('vault:save-collections', payload),
    importKeyPair: (payload) => ipcRenderer.invoke('vault:import-key-pair', payload),
    generateRsaKeyPair: (payload) => ipcRenderer.invoke('vault:generate-rsa-key-pair', payload),
    getBookmarks: (scope) => ipcRenderer.invoke('vault:get-bookmarks', scope),
    saveBookmarks: (scope, bookmarks) => ipcRenderer.invoke('vault:save-bookmarks', scope, bookmarks),
  },
  logs: {
    getEntries: () => ipcRenderer.invoke('logs:get-entries'),
    clearEntries: () => ipcRenderer.invoke('logs:clear-entries'),
    saveEntries: (entries) => ipcRenderer.invoke('logs:save-entries', entries),
    appendEntry: (entry) => ipcRenderer.invoke('logs:append-entry', entry),
  },
  preferences: {
    get: (key) => ipcRenderer.invoke('preferences:get', key),
    set: (key, value) => ipcRenderer.invoke('preferences:set', key, value),
  },
  system: {
    listFonts: () => ipcRenderer.invoke('system:list-fonts'),
    readKnownHosts: () => ipcRenderer.invoke('system:read-known-hosts'),
    testProxy: (payload) => ipcRenderer.invoke('system:test-proxy', payload),
  },
  ai: {
    listModels: (request) => ipcRenderer.invoke('ai:list-models', request),
    chat: (request) => ipcRenderer.invoke('ai:chat', request),
    chatStream,
  },
  sync: {
    getConfig: () => ipcRenderer.invoke('sync:get-config'),
    saveConfig: (config) => ipcRenderer.invoke('sync:save-config', config),
    testWebDav: (config) => ipcRenderer.invoke('sync:test-webdav', config),
    runNow: (config) => ipcRenderer.invoke('sync:run-now', config),
  },
  connections: {
    connect: connectHost,
    openLocal: openLocalConnection,
    respondKeyboardInteractive: (payload) => ipcRenderer.invoke('connection:keyboard-interactive-response', payload),
    respondHostKeyVerification: (payload) => ipcRenderer.invoke('connection:host-key-response', payload),
    getInfo: (connectionId) => ipcRenderer.invoke('connection:get-info', connectionId),
    disconnect: (connectionId) => ipcRenderer.invoke('connection:disconnect', connectionId),
    getIpcCapabilities: () => ipcRenderer.invoke('connection:get-ipc-capabilities').catch(() => ({ terminalSessions: false })),
    trustBrowserCertificate: (partition, url) => ipcRenderer.invoke('connection:trust-browser-certificate', partition, url),
    startTerminal: (connectionId, terminalId, columns, rows, options) => {
      if (options?.legacy) {
        return ipcRenderer.invoke('connection:start-terminal', connectionId);
      }

      return ipcRenderer.invoke('connection:start-terminal', connectionId, terminalId, columns, rows, options);
    },
    writeTerminal: (connectionId, terminalId, data, options) => {
      if (options?.legacy) {
        return ipcRenderer.invoke('connection:write-terminal', connectionId, data);
      }

      return ipcRenderer.invoke('connection:write-terminal', connectionId, terminalId, data);
    },
    writeTerminalBytes: (connectionId, terminalId, data) =>
      ipcRenderer.invoke('connection:write-terminal-binary', connectionId, terminalId, data),
    resizeTerminal: (connectionId, terminalId, columns, rows, options) => {
      if (options?.legacy) {
        return ipcRenderer.invoke('connection:resize-terminal', connectionId, columns, rows);
      }

      return ipcRenderer.invoke('connection:resize-terminal', connectionId, terminalId, columns, rows);
    },
    closeTerminal: (connectionId, terminalId) =>
      ipcRenderer.invoke('connection:close-terminal', connectionId, terminalId).catch(() => false),
    listDirectory: (connectionId, remotePath, options) => ipcRenderer.invoke('connection:list-directory', connectionId, remotePath, options),
    createDirectory: (connectionId, remotePath, options) => ipcRenderer.invoke('connection:create-directory', connectionId, remotePath, options),
    deletePath: (connectionId, remotePath, entryType, options) =>
      ipcRenderer.invoke('connection:delete-path', connectionId, remotePath, entryType, options),
    renamePath: (connectionId, oldPath, newPath, options) =>
      ipcRenderer.invoke('connection:rename-path', connectionId, oldPath, newPath, options),
    createFile: (connectionId, remotePath, options) => ipcRenderer.invoke('connection:create-file', connectionId, remotePath, options),
    readFile: (connectionId, remotePath, options) => ipcRenderer.invoke('connection:read-file', connectionId, remotePath, options),
    writeFile: (connectionId, remotePath, content, options) => ipcRenderer.invoke('connection:write-file', connectionId, remotePath, content, options),
    downloadFile: (connectionId, remotePath, options) => ipcRenderer.invoke('connection:download-file', connectionId, remotePath, options),
    downloadPaths: (connectionId, remotePaths, options) => ipcRenderer.invoke('connection:download-paths', connectionId, remotePaths, options),
    selectUploadFiles: () => ipcRenderer.invoke('connection:select-upload-files'),
    selectUploadFolders: () => ipcRenderer.invoke('connection:select-upload-folders'),
    uploadFile: (connectionId, remotePath, options) => ipcRenderer.invoke('connection:upload-file', connectionId, remotePath, options),
    uploadFiles: (connectionId, remotePath, options) => ipcRenderer.invoke('connection:upload-files', connectionId, remotePath, options),
    uploadPaths: (connectionId, remotePath, options) => ipcRenderer.invoke('connection:upload-paths', connectionId, remotePath, options),
    uploadLocalPaths: (connectionId, remotePath, items, options) => ipcRenderer.invoke('connection:upload-local-paths', connectionId, remotePath, items, options),
    cancelTransfer: (connectionId, queueId) => ipcRenderer.invoke('connection:cancel-transfer', connectionId, queueId),
    checkSftp: (connectionId) => ipcRenderer.invoke('connection:check-sftp', connectionId),
    selectZmodemUploadFiles: () => ipcRenderer.invoke('connection:zmodem-select-upload-files'),
    readZmodemUploadFile: (fileId, offset, length) =>
      ipcRenderer.invoke('connection:zmodem-read-upload-file', fileId, offset, length),
    releaseZmodemUploadFiles: (fileIds) => ipcRenderer.invoke('connection:zmodem-release-upload-files', fileIds),
    saveZmodemFile: (fileName, content) => ipcRenderer.invoke('connection:zmodem-save-file', fileName, content),
    compress: (connectionId, sourcePaths, format, destPath) => ipcRenderer.invoke('connection:compress', connectionId, sourcePaths, format, destPath),
    decompress: (connectionId, archivePath, destDir) => ipcRenderer.invoke('connection:decompress', connectionId, archivePath, destDir),
    statPath: (connectionId, remotePath, options) => ipcRenderer.invoke('connection:stat-path', connectionId, remotePath, options),
    setPathPermissions: (connectionId, remotePath, options) =>
      ipcRenderer.invoke('connection:set-path-permissions', connectionId, remotePath, options),
    getStatus: (connectionId) => ipcRenderer.invoke('connection:get-status', connectionId),
    getSystemInfo: (connectionId) => ipcRenderer.invoke('connection:get-system-info', connectionId),
    getMetrics: (connectionId) => ipcRenderer.invoke('connection:get-metrics', connectionId),
    runCommand: (connectionId, command, stdin, options) => ipcRenderer.invoke('connection:run-command', connectionId, command, stdin, options),
    runCommandStream,
    mysqlConnect: (connectionId, config) => ipcRenderer.invoke('connection:mysql-connect', connectionId, config),
    mysqlDisconnect: (connectionId, mysqlId) => ipcRenderer.invoke('connection:mysql-disconnect', connectionId, mysqlId),
    mysqlDatabases: (connectionId, mysqlId) => ipcRenderer.invoke('connection:mysql-databases', connectionId, mysqlId),
    mysqlTables: (connectionId, mysqlId, database) => ipcRenderer.invoke('connection:mysql-tables', connectionId, mysqlId, database),
    mysqlColumns: (connectionId, mysqlId, database, table) => ipcRenderer.invoke('connection:mysql-columns', connectionId, mysqlId, database, table),
    mysqlQuery: (connectionId, mysqlId, sql, database) => ipcRenderer.invoke('connection:mysql-query', connectionId, mysqlId, sql, database),
    mysqlUpdateCell: (connectionId, mysqlId, database, table, pkColumn, pkValue, column, newValue, pkColumns, pkValues) =>
      ipcRenderer.invoke('connection:mysql-update-cell', connectionId, mysqlId, database, table, pkColumn, pkValue, column, newValue, pkColumns, pkValues),
    clickhouseConnect: (connectionId, config) => ipcRenderer.invoke('connection:clickhouse-connect', connectionId, config),
    clickhouseDisconnect: (connectionId, clickhouseId) => ipcRenderer.invoke('connection:clickhouse-disconnect', connectionId, clickhouseId),
    clickhouseDatabases: (connectionId, clickhouseId) => ipcRenderer.invoke('connection:clickhouse-databases', connectionId, clickhouseId),
    clickhouseTables: (connectionId, clickhouseId, database) => ipcRenderer.invoke('connection:clickhouse-tables', connectionId, clickhouseId, database),
    clickhouseColumns: (connectionId, clickhouseId, database, table) => ipcRenderer.invoke('connection:clickhouse-columns', connectionId, clickhouseId, database, table),
    clickhouseQuery: (connectionId, clickhouseId, sql, database) => ipcRenderer.invoke('connection:clickhouse-query', connectionId, clickhouseId, sql, database),
    postgresConnect: (connectionId, config) => ipcRenderer.invoke('connection:postgres-connect', connectionId, config),
    postgresDisconnect: (connectionId, postgresId) => ipcRenderer.invoke('connection:postgres-disconnect', connectionId, postgresId),
    postgresDatabases: (connectionId, postgresId) => ipcRenderer.invoke('connection:postgres-databases', connectionId, postgresId),
    postgresSchemas: (connectionId, postgresId) => ipcRenderer.invoke('connection:postgres-schemas', connectionId, postgresId),
    postgresTables: (connectionId, postgresId, schema) => ipcRenderer.invoke('connection:postgres-tables', connectionId, postgresId, schema),
    postgresColumns: (connectionId, postgresId, schema, table) => ipcRenderer.invoke('connection:postgres-columns', connectionId, postgresId, schema, table),
    postgresQuery: (connectionId, postgresId, sql) => ipcRenderer.invoke('connection:postgres-query', connectionId, postgresId, sql),
    mongoConnect: (connectionId, config) => ipcRenderer.invoke('connection:mongo-connect', connectionId, config),
    mongoDisconnect: (connectionId, mongoId) => ipcRenderer.invoke('connection:mongo-disconnect', connectionId, mongoId),
    mongoDatabases: (connectionId, mongoId) => ipcRenderer.invoke('connection:mongo-databases', connectionId, mongoId),
    mongoCollections: (connectionId, mongoId, database) => ipcRenderer.invoke('connection:mongo-collections', connectionId, mongoId, database),
    mongoIndexes: (connectionId, mongoId, database, collection) => ipcRenderer.invoke('connection:mongo-indexes', connectionId, mongoId, database, collection),
    mongoQuery: (connectionId, mongoId, request) => ipcRenderer.invoke('connection:mongo-query', connectionId, mongoId, request),
    redisConnect: (connectionId, config) => ipcRenderer.invoke('connection:redis-connect', connectionId, config),
    redisDisconnect: (connectionId, redisId) => ipcRenderer.invoke('connection:redis-disconnect', connectionId, redisId),
    redisScan: (connectionId, redisId, options) => ipcRenderer.invoke('connection:redis-scan', connectionId, redisId, options),
    redisKeys: (connectionId, redisId, pattern) => ipcRenderer.invoke('connection:redis-keys', connectionId, redisId, pattern),
    redisGetValue: (connectionId, redisId, key) => ipcRenderer.invoke('connection:redis-get-value', connectionId, redisId, key),
    redisSetValue: (connectionId, redisId, key, value, type) => ipcRenderer.invoke('connection:redis-set-value', connectionId, redisId, key, value, type),
    redisDeleteKey: (connectionId, redisId, key) => ipcRenderer.invoke('connection:redis-delete-key', connectionId, redisId, key),
    redisCommand: (connectionId, redisId, command, args) => ipcRenderer.invoke('connection:redis-command', connectionId, redisId, command, args),
    vncProbe: (connectionId, config) => ipcRenderer.invoke('connection:vnc-probe', connectionId, config),
    vncStart: (connectionId, config) => ipcRenderer.invoke('connection:vnc-start', connectionId, config),
    vncStop: (connectionId, vncId) => ipcRenderer.invoke('connection:vnc-stop', connectionId, vncId),
    sqliteOpen: (connectionId, filePath, options) => ipcRenderer.invoke('connection:sqlite-open', connectionId, filePath, options),
    sqliteClose: (connectionId, sqliteId) => ipcRenderer.invoke('connection:sqlite-close', connectionId, sqliteId),
    sqliteTables: (connectionId, sqliteId, options) => ipcRenderer.invoke('connection:sqlite-tables', connectionId, sqliteId, options),
    sqliteObjects: (connectionId, sqliteId, options) => ipcRenderer.invoke('connection:sqlite-objects', connectionId, sqliteId, options),
    sqliteColumns: (connectionId, sqliteId, table, options) => ipcRenderer.invoke('connection:sqlite-columns', connectionId, sqliteId, table, options),
    sqliteSchema: (connectionId, sqliteId, objectType, objectName, options) =>
      ipcRenderer.invoke('connection:sqlite-schema', connectionId, sqliteId, objectType, objectName, options),
    sqliteQuery: (connectionId, sqliteId, sql, options) => ipcRenderer.invoke('connection:sqlite-query', connectionId, sqliteId, sql, options),
    sqliteUpdateCell: (connectionId, sqliteId, table, column, newValue, target, options) =>
      ipcRenderer.invoke('connection:sqlite-update-cell', connectionId, sqliteId, table, column, newValue, target, options),
  },
  events: {
    onTerminalData: (callback) => onIpc('terminal:data', callback),
    onTerminalExit: (callback) => onIpc('terminal:exit', callback),
    onVncDiagnostic: (callback) => onIpc('vnc:diagnostic', callback),
    onConnectionClosed: (callback) => onIpc('connection:closed', callback),
    onConnectionReconnecting: (callback) => onIpc('connection:reconnecting', callback),
    onConnectionRestored: (callback) => onIpc('connection:restored', callback),
    onKeyboardInteractive: (callback) => onIpc('connection:keyboard-interactive', callback),
    onHostKeyVerification: (callback) => onIpc('connection:host-key-verification', callback),
    onWindowMaximizedChange: (callback) => onIpc('window:maximize-state-changed', callback),
    onVaultChanged: (callback) => onIpc('vault:changed', callback),
    onSyncChanged: (callback) => onIpc('sync:changed', callback),
    onTransferProgress: (callback) => onIpc('transfer:progress', callback),
    onTransferEnd: (callback) => onIpc('transfer:end', callback),
    onUpdateAvailable: (callback) => onIpc('app:update:available', callback),
    onUpdateNotAvailable: (callback) => onIpc('app:update:not-available', callback),
    onUpdateDownloadProgress: (callback) => onIpc('app:update:download-progress', callback),
    onUpdateDownloaded: (callback) => onIpc('app:update:downloaded', callback),
    onUpdateError: (callback) => onIpc('app:update:error', callback),
  },
});
