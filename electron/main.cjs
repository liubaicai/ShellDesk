const { app, nativeTheme } = require('electron');
const { registerAiHandlers } = require('./main/aiHandlers.cjs');
const { registerAppHandlers } = require('./main/appHandlers.cjs');
const {
  registerAutoUpdateHandlers,
  startAutoUpdateCheck,
} = require('./main/autoUpdateHandlers.cjs');
const { registerConfigHandlers } = require('./main/configHandlers.cjs');
const { registerConnectionHandlers } = require('./main/connectionHandlers.cjs');
const { activeConnections, closeActiveConnection } = require('./main/connectionManager.cjs');
const { registerDatabaseHandlers } = require('./main/databaseHandlers.cjs');
const { registerIpcHandler } = require('./main/ipc.cjs');
const { registerRemoteConnectionHandlers } = require('./main/remoteConnectionHandlers.cjs');
const { registerSyncHandlers } = require('./main/syncHandlers.cjs');
const {
  createMainWindow,
  ensureAppTray,
  registerWebContentsGuards,
  registerWindowHandlers,
  showMainWindow,
} = require('./main/windows.cjs');
const { registerVncHandlers } = require('./main/vncHandlers.cjs');

const appUserModelId = 'com.shelldesk.app';

nativeTheme.themeSource = 'dark';

if (process.platform === 'win32') {
  app.setAppUserModelId(appUserModelId);
}

const singleInstanceLock = app.requestSingleInstanceLock();

if (!singleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });
}

registerWindowHandlers();
registerAppHandlers(registerIpcHandler);
registerAutoUpdateHandlers(registerIpcHandler);
registerConfigHandlers(registerIpcHandler);
registerAiHandlers(registerIpcHandler);
registerConnectionHandlers(registerIpcHandler);
registerRemoteConnectionHandlers(registerIpcHandler);
registerDatabaseHandlers(registerIpcHandler);
registerVncHandlers(registerIpcHandler);
registerSyncHandlers(registerIpcHandler);
registerWebContentsGuards();

if (singleInstanceLock) {
  app.whenReady().then(() => {
    createMainWindow();
    ensureAppTray();
    startAutoUpdateCheck(5000);

    app.on('activate', () => {
      showMainWindow();
    });
  });
}

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
