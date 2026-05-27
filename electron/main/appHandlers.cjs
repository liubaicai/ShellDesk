const { app, shell } = require('electron');
const { readBoundedString } = require('./validation.cjs');
const packageMetadata = require('../../package.json');

const repositoryOwner = 'liubaicai';
const repositoryName = 'ShellDesk';
const repositorySlug = `${repositoryOwner}/${repositoryName}`;
const githubLatestReleaseApiUrl = `https://api.github.com/repos/${repositorySlug}/releases/latest`;
const githubReleasesUrl = `https://github.com/${repositorySlug}/releases`;
const latestYmlAssetName = 'latest.yml';
const updateRequestTimeoutMs = 15_000;
const externalUrlProtocols = new Set(['https:', 'http:', 'mailto:']);

function normalizeVersion(value) {
  return String(value ?? '').trim().replace(/^v/i, '').replace(/\+.*/, '');
}

function readVersionParts(value) {
  const cleanValue = normalizeVersion(value);
  const prereleaseStart = cleanValue.indexOf('-');
  const mainVersion = prereleaseStart === -1 ? cleanValue : cleanValue.slice(0, prereleaseStart);
  const prerelease = prereleaseStart === -1 ? '' : cleanValue.slice(prereleaseStart + 1);
  const numbers = mainVersion.split('.').map((part) => {
    const match = /^\d+/.exec(part);
    return match ? Number(match[0]) : 0;
  });

  return { numbers, prerelease };
}

function comparePrereleaseIdentifier(left, right) {
  const leftNumber = /^\d+$/.test(left) ? Number(left) : null;
  const rightNumber = /^\d+$/.test(right) ? Number(right) : null;

  if (leftNumber !== null && rightNumber !== null) {
    return Math.sign(leftNumber - rightNumber);
  }

  if (leftNumber !== null) {
    return -1;
  }

  if (rightNumber !== null) {
    return 1;
  }

  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

function compareVersions(left, right) {
  const leftParts = readVersionParts(left);
  const rightParts = readVersionParts(right);
  const maxLength = Math.max(leftParts.numbers.length, rightParts.numbers.length);

  for (let index = 0; index < maxLength; index += 1) {
    const leftNumber = leftParts.numbers[index] ?? 0;
    const rightNumber = rightParts.numbers[index] ?? 0;

    if (leftNumber !== rightNumber) {
      return Math.sign(leftNumber - rightNumber);
    }
  }

  if (!leftParts.prerelease && !rightParts.prerelease) {
    return 0;
  }

  if (!leftParts.prerelease) {
    return 1;
  }

  if (!rightParts.prerelease) {
    return -1;
  }

  const leftIdentifiers = leftParts.prerelease.split('.');
  const rightIdentifiers = rightParts.prerelease.split('.');
  const prereleaseLength = Math.max(leftIdentifiers.length, rightIdentifiers.length);

  for (let index = 0; index < prereleaseLength; index += 1) {
    const leftIdentifier = leftIdentifiers[index];
    const rightIdentifier = rightIdentifiers[index];

    if (leftIdentifier == null) {
      return -1;
    }

    if (rightIdentifier == null) {
      return 1;
    }

    const comparison = comparePrereleaseIdentifier(leftIdentifier, rightIdentifier);

    if (comparison !== 0) {
      return comparison;
    }
  }

  return 0;
}

function unquoteYamlScalar(value) {
  const trimmedValue = value.trim();

  if (trimmedValue.startsWith("'") && trimmedValue.endsWith("'")) {
    return trimmedValue.slice(1, -1).replace(/''/g, "'");
  }

  if (trimmedValue.startsWith('"') && trimmedValue.endsWith('"')) {
    return trimmedValue.slice(1, -1).replace(/\\"/g, '"');
  }

  return trimmedValue;
}

function readTopLevelYamlScalar(yamlText, key) {
  const pattern = new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm');
  const match = pattern.exec(yamlText);
  return match ? unquoteYamlScalar(match[1]) : '';
}

function parseLatestYml(yamlText) {
  const version = readTopLevelYamlScalar(yamlText, 'version');

  if (!version) {
    throw new Error('latest.yml 中缺少 version 字段。');
  }

  const files = Array.from(yamlText.matchAll(/^\s*-\s+url:\s*(.+?)\s*$/gm), (match) => unquoteYamlScalar(match[1]))
    .filter(Boolean);

  return {
    version: normalizeVersion(version),
    path: readTopLevelYamlScalar(yamlText, 'path'),
    sha512: readTopLevelYamlScalar(yamlText, 'sha512'),
    releaseDate: readTopLevelYamlScalar(yamlText, 'releaseDate'),
    files,
  };
}

function createUpdateHeaders(accept) {
  return {
    Accept: accept,
    'User-Agent': `ShellDesk/${app.getVersion()} (${process.platform}; ${process.arch})`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function fetchWithTimeout(url, options = {}) {
  if (typeof fetch !== 'function') {
    throw new Error('当前运行环境不支持网络更新检查。');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), updateRequestTimeoutMs);

  try {
    const response = await fetch(url, {
      redirect: 'follow',
      ...options,
      signal: controller.signal,
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error('未找到可用的 GitHub 最新 Release。');
      }

      throw new Error(`GitHub 请求失败：${response.status} ${response.statusText || ''}`.trim());
    }

    return response;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('检查更新超时，请稍后重试。');
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeReleaseAsset(asset) {
  if (!asset || typeof asset !== 'object') {
    return null;
  }

  const name = typeof asset.name === 'string' ? asset.name : '';
  const browserDownloadUrl = typeof asset.browser_download_url === 'string' ? asset.browser_download_url : '';
  const size = Number.isFinite(asset.size) ? asset.size : 0;

  if (!name || !browserDownloadUrl) {
    return null;
  }

  return { name, browserDownloadUrl, size };
}

function pickDownloadAsset(assets, feedInfo) {
  const preferredNames = [feedInfo.path, feedInfo.files[0]].filter(Boolean);

  for (const preferredName of preferredNames) {
    const asset = assets.find((candidate) => candidate.name === preferredName);

    if (asset) {
      return asset;
    }
  }

  return assets.find((asset) => {
    const assetName = asset.name.toLowerCase();
    return assetName !== latestYmlAssetName && !assetName.endsWith('.blockmap') && !assetName.endsWith('.yml');
  }) ?? null;
}

function getAppInfo() {
  return {
    name: packageMetadata.name || app.getName(),
    productName: packageMetadata.productName || app.getName(),
    version: app.getVersion(),
    description: packageMetadata.description || '',
    homepage: packageMetadata.homepage || `https://github.com/${repositorySlug}`,
    author: typeof packageMetadata.author === 'string' ? packageMetadata.author : '',
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged,
  };
}

async function checkForUpdates() {
  const currentVersion = app.getVersion();
  const releaseResponse = await fetchWithTimeout(githubLatestReleaseApiUrl, {
    headers: createUpdateHeaders('application/vnd.github+json'),
  });
  const releasePayload = await releaseResponse.json();
  const assets = Array.isArray(releasePayload.assets)
    ? releasePayload.assets.map(normalizeReleaseAsset).filter(Boolean)
    : [];
  const latestYmlAsset = assets.find((asset) => asset.name.toLowerCase() === latestYmlAssetName);

  if (!latestYmlAsset) {
    throw new Error('最新 Release 中未找到 latest.yml。');
  }

  const latestYmlResponse = await fetchWithTimeout(latestYmlAsset.browserDownloadUrl, {
    headers: createUpdateHeaders('text/yaml, text/plain, application/octet-stream'),
  });
  const latestYmlText = await latestYmlResponse.text();
  const feedInfo = parseLatestYml(latestYmlText);
  const latestVersion = feedInfo.version;
  const downloadAsset = pickDownloadAsset(assets, feedInfo);

  return {
    repository: repositorySlug,
    currentVersion,
    latestVersion,
    updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
    releaseName: releasePayload.name || releasePayload.tag_name || `v${latestVersion}`,
    releaseTag: releasePayload.tag_name || `v${latestVersion}`,
    releaseUrl: releasePayload.html_url || `${githubReleasesUrl}/latest`,
    releaseDate: feedInfo.releaseDate || releasePayload.published_at || null,
    latestYmlUrl: latestYmlAsset.browserDownloadUrl,
    downloadName: downloadAsset?.name || feedInfo.path || '',
    downloadUrl: downloadAsset?.browserDownloadUrl || null,
    downloadSize: downloadAsset?.size || 0,
    checkedAt: new Date().toISOString(),
  };
}

function isSafeExternalUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return externalUrlProtocols.has(url.protocol);
  } catch {
    return false;
  }
}

function registerAppHandlers(registerIpcHandler) {
  registerIpcHandler('app:get-info', async () => getAppInfo());

  registerIpcHandler('app:check-for-updates', async () => checkForUpdates());

  registerIpcHandler('app:open-external', async (_event, rawUrl) => {
    const url = readBoundedString(rawUrl, '外部链接', 2048);

    if (!isSafeExternalUrl(url)) {
      throw new Error('外部链接不受支持。');
    }

    await shell.openExternal(url);
    return true;
  });
}

module.exports = {
  registerAppHandlers,
};
