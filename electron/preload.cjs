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
  },
  connections: {
    connect: connectHost,
    disconnect: (connectionId) => ipcRenderer.invoke('connection:disconnect', connectionId),
    startTerminal: (connectionId) => ipcRenderer.invoke('connection:start-terminal', connectionId),
    writeTerminal: (connectionId, data) => ipcRenderer.invoke('connection:write-terminal', connectionId, data),
    resizeTerminal: (connectionId, columns, rows) =>
      ipcRenderer.invoke('connection:resize-terminal', connectionId, columns, rows),
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
  },
});
