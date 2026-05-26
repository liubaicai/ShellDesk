const { app, BrowserWindow, nativeTheme } = require('electron');
const { registerAiHandlers } = require('./main/aiHandlers.cjs');
const { registerConfigHandlers } = require('./main/configHandlers.cjs');
const { registerConnectionHandlers } = require('./main/connectionHandlers.cjs');
const { activeConnections, closeActiveConnection } = require('./main/connectionManager.cjs');
const { registerDatabaseHandlers } = require('./main/databaseHandlers.cjs');
const { registerIpcHandler } = require('./main/ipc.cjs');
const { registerRemoteConnectionHandlers } = require('./main/remoteConnectionHandlers.cjs');
const {
  createMainWindow,
  registerWebContentsGuards,
  registerWindowHandlers,
} = require('./main/windows.cjs');
const { registerVncHandlers } = require('./main/vncHandlers.cjs');

const appUserModelId = 'com.shelldesk.app';

nativeTheme.themeSource = 'dark';

if (process.platform === 'win32') {
  app.setAppUserModelId(appUserModelId);
}

registerWindowHandlers();
registerConfigHandlers(registerIpcHandler);
registerAiHandlers(registerIpcHandler);
registerConnectionHandlers(registerIpcHandler);
registerRemoteConnectionHandlers(registerIpcHandler);
registerDatabaseHandlers(registerIpcHandler);
registerVncHandlers(registerIpcHandler);
registerWebContentsGuards();

app.whenReady().then(() => {
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  for (const connectionId of activeConnections.keys()) {
    void closeActiveConnection(connectionId, '应用退出。');
  }
});
