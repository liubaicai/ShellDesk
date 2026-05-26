const { app, dialog, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { maxConfigImportBytes } = require('./constants.cjs');
const { getSystemFontFamilies } = require('./systemFonts.cjs');
const { getSenderWindow } = require('./windows.cjs');
const { isPlainObject, readBoundedString, toErrorMessage } = require('./validation.cjs');
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

function getCurrentLanguage() {
  try {
    return getVault().settings?.language === 'zh-CN' ? 'zh-CN' : 'en-US';
  } catch {
    return /^zh\b|^zh-/i.test(app.getLocale?.() ?? '') ? 'zh-CN' : 'en-US';
  }
}

function getDialogText(language) {
  return language === 'zh-CN'
    ? {
        selectPrivateKey: '选择 SSH 私钥文件',
        selectPublicKey: '选择 SSH 公钥文件',
        exportConfig: '导出完整主机配置',
        saveTextFile: '保存文本文件',
        importConfig: '导入完整主机配置',
        allFiles: 'All Files',
        markdown: 'Markdown',
        textFiles: 'Text Files',
        sshPublicKeys: 'SSH Public Keys',
        shellDeskConfig: 'ShellDesk Config',
        importSizeError: '备份文件为空或超过大小限制。',
      }
    : {
        selectPrivateKey: 'Choose SSH Private Key',
        selectPublicKey: 'Choose SSH Public Key',
        exportConfig: 'Export Full Host Configuration',
        saveTextFile: 'Save Text File',
        importConfig: 'Import Full Host Configuration',
        allFiles: 'All Files',
        markdown: 'Markdown',
        textFiles: 'Text Files',
        sshPublicKeys: 'SSH Public Keys',
        shellDeskConfig: 'ShellDesk Config',
        importSizeError: 'The backup file is empty or exceeds the size limit.',
      };
}

function sanitizeTextFileName(value, fallback) {
  const rawValue = typeof value === 'string' ? value : '';
  const sanitizedValue = rawValue
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '-')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 180);

  return sanitizedValue || fallback;
}

function registerConfigHandlers(registerIpcHandler) {
  ipcMain.handle('dialog:select-private-key', async (event) => {
    const window = getSenderWindow(event);
    const text = getDialogText(getCurrentLanguage());
    const result = await dialog.showOpenDialog(window ?? undefined, {
      title: text.selectPrivateKey,
      properties: ['openFile'],
      filters: [{ name: text.allFiles, extensions: ['*'] }],
    });

    if (result.canceled) {
      return '';
    }

    return result.filePaths[0] ?? '';
  });

  ipcMain.handle('dialog:select-public-key', async (event) => {
    const window = getSenderWindow(event);
    const text = getDialogText(getCurrentLanguage());
    const result = await dialog.showOpenDialog(window ?? undefined, {
      title: text.selectPublicKey,
      properties: ['openFile'],
      filters: [
        { name: text.sshPublicKeys, extensions: ['pub', 'txt'] },
        { name: text.allFiles, extensions: ['*'] },
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

  registerIpcHandler('system:list-fonts', async () => getSystemFontFamilies());

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
    const text = getDialogText(getCurrentLanguage());
    const defaultPath = path.join(app.getPath('documents'), `shelldesk-config-${new Date().toISOString().slice(0, 10)}.json`);
    const result = await dialog.showSaveDialog(window ?? undefined, {
      title: text.exportConfig,
      defaultPath,
      filters: [{ name: text.shellDeskConfig, extensions: ['json'] }],
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

  registerIpcHandler('dialog:save-text-file', async (event, rawPayload) => {
    if (!isPlainObject(rawPayload)) {
      throw new Error('保存文件请求无效。');
    }

    const text = getDialogText(getCurrentLanguage());
    const content = readBoundedString(rawPayload.content, '文件内容', 2_000_000, {
      trim: false,
      rejectLineBreaks: false,
    });
    const title = typeof rawPayload.title === 'string' && rawPayload.title.trim()
      ? rawPayload.title.trim().slice(0, 120)
      : text.saveTextFile;
    const defaultFileName = sanitizeTextFileName(
      rawPayload.defaultFileName,
      `shelldesk-report-${new Date().toISOString().slice(0, 10)}.md`,
    );
    const window = getSenderWindow(event);
    const result = await dialog.showSaveDialog(window ?? undefined, {
      title,
      defaultPath: path.join(app.getPath('documents'), defaultFileName),
      filters: [
        { name: text.markdown, extensions: ['md'] },
        { name: text.textFiles, extensions: ['txt'] },
        { name: text.allFiles, extensions: ['*'] },
      ],
    });

    if (result.canceled || !result.filePath) {
      return '';
    }

    fs.writeFileSync(result.filePath, content, {
      encoding: 'utf8',
      mode: 0o600,
    });

    return result.filePath;
  });

  registerIpcHandler('config:import', async (event) => {
    const window = getSenderWindow(event);
    const text = getDialogText(getCurrentLanguage());
    const result = await dialog.showOpenDialog(window ?? undefined, {
      title: text.importConfig,
      properties: ['openFile'],
      filters: [{ name: text.shellDeskConfig, extensions: ['json'] }],
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
      throw new Error(text.importSizeError);
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
