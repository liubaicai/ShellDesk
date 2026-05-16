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
  appName: 'GUI-SSH',
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
    getStatus: (connectionId) => ipcRenderer.invoke('connection:get-status', connectionId),
  },
  events: {
    onTerminalData: (callback) => onIpc('terminal:data', callback),
    onTerminalExit: (callback) => onIpc('terminal:exit', callback),
    onConnectionClosed: (callback) => onIpc('connection:closed', callback),
    onVaultChanged: (callback) => onIpc('vault:changed', callback),
  },
});
