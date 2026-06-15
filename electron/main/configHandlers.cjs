const { app, dialog, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { maxConfigImportBytes, maxLogEntries } = require('./constants.cjs');
const { testProxyConfig } = require('./connectionManager.cjs');
const { getSystemFontFamilies } = require('./systemFonts.cjs');
const { getSenderWindow } = require('./windows.cjs');
const { isPlainObject, readBoundedString, readIntegerInRange } = require('./validation.cjs');
const {
  buildConfigBundle,
  createPublicVaultSnapshot,
  createVaultSnapshot,
  generateRsaKeyPairInVault,
  getConfigPreference,
  getRemoteConnectionProfile,
  getVault,
  importKeyPairToVault,
  notifyVaultChanged,
  readConfigImportPayload,
  readLogEntries,
  saveBrowserBookmarks,
  saveRemoteConnectionProfile,
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

function readTextFileFilters(rawFilters) {
  if (!Array.isArray(rawFilters)) {
    return null;
  }

  const filters = [];

  for (const rawFilter of rawFilters.slice(0, 8)) {
    if (!isPlainObject(rawFilter)) {
      continue;
    }

    const name = typeof rawFilter.name === 'string'
      ? rawFilter.name.trim().slice(0, 80)
      : '';
    const extensions = Array.isArray(rawFilter.extensions)
      ? rawFilter.extensions
        .filter((extension) => typeof extension === 'string')
        .map((extension) => extension.trim().replace(/^\./u, '').toLowerCase())
        .filter((extension) => extension === '*' || /^[a-z0-9][a-z0-9_-]{0,15}$/iu.test(extension))
        .slice(0, 8)
      : [];

    if (name && extensions.length > 0) {
      filters.push({ name, extensions });
    }
  }

  return filters.length > 0
    ? filters
    : null;
}

function readLogEntry(rawEntry) {
  if (!isPlainObject(rawEntry)) {
    return null;
  }

  const id = typeof rawEntry.id === 'string' && rawEntry.id.trim()
    ? readBoundedString(rawEntry.id, '日志 ID', 120)
    : '';
  const timestamp = typeof rawEntry.timestamp === 'string' && rawEntry.timestamp.trim()
    ? readBoundedString(rawEntry.timestamp, '日志时间', 80)
    : new Date().toISOString();
  const category = ['connection', 'host', 'key', 'config', 'system'].includes(rawEntry.category)
    ? rawEntry.category
    : 'system';
  const level = ['info', 'success', 'warning', 'error'].includes(rawEntry.level)
    ? rawEntry.level
    : 'info';
  const message = readBoundedString(String(rawEntry.message ?? ''), '日志内容', 500, {
    required: false,
    rejectLineBreaks: false,
  });
  const detail = readBoundedString(String(rawEntry.detail ?? ''), '日志详情', 4000, {
    required: false,
    rejectLineBreaks: false,
  });
  const component = typeof rawEntry.component === 'string' && rawEntry.component.trim()
    ? readBoundedString(rawEntry.component, '日志组件', 180, { required: false })
    : '';
  const hostId = typeof rawEntry.hostId === 'string' && rawEntry.hostId.trim()
    ? readBoundedString(rawEntry.hostId, '日志主机 ID', 180, { required: false })
    : '';
  const hostName = typeof rawEntry.hostName === 'string' && rawEntry.hostName.trim()
    ? readBoundedString(rawEntry.hostName, '日志主机名称', 180, { required: false })
    : '';
  const hostAddress = typeof rawEntry.hostAddress === 'string' && rawEntry.hostAddress.trim()
    ? readBoundedString(rawEntry.hostAddress, '日志主机地址', 255, { required: false })
    : '';

  if (!id || !message) {
    return null;
  }

  return {
    id,
    timestamp,
    category,
    level,
    message,
    detail,
    ...(component ? { component } : {}),
    ...(hostId ? { hostId } : {}),
    ...(hostName ? { hostName } : {}),
    ...(hostAddress ? { hostAddress } : {}),
  };
}

function readLogEntryList(rawEntries) {
  if (!Array.isArray(rawEntries)) {
    return [];
  }

  return rawEntries
    .slice(0, maxLogEntries)
    .map((entry) => readLogEntry(entry))
    .filter(Boolean);
}

function mergeLogEntries(primaryEntries, secondaryEntries = []) {
  const seenIds = new Set();
  const nextEntries = [];

  for (const entry of [...primaryEntries, ...secondaryEntries]) {
    if (!entry || seenIds.has(entry.id)) {
      continue;
    }

    seenIds.add(entry.id);
    nextEntries.push(entry);

    if (nextEntries.length >= maxLogEntries) {
      break;
    }
  }

  return nextEntries;
}

function getSystemKnownHostsPaths() {
  const homeDir = os.homedir();
  const paths = [];

  if (homeDir) {
    paths.push(path.join(homeDir, '.ssh', 'known_hosts'));
    paths.push(path.join(homeDir, '.ssh', 'known_hosts2'));
  }

  if (process.platform === 'win32') {
    paths.push(path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'ssh', 'known_hosts'));
  } else {
    paths.push('/etc/ssh/ssh_known_hosts');
  }

  return Array.from(new Set(paths));
}

function readSystemKnownHosts() {
  const chunks = [];
  const paths = [];

  for (const filePath of getSystemKnownHostsPaths()) {
    try {
      const stats = fs.statSync(filePath);

      if (!stats.isFile() || stats.size > 5 * 1024 * 1024) {
        continue;
      }

      chunks.push(fs.readFileSync(filePath, 'utf8'));
      paths.push(filePath);
    } catch {
      // Missing known_hosts files are normal on fresh systems.
    }
  }

  return {
    content: chunks.join('\n'),
    paths,
  };
}

function readProxyTestConfig(rawConfig) {
  if (!isPlainObject(rawConfig)) {
    throw new Error('代理配置无效。');
  }

  const type = rawConfig.type === 'http' || rawConfig.type === 'socks5' || rawConfig.type === 'command'
    ? rawConfig.type
    : '';

  if (!type) {
    throw new Error('代理类型无效。');
  }

  if (type === 'command') {
    return {
      type,
      host: '',
      port: 0,
      command: readBoundedString(rawConfig.command ?? '', '代理命令', 4096),
      username: '',
      password: '',
    };
  }

  return {
    type,
    host: readBoundedString(rawConfig.host ?? '', '代理主机', 255),
    port: readIntegerInRange(rawConfig.port, '代理端口', 1, 65535),
    command: '',
    username: readBoundedString(rawConfig.username ?? '', '代理用户名', 128, { required: false }),
    password: readBoundedString(rawConfig.password ?? '', '代理密码', 4096, { required: false, trim: false }),
  };
}

function readProxyTestTarget(rawTarget) {
  if (!isPlainObject(rawTarget)) {
    return {
      kind: 'http',
      host: 'example.com',
      port: 80,
      timeoutMs: 15000,
    };
  }

  const kind = rawTarget.kind === 'ssh' ? 'ssh' : 'http';
  const defaultPort = kind === 'ssh' ? 22 : 80;

  return {
    kind,
    host: readBoundedString(rawTarget.host ?? 'example.com', '代理测试目标主机', 255),
    port: readIntegerInRange(rawTarget.port ?? defaultPort, '代理测试目标端口', 1, 65535),
    timeoutMs: readIntegerInRange(rawTarget.timeoutMs ?? 15000, '代理测试超时时间', 3000, 30000),
  };
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

  registerIpcHandler('vault:get-public-snapshot', async () => createPublicVaultSnapshot());

  registerIpcHandler('vault:get-snapshot', async () => createVaultSnapshot());

  registerIpcHandler('logs:get-entries', async () => readLogEntries());

  registerIpcHandler('logs:clear-entries', async () => {
    writeLogEntries([]);
    return [];
  });

  registerIpcHandler('logs:save-entries', async (_event, rawEntries) => {
    const entries = readLogEntryList(rawEntries);

    if (Array.isArray(rawEntries) && rawEntries.length === 0) {
      writeLogEntries([]);
      return readLogEntries();
    }

    const existingEntries = readLogEntryList(readLogEntries());
    writeLogEntries(mergeLogEntries(entries, existingEntries));
    return readLogEntries();
  });

  registerIpcHandler('logs:append-entry', async (_event, rawEntry) => {
    const entry = readLogEntry(rawEntry);

    if (!entry) {
      throw new Error('日志条目无效。');
    }

    const existingEntries = readLogEntryList(readLogEntries());
    writeLogEntries(mergeLogEntries([entry], existingEntries));
    return readLogEntries();
  });

  registerIpcHandler('preferences:get', async (_event, rawKey) => getConfigPreference(rawKey));

  registerIpcHandler('preferences:set', async (_event, rawKey, rawValue) => setConfigPreference(rawKey, rawValue));

  registerIpcHandler('system:list-fonts', async () => getSystemFontFamilies());

  registerIpcHandler('system:read-known-hosts', async () => readSystemKnownHosts());

  registerIpcHandler('system:test-proxy', async (_event, rawPayload) => {
    const payload = isPlainObject(rawPayload) ? rawPayload : {};
    const proxyConfig = readProxyTestConfig(payload.config ?? rawPayload);
    const target = readProxyTestTarget(payload.target);

    return testProxyConfig(proxyConfig, target);
  });

  registerIpcHandler('vault:save-collections', async (_event, rawPayload) => upsertVaultCollections(rawPayload));

  registerIpcHandler('vault:import-key-pair', async (_event, rawPayload) => importKeyPairToVault(rawPayload));

  registerIpcHandler('vault:generate-rsa-key-pair', async (_event, rawPayload) => generateRsaKeyPairInVault(rawPayload));

  registerIpcHandler('vault:get-bookmarks', async (_event, rawScope) => {
    const scope = readBoundedString(rawScope, '书签范围', 255);
    const bookmarks = getVault().browserBookmarks.find((collection) => collection.scope === scope)?.bookmarks ?? [];
    return bookmarks;
  });

  registerIpcHandler('vault:save-bookmarks', async (_event, rawScope, rawBookmarks) => saveBrowserBookmarks(rawScope, rawBookmarks));

  registerIpcHandler('vault:get-remote-connection-profile', async (_event, rawHostId, rawAppKey) => (
    getRemoteConnectionProfile(rawHostId, rawAppKey)
  ));

  registerIpcHandler('vault:save-remote-connection-profile', async (_event, rawHostId, rawAppKey, rawValues) => (
    saveRemoteConnectionProfile(rawHostId, rawAppKey, rawValues)
  ));

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
    const content = readBoundedString(rawPayload.content, '文件内容', 50_000_000, {
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
    const filters = readTextFileFilters(rawPayload.filters) ?? [
      { name: text.markdown, extensions: ['md'] },
      { name: text.textFiles, extensions: ['txt'] },
      { name: text.allFiles, extensions: ['*'] },
    ];
    const window = getSenderWindow(event);
    const result = await dialog.showSaveDialog(window ?? undefined, {
      title,
      defaultPath: path.join(app.getPath('documents'), defaultFileName),
      filters,
    });

    if (result.canceled || !result.filePath) {
      return '';
    }

    await fs.promises.writeFile(result.filePath, content, {
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
      proxyProfiles: importedPayload.proxyProfiles,
      knownHosts: importedPayload.knownHosts,
      settings: importedPayload.settings,
      browserBookmarks: importedPayload.browserBookmarks,
    });

    notifyVaultChanged({ kind: 'vault' });
    return createVaultSnapshot(nextVault);
  });
}

module.exports = { registerConfigHandlers };
