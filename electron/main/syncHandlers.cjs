const { app, BrowserWindow, safeStorage } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { createVaultSnapshot, getVault, notifyVaultChanged, setVault } = require('./vaultStore.cjs');
const { isPlainObject, readBoolean, readBoundedString, readIntegerInRange } = require('./validation.cjs');

const syncSettingsFileName = 'sync.json';
const syncSettingsFormat = 'shelldesk-sync-settings';
const syncSettingsVersion = 1;
const encryptedSyncBundleFormat = 'shelldesk-sync-encrypted';
const encryptedSyncBundleVersion = 1;
const remoteSyncFormat = 'shelldesk-sync-webdav';
const remoteSyncVersion = 1;
const defaultRemotePath = '/ShellDesk/shelldesk-sync.json';
const syncRequestTimeoutMs = 25_000;
const maxRemoteSyncBytes = 25 * 1024 * 1024;
const syncKdfIterations = 210_000;
const syncTombstoneRetentionMs = 30 * 24 * 60 * 60 * 1000;
const autoSyncStartupDelayMs = 12_000;
const syncPasswordPlaceholder = '••••••••';
const syncedContentRecordTypes = new Set(['host', 'bookmark', 'proxyProfile', 'knownHost']);
const suspiciousShrinkRatio = 0.5;
const suspiciousShrinkMinimumLost = 3;
const suspiciousShrinkAbsoluteLost = 10;

let syncTimer = null;
let startupSyncTimer = null;
let activeSyncPromise = null;

function emitSyncChanged(payload) {
  for (const browserWindow of BrowserWindow.getAllWindows()) {
    if (!browserWindow.isDestroyed()) {
      browserWindow.webContents.send('sync:changed', payload);
    }
  }
}

function getSyncSettingsPath() {
  return path.join(app.getPath('userData'), syncSettingsFileName);
}

function createDefaultSyncStore() {
  return {
    config: {
      enabled: false,
      provider: 'webdav',
      webdavUrl: '',
      webdavUsername: '',
      webdavRemotePath: defaultRemotePath,
      ignoreCertificateErrors: false,
      intervalMinutes: 15,
      syncOnStartup: true,
      lastSyncAt: '',
      lastSyncStatus: 'idle',
      lastSyncMessage: '尚未同步',
      lastConflictCount: 0,
    },
    secrets: {
      webdavPassword: '',
      syncPassphrase: '',
    },
    state: {
      deviceId: crypto.randomUUID(),
      lastRecords: {},
      lastTombstones: {},
      lastSyncAt: '',
      lastRemoteEtag: '',
    },
  };
}

function readOptionalString(value, label, maxLength) {
  if (value === undefined || value === null) {
    return '';
  }

  return readBoundedString(value, label, maxLength, { required: false });
}

function normalizeWebDavUrl(value, required) {
  const rawUrl = readOptionalString(value, 'WebDAV 地址', 2048);

  if (!rawUrl) {
    if (required) {
      throw new Error('请输入 WebDAV 地址。');
    }

    return '';
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new Error('WebDAV 地址无效。');
  }

  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    throw new Error('WebDAV 地址只支持 http 或 https。');
  }

  parsedUrl.hash = '';
  return parsedUrl.toString();
}

function normalizeRemotePath(value) {
  const rawPath = readOptionalString(value, '远程同步文件路径', 512) || defaultRemotePath;
  const normalizedPath = rawPath.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  const withRoot = normalizedPath.startsWith('/') ? normalizedPath : `/${normalizedPath}`;
  const parts = withRoot.split('/').filter(Boolean);

  if (!parts.length || parts.some((part) => part === '.' || part === '..' || /[\0?#]/.test(part))) {
    throw new Error('远程同步文件路径无效。');
  }

  return `/${parts.join('/')}`;
}

function normalizeSyncStatus(value) {
  return value === 'success' || value === 'warning' || value === 'error' ? value : 'idle';
}

function normalizeSyncConfig(rawConfig, fallbackConfig = createDefaultSyncStore().config) {
  const enabled = readBoolean(rawConfig?.enabled, '自动同步开关', fallbackConfig.enabled);
  const intervalMinutes = readIntegerInRange(
    rawConfig?.intervalMinutes,
    '自动同步间隔',
    5,
    1440,
    fallbackConfig.intervalMinutes,
  );

  return {
    enabled,
    provider: 'webdav',
    webdavUrl: normalizeWebDavUrl(rawConfig?.webdavUrl ?? fallbackConfig.webdavUrl, enabled),
    webdavUsername: readBoundedString(
      rawConfig?.webdavUsername ?? fallbackConfig.webdavUsername ?? '',
      'WebDAV 用户名',
      256,
      { required: enabled },
    ),
    webdavRemotePath: normalizeRemotePath(rawConfig?.webdavRemotePath ?? fallbackConfig.webdavRemotePath),
    ignoreCertificateErrors: readBoolean(
      rawConfig?.ignoreCertificateErrors,
      '忽略 WebDAV 证书错误',
      fallbackConfig.ignoreCertificateErrors ?? false,
    ),
    intervalMinutes,
    syncOnStartup: readBoolean(rawConfig?.syncOnStartup, '启动时同步', fallbackConfig.syncOnStartup),
    lastSyncAt: readOptionalString(rawConfig?.lastSyncAt ?? fallbackConfig.lastSyncAt, '上次同步时间', 64),
    lastSyncStatus: normalizeSyncStatus(rawConfig?.lastSyncStatus ?? fallbackConfig.lastSyncStatus),
    lastSyncMessage: readOptionalString(rawConfig?.lastSyncMessage ?? fallbackConfig.lastSyncMessage, '同步状态', 400),
    lastConflictCount: readIntegerInRange(
      rawConfig?.lastConflictCount,
      '冲突数量',
      0,
      10000,
      fallbackConfig.lastConflictCount,
    ),
  };
}

function normalizeSyncSecrets(rawSecrets = {}) {
  return {
    webdavPassword: readOptionalString(rawSecrets.webdavPassword ?? '', 'WebDAV 密码', 4096),
    syncPassphrase: readOptionalString(rawSecrets.syncPassphrase ?? '', '同步密码', 4096),
  };
}

function normalizeSyncState(rawState = {}) {
  const defaultState = createDefaultSyncStore().state;
  const lastRecords = {};
  const lastTombstones = {};

  if (isPlainObject(rawState.lastRecords)) {
    for (const [id, record] of Object.entries(rawState.lastRecords)) {
      if (!isPlainObject(record)) {
        continue;
      }

      try {
        lastRecords[readBoundedString(id, '同步记录 ID', 260)] = {
          type: readEntityType(record.type),
          hash: readBoundedString(record.hash, '同步记录摘要', 128),
          updatedAt: readOptionalString(record.updatedAt, '同步记录更新时间', 64),
        };
      } catch {
        // Ignore one malformed local sync state entry.
      }
    }
  }

  if (isPlainObject(rawState.lastTombstones)) {
    for (const [id, tombstone] of Object.entries(rawState.lastTombstones)) {
      if (!isPlainObject(tombstone)) {
        continue;
      }

      try {
        const tombstoneId = readBoundedString(id, '同步删除记录 ID', 260);
        lastTombstones[tombstoneId] = {
          id: tombstoneId,
          type: readEntityType(tombstone.type),
          deletedAt: readOptionalString(tombstone.deletedAt, '删除时间', 64),
          deviceId: readOptionalString(tombstone.deviceId, '设备 ID', 128),
          hash: readOptionalString(tombstone.hash, '同步记录摘要', 128),
        };
      } catch {
        // Ignore one malformed local tombstone entry.
      }
    }
  }

  return {
    deviceId: readOptionalString(rawState.deviceId, '设备 ID', 128) || defaultState.deviceId,
    lastRecords,
    lastTombstones,
    lastSyncAt: readOptionalString(rawState.lastSyncAt, '上次同步时间', 64),
    lastRemoteEtag: readOptionalString(rawState.lastRemoteEtag, '远端 ETag', 256),
  };
}

function decryptLocalSecrets(ciphertext) {
  const encrypted = readBoundedString(ciphertext, '同步设置密文', 2 * 1024 * 1024, { trim: false });
  return JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, 'base64')));
}

function readSyncStore() {
  const defaults = createDefaultSyncStore();
  const settingsPath = getSyncSettingsPath();

  if (!fs.existsSync(settingsPath)) {
    return defaults;
  }

  const rawPayload = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

  if (!isPlainObject(rawPayload) || rawPayload.format !== syncSettingsFormat || rawPayload.version !== syncSettingsVersion) {
    throw new Error('同步设置文件格式不受支持。');
  }

  const rawSecrets = rawPayload.protected
    ? decryptLocalSecrets(rawPayload.ciphertext)
    : rawPayload.secrets;

  return {
    config: normalizeSyncConfig(rawPayload.config ?? {}, defaults.config),
    secrets: normalizeSyncSecrets(rawSecrets),
    state: normalizeSyncState(rawPayload.state),
  };
}

function createLocalSecretsWrapper(secrets) {
  const payloadJson = JSON.stringify(normalizeSyncSecrets(secrets));

  if (safeStorage.isEncryptionAvailable()) {
    return {
      protected: true,
      ciphertext: safeStorage.encryptString(payloadJson).toString('base64'),
    };
  }

  return {
    protected: false,
    secrets,
  };
}

function writeSyncStore(store) {
  const settingsPath = getSyncSettingsPath();
  const config = normalizeSyncConfig(store.config ?? {}, createDefaultSyncStore().config);
  const secrets = normalizeSyncSecrets(store.secrets);
  const state = normalizeSyncState(store.state);
  const secretsWrapper = createLocalSecretsWrapper(secrets);
  const wrapper = {
    format: syncSettingsFormat,
    version: syncSettingsVersion,
    updatedAt: new Date().toISOString(),
    config,
    state,
    ...secretsWrapper,
  };

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(wrapper, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });

  return { config, secrets, state };
}

function toPublicSyncConfig(store = readSyncStore()) {
  return {
    ...store.config,
    deviceId: store.state.deviceId,
    hasWebDavPassword: Boolean(store.secrets.webdavPassword),
    hasSyncPassphrase: Boolean(store.secrets.syncPassphrase),
  };
}

function readIncomingSecret(value, previousValue) {
  if (typeof value !== 'string') {
    return previousValue;
  }

  if (!value || value === syncPasswordPlaceholder) {
    return previousValue;
  }

  return value;
}

function readConflictResolution(value) {
  return value === 'local' || value === 'remote' ? value : '';
}

function readEmptyVaultResolution(value) {
  return value === 'restoreRemote' || value === 'keepEmpty' ? value : '';
}

function readShrinkResolution(value) {
  return value === 'allow' ? value : '';
}

function saveSyncConfig(rawConfig) {
  if (!isPlainObject(rawConfig)) {
    throw new Error('同步设置无效。');
  }

  const currentStore = readSyncStore();
  const nextConfig = normalizeSyncConfig(rawConfig, currentStore.config);
  const nextSecrets = normalizeSyncSecrets({
    webdavPassword: readIncomingSecret(rawConfig.webdavPassword, currentStore.secrets.webdavPassword),
    syncPassphrase: readIncomingSecret(rawConfig.syncPassphrase, currentStore.secrets.syncPassphrase),
  });

  if (nextConfig.enabled) {
    ensureOperationalSettings(nextConfig, nextSecrets, { requireSyncPassphrase: true });
  }

  const nextStore = writeSyncStore({
    config: nextConfig,
    secrets: nextSecrets,
    state: currentStore.state,
  });

  reloadSyncSchedule();
  return toPublicSyncConfig(nextStore);
}

function readEntityType(value) {
  if (
    value === 'host' ||
    value === 'bookmark' ||
    value === 'settings' ||
    value === 'proxyProfile' ||
    value === 'knownHost'
  ) {
    return value;
  }

  throw new Error('同步记录类型无效。');
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }

  return JSON.stringify(value);
}

function hashPayload(payload) {
  return crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');
}

function getValidDateTime(value, fallback) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function compareTime(left, right) {
  return new Date(left || 0).getTime() - new Date(right || 0).getTime();
}

function isSyncedContentType(type) {
  return syncedContentRecordTypes.has(type);
}

function countRecordsByType(records) {
  const counts = {};

  for (const record of Object.values(records ?? {})) {
    if (!record || !isSyncedContentType(record.type)) {
      continue;
    }

    counts[record.type] = (counts[record.type] ?? 0) + 1;
  }

  return counts;
}

function sumCounts(counts) {
  return Object.values(counts).reduce((total, count) => total + count, 0);
}

function countContentRecords(records) {
  return sumCounts(countRecordsByType(records));
}

function createConflictSummary(conflicts) {
  const counts = {};

  for (const conflict of conflicts) {
    counts[conflict.type] = (counts[conflict.type] ?? 0) + 1;
  }

  return Object.entries(counts)
    .map(([type, count]) => ({ type, count }))
    .sort((left, right) => left.type.localeCompare(right.type));
}

function createSyncSummary({ localRecords, localTombstones, remoteDocument, mergedDocument, uploaded, downloaded, deleted, conflicts }) {
  const localCounts = countRecordsByType(localRecords);
  const remoteCounts = countRecordsByType(remoteDocument.records);
  const mergedCounts = countRecordsByType(mergedDocument.records);
  const tombstoneCounts = countRecordsByType({
    ...remoteDocument.tombstones,
    ...localTombstones,
    ...mergedDocument.tombstones,
  });

  return {
    localRecords: sumCounts(localCounts),
    remoteRecords: sumCounts(remoteCounts),
    mergedRecords: sumCounts(mergedCounts),
    tombstones: sumCounts(tombstoneCounts),
    uploaded,
    downloaded,
    deleted,
    conflictCount: conflicts.length,
    conflictsByType: createConflictSummary(conflicts),
    recordsByType: mergedCounts,
  };
}

function createEmptyVaultSummary(localRecords, remoteRecords) {
  return {
    localRecords: countContentRecords(localRecords),
    remoteRecords: countContentRecords(remoteRecords),
    remoteRecordsByType: countRecordsByType(remoteRecords),
  };
}

function shouldRequestEmptyVaultResolution(localRecords, remoteDocument, emptyVaultResolution) {
  return (
    !emptyVaultResolution &&
    countContentRecords(localRecords) === 0 &&
    countContentRecords(remoteDocument.records) > 0
  );
}

function createTombstonesForRecords(records, state, now) {
  const tombstones = {};

  for (const [id, record] of Object.entries(records)) {
    if (!isSyncedContentType(record.type)) {
      continue;
    }

    tombstones[id] = {
      id,
      type: record.type,
      deletedAt: now,
      deviceId: state.deviceId,
      hash: record.hash,
    };
  }

  return tombstones;
}

function detectSuspiciousShrink({ state, localRecords, remoteDocument, mergedDocument }) {
  const previousCounts = countRecordsByType(state.lastRecords);
  const localCounts = countRecordsByType(localRecords);
  const remoteCounts = countRecordsByType(remoteDocument.records);
  const mergedCounts = countRecordsByType(mergedDocument.records);
  const previousCount = sumCounts(previousCounts);
  const localCount = sumCounts(localCounts);
  const remoteCount = sumCounts(remoteCounts);
  const mergedCount = sumCounts(mergedCounts);
  const baselineCount = Math.max(previousCount, localCount, remoteCount);
  const lostCount = baselineCount - mergedCount;

  if (baselineCount <= 0 || lostCount <= 0) {
    return null;
  }

  const isSuspicious = lostCount >= suspiciousShrinkAbsoluteLost ||
    (lostCount >= suspiciousShrinkMinimumLost && mergedCount <= Math.floor(baselineCount * suspiciousShrinkRatio));

  if (!isSuspicious) {
    return null;
  }

  const lostByType = {};
  const allTypes = new Set([
    ...Object.keys(previousCounts),
    ...Object.keys(localCounts),
    ...Object.keys(remoteCounts),
    ...Object.keys(mergedCounts),
  ]);

  for (const type of allTypes) {
    const baselineForType = Math.max(previousCounts[type] ?? 0, localCounts[type] ?? 0, remoteCounts[type] ?? 0);
    const lostForType = baselineForType - (mergedCounts[type] ?? 0);

    if (lostForType > 0) {
      lostByType[type] = lostForType;
    }
  }

  return {
    baselineRecords: baselineCount,
    mergedRecords: mergedCount,
    lostRecords: lostCount,
    previousRecords: previousCount,
    localRecords: localCount,
    remoteRecords: remoteCount,
    lostByType,
  };
}

function toPublicHostPayload(host) {
  const { password: _password, passphrase: _passphrase, rootPassword: _rootPassword, ...publicHost } = host;
  return {
    ...publicHost,
    password: '',
    passphrase: '',
    rootPassword: '',
  };
}

function toPublicSettingsPayload(settings) {
  return {
    ...settings,
    aiApiKey: '',
  };
}

function toPublicProxyProfilePayload(profile) {
  return {
    ...profile,
    config: {
      ...profile.config,
      password: '',
    },
  };
}

function createSyncRecord(entityId, type, payload, updatedAt, deviceId) {
  return {
    id: entityId,
    type,
    updatedAt,
    deviceId,
    hash: hashPayload(payload),
    payload,
  };
}

function createLocalRecords(vault, state, now) {
  const records = {};

  for (const host of vault.hosts) {
    const payload = toPublicHostPayload(host);
    const entityId = `host:${host.id}`;
    records[entityId] = createSyncRecord(
      entityId,
      'host',
      payload,
      getValidDateTime(host.updatedAt, now),
      state.deviceId,
    );
  }

  for (const profile of vault.proxyProfiles) {
    const payload = toPublicProxyProfilePayload(profile);
    const entityId = `proxyProfile:${profile.id}`;
    records[entityId] = createSyncRecord(
      entityId,
      'proxyProfile',
      payload,
      getValidDateTime(profile.updatedAt, now),
      state.deviceId,
    );
  }

  for (const knownHost of vault.knownHosts) {
    const payload = knownHost;
    const entityId = `knownHost:${knownHost.id}`;
    const payloadHash = hashPayload(payload);
    const previousRecord = state.lastRecords[entityId];
    const updatedAt = previousRecord?.hash === payloadHash
      ? previousRecord.updatedAt || state.lastSyncAt || now
      : now;
    records[entityId] = createSyncRecord(
      entityId,
      'knownHost',
      payload,
      updatedAt,
      state.deviceId,
    );
  }

  const settingsPayload = toPublicSettingsPayload(vault.settings);
  const settingsEntityId = 'settings:app';
  const settingsHash = hashPayload(settingsPayload);
  const previousSettings = state.lastRecords[settingsEntityId];
  const settingsUpdatedAt = previousSettings?.hash === settingsHash
    ? previousSettings.updatedAt || state.lastSyncAt || now
    : now;
  records[settingsEntityId] = {
    id: settingsEntityId,
    type: 'settings',
    updatedAt: settingsUpdatedAt,
    deviceId: state.deviceId,
    hash: settingsHash,
    payload: settingsPayload,
  };

  for (const collection of vault.browserBookmarks) {
    for (const bookmark of collection.bookmarks) {
      const payload = {
        scope: collection.scope,
        bookmark,
      };
      const entityId = `bookmark:${hashPayload(collection.scope).slice(0, 16)}:${bookmark.id}`;
      records[entityId] = createSyncRecord(
        entityId,
        'bookmark',
        payload,
        getValidDateTime(bookmark.updatedAt || collection.updatedAt, now),
        state.deviceId,
      );
    }
  }

  return records;
}

function createLocalTombstones(localRecords, state, now) {
  const tombstones = {};
  const cutoff = Date.now() - syncTombstoneRetentionMs;

  for (const [id, previousTombstone] of Object.entries(state.lastTombstones ?? {})) {
    if (localRecords[id]) {
      continue;
    }

    if (new Date(previousTombstone.deletedAt || 0).getTime() < cutoff) {
      continue;
    }

    tombstones[id] = previousTombstone;
  }

  for (const [id, previousRecord] of Object.entries(state.lastRecords)) {
    if (id === 'settings:app' || localRecords[id]) {
      continue;
    }

    tombstones[id] = {
      id,
      type: previousRecord.type,
      deletedAt: now,
      deviceId: state.deviceId,
      hash: previousRecord.hash,
    };
  }

  return tombstones;
}

function createSyncFootprint(records, tombstones) {
  const recordFootprint = {};
  const tombstoneFootprint = {};

  for (const [id, record] of Object.entries(records)) {
    recordFootprint[id] = {
      type: record.type,
      hash: record.hash,
    };
  }

  for (const [id, tombstone] of Object.entries(tombstones)) {
    tombstoneFootprint[id] = {
      type: tombstone.type,
      hash: tombstone.hash,
    };
  }

  return stableStringify({
    records: recordFootprint,
    tombstones: tombstoneFootprint,
  });
}

function createLocalSyncInputs(state, now) {
  const vault = getVault();
  const localRecords = createLocalRecords(vault, state, now);
  const localTombstones = createLocalTombstones(localRecords, state, now);

  return {
    localRecords,
    localTombstones,
    footprint: createSyncFootprint(localRecords, localTombstones),
  };
}

function sanitizeRemoteRecord(rawRecord) {
  if (!isPlainObject(rawRecord)) {
    return null;
  }

  try {
    const id = readBoundedString(rawRecord.id, '同步记录 ID', 260);
    const type = readEntityType(rawRecord.type);
    const payload = isPlainObject(rawRecord.payload) ? rawRecord.payload : null;

    if (!payload) {
      return null;
    }

    return {
      id,
      type,
      updatedAt: readOptionalString(rawRecord.updatedAt, '同步记录更新时间', 64),
      deviceId: readOptionalString(rawRecord.deviceId, '设备 ID', 128),
      hash: readBoundedString(rawRecord.hash || hashPayload(payload), '同步记录摘要', 128),
      payload,
    };
  } catch {
    return null;
  }
}

function sanitizeRemoteTombstone(rawTombstone) {
  if (!isPlainObject(rawTombstone)) {
    return null;
  }

  try {
    return {
      id: readBoundedString(rawTombstone.id, '同步删除记录 ID', 260),
      type: readEntityType(rawTombstone.type),
      deletedAt: readOptionalString(rawTombstone.deletedAt, '删除时间', 64),
      deviceId: readOptionalString(rawTombstone.deviceId, '设备 ID', 128),
      hash: readOptionalString(rawTombstone.hash, '同步记录摘要', 128),
    };
  } catch {
    return null;
  }
}

function createEmptyRemoteDocument() {
  return {
    format: remoteSyncFormat,
    version: remoteSyncVersion,
    updatedAt: '',
    devices: {},
    records: {},
    tombstones: {},
  };
}

function readRemoteSyncDocument(rawPayload) {
  if (!isPlainObject(rawPayload) || rawPayload.format !== remoteSyncFormat || rawPayload.version !== remoteSyncVersion) {
    throw new Error('远端同步文件格式不受支持。');
  }

  const records = {};
  const tombstones = {};

  if (isPlainObject(rawPayload.records)) {
    for (const [id, rawRecord] of Object.entries(rawPayload.records)) {
      const record = sanitizeRemoteRecord({ ...rawRecord, id: rawRecord?.id ?? id });

      if (record) {
        records[record.id] = record;
      }
    }
  }

  if (isPlainObject(rawPayload.tombstones)) {
    for (const [id, rawTombstone] of Object.entries(rawPayload.tombstones)) {
      const tombstone = sanitizeRemoteTombstone({ ...rawTombstone, id: rawTombstone?.id ?? id });

      if (tombstone) {
        tombstones[tombstone.id] = tombstone;
      }
    }
  }

  return {
    format: remoteSyncFormat,
    version: remoteSyncVersion,
    updatedAt: readOptionalString(rawPayload.updatedAt, '远端同步更新时间', 64),
    devices: isPlainObject(rawPayload.devices) ? rawPayload.devices : {},
    records,
    tombstones,
  };
}

function createBasicAuthHeader(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

function encodePathSegment(segment) {
  return encodeURIComponent(segment).replace(/%2F/gi, '/');
}

function getRemotePathParts(remotePath) {
  return remotePath.split('/').filter(Boolean);
}

function createWebDavUrl(config, remotePath = config.webdavRemotePath) {
  const baseUrl = config.webdavUrl.endsWith('/') ? config.webdavUrl : `${config.webdavUrl}/`;
  const relativePath = getRemotePathParts(remotePath).map(encodePathSegment).join('/');
  return new URL(relativePath, baseUrl).toString();
}

function getNestedErrorCause(error) {
  let current = error;

  for (let depth = 0; depth < 4; depth += 1) {
    if (!current?.cause) {
      return current;
    }

    current = current.cause;
  }

  return current;
}

function getWebDavNetworkErrorMessage(error, requestUrl) {
  const cause = getNestedErrorCause(error);
  const code = typeof cause?.code === 'string' ? cause.code : '';
  const message = typeof cause?.message === 'string' && cause.message.trim()
    ? cause.message.trim()
    : error instanceof Error && error.message
      ? error.message
      : '';
  const host = (() => {
    try {
      return new URL(requestUrl).host;
    } catch {
      return 'WebDAV 服务';
    }
  })();

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `无法解析 WebDAV 主机「${host}」，请检查地址或 DNS。`;
  }

  if (code === 'ECONNREFUSED') {
    return `WebDAV 服务「${host}」拒绝连接，请检查地址、端口和服务状态。`;
  }

  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return `连接 WebDAV 服务「${host}」超时，请检查网络、代理或防火墙。`;
  }

  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'UND_ERR_SOCKET') {
    return `WebDAV 连接被中断，请检查网络、代理、服务端限制或地址是否正确。`;
  }

  if (code === 'CERT_HAS_EXPIRED') {
    return `WebDAV 证书已过期：${host}。`;
  }

  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
    return `WebDAV 证书域名与地址不匹配：${host}。`;
  }

  if (code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'SELF_SIGNED_CERT_IN_CHAIN' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
    return `WebDAV 证书不受信任：${host}。请使用受信任证书或在系统中安装对应 CA。`;
  }

  if (/certificate|tls|ssl/i.test(message)) {
    return `WebDAV TLS/证书校验失败：${message}`;
  }

  if (/proxy/i.test(message)) {
    return `WebDAV 代理连接失败：${message}`;
  }

  return message && message !== 'fetch failed'
    ? `WebDAV 网络请求失败：${message}`
    : `WebDAV 网络请求失败，请检查地址、网络、代理或证书配置。`;
}

function createWebDavResponse(status, statusText, headers, bodyBuffer) {
  const normalizedHeaders = new Map();

  for (const [key, value] of Object.entries(headers ?? {})) {
    normalizedHeaders.set(key.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value ?? ''));
  }

  return {
    status,
    statusText,
    ok: status >= 200 && status < 300,
    headers: {
      get: (key) => normalizedHeaders.get(String(key).toLowerCase()) ?? null,
    },
    text: async () => bodyBuffer.toString('utf8'),
  };
}

function createRedirectUrl(requestUrl, location) {
  try {
    return new URL(location, requestUrl).toString();
  } catch {
    return '';
  }
}

function isSameUrlOrigin(leftUrl, rightUrl) {
  try {
    return new URL(leftUrl).origin === new URL(rightUrl).origin;
  } catch {
    return false;
  }
}

function omitAuthorizationHeader(headers) {
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => key.toLowerCase() !== 'authorization'),
  );
}

async function readResponseText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function requestWebDavUrl(config, requestUrl, method, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(requestUrl);
    const isHttps = url.protocol === 'https:';
    const requestModule = isHttps ? https : http;
    const bodyBuffer = body === undefined || body === null
      ? null
      : Buffer.isBuffer(body)
        ? body
        : Buffer.from(String(body), 'utf8');
    const requestHeaders = { ...headers };

    if (bodyBuffer && !Object.keys(requestHeaders).some((key) => key.toLowerCase() === 'content-length')) {
      requestHeaders['Content-Length'] = String(bodyBuffer.length);
    }

    const request = requestModule.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method,
      headers: requestHeaders,
      rejectUnauthorized: isHttps ? !config.ignoreCertificateErrors : undefined,
    }, (response) => {
      const chunks = [];
      let totalLength = 0;

      response.on('data', (chunk) => {
        totalLength += chunk.length;

        if (totalLength <= maxRemoteSyncBytes) {
          chunks.push(chunk);
        }
      });

      response.on('end', () => {
        resolve(createWebDavResponse(
          response.statusCode ?? 0,
          response.statusMessage ?? '',
          response.headers,
          Buffer.concat(chunks),
        ));
      });
    });

    request.setTimeout(syncRequestTimeoutMs, () => {
      request.destroy(Object.assign(new Error('WebDAV 请求超时，请检查网络或服务地址。'), { code: 'ETIMEDOUT' }));
    });

    request.on('error', reject);

    if (bodyBuffer) {
      request.write(bodyBuffer);
    }

    request.end();
  });
}

async function webDavRequestAtUrl(config, requestUrl, method, headers, body, redirectCount = 0) {
  try {
    const response = await requestWebDavUrl(config, requestUrl, method, headers, body);

    if ([301, 302, 303, 307, 308].includes(response.status) && redirectCount < 5) {
      const location = response.headers.get('location');
      const redirectUrl = location ? createRedirectUrl(requestUrl, location) : '';

      if (redirectUrl) {
        const nextMethod = response.status === 303 ? 'GET' : method;
        const nextBody = nextMethod === 'GET' ? null : body;
        const nextHeaders = isSameUrlOrigin(requestUrl, redirectUrl)
          ? headers
          : omitAuthorizationHeader(headers);
        return webDavRequestAtUrl(config, redirectUrl, nextMethod, nextHeaders, nextBody, redirectCount + 1);
      }
    }

    return response;
  } catch (error) {
    if (error?.message === 'WebDAV 请求超时，请检查网络或服务地址。') {
      throw error;
    }

    throw new Error(getWebDavNetworkErrorMessage(error, requestUrl));
  }
}

async function webDavRequest(config, secrets, method, remotePath = config.webdavRemotePath, options = {}) {
  const requestUrl = createWebDavUrl(config, remotePath);
  const headers = {
    Authorization: createBasicAuthHeader(config.webdavUsername, secrets.webdavPassword),
    'User-Agent': `ShellDesk/${app.getVersion()} (${process.platform}; ${process.arch})`,
    ...options.headers,
  };

  return webDavRequestAtUrl(config, requestUrl, method, headers, options.body);
}

async function throwWebDavError(response, action) {
  const body = (await readResponseText(response)).replace(/\s+/g, ' ').trim().slice(0, 180);
  const suffix = body ? `：${body}` : '';
  throw new Error(`${action}失败：${response.status} ${response.statusText || ''}${suffix}`.trim());
}

async function ensureRemoteDirectories(config, secrets) {
  const parts = getRemotePathParts(config.webdavRemotePath);
  const directories = parts.slice(0, -1);
  let currentPath = '';

  for (const directory of directories) {
    currentPath = `${currentPath}/${directory}`;
    const response = await webDavRequest(config, secrets, 'MKCOL', currentPath);

    if ([201, 405, 409, 301, 302].includes(response.status)) {
      continue;
    }

    if (response.status === 401 || response.status === 403) {
      await throwWebDavError(response, '创建远程目录');
    }
  }
}

function deriveSyncKey(passphrase, salt, iterations) {
  return crypto.pbkdf2Sync(passphrase, salt, iterations, 32, 'sha256');
}

function encryptRemoteDocument(document, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveSyncKey(passphrase, salt, syncKdfIterations);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(document), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    format: encryptedSyncBundleFormat,
    version: encryptedSyncBundleVersion,
    algorithm: 'aes-256-gcm',
    kdf: 'pbkdf2-sha256',
    iterations: syncKdfIterations,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function decryptRemoteDocument(wrapper, passphrase) {
  if (!isPlainObject(wrapper) || wrapper.format !== encryptedSyncBundleFormat || wrapper.version !== encryptedSyncBundleVersion) {
    throw new Error('远端同步文件不是 ShellDesk 加密同步包。');
  }

  try {
    const salt = Buffer.from(readBoundedString(wrapper.salt, '同步 salt', 128), 'base64');
    const iv = Buffer.from(readBoundedString(wrapper.iv, '同步 IV', 128), 'base64');
    const tag = Buffer.from(readBoundedString(wrapper.tag, '同步认证标签', 128), 'base64');
    const ciphertext = Buffer.from(readBoundedString(wrapper.ciphertext, '同步密文', maxRemoteSyncBytes, { trim: false }), 'base64');
    const iterations = readIntegerInRange(wrapper.iterations, '同步加密迭代次数', 100_000, 1_000_000, syncKdfIterations);
    const key = deriveSyncKey(passphrase, salt, iterations);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);

    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('远端同步文件内容无效。');
    }

    throw new Error('同步密码不正确，或远端同步文件已损坏。');
  }
}

async function readRemoteDocument(config, secrets) {
  const response = await webDavRequest(config, secrets, 'GET');

  if (response.status === 404) {
    return {
      document: createEmptyRemoteDocument(),
      etag: '',
      exists: false,
    };
  }

  if (!response.ok) {
    await throwWebDavError(response, '读取远端同步文件');
  }

  const text = await response.text();

  if (!text || Buffer.byteLength(text, 'utf8') > maxRemoteSyncBytes) {
    throw new Error('远端同步文件为空或超过大小限制。');
  }

  const encryptedWrapper = JSON.parse(text);
  return {
    document: readRemoteSyncDocument(decryptRemoteDocument(encryptedWrapper, secrets.syncPassphrase)),
    etag: response.headers.get('etag') || '',
    exists: true,
  };
}

async function writeRemoteDocument(config, secrets, document, etag, exists) {
  const encryptedWrapper = encryptRemoteDocument(document, secrets.syncPassphrase);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
  };

  if (etag) {
    headers['If-Match'] = etag;
  } else if (!exists) {
    headers['If-None-Match'] = '*';
  }

  const response = await webDavRequest(config, secrets, 'PUT', config.webdavRemotePath, {
    headers,
    body: JSON.stringify(encryptedWrapper, null, 2),
  });

  if (response.status === 412) {
    return { preconditionFailed: true, etag: '' };
  }

  if (!response.ok && response.status !== 201 && response.status !== 204) {
    await throwWebDavError(response, '写入远端同步文件');
  }

  return {
    preconditionFailed: false,
    etag: response.headers.get('etag') || '',
  };
}

function addConflict(conflicts, record, reason) {
  conflicts.push({
    type: record.type,
    id: record.id,
    name: record.type === 'host'
      ? record.payload.name || record.payload.address || record.id
      : record.type === 'bookmark'
        ? record.payload.bookmark?.title || record.payload.bookmark?.url || record.id
        : record.type === 'proxyProfile'
          ? record.payload.name || record.payload.config?.host || record.id
          : record.type === 'knownHost'
            ? `${record.payload.hostname || record.id}:${record.payload.port || 22}`
            : '应用设置',
    reason,
  });
}

function mergeSyncDocuments(remoteDocument, localRecords, localTombstones, state, now, conflictResolution = '') {
  const mergedRecords = { ...remoteDocument.records };
  const mergedTombstones = { ...remoteDocument.tombstones };
  const conflicts = [];
  const keepLocal = conflictResolution === 'local';
  const keepRemote = conflictResolution === 'remote';
  let uploaded = 0;
  let downloaded = 0;
  let deleted = 0;

  for (const tombstone of Object.values(localTombstones)) {
    const remoteRecord = mergedRecords[tombstone.id];

    if (!remoteRecord || remoteRecord.hash === tombstone.hash || compareTime(tombstone.deletedAt, remoteRecord.updatedAt) >= 0) {
      delete mergedRecords[tombstone.id];
      mergedTombstones[tombstone.id] = tombstone;
      uploaded += 1;
      deleted += 1;
      continue;
    }

    if (keepLocal) {
      addConflict(conflicts, remoteRecord, '本机删除与远端修改冲突，已按选择保留本地：云端对应数据将删除。');
      delete mergedRecords[tombstone.id];
      mergedTombstones[tombstone.id] = tombstone;
      uploaded += 1;
      deleted += 1;
      continue;
    }

    addConflict(
      conflicts,
      remoteRecord,
      keepRemote
        ? '本机删除与远端修改冲突，已按选择保留云端：云端版本已恢复到本地。'
        : '本机删除与远端修改冲突，请选择保留本地或保留云端。',
    );

    if (keepRemote) {
      downloaded += 1;
    }
  }

  for (const [id, localRecord] of Object.entries(localRecords)) {
    const remoteTombstone = mergedTombstones[id];

    if (remoteTombstone && compareTime(remoteTombstone.deletedAt, localRecord.updatedAt) >= 0) {
      const previousRecord = state.lastRecords[id];
      const localChanged = previousRecord ? previousRecord.hash !== localRecord.hash : false;

      if (!localChanged) {
        delete mergedRecords[id];
        downloaded += 1;
        deleted += 1;
        continue;
      }

      if (keepRemote) {
        addConflict(conflicts, localRecord, '远端删除与本机修改冲突，已按选择保留云端：本机对应数据将删除。');
        delete mergedRecords[id];
        downloaded += 1;
        deleted += 1;
        continue;
      }

      if (keepLocal) {
        addConflict(conflicts, localRecord, '远端删除与本机修改冲突，已按选择保留本地：本机版本已覆盖到云端。');
        delete mergedTombstones[id];
        mergedRecords[id] = localRecord;
        uploaded += 1;
        continue;
      }

      addConflict(conflicts, localRecord, '远端删除与本机修改冲突，请选择保留本地或保留云端。');
      continue;
    }

    const remoteRecord = mergedRecords[id];

    if (!remoteRecord) {
      mergedRecords[id] = localRecord;
      uploaded += 1;
      continue;
    }

    if (remoteRecord.hash === localRecord.hash) {
      mergedRecords[id] = compareTime(localRecord.updatedAt, remoteRecord.updatedAt) > 0 ? localRecord : remoteRecord;
      continue;
    }

    const previousRecord = state.lastRecords[id];
    const localChanged = previousRecord ? previousRecord.hash !== localRecord.hash : false;
    const remoteChanged = previousRecord ? previousRecord.hash !== remoteRecord.hash : false;

    if (previousRecord && localChanged && remoteChanged) {
      const conflictLabel = localRecord.type === 'settings' ? '设置' : '同一条数据';

      if (keepRemote) {
        addConflict(conflicts, localRecord, `${conflictLabel}在本机和远端都被修改，已按选择保留云端版本。`);
        downloaded += 1;
        continue;
      }

      if (keepLocal) {
        addConflict(conflicts, localRecord, `${conflictLabel}在本机和远端都被修改，已按选择保留本地版本。`);
        mergedRecords[id] = localRecord;
        uploaded += 1;
        continue;
      }

      addConflict(conflicts, localRecord, `${conflictLabel}在本机和远端都被修改，请选择保留本地或保留云端。`);
      continue;
    }

    if (compareTime(localRecord.updatedAt, remoteRecord.updatedAt) >= 0) {
      mergedRecords[id] = localRecord;
      uploaded += 1;
    } else {
      downloaded += 1;
    }
  }

  const cutoff = Date.now() - syncTombstoneRetentionMs;

  for (const [id, tombstone] of Object.entries(mergedTombstones)) {
    if (new Date(tombstone.deletedAt || 0).getTime() < cutoff) {
      delete mergedTombstones[id];
    }
  }

  return {
    document: {
      format: remoteSyncFormat,
      version: remoteSyncVersion,
      updatedAt: now,
      devices: {
        ...remoteDocument.devices,
        [state.deviceId]: {
          name: os.hostname(),
          platform: process.platform,
          arch: process.arch,
          lastSeenAt: now,
        },
      },
      records: mergedRecords,
      tombstones: mergedTombstones,
    },
    conflicts,
    uploaded,
    downloaded,
    deleted,
  };
}

function rebuildBookmarksFromRecords(records) {
  const collectionsByScope = new Map();

  for (const record of Object.values(records)) {
    if (record.type !== 'bookmark' || !isPlainObject(record.payload)) {
      continue;
    }

    const scope = typeof record.payload.scope === 'string' ? record.payload.scope : '';
    const bookmark = isPlainObject(record.payload.bookmark) ? record.payload.bookmark : null;

    if (!scope || !bookmark) {
      continue;
    }

    const collection = collectionsByScope.get(scope) ?? {
      scope,
      bookmarks: [],
      updatedAt: record.updatedAt,
    };

    collection.bookmarks.push(bookmark);

    if (compareTime(record.updatedAt, collection.updatedAt) > 0) {
      collection.updatedAt = record.updatedAt;
    }

    collectionsByScope.set(scope, collection);
  }

  return Array.from(collectionsByScope.values()).map((collection) => ({
    ...collection,
    bookmarks: collection.bookmarks.sort((left, right) => String(left.title).localeCompare(String(right.title), 'zh-CN')),
  }));
}

function mergeHostSecrets(publicHost, currentHost) {
  if (!currentHost) {
    return {
      ...publicHost,
      password: '',
      passphrase: '',
      rootPassword: '',
    };
  }

  return {
    ...publicHost,
    password: currentHost.password || '',
    passphrase: currentHost.passphrase || '',
    rootPassword: currentHost.rootPassword || '',
  };
}

function mergeProxyProfileSecrets(publicProfile, currentProfile) {
  return {
    ...publicProfile,
    config: {
      ...publicProfile.config,
      password: currentProfile?.config?.password || '',
    },
  };
}

function applyMergedDocumentToVault(document) {
  const currentVault = getVault();
  const currentHostsById = new Map(currentVault.hosts.map((host) => [host.id, host]));
  const currentProxyProfilesById = new Map(currentVault.proxyProfiles.map((profile) => [profile.id, profile]));
  const hosts = Object.values(document.records)
    .filter((record) => record.type === 'host')
    .map((record) => mergeHostSecrets(record.payload, currentHostsById.get(record.payload.id)));
  const proxyProfiles = Object.values(document.records)
    .filter((record) => record.type === 'proxyProfile')
    .map((record) => mergeProxyProfileSecrets(record.payload, currentProxyProfilesById.get(record.payload.id)))
    .sort((left, right) => String(left.name).localeCompare(String(right.name), 'zh-CN'));
  const knownHosts = Object.values(document.records)
    .filter((record) => record.type === 'knownHost')
    .map((record) => record.payload)
    .sort((left, right) => `${left.hostname}:${left.port}`.localeCompare(`${right.hostname}:${right.port}`, 'zh-CN'));
  const settingsRecord = document.records['settings:app'];
  const settings = settingsRecord?.type === 'settings'
    ? {
        ...settingsRecord.payload,
        aiApiKey: currentVault.settings.aiApiKey || '',
      }
    : currentVault.settings;
  const nextVault = setVault({
    ...currentVault,
    hosts,
    settings,
    proxyProfiles,
    knownHosts,
    browserBookmarks: rebuildBookmarksFromRecords(document.records),
  });

  notifyVaultChanged({ kind: 'vault' });
  return createVaultSnapshot(nextVault);
}

function createStateFromDocument(document, deviceId, etag, now) {
  const lastRecords = {};
  const lastTombstones = {};

  for (const [id, record] of Object.entries(document.records)) {
    lastRecords[id] = {
      type: record.type,
      hash: record.hash,
      updatedAt: record.updatedAt,
    };
  }

  for (const [id, tombstone] of Object.entries(document.tombstones)) {
    lastTombstones[id] = {
      id,
      type: tombstone.type,
      deletedAt: tombstone.deletedAt,
      deviceId: tombstone.deviceId,
      hash: tombstone.hash,
    };
  }

  return {
    deviceId,
    lastRecords,
    lastTombstones,
    lastSyncAt: now,
    lastRemoteEtag: etag || '',
  };
}

function ensureOperationalSettings(config, secrets, options = {}) {
  const { requireSyncPassphrase = true } = options;

  if (!config.webdavUrl) {
    throw new Error('请先填写 WebDAV 地址。');
  }

  if (!config.webdavUsername) {
    throw new Error('请先填写 WebDAV 用户名。');
  }

  if (!secrets.webdavPassword) {
    throw new Error('请先填写 WebDAV 密码或应用密码。');
  }

  if (requireSyncPassphrase && secrets.syncPassphrase.length < 8) {
    throw new Error('同步密码至少需要 8 个字符。');
  }
}

function createOperationalStore(rawConfig, options = {}) {
  const currentStore = readSyncStore();

  if (!rawConfig) {
    ensureOperationalSettings(currentStore.config, currentStore.secrets, options);
    return currentStore;
  }

  if (!isPlainObject(rawConfig)) {
    throw new Error('同步设置无效。');
  }

  const config = normalizeSyncConfig(rawConfig, currentStore.config);
  const secrets = normalizeSyncSecrets({
    webdavPassword: readIncomingSecret(rawConfig.webdavPassword, currentStore.secrets.webdavPassword),
    syncPassphrase: readIncomingSecret(rawConfig.syncPassphrase, currentStore.secrets.syncPassphrase),
  });

  ensureOperationalSettings(config, secrets, options);
  return {
    config,
    secrets,
    state: currentStore.state,
  };
}

async function testWebDav(rawConfig) {
  const store = createOperationalStore(rawConfig, { requireSyncPassphrase: false });
  const testPath = `${store.config.webdavRemotePath.replace(/\/[^/]+$/u, '') || ''}/.shelldesk-webdav-test-${crypto.randomUUID()}.txt`;
  const testContent = `ShellDesk WebDAV test ${new Date().toISOString()}`;

  await ensureRemoteDirectories(store.config, store.secrets);

  const putResponse = await webDavRequest(store.config, store.secrets, 'PUT', testPath, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    body: testContent,
  });

  if (!putResponse.ok && putResponse.status !== 201 && putResponse.status !== 204) {
    await throwWebDavError(putResponse, '写入 WebDAV 测试文件');
  }

  const getResponse = await webDavRequest(store.config, store.secrets, 'GET', testPath);

  if (!getResponse.ok) {
    await throwWebDavError(getResponse, '读取 WebDAV 测试文件');
  }

  const readBack = await getResponse.text();

  if (readBack !== testContent) {
    throw new Error('WebDAV 测试文件读写内容不一致。');
  }

  const deleteResponse = await webDavRequest(store.config, store.secrets, 'DELETE', testPath);
  let cleanupMessage = '';

  if (!deleteResponse.ok && deleteResponse.status !== 404 && deleteResponse.status !== 204) {
    const body = (await readResponseText(deleteResponse)).replace(/\s+/g, ' ').trim().slice(0, 180);
    cleanupMessage = `读写测试通过，但临时测试文件删除失败：${deleteResponse.status} ${deleteResponse.statusText || ''}${body ? `：${body}` : ''}`.trim();
  }

  const message = cleanupMessage || 'WebDAV 连接测试通过，远程目录具备读写权限。';

  updateSyncStatus(cleanupMessage ? 'warning' : 'success', message, { lastConflictCount: 0 });
  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    message,
  };
}

function updateSyncStatus(status, message, extraConfig = {}) {
  const currentStore = readSyncStore();
  const nextStore = writeSyncStore({
    ...currentStore,
    config: {
      ...currentStore.config,
      ...extraConfig,
      lastSyncAt: extraConfig.lastSyncAt ?? currentStore.config.lastSyncAt,
      lastSyncStatus: status,
      lastSyncMessage: message,
    },
  });

  return toPublicSyncConfig(nextStore);
}

async function runWebDavSyncInternal(rawConfig) {
  const store = createOperationalStore(rawConfig, { requireSyncPassphrase: true });
  const conflictResolution = readConflictResolution(rawConfig?.conflictResolution);
  const emptyVaultResolution = readEmptyVaultResolution(rawConfig?.emptyVaultResolution);
  const shrinkResolution = readShrinkResolution(rawConfig?.shrinkResolution);
  const maxPreconditionRetries = 1;
  const maxLocalRefreshes = 2;
  let preconditionRetries = 0;
  let localRefreshes = 0;
  let remoteOverride = null;

  await ensureRemoteDirectories(store.config, store.secrets);

  while (preconditionRetries <= maxPreconditionRetries && localRefreshes <= maxLocalRefreshes) {
    const now = new Date().toISOString();
    const local = createLocalSyncInputs(store.state, now);
    const remote = remoteOverride ?? await readRemoteDocument(store.config, store.secrets);
    remoteOverride = null;
    let effectiveLocalRecords = local.localRecords;
    let effectiveLocalTombstones = local.localTombstones;
    const localContentRecordCount = countContentRecords(local.localRecords);
    const remoteContentRecordCount = countContentRecords(remote.document.records);

    if (shouldRequestEmptyVaultResolution(local.localRecords, remote.document, emptyVaultResolution)) {
      const emptyVaultSummary = createEmptyVaultSummary(local.localRecords, remote.document.records);
      const nextStore = writeSyncStore({
        config: {
          ...store.config,
          lastSyncStatus: 'warning',
          lastSyncMessage: `本机 vault 为空，但云端有 ${emptyVaultSummary.remoteRecords} 项数据。请选择恢复云端数据或保留本机空库。`,
          lastConflictCount: 0,
        },
        secrets: store.secrets,
        state: store.state,
      });

      reloadSyncSchedule();

      const result = {
        ok: false,
        needsResolution: false,
        needsEmptyVaultResolution: true,
        needsShrinkConfirmation: false,
        resolution: '',
        emptyVaultResolution: '',
        shrinkResolution: '',
        syncedAt: '',
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        conflictCount: 0,
        conflicts: [],
        conflictSummary: [],
        summary: createSyncSummary({
          localRecords: local.localRecords,
          localTombstones: local.localTombstones,
          remoteDocument: remote.document,
          mergedDocument: remote.document,
          uploaded: 0,
          downloaded: 0,
          deleted: 0,
          conflicts: [],
        }),
        emptyVaultSummary,
        shrinkSummary: null,
        snapshot: null,
        config: toPublicSyncConfig(nextStore),
      };

      emitSyncChanged(result);
      return result;
    }

    if (emptyVaultResolution === 'restoreRemote' && localContentRecordCount === 0 && remoteContentRecordCount > 0) {
      effectiveLocalRecords = { ...local.localRecords };
      if (remote.document.records['settings:app']) {
        delete effectiveLocalRecords['settings:app'];
      }
      effectiveLocalTombstones = {};
    } else if (emptyVaultResolution === 'keepEmpty' && localContentRecordCount === 0 && remoteContentRecordCount > 0) {
      effectiveLocalTombstones = {
        ...local.localTombstones,
        ...createTombstonesForRecords(remote.document.records, store.state, now),
      };
    }

    const merged = mergeSyncDocuments(
      remote.document,
      effectiveLocalRecords,
      effectiveLocalTombstones,
      store.state,
      now,
      conflictResolution,
    );
    const mergedSummary = createSyncSummary({
      localRecords: effectiveLocalRecords,
      localTombstones: effectiveLocalTombstones,
      remoteDocument: remote.document,
      mergedDocument: merged.document,
      uploaded: merged.uploaded,
      downloaded: merged.downloaded,
      deleted: merged.deleted,
      conflicts: merged.conflicts,
    });

    if (merged.conflicts.length && !conflictResolution) {
      const nextStore = writeSyncStore({
        config: {
          ...store.config,
          lastSyncStatus: 'warning',
          lastSyncMessage: `发现 ${merged.conflicts.length} 个同步冲突，请选择保留本地或保留云端。`,
          lastConflictCount: merged.conflicts.length,
        },
        secrets: store.secrets,
        state: store.state,
      });

      reloadSyncSchedule();

      const result = {
        ok: false,
        needsResolution: true,
        resolution: '',
        syncedAt: '',
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        conflictCount: merged.conflicts.length,
        conflicts: merged.conflicts,
        conflictSummary: createConflictSummary(merged.conflicts),
        summary: mergedSummary,
        needsEmptyVaultResolution: false,
        needsShrinkConfirmation: false,
        emptyVaultResolution: '',
        shrinkResolution: '',
        emptyVaultSummary: null,
        shrinkSummary: null,
        snapshot: null,
        config: toPublicSyncConfig(nextStore),
      };

      emitSyncChanged(result);
      return result;
    }

    const shrinkSummary = detectSuspiciousShrink({
      state: store.state,
      localRecords: effectiveLocalRecords,
      remoteDocument: remote.document,
      mergedDocument: merged.document,
    });

    if (shrinkSummary && shrinkResolution !== 'allow' && emptyVaultResolution !== 'keepEmpty') {
      const nextStore = writeSyncStore({
        config: {
          ...store.config,
          lastSyncStatus: 'warning',
          lastSyncMessage: `同步结果会从 ${shrinkSummary.baselineRecords} 项减少到 ${shrinkSummary.mergedRecords} 项，已暂停以避免误删。`,
          lastConflictCount: 0,
        },
        secrets: store.secrets,
        state: store.state,
      });

      reloadSyncSchedule();

      const result = {
        ok: false,
        needsResolution: false,
        needsEmptyVaultResolution: false,
        needsShrinkConfirmation: true,
        resolution: conflictResolution,
        emptyVaultResolution,
        shrinkResolution: '',
        syncedAt: '',
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        conflictCount: merged.conflicts.length,
        conflicts: merged.conflicts,
        conflictSummary: createConflictSummary(merged.conflicts),
        summary: mergedSummary,
        emptyVaultSummary: null,
        shrinkSummary,
        snapshot: null,
        config: toPublicSyncConfig(nextStore),
      };

      emitSyncChanged(result);
      return result;
    }

    const writeResult = await writeRemoteDocument(
      store.config,
      store.secrets,
      merged.document,
      remote.etag,
      remote.exists,
    );

    if (writeResult.preconditionFailed && preconditionRetries < maxPreconditionRetries) {
      preconditionRetries += 1;
      continue;
    }

    if (writeResult.preconditionFailed) {
      throw new Error('远端同步文件刚刚被其他设备更新，请稍后重试。');
    }

    const latestLocal = createLocalSyncInputs(store.state, now);

    if (latestLocal.footprint !== local.footprint) {
      if (localRefreshes >= maxLocalRefreshes) {
        throw new Error('本机数据在同步期间持续变化，请稍后重试。');
      }

      localRefreshes += 1;
      remoteOverride = {
        document: merged.document,
        etag: writeResult.etag,
        exists: true,
      };
      continue;
    }

    const snapshot = applyMergedDocumentToVault(merged.document);
    const syncMessage = merged.conflicts.length && conflictResolution
      ? `同步完成，已按选择保留${conflictResolution === 'local' ? '本地' : '云端'}处理 ${merged.conflicts.length} 个冲突。`
      : '同步完成。';
    const nextStore = writeSyncStore({
      config: {
        ...store.config,
        lastSyncAt: now,
        lastSyncStatus: 'success',
        lastSyncMessage: syncMessage,
        lastConflictCount: 0,
      },
      secrets: store.secrets,
      state: createStateFromDocument(merged.document, store.state.deviceId, writeResult.etag, now),
    });

    reloadSyncSchedule();

    const result = {
      ok: true,
      needsResolution: false,
      needsEmptyVaultResolution: false,
      needsShrinkConfirmation: false,
      resolution: conflictResolution,
      emptyVaultResolution,
      shrinkResolution,
      syncedAt: now,
      uploaded: merged.uploaded,
      downloaded: merged.downloaded,
      deleted: merged.deleted,
      conflictCount: merged.conflicts.length,
      conflicts: merged.conflicts,
      conflictSummary: createConflictSummary(merged.conflicts),
      summary: mergedSummary,
      emptyVaultSummary: null,
      shrinkSummary: null,
      snapshot,
      config: toPublicSyncConfig(nextStore),
    };

    emitSyncChanged(result);
    return result;
  }

  throw new Error('同步未完成。');
}

async function runWebDavSync(rawConfig) {
  if (activeSyncPromise) {
    return activeSyncPromise;
  }

  activeSyncPromise = runWebDavSyncInternal(rawConfig)
    .catch((error) => {
      updateSyncStatus('error', error instanceof Error ? error.message : '同步失败。');
      throw error;
    })
    .finally(() => {
      activeSyncPromise = null;
    });

  return activeSyncPromise;
}

function clearSyncSchedule() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }

  if (startupSyncTimer) {
    clearTimeout(startupSyncTimer);
    startupSyncTimer = null;
  }
}

function reloadSyncSchedule() {
  clearSyncSchedule();

  let store;

  try {
    store = readSyncStore();
  } catch {
    return;
  }

  if (!store.config.enabled) {
    return;
  }

  const intervalMs = store.config.intervalMinutes * 60 * 1000;
  syncTimer = setInterval(() => {
    void runWebDavSync().catch(() => undefined);
  }, intervalMs);

  if (store.config.syncOnStartup) {
    startupSyncTimer = setTimeout(() => {
      void runWebDavSync().catch(() => undefined);
    }, autoSyncStartupDelayMs);
  }
}

function registerSyncHandlers(registerIpcHandler) {
  registerIpcHandler('sync:get-config', async () => toPublicSyncConfig());
  registerIpcHandler('sync:save-config', async (_event, rawConfig) => saveSyncConfig(rawConfig));
  registerIpcHandler('sync:test-webdav', async (_event, rawConfig) => testWebDav(rawConfig));
  registerIpcHandler('sync:run-now', async (_event, rawConfig) => runWebDavSync(rawConfig));

  app.whenReady().then(() => {
    reloadSyncSchedule();
  });

  app.on('before-quit', () => {
    clearSyncSchedule();
  });
}

module.exports = {
  registerSyncHandlers,
};
