const { contextBridge, ipcRenderer } = require('electron');

function readInitialPublicVaultSnapshot() {
  try {
    const result = ipcRenderer.sendSync('vault:get-public-snapshot-sync');
    return result?.ok ? result.snapshot : null;
  } catch {
    return null;
  }
}

const initialPublicVaultSnapshot = readInitialPublicVaultSnapshot();
let initialPublicVaultSnapshotPromise = initialPublicVaultSnapshot
  ? Promise.resolve(initialPublicVaultSnapshot)
  : ipcRenderer.invoke('vault:get-public-snapshot');
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

function runCommandStream(connectionId, command, stdin, callbacks = {}) {
  const streamId = createIpcRequestId('command-stream');
  const removeChunkListener = onIpc('connection:run-command-stream:chunk', (payload) => {
    if (payload?.streamId === streamId && typeof payload.chunk === 'string') {
      callbacks.onChunk?.(payload.chunk, payload.stream === 'stderr' ? 'stderr' : 'stdout');
    }
  });

  return ipcRenderer.invoke('connection:run-command-stream', connectionId, command, stdin, streamId).finally(() => {
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
    saveEntries: (entries) => ipcRenderer.invoke('logs:save-entries', entries),
  },
  preferences: {
    get: (key) => ipcRenderer.invoke('preferences:get', key),
    set: (key, value) => ipcRenderer.invoke('preferences:set', key, value),
  },
  system: {
    listFonts: () => ipcRenderer.invoke('system:list-fonts'),
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
    getInfo: (connectionId) => ipcRenderer.invoke('connection:get-info', connectionId),
    disconnect: (connectionId) => ipcRenderer.invoke('connection:disconnect', connectionId),
    getIpcCapabilities: () => ipcRenderer.invoke('connection:get-ipc-capabilities').catch(() => ({ terminalSessions: false })),
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
    resizeTerminal: (connectionId, terminalId, columns, rows, options) => {
      if (options?.legacy) {
        return ipcRenderer.invoke('connection:resize-terminal', connectionId, columns, rows);
      }

      return ipcRenderer.invoke('connection:resize-terminal', connectionId, terminalId, columns, rows);
    },
    closeTerminal: (connectionId, terminalId) =>
      ipcRenderer.invoke('connection:close-terminal', connectionId, terminalId).catch(() => false),
    listDirectory: (connectionId, remotePath) => ipcRenderer.invoke('connection:list-directory', connectionId, remotePath),
    createDirectory: (connectionId, remotePath) => ipcRenderer.invoke('connection:create-directory', connectionId, remotePath),
    deletePath: (connectionId, remotePath, entryType) =>
      ipcRenderer.invoke('connection:delete-path', connectionId, remotePath, entryType),
    renamePath: (connectionId, oldPath, newPath) =>
      ipcRenderer.invoke('connection:rename-path', connectionId, oldPath, newPath),
    createFile: (connectionId, remotePath) => ipcRenderer.invoke('connection:create-file', connectionId, remotePath),
    readFile: (connectionId, remotePath) => ipcRenderer.invoke('connection:read-file', connectionId, remotePath),
    writeFile: (connectionId, remotePath, content) => ipcRenderer.invoke('connection:write-file', connectionId, remotePath, content),
    downloadFile: (connectionId, remotePath) => ipcRenderer.invoke('connection:download-file', connectionId, remotePath),
    uploadFile: (connectionId, remotePath) => ipcRenderer.invoke('connection:upload-file', connectionId, remotePath),
    cancelTransfer: (connectionId) => ipcRenderer.invoke('connection:cancel-transfer', connectionId),
    compress: (connectionId, sourcePaths, format, destPath) => ipcRenderer.invoke('connection:compress', connectionId, sourcePaths, format, destPath),
    decompress: (connectionId, archivePath, destDir) => ipcRenderer.invoke('connection:decompress', connectionId, archivePath, destDir),
    statPath: (connectionId, remotePath) => ipcRenderer.invoke('connection:stat-path', connectionId, remotePath),
    setPathPermissions: (connectionId, remotePath, options) =>
      ipcRenderer.invoke('connection:set-path-permissions', connectionId, remotePath, options),
    getStatus: (connectionId) => ipcRenderer.invoke('connection:get-status', connectionId),
    getSystemInfo: (connectionId) => ipcRenderer.invoke('connection:get-system-info', connectionId),
    getMetrics: (connectionId) => ipcRenderer.invoke('connection:get-metrics', connectionId),
    runCommand: (connectionId, command, stdin) => ipcRenderer.invoke('connection:run-command', connectionId, command, stdin),
    runCommandStream,
    mysqlConnect: (connectionId, config) => ipcRenderer.invoke('connection:mysql-connect', connectionId, config),
    mysqlDisconnect: (connectionId, mysqlId) => ipcRenderer.invoke('connection:mysql-disconnect', connectionId, mysqlId),
    mysqlDatabases: (connectionId, mysqlId) => ipcRenderer.invoke('connection:mysql-databases', connectionId, mysqlId),
    mysqlTables: (connectionId, mysqlId, database) => ipcRenderer.invoke('connection:mysql-tables', connectionId, mysqlId, database),
    mysqlColumns: (connectionId, mysqlId, database, table) => ipcRenderer.invoke('connection:mysql-columns', connectionId, mysqlId, database, table),
    mysqlQuery: (connectionId, mysqlId, sql, database) => ipcRenderer.invoke('connection:mysql-query', connectionId, mysqlId, sql, database),
    mysqlUpdateCell: (connectionId, mysqlId, database, table, pkColumn, pkValue, column, newValue, pkColumns, pkValues) =>
      ipcRenderer.invoke('connection:mysql-update-cell', connectionId, mysqlId, database, table, pkColumn, pkValue, column, newValue, pkColumns, pkValues),
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
    sqliteOpen: (connectionId, filePath) => ipcRenderer.invoke('connection:sqlite-open', connectionId, filePath),
    sqliteClose: (connectionId, sqliteId) => ipcRenderer.invoke('connection:sqlite-close', connectionId, sqliteId),
    sqliteTables: (connectionId, sqliteId) => ipcRenderer.invoke('connection:sqlite-tables', connectionId, sqliteId),
    sqliteObjects: (connectionId, sqliteId) => ipcRenderer.invoke('connection:sqlite-objects', connectionId, sqliteId),
    sqliteColumns: (connectionId, sqliteId, table) => ipcRenderer.invoke('connection:sqlite-columns', connectionId, sqliteId, table),
    sqliteSchema: (connectionId, sqliteId, objectType, objectName) => ipcRenderer.invoke('connection:sqlite-schema', connectionId, sqliteId, objectType, objectName),
    sqliteQuery: (connectionId, sqliteId, sql) => ipcRenderer.invoke('connection:sqlite-query', connectionId, sqliteId, sql),
    sqliteUpdateCell: (connectionId, sqliteId, table, column, newValue, target) =>
      ipcRenderer.invoke('connection:sqlite-update-cell', connectionId, sqliteId, table, column, newValue, target),
  },
  events: {
    onTerminalData: (callback) => onIpc('terminal:data', callback),
    onTerminalExit: (callback) => onIpc('terminal:exit', callback),
    onVncDiagnostic: (callback) => onIpc('vnc:diagnostic', callback),
    onConnectionClosed: (callback) => onIpc('connection:closed', callback),
    onWindowMaximizedChange: (callback) => onIpc('window:maximize-state-changed', callback),
    onVaultChanged: (callback) => onIpc('vault:changed', callback),
    onTransferProgress: (callback) => onIpc('transfer:progress', callback),
    onTransferEnd: (callback) => onIpc('transfer:end', callback),
  },
});
