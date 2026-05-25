const { app, dialog, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { maxConfigImportBytes } = require('./constants.cjs');
const { getSenderWindow } = require('./windows.cjs');
const { readBoundedString, toErrorMessage } = require('./validation.cjs');
const {
  buildConfigBundle,
  createPublicVaultSnapshot,
  createVaultSnapshot,
  generateRsaKeyPairInVault,
  getConfigPreference,
  getVault,
  importKeyPairToVault,
  notifyVaultChanged,
  readConfigImportPayload,
  readLogEntries,
  saveBrowserBookmarks,
  setConfigPreference,
  setVault,
  upsertVaultCollections,
  writeLogEntries,
} = require('./vaultStore.cjs');

function registerConfigHandlers(registerIpcHandler) {
  ipcMain.handle('dialog:select-private-key', async (event) => {
    const window = getSenderWindow(event);
    const result = await dialog.showOpenDialog(window ?? undefined, {
      title: '选择 SSH 私钥文件',
      properties: ['openFile'],
      filters: [{ name: 'All Files', extensions: ['*'] }],
    });

    if (result.canceled) {
      return '';
    }

    return result.filePaths[0] ?? '';
  });

  ipcMain.handle('dialog:select-public-key', async (event) => {
    const window = getSenderWindow(event);
    const result = await dialog.showOpenDialog(window ?? undefined, {
      title: '选择 SSH 公钥文件',
      properties: ['openFile'],
      filters: [
        { name: 'SSH Public Keys', extensions: ['pub', 'txt'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });

    if (result.canceled) {
      return '';
    }

    return result.filePaths[0] ?? '';
  });

  ipcMain.on('vault:get-public-snapshot-sync', (event) => {
    try {
      event.returnValue = { ok: true, snapshot: createPublicVaultSnapshot() };
    } catch (error) {
      event.returnValue = { ok: false, error: toErrorMessage(error) };
    }
  });

  registerIpcHandler('vault:get-public-snapshot', async () => createPublicVaultSnapshot());

  registerIpcHandler('vault:get-snapshot', async () => createVaultSnapshot());

  registerIpcHandler('logs:get-entries', async () => readLogEntries());

  registerIpcHandler('logs:save-entries', async (_event, rawEntries) => {
    const entries = Array.isArray(rawEntries) ? rawEntries : [];
    writeLogEntries(entries);
    return readLogEntries();
  });

  registerIpcHandler('preferences:get', async (_event, rawKey) => getConfigPreference(rawKey));

  registerIpcHandler('preferences:set', async (_event, rawKey, rawValue) => setConfigPreference(rawKey, rawValue));

  registerIpcHandler('vault:save-collections', async (_event, rawPayload) => upsertVaultCollections(rawPayload));

  registerIpcHandler('vault:import-key-pair', async (_event, rawPayload) => importKeyPairToVault(rawPayload));

  registerIpcHandler('vault:generate-rsa-key-pair', async (_event, rawPayload) => generateRsaKeyPairInVault(rawPayload));

  registerIpcHandler('vault:get-bookmarks', async (_event, rawScope) => {
    const scope = readBoundedString(rawScope, '书签范围', 255);
    const bookmarks = getVault().browserBookmarks.find((collection) => collection.scope === scope)?.bookmarks ?? [];
    return bookmarks;
  });

  registerIpcHandler('vault:save-bookmarks', async (_event, rawScope, rawBookmarks) => saveBrowserBookmarks(rawScope, rawBookmarks));

  registerIpcHandler('config:export', async (event) => {
    const bundle = buildConfigBundle();
    const window = getSenderWindow(event);
    const defaultPath = path.join(app.getPath('documents'), `shelldesk-config-${new Date().toISOString().slice(0, 10)}.json`);
    const result = await dialog.showSaveDialog(window ?? undefined, {
      title: '导出完整主机配置',
      defaultPath,
      filters: [{ name: 'ShellDesk Config', extensions: ['json'] }],
    });

    if (result.canceled || !result.filePath) {
      return '';
    }

    fs.writeFileSync(result.filePath, JSON.stringify(bundle, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });

    return result.filePath;
  });

  registerIpcHandler('config:import', async (event) => {
    const window = getSenderWindow(event);
    const result = await dialog.showOpenDialog(window ?? undefined, {
      title: '导入完整主机配置',
      properties: ['openFile'],
      filters: [{ name: 'ShellDesk Config', extensions: ['json'] }],
    });

    if (result.canceled) {
      return null;
    }

    const filePath = result.filePaths[0];

    if (!filePath) {
      return null;
    }

    const stats = fs.statSync(filePath);

    if (!stats.size || stats.size > maxConfigImportBytes) {
      throw new Error('备份文件为空或超过大小限制。');
    }

    const importedPayload = readConfigImportPayload(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    const nextVault = setVault({
      hosts: importedPayload.hosts,
      sshKeys: importedPayload.sshKeys,
      settings: importedPayload.settings,
      browserBookmarks: importedPayload.browserBookmarks,
    });

    notifyVaultChanged({ kind: 'vault' });
    return createVaultSnapshot(nextVault);
  });
}

module.exports = { registerConfigHandlers };
