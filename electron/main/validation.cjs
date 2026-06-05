const { maxDesktopWallpaperBytes, maxDesktopWallpaperDataUrlLength } = require('./constants.cjs');

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

  if (/^(跳板机|通过跳板机)/.test(message)) {
    return message;
  }

  if (/All configured authentication methods failed/i.test(message)) {
    return 'SSH 认证失败：请检查用户名、密码、私钥或密钥口令，或确认服务器允许当前认证方式。';
  }

  if (/Cannot parse privateKey|Encrypted private OpenSSH key detected|passphrase/i.test(message)) {
    return 'SSH 私钥读取失败：请确认私钥文件格式正确；如果私钥已加密，请填写密钥口令。';
  }

  if (/ECONNREFUSED|Connection refused/i.test(message)) {
    return 'SSH 连接被拒绝：请检查主机地址、端口和 sshd 服务状态。';
  }

  if (/ECONNRESET|Connection reset|ECONNABORTED|EPIPE/i.test(message)) {
    return 'SSH 连接被远程主机重置：请检查 Windows OpenSSH 服务、防火墙、端口和账号权限。';
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

function readNumberInRange(value, label, minValue, maxValue, fallback) {
  const nextValue = Number(value);

  if (Number.isFinite(nextValue) && nextValue >= minValue && nextValue <= maxValue) {
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

function readDesktopWallpaperDataUrl(value, fallback = '') {
  if (typeof value !== 'string' || !value) {
    return fallback;
  }

  if (
    value.length > maxDesktopWallpaperDataUrlLength ||
    !/^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/i.test(value)
  ) {
    throw new Error('桌面壁纸无效。');
  }

  const base64Payload = value.slice(value.indexOf(',') + 1);
  const imageBytes = Buffer.byteLength(base64Payload, 'base64');

  if (!imageBytes || imageBytes > maxDesktopWallpaperBytes) {
    throw new Error('桌面壁纸为空或超过大小限制。');
  }

  return value;
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


function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeShellSingleQuotedArg(arg) {
  return `'${String(arg).replace(/'/g, "'\\''")}'`;
}

function quotePowerShellString(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

function createPowerShellCommand(script) {
  const utf8Prelude = `
try {
$__shelldeskUtf8 = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $__shelldeskUtf8
[Console]::OutputEncoding = $__shelldeskUtf8
$OutputEncoding = $__shelldeskUtf8
} catch {}
try { chcp.com 65001 > $null } catch {}
`;
  const encodedScript = Buffer.from(`${utf8Prelude}\n${script}`, 'utf16le').toString('base64');
  return `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodedScript}`;
}

module.exports = {
  createPowerShellCommand,
  escapeRegExp,
  escapeShellSingleQuotedArg,
  isPlainObject,
  quotePowerShellString,
  readBoolean,
  readBoundedString,
  readColorHex,
  readDesktopWallpaperDataUrl,
  readIntegerInRange,
  readNumberInRange,
  readStringList,
  readTimestampString,
  toConnectionErrorMessage,
  toErrorMessage,
};
