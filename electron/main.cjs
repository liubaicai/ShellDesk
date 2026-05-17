const { app, BrowserWindow, dialog, ipcMain, nativeTheme, safeStorage, session, shell } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { Client } = require('ssh2');
const mysql = require('mysql2/promise');
const Redis = require('ioredis');

const devServerUrl = process.env.VITE_DEV_SERVER_URL;
const activeConnections = new Map();
const configBundleFormat = 'gui-ssh-config';
const configBundleVersion = 2;
const maxConfigImportBytes = 20 * 1024 * 1024;
const maxPrivateKeyBytes = 1024 * 1024;
const maxRemoteTextFileBytes = 5 * 1024 * 1024;
const maxRemoteTextWriteBytes = 10 * 1024 * 1024;
const maxVaultBytes = 25 * 1024 * 1024;
const vaultFileName = 'vault.json';
const vaultFormat = 'gui-ssh-vault';
const vaultSchemaVersion = 1;
const bookmarkScopePrefix = 'gui-ssh:browser-bookmarks:';
const logFileName = 'logs.json';
const maxLogEntries = 500;
const accentColorChoices = ['#43c7ff', '#77f4c5', '#ffb347', '#ff7b9c', '#9f8cff', '#8bd3ff', '#ff8c42'];
const uiFontChoices = ['Space Grotesk', 'Segoe UI', 'Inter'];
let vaultCache = null;

nativeTheme.themeSource = 'dark';

function createDefaultSettings() {
  return {
    language: 'zh-CN',
    interfaceFont: 'Space Grotesk',
    theme: 'dark',
    accentColor: accentColorChoices[0],
    defaultHostView: 'grid',
    rememberPasswords: true,
    rememberKeyPassphrases: true,
    terminalFontSize: 13,
    terminalCursorStyle: 'block',
    terminalScrollback: 10000,
    terminalCopyOnSelect: true,
  };
}

function toErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }

  return '操作失败。';
}

function toConnectionErrorMessage(error) {
  const message = toErrorMessage(error);

  if (/All configured authentication methods failed/i.test(message)) {
    return 'SSH 认证失败：请检查用户名、密码、私钥或密钥口令，或确认服务器允许当前认证方式。';
  }

  if (/Cannot parse privateKey|Encrypted private OpenSSH key detected|passphrase/i.test(message)) {
    return 'SSH 私钥读取失败：请确认私钥文件格式正确；如果私钥已加密，请填写密钥口令。';
  }

  if (/ECONNREFUSED|Connection refused/i.test(message)) {
    return 'SSH 连接被拒绝：请检查主机地址、端口和 sshd 服务状态。';
  }

  if (/Timed out|readyTimeout|ETIMEDOUT/i.test(message)) {
    return 'SSH 连接超时：请检查网络连通性、防火墙和端口。';
  }

  return message;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readBoundedString(value, label, maxLength, options = {}) {
  const { required = true, trim = true, rejectLineBreaks = true } = options;

  if (typeof value !== 'string') {
    throw new Error(`${label}无效。`);
  }

  const nextValue = trim ? value.trim() : value;

  if (required && !nextValue) {
    throw new Error(`请输入${label}。`);
  }

  if (nextValue.length > maxLength || nextValue.includes('\0') || (rejectLineBreaks && /[\r\n]/.test(nextValue))) {
    throw new Error(`${label}无效。`);
  }

  return nextValue;
}

function readBoolean(value, label, fallback) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof fallback === 'boolean') {
    return fallback;
  }

  throw new Error(`${label}无效。`);
}

function readIntegerInRange(value, label, minValue, maxValue, fallback) {
  const nextValue = Number(value);

  if (Number.isInteger(nextValue) && nextValue >= minValue && nextValue <= maxValue) {
    return nextValue;
  }

  if (typeof fallback === 'number') {
    return fallback;
  }

  throw new Error(`${label}无效。`);
}

function readColorHex(value, label, fallback) {
  if (typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)) {
    return value.toLowerCase();
  }

  if (typeof fallback === 'string') {
    return fallback;
  }

  throw new Error(`${label}无效。`);
}

function getVaultFilePath() {
  return path.join(app.getPath('userData'), vaultFileName);
}

function getVaultStorageInfo() {
  const protectedStorage = safeStorage.isEncryptionAvailable();

  return {
    path: getVaultFilePath(),
    protected: protectedStorage,
    protectionLabel: protectedStorage ? '已使用系统凭据加密保存' : '当前系统不支持加密，改为本地文件权限保护',
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

  return {
    language: rawSettings.language === 'en-US' ? 'en-US' : 'zh-CN',
    interfaceFont: uiFontChoices.includes(rawSettings.interfaceFont) ? rawSettings.interfaceFont : defaults.interfaceFont,
    theme: rawSettings.theme === 'light' || rawSettings.theme === 'system' ? rawSettings.theme : defaults.theme,
    accentColor: readColorHex(rawSettings.accentColor, '强调色', defaults.accentColor),
    defaultHostView: rawSettings.defaultHostView === 'list' ? 'list' : 'grid',
    rememberPasswords: readBoolean(rawSettings.rememberPasswords, '记住密码', defaults.rememberPasswords),
    rememberKeyPassphrases: readBoolean(
      rawSettings.rememberKeyPassphrases,
      '记住密钥口令',
      defaults.rememberKeyPassphrases,
    ),
    terminalFontSize: readIntegerInRange(rawSettings.terminalFontSize, '终端字号', 11, 20, defaults.terminalFontSize),
    terminalCursorStyle: rawSettings.terminalCursorStyle === 'bar' || rawSettings.terminalCursorStyle === 'underline'
      ? rawSettings.terminalCursorStyle
      : defaults.terminalCursorStyle,
    terminalScrollback: readIntegerInRange(
      rawSettings.terminalScrollback,
      '终端滚动缓冲区',
      1000,
      50000,
      defaults.terminalScrollback,
    ),
    terminalCopyOnSelect: readBoolean(
      rawSettings.terminalCopyOnSelect,
      '终端选中复制',
      defaults.terminalCopyOnSelect,
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
  };
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
  };
}

function readPersistedVaultWrapper(rawPayload) {
  if (!isPlainObject(rawPayload) || rawPayload.format !== vaultFormat || rawPayload.version !== vaultSchemaVersion) {
    throw new Error('本地数据格式不受支持。');
  }

  if (rawPayload.protected) {
    const encrypted = readBoundedString(rawPayload.ciphertext, '本地数据密文', 8 * 1024 * 1024, { trim: false });
    const decrypted = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    return readVaultPayload(JSON.parse(decrypted));
  }

  return readVaultPayload(rawPayload.payload);
}

function writeVaultToDisk(vault) {
  const vaultPath = getVaultFilePath();
  const payloadJson = JSON.stringify(vault);
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

function getVault() {
  if (vaultCache) {
    return vaultCache;
  }

  const vaultPath = getVaultFilePath();

  if (!fs.existsSync(vaultPath)) {
    vaultCache = createEmptyVault();
    return vaultCache;
  }

  const stats = fs.statSync(vaultPath);

  if (!stats.size || stats.size > maxVaultBytes) {
    throw new Error('本地数据文件为空或超过大小限制。');
  }

  vaultCache = readPersistedVaultWrapper(JSON.parse(fs.readFileSync(vaultPath, 'utf8')));
  return vaultCache;
}

function setVault(nextVault) {
  const normalizedVault = readVaultPayload(nextVault);
  vaultCache = normalizedVault;
  writeVaultToDisk(normalizedVault);
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

function readLegacyBookmarkCollections(rawCollections) {
  if (!Array.isArray(rawCollections)) {
    return [];
  }

  return rawCollections.map((collection) => {
    if (!isPlainObject(collection)) {
      throw new Error('历史书签数据无效。');
    }

    const normalizedScope = readBoundedString(collection.scope, '书签范围', 255);
    const bookmarks = Array.isArray(collection.bookmarks) ? collection.bookmarks.map((bookmark) => readBrowserBookmark(bookmark)) : [];

    return {
      scope: normalizedScope.startsWith(bookmarkScopePrefix)
        ? normalizedScope.slice(bookmarkScopePrefix.length)
        : normalizedScope,
      bookmarks,
      updatedAt: readTimestampString(collection.updatedAt ?? new Date().toISOString(), '书签更新时间'),
    };
  });
}

function migrateLegacyData(rawPayload) {
  const currentVault = getVault();

  if (currentVault.hosts.length || currentVault.sshKeys.length || currentVault.browserBookmarks.length) {
    return createVaultSnapshot(currentVault);
  }

  if (!isPlainObject(rawPayload)) {
    return createVaultSnapshot(currentVault);
  }

  const legacyHosts = Array.isArray(rawPayload.hosts) ? rawPayload.hosts.map((host) => readStoredHostRecord(host)) : [];
  const legacyKeys = Array.isArray(rawPayload.sshKeys)
    ? rawPayload.sshKeys.map((key) => {
        const legacyKey = readLegacyStoredKeyRecord(key);
        const nextKey = createVaultKeyRecord({
          name: legacyKey.name,
          privateKey: readLocalTextFile(legacyKey.keyPath, `私钥「${legacyKey.name}」`),
          passphrase: legacyKey.passphrase,
          source: 'imported',
          createdAt: legacyKey.createdAt,
        });

        nextKey.id = legacyKey.id;
        nextKey.updatedAt = legacyKey.updatedAt;
        return nextKey;
      })
    : [];
  const bookmarkCollections = readLegacyBookmarkCollections(rawPayload.browserBookmarks ?? []);
  const keysById = new Map(legacyKeys.map((key) => [key.id, key]));
  const keysByName = new Map(legacyKeys.map((key) => [key.name, key]));
  const nextHosts = legacyHosts.map((host) => {
    if (host.authMethod !== 'key') {
      return host;
    }

    const matchedKey = (host.keyId && keysById.get(host.keyId)) || keysByName.get(`${host.name} 私钥`);

    return {
      ...host,
      keyId: matchedKey?.id || host.keyId,
    };
  });

  const nextVault = setVault({
    ...currentVault,
    hosts: nextHosts,
    sshKeys: legacyKeys,
    settings: readAppSettings(rawPayload.settings),
    browserBookmarks: bookmarkCollections,
  });

  notifyVaultChanged({ kind: 'vault' });
  return createVaultSnapshot(nextVault);
}

function validateHostRequest(rawHost) {
  if (!isPlainObject(rawHost)) {
    throw new Error('主机信息无效。');
  }

  const name = readBoundedString(rawHost.name ?? '', '主机名称', 80, { required: false });
  const host = readBoundedString(rawHost.address, '主机地址', 255);
  const username = readBoundedString(rawHost.username, '用户名', 128);
  const port = Number(rawHost.port);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('端口必须是 1 到 65535 之间的整数。');
  }

  if (rawHost.authMethod !== 'password' && rawHost.authMethod !== 'key') {
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
    const password = readBoundedString(rawHost.password ?? '', 'SSH 密码', 4096, {
      trim: false,
      rejectLineBreaks: false,
    });
    sshConfig.password = password;
  } else {
    const keyId = readBoundedString(rawHost.keyId ?? '', '密钥 ID', 128, { required: false });
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

    const rawPassphrase = typeof rawHost.passphrase === 'string' ? rawHost.passphrase : storedKey?.passphrase ?? '';

    if (rawPassphrase) {
      sshConfig.passphrase = readBoundedString(rawPassphrase, 'SSH 密钥口令', 4096, {
        trim: false,
        rejectLineBreaks: false,
      });
    }
  }

  return {
    displayHost: {
      name: name || host,
      address: host,
      port,
      username,
      authMethod: rawHost.authMethod,
    },
    sshConfig,
  };
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
    throw new Error('不是受支持的 GUI-SSH 完整备份文件。');
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

function connectSshClient(sshConfig) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;

    const rejectConnection = (error) => {
      if (settled) {
        return;
      }

      settled = true;
      reject(error);
    };

    client.once('ready', () => {
      settled = true;
      client.removeListener('error', rejectConnection);
      client.on('error', () => undefined);
      resolve(client);
    });

    client.once('error', rejectConnection);
    client.connect(sshConfig);
  });
}

function createBufferedReader(socket) {
  let buffer = Buffer.alloc(0);
  let waiters = [];
  let closedError = null;

  const flush = () => {
    while (waiters.length) {
      const waiter = waiters[0];

      if (buffer.length >= waiter.size) {
        const chunk = buffer.subarray(0, waiter.size);
        buffer = buffer.subarray(waiter.size);
        waiters = waiters.slice(1);
        waiter.resolve(chunk);
        continue;
      }

      if (closedError) {
        waiters = waiters.slice(1);
        waiter.reject(closedError);
        continue;
      }

      break;
    }
  };

  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    flush();
  };

  const onError = (error) => {
    closedError = error;
    flush();
  };

  const onClose = () => {
    closedError = closedError ?? new Error('SOCKS 客户端已关闭。');
    flush();
  };

  socket.on('data', onData);
  socket.once('error', onError);
  socket.once('close', onClose);

  return {
    read(size) {
      if (buffer.length >= size) {
        const chunk = buffer.subarray(0, size);
        buffer = buffer.subarray(size);
        return Promise.resolve(chunk);
      }

      if (closedError) {
        return Promise.reject(closedError);
      }

      return new Promise((resolve, reject) => {
        waiters.push({ size, resolve, reject });
      });
    },
    drain() {
      const pending = buffer;
      buffer = Buffer.alloc(0);
      return pending;
    },
    dispose() {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    },
  };
}

function closeSocket(socket) {
  if (!socket.destroyed) {
    socket.destroy();
  }
}

function sendSocksReply(socket, code) {
  if (!socket.destroyed) {
    socket.write(Buffer.from([0x05, code, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
  }
}

function randomSourcePort() {
  return 1024 + crypto.randomInt(0, 64511);
}

function formatIpv6Address(bytes) {
  const parts = [];

  for (let index = 0; index < 16; index += 2) {
    parts.push(bytes.readUInt16BE(index).toString(16));
  }

  return parts.join(':');
}

function forwardOut(client, destinationHost, destinationPort) {
  return new Promise((resolve, reject) => {
    client.forwardOut('127.0.0.1', randomSourcePort(), destinationHost, destinationPort, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(stream);
    });
  });
}

async function handleSocksClient(client, socket) {
  const reader = createBufferedReader(socket);

  try {
    socket.setNoDelay(true);

    const greetingHead = await reader.read(2);
    const version = greetingHead[0];
    const methodCount = greetingHead[1];

    if (version !== 0x05 || methodCount < 1) {
      closeSocket(socket);
      return;
    }

    const methods = await reader.read(methodCount);
    if (!methods.includes(0x00)) {
      socket.write(Buffer.from([0x05, 0xff]));
      closeSocket(socket);
      return;
    }

    socket.write(Buffer.from([0x05, 0x00]));

    const requestHead = await reader.read(4);
    const command = requestHead[1];
    const addressType = requestHead[3];

    if (requestHead[0] !== 0x05 || command !== 0x01) {
      sendSocksReply(socket, 0x07);
      closeSocket(socket);
      return;
    }

    let destinationHost = '';

    if (addressType === 0x01) {
      destinationHost = Array.from(await reader.read(4)).join('.');
    } else if (addressType === 0x03) {
      const length = (await reader.read(1))[0];
      destinationHost = (await reader.read(length)).toString('utf8');
    } else if (addressType === 0x04) {
      destinationHost = formatIpv6Address(await reader.read(16));
    } else {
      sendSocksReply(socket, 0x08);
      closeSocket(socket);
      return;
    }

    const portBytes = await reader.read(2);
    const destinationPort = portBytes.readUInt16BE(0);

    if (!destinationHost || destinationPort < 1 || destinationPort > 65535) {
      sendSocksReply(socket, 0x04);
      closeSocket(socket);
      return;
    }

    const target = `${destinationHost}:${destinationPort}`;
    console.info(`[gui-ssh] SOCKS CONNECT ${target}`);

    let stream;
    try {
      stream = await forwardOut(client, destinationHost, destinationPort);
    } catch (error) {
      console.warn(`[gui-ssh] SOCKS CONNECT failed ${target}: ${toErrorMessage(error)}`);
      throw error;
    }

    const pending = reader.drain();
    reader.dispose();

    sendSocksReply(socket, 0x00);

    if (pending.length) {
      stream.write(pending);
    }

    stream.once('close', () => closeSocket(socket));
    stream.once('error', () => closeSocket(socket));
    socket.once('error', () => stream.destroy());
    socket.pipe(stream).pipe(socket);
  } catch {
    reader.dispose();
    sendSocksReply(socket, 0x01);
    closeSocket(socket);
  }
}

function createSocksProxy(client) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      void handleSocksClient(client, socket);
    });

    const fail = (error) => {
      server.removeListener('listening', ready);
      reject(error);
    };

    const ready = () => {
      server.removeListener('error', fail);
      server.on('error', () => undefined);
      const address = server.address();

      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('SOCKS 代理启动失败。'));
        return;
      }

      resolve({ server, port: address.port });
    };

    server.once('error', fail);
    server.once('listening', ready);
    server.listen(0, '127.0.0.1');
  });
}

function getActiveConnection(connectionId) {
  if (typeof connectionId !== 'string' || !connectionId) {
    throw new Error('连接标识无效。');
  }

  const activeConnection = activeConnections.get(connectionId);

  if (!activeConnection) {
    throw new Error('连接已断开，请重新连接。');
  }

  return activeConnection;
}

function notifyConnectionClosed(connectionId, reason) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send('connection:closed', { connectionId, reason });
    }
  }
}

function closeServer(server) {
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

async function closeActiveConnection(connectionId, reason = '连接已断开。', fromClientClose = false) {
  const activeConnection = activeConnections.get(connectionId);

  if (!activeConnection) {
    return false;
  }

  activeConnections.delete(connectionId);
  const connectionWindow = activeConnection.window;

  if (activeConnection.terminalSessions) {
    for (const stream of activeConnection.terminalSessions.values()) {
      stream.removeAllListeners();
      stream.end();
    }
  }

  for (const [key, entry] of activeMysqlConnections) {
    if (entry.connectionId === connectionId) {
      activeMysqlConnections.delete(key);
      entry.connection.end().catch(() => {});
    }
  }

  for (const [key, entry] of activeRedisConnections) {
    if (entry.connectionId === connectionId) {
      activeRedisConnections.delete(key);
      entry.connection.disconnect();
      entry.tunnelServer.close();
    }
  }

  await closeServer(activeConnection.socksServer);

  if (!fromClientClose) {
    activeConnection.client.end();
  }

  notifyConnectionClosed(connectionId, reason);

  if (connectionWindow && !connectionWindow.isDestroyed()) {
    connectionWindow.close();
  }

  return true;
}

function validateRemotePath(rawPath) {
  const remotePath = typeof rawPath === 'string' && rawPath.trim() ? rawPath.trim() : '.';

  if (remotePath.length > 4096 || remotePath.includes('\0')) {
    throw new Error('远程路径无效。');
  }

  return remotePath;
}

function validateMutableRemotePath(rawPath) {
  const remotePath = validateRemotePath(rawPath);

  if (remotePath === '.' || remotePath === '/' || remotePath === '~') {
    throw new Error('不允许对该远程路径执行管理操作。');
  }

  return remotePath;
}

function validateTerminalId(rawTerminalId) {
  const terminalId = readBoundedString(rawTerminalId, '终端标识', 120);

  if (!/^[a-zA-Z0-9:_-]+$/.test(terminalId)) {
    throw new Error('终端标识无效。');
  }

  return terminalId;
}

function getSftpEntryType(attrs) {
  const mode = attrs.mode ?? 0;
  const fileType = mode & 0o170000;

  if (fileType === 0o040000) {
    return 'directory';
  }

  if (fileType === 0o120000) {
    return 'symlink';
  }

  return 'file';
}

function listRemoteDirectory(client, remotePath) {
  return new Promise((resolve, reject) => {
    client.sftp((sftpError, sftp) => {
      if (sftpError) {
        reject(sftpError);
        return;
      }

      sftp.readdir(remotePath, (readError, entries) => {
        sftp.end();

        if (readError) {
          reject(readError);
          return;
        }

        resolve(
          entries
            .filter((entry) => entry.filename !== '.' && entry.filename !== '..')
            .map((entry) => ({
              name: entry.filename,
              longname: entry.longname,
              type: getSftpEntryType(entry.attrs),
              size: entry.attrs.size ?? 0,
              modifiedAt: entry.attrs.mtime ? new Date(entry.attrs.mtime * 1000).toISOString() : '',
            }))
            .sort((left, right) => {
              if (left.type === right.type) {
                return left.name.localeCompare(right.name, 'zh-CN');
              }

              return left.type === 'directory' ? -1 : 1;
            }),
        );
      });
    });
  });
}

function createRemoteDirectory(client, remotePath) {
  return new Promise((resolve, reject) => {
    client.sftp((sftpError, sftp) => {
      if (sftpError) {
        reject(sftpError);
        return;
      }

      sftp.mkdir(remotePath, (mkdirError) => {
        sftp.end();

        if (mkdirError) {
          reject(mkdirError);
          return;
        }

        resolve(true);
      });
    });
  });
}

function deleteRemotePath(client, remotePath, entryType) {
  return new Promise((resolve, reject) => {
    client.sftp((sftpError, sftp) => {
      if (sftpError) {
        reject(sftpError);
        return;
      }

      const finish = (deleteError) => {
        sftp.end();

        if (deleteError) {
          reject(deleteError);
          return;
        }

        resolve(true);
      };

      if (entryType === 'directory') {
        sftp.rmdir(remotePath, finish);
      } else {
        sftp.unlink(remotePath, finish);
      }
    });
  });
}

function execRemoteCommand(client, command) {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }

      let output = '';
      let errorOutput = '';
      const append = (chunk, isError = false) => {
        const value = chunk.toString('utf8');

        if (isError) {
          errorOutput = `${errorOutput}${value}`.slice(0, 65536);
        } else {
          output = `${output}${value}`.slice(0, 65536);
        }
      };

      stream.on('data', (chunk) => append(chunk));
      stream.stderr.on('data', (chunk) => append(chunk, true));
      stream.once('close', () => {
        resolve(`${output}${errorOutput ? `\n${errorOutput}` : ''}`.trim());
      });
      stream.once('error', reject);
    });
  });
}

async function getRemoteStatus(client) {
  const commands = [
    { key: 'hostname', label: '主机名', command: 'hostname 2>/dev/null || uname -n' },
    { key: 'user', label: '当前用户', command: 'whoami 2>/dev/null || id -un' },
    { key: 'kernel', label: '系统内核', command: 'uname -a' },
    { key: 'uptime', label: '运行时间', command: 'uptime' },
    { key: 'disk', label: '根分区', command: 'df -h / 2>/dev/null || df -h' },
    { key: 'memory', label: '内存', command: 'free -m 2>/dev/null || vm_stat 2>/dev/null || echo unavailable' },
    { key: 'network', label: '网络接口', command: 'ip -brief address 2>/dev/null || ifconfig 2>/dev/null || echo unavailable' },
  ];

  // 串行执行避免 SSH channel 耗尽
  const items = [];
  for (const item of commands) {
    try {
      const value = await execRemoteCommand(client, item.command);
      items.push({ key: item.key, label: item.label, value: value || '无输出' });
    } catch (error) {
      items.push({ key: item.key, label: item.label, value: `读取失败：${toErrorMessage(error)}` });
    }
  }

  return { refreshedAt: new Date().toISOString(), items };
}

function registerIpcHandler(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await handler(event, ...args);
    } catch (error) {
      throw new Error(toErrorMessage(error));
    }
  });
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

function configureAppWindow(appWindow) {
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
}

function loadAppWindow(appWindow, query = {}) {
  if (devServerUrl) {
    const appUrl = new URL(devServerUrl);

    for (const [key, value] of Object.entries(query)) {
      appUrl.searchParams.set(key, value);
    }

    void appWindow.loadURL(appUrl.toString());
  } else {
    void appWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { query });
  }
}

function toConnectionInfo(activeConnection) {
  return {
    id: activeConnection.id,
    partition: activeConnection.partition,
    proxyPort: activeConnection.proxyPort,
    connectedAt: activeConnection.connectedAt,
    host: activeConnection.displayHost,
  };
}

function createMainWindow() {
  const mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 940,
    minHeight: 620,
    show: false,
    title: 'GUI-SSH',
    backgroundColor: '#0b1017',
    autoHideMenuBar: true,
    frame: process.platform === 'darwin',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 16, y: 15 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
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

  configureAppWindow(mainWindow);
  loadAppWindow(mainWindow);
}

function createConnectionWindow(activeConnection) {
  const connectionTitle = `${activeConnection.displayHost.username}@${activeConnection.displayHost.address}:${activeConnection.displayHost.port}`;
  const connectionWindow = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: `GUI-SSH - ${connectionTitle} - SOCKS :${activeConnection.proxyPort}`,
    backgroundColor: '#0b1017',
    autoHideMenuBar: true,
    frame: process.platform === 'darwin',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 16, y: 15 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
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

ipcMain.handle('window:close', (event) => {
  getSenderWindow(event)?.close();
});

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

registerIpcHandler('vault:get-snapshot', async () => createVaultSnapshot());

registerIpcHandler('logs:get-entries', async () => readLogEntries());

registerIpcHandler('logs:save-entries', async (_event, rawEntries) => {
  const entries = Array.isArray(rawEntries) ? rawEntries : [];
  writeLogEntries(entries);
  return readLogEntries();
});

registerIpcHandler('vault:save-collections', async (_event, rawPayload) => upsertVaultCollections(rawPayload));

registerIpcHandler('vault:migrate-legacy-data', async (_event, rawPayload) => migrateLegacyData(rawPayload));

registerIpcHandler('vault:import-key-pair', async (_event, rawPayload) => importKeyPairToVault(rawPayload));

registerIpcHandler('vault:generate-rsa-key-pair', async (_event, rawPayload) => generateRsaKeyPairInVault(rawPayload));

registerIpcHandler('vault:get-bookmarks', async (_event, rawScope) => {
  const scope = readBoundedString(rawScope, '书签范围', 255);
  const bookmarks = getVault().browserBookmarks.find((collection) => collection.scope === scope)?.bookmarks ?? [];
  return bookmarks;
});

registerIpcHandler('vault:save-bookmarks', async (_event, rawScope, rawBookmarks) => {
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
  const nextVault = setVault({
    ...currentVault,
    browserBookmarks: nextBookmarkCollections,
  });

  notifyVaultChanged({ kind: 'bookmarks', scope });
  return nextVault.browserBookmarks.find((collection) => collection.scope === scope)?.bookmarks ?? [];
});

registerIpcHandler('config:export', async (event) => {
  const bundle = buildConfigBundle();
  const window = getSenderWindow(event);
  const defaultPath = path.join(app.getPath('documents'), `gui-ssh-config-${new Date().toISOString().slice(0, 10)}.json`);
  const result = await dialog.showSaveDialog(window ?? undefined, {
    title: '导出完整主机配置',
    defaultPath,
    filters: [{ name: 'GUI-SSH Config', extensions: ['json'] }],
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
    filters: [{ name: 'GUI-SSH Config', extensions: ['json'] }],
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

ipcMain.handle('connection:connect', async (_event, rawHost) => {
  let client;

  try {
    const { displayHost, sshConfig } = validateHostRequest(rawHost);
    client = await connectSshClient(sshConfig);
    const { server, port } = await createSocksProxy(client);
    const id = crypto.randomUUID();
    const partition = `gui-ssh-${id}`;
    const remoteSession = session.fromPartition(partition);

    await remoteSession.setProxy({
      mode: 'fixed_servers',
      proxyRules: `socks5://127.0.0.1:${port}`,
      proxyBypassRules: '<-loopback>',
    });
    const loopbackProxy = await remoteSession.resolveProxy('http://127.0.0.1/');
    const publicProxy = await remoteSession.resolveProxy('http://example.com/');
    console.info(`[gui-ssh] webview proxy ${partition}: 127.0.0.1 => ${loopbackProxy}; example.com => ${publicProxy}`);
    remoteSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));

    const activeConnection = {
      id,
      client,
      socksServer: server,
      proxyPort: port,
      partition,
      displayHost,
      connectedAt: new Date().toISOString(),
      terminalSessions: new Map(),
    };

    activeConnections.set(id, activeConnection);
    client.once('close', () => {
      void closeActiveConnection(id, 'SSH 连接已断开。', true);
    });
    createConnectionWindow(activeConnection);

    return {
      ok: true,
      connection: toConnectionInfo(activeConnection),
    };
  } catch (error) {
    client?.end();
    return { ok: false, error: toConnectionErrorMessage(error) };
  }
});

registerIpcHandler('connection:disconnect', async (_event, connectionId) => {
  await closeActiveConnection(connectionId, '已断开 SSH 连接。');
  return true;
});

registerIpcHandler('connection:get-info', async (_event, connectionId) => {
  return toConnectionInfo(getActiveConnection(connectionId));
});

registerIpcHandler('connection:get-ipc-capabilities', async () => ({
  terminalSessions: true,
}));

registerIpcHandler('connection:start-terminal', async (event, connectionId, rawTerminalId, rawColumns, rawRows) => {
  const activeConnection = getActiveConnection(connectionId);
  const terminalId = validateTerminalId(rawTerminalId);
  const columns = Number(rawColumns) || 100;
  const rows = Number(rawRows) || 30;

  if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 20 || rows < 5 || columns > 300 || rows > 120) {
    throw new Error('终端尺寸无效。');
  }

  const existingStream = activeConnection.terminalSessions.get(terminalId);

  if (existingStream && !existingStream.destroyed) {
    return true;
  }

  await new Promise((resolve, reject) => {
    let settled = false;
    const startTimer = setTimeout(() => {
      settled = true;
      reject(new Error('终端启动超时：远程服务器未返回交互式 Shell。'));
    }, 15000);

    activeConnection.client.shell({ term: 'xterm-256color', cols: columns, rows }, (error, stream) => {
      if (settled) {
        stream?.end();
        return;
      }

      settled = true;
      clearTimeout(startTimer);

      if (error) {
        reject(error);
        return;
      }

      activeConnection.terminalSessions.set(terminalId, stream);
      stream.on('data', (chunk) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('terminal:data', { connectionId, terminalId, data: chunk.toString('utf8') });
        }
      });
      stream.stderr.on('data', (chunk) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('terminal:data', { connectionId, terminalId, data: chunk.toString('utf8') });
        }
      });
      stream.once('close', () => {
        if (activeConnection.terminalSessions.get(terminalId) === stream) {
          activeConnection.terminalSessions.delete(terminalId);
        }

        if (!event.sender.isDestroyed()) {
          event.sender.send('terminal:exit', { connectionId, terminalId });
        }
      });
      resolve();
    });
  });

  return true;
});

registerIpcHandler('connection:write-terminal', async (_event, connectionId, rawTerminalId, rawData) => {
  const activeConnection = getActiveConnection(connectionId);
  const terminalId = validateTerminalId(rawTerminalId);
  const terminalStream = activeConnection.terminalSessions.get(terminalId);

  if (!terminalStream || terminalStream.destroyed) {
    throw new Error('终端尚未启动。');
  }

  if (typeof rawData !== 'string' || rawData.length > 8192 || rawData.includes('\0')) {
    throw new Error('终端输入无效。');
  }

  terminalStream.write(rawData);
  return true;
});

registerIpcHandler('connection:resize-terminal', async (_event, connectionId, rawTerminalId, rawColumns, rawRows) => {
  const activeConnection = getActiveConnection(connectionId);
  const terminalId = validateTerminalId(rawTerminalId);
  const columns = Number(rawColumns);
  const rows = Number(rawRows);

  if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 20 || rows < 5 || columns > 300 || rows > 120) {
    throw new Error('终端尺寸无效。');
  }

  const terminalStream = activeConnection.terminalSessions.get(terminalId);

  if (terminalStream?.setWindow) {
    terminalStream.setWindow(rows, columns, 0, 0);
  }

  return true;
});

registerIpcHandler('connection:close-terminal', async (_event, connectionId, rawTerminalId) => {
  const activeConnection = getActiveConnection(connectionId);
  const terminalId = validateTerminalId(rawTerminalId);
  const terminalStream = activeConnection.terminalSessions.get(terminalId);

  if (terminalStream) {
    activeConnection.terminalSessions.delete(terminalId);
    terminalStream.removeAllListeners();
    terminalStream.end();
  }

  return true;
});

registerIpcHandler('connection:list-directory', async (_event, connectionId, rawPath) => {
  const activeConnection = getActiveConnection(connectionId);
  const remotePath = validateRemotePath(rawPath);
  const entries = await listRemoteDirectory(activeConnection.client, remotePath);

  return { path: remotePath, entries };
});

registerIpcHandler('connection:create-directory', async (_event, connectionId, rawPath) => {
  const activeConnection = getActiveConnection(connectionId);
  const remotePath = validateMutableRemotePath(rawPath);
  await createRemoteDirectory(activeConnection.client, remotePath);
  return true;
});

registerIpcHandler('connection:delete-path', async (_event, connectionId, rawPath, rawType) => {
  const activeConnection = getActiveConnection(connectionId);
  const remotePath = validateMutableRemotePath(rawPath);
  const entryType = rawType === 'directory' ? 'directory' : 'file';
  await deleteRemotePath(activeConnection.client, remotePath, entryType);
  return true;
});

function renameRemotePath(client, oldPath, newPath) {
  return new Promise((resolve, reject) => {
    client.sftp((sftpError, sftp) => {
      if (sftpError) {
        reject(sftpError);
        return;
      }

      sftp.rename(oldPath, newPath, (renameError) => {
        sftp.end();

        if (renameError) {
          reject(renameError);
          return;
        }

        resolve(true);
      });
    });
  });
}

function createRemoteFile(client, remotePath) {
  return new Promise((resolve, reject) => {
    client.sftp((sftpError, sftp) => {
      if (sftpError) {
        reject(sftpError);
        return;
      }

      sftp.open(remotePath, 'w', (openError, handle) => {
        if (openError) {
          sftp.end();
          reject(openError);
          return;
        }

        sftp.closeHandle(handle, (closeError) => {
          sftp.end();

          if (closeError) {
            reject(closeError);
            return;
          }

          resolve(true);
        });
      });
    });
  });
}

function statRemotePath(client, remotePath) {
  return new Promise((resolve, reject) => {
    client.sftp((sftpError, sftp) => {
      if (sftpError) {
        reject(sftpError);
        return;
      }

      sftp.stat(remotePath, (statError, attrs) => {
        sftp.end();

        if (statError) {
          reject(statError);
          return;
        }

        resolve({
          type: getSftpEntryType(attrs),
          size: attrs.size ?? 0,
          mode: attrs.mode ?? 0,
          owner: attrs.uid ?? 0,
          group: attrs.gid ?? 0,
          modifiedAt: attrs.mtime ? new Date(attrs.mtime * 1000).toISOString() : '',
          accessedAt: attrs.atime ? new Date(attrs.atime * 1000).toISOString() : '',
        });
      });
    });
  });
}

registerIpcHandler('connection:rename-path', async (_event, connectionId, rawOldPath, rawNewPath) => {
  const activeConnection = getActiveConnection(connectionId);
  const oldPath = validateMutableRemotePath(rawOldPath);
  const newPath = validateMutableRemotePath(rawNewPath);
  await renameRemotePath(activeConnection.client, oldPath, newPath);
  return true;
});

registerIpcHandler('connection:create-file', async (_event, connectionId, rawPath) => {
  const activeConnection = getActiveConnection(connectionId);
  const remotePath = validateMutableRemotePath(rawPath);
  await createRemoteFile(activeConnection.client, remotePath);
  return true;
});

function readRemoteFile(client, remotePath) {
  return new Promise((resolve, reject) => {
    client.sftp((sftpError, sftp) => {
      if (sftpError) {
        reject(sftpError);
        return;
      }

      sftp.stat(remotePath, (statError, attrs) => {
        if (statError) {
          sftp.end();
          reject(statError);
          return;
        }

        if (getSftpEntryType(attrs) !== 'file') {
          sftp.end();
          reject(new Error('只能用记事本打开远程文件。'));
          return;
        }

        if ((attrs.size ?? 0) > maxRemoteTextFileBytes) {
          sftp.end();
          reject(new Error(`文件超过 ${Math.round(maxRemoteTextFileBytes / 1024 / 1024)} MB，请先下载后用本地编辑器打开。`));
          return;
        }

        sftp.readFile(remotePath, 'utf8', (readError, content) => {
          sftp.end();

          if (readError) {
            reject(readError);
            return;
          }

          resolve(content);
        });
      });
    });
  });
}

function writeRemoteFile(client, remotePath, content) {
  if (Buffer.byteLength(content, 'utf8') > maxRemoteTextWriteBytes) {
    throw new Error(`文件内容超过 ${Math.round(maxRemoteTextWriteBytes / 1024 / 1024)} MB，请使用上传功能替换大文件。`);
  }

  return new Promise((resolve, reject) => {
    client.sftp((sftpError, sftp) => {
      if (sftpError) {
        reject(sftpError);
        return;
      }

      sftp.writeFile(remotePath, content, 'utf8', (writeError) => {
        sftp.end();

        if (writeError) {
          reject(writeError);
          return;
        }

        resolve(true);
      });
    });
  });
}

registerIpcHandler('connection:stat-path', async (_event, connectionId, rawPath) => {
  const activeConnection = getActiveConnection(connectionId);
  const remotePath = validateRemotePath(rawPath);
  return await statRemotePath(activeConnection.client, remotePath);
});

registerIpcHandler('connection:read-file', async (_event, connectionId, rawPath) => {
  const activeConnection = getActiveConnection(connectionId);
  const remotePath = validateRemotePath(rawPath);
  return await readRemoteFile(activeConnection.client, remotePath);
});

registerIpcHandler('connection:write-file', async (_event, connectionId, rawPath, content) => {
  const activeConnection = getActiveConnection(connectionId);
  const remotePath = validateMutableRemotePath(rawPath);
  if (typeof content !== 'string') {
    throw new Error('文件内容必须是字符串。');
  }
  await writeRemoteFile(activeConnection.client, remotePath, content);
  return true;
});

// ─── Active transfer tracking (for cancel) ───────────────────────────────────

const activeStreams = new Map(); // connectionId -> { destroy: () => void }

function destroyActiveStream(connectionId) {
  const handle = activeStreams.get(connectionId);
  if (handle) {
    activeStreams.delete(connectionId);
    handle.destroy();
  }
}

registerIpcHandler('connection:cancel-transfer', (_event, connectionId) => {
  destroyActiveStream(connectionId);
});

function downloadRemoteFileToPath(client, remotePath, localPath, sender, connectionId) {
  destroyActiveStream(connectionId);

  return new Promise((resolve, reject) => {
    client.sftp((sftpError, sftp) => {
      if (sftpError) {
        reject(sftpError);
        return;
      }

      const fileName = remotePath.split('/').pop() || 'download';
      let settled = false;
      let transferredBytes = 0;
      let totalBytes = 0;
      let lastSent = 0;
      const readStream = sftp.createReadStream(remotePath);
      const writeStream = fs.createWriteStream(localPath, { flags: 'w' });

      const cleanup = () => {
        activeStreams.delete(connectionId);
        try { sftp.end(); } catch (_) { /* ignore */ }
        readStream.destroy();
        writeStream.destroy();
      };

      activeStreams.set(connectionId, { destroy: cleanup });

      const sendEndAndResolve = (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (sender && !sender.isDestroyed()) {
          sender.send('transfer:end', { type: 'download', fileName, transferred: transferredBytes, total: totalBytes, success: true });
        }
        resolve(value);
      };

      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (sender && !sender.isDestroyed()) {
          sender.send('transfer:end', { type: 'download', fileName, transferred: transferredBytes, total: totalBytes, success: false, error: error?.message ?? String(error) });
        }
        reject(error);
      };

      const sendProgress = () => {
        const now = Date.now();
        if (sender && !sender.isDestroyed() && now - lastSent >= 100) {
          lastSent = now;
          sender.send('transfer:progress', {
            type: 'download',
            fileName,
            transferred: transferredBytes,
            total: totalBytes,
          });
        }
      };

      sftp.stat(remotePath, (statErr, stat) => {
        if (!statErr && stat) {
          totalBytes = stat.size;
        }
      });

      readStream.on('data', (chunk) => {
        transferredBytes += chunk.length;
        sendProgress();
      });
      readStream.on('error', fail);
      writeStream.on('error', fail);
      writeStream.on('finish', () => sendEndAndResolve(transferredBytes));

      readStream.pipe(writeStream);
    });
  });
}

registerIpcHandler('connection:download-file', async (event, connectionId, rawPath) => {
  const activeConnection = getActiveConnection(connectionId);
  const remotePath = validateRemotePath(rawPath);
  const remoteFileName = remotePath.split('/').pop() || 'download';
  const senderWindow = BrowserWindow.fromWebContents(event.sender);

  const result = await dialog.showSaveDialog(senderWindow ?? BrowserWindow.getAllWindows()[0], {
    defaultPath: remoteFileName,
    filters: [{ name: '所有文件', extensions: ['*'] }],
  });

  if (result.canceled || !result.filePath) {
    return { canceled: true };
  }

  const size = await downloadRemoteFileToPath(activeConnection.client, remotePath, result.filePath, event.sender, connectionId);
  return { canceled: false, filePath: result.filePath, size };
});

registerIpcHandler('connection:upload-file', async (event, connectionId, rawRemotePath) => {
  const activeConnection = getActiveConnection(connectionId);
  const currentPath = validateRemotePath(rawRemotePath);
  const senderWindow = BrowserWindow.fromWebContents(event.sender);

  const result = await dialog.showOpenDialog(senderWindow ?? BrowserWindow.getAllWindows()[0], {
    properties: ['openFile'],
    filters: [{ name: '所有文件', extensions: ['*'] }],
  });

  if (result.canceled || !result.filePaths.length) {
    return { canceled: true };
  }

  const localPath = result.filePaths[0];
  const fileName = localPath.split(/[/\\]/).pop() || 'upload';
  const destPath = currentPath === '.' ? fileName
    : currentPath === '/' ? `/${fileName}`
    : `${currentPath.replace(/\/+$/, '')}/${fileName}`;
  const targetRemotePath = validateMutableRemotePath(destPath);
  const stats = fs.statSync(localPath);

  if (!stats.isFile()) {
    throw new Error('只能上传文件。');
  }

  destroyActiveStream(connectionId);

  await new Promise((resolve, reject) => {
    activeConnection.client.sftp((sftpError, sftp) => {
      if (sftpError) { reject(sftpError); return; }
      let settled = false;
      let transferredBytes = 0;
      let lastSent = 0;
      const totalBytes = stats.size;
      const readStream = fs.createReadStream(localPath);
      const writeStream = sftp.createWriteStream(targetRemotePath);

      const cleanup = () => {
        activeStreams.delete(connectionId);
        try { sftp.end(); } catch (_) { /* ignore */ }
        readStream.destroy();
        writeStream.destroy();
      };

      activeStreams.set(connectionId, { destroy: cleanup });

      const end = (success, errorMsg) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (!event.sender.isDestroyed()) {
          event.sender.send('transfer:end', {
            type: 'upload',
            fileName,
            transferred: transferredBytes,
            total: totalBytes,
            success,
            error: errorMsg,
          });
        }
        if (success) resolve();
        else reject(new Error(errorMsg ?? '传输已取消'));
      };

      const sendProgress = () => {
        const now = Date.now();
        if (!event.sender.isDestroyed() && now - lastSent >= 100) {
          lastSent = now;
          event.sender.send('transfer:progress', {
            type: 'upload',
            fileName,
            transferred: transferredBytes,
            total: totalBytes,
          });
        }
      };

      const fail = (error) => end(false, error?.message ?? String(error));

      readStream.on('data', (chunk) => {
        transferredBytes += chunk.length;
        sendProgress();
      });
      readStream.on('error', fail);
      writeStream.on('error', fail);
      writeStream.on('close', () => end(true, null));
      readStream.pipe(writeStream);
    });
  });

  return { canceled: false, remotePath: targetRemotePath, size: stats.size };
});

registerIpcHandler('connection:get-status', async (_event, connectionId) => {
  const activeConnection = getActiveConnection(connectionId);
  return getRemoteStatus(activeConnection.client);
});

// ─── Remote SSH command execution ───────────────────────────────────────────

function execSshCommand(client, command) {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }

      let stdout = '';
      let stderr = '';

      stream.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
      stream.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      stream.on('close', (code) => {
        if (code === 0) {
          resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code });
        } else {
          reject(new Error(stderr.trim() || `命令执行失败，退出码 ${code}`));
        }
      });
    });
  });
}

function execRemoteCommandRaw(client, command) {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }

      let stdout = '';
      let stderr = '';

      stream.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
      stream.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      stream.on('close', (code) => {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 0 });
      });
    });
  });
}

registerIpcHandler('connection:run-command', async (_event, connectionId, rawCommand) => {
  const activeConnection = getActiveConnection(connectionId);
  const command = readBoundedString(rawCommand, '命令', 4096, { rejectLineBreaks: false });
  return execRemoteCommandRaw(activeConnection.client, command);
});

registerIpcHandler('connection:compress', async (_event, connectionId, rawSourcePaths, rawFormat, rawDestPath) => {
  const activeConnection = getActiveConnection(connectionId);

  if (!Array.isArray(rawSourcePaths) || rawSourcePaths.length === 0) {
    throw new Error('请选择要压缩的文件。');
  }

  const sourcePaths = rawSourcePaths.map((p) => validateRemotePath(p));
  const format = ['zip', 'tar', 'tar.gz', 'tgz', '7z'].includes(rawFormat) ? rawFormat : 'zip';
  const destPath = validateMutableRemotePath(rawDestPath);

  const escapedSources = sourcePaths.map((p) => `'${p.replace(/'/g, "'\\''")}'`).join(' ');
  const escapedDest = `'${destPath.replace(/'/g, "'\\''")}'`;

  let command = '';

  switch (format) {
    case 'zip':
      command = `zip -r ${escapedDest} ${escapedSources}`;
      break;
    case 'tar':
      command = `tar cf ${escapedDest} ${escapedSources}`;
      break;
    case 'tar.gz':
    case 'tgz':
      command = `tar czf ${escapedDest} ${escapedSources}`;
      break;
    case '7z':
      command = `7z a ${escapedDest} ${escapedSources}`;
      break;
    default:
      command = `zip -r ${escapedDest} ${escapedSources}`;
  }

  await execSshCommand(activeConnection.client, command);
  return { format, destPath };
});

registerIpcHandler('connection:decompress', async (_event, connectionId, rawArchivePath, rawDestDir) => {
  const activeConnection = getActiveConnection(connectionId);
  const archivePath = validateRemotePath(rawArchivePath);
  const archiveName = archivePath.split('/').pop() || '';
  const escapedArchive = `'${archivePath.replace(/'/g, "'\\''")}'`;
  const destDir = rawDestDir ? validateRemotePath(rawDestDir) : validateRemotePath(archivePath.replace(/\/[^/]*$/, '') || '.');
  const escapedDest = `'${destDir.replace(/'/g, "'\\''")}'`;

  let command = '';

  if (archiveName.endsWith('.tar.gz') || archiveName.endsWith('.tgz')) {
    command = `tar xzf ${escapedArchive} -C ${escapedDest}`;
  } else if (archiveName.endsWith('.tar.bz2') || archiveName.endsWith('.tbz2')) {
    command = `tar xjf ${escapedArchive} -C ${escapedDest}`;
  } else if (archiveName.endsWith('.tar.xz') || archiveName.endsWith('.txz')) {
    command = `tar xJf ${escapedArchive} -C ${escapedDest}`;
  } else if (archiveName.endsWith('.tar')) {
    command = `tar xf ${escapedArchive} -C ${escapedDest}`;
  } else if (archiveName.endsWith('.zip')) {
    command = `unzip -o ${escapedArchive} -d ${escapedDest}`;
  } else if (archiveName.endsWith('.7z')) {
    command = `7z x -o${escapedDest} ${escapedArchive} -y`;
  } else if (archiveName.endsWith('.gz') && !archiveName.endsWith('.tar.gz')) {
    const baseName = archiveName.replace(/\.gz$/, '');
    command = `gunzip -c ${escapedArchive} > ${escapedDest}/${baseName}`;
  } else if (archiveName.endsWith('.rar')) {
    command = `unrar x -o+ ${escapedArchive} ${escapedDest}`;
  } else {
    throw new Error(`不支持的压缩格式：${archiveName}`);
  }

  await execSshCommand(activeConnection.client, command);
  return { archivePath, destDir };
});

// ─── MySQL over SSH tunnel ──────────────────────────────────────────────────

const activeMysqlConnections = new Map();

function getMysqlKey(connectionId, mysqlId) {
  return `${connectionId}::${mysqlId}`;
}

function createMysqlTunnelStream(client, host, port) {
  return new Promise((resolve, reject) => {
    const sourcePort = Math.floor(Math.random() * 50000) + 10000;
    client.forwardOut('127.0.0.1', sourcePort, host, port, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stream);
    });
  });
}

registerIpcHandler('connection:mysql-connect', async (_event, connectionId, rawConfig) => {
  const activeConnection = getActiveConnection(connectionId);

  if (!isPlainObject(rawConfig)) {
    throw new Error('MySQL 连接配置无效。');
  }

  const mysqlHost = readBoundedString(rawConfig.host || '127.0.0.1', 'MySQL 主机', 256);
  const mysqlPort = readIntegerInRange(rawConfig.port, 'MySQL 端口', 1, 65535, 3306);
  const mysqlUser = readBoundedString(rawConfig.user || 'root', 'MySQL 用户名', 128);
  const mysqlPassword = typeof rawConfig.password === 'string' ? rawConfig.password : '';
  const mysqlDatabase = typeof rawConfig.database === 'string' && rawConfig.database
    ? readBoundedString(rawConfig.database, 'MySQL 数据库', 256)
    : undefined;
  const mysqlId = readBoundedString(rawConfig.mysqlId || crypto.randomUUID(), 'MySQL 连接 ID', 128);
  const key = getMysqlKey(connectionId, mysqlId);

  const existing = activeMysqlConnections.get(key);

  if (existing) {
    try {
      await existing.connection.query('SELECT 1');
      return { mysqlId, alreadyConnected: true };
    } catch {
      activeMysqlConnections.delete(key);
    }
  }

  const stream = await createMysqlTunnelStream(activeConnection.client, mysqlHost, mysqlPort);
  const connection = await mysql.createConnection({
    host: mysqlHost,
    user: mysqlUser,
    password: mysqlPassword,
    database: mysqlDatabase,
    stream,
    connectTimeout: 15000,
    charset: 'utf8mb4',
  });

  activeMysqlConnections.set(key, { connection, connectionId, mysqlId });

  return { mysqlId };
});

registerIpcHandler('connection:mysql-disconnect', async (_event, connectionId, rawMysqlId) => {
  const mysqlId = readBoundedString(rawMysqlId, 'MySQL 连接 ID', 128);
  const key = getMysqlKey(connectionId, mysqlId);
  const entry = activeMysqlConnections.get(key);

  if (entry) {
    activeMysqlConnections.delete(key);
    await entry.connection.end().catch(() => {});
  }

  return true;
});

registerIpcHandler('connection:mysql-databases', async (_event, connectionId, rawMysqlId) => {
  const mysqlId = readBoundedString(rawMysqlId, 'MySQL 连接 ID', 128);
  const key = getMysqlKey(connectionId, mysqlId);
  const entry = activeMysqlConnections.get(key);

  if (!entry) {
    throw new Error('MySQL 连接已断开。');
  }

  const [rows] = await entry.connection.query('SHOW DATABASES');
  return rows.map((row) => row.Database || row.database || Object.values(row)[0]);
});

registerIpcHandler('connection:mysql-tables', async (_event, connectionId, rawMysqlId, rawDatabase) => {
  const mysqlId = readBoundedString(rawMysqlId, 'MySQL 连接 ID', 128);
  const database = readBoundedString(rawDatabase, '数据库名', 256);
  const key = getMysqlKey(connectionId, mysqlId);
  const entry = activeMysqlConnections.get(key);

  if (!entry) {
    throw new Error('MySQL 连接已断开。');
  }

  const [rows] = await entry.connection.query('SHOW TABLES FROM ??', [database]);
  return rows.map((row) => Object.values(row)[0]);
});

registerIpcHandler('connection:mysql-columns', async (_event, connectionId, rawMysqlId, rawDatabase, rawTable) => {
  const mysqlId = readBoundedString(rawMysqlId, 'MySQL 连接 ID', 128);
  const database = readBoundedString(rawDatabase, '数据库名', 256);
  const table = readBoundedString(rawTable, '表名', 256);
  const key = getMysqlKey(connectionId, mysqlId);
  const entry = activeMysqlConnections.get(key);

  if (!entry) {
    throw new Error('MySQL 连接已断开。');
  }

  const [rows] = await entry.connection.query(
    'SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
    [database, table],
  );

  return rows.map((row) => ({
    name: row.COLUMN_NAME,
    type: row.COLUMN_TYPE,
    nullable: row.IS_NULLABLE === 'YES',
    key: row.COLUMN_KEY,
    default: row.COLUMN_DEFAULT,
    extra: row.EXTRA,
    comment: row.COLUMN_COMMENT,
  }));
});

registerIpcHandler('connection:mysql-query', async (_event, connectionId, rawMysqlId, rawSql, rawDatabase) => {
  const mysqlId = readBoundedString(rawMysqlId, 'MySQL 连接 ID', 128);
  const sql = readBoundedString(rawSql, 'SQL 语句', 1024 * 1024, { rejectLineBreaks: false });
  const key = getMysqlKey(connectionId, mysqlId);
  const entry = activeMysqlConnections.get(key);

  if (!entry) {
    throw new Error('MySQL 连接已断开。');
  }

  if (rawDatabase) {
    const database = readBoundedString(rawDatabase, '数据库名', 256);
    await entry.connection.query('USE ??', [database]);
  }

  const [rows, fields] = await entry.connection.query(sql);
  const columnNames = fields ? fields.map((f) => f.name) : [];
  const data = Array.isArray(rows) ? rows : [];
  const affectedRows = typeof rows === 'object' && rows !== null && 'affectedRows' in rows
    ? rows.affectedRows
    : undefined;
  const insertId = typeof rows === 'object' && rows !== null && 'insertId' in rows && rows.insertId
    ? String(rows.insertId)
    : undefined;

  return { columns: columnNames, rows: data, affectedRows, insertId };
});

registerIpcHandler('connection:mysql-update-cell', async (_event, connectionId, rawMysqlId, rawDatabase, rawTable, rawPkColumn, rawPkValue, rawColumn, rawNewValue, rawPkColumns, rawPkValues) => {
  const mysqlId = readBoundedString(rawMysqlId, 'MySQL 连接 ID', 128);
  const database = readBoundedString(rawDatabase, '数据库名', 256);
  const table = readBoundedString(rawTable, '表名', 256);
  const column = readBoundedString(rawColumn, '列名', 256);
  const key = getMysqlKey(connectionId, mysqlId);
  const entry = activeMysqlConnections.get(key);

  if (!entry) {
    throw new Error('MySQL 连接已断开。');
  }

  await entry.connection.query('USE ??', [database]);

  let whereClause;
  let whereParams;

  if (Array.isArray(rawPkColumns) && Array.isArray(rawPkValues) && rawPkColumns.length > 0) {
    whereClause = rawPkColumns.map((col) => '?? = ?').join(' AND ');
    whereParams = rawPkColumns.flatMap((col, i) => [col, rawPkValues[i]]);
  } else {
    whereClause = '?? = ?';
    whereParams = [rawPkColumn, rawPkValue];
  }

  const sql = `UPDATE ?? SET ?? = ? WHERE ${whereClause}`;
  const params = [`${database}.${table}`, column, rawNewValue === null ? null : rawNewValue, ...whereParams];
  const [result] = await entry.connection.query(sql, params);

  return { affectedRows: result.affectedRows };
});

// ─── Redis over SSH tunnel ──────────────────────────────────────────────────

const activeRedisConnections = new Map();

function getRedisKey(connectionId, redisId) {
  return `${connectionId}::${redisId}`;
}

function createRedisTunnel(client, redisHost, redisPort) {
  return new Promise((resolve, reject) => {
    const localPort = Math.floor(Math.random() * 50000) + 10000;
    const localHost = '127.0.0.1';
    const server = net.createServer((localSocket) => {
      client.forwardOut(localHost, localPort, redisHost, redisPort, (error, remoteStream) => {
        if (error) { localSocket.destroy(); return; }
        localSocket.pipe(remoteStream).pipe(localSocket);
        localSocket.on('error', () => {});
        remoteStream.on('error', () => localSocket.destroy());
      });
    });
    server.listen(localPort, localHost, () => {
      resolve({ server, localPort, localHost });
    });
    server.on('error', reject);
  });
}

registerIpcHandler('connection:redis-connect', async (_event, connectionId, rawConfig) => {
  const activeConnection = getActiveConnection(connectionId);
  if (!isPlainObject(rawConfig)) { throw new Error('Redis 连接配置无效。'); }
  const redisHost = readBoundedString(rawConfig.host || '127.0.0.1', 'Redis 主机', 256);
  const redisPort = readIntegerInRange(rawConfig.port, 'Redis 端口', 1, 65535, 6379);
  const redisPassword = typeof rawConfig.password === 'string' ? rawConfig.password : undefined;
  const redisDb = typeof rawConfig.db === 'number' ? rawConfig.db : (parseInt(rawConfig.db, 10) || 0);
  const redisId = readBoundedString(rawConfig.redisId || crypto.randomUUID(), 'Redis 连接 ID', 128);
  const key = getRedisKey(connectionId, redisId);
  const existing = activeRedisConnections.get(key);
  if (existing) {
    try { await existing.connection.ping(); return { redisId, alreadyConnected: true }; }
    catch { existing.tunnelServer.close(); activeRedisConnections.delete(key); }
  }
  const { server: tunnelServer, localPort } = await createRedisTunnel(activeConnection.client, redisHost, redisPort);
  const redis = new Redis({
    host: '127.0.0.1', port: localPort, password: redisPassword, db: redisDb,
    lazyConnect: true, connectTimeout: 15000, maxRetriesPerRequest: 1,
  });
  await redis.connect();
  activeRedisConnections.set(key, { connection: redis, connectionId, redisId, tunnelServer });
  return { redisId };
});

registerIpcHandler('connection:redis-disconnect', async (_event, connectionId, rawRedisId) => {
  const redisId = readBoundedString(rawRedisId, 'Redis 连接 ID', 128);
  const key = getRedisKey(connectionId, redisId);
  const entry = activeRedisConnections.get(key);
  if (entry) { activeRedisConnections.delete(key); entry.connection.disconnect(); entry.tunnelServer.close(); }
  return true;
});

registerIpcHandler('connection:redis-keys', async (_event, connectionId, rawRedisId, rawPattern) => {
  const redisId = readBoundedString(rawRedisId, 'Redis 连接 ID', 128);
  const pattern = typeof rawPattern === 'string' ? rawPattern : '*';
  const key = getRedisKey(connectionId, redisId);
  const entry = activeRedisConnections.get(key);
  if (!entry) { throw new Error('Redis 连接已断开。'); }
  const allKeys = [];
  let cursor = '0';
  do {
    const [nextCursor, batch] = await entry.connection.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    cursor = nextCursor;
    allKeys.push(...batch);
  } while (cursor !== '0');
  const result = [];
  const pipeline = entry.connection.pipeline();
  for (const k of allKeys) { pipeline.type(k); pipeline.ttl(k); }
  const pipelineResults = await pipeline.exec();
  for (let i = 0; i < allKeys.length; i++) {
    const typeErr = pipelineResults[i * 2][0];
    const typeVal = pipelineResults[i * 2][1];
    const ttlErr = pipelineResults[i * 2 + 1][0];
    const ttlVal = pipelineResults[i * 2 + 1][1];
    result.push({ name: allKeys[i], type: typeErr ? 'unknown' : (typeVal || 'none'), ttl: ttlErr ? -2 : ttlVal });
  }
  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
});

registerIpcHandler('connection:redis-get-value', async (_event, connectionId, rawRedisId, rawKey) => {
  const redisId = readBoundedString(rawRedisId, 'Redis 连接 ID', 128);
  const key = readBoundedString(rawKey, '键名', 1024);
  const redisKey = getRedisKey(connectionId, redisId);
  const entry = activeRedisConnections.get(redisKey);
  if (!entry) { throw new Error('Redis 连接已断开。'); }
  const type = await entry.connection.type(key);
  let value;
  switch (type) {
    case 'string': value = await entry.connection.get(key); break;
    case 'hash': value = await entry.connection.hgetall(key); break;
    case 'list': value = await entry.connection.lrange(key, 0, -1); break;
    case 'set': value = await entry.connection.smembers(key); break;
    case 'zset': value = await entry.connection.zrange(key, 0, -1, 'WITHSCORES'); break;
    case 'none': throw new Error(`键 "${key}" 不存在。`);
    default: value = await entry.connection.call('DUMP', key); break;
  }
  return { type, value };
});

registerIpcHandler('connection:redis-set-value', async (_event, connectionId, rawRedisId, rawKey, rawValue, rawType) => {
  const redisId = readBoundedString(rawRedisId, 'Redis 连接 ID', 128);
  const key = readBoundedString(rawKey, '键名', 1024);
  const redisKey = getRedisKey(connectionId, redisId);
  const entry = activeRedisConnections.get(redisKey);
  if (!entry) { throw new Error('Redis 连接已断开。'); }
  const type = typeof rawType === 'string' ? rawType : 'string';
  const pipeline = entry.connection.pipeline();
  pipeline.del(key);
  switch (type) {
    case 'string': pipeline.set(key, String(rawValue)); break;
    case 'hash': {
      if (typeof rawValue === 'object' && rawValue !== null && !Array.isArray(rawValue)) {
        pipeline.hset(key, rawValue);
      }
      break;
    }
    case 'list': {
      if (Array.isArray(rawValue) && rawValue.length > 0) {
        pipeline.rpush(key, ...rawValue);
      }
      break;
    }
    case 'set': {
      if (Array.isArray(rawValue) && rawValue.length > 0) {
        pipeline.sadd(key, ...rawValue);
      }
      break;
    }
    case 'zset': {
      if (Array.isArray(rawValue)) {
        const zsetArgs = [];
        for (let i = 0; i < rawValue.length; i++) {
          const item = rawValue[i];
          if (typeof item === 'object' && item !== null && 'member' in item && 'score' in item) {
            zsetArgs.push(item.score, item.member);
          } else if (i % 2 === 0 && i + 1 < rawValue.length) {
            zsetArgs.push(rawValue[i + 1], rawValue[i]);
            i++;
          }
        }
        if (zsetArgs.length > 0) pipeline.zadd(key, ...zsetArgs);
      }
      break;
    }
  }
  await pipeline.exec();
  return true;
});

registerIpcHandler('connection:redis-delete-key', async (_event, connectionId, rawRedisId, rawKey) => {
  const redisId = readBoundedString(rawRedisId, 'Redis 连接 ID', 128);
  const key = readBoundedString(rawKey, '键名', 1024);
  const redisKey = getRedisKey(connectionId, redisId);
  const entry = activeRedisConnections.get(redisKey);
  if (!entry) { throw new Error('Redis 连接已断开。'); }
  await entry.connection.del(key);
  return true;
});

registerIpcHandler('connection:redis-command', async (_event, connectionId, rawRedisId, rawCommand, rawArgs) => {
  const redisId = readBoundedString(rawRedisId, 'Redis 连接 ID', 128);
  const command = readBoundedString(rawCommand, '命令', 256);
  const key = getRedisKey(connectionId, redisId);
  const entry = activeRedisConnections.get(key);
  if (!entry) { throw new Error('Redis 连接已断开。'); }
  const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
  const result = await entry.connection.call(command, ...args);
  return result;
});

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
