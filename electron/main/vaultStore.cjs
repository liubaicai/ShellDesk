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
    desktopWallpaperMode: 'default',
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

  return {
    language: rawSettings.language === 'zh-CN' || rawSettings.language === 'en-US' ? rawSettings.language : defaults.language,
    interfaceFont: readFontFamily(rawSettings.interfaceFont, defaults.interfaceFont),
    theme: rawSettings.theme === 'light' || rawSettings.theme === 'system' ? rawSettings.theme : defaults.theme,
    accentColor: readColorHex(rawSettings.accentColor, '强调色', defaults.accentColor),
    defaultHostView: rawSettings.defaultHostView === 'list' ? 'list' : 'grid',
    desktopWallpaperMode: (
      rawSettings.desktopWallpaperMode === 'custom' &&
      typeof rawSettings.desktopWallpaperDataUrl === 'string' &&
      rawSettings.desktopWallpaperDataUrl
    ) ? 'custom' : 'default',
    desktopWallpaperDataUrl: readDesktopWallpaperDataUrl(
      rawSettings.desktopWallpaperDataUrl,
      defaults.desktopWallpaperDataUrl,
    ),
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
    settings: createDefaultSettings(),
    browserBookmarks: [],
    preferences: {},
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

function readVaultPayload(rawPayload) {
  if (!isPlainObject(rawPayload)) {
    throw new Error('本地数据无效。');
  }

  return {
    version: vaultSchemaVersion,
    hosts: Array.isArray(rawPayload.hosts) ? rawPayload.hosts.map((host) => readStoredHostRecord(host)) : [],
    sshKeys: Array.isArray(rawPayload.sshKeys) ? rawPayload.sshKeys.map((key) => readVaultKeyRecord(key)) : [],
    settings: readAppSettings(rawPayload.settings),
    browserBookmarks: Array.isArray(rawPayload.browserBookmarks)
      ? rawPayload.browserBookmarks.map((collection) => readBookmarkCollection(collection))
      : [],
    preferences: readPreferenceStore(rawPayload.preferences),
  };
}

function toConfigHostRecord(host) {
  const { password: _password, passphrase: _passphrase, ...configHost } = host;
  return configHost;
}

function toConfigKeyRecord(key) {
  const { privateKey: _privateKey, passphrase: _passphrase, ...configKey } = key;
  return configKey;
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
    hosts: vault.hosts.map((host) => toConfigHostRecord(host)),
    sshKeys: vault.sshKeys.map((key) => toConfigKeyRecord(key)),
    settings: toConfigSettings(vault.settings),
    browserBookmarks: vault.browserBookmarks,
    preferences: vault.preferences,
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
      }))
      .filter((secret) => secret.password || secret.passphrase),
    sshKeySecrets: vault.sshKeys.map((key) => ({
      id: key.id,
      privateKey: key.privateKey,
      passphrase: key.passphrase,
    })),
    aiSecret: {
      apiKey: vault.settings.aiApiKey || '',
    },
  };
}

function readConfigPayload(rawPayload) {
  if (!isPlainObject(rawPayload)) {
    throw new Error('配置数据无效。');
  }

  return {
    version: vaultSchemaVersion,
    hosts: Array.isArray(rawPayload.hosts) ? rawPayload.hosts.map((host) => readStoredHostRecord(host)) : [],
    sshKeys: Array.isArray(rawPayload.sshKeys) ? rawPayload.sshKeys.map((key) => readStoredKeyRecord(key)) : [],
    settings: readAppSettings(rawPayload.settings),
    browserBookmarks: Array.isArray(rawPayload.browserBookmarks)
      ? rawPayload.browserBookmarks.map((collection) => readBookmarkCollection(collection))
      : [],
    preferences: readPreferenceStore(rawPayload.preferences),
  };
}

function readPersistedConfigWrapper(rawPayload) {
  if (!isPlainObject(rawPayload)) {
    throw new Error('配置文件格式无效。');
  }

  if (rawPayload.format === configStoreFormat && rawPayload.version === vaultSchemaVersion) {
    return readConfigPayload(rawPayload.payload);
  }

  if ('hosts' in rawPayload || 'sshKeys' in rawPayload || 'settings' in rawPayload || 'browserBookmarks' in rawPayload || 'preferences' in rawPayload) {
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

function readAiSecretRecord(rawSecret) {
  if (!isPlainObject(rawSecret)) {
    return { apiKey: '' };
  }

  return {
    apiKey: readAiApiKey(rawSecret.apiKey ?? ''),
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
    aiSecret: readAiSecretRecord(rawPayload.aiSecret),
  };
}

function isVaultSecretsPayload(rawPayload) {
  return isPlainObject(rawPayload) && (
    Array.isArray(rawPayload.hostSecrets) ||
    Array.isArray(rawPayload.sshKeySecrets) ||
    Array.isArray(rawPayload.keySecrets) ||
    isPlainObject(rawPayload.aiSecret)
  );
}

function mergeConfigAndSecrets(configPayload, secretsPayload) {
  const hostSecretsById = new Map(secretsPayload.hostSecrets.map((secret) => [secret.id, secret]));
  const keySecretsById = new Map(secretsPayload.sshKeySecrets.map((secret) => [secret.id, secret]));

  const hosts = configPayload.hosts.map((host) => {
    const secret = hostSecretsById.get(host.id);

    return readStoredHostRecord({
      ...host,
      password: secret?.password ?? host.password,
      passphrase: secret?.passphrase ?? host.passphrase,
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

  return readVaultPayload({
    version: vaultSchemaVersion,
    hosts,
    sshKeys,
    settings: {
      ...configPayload.settings,
      aiApiKey: secretsPayload.aiSecret?.apiKey || configPayload.settings.aiApiKey,
    },
    browserBookmarks: configPayload.browserBookmarks,
    preferences: configPayload.preferences,
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
    hosts: vault.hosts,
    sshKeys: vault.sshKeys.map((key) => toRendererKeyRecord(key)),
    settings: vault.settings,
    browserBookmarks: vault.browserBookmarks,
    storage: getVaultStorageInfo(),
  };
}

function createPublicVaultSnapshotFromConfig(configPayload) {
  return {
    hosts: configPayload.hosts.map((host) => ({
      ...host,
      password: '',
      passphrase: '',
    })),
    sshKeys: configPayload.sshKeys.map((key) => toRendererKeyRecord({
      ...key,
      passphrase: '',
    })),
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

function upsertVaultCollections(rawPayload) {
  if (!isPlainObject(rawPayload)) {
    throw new Error('本地数据无效。');
  }

  const currentVault = getVault();
  const nextHosts = Array.isArray(rawPayload.hosts) ? rawPayload.hosts.map((host) => readStoredHostRecord(host)) : currentVault.hosts;
  const nextSettings = rawPayload.settings === undefined ? currentVault.settings : readAppSettings(rawPayload.settings);
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
      throw new Error(`密钥「${key.name}」已经存在。`);
    }

    if (nextKey.fingerprint && key.fingerprint && key.fingerprint === nextKey.fingerprint) {
      throw new Error(`密钥「${key.name}」已经存在。`);
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

function validateHostRequest(rawHost) {
  if (!isPlainObject(rawHost)) {
    throw new Error('主机信息无效。');
  }

  const hostId = readBoundedString(rawHost.id ?? '', '主机 ID', 128, { required: false });
  const name = readBoundedString(rawHost.name ?? '', '主机名称', 80, { required: false });
  const host = readBoundedString(rawHost.address, '主机地址', 255);
  const username = readBoundedString(rawHost.username, '用户名', 128);
  const port = Number(rawHost.port);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('端口必须是 1 到 65535 之间的整数。');
  }

  if (rawHost.authMethod !== 'password' && rawHost.authMethod !== 'key' && rawHost.authMethod !== 'agent') {
    throw new Error('登录方式无效。');
  }

  const storedHost = hostId ? getHostById(hostId) : null;
  const matchedStoredHost = storedHost &&
    storedHost.address === host &&
    storedHost.port === port &&
    storedHost.username === username
    ? storedHost
    : null;

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
    displayHost: {
      name: name || host,
      address: host,
      port,
      username,
      authMethod: rawHost.authMethod,
      systemType: readRemoteSystemType(rawHost.systemType),
      systemName: readBoundedString(rawHost.systemName ?? '', '系统名称', 160, { required: false }),
    },
    sshConfig,
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
    hosts: vault.hosts,
    sshKeys: vault.sshKeys.map((key) => ({
      ...toRendererKeyRecord(key),
      privateKeyBase64: Buffer.from(key.privateKey, 'utf8').toString('base64'),
    })),
    settings: vault.settings,
    browserBookmarks: vault.browserBookmarks,
  };
}

function readConfigImportPayload(rawPayload) {
  if (!isPlainObject(rawPayload) || rawPayload.format !== configBundleFormat || !Array.isArray(rawPayload.hosts) || !Array.isArray(rawPayload.sshKeys)) {
    throw new Error('不是受支持的 ShellDesk 完整备份文件。');
  }

  if (rawPayload.version !== 1 && rawPayload.version !== configBundleVersion) {
    throw new Error('备份文件版本不受支持。');
  }

  const hosts = rawPayload.hosts.map((host) => readStoredHostRecord(host));
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
    settings: readAppSettings(rawPayload.settings),
    browserBookmarks: Array.isArray(rawPayload.browserBookmarks)
      ? rawPayload.browserBookmarks.map((collection) => readBookmarkCollection(collection))
      : [],
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
  getVault,
  importKeyPairToVault,
  notifyVaultChanged,
  readConfigImportPayload,
  readLogEntries,
  saveBrowserBookmarks,
  setConfigPreference,
  setVault,
  upsertVaultCollections,
  validateHostRequest,
  writeLogEntries,
};
