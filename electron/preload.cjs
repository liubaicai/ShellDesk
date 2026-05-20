const { contextBridge, ipcRenderer } = require('electron');

function onIpc(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

async function connectHost(host) {
  const result = await ipcRenderer.invoke('connection:connect', host);

  if (!result?.ok) {
    throw new Error(result?.error || 'SSH 连接失败。');
  }

  return result.connection;
}

contextBridge.exposeInMainWorld('guiSSH', {
  appName: 'ShellDesk',
  platform: process.platform,
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    close: () => ipcRenderer.invoke('window:close'),
  },
  files: {
    selectPrivateKeyFile: () => ipcRenderer.invoke('dialog:select-private-key'),
    selectPublicKeyFile: () => ipcRenderer.invoke('dialog:select-public-key'),
    importConfig: () => ipcRenderer.invoke('config:import'),
    exportConfig: () => ipcRenderer.invoke('config:export'),
  },
  vault: {
    getSnapshot: () => ipcRenderer.invoke('vault:get-snapshot'),
    saveCollections: (payload) => ipcRenderer.invoke('vault:save-collections', payload),
    migrateLegacyData: (payload) => ipcRenderer.invoke('vault:migrate-legacy-data', payload),
    importKeyPair: (payload) => ipcRenderer.invoke('vault:import-key-pair', payload),
    generateRsaKeyPair: (payload) => ipcRenderer.invoke('vault:generate-rsa-key-pair', payload),
    getBookmarks: (scope) => ipcRenderer.invoke('vault:get-bookmarks', scope),
    saveBookmarks: (scope, bookmarks) => ipcRenderer.invoke('vault:save-bookmarks', scope, bookmarks),
  },
  logs: {
    getEntries: () => ipcRenderer.invoke('logs:get-entries'),
    saveEntries: (entries) => ipcRenderer.invoke('logs:save-entries', entries),
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

      return ipcRenderer.invoke('connection:start-terminal', connectionId, terminalId, columns, rows);
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
    getStatus: (connectionId) => ipcRenderer.invoke('connection:get-status', connectionId),
    runCommand: (connectionId, command) => ipcRenderer.invoke('connection:run-command', connectionId, command),
    mysqlConnect: (connectionId, config) => ipcRenderer.invoke('connection:mysql-connect', connectionId, config),
    mysqlDisconnect: (connectionId, mysqlId) => ipcRenderer.invoke('connection:mysql-disconnect', connectionId, mysqlId),
    mysqlDatabases: (connectionId, mysqlId) => ipcRenderer.invoke('connection:mysql-databases', connectionId, mysqlId),
    mysqlTables: (connectionId, mysqlId, database) => ipcRenderer.invoke('connection:mysql-tables', connectionId, mysqlId, database),
    mysqlColumns: (connectionId, mysqlId, database, table) => ipcRenderer.invoke('connection:mysql-columns', connectionId, mysqlId, database, table),
    mysqlQuery: (connectionId, mysqlId, sql, database) => ipcRenderer.invoke('connection:mysql-query', connectionId, mysqlId, sql, database),
    mysqlUpdateCell: (connectionId, mysqlId, database, table, pkColumn, pkValue, column, newValue, pkColumns, pkValues) =>
      ipcRenderer.invoke('connection:mysql-update-cell', connectionId, mysqlId, database, table, pkColumn, pkValue, column, newValue, pkColumns, pkValues),
    redisConnect: (connectionId, config) => ipcRenderer.invoke('connection:redis-connect', connectionId, config),
    redisDisconnect: (connectionId, redisId) => ipcRenderer.invoke('connection:redis-disconnect', connectionId, redisId),
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
    sqliteColumns: (connectionId, sqliteId, table) => ipcRenderer.invoke('connection:sqlite-columns', connectionId, sqliteId, table),
    sqliteQuery: (connectionId, sqliteId, sql) => ipcRenderer.invoke('connection:sqlite-query', connectionId, sqliteId, sql),
  },
  events: {
    onTerminalData: (callback) => onIpc('terminal:data', callback),
    onTerminalExit: (callback) => onIpc('terminal:exit', callback),
    onVncDiagnostic: (callback) => onIpc('vnc:diagnostic', callback),
    onConnectionClosed: (callback) => onIpc('connection:closed', callback),
    onVaultChanged: (callback) => onIpc('vault:changed', callback),
    onTransferProgress: (callback) => onIpc('transfer:progress', callback),
    onTransferEnd: (callback) => onIpc('transfer:end', callback),
  },
});
