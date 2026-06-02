const { app, BrowserWindow } = require('electron');
const { toErrorMessage } = require('./validation.cjs');

const updateChannels = {
  available: 'app:update:available',
  notAvailable: 'app:update:not-available',
  progress: 'app:update:download-progress',
  downloaded: 'app:update:downloaded',
  error: 'app:update:error',
};

let autoUpdater = null;
let listenersRegistered = false;
let autoUpdateTimer = null;
let isChecking = false;
let isDownloading = false;

let lastStatus = {
  status: 'idle',
  percent: 0,
  error: null,
  version: null,
  releaseNotes: '',
  releaseDate: null,
  isChecking: false,
  checkedAt: null,
};

function normalizeVersion(value) {
  return String(value ?? '').trim().replace(/^v/i, '').replace(/\+.*/, '');
}

function isVersionNewer(version, currentVersion) {
  const latest = normalizeVersion(version);
  const current = normalizeVersion(currentVersion);

  if (!latest) {
    return false;
  }

  return current.localeCompare(latest, undefined, { numeric: true, sensitivity: 'base' }) < 0;
}

function getUnsupportedReason() {
  if (!app.isPackaged) {
    return '开发环境不支持自动下载更新，打包后可使用自动更新。';
  }

  if (process.platform === 'linux' && !process.env.APPIMAGE) {
    return '当前 Linux 安装包格式不支持自动更新，请打开 Release 手动下载。';
  }

  return '当前平台不支持自动更新，请打开 Release 手动下载。';
}

function isAutoUpdateSupported() {
  if (!app.isPackaged) {
    return false;
  }

  if (process.platform === 'darwin' || process.platform === 'win32') {
    return true;
  }

  return process.platform === 'linux' && Boolean(process.env.APPIMAGE);
}

function getStatusSnapshot() {
  return {
    ...lastStatus,
    isChecking,
    supported: isAutoUpdateSupported(),
    unsupportedReason: isAutoUpdateSupported() ? '' : getUnsupportedReason(),
  };
}

function setLastStatus(patch) {
  lastStatus = {
    ...lastStatus,
    ...patch,
  };
  return getStatusSnapshot();
}

function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

function getAutoUpdater() {
  if (autoUpdater) {
    return autoUpdater;
  }

  try {
    const { autoUpdater: resolvedAutoUpdater } = require('electron-updater');
    resolvedAutoUpdater.autoDownload = true;
    resolvedAutoUpdater.autoInstallOnAppQuit = false;
    resolvedAutoUpdater.logger = null;
    autoUpdater = resolvedAutoUpdater;
    setupAutoUpdateListeners();
    return autoUpdater;
  } catch (error) {
    console.error('[AutoUpdate] Failed to load electron-updater:', toErrorMessage(error));
    return null;
  }
}

function setupAutoUpdateListeners() {
  if (listenersRegistered || !autoUpdater) {
    return;
  }

  listenersRegistered = true;

  autoUpdater.on('update-not-available', () => {
    isChecking = false;
    isDownloading = false;
    const status = setLastStatus({
      status: 'idle',
      percent: 0,
      error: null,
      version: null,
      releaseNotes: '',
      releaseDate: null,
      isChecking: false,
      checkedAt: new Date().toISOString(),
    });
    broadcast(updateChannels.notAvailable, status);
  });

  autoUpdater.on('update-available', (info = {}) => {
    isChecking = false;
    isDownloading = autoUpdater.autoDownload !== false;
    const status = setLastStatus({
      status: isDownloading ? 'downloading' : 'available',
      percent: 0,
      error: null,
      version: info.version || null,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : '',
      releaseDate: info.releaseDate || null,
      isChecking: false,
      checkedAt: new Date().toISOString(),
    });
    broadcast(updateChannels.available, status);
  });

  autoUpdater.on('download-progress', (info = {}) => {
    const percent = Math.max(0, Math.min(100, Math.round(Number(info.percent) || 0)));
    const status = setLastStatus({
      status: 'downloading',
      percent,
      error: null,
    });
    broadcast(updateChannels.progress, {
      ...status,
      bytesPerSecond: Number(info.bytesPerSecond) || 0,
      transferred: Number(info.transferred) || 0,
      total: Number(info.total) || 0,
    });
  });

  autoUpdater.on('update-downloaded', (info = {}) => {
    isChecking = false;
    isDownloading = false;
    const status = setLastStatus({
      status: 'ready',
      percent: 100,
      error: null,
      version: info.version || lastStatus.version,
      releaseDate: info.releaseDate || lastStatus.releaseDate,
      isChecking: false,
      checkedAt: new Date().toISOString(),
    });
    broadcast(updateChannels.downloaded, status);
  });

  autoUpdater.on('error', (error) => {
    const errorMessage = toErrorMessage(error) || '更新失败。';
    isChecking = false;

    if (!isDownloading) {
      setLastStatus({ isChecking: false });
      console.warn('[AutoUpdate] Check failed:', errorMessage);
      return;
    }

    isDownloading = false;
    const status = setLastStatus({
      status: 'error',
      percent: 0,
      error: errorMessage,
      isChecking: false,
    });
    broadcast(updateChannels.error, status);
  });
}

function cancelAutoUpdateCheck() {
  if (autoUpdateTimer) {
    clearTimeout(autoUpdateTimer);
    autoUpdateTimer = null;
  }
}

async function checkForUpdateDownload(options = {}) {
  const automatic = Boolean(options.automatic);

  if (!automatic) {
    cancelAutoUpdateCheck();
  }

  if (!isAutoUpdateSupported()) {
    return {
      available: false,
      supported: false,
      error: getUnsupportedReason(),
    };
  }

  const updater = getAutoUpdater();

  if (!updater) {
    return {
      available: false,
      supported: false,
      error: '更新模块加载失败。',
    };
  }

  if (isChecking) {
    return { available: false, supported: true, checking: true };
  }

  if (isDownloading) {
    return { available: true, supported: true, downloading: true, version: lastStatus.version };
  }

  if (lastStatus.status === 'ready') {
    return { available: true, supported: true, ready: true, version: lastStatus.version };
  }

  try {
    isChecking = true;
    setLastStatus({ isChecking: true, error: null });
    const result = await updater.checkForUpdates();
    const updateInfo = result?.updateInfo;

    if (!updateInfo || !isVersionNewer(updateInfo.version, app.getVersion())) {
      isChecking = false;
      setLastStatus({ isChecking: false, checkedAt: new Date().toISOString() });
      return { available: false, supported: true };
    }

    isChecking = false;
    setLastStatus({
      version: updateInfo.version || lastStatus.version,
      releaseNotes: typeof updateInfo.releaseNotes === 'string' ? updateInfo.releaseNotes : lastStatus.releaseNotes,
      releaseDate: updateInfo.releaseDate || lastStatus.releaseDate,
      isChecking: false,
      checkedAt: new Date().toISOString(),
    });

    return {
      available: true,
      supported: true,
      version: updateInfo.version,
      releaseNotes: typeof updateInfo.releaseNotes === 'string' ? updateInfo.releaseNotes : '',
      releaseDate: updateInfo.releaseDate || null,
    };
  } catch (error) {
    const errorMessage = toErrorMessage(error);
    isChecking = false;
    setLastStatus({
      status: automatic ? lastStatus.status : 'error',
      error: automatic ? lastStatus.error : errorMessage,
      isChecking: false,
      checkedAt: new Date().toISOString(),
    });

    if (!automatic) {
      broadcast(updateChannels.error, getStatusSnapshot());
    }

    return {
      available: false,
      supported: true,
      error: errorMessage,
    };
  }
}

function startAutoUpdateCheck(delayMs = 5000) {
  if (!isAutoUpdateSupported()) {
    return;
  }

  cancelAutoUpdateCheck();
  autoUpdateTimer = setTimeout(() => {
    autoUpdateTimer = null;
    void checkForUpdateDownload({ automatic: true });
  }, delayMs);
}

async function downloadUpdate() {
  if (!isAutoUpdateSupported()) {
    return { success: false, error: getUnsupportedReason() };
  }

  if (isDownloading) {
    return { success: true };
  }

  const updater = getAutoUpdater();

  if (!updater) {
    return { success: false, error: '更新模块加载失败。' };
  }

  try {
    isDownloading = true;
    setLastStatus({ status: 'downloading', percent: 0, error: null });
    await updater.downloadUpdate();
    return { success: true };
  } catch (error) {
    const errorMessage = toErrorMessage(error);
    isDownloading = false;
    const status = setLastStatus({
      status: 'error',
      percent: 0,
      error: errorMessage,
      isChecking: false,
    });
    broadcast(updateChannels.error, status);
    return { success: false, error: errorMessage };
  }
}

function installUpdate() {
  if (!isAutoUpdateSupported()) {
    throw new Error(getUnsupportedReason());
  }

  const updater = getAutoUpdater();

  if (!updater) {
    throw new Error('更新模块加载失败。');
  }

  updater.quitAndInstall(false, true);
  return true;
}

function registerAutoUpdateHandlers(registerIpcHandler) {
  registerIpcHandler('app:get-update-status', async () => getStatusSnapshot());
  registerIpcHandler('app:check-for-update-download', async () => checkForUpdateDownload());
  registerIpcHandler('app:download-update', async () => downloadUpdate());
  registerIpcHandler('app:install-update', async () => installUpdate());
}

module.exports = {
  registerAutoUpdateHandlers,
  startAutoUpdateCheck,
  isAutoUpdateSupported,
};
