const { app, BrowserWindow, ipcMain, Menu, shell, Tray } = require('electron');
const path = require('node:path');
const { activeConnections, closeActiveConnection } = require('./connectionManager.cjs');
const { getVault } = require('./vaultStore.cjs');

const devServerUrl = process.env.VITE_DEV_SERVER_URL;
const appIconPath = app.isPackaged
  ? path.join(process.resourcesPath, 'app-icon.png')
  : path.join(__dirname, '..', '..', 'src', 'assets', 'images', 'icon.png');
let mainWindow = null;
let appTray = null;
let isAppQuitting = false;

app.on('before-quit', () => {
  isAppQuitting = true;
});

function getCurrentSettings() {
  try {
    return getVault().settings ?? {};
  } catch {
    return {};
  }
}

function shouldMinimizeMainWindowToTray() {
  return getCurrentSettings().minimizeToTrayOnClose !== false;
}

function getTrayExitLabel() {
  return getCurrentSettings().language === 'zh-CN' ? '退出' : 'Exit';
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: getTrayExitLabel(),
      click: () => {
        isAppQuitting = true;
        app.quit();
      },
    },
  ]);
}

function isTrayUsable(tray) {
  return Boolean(tray) && (
    typeof tray.isDestroyed !== 'function' ||
    !tray.isDestroyed()
  );
}

function ensureAppTray() {
  if (isTrayUsable(appTray)) {
    appTray.setContextMenu(buildTrayMenu());
    return appTray;
  }

  appTray = new Tray(appIconPath);
  appTray.setToolTip('ShellDesk');
  appTray.setContextMenu(buildTrayMenu());
  appTray.on('click', () => {
    showMainWindow();
  });

  return appTray;
}

function isSafeNavigation(targetUrl) {
  if (!targetUrl) {
    return false;
  }

  if (devServerUrl && targetUrl.startsWith(devServerUrl)) {
    return true;
  }

  return targetUrl.startsWith('file://');
}

function getSenderWindow(event) {
  return BrowserWindow.fromWebContents(event.sender);
}

function configureAppWindow(appWindow, options = {}) {
  const { role = 'connection' } = options;
  const sendMaximizeState = () => {
    if (appWindow.isDestroyed() || appWindow.webContents.isDestroyed()) {
      return;
    }

    appWindow.webContents.send('window:maximize-state-changed', { maximized: appWindow.isMaximized() });
  };

  appWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url);
    }

    return { action: 'deny' };
  });

  appWindow.webContents.on('will-navigate', (event, url) => {
    if (!isSafeNavigation(url)) {
      event.preventDefault();
    }
  });

  appWindow.on('maximize', sendMaximizeState);
  appWindow.on('unmaximize', sendMaximizeState);

  if (role === 'main') {
    appWindow.on('close', (event) => {
      if (isAppQuitting || !shouldMinimizeMainWindowToTray()) {
        return;
      }

      event.preventDefault();
      ensureAppTray();
      appWindow.hide();
    });

    appWindow.on('closed', () => {
      if (mainWindow === appWindow) {
        mainWindow = null;
      }
    });
  }
}

function loadAppWindow(appWindow, query = {}) {
  if (devServerUrl) {
    const appUrl = new URL(devServerUrl);

    for (const [key, value] of Object.entries(query)) {
      appUrl.searchParams.set(key, value);
    }

    void appWindow.loadURL(appUrl.toString());
    appWindow.webContents.openDevTools();
  } else {
    void appWindow.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'), { query });
  }
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow;
  }

  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 940,
    minHeight: 620,
    show: false,
    title: 'ShellDesk',
    icon: appIconPath,
    backgroundColor: '#0b1017',
    autoHideMenuBar: true,
    frame: process.platform === 'darwin',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 16, y: 15 },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  configureAppWindow(mainWindow, { role: 'main' });
  loadAppWindow(mainWindow);
  ensureAppTray();
  return mainWindow;
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
}

function createConnectionWindow(activeConnection) {
  const connectionTitle = `${activeConnection.displayHost.username}@${activeConnection.displayHost.address}:${activeConnection.displayHost.port}`;
  const connectionWindow = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: `ShellDesk - ${connectionTitle} - SOCKS :${activeConnection.proxyPort}`,
    icon: appIconPath,
    backgroundColor: '#0b1017',
    autoHideMenuBar: true,
    frame: process.platform === 'darwin',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 16, y: 15 },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: true,
    },
  });

  activeConnection.window = connectionWindow;
  connectionWindow.once('ready-to-show', () => {
    connectionWindow.show();
  });
  connectionWindow.on('closed', () => {
    const currentConnection = activeConnections.get(activeConnection.id);

    if (currentConnection?.window === connectionWindow) {
      void closeActiveConnection(activeConnection.id, '连接窗口已关闭。');
    }
  });
  configureAppWindow(connectionWindow);
  loadAppWindow(connectionWindow, { connectionId: activeConnection.id });
}

function registerWindowHandlers() {
  ipcMain.handle('window:minimize', (event) => {
    getSenderWindow(event)?.minimize();
  });

  ipcMain.handle('window:toggle-maximize', (event) => {
    const window = getSenderWindow(event);

    if (!window) {
      return false;
    }

    if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }

    return window.isMaximized();
  });

  ipcMain.handle('window:is-maximized', (event) => {
    return Boolean(getSenderWindow(event)?.isMaximized());
  });

  ipcMain.handle('window:close', (event) => {
    getSenderWindow(event)?.close();
  });
}

function registerWebContentsGuards() {
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview') {
      return;
    }

    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, url) => {
      if (!url.startsWith('http://') && !url.startsWith('https://') && url !== 'about:blank') {
        event.preventDefault();
      }
    });
  });
}

module.exports = {
  createConnectionWindow,
  createMainWindow,
  ensureAppTray,
  getSenderWindow,
  registerWebContentsGuards,
  registerWindowHandlers,
  showMainWindow,
};
