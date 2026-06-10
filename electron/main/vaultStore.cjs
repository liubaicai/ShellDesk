const { app, BrowserWindow, safeStorage, shell } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  accentColorChoices,
  aiApiFormatChoices,
  aiProviderChoices,
  configBundleFormat,
  configBundleVersion,
  configFileName,
  configStoreFormat,
  defaultAiApiBaseUrls,
  defaultIdentityFileNames,
  desktopWallpaperPresetIdSet,
  logFileName,
  maxAiApiBaseUrlLength,
  maxAiApiKeyLength,
  maxAiModelNameLength,
  maxAiProviderNameLength,
  maxConfigStoreBytes,
  maxLogEntries,
  maxPrivateKeyBytes,
  maxVaultBytes,
  remoteDesktopAppCatalogMigrationKeys,
  remoteDesktopAppCatalogVersion,
  remoteDesktopAppKeySet,
  remoteDesktopAppKeys,
  remoteDesktopSortModes,
  remoteSystemTypeChoices,
  terminalCursorInactiveStyleChoices,
  terminalThemeChoices,
  vaultFileName,
  vaultFormat,
  vaultSchemaVersion,
} = require('./constants.cjs');
const {
  isPlainObject,
  readBoolean,
  readBoundedString,
  readColorHex,
  readDesktopWallpaperDataUrl,
  readIntegerInRange,
  readNumberInRange,
} = require('./validation.cjs');

let vaultCache = null;

const remoteConnectionProfileSecretKeyPattern = /(?:password|passphrase|secret|token|apiKey|accessKey|secretKey)$/i;

function isRemoteConnectionProfileSecretKey(key) {
  return remoteConnectionProfileSecretKeyPattern.test(String(key || ''));
}

function getDefaultLanguage() {
  try {
    const locale = typeof app.getLocale === 'function' ? app.getLocale() : '';
    return /^zh\b|^zh-/i.test(locale) ? 'zh-CN' : 'en-US';
  } catch {
    return 'en-US';
  }
}

function readFontFamily(value, fallback) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const fontFamily = value
    .replace(/\0/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!fontFamily || fontFamily.length > 120 || /[\r\n]/.test(fontFamily)) {
    return fallback;
  }

  return fontFamily;
}

function readAiProvider(value, fallback) {
  return aiProviderChoices.includes(value) ? value : fallback;
}

function readAiApiFormat(value, fallback) {
  return aiApiFormatChoices.includes(value) ? value : fallback;
}

function readAiApiBaseUrl(value, fallback = '') {
  if (typeof value !== 'string') {
    return fallback;
  }

  const apiBaseUrl = value.trim();

  if (!apiBaseUrl) {
    return '';
  }

  if (apiBaseUrl.length > maxAiApiBaseUrlLength || /[\0\r\n]/.test(apiBaseUrl)) {
    throw new Error('AI API 地址无效。');
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(apiBaseUrl);
  } catch {
    throw new Error('AI API 地址无效。');
  }

  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    throw new Error('AI API 地址只支持 http 或 https。');
  }

  return apiBaseUrl;
}

function readAiApiKey(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return readBoundedString(value, 'AI API 密钥', maxAiApiKeyLength, {
    required: false,
  });
}

function createDefaultAiSettings() {
  return {
    aiProvider: 'openai',
    aiProviderName: 'OpenAI',
    aiApiFormat: 'openai',
    aiApiBaseUrl: defaultAiApiBaseUrls.openai,
    aiApiKey: '',
    aiModel: '',
  };
}

function createDefaultTerminalSnippets(language = getDefaultLanguage()) {
  const isChinese = language === 'zh-CN';
  const timestamp = '2026-01-01T00:00:00.000Z';
  const group = isChinese ? '常用巡检' : 'Common Checks';
  const snippets = isChinese
    ? [
        ['system-overview', '系统概览', 'uname -a && uptime'],
        ['disk-usage', '磁盘占用', 'df -h'],
        ['memory-usage', '内存占用', 'free -h'],
        ['listening-ports', '监听端口', 'ss -tulpen || netstat -tulpen'],
        ['recent-logins', '最近登录', 'last -a | head -20'],
      ]
    : [
        ['system-overview', 'System overview', 'uname -a && uptime'],
        ['disk-usage', 'Disk usage', 'df -h'],
        ['memory-usage', 'Memory usage', 'free -h'],
        ['listening-ports', 'Listening ports', 'ss -tulpen || netstat -tulpen'],
        ['recent-logins', 'Recent logins', 'last -a | head -20'],
      ];

  return snippets.map(([id, label, command]) => ({
    id: `builtin:${id}`,
    label,
    command,
    group,
    shortcut: '',
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
}

function getDefaultAiProviderName(provider) {
  if (provider === 'anthropic') {
    return 'Claude / Anthropic';
  }

  if (provider === 'openai-compatible') {
    return 'OpenAI 兼容';
  }

  if (provider === 'custom') {
    return '自定义提供商';
  }

  return 'OpenAI';
}

function createDefaultSettings() {
  const defaultAiSettings = createDefaultAiSettings();

  return {
    language: getDefaultLanguage(),
    interfaceFont: 'Microsoft YaHei UI',
    theme: 'dark',
    accentColor: accentColorChoices[0],
    defaultHostView: 'grid',
    minimizeToTrayOnClose: true,
    desktopWallpaperMode: 'preset',
    desktopWallpaperPresetId: 'default',
    desktopWallpaperDataUrl: '',
    desktopWallpaperName: '',
    remoteDesktopLayout: createDefaultRemoteDesktopLayout(),
    rememberPasswords: true,
    rememberKeyPassphrases: true,
    terminalFontSize: 13,
    terminalFontFamily: 'Cascadia Mono',
    terminalFontWeight: 400,
    terminalFontWeightBold: 700,
    terminalFontLigatures: true,
    terminalLineHeight: 1.2,
    terminalTheme: 'shelldesk-dark',
    terminalCursorBlink: true,
    terminalCursorStyle: 'block',
    terminalCursorInactiveStyle: 'outline',
    terminalScrollback: 10000,
    terminalScrollSensitivity: 1,
    terminalFastScrollSensitivity: 5,
    terminalScrollOnUserInput: true,
    terminalScrollOnEraseInDisplay: true,
    terminalCopyOnSelect: true,
    terminalRightClickPaste: true,
    terminalAltClickMovesCursor: true,
    terminalBracketedPasteMode: true,
    terminalMinimumContrastRatio: 1,
    terminalScreenReaderMode: false,
    terminalSnippets: createDefaultTerminalSnippets(),
    ...defaultAiSettings,
  };
}


function createDefaultRemoteDesktopLayout() {
  return {
    appCatalogVersion: remoteDesktopAppCatalogVersion,
    sortMode: 'custom',
    items: ['files', 'terminal', 'browser', 'settings'].map((appKey) => ({
      id: `app:${appKey}`,
      type: 'app',
      appKey,
    })),
  };
}

function getRemoteDesktopLayoutAppKeys(items) {
  const appKeys = new Set();

  for (const item of items) {
    if (item.type === 'app') {
      appKeys.add(item.appKey);
      continue;
    }

    for (const appKey of item.appKeys) {
      appKeys.add(appKey);
    }
  }

  return appKeys;
}

function migrateLegacyAllRemoteDesktopApps(items, appCatalogVersion) {
  if (appCatalogVersion >= remoteDesktopAppCatalogVersion) {
    return items;
  }

  const currentAppKeys = getRemoteDesktopLayoutAppKeys(items);
  const migrationKeySet = new Set(remoteDesktopAppCatalogMigrationKeys);
  const legacyAppKeys = remoteDesktopAppKeys.filter((appKey) => !migrationKeySet.has(appKey));
  const hasAllLegacyApps = legacyAppKeys.every((appKey) => currentAppKeys.has(appKey));

  if (!hasAllLegacyApps) {
    return items;
  }

  return [
    ...items,
    ...remoteDesktopAppCatalogMigrationKeys
      .filter((appKey) => !currentAppKeys.has(appKey))
      .map((appKey) => ({
        id: `app:${appKey}`,
        type: 'app',
        appKey,
      })),
  ];
}

function readRemoteDesktopLayout(rawLayout) {
  const defaults = createDefaultRemoteDesktopLayout();

  if (!isPlainObject(rawLayout)) {
    return defaults;
  }

  const sortMode = remoteDesktopSortModes.has(rawLayout.sortMode) ? rawLayout.sortMode : defaults.sortMode;
  const rawAppCatalogVersion = Number(rawLayout.appCatalogVersion);
  const appCatalogVersion = Number.isInteger(rawAppCatalogVersion) && rawAppCatalogVersion > 0
    ? rawAppCatalogVersion
    : 1;

  if (!Array.isArray(rawLayout.items)) {
    return { ...defaults, sortMode };
  }

  const seenAppKeys = new Set();
  const items = [];

  for (const [index, rawItem] of rawLayout.items.slice(0, remoteDesktopAppKeys.length + 12).entries()) {
    if (!isPlainObject(rawItem)) {
      continue;
    }

    if (rawItem.type === 'app') {
      const appKey = rawItem.appKey;

      if (!remoteDesktopAppKeySet.has(appKey) || seenAppKeys.has(appKey)) {
        continue;
      }

      seenAppKeys.add(appKey);
      items.push({
        id: `app:${appKey}`,
        type: 'app',
        appKey,
      });
      continue;
    }

    if (rawItem.type === 'folder') {
      const folderAppKeys = Array.isArray(rawItem.appKeys)
        ? rawItem.appKeys.filter((appKey) => {
            if (!remoteDesktopAppKeySet.has(appKey) || seenAppKeys.has(appKey)) {
              return false;
            }

            seenAppKeys.add(appKey);
            return true;
          })
        : [];
      const folderName = readBoundedString(rawItem.name ?? '文件夹', '桌面文件夹名称', 40, { required: false }) || '文件夹';
      const folderId = readBoundedString(
        rawItem.id ?? `folder:${index + 1}`,
        '桌面文件夹 ID',
        128,
        { required: false },
      ) || `folder:${index + 1}`;

      items.push({
        id: folderId,
        type: 'folder',
        name: folderName,
        appKeys: folderAppKeys,
      });
    }
  }

  return {
    appCatalogVersion: remoteDesktopAppCatalogVersion,
    sortMode,
    items: migrateLegacyAllRemoteDesktopApps(items, appCatalogVersion),
  };
}

function readTerminalSnippetShortcut(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return readBoundedString(value.replace(/\s*\+\s*/g, ' + '), '代码片段快捷键', 80, {
    required: false,
  });
}

function readTerminalSnippets(rawSnippets, fallbackSnippets) {
  if (rawSnippets === undefined) {
    return fallbackSnippets;
  }

  if (!Array.isArray(rawSnippets)) {
    return fallbackSnippets;
  }

  const snippets = [];
  const seenIds = new Set();

  for (const rawSnippet of rawSnippets.slice(0, 80)) {
    if (!isPlainObject(rawSnippet)) {
      continue;
    }

    const label = readBoundedString(rawSnippet.label ?? '', '代码片段名称', 80, { required: false });
    const command = readBoundedString(rawSnippet.command ?? '', '代码片段命令', 20000, {
      required: false,
      trim: false,
      rejectLineBreaks: false,
    }).trimEnd();

    if (!label || !command) {
      continue;
    }

    const rawId = readBoundedString(rawSnippet.id ?? '', '代码片段 ID', 128, { required: false });
    let id = rawId || crypto.randomUUID();

    if (seenIds.has(id)) {
      id = crypto.randomUUID();
    }

    seenIds.add(id);
    snippets.push({
      id,
      label,
      command,
      group: readBoundedString(rawSnippet.group ?? '', '代码片段分组', 80, { required: false }),
      shortcut: readTerminalSnippetShortcut(rawSnippet.shortcut),
      createdAt: readBoundedString(rawSnippet.createdAt ?? new Date().toISOString(), '代码片段创建时间', 64, { required: false }) || new Date().toISOString(),
      updatedAt: readBoundedString(rawSnippet.updatedAt ?? new Date().toISOString(), '代码片段更新时间', 64, { required: false }) || new Date().toISOString(),
    });
  }

  return snippets;
}

function readProxyType(value) {
  if (value === 'http' || value === 'socks5' || value === 'command') {
    return value;
  }

  throw new Error('代理类型无效。');
}

function readProxyConfig(rawConfig) {
  if (!isPlainObject(rawConfig)) {
    throw new Error('代理配置无效。');
  }

  const type = readProxyType(rawConfig.type);

  if (type === 'command') {
    return {
      type,
      host: '',
      port: 0,
      command: readBoundedString(rawConfig.command ?? '', '代理命令', 4096, {
        trim: false,
        rejectLineBreaks: false,
      }).trim(),
      username: '',
      password: '',
    };
  }

  const port = Number(rawConfig.port);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('代理端口无效。');
  }

  return {
    type,
    host: readBoundedString(rawConfig.host, '代理主机', 255),
    port,
    command: '',
    username: readBoundedString(rawConfig.username ?? '', '代理用户名', 128, { required: false }),
    password: readBoundedString(rawConfig.password ?? '', '代理密码', 4096, {
      required: false,
      trim: false,
      rejectLineBreaks: false,
    }),
  };
}

function readProxyProfile(rawProfile) {
  if (!isPlainObject(rawProfile)) {
    throw new Error('代理资料无效。');
  }

  return {
    id: readBoundedString(rawProfile.id, '代理 ID', 128),
    label: readBoundedString(rawProfile.label, '代理名称', 80),
    config: readProxyConfig(rawProfile.config),
    createdAt: readTimestampString(rawProfile.createdAt, '代理创建时间'),
    updatedAt: readTimestampString(rawProfile.updatedAt ?? rawProfile.createdAt, '代理更新时间'),
  };
}

function readKnownHost(rawKnownHost) {
  if (!isPlainObject(rawKnownHost)) {
    throw new Error('已知主机数据无效。');
  }

  const port = Number(rawKnownHost.port);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('已知主机端口无效。');
  }

  return {
    id: readBoundedString(rawKnownHost.id, '已知主机 ID', 128),
    hostname: readBoundedString(rawKnownHost.hostname, '已知主机名', 255),
    port,
    keyType: readBoundedString(rawKnownHost.keyType ?? '', '主机密钥类型', 80, { required: false }),
    publicKey: readBoundedString(rawKnownHost.publicKey ?? '', '主机公钥', 128 * 1024, {
      required: false,
      trim: true,
      rejectLineBreaks: false,
    }),
    fingerprint: readBoundedString(rawKnownHost.fingerprint ?? '', '主机指纹', 256, { required: false }),
    discoveredAt: readTimestampString(rawKnownHost.discoveredAt ?? new Date().toISOString(), '发现时间'),
    lastSeen: rawKnownHost.lastSeen
      ? readTimestampString(rawKnownHost.lastSeen, '最近看到时间')
      : '',
    convertedToHostId: readBoundedString(rawKnownHost.convertedToHostId ?? '', '转换主机 ID', 128, { required: false }),
  };
}

function getVaultFilePath() {
  return path.join(app.getPath('userData'), vaultFileName);
}

function getConfigFilePath() {
  return path.join(app.getPath('userData'), configFileName);
}

function getVaultStorageInfo() {
  const protectedStorage = safeStorage.isEncryptionAvailable();
  const configPath = getConfigFilePath();
  const vaultPath = getVaultFilePath();

  return {
    path: path.dirname(configPath),
    configPath,
    vaultPath,
    protected: protectedStorage,
    protectionLabel: protectedStorage
      ? '普通配置写入 config.json，密码、私钥和 AI API 密钥已使用系统凭据加密保存到 vault.json'
      : '普通配置写入 config.json，当前系统不支持加密，敏感 vault 改为本地文件权限保护',
  };
}

function ensurePrivateKeyText(privateKey, label) {
  const value = readBoundedString(privateKey, label, maxPrivateKeyBytes, {
    trim: false,
    rejectLineBreaks: false,
  });

  if (!/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(value)) {
    throw new Error(`${label}无效。`);
  }

  return value;
}

function ensurePublicKeyText(publicKey) {
  return readBoundedString(publicKey ?? '', 'SSH 公钥', 128 * 1024, {
    required: false,
    trim: true,
    rejectLineBreaks: false,
  });
}

function readAppSettings(rawSettings) {
  const defaults = createDefaultSettings();

  if (!isPlainObject(rawSettings)) {
    return defaults;
  }

  const aiProvider = readAiProvider(rawSettings.aiProvider, defaults.aiProvider);
  const aiApiFormat = readAiApiFormat(
    rawSettings.aiApiFormat,
    aiProvider === 'anthropic' ? 'anthropic' : defaults.aiApiFormat,
  );
  const defaultAiApiBaseUrl = defaultAiApiBaseUrls[aiProvider] ?? '';
  const defaultAiProviderName = getDefaultAiProviderName(aiProvider);
  const desktopWallpaperDataUrl = readDesktopWallpaperDataUrl(
    rawSettings.desktopWallpaperDataUrl,
    defaults.desktopWallpaperDataUrl,
  );
  const rawDesktopWallpaperPresetId = typeof rawSettings.desktopWallpaperPresetId === 'string'
    ? rawSettings.desktopWallpaperPresetId
    : defaults.desktopWallpaperPresetId;
  const desktopWallpaperPresetId = desktopWallpaperPresetIdSet.has(rawDesktopWallpaperPresetId)
    ? rawDesktopWallpaperPresetId
    : defaults.desktopWallpaperPresetId;
  const hasCustomDesktopWallpaper = (
    rawSettings.desktopWallpaperMode === 'custom' &&
    Boolean(desktopWallpaperDataUrl)
  );

  return {
    language: rawSettings.language === 'zh-CN' || rawSettings.language === 'en-US' ? rawSettings.language : defaults.language,
    interfaceFont: readFontFamily(rawSettings.interfaceFont, defaults.interfaceFont),
    theme: rawSettings.theme === 'light' || rawSettings.theme === 'system' ? rawSettings.theme : defaults.theme,
    accentColor: readColorHex(rawSettings.accentColor, '强调色', defaults.accentColor),
    defaultHostView: rawSettings.defaultHostView === 'list' ? 'list' : 'grid',
    minimizeToTrayOnClose: readBoolean(
      rawSettings.minimizeToTrayOnClose,
      '关闭时最小化到托盘',
      defaults.minimizeToTrayOnClose,
    ),
    desktopWallpaperMode: hasCustomDesktopWallpaper ? 'custom' : 'preset',
    desktopWallpaperPresetId,
    desktopWallpaperDataUrl,
    desktopWallpaperName: readBoundedString(
      rawSettings.desktopWallpaperName ?? '',
      '桌面壁纸名称',
      160,
      { required: false },
    ),
    remoteDesktopLayout: readRemoteDesktopLayout(rawSettings.remoteDesktopLayout),
    rememberPasswords: readBoolean(rawSettings.rememberPasswords, '记住密码', defaults.rememberPasswords),
    rememberKeyPassphrases: readBoolean(
      rawSettings.rememberKeyPassphrases,
      '记住密钥口令',
      defaults.rememberKeyPassphrases,
    ),
    aiProvider,
    aiProviderName: readBoundedString(
      rawSettings.aiProviderName ?? defaultAiProviderName,
      'AI 提供商名称',
      maxAiProviderNameLength,
      { required: false },
    ) || defaultAiProviderName,
    aiApiFormat,
    aiApiBaseUrl: readAiApiBaseUrl(rawSettings.aiApiBaseUrl, defaultAiApiBaseUrl),
    aiApiKey: readAiApiKey(rawSettings.aiApiKey),
    aiModel: readBoundedString(
      rawSettings.aiModel ?? defaults.aiModel,
      'AI 模型',
      maxAiModelNameLength,
      { required: false },
    ),
    terminalFontSize: readIntegerInRange(rawSettings.terminalFontSize, '终端字号', 11, 20, defaults.terminalFontSize),
    terminalFontFamily: readFontFamily(rawSettings.terminalFontFamily, defaults.terminalFontFamily),
    terminalFontWeight: readIntegerInRange(
      rawSettings.terminalFontWeight,
      '终端常规字重',
      300,
      600,
      defaults.terminalFontWeight,
    ),
    terminalFontWeightBold: readIntegerInRange(
      rawSettings.terminalFontWeightBold,
      '终端粗体字重',
      600,
      800,
      defaults.terminalFontWeightBold,
    ),
    terminalFontLigatures: readBoolean(
      rawSettings.terminalFontLigatures,
      '终端字体连字',
      defaults.terminalFontLigatures,
    ),
    terminalLineHeight: readNumberInRange(rawSettings.terminalLineHeight, '终端行高', 1, 1.5, defaults.terminalLineHeight),
    terminalTheme: terminalThemeChoices.includes(rawSettings.terminalTheme) ? rawSettings.terminalTheme : defaults.terminalTheme,
    terminalCursorBlink: readBoolean(rawSettings.terminalCursorBlink, '终端光标闪烁', defaults.terminalCursorBlink),
    terminalCursorStyle: rawSettings.terminalCursorStyle === 'bar' || rawSettings.terminalCursorStyle === 'underline'
      ? rawSettings.terminalCursorStyle
      : defaults.terminalCursorStyle,
    terminalCursorInactiveStyle: terminalCursorInactiveStyleChoices.includes(rawSettings.terminalCursorInactiveStyle)
      ? rawSettings.terminalCursorInactiveStyle
      : defaults.terminalCursorInactiveStyle,
    terminalScrollback: readIntegerInRange(
      rawSettings.terminalScrollback,
      '终端滚动缓冲区',
      1000,
      50000,
      defaults.terminalScrollback,
    ),
    terminalScrollSensitivity: readNumberInRange(
      rawSettings.terminalScrollSensitivity,
      '终端滚轮速度',
      0.5,
      5,
      defaults.terminalScrollSensitivity,
    ),
    terminalFastScrollSensitivity: readIntegerInRange(
      rawSettings.terminalFastScrollSensitivity,
      '终端快速滚动速度',
      2,
      20,
      defaults.terminalFastScrollSensitivity,
    ),
    terminalScrollOnUserInput: readBoolean(
      rawSettings.terminalScrollOnUserInput,
      '终端输入时滚到底部',
      defaults.terminalScrollOnUserInput,
    ),
    terminalScrollOnEraseInDisplay: readBoolean(
      rawSettings.terminalScrollOnEraseInDisplay,
      '终端清屏保留历史',
      defaults.terminalScrollOnEraseInDisplay,
    ),
    terminalCopyOnSelect: readBoolean(
      rawSettings.terminalCopyOnSelect,
      '终端选中复制',
      defaults.terminalCopyOnSelect,
    ),
    terminalRightClickPaste: readBoolean(
      rawSettings.terminalRightClickPaste,
      '终端右键粘贴',
      defaults.terminalRightClickPaste,
    ),
    terminalAltClickMovesCursor: readBoolean(
      rawSettings.terminalAltClickMovesCursor,
      '终端 Alt 单击移动光标',
      defaults.terminalAltClickMovesCursor,
    ),
    terminalBracketedPasteMode: readBoolean(
      rawSettings.terminalBracketedPasteMode,
      '终端括号粘贴保护',
      defaults.terminalBracketedPasteMode,
    ),
    terminalMinimumContrastRatio: readNumberInRange(
      rawSettings.terminalMinimumContrastRatio,
      '终端最小对比度',
      1,
      7,
      defaults.terminalMinimumContrastRatio,
    ),
    terminalScreenReaderMode: readBoolean(
      rawSettings.terminalScreenReaderMode,
      '终端屏幕阅读器支持',
      defaults.terminalScreenReaderMode,
    ),
    terminalSnippets: readTerminalSnippets(rawSettings.terminalSnippets, defaults.terminalSnippets),
  };
}

function readTimestampString(value, label) {
  return readBoundedString(value, label, 64);
}

function readStringList(value, label, maxItems, maxItemLength) {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`${label}无效。`);
  }

  return value.map((item) => readBoundedString(item, label, maxItemLength, { required: false }));
}

function readRemoteSystemType(value) {
  const normalizedValue = typeof value === 'string' ? value.toLowerCase() : value;
  return remoteSystemTypeChoices.has(normalizedValue) ? normalizedValue : 'unknown';
}

function readPrivilegeMode(value) {
  return value === 'su-root' ? 'su-root' : 'sudo';
}

function readHostConnectionStatus(value) {
  return value === 'success' || value === 'failed' ? value : 'unknown';
}

function readStoredKeyRecord(rawKey) {
  if (!isPlainObject(rawKey)) {
    throw new Error('密钥数据无效。');
  }

  const source = rawKey.source === 'generated' ? 'generated' : 'imported';

  return {
    id: readBoundedString(rawKey.id, '密钥 ID', 128),
    name: readBoundedString(rawKey.name, '密钥名称', 80),
    source,
    algorithm: readBoundedString(rawKey.algorithm ?? '', '密钥算法', 64, { required: false }) || (source === 'generated' ? 'RSA' : 'SSH'),
    fingerprint: readBoundedString(rawKey.fingerprint ?? '', '密钥指纹', 160, { required: false }),
    publicKey: ensurePublicKeyText(rawKey.publicKey ?? ''),
    passphrase: readBoundedString(rawKey.passphrase ?? '', 'SSH 密钥口令', 4096, {
      required: false,
      trim: false,
      rejectLineBreaks: false,
    }),
    createdAt: readTimestampString(rawKey.createdAt, '密钥创建时间'),
    updatedAt: readTimestampString(rawKey.updatedAt, '密钥更新时间'),
  };
}

function readVaultKeyRecord(rawKey) {
  const key = readStoredKeyRecord(rawKey);

  return {
    ...key,
    privateKey: ensurePrivateKeyText(rawKey.privateKey, 'SSH 私钥内容'),
  };
}

function readStoredHostRecord(rawHost) {
  if (!isPlainObject(rawHost)) {
    throw new Error('主机数据无效。');
  }

  const authMethod = rawHost.authMethod;

  if (authMethod !== 'password' && authMethod !== 'key') {
    throw new Error('主机登录方式无效。');
  }

  const port = Number(rawHost.port);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('主机端口无效。');
  }

  const host = {
    id: readBoundedString(rawHost.id, '主机 ID', 128),
    name: readBoundedString(rawHost.name, '主机名称', 80),
    address: readBoundedString(rawHost.address, '主机地址', 255),
    port,
    username: readBoundedString(rawHost.username, '用户名', 128),
    authMethod,
    password: readBoundedString(rawHost.password ?? '', 'SSH 密码', 4096, {
      required: false,
      trim: false,
      rejectLineBreaks: false,
    }),
    keyId: readBoundedString(rawHost.keyId ?? '', '密钥 ID', 128, { required: false }),
    keyPath: readBoundedString(rawHost.keyPath ?? '', 'SSH 私钥路径', 1024, { required: false }),
    passphrase: readBoundedString(rawHost.passphrase ?? '', 'SSH 密钥口令', 4096, {
      required: false,
      trim: false,
      rejectLineBreaks: false,
    }),
    privilegeMode: readPrivilegeMode(rawHost.privilegeMode),
    rootPassword: readBoundedString(rawHost.rootPassword ?? '', 'root 密码', 4096, {
      required: false,
      trim: false,
      rejectLineBreaks: true,
    }),
    jumpHostId: readBoundedString(rawHost.jumpHostId ?? '', '跳板机 ID', 128, { required: false }),
    canBeJumpHost: readBoolean(rawHost.canBeJumpHost, '可作为跳板机', false),
    proxyProfileId: readBoundedString(rawHost.proxyProfileId ?? '', '代理 ID', 128, { required: false }),
    systemType: readRemoteSystemType(rawHost.systemType),
    systemName: readBoundedString(rawHost.systemName ?? '', '系统名称', 160, { required: false }),
    lastConnectionStatus: readHostConnectionStatus(rawHost.lastConnectionStatus),
    lastConnectionAt: rawHost.lastConnectionAt
      ? readTimestampString(rawHost.lastConnectionAt, '上次连接时间')
      : '',
    lastConnectionError: readBoundedString(rawHost.lastConnectionError ?? '', '上次连接错误', 4096, {
      required: false,
      rejectLineBreaks: false,
    }),
    group: readBoundedString(rawHost.group ?? '', '分组', 120, { required: false }),
    tags: readStringList(rawHost.tags ?? [], '主机标签', 8, 256),
    note: readBoundedString(rawHost.note ?? '', '备注', 20000, {
      required: false,
      rejectLineBreaks: false,
    }),
    createdAt: readTimestampString(rawHost.createdAt, '主机创建时间'),
    updatedAt: readTimestampString(rawHost.updatedAt, '主机更新时间'),
  };

  if (host.authMethod === 'key' && !host.keyId && !host.keyPath) {
    throw new Error(`主机「${host.name}」缺少私钥信息。`);
  }

  if (host.authMethod === 'password') {
    host.keyId = '';
    host.keyPath = '';
    host.passphrase = '';
  } else {
    host.password = '';
  }

  if (host.privilegeMode !== 'su-root') {
    host.rootPassword = '';
  }

  return host;
}

function readBrowserBookmark(rawBookmark) {
  if (!isPlainObject(rawBookmark)) {
    throw new Error('浏览器书签无效。');
  }

  return {
    id: readBoundedString(rawBookmark.id, '书签 ID', 128),
    title: readBoundedString(rawBookmark.title, '书签名称', 200),
    url: readBoundedString(rawBookmark.url, '书签地址', 4096),
    createdAt: readTimestampString(rawBookmark.createdAt, '书签创建时间'),
    updatedAt: readTimestampString(rawBookmark.updatedAt, '书签更新时间'),
  };
}

function readBookmarkCollection(rawCollection) {
  if (!isPlainObject(rawCollection)) {
    throw new Error('书签分组无效。');
  }

  const bookmarks = Array.isArray(rawCollection.bookmarks)
    ? rawCollection.bookmarks.map((bookmark) => readBrowserBookmark(bookmark))
    : [];

  return {
    scope: readBoundedString(rawCollection.scope, '书签范围', 255),
    bookmarks,
    updatedAt: readTimestampString(rawCollection.updatedAt ?? new Date().toISOString(), '书签更新时间'),
  };
}

function createEmptyVault() {
  return {
    version: vaultSchemaVersion,
    hosts: [],
    sshKeys: [],
    proxyProfiles: [],
    knownHosts: [],
    settings: createDefaultSettings(),
    browserBookmarks: [],
    preferences: {},
    remoteConnectionProfiles: [],
  };
}

function readPreferenceStore(rawPreferences) {
  if (!isPlainObject(rawPreferences)) {
    return {};
  }

  const preferences = {};

  for (const [key, value] of Object.entries(rawPreferences)) {
    if (typeof key !== 'string' || key.length > 255 || !/^[a-z0-9:._%-]+$/i.test(key)) {
      continue;
    }

    try {
      preferences[key] = readPreferenceValue(value);
    } catch {
      // Ignore one malformed preference without discarding the whole config.
    }
  }

  return preferences;
}

function readPreferenceKey(rawKey) {
  const key = readBoundedString(rawKey, '偏好设置键', 255);

  if (!/^[a-z0-9:._%-]+$/i.test(key)) {
    throw new Error('偏好设置键无效。');
  }

  return key;
}

function readPreferenceValue(rawValue) {
  const serialized = JSON.stringify(rawValue);

  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > 64 * 1024) {
    throw new Error('偏好设置内容无效或超过大小限制。');
  }

  return JSON.parse(serialized);
}

function readRemoteConnectionProfileHostId(rawHostId) {
  return readBoundedString(rawHostId, '远程组件主机 ID', 512);
}

function readRemoteConnectionProfileAppKey(rawAppKey) {
  const appKey = readBoundedString(rawAppKey, '远程组件标识', 80);

  if (!remoteDesktopAppKeySet.has(appKey)) {
    throw new Error('远程组件标识无效。');
  }

  return appKey;
}

function readRemoteConnectionProfileValue(rawValue, label) {
  if (typeof rawValue === 'string') {
    return readBoundedString(rawValue, label, 8192, {
      required: false,
      trim: false,
      rejectLineBreaks: false,
    });
  }

  if (typeof rawValue === 'boolean') {
    return rawValue;
  }

  if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
    return rawValue;
  }

  return '';
}

function readRemoteConnectionProfileValues(rawValues) {
  if (!isPlainObject(rawValues)) {
    return {};
  }

  const serialized = JSON.stringify(rawValues);
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > 64 * 1024) {
    throw new Error('远程组件连接配置超过大小限制。');
  }

  const values = {};
  for (const [rawKey, rawValue] of Object.entries(rawValues).slice(0, 80)) {
    const key = readBoundedString(rawKey, '远程组件配置键', 80);

    if (!/^[a-z0-9._:-]+$/i.test(key)) {
      continue;
    }

    values[key] = readRemoteConnectionProfileValue(rawValue, `远程组件配置 ${key}`);
  }

  return values;
}

function splitRemoteConnectionProfileValues(values) {
  const configValues = {};
  const secretValues = {};

  for (const [key, value] of Object.entries(values || {})) {
    if (isRemoteConnectionProfileSecretKey(key)) {
      secretValues[key] = value;
    } else {
      configValues[key] = value;
    }
  }

  return { configValues, secretValues };
}

function readRemoteConnectionProfileRecord(rawRecord) {
  if (!isPlainObject(rawRecord)) {
    throw new Error('远程组件连接配置无效。');
  }

  return {
    hostId: readRemoteConnectionProfileHostId(rawRecord.hostId),
    appKey: readRemoteConnectionProfileAppKey(rawRecord.appKey),
    values: readRemoteConnectionProfileValues(rawRecord.values),
    updatedAt: rawRecord.updatedAt
      ? readTimestampString(rawRecord.updatedAt, '远程组件连接配置更新时间')
      : new Date().toISOString(),
  };
}

function readRemoteConnectionProfiles(rawProfiles) {
  if (!Array.isArray(rawProfiles)) {
    return [];
  }

  const profiles = [];
  const seen = new Set();

  for (const rawProfile of rawProfiles.slice(0, 1000)) {
    const profile = readRemoteConnectionProfileRecord(rawProfile);
    const profileKey = `${profile.hostId}:${profile.appKey}`;

    if (seen.has(profileKey)) {
      continue;
    }

    seen.add(profileKey);
    profiles.push(profile);
  }

  return profiles;
}

function toRemoteConnectionProfileConfigRecord(profile) {
  const { configValues } = splitRemoteConnectionProfileValues(profile.values);

  return {
    hostId: profile.hostId,
    appKey: profile.appKey,
    values: configValues,
    updatedAt: profile.updatedAt,
  };
}

function getSortableTimestamp(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function compareHostsByListOrder(left, right) {
  const createdDiff = getSortableTimestamp(right.createdAt) - getSortableTimestamp(left.createdAt);

  if (createdDiff !== 0) {
    return createdDiff;
  }

  const updatedDiff = getSortableTimestamp(right.updatedAt) - getSortableTimestamp(left.updatedAt);

  if (updatedDiff !== 0) {
    return updatedDiff;
  }

  return String(left.id).localeCompare(String(right.id));
}

function sortHostsByListOrder(hosts) {
  return hosts.slice().sort(compareHostsByListOrder);
}

function preserveReferencedJumpHostCapability(hosts) {
  const hostsById = new Map(hosts.map((host) => [host.id, host]));
  const referencedJumpHostIds = new Set(hosts
    .map((host) => {
      const jumpHostId = typeof host.jumpHostId === 'string' ? host.jumpHostId.trim() : '';
      const jumpHost = jumpHostId ? hostsById.get(jumpHostId) : null;

      return jumpHost && jumpHost.id !== host.id ? jumpHost.id : '';
    })
    .filter(Boolean));

  return hosts.map((host) => (
    referencedJumpHostIds.has(host.id) && !host.canBeJumpHost
      ? { ...host, canBeJumpHost: true }
      : host
  ));
}

function sanitizeHostJumpHostReferences(hosts) {
  const hostsWithJumpCapability = preserveReferencedJumpHostCapability(hosts);
  const hostsById = new Map(hostsWithJumpCapability.map((host) => [host.id, host]));
  const directOrExistingHosts = hostsWithJumpCapability.map((host) => {
    const jumpHostId = typeof host.jumpHostId === 'string' ? host.jumpHostId.trim() : '';
    const jumpHost = jumpHostId ? hostsById.get(jumpHostId) : null;

    if (!jumpHostId || jumpHostId === host.id || !jumpHost || !jumpHost.canBeJumpHost) {
      return {
        ...host,
        jumpHostId: '',
      };
    }

    return {
      ...host,
      jumpHostId,
    };
  });
  const normalizedHostsById = new Map(directOrExistingHosts.map((host) => [host.id, host]));

  return directOrExistingHosts.map((host) => {
    const jumpHost = host.jumpHostId ? normalizedHostsById.get(host.jumpHostId) : null;

    if (!host.jumpHostId || !jumpHost || jumpHost.jumpHostId) {
      return {
        ...host,
        jumpHostId: '',
      };
    }

    return {
      ...host,
      jumpHostId: host.jumpHostId,
    };
  });
}

function readVaultPayload(rawPayload) {
  if (!isPlainObject(rawPayload)) {
    throw new Error('本地数据无效。');
  }

  const hosts = Array.isArray(rawPayload.hosts)
    ? sanitizeHostJumpHostReferences(rawPayload.hosts.map((host) => readStoredHostRecord(host)))
    : [];

  return {
    version: vaultSchemaVersion,
    hosts: sortHostsByListOrder(hosts),
    sshKeys: Array.isArray(rawPayload.sshKeys) ? rawPayload.sshKeys.map((key) => readVaultKeyRecord(key)) : [],
    proxyProfiles: Array.isArray(rawPayload.proxyProfiles)
      ? rawPayload.proxyProfiles.map((profile) => readProxyProfile(profile))
      : [],
    knownHosts: Array.isArray(rawPayload.knownHosts)
      ? rawPayload.knownHosts.map((knownHost) => readKnownHost(knownHost))
      : [],
    settings: readAppSettings(rawPayload.settings),
    browserBookmarks: Array.isArray(rawPayload.browserBookmarks)
      ? rawPayload.browserBookmarks.map((collection) => readBookmarkCollection(collection))
      : [],
    preferences: readPreferenceStore(rawPayload.preferences),
    remoteConnectionProfiles: readRemoteConnectionProfiles(rawPayload.remoteConnectionProfiles),
  };
}

function toConfigHostRecord(host) {
  const { password: _password, passphrase: _passphrase, rootPassword: _rootPassword, ...configHost } = host;
  return configHost;
}

function toConfigKeyRecord(key) {
  const { privateKey: _privateKey, passphrase: _passphrase, ...configKey } = key;
  return configKey;
}

function toConfigProxyProfile(profile) {
  return {
    ...profile,
    config: {
      ...profile.config,
      password: '',
    },
  };
}

function toConfigSettings(settings) {
  return {
    ...settings,
    aiApiKey: '',
  };
}

function createConfigPayload(vault) {
  return {
    version: vaultSchemaVersion,
    hosts: sortHostsByListOrder(vault.hosts).map((host) => toConfigHostRecord(host)),
    sshKeys: vault.sshKeys.map((key) => toConfigKeyRecord(key)),
    proxyProfiles: vault.proxyProfiles.map((profile) => toConfigProxyProfile(profile)),
    knownHosts: vault.knownHosts,
    settings: toConfigSettings(vault.settings),
    browserBookmarks: vault.browserBookmarks,
    preferences: vault.preferences,
    remoteConnectionProfiles: vault.remoteConnectionProfiles.map((profile) => toRemoteConnectionProfileConfigRecord(profile)),
  };
}

function createVaultSecretsPayload(vault) {
  return {
    version: vaultSchemaVersion,
    hostSecrets: vault.hosts
      .map((host) => ({
        id: host.id,
        password: host.password,
        passphrase: host.passphrase,
        rootPassword: host.rootPassword,
      }))
      .filter((secret) => secret.password || secret.passphrase || secret.rootPassword),
    sshKeySecrets: vault.sshKeys.map((key) => ({
      id: key.id,
      privateKey: key.privateKey,
      passphrase: key.passphrase,
    })),
    proxyProfileSecrets: vault.proxyProfiles
      .map((profile) => ({
        id: profile.id,
        password: profile.config.password || '',
      }))
      .filter((secret) => secret.password),
    aiSecret: {
      apiKey: vault.settings.aiApiKey || '',
    },
    remoteConnectionProfileSecrets: vault.remoteConnectionProfiles
      .map((profile) => {
        const { secretValues } = splitRemoteConnectionProfileValues(profile.values);

        return {
          hostId: profile.hostId,
          appKey: profile.appKey,
          values: secretValues,
          updatedAt: profile.updatedAt,
        };
      })
      .filter((profile) => Object.keys(profile.values).length),
  };
}

function readConfigPayload(rawPayload) {
  if (!isPlainObject(rawPayload)) {
    throw new Error('配置数据无效。');
  }

  const hosts = Array.isArray(rawPayload.hosts)
    ? sanitizeHostJumpHostReferences(rawPayload.hosts.map((host) => readStoredHostRecord(host)))
    : [];

  return {
    version: vaultSchemaVersion,
    hosts: sortHostsByListOrder(hosts),
    sshKeys: Array.isArray(rawPayload.sshKeys) ? rawPayload.sshKeys.map((key) => readStoredKeyRecord(key)) : [],
    proxyProfiles: Array.isArray(rawPayload.proxyProfiles)
      ? rawPayload.proxyProfiles.map((profile) => readProxyProfile(profile))
      : [],
    knownHosts: Array.isArray(rawPayload.knownHosts)
      ? rawPayload.knownHosts.map((knownHost) => readKnownHost(knownHost))
      : [],
    settings: readAppSettings(rawPayload.settings),
    browserBookmarks: Array.isArray(rawPayload.browserBookmarks)
      ? rawPayload.browserBookmarks.map((collection) => readBookmarkCollection(collection))
      : [],
    preferences: readPreferenceStore(rawPayload.preferences),
    remoteConnectionProfiles: readRemoteConnectionProfiles(rawPayload.remoteConnectionProfiles),
  };
}

function readPersistedConfigWrapper(rawPayload) {
  if (!isPlainObject(rawPayload)) {
    throw new Error('配置文件格式无效。');
  }

  if (rawPayload.format === configStoreFormat && rawPayload.version === vaultSchemaVersion) {
    return readConfigPayload(rawPayload.payload);
  }

  if (
    'hosts' in rawPayload ||
    'sshKeys' in rawPayload ||
    'proxyProfiles' in rawPayload ||
    'knownHosts' in rawPayload ||
    'settings' in rawPayload ||
    'browserBookmarks' in rawPayload ||
    'preferences' in rawPayload
  ) {
    return readConfigPayload(rawPayload);
  }

  throw new Error('配置文件格式不受支持。');
}

function readHostSecretRecord(rawSecret) {
  if (!isPlainObject(rawSecret)) {
    throw new Error('主机凭据无效。');
  }

  return {
    id: readBoundedString(rawSecret.id, '主机 ID', 128),
    password: readBoundedString(rawSecret.password ?? '', 'SSH 密码', 4096, {
      required: false,
      trim: false,
      rejectLineBreaks: false,
    }),
    passphrase: readBoundedString(rawSecret.passphrase ?? '', 'SSH 密钥口令', 4096, {
      required: false,
      trim: false,
      rejectLineBreaks: false,
    }),
    rootPassword: readBoundedString(rawSecret.rootPassword ?? '', 'root 密码', 4096, {
      required: false,
      trim: false,
      rejectLineBreaks: true,
    }),
  };
}

function readSshKeySecretRecord(rawSecret) {
  if (!isPlainObject(rawSecret)) {
    throw new Error('密钥凭据无效。');
  }

  return {
    id: readBoundedString(rawSecret.id, '密钥 ID', 128),
    privateKey: ensurePrivateKeyText(rawSecret.privateKey, 'SSH 私钥内容'),
    passphrase: readBoundedString(rawSecret.passphrase ?? '', 'SSH 密钥口令', 4096, {
      required: false,
      trim: false,
      rejectLineBreaks: false,
    }),
  };
}

function readProxyProfileSecretRecord(rawSecret) {
  if (!isPlainObject(rawSecret)) {
    throw new Error('代理凭据无效。');
  }

  return {
    id: readBoundedString(rawSecret.id, '代理 ID', 128),
    password: readBoundedString(rawSecret.password ?? '', '代理密码', 4096, {
      required: false,
      trim: false,
      rejectLineBreaks: false,
    }),
  };
}

function readAiSecretRecord(rawSecret) {
  if (!isPlainObject(rawSecret)) {
    return { apiKey: '' };
  }

  return {
    apiKey: readAiApiKey(rawSecret.apiKey ?? ''),
  };
}

function readRemoteConnectionProfileSecretRecord(rawSecret) {
  const profile = readRemoteConnectionProfileRecord(rawSecret);
  const { secretValues } = splitRemoteConnectionProfileValues(profile.values);

  return {
    ...profile,
    values: secretValues,
  };
}

function readVaultSecretsPayload(rawPayload) {
  if (!isPlainObject(rawPayload)) {
    throw new Error('敏感数据无效。');
  }

  const rawKeySecrets = Array.isArray(rawPayload.sshKeySecrets)
    ? rawPayload.sshKeySecrets
    : Array.isArray(rawPayload.keySecrets)
      ? rawPayload.keySecrets
      : [];

  return {
    version: vaultSchemaVersion,
    hostSecrets: Array.isArray(rawPayload.hostSecrets)
      ? rawPayload.hostSecrets.map((secret) => readHostSecretRecord(secret))
      : [],
    sshKeySecrets: rawKeySecrets.map((secret) => readSshKeySecretRecord(secret)),
    proxyProfileSecrets: Array.isArray(rawPayload.proxyProfileSecrets)
      ? rawPayload.proxyProfileSecrets.map((secret) => readProxyProfileSecretRecord(secret))
      : [],
    aiSecret: readAiSecretRecord(rawPayload.aiSecret),
    remoteConnectionProfileSecrets: Array.isArray(rawPayload.remoteConnectionProfileSecrets)
      ? rawPayload.remoteConnectionProfileSecrets.map((secret) => readRemoteConnectionProfileSecretRecord(secret))
      : [],
  };
}

function isVaultSecretsPayload(rawPayload) {
  return isPlainObject(rawPayload) && (
    Array.isArray(rawPayload.hostSecrets) ||
    Array.isArray(rawPayload.sshKeySecrets) ||
    Array.isArray(rawPayload.keySecrets) ||
    Array.isArray(rawPayload.proxyProfileSecrets) ||
    Array.isArray(rawPayload.remoteConnectionProfileSecrets) ||
    isPlainObject(rawPayload.aiSecret)
  );
}

function mergeConfigAndSecrets(configPayload, secretsPayload) {
  const hostSecretsById = new Map(secretsPayload.hostSecrets.map((secret) => [secret.id, secret]));
  const keySecretsById = new Map(secretsPayload.sshKeySecrets.map((secret) => [secret.id, secret]));
  const proxySecretsById = new Map((secretsPayload.proxyProfileSecrets ?? []).map((secret) => [secret.id, secret]));
  const profileSecretsById = new Map((secretsPayload.remoteConnectionProfileSecrets ?? []).map((secret) => [`${secret.hostId}:${secret.appKey}`, secret]));

  const hosts = configPayload.hosts.map((host) => {
    const secret = hostSecretsById.get(host.id);

    return readStoredHostRecord({
      ...host,
      password: secret?.password ?? host.password,
      passphrase: secret?.passphrase ?? host.passphrase,
      rootPassword: secret?.rootPassword ?? host.rootPassword,
    });
  });

  const sshKeys = configPayload.sshKeys
    .map((key) => {
      const secret = keySecretsById.get(key.id);

      if (!secret) {
        return null;
      }

      return readVaultKeyRecord({
        ...key,
        privateKey: secret.privateKey,
        passphrase: secret.passphrase,
      });
    })
    .filter(Boolean);
  const proxyProfiles = configPayload.proxyProfiles.map((profile) => {
    const secret = proxySecretsById.get(profile.id);

    return readProxyProfile({
      ...profile,
      config: {
        ...profile.config,
        password: secret?.password ?? profile.config.password,
      },
    });
  });
  const remoteConnectionProfiles = configPayload.remoteConnectionProfiles.map((profile) => {
    const profileKey = `${profile.hostId}:${profile.appKey}`;
    const secret = profileSecretsById.get(profileKey);
    profileSecretsById.delete(profileKey);

    return readRemoteConnectionProfileRecord({
      ...profile,
      values: {
        ...profile.values,
        ...(secret?.values ?? {}),
      },
    });
  });

  for (const secret of profileSecretsById.values()) {
    remoteConnectionProfiles.push(readRemoteConnectionProfileRecord(secret));
  }

  return readVaultPayload({
    version: vaultSchemaVersion,
    hosts,
    sshKeys,
    proxyProfiles,
    knownHosts: configPayload.knownHosts,
    settings: {
      ...configPayload.settings,
      aiApiKey: secretsPayload.aiSecret?.apiKey || configPayload.settings.aiApiKey,
    },
    browserBookmarks: configPayload.browserBookmarks,
    preferences: configPayload.preferences,
    remoteConnectionProfiles,
  });
}

function readJsonFile(filePath, maxBytes, label) {
  const stats = fs.statSync(filePath);

  if (!stats.size || stats.size > maxBytes) {
    throw new Error(`${label}为空或超过大小限制。`);
  }

  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readPersistedVaultWrapper(rawPayload) {
  if (!isPlainObject(rawPayload) || rawPayload.format !== vaultFormat || rawPayload.version !== vaultSchemaVersion) {
    throw new Error('本地数据格式不受支持。');
  }

  if (rawPayload.protected) {
    const encrypted = readBoundedString(rawPayload.ciphertext, '本地数据密文', 8 * 1024 * 1024, { trim: false });
    const decrypted = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    return JSON.parse(decrypted);
  }

  return rawPayload.payload;
}

function writeConfigToDisk(vault) {
  const configPath = getConfigFilePath();
  const wrapper = {
    format: configStoreFormat,
    version: vaultSchemaVersion,
    updatedAt: new Date().toISOString(),
    payload: createConfigPayload(vault),
  };

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(wrapper, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function writeVaultSecretsToDisk(vault) {
  const vaultPath = getVaultFilePath();
  const payloadJson = JSON.stringify(createVaultSecretsPayload(vault));
  const storageInfo = getVaultStorageInfo();
  const wrapper = storageInfo.protected
    ? {
        format: vaultFormat,
        version: vaultSchemaVersion,
        protected: true,
        ciphertext: safeStorage.encryptString(payloadJson).toString('base64'),
      }
    : {
        format: vaultFormat,
        version: vaultSchemaVersion,
        protected: false,
        payload: vault,
      };

  fs.mkdirSync(path.dirname(vaultPath), { recursive: true });
  fs.writeFileSync(vaultPath, JSON.stringify(wrapper, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function writeVaultFiles(vault) {
  writeConfigToDisk(vault);
  writeVaultSecretsToDisk(vault);
}

function getVault() {
  if (vaultCache) {
    return vaultCache;
  }

  const configPath = getConfigFilePath();
  const vaultPath = getVaultFilePath();

  if (fs.existsSync(configPath)) {
    const configPayload = readPersistedConfigWrapper(readJsonFile(configPath, maxConfigStoreBytes, '配置文件'));
    let secretsPayload = readVaultSecretsPayload({});
    let shouldRewriteVaultFiles = false;

    if (fs.existsSync(vaultPath)) {
      const persistedPayload = readPersistedVaultWrapper(readJsonFile(vaultPath, maxVaultBytes, '敏感数据文件'));
      if (isVaultSecretsPayload(persistedPayload)) {
        secretsPayload = readVaultSecretsPayload(persistedPayload);
      } else {
        secretsPayload = readVaultSecretsPayload(createVaultSecretsPayload(readVaultPayload(persistedPayload)));
        shouldRewriteVaultFiles = true;
      }
    }

    vaultCache = mergeConfigAndSecrets(configPayload, secretsPayload);

    if (shouldRewriteVaultFiles) {
      writeVaultFiles(vaultCache);
    }

    return vaultCache;
  }

  if (!fs.existsSync(vaultPath)) {
    vaultCache = createEmptyVault();
    return vaultCache;
  }

  const persistedPayload = readPersistedVaultWrapper(readJsonFile(vaultPath, maxVaultBytes, '本地数据文件'));

  if (isVaultSecretsPayload(persistedPayload)) {
    vaultCache = mergeConfigAndSecrets(readConfigPayload({}), readVaultSecretsPayload(persistedPayload));
    return vaultCache;
  }

  vaultCache = readVaultPayload(persistedPayload);
  writeVaultFiles(vaultCache);
  return vaultCache;
}

function setVault(nextVault) {
  const previousSecrets = vaultCache ? JSON.stringify(createVaultSecretsPayload(vaultCache)) : '';
  const normalizedVault = readVaultPayload(nextVault);
  const nextSecrets = JSON.stringify(createVaultSecretsPayload(normalizedVault));
  vaultCache = normalizedVault;
  writeConfigToDisk(normalizedVault);

  if (previousSecrets !== nextSecrets || !fs.existsSync(getVaultFilePath())) {
    writeVaultSecretsToDisk(normalizedVault);
  }

  return normalizedVault;
}

function notifyVaultChanged(payload) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send('vault:changed', payload);
    }
  }
}

// ─── Log persistence ────────────────────────────────────────────────────────

function getLogFilePath() {
  return path.join(app.getPath('userData'), logFileName);
}

function readLogEntries() {
  const logPath = getLogFilePath();

  if (!fs.existsSync(logPath)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(logPath, 'utf8');
    const entries = JSON.parse(raw);

    if (!Array.isArray(entries)) {
      return [];
    }

    return entries.slice(0, maxLogEntries);
  } catch {
    return [];
  }
}

function writeLogEntries(entries) {
  const logPath = getLogFilePath();
  const trimmed = Array.isArray(entries) ? entries.slice(0, maxLogEntries) : [];

  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, JSON.stringify(trimmed, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function toRendererKeyRecord(key) {
  return {
    id: key.id,
    name: key.name,
    source: key.source,
    algorithm: key.algorithm,
    fingerprint: key.fingerprint,
    publicKey: key.publicKey,
    passphrase: key.passphrase,
    createdAt: key.createdAt,
    updatedAt: key.updatedAt,
  };
}

function createVaultSnapshot(vault = getVault()) {
  return {
    hosts: sortHostsByListOrder(vault.hosts),
    sshKeys: vault.sshKeys.map((key) => toRendererKeyRecord(key)),
    proxyProfiles: vault.proxyProfiles,
    knownHosts: vault.knownHosts,
    settings: vault.settings,
    browserBookmarks: vault.browserBookmarks,
    storage: getVaultStorageInfo(),
  };
}

function createPublicVaultSnapshotFromConfig(configPayload) {
  return {
    hosts: sortHostsByListOrder(configPayload.hosts).map((host) => ({
      ...host,
      password: '',
      passphrase: '',
      rootPassword: '',
    })),
    sshKeys: configPayload.sshKeys.map((key) => toRendererKeyRecord({
      ...key,
      passphrase: '',
    })),
    proxyProfiles: configPayload.proxyProfiles.map((profile) => toConfigProxyProfile(profile)),
    knownHosts: configPayload.knownHosts,
    settings: toConfigSettings(configPayload.settings),
    browserBookmarks: configPayload.browserBookmarks,
    storage: getVaultStorageInfo(),
  };
}

function createPublicVaultSnapshot() {
  const configPath = getConfigFilePath();

  if (fs.existsSync(configPath)) {
    return createPublicVaultSnapshotFromConfig(readPersistedConfigWrapper(readJsonFile(configPath, maxConfigStoreBytes, '配置文件')));
  }

  if (vaultCache) {
    return createPublicVaultSnapshotFromConfig(readConfigPayload(createConfigPayload(vaultCache)));
  }

  if (!fs.existsSync(getVaultFilePath())) {
    return createPublicVaultSnapshotFromConfig(readConfigPayload({}));
  }

  return createPublicVaultSnapshotFromConfig(readConfigPayload(createConfigPayload(getVault())));
}

function getConfigPreference(rawKey) {
  const key = readPreferenceKey(rawKey);
  return getVault().preferences[key] ?? null;
}

function setConfigPreference(rawKey, rawValue) {
  const key = readPreferenceKey(rawKey);
  const value = readPreferenceValue(rawValue);
  const currentVault = getVault();
  const nextPreferences = { ...currentVault.preferences };

  if (value === null) {
    delete nextPreferences[key];
  } else {
    nextPreferences[key] = value;
  }

  const nextVault = readVaultPayload({
    ...currentVault,
    preferences: nextPreferences,
  });

  vaultCache = nextVault;
  writeConfigToDisk(nextVault);
  notifyVaultChanged({ kind: 'preference', key });
  return nextVault.preferences[key] ?? null;
}

function getRemoteConnectionProfile(rawHostId, rawAppKey) {
  const hostId = readRemoteConnectionProfileHostId(rawHostId);
  const appKey = readRemoteConnectionProfileAppKey(rawAppKey);
  const profile = getVault().remoteConnectionProfiles.find((item) => item.hostId === hostId && item.appKey === appKey);

  return profile?.values ?? null;
}

function saveRemoteConnectionProfile(rawHostId, rawAppKey, rawValues) {
  const hostId = readRemoteConnectionProfileHostId(rawHostId);
  const appKey = readRemoteConnectionProfileAppKey(rawAppKey);
  const values = readRemoteConnectionProfileValues(rawValues);
  const currentVault = getVault();
  const updatedAt = new Date().toISOString();
  const nextProfile = {
    hostId,
    appKey,
    values,
    updatedAt,
  };
  const nextProfiles = [
    nextProfile,
    ...currentVault.remoteConnectionProfiles.filter((profile) => profile.hostId !== hostId || profile.appKey !== appKey),
  ];
  const nextVault = setVault({
    ...currentVault,
    remoteConnectionProfiles: nextProfiles,
  });

  notifyVaultChanged({ kind: 'preference', key: `remote-connection-profile:${hostId}:${appKey}` });
  return nextVault.remoteConnectionProfiles.find((profile) => profile.hostId === hostId && profile.appKey === appKey)?.values ?? values;
}

function upsertVaultCollections(rawPayload) {
  if (!isPlainObject(rawPayload)) {
    throw new Error('本地数据无效。');
  }

  const currentVault = getVault();
  const nextHosts = Array.isArray(rawPayload.hosts) ? rawPayload.hosts.map((host) => readStoredHostRecord(host)) : currentVault.hosts;
  const nextSettings = rawPayload.settings === undefined ? currentVault.settings : readAppSettings(rawPayload.settings);
  const nextProxyProfiles = Array.isArray(rawPayload.proxyProfiles)
    ? rawPayload.proxyProfiles.map((profile) => readProxyProfile(profile))
    : currentVault.proxyProfiles;
  const nextKnownHosts = Array.isArray(rawPayload.knownHosts)
    ? rawPayload.knownHosts.map((knownHost) => readKnownHost(knownHost))
    : currentVault.knownHosts;
  const nextSshKeys = Array.isArray(rawPayload.sshKeys)
    ? rawPayload.sshKeys.map((key) => {
        const nextKey = readStoredKeyRecord(key);
        const currentKey = currentVault.sshKeys.find((item) => item.id === nextKey.id);

        if (!currentKey) {
          throw new Error(`密钥「${nextKey.name}」缺少私钥内容，无法保存。`);
        }

        return {
          ...currentKey,
          ...nextKey,
        };
      })
    : currentVault.sshKeys;

  const nextVault = setVault({
    ...currentVault,
    hosts: nextHosts,
    sshKeys: nextSshKeys,
    proxyProfiles: nextProxyProfiles,
    knownHosts: nextKnownHosts,
    settings: nextSettings,
  });

  notifyVaultChanged({ kind: 'vault' });
  return createVaultSnapshot(nextVault);
}

function getKeyById(keyId) {
  if (!keyId) {
    return null;
  }

  return getVault().sshKeys.find((key) => key.id === keyId) ?? null;
}

function getHostById(hostId) {
  if (!hostId) {
    return null;
  }

  return getVault().hosts.find((host) => host.id === hostId) ?? null;
}

function getProxyProfileById(proxyProfileId) {
  if (!proxyProfileId) {
    return null;
  }

  return getVault().proxyProfiles.find((profile) => profile.id === proxyProfileId) ?? null;
}

function getProxyConfigForHost(host, label = '主机') {
  const proxyProfileId = readBoundedString(host.proxyProfileId ?? '', '代理 ID', 128, { required: false });

  if (!proxyProfileId) {
    return null;
  }

  const proxyProfile = getProxyProfileById(proxyProfileId);

  if (!proxyProfile) {
    throw new Error(`${label}选择的代理不存在，请重新选择。`);
  }

  return proxyProfile.config;
}

function readLocalTextFile(filePath, label, maxBytes = maxPrivateKeyBytes) {
  const absolutePath = readBoundedString(filePath, `${label}路径`, 2048);
  const stats = fs.statSync(absolutePath);

  if (!stats.isFile()) {
    throw new Error(`${label}不存在。`);
  }

  if (!stats.size || stats.size > maxBytes) {
    throw new Error(`${label}为空或超过大小限制。`);
  }

  return fs.readFileSync(absolutePath, 'utf8');
}

function readLegacyStoredKeyRecord(rawKey) {
  if (!isPlainObject(rawKey)) {
    throw new Error('密钥数据无效。');
  }

  return {
    id: readBoundedString(rawKey.id, '密钥 ID', 128),
    name: readBoundedString(rawKey.name, '密钥名称', 80),
    keyPath: readBoundedString(rawKey.keyPath, 'SSH 私钥路径', 1024),
    passphrase: readBoundedString(rawKey.passphrase ?? '', 'SSH 密钥口令', 4096, {
      required: false,
      trim: false,
      rejectLineBreaks: false,
    }),
    createdAt: readTimestampString(rawKey.createdAt, '密钥创建时间'),
    updatedAt: readTimestampString(rawKey.updatedAt, '密钥更新时间'),
  };
}

function base64UrlToBuffer(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const paddingLength = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(`${normalized}${'='.repeat(paddingLength)}`, 'base64');
}

function encodeSshBuffer(buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(buffer.length, 0);
  return Buffer.concat([length, buffer]);
}

function encodeSshString(value) {
  return encodeSshBuffer(Buffer.from(value, 'utf8'));
}

function createRsaOpenSshPublicKey(publicKeyObject) {
  const jwk = publicKeyObject.export({ format: 'jwk' });

  if (!jwk?.n || !jwk?.e) {
    throw new Error('无法导出 RSA 公钥。');
  }

  const body = Buffer.concat([
    encodeSshString('ssh-rsa'),
    encodeSshBuffer(base64UrlToBuffer(jwk.e)),
    encodeSshBuffer(base64UrlToBuffer(jwk.n)),
  ]);

  return `ssh-rsa ${body.toString('base64')}`;
}

function createPublicKeyFingerprint(publicKeyText) {
  const trimmedValue = publicKeyText.trim();

  if (!trimmedValue) {
    return '';
  }

  const [algorithm, encodedKey] = trimmedValue.split(/\s+/, 3);

  if (algorithm && encodedKey && /^ssh-|^ecdsa-|^sk-/.test(algorithm)) {
    return `SHA256:${crypto.createHash('sha256').update(Buffer.from(encodedKey, 'base64')).digest('base64').replace(/=+$/u, '')}`;
  }

  try {
    const publicKeyObject = crypto.createPublicKey(trimmedValue);
    const der = publicKeyObject.export({ type: 'spki', format: 'der' });
    return `SHA256:${crypto.createHash('sha256').update(der).digest('base64').replace(/=+$/u, '')}`;
  } catch {
    return '';
  }
}

function deriveKeyDetails(privateKey, passphrase, rawPublicKey = '') {
  const publicKey = ensurePublicKeyText(rawPublicKey);

  if (publicKey) {
    const algorithmToken = publicKey.trim().split(/\s+/, 1)[0];
    return {
      algorithm: algorithmToken ? algorithmToken.replace(/^ssh-/u, '').toUpperCase() : 'SSH',
      publicKey,
      fingerprint: createPublicKeyFingerprint(publicKey),
    };
  }

  try {
    const privateKeyObject = crypto.createPrivateKey({
      key: privateKey,
      format: 'pem',
      passphrase: passphrase || undefined,
    });
    const publicKeyObject = crypto.createPublicKey(privateKeyObject);
    let derivedPublicKey = '';

    if (publicKeyObject.asymmetricKeyType === 'rsa') {
      derivedPublicKey = createRsaOpenSshPublicKey(publicKeyObject);
    }

    return {
      algorithm: String(publicKeyObject.asymmetricKeyType || 'SSH').toUpperCase(),
      publicKey: derivedPublicKey,
      fingerprint: createPublicKeyFingerprint(derivedPublicKey),
    };
  } catch {
    return {
      algorithm: 'SSH',
      publicKey: '',
      fingerprint: '',
    };
  }
}

function createVaultKeyRecord({ name, privateKey, publicKey = '', passphrase = '', source = 'imported', createdAt }) {
  const timestamp = createdAt || new Date().toISOString();
  const nextPrivateKey = ensurePrivateKeyText(privateKey, 'SSH 私钥内容');
  const nextPassphrase = readBoundedString(passphrase, 'SSH 密钥口令', 4096, {
    required: false,
    trim: false,
    rejectLineBreaks: false,
  });
  const derivedDetails = deriveKeyDetails(nextPrivateKey, nextPassphrase, publicKey);

  return {
    id: crypto.randomUUID(),
    name: readBoundedString(name, '密钥名称', 80),
    source,
    algorithm: derivedDetails.algorithm,
    fingerprint: derivedDetails.fingerprint,
    publicKey: derivedDetails.publicKey,
    privateKey: nextPrivateKey,
    passphrase: nextPassphrase,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function ensureNoDuplicateKey(nextKey, currentKeys, ignoreKeyId = '') {
  const normalizedPrivateKey = nextKey.privateKey.trim();

  for (const key of currentKeys) {
    if (key.id === ignoreKeyId) {
      continue;
    }

    if (key.privateKey.trim() === normalizedPrivateKey) {
      throw new Error(`相同 SSH 私钥已存在：${key.name}。`);
    }

    if (nextKey.fingerprint && key.fingerprint && key.fingerprint === nextKey.fingerprint) {
      throw new Error(`相同 SSH 密钥指纹已存在：${key.name}。`);
    }
  }
}

function importKeyPairToVault(rawPayload) {
  if (!isPlainObject(rawPayload)) {
    throw new Error('导入密钥参数无效。');
  }

  const privateKey = readLocalTextFile(rawPayload.privateKeyPath, 'SSH 私钥');
  const publicKeyPath = readBoundedString(rawPayload.publicKeyPath ?? '', 'SSH 公钥路径', 2048, { required: false });
  const publicKey = publicKeyPath ? readLocalTextFile(publicKeyPath, 'SSH 公钥', 128 * 1024) : '';
  const nextKey = createVaultKeyRecord({
    name: readBoundedString(rawPayload.name, '密钥名称', 80),
    privateKey,
    publicKey,
    passphrase: readBoundedString(rawPayload.passphrase ?? '', 'SSH 密钥口令', 4096, {
      required: false,
      trim: false,
      rejectLineBreaks: false,
    }),
    source: 'imported',
  });
  const currentVault = getVault();

  ensureNoDuplicateKey(nextKey, currentVault.sshKeys);
  const nextVault = setVault({
    ...currentVault,
    sshKeys: [nextKey, ...currentVault.sshKeys],
  });

  notifyVaultChanged({ kind: 'vault' });
  return { snapshot: createVaultSnapshot(nextVault), key: toRendererKeyRecord(nextKey) };
}

function generateRsaKeyPairInVault(rawPayload) {
  if (!isPlainObject(rawPayload)) {
    throw new Error('生成密钥参数无效。');
  }

  const name = readBoundedString(rawPayload.name, '密钥名称', 80);
  const modulusLength = readIntegerInRange(rawPayload.modulusLength, 'RSA 位数', 2048, 4096);
  const passphrase = readBoundedString(rawPayload.passphrase ?? '', 'SSH 密钥口令', 4096, {
    required: false,
    trim: false,
    rejectLineBreaks: false,
  });
  const generatedPair = crypto.generateKeyPairSync('rsa', {
    modulusLength,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem',
    },
    privateKeyEncoding: passphrase
      ? {
          type: 'pkcs8',
          format: 'pem',
          cipher: 'aes-256-cbc',
          passphrase,
        }
      : {
          type: 'pkcs8',
          format: 'pem',
        },
  });
  const publicKeyObject = crypto.createPublicKey(generatedPair.publicKey);
  const nextKey = createVaultKeyRecord({
    name,
    privateKey: generatedPair.privateKey,
    publicKey: createRsaOpenSshPublicKey(publicKeyObject),
    passphrase,
    source: 'generated',
  });
  const currentVault = getVault();

  ensureNoDuplicateKey(nextKey, currentVault.sshKeys);
  const nextVault = setVault({
    ...currentVault,
    sshKeys: [nextKey, ...currentVault.sshKeys],
  });

  notifyVaultChanged({ kind: 'vault' });
  return { snapshot: createVaultSnapshot(nextVault), key: toRendererKeyRecord(nextKey) };
}

function buildDisplayHost(rawHost, host, port, username, matchedStoredHost = null) {
  const id = readBoundedString(rawHost.id ?? matchedStoredHost?.id ?? '', '主机 ID', 128, { required: false });

  return {
    ...(id ? { id } : {}),
    name: readBoundedString(rawHost.name ?? '', '主机名称', 80, { required: false }) || host,
    address: host,
    port,
    username,
    authMethod: rawHost.authMethod,
    privilegeMode: readPrivilegeMode(rawHost.privilegeMode ?? matchedStoredHost?.privilegeMode),
    systemType: readRemoteSystemType(rawHost.systemType),
    systemName: readBoundedString(rawHost.systemName ?? '', '系统名称', 160, { required: false }),
  };
}

function buildPrivilegeConfigFromHostRequest(rawHost, matchedStoredHost = null) {
  const privilegeMode = readPrivilegeMode(rawHost.privilegeMode ?? matchedStoredHost?.privilegeMode);

  if (privilegeMode !== 'su-root') {
    return { mode: 'sudo', rootPassword: '' };
  }

  const rawRootPassword = typeof rawHost.rootPassword === 'string' ? rawHost.rootPassword : '';
  const rootPassword = readBoundedString(
    rawRootPassword || (matchedStoredHost?.privilegeMode === 'su-root' ? matchedStoredHost.rootPassword : ''),
    'root 密码',
    4096,
    {
      trim: false,
      rejectLineBreaks: true,
    },
  );

  if (!rootPassword) {
    throw new Error('该主机已选择 su root 提权，但本机没有保存 root 密码，请编辑主机配置。');
  }

  return { mode: 'su-root', rootPassword };
}

function buildSshConfigFromHostRequest(rawHost, matchedStoredHost = null) {
  if (!isPlainObject(rawHost)) {
    throw new Error('主机信息无效。');
  }

  const host = readBoundedString(rawHost.address, '主机地址', 255);
  const username = readBoundedString(rawHost.username, '用户名', 128);
  const port = Number(rawHost.port);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('端口必须是 1 到 65535 之间的整数。');
  }

  if (rawHost.authMethod !== 'password' && rawHost.authMethod !== 'key' && rawHost.authMethod !== 'agent') {
    throw new Error('登录方式无效。');
  }

  const sshConfig = {
    host,
    port,
    username,
    readyTimeout: 15000,
    keepaliveInterval: 10000,
    keepaliveCountMax: 3,
  };

  if (rawHost.authMethod === 'password') {
    const rawPassword = typeof rawHost.password === 'string' ? rawHost.password : '';
    const password = readBoundedString(
      rawPassword || (matchedStoredHost?.authMethod === 'password' ? matchedStoredHost.password : ''),
      'SSH 密码',
      4096,
      {
        trim: false,
        rejectLineBreaks: false,
      },
    );
    sshConfig.password = password;
  } else if (rawHost.authMethod === 'key') {
    const keyId = readBoundedString(
      rawHost.keyId || (matchedStoredHost?.authMethod === 'key' ? matchedStoredHost.keyId : ''),
      '密钥 ID',
      128,
      { required: false },
    );
    const storedKey = keyId ? getKeyById(keyId) : null;
    const inlinePrivateKey = typeof rawHost.privateKey === 'string' ? rawHost.privateKey : '';

    if (storedKey) {
      sshConfig.privateKey = storedKey.privateKey;
    } else if (inlinePrivateKey) {
      sshConfig.privateKey = ensurePrivateKeyText(inlinePrivateKey, 'SSH 私钥内容');
    } else {
      const keyPath = readBoundedString(rawHost.keyPath, 'SSH 私钥路径', 1024);
      sshConfig.privateKey = fs.readFileSync(keyPath);
    }

    const rawPassphrase = typeof rawHost.passphrase === 'string' && rawHost.passphrase
      ? rawHost.passphrase
      : storedKey?.passphrase || (matchedStoredHost?.authMethod === 'key' ? matchedStoredHost.passphrase : '');

    if (rawPassphrase) {
      sshConfig.passphrase = readBoundedString(rawPassphrase, 'SSH 密钥口令', 4096, {
        trim: false,
        rejectLineBreaks: false,
      });
    }
  } else {
    sshConfig.authHandler = createDefaultUserCredentialAuthHandler(username);
  }

  return {
    displayHost: buildDisplayHost(rawHost, host, port, username, matchedStoredHost),
    sshConfig,
  };
}

function validateHostRequest(rawHost) {
  if (!isPlainObject(rawHost)) {
    throw new Error('主机信息无效。');
  }

  const hostId = readBoundedString(rawHost.id ?? '', '主机 ID', 128, { required: false });
  const storedHost = hostId ? getHostById(hostId) : null;
  const rawHostAddress = typeof rawHost.address === 'string' ? rawHost.address.trim() : '';
  const rawHostPort = Number(rawHost.port);
  const rawUsername = typeof rawHost.username === 'string' ? rawHost.username.trim() : '';
  const matchedStoredHost = storedHost &&
    storedHost.address === rawHostAddress &&
    storedHost.port === rawHostPort &&
    storedHost.username === rawUsername
    ? storedHost
    : null;
  const { displayHost, sshConfig } = buildSshConfigFromHostRequest(rawHost, matchedStoredHost);
  const privilegeConfig = buildPrivilegeConfigFromHostRequest(rawHost, matchedStoredHost);
  const jumpHostId = readBoundedString(rawHost.jumpHostId || matchedStoredHost?.jumpHostId || '', '跳板机 ID', 128, { required: false });
  const proxyProfileId = readBoundedString(rawHost.proxyProfileId || matchedStoredHost?.proxyProfileId || '', '代理 ID', 128, { required: false });
  let jumpHost = null;
  let jumpSshConfig = null;
  let proxyConfig = null;
  let jumpProxyConfig = null;

  if (jumpHostId && proxyProfileId) {
    throw new Error('当前不能同时为目标主机选择代理和跳板机。');
  }

  if (!jumpHostId && proxyProfileId) {
    proxyConfig = getProxyConfigForHost({ proxyProfileId }, '目标主机');
  }

  if (jumpHostId) {
    if (jumpHostId === hostId) {
      throw new Error('目标主机不能选择自己作为跳板机。');
    }

    jumpHost = getHostById(jumpHostId);

    if (!jumpHost) {
      throw new Error('跳板机不存在，请重新选择。');
    }

    if (!jumpHost.canBeJumpHost) {
      throw new Error(`主机「${jumpHost.name}」未勾选“可作为跳板机”，请先编辑该主机。`);
    }

    if (jumpHost.jumpHostId) {
      throw new Error('当前仅支持单层跳板机，请选择一台直连主机作为跳板。');
    }

    if (jumpHost.authMethod === 'password' && !jumpHost.password) {
      throw new Error(`跳板机「${jumpHost.name}」未保存 SSH 密码，请先完善跳板机凭据。`);
    }

    const jumpRequest = {
      ...jumpHost,
      authMethod: jumpHost.authMethod,
    };
    const jumpConfig = buildSshConfigFromHostRequest(jumpRequest, jumpHost);
    jumpSshConfig = jumpConfig.sshConfig;
    jumpProxyConfig = getProxyConfigForHost(jumpHost, `跳板机「${jumpHost.name}」`);
    displayHost.jumpHost = {
      id: jumpHost.id,
      name: jumpHost.name,
      address: jumpHost.address,
      port: jumpHost.port,
      username: jumpHost.username,
    };
  }

  return {
    displayHost,
    sshConfig,
    privilegeConfig,
    proxyConfig,
    jumpSshConfig,
    jumpProxyConfig,
    jumpHost: displayHost.jumpHost ?? null,
  };
}

function getDefaultSshAgentValues() {
  const agentValues = [];
  const sshAuthSock = typeof process.env.SSH_AUTH_SOCK === 'string' ? process.env.SSH_AUTH_SOCK.trim() : '';

  if (sshAuthSock) {
    agentValues.push(sshAuthSock);
  }

  if (process.platform === 'win32') {
    agentValues.push('\\\\.\\pipe\\openssh-ssh-agent', 'pageant');
  }

  return Array.from(new Set(agentValues));
}

function readDefaultIdentityKeys() {
  const homeDir = os.homedir();

  if (!homeDir) {
    return [];
  }

  return defaultIdentityFileNames
    .map((fileName) => path.join(homeDir, '.ssh', fileName))
    .filter((identityPath) => {
      try {
        return fs.statSync(identityPath).isFile();
      } catch {
        return false;
      }
    })
    .map((identityPath) => {
      try {
        return fs.readFileSync(identityPath);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function createDefaultUserCredentialAuthHandler(username) {
  return [
    ...getDefaultSshAgentValues().map((agent) => ({
      type: 'agent',
      username,
      agent,
    })),
    ...readDefaultIdentityKeys().map((key) => ({
      type: 'publickey',
      username,
      key,
    })),
  ];
}

function readPrivateKeyTextFromBase64(base64Value) {
  const value = readBoundedString(base64Value, 'SSH 私钥内容', 2 * 1024 * 1024, { trim: false });

  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error('SSH 私钥内容无效。');
  }

  const privateKeyText = Buffer.from(value, 'base64').toString('utf8');
  return ensurePrivateKeyText(privateKeyText, 'SSH 私钥内容');
}

function buildConfigBundle(vault = getVault()) {
  return {
    format: configBundleFormat,
    version: configBundleVersion,
    exportedAt: new Date().toISOString(),
    hosts: sortHostsByListOrder(vault.hosts),
    sshKeys: vault.sshKeys.map((key) => ({
      ...toRendererKeyRecord(key),
      privateKeyBase64: Buffer.from(key.privateKey, 'utf8').toString('base64'),
    })),
    proxyProfiles: vault.proxyProfiles,
    knownHosts: vault.knownHosts,
    settings: vault.settings,
    browserBookmarks: vault.browserBookmarks,
    remoteConnectionProfiles: vault.remoteConnectionProfiles,
  };
}

function readConfigImportPayload(rawPayload) {
  if (!isPlainObject(rawPayload) || rawPayload.format !== configBundleFormat || !Array.isArray(rawPayload.hosts) || !Array.isArray(rawPayload.sshKeys)) {
    throw new Error('不是受支持的 ShellDesk 完整备份文件。');
  }

  if (rawPayload.version !== 1 && rawPayload.version !== configBundleVersion) {
    throw new Error('备份文件版本不受支持。');
  }

  const hosts = sortHostsByListOrder(sanitizeHostJumpHostReferences(rawPayload.hosts.map((host) => readStoredHostRecord(host))));
  const proxyProfiles = Array.isArray(rawPayload.proxyProfiles)
    ? rawPayload.proxyProfiles.map((profile) => readProxyProfile(profile))
    : [];
  const knownHosts = Array.isArray(rawPayload.knownHosts)
    ? rawPayload.knownHosts.map((knownHost) => readKnownHost(knownHost))
    : [];
  const sshKeys = rawPayload.sshKeys.map((key) => {
    const isLegacyKey = typeof key.keyPath === 'string' && !('source' in key);
    const baseKey = isLegacyKey ? readLegacyStoredKeyRecord(key) : readStoredKeyRecord(key);
    const nextKey = createVaultKeyRecord({
      name: baseKey.name,
      privateKey: readPrivateKeyTextFromBase64(key.privateKeyBase64),
      publicKey: typeof key.publicKey === 'string' ? key.publicKey : '',
      passphrase: baseKey.passphrase,
      source: typeof key.source === 'string' && key.source === 'generated' ? 'generated' : 'imported',
      createdAt: baseKey.createdAt,
    });

    nextKey.id = baseKey.id;
    nextKey.updatedAt = baseKey.updatedAt;
    return nextKey;
  });

  return {
    hosts,
    sshKeys,
    proxyProfiles,
    knownHosts,
    settings: readAppSettings(rawPayload.settings),
    browserBookmarks: Array.isArray(rawPayload.browserBookmarks)
      ? rawPayload.browserBookmarks.map((collection) => readBookmarkCollection(collection))
      : [],
    remoteConnectionProfiles: readRemoteConnectionProfiles(rawPayload.remoteConnectionProfiles),
  };
}

function saveBrowserBookmarks(rawScope, rawBookmarks) {
  const scope = readBoundedString(rawScope, '书签范围', 255);
  const bookmarks = Array.isArray(rawBookmarks) ? rawBookmarks.map((bookmark) => readBrowserBookmark(bookmark)) : [];
  const currentVault = getVault();
  const nextCollection = {
    scope,
    bookmarks,
    updatedAt: new Date().toISOString(),
  };
  const nextBookmarkCollections = [
    nextCollection,
    ...currentVault.browserBookmarks.filter((collection) => collection.scope !== scope),
  ].filter((collection) => collection.bookmarks.length);
  const nextVault = readVaultPayload({
    ...currentVault,
    browserBookmarks: nextBookmarkCollections,
  });

  vaultCache = nextVault;
  writeConfigToDisk(nextVault);
  notifyVaultChanged({ kind: 'bookmarks', scope });
  return nextVault.browserBookmarks.find((collection) => collection.scope === scope)?.bookmarks ?? [];
}

module.exports = {
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
  validateHostRequest,
  writeLogEntries,
};
