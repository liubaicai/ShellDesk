const { BrowserWindow, dialog } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const {
  maxRemoteCommandInputLength,
  maxRemoteCommandLength,
  maxRemoteTextFileBytes,
  maxRemoteTextWriteBytes,
} = require('./constants.cjs');
const {
  getActiveConnection,
  registerConnectionCleanup,
  withActiveConnectionClientRetry,
} = require('./connectionManager.cjs');
const {
  cancelLocalTransfer,
  copyLocalDownload,
  copyLocalUpload,
  createLocalDirectory,
  createLocalFile,
  deleteLocalPath,
  getLocalMetrics,
  getLocalStatus,
  getLocalSystemInfo,
  isLocalConnection,
  listLocalDirectory,
  readLocalTextFile,
  renameLocalPath,
  runLocalCommand,
  setLocalPathPermissions,
  startLocalTerminal,
  statLocalPath,
  writeLocalTextFile,
} = require('./localConnection.cjs');
const {
  cleanPowerShellCliXmlOutput,
  createPowerShellCliXmlStreamCleaner,
} = require('./powershellCliXml.cjs');
const {
  createPowerShellCommand,
  escapeShellSingleQuotedArg,
  quotePowerShellString,
  readBoolean,
  readBoundedString,
  readIntegerInRange,
} = require('./validation.cjs');

const maxRemotePermissionTargets = 5000;
const maxRemoteDeleteTargets = 5000;
const maxTransferQueueItems = 20000;
const maxTransferQueueIdLength = 120;
const maxTerminalBinaryInputBytes = 256 * 1024;
const maxZmodemReadChunkBytes = 256 * 1024;
const maxZmodemUploadSelectionAgeMs = 30 * 60 * 1000;
const maxDirectorySymlinkTargetStats = 80;
const remoteEntryCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
const zmodemUploadSelections = new Map();
const elevatedSftpSessions = new Map();

let SFTPWrapper = null;
try {
  const sftpModule = require('ssh2/lib/protocol/SFTP');
  SFTPWrapper = sftpModule.SFTP || sftpModule;
} catch (error) {
  console.info(`[shelldesk] sudo SFTP wrapper unavailable: ${error?.message ?? error}`);
}

function validateRemotePath(rawPath) {
  const remotePath = typeof rawPath === 'string' && rawPath.trim() ? rawPath.trim() : '.';

  if (remotePath.length > 4096 || remotePath.includes('\0')) {
    throw new Error('远程路径无效。');
  }

  return remotePath;
}

function isWindowsDriveRootPath(remotePath) {
  return /^[/\\]?[a-z]:[/\\]*$/i.test(remotePath.trim());
}

function validateMutableRemotePath(rawPath) {
  const remotePath = validateRemotePath(rawPath);

  if (remotePath === '.' || remotePath === '/' || remotePath === '~' || isWindowsDriveRootPath(remotePath)) {
    throw new Error('不允许对该远程路径执行管理操作。');
  }

  return remotePath;
}

function getRemoteFileName(remotePath, fallback = 'download') {
  return remotePath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || fallback;
}

function sanitizeLocalFileName(fileName, fallback = 'download') {
  const safeName = `${fileName || ''}`
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();

  if (!safeName || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(safeName)) {
    return fallback;
  }

  return safeName;
}

function sanitizeRelativeLocalPath(relativePath, fallback = 'download') {
  const parts = String(relativePath || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .map((part, index) => sanitizeLocalFileName(part, index === 0 ? fallback : 'item'));

  return parts.length ? path.join(...parts) : fallback;
}

function toIpcArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function sendTerminalData(sender, connectionId, terminalId, chunk) {
  if (sender.isDestroyed()) {
    return;
  }

  sender.send('terminal:data', {
    connectionId,
    terminalId,
    data: chunk.toString('utf8'),
    bytes: toIpcArrayBuffer(chunk),
  });
}

function readBinaryInput(rawData, label = '二进制输入', maxBytes = 0) {
  let buffer;

  if (Buffer.isBuffer(rawData)) {
    buffer = rawData;
  } else if (rawData instanceof ArrayBuffer) {
    buffer = Buffer.from(rawData);
  } else if (ArrayBuffer.isView(rawData)) {
    buffer = Buffer.from(rawData.buffer, rawData.byteOffset, rawData.byteLength);
  } else if (Array.isArray(rawData)) {
    buffer = Buffer.from(rawData);
  } else {
    throw new Error(`${label}无效。`);
  }

  if (maxBytes > 0 && buffer.length > maxBytes) {
    throw new Error(`${label}超过长度限制。`);
  }

  return buffer;
}

function readTerminalBinaryInput(rawData) {
  return readBinaryInput(rawData, '终端二进制输入', maxTerminalBinaryInputBytes);
}

function createZmodemUploadSelection(localPath) {
  const stats = fs.statSync(localPath);

  if (!stats.isFile()) {
    return null;
  }

  const id = `zmodem-${Date.now()}-${crypto.randomUUID()}`;
  const selection = {
    id,
    path: localPath,
    name: path.basename(localPath) || 'upload',
    size: stats.size,
    lastModified: Math.floor(stats.mtimeMs),
    expiresAt: Date.now() + maxZmodemUploadSelectionAgeMs,
  };

  zmodemUploadSelections.set(id, selection);
  return selection;
}

function cleanupExpiredZmodemUploadSelections() {
  const now = Date.now();

  for (const [id, selection] of zmodemUploadSelections) {
    if (selection.expiresAt <= now) {
      zmodemUploadSelections.delete(id);
    }
  }
}

function getZmodemUploadSelection(rawId) {
  cleanupExpiredZmodemUploadSelections();
  const id = typeof rawId === 'string' ? rawId : '';
  const selection = zmodemUploadSelections.get(id);

  if (!selection) {
    throw new Error('上传文件选择已过期，请重新选择文件。');
  }

  selection.expiresAt = Date.now() + maxZmodemUploadSelectionAgeMs;
  return selection;
}

function toErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return String(error || '未知错误');
}

function joinRemoteChildPath(parentPath, childName) {
  const normalizedParent = parentPath.replace(/\\/g, '/');

  if (normalizedParent === '.') {
    return childName;
  }

  if (normalizedParent === '/') {
    return `/${childName}`;
  }

  if (isWindowsDriveRootPath(normalizedParent)) {
    return `${normalizedParent.replace(/\/?$/, '/')}${childName}`;
  }

  return `${normalizedParent.replace(/\/+$/, '')}/${childName}`;
}

function shouldResolveDirectoryDisplayPath(remotePath) {
  const normalizedPath = remotePath.trim();
  return normalizedPath === '.' || normalizedPath === '~';
}

function resolveSftpDisplayPath(sftp, remotePath) {
  if (!shouldResolveDirectoryDisplayPath(remotePath) || typeof sftp.realpath !== 'function') {
    return Promise.resolve(remotePath);
  }

  return new Promise((resolve) => {
    try {
      sftp.realpath(remotePath, (realpathError, resolvedPath) => {
        if (realpathError || typeof resolvedPath !== 'string' || !resolvedPath.trim()) {
          resolve(remotePath);
          return;
        }

        resolve(resolvedPath.trim());
      });
    } catch {
      resolve(remotePath);
    }
  });
}

function getRemoteParentPath(remotePath) {
  const normalizedPath = remotePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const driveChildMatch = normalizedPath.match(/^(\/?[a-z]:)\/[^/]+$/i);

  if (driveChildMatch) {
    return `${driveChildMatch[1]}/`;
  }

  return normalizedPath.replace(/\/[^/]*$/, '') || '.';
}


function validateTerminalId(rawTerminalId) {
  const terminalId = readBoundedString(rawTerminalId, '终端标识', 120);

  if (!/^[a-zA-Z0-9:_-]+$/.test(terminalId)) {
    throw new Error('终端标识无效。');
  }

  return terminalId;
}

function readOptionalTerminalLaunchText(rawValue, label, maxLength, allowNewlines = false) {
  if (typeof rawValue !== 'string') {
    return '';
  }

  const value = rawValue.trim();

  if (!value) {
    return '';
  }

  if (value.length > maxLength || value.includes('\0') || (!allowNewlines && /[\r\n]/.test(value))) {
    throw new Error(`${label}无效。`);
  }

  return value;
}

function readTerminalLaunchOptions(rawOptions) {
  if (!rawOptions || typeof rawOptions !== 'object') {
    return {
      title: '',
      shell: '',
      initialCommand: '',
      workingDirectory: '',
    };
  }

  return {
    title: readOptionalTerminalLaunchText(rawOptions.title, '终端标题', 120),
    shell: readOptionalTerminalLaunchText(rawOptions.shell, '终端 Shell', 160),
    initialCommand: readOptionalTerminalLaunchText(rawOptions.initialCommand, '终端初始命令', 8192, true),
    workingDirectory: readOptionalTerminalLaunchText(rawOptions.workingDirectory, '终端工作目录', 1024),
  };
}

function quoteTerminalStartupDirectory(directory, systemType) {
  if (systemType === 'windows') {
    return `"${directory.replace(/"/g, '""')}"`;
  }

  return `'${directory.replace(/'/g, `'\\''`)}'`;
}

function createTerminalStartupInput(launchOptions, systemType) {
  const startupLines = [];

  if (launchOptions.workingDirectory) {
    startupLines.push(`cd ${quoteTerminalStartupDirectory(launchOptions.workingDirectory, systemType)}`);
  }

  if (launchOptions.shell) {
    startupLines.push(launchOptions.shell);
  }

  if (launchOptions.initialCommand) {
    startupLines.push(launchOptions.initialCommand.replace(/\r?\n/g, '\r'));
  }

  return startupLines.length ? `${startupLines.join('\r')}\r` : '';
}

function createTerminalStartupPlan(activeConnection, launchOptions) {
  const startupInput = createTerminalStartupInput(launchOptions, activeConnection.displayHost.systemType);
  const privilegeConfig = activeConnection.privilegeConfig;

  if (
    activeConnection.displayHost.systemType === 'windows' ||
    privilegeConfig?.mode !== 'su-root' ||
    !privilegeConfig.rootPassword
  ) {
    return {
      initialInput: startupInput,
      rootPassword: '',
      afterAuthInput: '',
    };
  }

  return {
    initialInput: 'su - root\r',
    rootPassword: privilegeConfig.rootPassword,
    afterAuthInput: startupInput,
  };
}

function stripTerminalControlSequences(value) {
  return String(value || '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\r/g, '\n');
}

function isTerminalPasswordPrompt(value) {
  return /(?:^|\n)\s*(?:password|密码|口令)[:：]\s*$/i.test(stripTerminalControlSequences(value));
}

function isTerminalSuAuthenticationFailure(value) {
  return /su:.*authentication failure|authentication failure|authentication failed|incorrect password|su:.*permission denied|su:.*denied|密码.*错误|认证失败|鉴定故障/i.test(stripTerminalControlSequences(value));
}

function isTerminalLikelyRootPrompt(value) {
  return /(?:^|\n)[^\n]*#\s*$/.test(stripTerminalControlSequences(value));
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

function sortRemoteFileEntries(entries) {
  return entries.sort((left, right) => {
    const leftSortType = left.type === 'symlink' && left.targetType === 'directory' ? 'directory' : left.type;
    const rightSortType = right.type === 'symlink' && right.targetType === 'directory' ? 'directory' : right.type;

    if (leftSortType === rightSortType) {
      return remoteEntryCollator.compare(left.name, right.name);
    }

    return leftSortType === 'directory' ? -1 : 1;
  });
}

function decodeBase64DirectoryField(value) {
  try {
    return Buffer.from(value || '', 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function parsePrivilegedDirectoryListing(output, fallbackPath) {
  let displayPath = fallbackPath;
  const entries = [];

  for (const line of output.split(/\r?\n/)) {
    if (!line) {
      continue;
    }

    const parts = line.split('\t');

    if (parts[0] === 'PATH') {
      displayPath = decodeBase64DirectoryField(parts[1]) || fallbackPath;
      continue;
    }

    if (parts[0] !== 'ENTRY' || parts.length < 6) {
      continue;
    }

    const name = decodeBase64DirectoryField(parts[1]);
    const type = parts[2] === 'directory' || parts[2] === 'symlink' ? parts[2] : 'file';
    const targetType = parts[3] === 'directory' || parts[3] === 'file' || parts[3] === 'symlink' || parts[3] === 'unknown'
      ? parts[3]
      : undefined;
    const size = Number(parts[4]);
    const mtime = Number(parts[5]);

    if (!name || name === '.' || name === '..') {
      continue;
    }

    entries.push({
      name,
      longname: '',
      type,
      targetType: type === 'symlink' ? targetType ?? 'unknown' : undefined,
      size: Number.isFinite(size) && size >= 0 ? size : 0,
      modifiedAt: Number.isFinite(mtime) && mtime > 0 ? new Date(mtime * 1000).toISOString() : '',
    });
  }

  return {
    path: displayPath,
    entries: sortRemoteFileEntries(entries),
  };
}

function listRemoteDirectory(client, remotePath) {
  return new Promise((resolve, reject) => {
    client.sftp((sftpError, sftp) => {
      if (sftpError) {
        reject(sftpError);
        return;
      }

      sftp.readdir(remotePath, (readError, entries) => {
        if (readError) {
          sftp.end();
          reject(readError);
          return;
        }

        const visibleEntries = entries.filter((entry) => entry.filename !== '.' && entry.filename !== '..');
        const shouldResolveSymlinkTargets = visibleEntries
          .filter((entry) => getSftpEntryType(entry.attrs) === 'symlink')
          .length <= maxDirectorySymlinkTargetStats;

        const statSymlinkTarget = (targetPath) => new Promise((resolveStat) => {
          sftp.stat(targetPath, (statError, attrs) => {
            resolveStat(statError || !attrs ? 'unknown' : getSftpEntryType(attrs));
          });
        });

        (async () => {
          try {
            const listedEntries = await Promise.all(visibleEntries
              .map(async (entry) => {
                const type = getSftpEntryType(entry.attrs);
                const targetType = type === 'symlink'
                  ? shouldResolveSymlinkTargets
                    ? await statSymlinkTarget(joinRemoteChildPath(remotePath, entry.filename))
                    : 'unknown'
                  : undefined;

                return {
                  name: entry.filename,
                  longname: entry.longname,
                  type,
                  targetType,
                  size: entry.attrs.size ?? 0,
                  modifiedAt: entry.attrs.mtime ? new Date(entry.attrs.mtime * 1000).toISOString() : '',
                };
              }));

            const sortedEntries = sortRemoteFileEntries(listedEntries);
            const displayPath = await resolveSftpDisplayPath(sftp, remotePath);

            resolve({ path: displayPath, entries: sortedEntries });
          } catch (error) {
            reject(error);
          } finally {
            sftp.end();
          }
        })();
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

      let deleteTargetCount = 0;

      const countTarget = () => {
        deleteTargetCount += 1;
        if (deleteTargetCount > maxRemoteDeleteTargets) {
          throw new Error(`删除目标超过 ${maxRemoteDeleteTargets} 项，请在终端中分批删除。`);
        }
      };

      const readDirectory = (targetPath) => new Promise((resolveEntries, rejectEntries) => {
        sftp.readdir(targetPath, (readError, entries) => {
          if (readError) {
            rejectEntries(readError);
            return;
          }

          resolveEntries(entries);
        });
      });

      const unlinkPath = (targetPath) => new Promise((resolveUnlink, rejectUnlink) => {
        sftp.unlink(targetPath, (unlinkError) => {
          if (unlinkError) {
            rejectUnlink(unlinkError);
            return;
          }

          resolveUnlink(true);
        });
      });

      const rmdirPath = (targetPath) => new Promise((resolveRmdir, rejectRmdir) => {
        sftp.rmdir(targetPath, (rmdirError) => {
          if (rmdirError) {
            rejectRmdir(rmdirError);
            return;
          }

          resolveRmdir(true);
        });
      });

      const removeDirectory = async (targetPath) => {
        countTarget();
        const entries = await readDirectory(targetPath);

        for (const entry of entries) {
          if (entry.filename === '.' || entry.filename === '..') {
            continue;
          }

          const childPath = joinRemoteChildPath(targetPath, entry.filename);
          const childType = getSftpEntryType(entry.attrs);

          if (childType === 'directory') {
            await removeDirectory(childPath);
          } else {
            countTarget();
            await unlinkPath(childPath);
          }
        }

        await rmdirPath(targetPath);
      };

      (async () => {
        try {
          if (entryType === 'directory') {
            await removeDirectory(remotePath);
          } else {
            countTarget();
            await unlinkPath(remotePath);
          }

          resolve(true);
        } catch (deleteError) {
          reject(deleteError);
        } finally {
          sftp.end();
        }
      })();
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


function parseOsReleaseText(output) {
  const values = {};

  for (const line of output.split(/\r?\n/)) {
    const separatorIndex = line.indexOf('=');

    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    values[key] = value.replace(/\\"/g, '"').replace(/\\'/g, "'");
  }

  return values;
}

function detectRemoteSystemType(osRelease, unameOutput) {
  const id = `${osRelease.ID ?? ''}`.toLowerCase();
  const idLike = `${osRelease.ID_LIKE ?? ''}`.toLowerCase();
  const name = `${osRelease.PRETTY_NAME ?? osRelease.NAME ?? ''}`.toLowerCase();
  const marker = `${id} ${idLike} ${name}`;
  const exactMarker = `${id} ${name}`;

  if (/ubuntu/.test(exactMarker)) {
    return 'ubuntu';
  }

  if (/linuxmint|mint/.test(exactMarker)) {
    return 'linuxmint';
  }

  if (/kali/.test(exactMarker)) {
    return 'kali';
  }

  if (/raspbian|raspberry|raspios/.test(exactMarker)) {
    return 'raspbian';
  }

  if (/\bpop\b|pop!_os|pop-os|pop_os/.test(exactMarker)) {
    return 'popos';
  }

  if (/elementary/.test(exactMarker)) {
    return 'elementary';
  }

  if (/debian/.test(exactMarker)) {
    return 'debian';
  }

  if (/rocky/.test(exactMarker)) {
    return 'rocky';
  }

  if (/almalinux|alma/.test(exactMarker)) {
    return 'almalinux';
  }

  if (/centos/.test(exactMarker)) {
    return 'centos';
  }

  if (/fedora/.test(exactMarker)) {
    return 'fedora';
  }

  if (/\bol\b|oracle/.test(exactMarker)) {
    return 'oracle';
  }

  if (/\bamzn\b|amazon/.test(exactMarker)) {
    return 'amazon';
  }

  if (
    /\brhel\b/.test(exactMarker) ||
    /redhat|red hat/.test(exactMarker)
  ) {
    return 'redhat';
  }

  if (/manjaro/.test(exactMarker)) {
    return 'manjaro';
  }

  if (/arch/.test(exactMarker)) {
    return 'arch';
  }

  if (/alpine/.test(exactMarker)) {
    return 'alpine';
  }

  if (/opensuse|sles|sled|\bsuse\b/.test(exactMarker)) {
    return 'opensuse';
  }

  if (/gentoo/.test(exactMarker)) {
    return 'gentoo';
  }

  if (/nixos/.test(exactMarker)) {
    return 'nixos';
  }

  if (/ubuntu/.test(idLike)) {
    return 'ubuntu';
  }

  if (/debian/.test(idLike)) {
    return 'debian';
  }

  if (/fedora/.test(idLike)) {
    return 'fedora';
  }

  if (/centos/.test(idLike)) {
    return 'centos';
  }

  if (/\brhel\b|redhat|red hat/.test(idLike)) {
    return 'redhat';
  }

  if (/arch/.test(idLike)) {
    return 'arch';
  }

  if (/alpine/.test(idLike)) {
    return 'alpine';
  }

  if (/suse/.test(idLike)) {
    return 'opensuse';
  }

  if (/gentoo/.test(idLike)) {
    return 'gentoo';
  }

  if (/linux/i.test(unameOutput) || marker.trim()) {
    return 'linux';
  }

  if (/darwin/i.test(unameOutput)) {
    return 'macos';
  }

  if (/bsd|sunos|aix/i.test(unameOutput)) {
    return 'unix';
  }

  return 'unknown';
}

async function detectRemoteWindowsSystem(client) {
  try {
    const probeOutput = await execRemoteCommand(client, createPowerShellCommand(`
$platform = [Environment]::OSVersion.Platform.ToString()
$versionString = [Environment]::OSVersion.VersionString
$caption = ''
$version = ''
try {
  $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
  $caption = [string]$os.Caption
  $version = [string]$os.Version
} catch {}
if ($platform -eq 'Win32NT' -or $caption -match 'Windows' -or $versionString -match 'Windows') {
  'SHELLDESK_WINDOWS=1'
  if ($caption) {
    "SHELLDESK_WINDOWS_NAME=$caption $version"
  } else {
    "SHELLDESK_WINDOWS_NAME=$versionString"
  }
}
`));

    if (/SHELLDESK_WINDOWS=1/.test(probeOutput)) {
      const nameMatch = probeOutput.match(/^SHELLDESK_WINDOWS_NAME=(.+)$/m);
      const systemName = nameMatch?.[1]?.trim() || 'Windows';

      return {
        systemType: 'windows',
        systemName: readBoundedString(systemName.replace(/\s+/g, ' ').trim(), '系统名称', 160, { required: false }),
      };
    }
  } catch {
    // Fall back to cmd.exe below.
  }

  try {
    const versionOutput = await execRemoteCommand(client, 'cmd /c ver');

    if (!/Microsoft Windows/i.test(versionOutput)) {
      return null;
    }

    let systemName = versionOutput;

    try {
      const details = await execRemoteCommand(client, createPowerShellCommand(`
$os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
if ($os -and $os.Caption) {
  $version = if ($os.Version) { $os.Version } else { [Environment]::OSVersion.Version.ToString() }
  "$($os.Caption) $version"
} else {
  [Environment]::OSVersion.VersionString
}
`));

      if (details) {
        systemName = details;
      }
    } catch {
      // The cmd.exe probe is enough to classify the host as Windows.
    }

    return {
      systemType: 'windows',
      systemName: readBoundedString(systemName.replace(/\s+/g, ' ').trim(), '系统名称', 160, { required: false }),
    };
  } catch {
    return null;
  }
}

async function detectRemoteSystem(client) {
  const windowsSystem = await detectRemoteWindowsSystem(client);

  if (windowsSystem) {
    return windowsSystem;
  }

  const output = await execRemoteCommand(
    client,
    "cat /etc/os-release 2>/dev/null; printf '\\nSHELLDESK_UNAME=%s\\n' \"$(uname -s 2>/dev/null || true)\"; if command -v sw_vers >/dev/null 2>&1; then printf 'SHELLDESK_MACOS_NAME=%s %s\\n' \"$(sw_vers -productName 2>/dev/null || true)\" \"$(sw_vers -productVersion 2>/dev/null || true)\"; fi",
  );
  const osRelease = parseOsReleaseText(output);
  const unameOutput = osRelease.SHELLDESK_UNAME ?? '';
  const systemType = detectRemoteSystemType(osRelease, unameOutput);
  const macosSystemName = systemType === 'macos' ? `${osRelease.SHELLDESK_MACOS_NAME ?? ''}`.trim() : '';
  const systemName = readBoundedString(
    macosSystemName || osRelease.PRETTY_NAME || osRelease.NAME || unameOutput || '',
    '系统名称',
    160,
    { required: false },
  );

  return {
    systemType,
    systemName,
  };
}

const remoteBatchBeginPrefix = '__SHELLDESK_BATCH_BEGIN__';
const remoteBatchEndPrefix = '__SHELLDESK_BATCH_END__';

const unixStatusItems = [
  { key: 'hostname', label: '主机名', command: 'hostname 2>/dev/null || uname -n' },
  { key: 'user', label: '当前用户', command: 'whoami 2>/dev/null || id -un' },
  { key: 'kernel', label: '系统内核', command: 'uname -a' },
  { key: 'uptime', label: '运行时间', command: 'uptime' },
  { key: 'disk', label: '根分区', command: 'df -h / 2>/dev/null || df -h' },
  { key: 'memory', label: '内存', command: 'free -m 2>/dev/null || vm_stat 2>/dev/null || echo unavailable' },
  { key: 'network', label: '网络接口', command: 'ip -brief address 2>/dev/null || ifconfig 2>/dev/null || echo unavailable' },
];

const windowsStatusItems = [
  { key: 'hostname', label: '主机名', command: '[System.Net.Dns]::GetHostName()' },
  { key: 'user', label: '当前用户', command: '[System.Security.Principal.WindowsIdentity]::GetCurrent().Name' },
  { key: 'kernel', label: '系统版本', command: '[Environment]::OSVersion.VersionString' },
  { key: 'uptime', label: '运行时间', command: '$os = Get-CimInstance Win32_OperatingSystem; ((Get-Date) - $os.LastBootUpTime).ToString()' },
  { key: 'disk', label: '本地磁盘', command: "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID, VolumeName, FileSystem, @{Name='SizeGB'; Expression={[math]::Round($_.Size / 1GB, 2)}}, @{Name='FreeGB'; Expression={[math]::Round($_.FreeSpace / 1GB, 2)}} | Format-Table -AutoSize | Out-String -Width 200" },
  { key: 'memory', label: '内存', command: "$os = Get-CimInstance Win32_OperatingSystem; $total = [math]::Round($os.TotalVisibleMemorySize / 1MB, 2); $free = [math]::Round($os.FreePhysicalMemory / 1MB, 2); $used = [math]::Round($total - $free, 2); 'Total: {0} GB, Used: {1} GB, Free: {2} GB' -f $total, $used, $free" },
  { key: 'network', label: '网络接口', command: 'Get-NetIPConfiguration | Format-List | Out-String -Width 220' },
];

const unixCpuInfoCommand = `
cpu_info="$(
  LC_ALL=C lscpu 2>/dev/null | grep -E '^(Model name|Socket\\(s\\)|Core\\(s\\) per socket|Thread\\(s\\) per core|CPU\\(s\\)):' | head -6
)"
if [ -n "$cpu_info" ]; then
  printf '%s\\n' "$cpu_info"
else
  awk -F: '
    function trim(value) { sub(/^[[:space:]]+/, "", value); sub(/[[:space:]]+$/, "", value); return value }
    /^(model name|Hardware|Processor)[[:space:]]*:/ && model == "" { model = trim($2) }
    /^processor[[:space:]]*:/ { logical += 1 }
    /^cpu cores[[:space:]]*:/ && cores == "" { cores = trim($2) }
    /^siblings[[:space:]]*:/ && siblings == "" { siblings = trim($2) }
    /^physical id[[:space:]]*:/ { socket_id = trim($2); sockets[socket_id] = 1 }
    END {
      if (model != "") print "Model name: " model
      if (logical > 0) print "CPU(s): " logical
      if (siblings != "" && cores != "" && cores > 0) print "Thread(s) per core: " int(siblings / cores)
      socket_count = 0
      for (socket_id in sockets) socket_count += 1
      if (socket_count > 0) print "Socket(s): " socket_count
      if (cores != "") print "Core(s) per socket: " cores
    }
  ' /proc/cpuinfo 2>/dev/null
fi
`.trim();

const unixSystemInfoItems = [
  { key: 'os', label: '操作系统', icon: '\u{1F5A5}\uFE0F', command: 'cat /etc/os-release 2>/dev/null | grep -E "^PRETTY_NAME|^NAME|^VERSION" | head -5 || uname -s' },
  { key: 'kernel', label: '内核版本', icon: '\u2699\uFE0F', command: 'uname -r' },
  { key: 'hostname', label: '主机名', icon: '\u{1F3E0}', command: 'hostname -f 2>/dev/null || hostname' },
  { key: 'arch', label: '系统架构', icon: '\u{1F9E9}', command: 'uname -m' },
  { key: 'cpu', label: 'CPU', icon: '\u{1F4BB}', command: unixCpuInfoCommand },
  { key: 'memory', label: '内存', icon: '\u{1F9E0}', command: 'free -h 2>/dev/null | grep "^Mem:" || vm_stat 2>/dev/null | head -5' },
  { key: 'uptime', label: '运行时间', icon: '\u23F1\uFE0F', command: 'uptime -p 2>/dev/null || uptime' },
  { key: 'load', label: '系统负载', icon: '\u26A1', command: 'cat /proc/loadavg 2>/dev/null || uptime | sed "s/.*load average: //"' },
  { key: 'shell', label: '默认 Shell', icon: '\u{1F41A}', command: 'echo $SHELL' },
  { key: 'user', label: '当前用户', icon: '\u{1F464}', command: 'whoami 2>/dev/null || id -un' },
  { key: 'locale', label: '系统语言', icon: '\u{1F30D}', command: 'locale 2>/dev/null | grep LANG= | head -1 || echo $LANG' },
  { key: 'timezone', label: '时区', icon: '\u{1F30D}', command: 'timedatectl 2>/dev/null | grep "Time zone" || cat /etc/timezone 2>/dev/null || date +"%Z"' },
  { key: 'gpu', label: 'GPU', icon: '\u{1F3AE}', command: 'lspci 2>/dev/null | grep -i "vga\\|3d\\|display" | head -3 || echo "未检测到"' },
  { key: 'virt', label: '虚拟化', icon: '\u{1F4EB}', command: 'systemd-detect-virt 2>/dev/null || cat /proc/cpuinfo 2>/dev/null | grep -c "hypervisor" | awk \'{if($1>0) print "虚拟化环境"; else print "物理机或未识别"}\' || echo "未识别"' },
  { key: 'boot', label: '启动模式', icon: '\u{1F504}', command: '[ -d /sys/firmware/efi ] && echo "UEFI" || echo "BIOS (Legacy)"' },
];

const windowsSystemInfoItems = [
  { key: 'os', label: '操作系统', icon: '\u{1F5A5}\uFE0F', command: "$os = Get-CimInstance Win32_OperatingSystem; '{0} {1}' -f $os.Caption, $os.Version" },
  { key: 'kernel', label: '系统版本', icon: '\u2699\uFE0F', command: '[Environment]::OSVersion.VersionString' },
  { key: 'hostname', label: '主机名', icon: '\u{1F3E0}', command: '[System.Net.Dns]::GetHostName()' },
  { key: 'arch', label: '系统架构', icon: '\u{1F9E9}', command: '(Get-CimInstance Win32_OperatingSystem).OSArchitecture' },
  { key: 'cpu', label: 'CPU', icon: '\u{1F4BB}', command: '(Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty Name)' },
  { key: 'memory', label: '内存', icon: '\u{1F9E0}', command: "$os = Get-CimInstance Win32_OperatingSystem; $total = [math]::Round($os.TotalVisibleMemorySize / 1MB, 2); $free = [math]::Round($os.FreePhysicalMemory / 1MB, 2); $used = [math]::Round($total - $free, 2); '已用 {0} GB / 总计 {1} GB，空闲 {2} GB' -f $used, $total, $free" },
  { key: 'uptime', label: '运行时间', icon: '\u23F1\uFE0F', command: '$os = Get-CimInstance Win32_OperatingSystem; ((Get-Date) - $os.LastBootUpTime).ToString()' },
  { key: 'load', label: 'CPU 负载', icon: '\u26A1', command: "$value = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average; if ($null -eq $value) { '0%' } else { '{0}%' -f [math]::Round($value, 1) }" },
  { key: 'shell', label: 'PowerShell', icon: '\u{1F4BB}', command: "'PowerShell ' + $PSVersionTable.PSVersion.ToString()" },
  { key: 'user', label: '当前用户', icon: '\u{1F464}', command: '[System.Security.Principal.WindowsIdentity]::GetCurrent().Name' },
  { key: 'locale', label: '系统语言', icon: '\u{1F30D}', command: '(Get-Culture).Name' },
  { key: 'timezone', label: '时区', icon: '\u{1F30D}', command: '(Get-TimeZone).DisplayName' },
  { key: 'gpu', label: 'GPU', icon: '\u{1F3AE}', command: 'Get-CimInstance Win32_VideoController | Select-Object -First 3 -ExpandProperty Name | Out-String -Width 200' },
  { key: 'virt', label: '硬件型号', icon: '\u{1F4EB}', command: "$cs = Get-CimInstance Win32_ComputerSystem; '{0} {1}' -f $cs.Manufacturer, $cs.Model" },
  { key: 'boot', label: '启动模式', icon: '\u{1F504}', command: "try { if (Confirm-SecureBootUEFI) { 'UEFI / Secure Boot' } else { 'UEFI' } } catch { 'Legacy BIOS 或未识别' }" },
];

function createUnixBatchCommand(items) {
  const lines = [
    'run_item() {',
    '  key="$1"',
    '  command="$2"',
    `  printf '%s%s\\n' ${escapeShellSingleQuotedArg(remoteBatchBeginPrefix)} "$key"`,
    '  output="$(sh -c "$command" 2>&1)"',
    '  status=$?',
    '  if [ "$status" -ne 0 ] && [ -z "$output" ]; then output="获取失败"; fi',
    '  if [ -z "$output" ]; then output="无输出"; fi',
    '  printf \'%s\\n\' "$output"',
    `  printf '%s%s\\n' ${escapeShellSingleQuotedArg(remoteBatchEndPrefix)} "$key"`,
    '}',
    '',
    ...items.map((item) => `run_item ${escapeShellSingleQuotedArg(item.key)} ${escapeShellSingleQuotedArg(item.command)}`),
  ];

  return `sh <<'SHELLDESK_BATCH'\n${lines.join('\n')}\nSHELLDESK_BATCH`;
}

function createWindowsBatchCommand(items) {
  const invocations = items
    .map((item) => `Invoke-ShellDeskItem ${quotePowerShellString(item.key)} { ${item.command} }`)
    .join('\n');

  return createPowerShellCommand(`
function Invoke-ShellDeskItem([string]$Key, [scriptblock]$Script) {
  [Console]::Out.WriteLine('${remoteBatchBeginPrefix}' + $Key)
  try {
    $result = & $Script 2>&1 | Out-String -Width 260
    if ([string]::IsNullOrWhiteSpace($result)) {
      [Console]::Out.WriteLine('无输出')
    } else {
      [Console]::Out.WriteLine($result.TrimEnd())
    }
  } catch {
    [Console]::Out.WriteLine('获取失败：' + $_.Exception.Message)
  }
  [Console]::Out.WriteLine('${remoteBatchEndPrefix}' + $Key)
}
${invocations}
`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseRemoteBatchOutput(output) {
  const values = new Map();
  const pattern = new RegExp(
    `${escapeRegExp(remoteBatchBeginPrefix)}([A-Za-z0-9_-]+)\\r?\\n([\\s\\S]*?)\\r?\\n${escapeRegExp(remoteBatchEndPrefix)}\\1`,
    'g',
  );

  let match;
  while ((match = pattern.exec(output)) !== null) {
    values.set(match[1], match[2].trim() || '无输出');
  }

  return values;
}

async function getRemoteCommandReport(client, systemType, items) {
  const command = systemType === 'windows'
    ? createWindowsBatchCommand(items)
    : createUnixBatchCommand(items);
  const output = await execRemoteCommand(client, command);
  const values = parseRemoteBatchOutput(output);

  return {
    refreshedAt: new Date().toISOString(),
    items: items.map((item) => ({
      key: item.key,
      label: item.label,
      ...(item.icon ? { icon: item.icon } : {}),
      value: values.get(item.key) || '获取失败',
    })),
  };
}

async function getRemoteStatus(client, systemType = 'unknown') {
  const items = systemType === 'windows' ? windowsStatusItems : unixStatusItems;
  return getRemoteCommandReport(client, systemType, items);
}

async function getRemoteSystemInfo(client, systemType = 'unknown') {
  const items = systemType === 'windows' ? windowsSystemInfoItems : unixSystemInfoItems;
  return getRemoteCommandReport(client, systemType, items);
}

function parseMetricNumber(output, key) {
  const match = output.match(new RegExp(`^${key}=([^\\r\\n]+)`, 'm'));
  const value = Number.parseFloat(match?.[1] ?? '');
  return Number.isFinite(value) ? value : null;
}

function parseMetricPair(output, key) {
  const match = output.match(new RegExp(`^${key}=([^\\s]+)\\s+([^\\s]+)`, 'm'));
  const first = Number.parseInt(match?.[1] ?? '', 10);
  const second = Number.parseInt(match?.[2] ?? '', 10);
  return {
    first: Number.isFinite(first) ? first : null,
    second: Number.isFinite(second) ? second : null,
  };
}

function clampMetricPercent(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(value, 100)) : null;
}

function clampMetricBytes(value) {
  return Number.isFinite(value) ? Math.max(0, value) : null;
}

function createUnixMetricsCommand() {
  return `sh <<'SHELLDESK_METRICS'
if [ -r /proc/stat ]; then
  read -r _ user nice system idle iowait irq softirq steal _ < /proc/stat
  idle1=$((idle + iowait))
  total1=$((user + nice + system + idle + iowait + irq + softirq + steal))
  sleep 0.12
  read -r _ user nice system idle iowait irq softirq steal _ < /proc/stat
  idle2=$((idle + iowait))
  total2=$((user + nice + system + idle + iowait + irq + softirq + steal))
  total_delta=$((total2 - total1))
  idle_delta=$((idle2 - idle1))
  awk -v total="$total_delta" -v idle="$idle_delta" 'BEGIN { if (total > 0) printf "cpu=%.1f\\n", (total - idle) / total * 100; else print "cpu=0" }'
else
  echo "cpu="
fi

if command -v free >/dev/null 2>&1; then
  free | awk '/^Mem:/ { if ($2 > 0) printf "mem=%.1f\\n", $3 / $2 * 100; else print "mem=0" }'
elif [ -r /proc/meminfo ]; then
  awk '
    /^MemTotal:/ { total=$2 }
    /^MemAvailable:/ { available=$2 }
    END {
      if (total > 0 && available >= 0) printf "mem=%.1f\\n", (total - available) / total * 100;
      else print "mem=0"
    }
  ' /proc/meminfo
else
  echo "mem="
fi

if [ -r /proc/net/dev ]; then
  awk 'NR > 2 { name=$1; sub(":", "", name); if (name != "lo") { rx += $2; tx += $10 } } END { printf "net=%d %d\\n", rx, tx }' /proc/net/dev
else
  echo "net=nan nan"
fi
SHELLDESK_METRICS`;
}

function createWindowsMetricsCommand() {
  return createPowerShellCommand(`
$culture = [Globalization.CultureInfo]::InvariantCulture
$cpu = $null
$mem = $null
$rx = $null
$tx = $null

try {
  $cpuValue = (Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Measure-Object -Property LoadPercentage -Average).Average
  if ($null -ne $cpuValue) { $cpu = [double]$cpuValue }
} catch {}

try {
  $os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
  if ($os -and $os.TotalVisibleMemorySize) {
    $mem = (($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / $os.TotalVisibleMemorySize) * 100
  }
} catch {}

try {
  $stats = Get-NetAdapterStatistics -ErrorAction SilentlyContinue
  $rxValue = ($stats | Measure-Object -Property ReceivedBytes -Sum).Sum
  $txValue = ($stats | Measure-Object -Property SentBytes -Sum).Sum
  if ($null -ne $rxValue) { $rx = [int64]$rxValue }
  if ($null -ne $txValue) { $tx = [int64]$txValue }
} catch {}

if ($null -ne $cpu) {
  [Console]::Out.WriteLine([string]::Format($culture, 'cpu={0:0.0}', $cpu))
} else {
  [Console]::Out.WriteLine('cpu=')
}

if ($null -ne $mem) {
  [Console]::Out.WriteLine([string]::Format($culture, 'mem={0:0.0}', $mem))
} else {
  [Console]::Out.WriteLine('mem=')
}

if ($null -ne $rx -and $null -ne $tx) {
  [Console]::Out.WriteLine([string]::Format($culture, 'net={0} {1}', $rx, $tx))
} else {
  [Console]::Out.WriteLine('net=nan nan')
}
`);
}

async function getRemoteMetrics(client, systemType = 'unknown') {
  const command = systemType === 'windows' ? createWindowsMetricsCommand() : createUnixMetricsCommand();
  const output = await execRemoteCommand(client, command);
  const net = parseMetricPair(output, 'net');

  return {
    refreshedAt: new Date().toISOString(),
    cpuPercent: clampMetricPercent(parseMetricNumber(output, 'cpu')),
    memoryPercent: clampMetricPercent(parseMetricNumber(output, 'mem')),
    netRxBytes: clampMetricBytes(net.first),
    netTxBytes: clampMetricBytes(net.second),
  };
}

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

        sftp.close(handle, (closeError) => {
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

function chmodRemotePath(client, remotePath, mode, recursive) {
  return new Promise((resolve, reject) => {
    client.sftp((sftpError, sftp) => {
      if (sftpError) {
        reject(sftpError);
        return;
      }

      const statPath = (targetPath) => new Promise((resolveStat, rejectStat) => {
        sftp.stat(targetPath, (statError, attrs) => {
          if (statError) {
            rejectStat(statError);
            return;
          }

          resolveStat(attrs);
        });
      });

      const readDirectory = (targetPath) => new Promise((resolveEntries, rejectEntries) => {
        sftp.readdir(targetPath, (readError, entries) => {
          if (readError) {
            rejectEntries(readError);
            return;
          }

          resolveEntries(entries);
        });
      });

      const chmodTarget = (targetPath) => new Promise((resolveChmod, rejectChmod) => {
        const finish = (chmodError) => {
          if (chmodError) {
            rejectChmod(chmodError);
            return;
          }

          resolveChmod(true);
        };

        if (typeof sftp.chmod === 'function') {
          sftp.chmod(targetPath, mode, finish);
          return;
        }

        sftp.setstat(targetPath, { mode }, finish);
      });

      const targets = [];
      const addTarget = (targetPath) => {
        if (targets.length >= maxRemotePermissionTargets) {
          throw new Error(`递归目标超过 ${maxRemotePermissionTargets} 项，请在终端中分批修改。`);
        }

        targets.push(targetPath);
      };

      const walk = async (targetPath, entryType) => {
        addTarget(targetPath);

        if (!recursive || entryType !== 'directory') {
          return;
        }

        const entries = await readDirectory(targetPath);

        for (const entry of entries) {
          if (entry.filename === '.' || entry.filename === '..') {
            continue;
          }

          const childPath = joinRemoteChildPath(targetPath, entry.filename);
          const childType = getSftpEntryType(entry.attrs);

          if (childType === 'directory') {
            await walk(childPath, childType);
          } else {
            addTarget(childPath);
          }
        }
      };

      (async () => {
        try {
          const rootAttrs = await statPath(remotePath);
          await walk(remotePath, getSftpEntryType(rootAttrs));

          for (const targetPath of targets) {
            await chmodTarget(targetPath);
          }

          resolve(true);
        } catch (error) {
          reject(error);
        } finally {
          sftp.end();
        }
      })();
    });
  });
}

function readPathPermissionOptions(rawOptions) {
  if (!rawOptions || typeof rawOptions !== 'object' || Array.isArray(rawOptions)) {
    throw new Error('权限设置无效。');
  }

  return {
    mode: readIntegerInRange(rawOptions.mode, '权限值', 0, 0o777),
    recursive: readBoolean(rawOptions.recursive, '递归设置', false),
  };
}

function countReplacementChars(value) {
  return (value.match(/\uFFFD/g) ?? []).length;
}

function decodeWithTextDecoder(buffer, encoding) {
  try {
    return new TextDecoder(encoding, { fatal: false }).decode(buffer);
  } catch {
    return '';
  }
}

function looksLikeUtf16Le(buffer) {
  if (buffer.length < 4) {
    return false;
  }

  let nullOddBytes = 0;
  const sampleLength = Math.min(buffer.length, 512);

  for (let index = 1; index < sampleLength; index += 2) {
    if (buffer[index] === 0) {
      nullOddBytes += 1;
    }
  }

  return nullOddBytes / Math.max(1, Math.floor(sampleLength / 2)) > 0.35;
}

function decodeSshOutputBuffer(buffer) {
  if (!buffer.length) {
    return '';
  }

  if (looksLikeUtf16Le(buffer)) {
    return cleanPowerShellCliXmlOutput(buffer.toString('utf16le'));
  }

  const utf8Text = buffer.toString('utf8');

  if (!utf8Text.includes('\uFFFD')) {
    return cleanPowerShellCliXmlOutput(utf8Text);
  }

  const candidates = ['gb18030', 'gbk', 'big5']
    .map((encoding) => decodeWithTextDecoder(buffer, encoding))
    .filter(Boolean);
  let bestText = utf8Text;
  let bestReplacementCount = countReplacementChars(utf8Text);

  for (const candidate of candidates) {
    const replacementCount = countReplacementChars(candidate);

    if (replacementCount < bestReplacementCount) {
      bestText = candidate;
      bestReplacementCount = replacementCount;
    }
  }

  return cleanPowerShellCliXmlOutput(bestText);
}

function execSshCommand(client, command) {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }

      const stdoutChunks = [];
      const stderrChunks = [];

      stream.on('data', (chunk) => { stdoutChunks.push(Buffer.from(chunk)); });
      stream.stderr.on('data', (chunk) => { stderrChunks.push(Buffer.from(chunk)); });
      stream.on('close', (code) => {
        const stdout = decodeSshOutputBuffer(Buffer.concat(stdoutChunks));
        const stderr = decodeSshOutputBuffer(Buffer.concat(stderrChunks));
        if (code === 0) {
          resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code });
        } else {
          reject(new Error(stderr.trim() || `命令执行失败，退出码 ${code}`));
        }
      });
      stream.once('error', reject);
    });
  });
}

function execRemoteCommandRaw(client, command, stdin = '') {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }

      const stdoutChunks = [];
      const stderrChunks = [];

      stream.on('data', (chunk) => { stdoutChunks.push(Buffer.from(chunk)); });
      stream.stderr.on('data', (chunk) => { stderrChunks.push(Buffer.from(chunk)); });
      if (stdin) {
        stream.end(stdin, 'utf8');
      }
      stream.on('close', (code) => {
        const stdout = decodeSshOutputBuffer(Buffer.concat(stdoutChunks));
        const stderr = decodeSshOutputBuffer(Buffer.concat(stderrChunks));
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 0 });
      });
      stream.once('error', reject);
    });
  });
}

function execRemoteCommandRawText(client, command, stdin = '') {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }

      const stdoutChunks = [];
      const stderrChunks = [];

      stream.on('data', (chunk) => { stdoutChunks.push(Buffer.from(chunk)); });
      stream.stderr.on('data', (chunk) => { stderrChunks.push(Buffer.from(chunk)); });
      stream.end(stdin, 'utf8');
      stream.on('close', (code) => {
        const stdout = decodeSshOutputBuffer(Buffer.concat(stdoutChunks));
        const stderr = decodeSshOutputBuffer(Buffer.concat(stderrChunks));
        resolve({ stdout, stderr, code: code ?? 0 });
      });
      stream.once('error', reject);
    });
  });
}

function execRemoteCommandStream(event, client, command, stdin = '', streamId) {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }

      const stdoutChunks = [];
      const stderrChunks = [];
      const stdoutDecoder = new TextDecoder('utf-8');
      const stderrDecoder = new TextDecoder('utf-8');
      const shouldCleanCliXml = /\bpowershell(?:\.exe)?\b/i.test(command);
      const stdoutCleaner = createPowerShellCliXmlStreamCleaner();
      const stderrCleaner = createPowerShellCliXmlStreamCleaner();

      const sendChunk = (source, chunk) => {
        const buffer = Buffer.from(chunk);
        const chunks = source === 'stdout' ? stdoutChunks : stderrChunks;
        const decoder = source === 'stdout' ? stdoutDecoder : stderrDecoder;
        const cleaner = source === 'stdout' ? stdoutCleaner : stderrCleaner;
        chunks.push(buffer);

        const decodedText = decoder.decode(buffer, { stream: true });
        const text = shouldCleanCliXml ? cleaner.push(decodedText) : decodedText;

        if (text && !event.sender.isDestroyed()) {
          event.sender.send('connection:run-command-stream:chunk', {
            streamId,
            stream: source,
            chunk: text,
          });
        }
      };

      const flushDecoder = (source) => {
        const decoder = source === 'stdout' ? stdoutDecoder : stderrDecoder;
        const cleaner = source === 'stdout' ? stdoutCleaner : stderrCleaner;
        const decodedText = decoder.decode();
        const text = shouldCleanCliXml ? cleaner.push(decodedText, true) : decodedText;

        if (text && !event.sender.isDestroyed()) {
          event.sender.send('connection:run-command-stream:chunk', {
            streamId,
            stream: source,
            chunk: text,
          });
        }
      };

      stream.on('data', (chunk) => sendChunk('stdout', chunk));
      stream.stderr.on('data', (chunk) => sendChunk('stderr', chunk));
      if (stdin) {
        stream.end(stdin, 'utf8');
      }
      stream.on('close', (code) => {
        flushDecoder('stdout');
        flushDecoder('stderr');

        const stdout = decodeSshOutputBuffer(Buffer.concat(stdoutChunks));
        const stderr = decodeSshOutputBuffer(Buffer.concat(stderrChunks));
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 0 });
      });
      stream.once('error', reject);
    });
  });
}

function registerRemoteConnectionHandlers(registerIpcHandler) {
  registerConnectionCleanup((connectionId) => {
    closeElevatedSftpSession(connectionId);
  });

  registerIpcHandler('connection:start-terminal', async (event, connectionId, rawTerminalId, rawColumns, rawRows, rawLaunchOptions) => {
    const terminalId = validateTerminalId(rawTerminalId);
    const columns = Number(rawColumns) || 100;
    const rows = Number(rawRows) || 30;
    const launchOptions = readTerminalLaunchOptions(rawLaunchOptions);

    if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 20 || rows < 5 || columns > 300 || rows > 120) {
      throw new Error('终端尺寸无效。');
    }

    const activeConnection = getActiveConnection(connectionId);
    if (isLocalConnection(activeConnection)) {
      await startLocalTerminal(activeConnection, terminalId, columns, rows, event.sender, sendTerminalData);
      return true;
    }

    await withActiveConnectionClientRetry(connectionId, async (activeConnection) => {
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
            if (stream) {
              stream.on('error', () => undefined);
              stream.end();
            }
            return;
          }

          settled = true;
          clearTimeout(startTimer);

          if (error) {
            reject(error);
            return;
          }

          activeConnection.terminalSessions.set(terminalId, stream);
          let streamClosed = false;
          let exitCode = null;
          let exitSignal = null;
          const startupPlan = createTerminalStartupPlan(activeConnection, launchOptions);
          let terminalPromptBuffer = '';
          let pendingRootPassword = startupPlan.rootPassword;
          let pendingAfterAuthInput = startupPlan.afterAuthInput;
          let rootPasswordSent = false;
          let afterAuthTimer = null;
          const clearAfterAuthTimer = () => {
            if (afterAuthTimer) {
              clearTimeout(afterAuthTimer);
              afterAuthTimer = null;
            }
          };
          const flushAfterAuthInput = () => {
            clearAfterAuthTimer();

            if (!streamClosed && !stream.destroyed && pendingAfterAuthInput) {
              stream.write(pendingAfterAuthInput);
            }

            pendingAfterAuthInput = '';
          };
          const scheduleAfterAuthInput = () => {
            if (!pendingAfterAuthInput) {
              return;
            }

            clearAfterAuthTimer();
            afterAuthTimer = setTimeout(() => {
              afterAuthTimer = null;
              flushAfterAuthInput();
            }, 4000);
          };
          const handleAutoSuRoot = (chunk) => {
            if (!startupPlan.rootPassword || (!pendingRootPassword && !afterAuthTimer)) {
              return;
            }

            terminalPromptBuffer = `${terminalPromptBuffer}${Buffer.from(chunk).toString('utf8')}`.slice(-2048);

            if (rootPasswordSent && afterAuthTimer && isTerminalSuAuthenticationFailure(terminalPromptBuffer)) {
              clearAfterAuthTimer();
              pendingAfterAuthInput = '';
              return;
            }

            if (rootPasswordSent && afterAuthTimer && isTerminalLikelyRootPrompt(terminalPromptBuffer)) {
              flushAfterAuthInput();
              return;
            }

            if (!rootPasswordSent && pendingRootPassword && isTerminalPasswordPrompt(terminalPromptBuffer)) {
              const password = pendingRootPassword;
              pendingRootPassword = '';
              rootPasswordSent = true;
              stream.write(`${password}\r`);
              scheduleAfterAuthInput();
            }
          };
          const closeTerminalStream = () => {
            if (streamClosed) {
              return;
            }

            streamClosed = true;
            clearAfterAuthTimer();

            if (activeConnection.terminalSessions.get(terminalId) === stream) {
              activeConnection.terminalSessions.delete(terminalId);
            }

            if (!event.sender.isDestroyed()) {
              event.sender.send('terminal:exit', { connectionId, terminalId, code: exitCode, signal: exitSignal });
            }
          };

          stream.on('data', (chunk) => {
            handleAutoSuRoot(chunk);
            sendTerminalData(event.sender, connectionId, terminalId, chunk);
          });
          stream.stderr.on('data', (chunk) => {
            handleAutoSuRoot(chunk);
            sendTerminalData(event.sender, connectionId, terminalId, chunk);
          });
          stream.once('exit', (code, signal) => {
            exitCode = Number.isInteger(code) ? code : null;
            exitSignal = typeof signal === 'string' ? signal : null;
          });
          stream.once('error', closeTerminalStream);
          stream.once('close', closeTerminalStream);

          if (startupPlan.initialInput) {
            stream.write(startupPlan.initialInput);
          }

          resolve();
        });
      });

      return true;
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

  registerIpcHandler('connection:write-terminal-binary', async (_event, connectionId, rawTerminalId, rawData) => {
    const activeConnection = getActiveConnection(connectionId);
    const terminalId = validateTerminalId(rawTerminalId);
    const terminalStream = activeConnection.terminalSessions.get(terminalId);

    if (!terminalStream || terminalStream.destroyed) {
      throw new Error('终端尚未启动。');
    }

    terminalStream.write(readTerminalBinaryInput(rawData));
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
      if (typeof terminalStream.dispose === 'function') {
        terminalStream.dispose();
      } else {
        terminalStream.removeAllListeners();
        terminalStream.on('error', () => undefined);
        terminalStream.end();
      }
    }

    return true;
  });

  registerIpcHandler('connection:list-directory', async (_event, connectionId, rawPath, rawOptions) => {
    const remotePath = validateRemotePath(rawPath);
    const options = readFilePrivilegeOptions(rawOptions);
    const activeConnection = getActiveConnection(connectionId);
    if (isLocalConnection(activeConnection)) {
      return listLocalDirectory(remotePath);
    }

    const directory = await withActiveConnectionClientRetry(connectionId, async (activeConnection) => {
      return withSftpPermissionFallback(
        activeConnection,
        options,
        () => listRemoteDirectory(activeConnection.client, remotePath),
        (_sftp, sudoClient) => listRemoteDirectory(sudoClient, remotePath),
        () => listRemoteDirectoryWithPrivilege(activeConnection, remotePath, options),
      );
    });

    return directory;
  });

  registerIpcHandler('connection:create-directory', async (_event, connectionId, rawPath, rawOptions) => {
    const remotePath = validateMutableRemotePath(rawPath);
    const options = readFilePrivilegeOptions(rawOptions);
    const activeConnection = getActiveConnection(connectionId);
    if (isLocalConnection(activeConnection)) {
      return createLocalDirectory(remotePath, options);
    }

    await withActiveConnectionClientRetry(connectionId, async (activeConnection) => {
      await withSftpPermissionFallback(
        activeConnection,
        options,
        () => createRemoteDirectory(activeConnection.client, remotePath),
        (_sftp, sudoClient) => createRemoteDirectory(sudoClient, remotePath),
        () => createRemoteDirectoryWithPrivilege(activeConnection, remotePath, options),
      );
    });
    return true;
  });

  registerIpcHandler('connection:delete-path', async (_event, connectionId, rawPath, rawType, rawOptions) => {
    const remotePath = validateMutableRemotePath(rawPath);
    const entryType = rawType === 'directory' ? 'directory' : 'file';
    const options = readFilePrivilegeOptions(rawOptions);
    const activeConnection = getActiveConnection(connectionId);
    if (isLocalConnection(activeConnection)) {
      return deleteLocalPath(remotePath, entryType, options);
    }

    await withActiveConnectionClientRetry(connectionId, async (activeConnection) => {
      await withSftpPermissionFallback(
        activeConnection,
        options,
        () => deleteRemotePath(activeConnection.client, remotePath, entryType),
        (_sftp, sudoClient) => deleteRemotePath(sudoClient, remotePath, entryType),
        () => deleteRemotePathWithPrivilege(activeConnection, remotePath, entryType, options),
      );
    });
    return true;
  });

  registerIpcHandler('connection:rename-path', async (_event, connectionId, rawOldPath, rawNewPath, rawOptions) => {
    const oldPath = validateMutableRemotePath(rawOldPath);
    const newPath = validateMutableRemotePath(rawNewPath);
    const options = readFilePrivilegeOptions(rawOptions);
    const activeConnection = getActiveConnection(connectionId);
    if (isLocalConnection(activeConnection)) {
      return renameLocalPath(oldPath, newPath, options);
    }

    await withActiveConnectionClientRetry(connectionId, async (activeConnection) => {
      await withSftpPermissionFallback(
        activeConnection,
        options,
        () => renameRemotePath(activeConnection.client, oldPath, newPath),
        (_sftp, sudoClient) => renameRemotePath(sudoClient, oldPath, newPath),
        () => renameRemotePathWithPrivilege(activeConnection, oldPath, newPath, options),
      );
    });
    return true;
  });

  registerIpcHandler('connection:create-file', async (_event, connectionId, rawPath, rawOptions) => {
    const remotePath = validateMutableRemotePath(rawPath);
    const options = readFilePrivilegeOptions(rawOptions);
    const activeConnection = getActiveConnection(connectionId);
    if (isLocalConnection(activeConnection)) {
      return createLocalFile(remotePath, options);
    }

    await withActiveConnectionClientRetry(connectionId, async (activeConnection) => {
      await withSftpPermissionFallback(
        activeConnection,
        options,
        () => createRemoteFile(activeConnection.client, remotePath),
        (_sftp, sudoClient) => createRemoteFile(sudoClient, remotePath),
        () => createRemoteFileWithPrivilege(activeConnection, remotePath, options),
      );
    });
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

  function isPermissionDeniedError(error) {
    const message = String(error?.message ?? error ?? '');
    const code = error?.code;

    return code === 3 ||
      code === 'EACCES' ||
      /permission denied|access denied|eacces|eperm/i.test(message);
  }

  function readFilePrivilegeOptions(rawOptions) {
    if (!rawOptions || typeof rawOptions !== 'object' || Array.isArray(rawOptions)) {
      return {};
    }

    const options = {};

    if (typeof rawOptions.sudoPassword === 'string') {
      options.sudoPassword = readBoundedString(rawOptions.sudoPassword, 'sudo 密码', 4096, {
          required: false,
          trim: false,
          rejectLineBreaks: true,
        });
    }

    if (typeof rawOptions.transferClientId === 'string' && rawOptions.transferClientId.trim()) {
      options.transferClientId = readBoundedString(rawOptions.transferClientId, '传输任务 ID', maxTransferQueueIdLength);
    }

    return options;
  }

  function getConfiguredPrivilege(activeConnection, options = {}) {
    if (activeConnection.displayHost.systemType === 'windows') {
      return null;
    }

    if (Object.prototype.hasOwnProperty.call(options, 'sudoPassword')) {
      return {
        mode: 'sudo',
        password: options.sudoPassword ?? '',
      };
    }

    const privilegeConfig = activeConnection.privilegeConfig;

    if (privilegeConfig?.mode === 'su-root' && privilegeConfig.rootPassword) {
      return {
        mode: 'su-root',
        password: privilegeConfig.rootPassword,
      };
    }

    return null;
  }

  function createPrivilegeStdin(privilege, stdin = '') {
    return privilege ? `${privilege.password ?? ''}\n${stdin}` : stdin;
  }

  function stripSuRootPasswordPrompt(stderr) {
    return String(stderr || '').replace(/^\s*(?:password|密码|口令)[:：]\s*/i, '');
  }

  function normalizePrivilegeResult(result, privilege) {
    if (privilege?.mode !== 'su-root') {
      return result;
    }

    return {
      ...result,
      stderr: stripSuRootPasswordPrompt(result.stderr),
    };
  }

  function isSudoPasswordRequired(result) {
    return /password is required|a terminal is required|no tty present|askpass/i.test(result.stderr);
  }

  function isSudoAuthenticationFailure(result) {
    return /sorry, try again|incorrect password|authentication failure|authentication failed/i.test(result.stderr);
  }

  function isSuAuthenticationFailure(result) {
    return /su:.*authentication failure|authentication failure|authentication failed|incorrect password|su:.*permission denied|su:.*denied|密码.*错误|认证失败|鉴定故障/i.test(result.stderr);
  }

  function isSuPasswordInputFailure(result) {
    return /must be run from a terminal|cannot open session|no tty|conversation error|authentication token manipulation/i.test(result.stderr);
  }

  function createPrivilegedShellCommand(script, args, privilege = null) {
    const baseCommand = [
      'sh',
      '-c',
      escapeShellSingleQuotedArg(script),
      'sh',
      ...args.map((arg) => escapeShellSingleQuotedArg(String(arg))),
    ].join(' ');

    if (privilege?.mode === 'sudo') {
      return [
        'if [ "$(id -u 2>/dev/null)" = "0" ]; then',
        'IFS= read -r _shelldesk_sudo_password || true;',
        `${baseCommand};`,
        'else',
        'IFS= read -r _shelldesk_sudo_password || exit 43;',
        'printf "%s\\n" "$_shelldesk_sudo_password" | sudo -S -p \'\' -v &&',
        `sudo -n ${baseCommand};`,
        'fi',
      ].join(' ');
    }

    if (privilege?.mode === 'su-root') {
      return [
        'if [ "$(id -u 2>/dev/null)" = "0" ]; then',
        'IFS= read -r _shelldesk_root_password || true;',
        `${baseCommand};`,
        'else',
        `su - root -c ${escapeShellSingleQuotedArg(baseCommand)};`,
        'fi',
      ].join(' ');
    }

    return `if [ "$(id -u 2>/dev/null)" = "0" ]; then ${baseCommand}; elif command -v sudo >/dev/null 2>&1; then sudo -n ${baseCommand}; else ${baseCommand}; fi`;
  }

  function createSudoVerifiedUserCommand(command) {
    const quotedCommand = escapeShellSingleQuotedArg(command);

    return [
      'if [ "$(id -u 2>/dev/null)" = "0" ]; then',
      'IFS= read -r _shelldesk_sudo_password || true;',
      `sh -c ${quotedCommand};`,
      'else',
      'IFS= read -r _shelldesk_sudo_password || exit 43;',
      'printf "%s\\n" "$_shelldesk_sudo_password" | sudo -S -p \'\' -v &&',
      `sudo -n sh -c ${quotedCommand};`,
      'fi',
    ].join(' ');
  }

  function createSuRootVerifiedUserCommand(command) {
    const quotedCommand = escapeShellSingleQuotedArg(command);

    return [
      'if [ "$(id -u 2>/dev/null)" = "0" ]; then',
      'IFS= read -r _shelldesk_root_password || true;',
      `sh -c ${quotedCommand};`,
      'else',
      `su - root -c ${quotedCommand};`,
      'fi',
    ].join(' ');
  }

  function createElevationRequiredError(result) {
    const detail = result.stderr.trim() || '当前账号需要 sudo 密码才能访问该文件。';
    return new Error(`SHELLDESK_ELEVATION_REQUIRED:${detail}`);
  }

  function createElevationAuthFailedError(result) {
    const detail = result.stderr.trim() || 'sudo 密码验证失败或当前账号没有提权权限。';
    return new Error(`SHELLDESK_ELEVATION_AUTH_FAILED:${detail}`);
  }

  function createSuRootElevationFailedError(result) {
    const detail = result.stderr.trim();
    const message = detail
      ? `root 密码验证失败，或当前账号不能通过 su root 提权：${detail}`
      : 'root 密码验证失败，或当前账号不能通过 su root 提权。';
    return new Error(`SHELLDESK_SU_ROOT_AUTH_FAILED:${message}`);
  }

  function createSuRootElevationUnsupportedError(result) {
    const detail = result.stderr.trim();
    const message = detail
      ? `远程系统无法在非交互 SSH 命令中使用 su root：${detail}`
      : '远程系统无法在非交互 SSH 命令中使用 su root。';
    return new Error(`SHELLDESK_SU_ROOT_UNSUPPORTED:${message}`);
  }

  function assertPrivilegeResult(result, privilege) {
    if (result.code === 0 || !privilege) {
      return;
    }

    if (privilege.mode === 'sudo' && isSudoAuthenticationFailure(result)) {
      throw createElevationAuthFailedError(result);
    }

    if (privilege.mode === 'su-root') {
      if (isSuPasswordInputFailure(result)) {
        throw createSuRootElevationUnsupportedError(result);
      }

      if (isSuAuthenticationFailure(result)) {
        throw createSuRootElevationFailedError(result);
      }
    }
  }

  function hasSudoPasswordOption(options = {}) {
    return Object.prototype.hasOwnProperty.call(options, 'sudoPassword');
  }

  function isSudoPrivilegeMode(activeConnection) {
    return activeConnection.displayHost.systemType !== 'windows' &&
      activeConnection.privilegeConfig?.mode === 'sudo';
  }

  function canAttemptSudoSftp(activeConnection) {
    return Boolean(SFTPWrapper) && isSudoPrivilegeMode(activeConnection);
  }

  function isElevationPromptError(error) {
    const message = String(error?.message ?? error ?? '');

    return message.startsWith('SHELLDESK_ELEVATION_REQUIRED:') ||
      message.startsWith('SHELLDESK_ELEVATION_AUTH_FAILED:');
  }

  function closeElevatedSftpSession(connectionId) {
    const entry = elevatedSftpSessions.get(connectionId);
    elevatedSftpSessions.delete(connectionId);

    if (!entry || entry.pending) {
      return;
    }

    entry.closed = true;

    try {
      if (entry.sftp && typeof entry.sftp.end === 'function') {
        entry.sftp.end();
      } else if (entry.sftp && typeof entry.sftp.close === 'function') {
        entry.sftp.close();
      }
    } catch {
      // Ignore cleanup failures; the owning SSH client is closing too.
    }
  }

  function createBorrowedSftpChannel(sftp) {
    return new Proxy(sftp, {
      get(target, prop) {
        if (prop === 'end' || prop === 'close') {
          return () => undefined;
        }

        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  function createBorrowedSftpClient(sftp) {
    return {
      sftp(callback) {
        callback(null, createBorrowedSftpChannel(sftp));
      },
    };
  }

  function buildSudoSftpCommand() {
    const prompt = 'SHELLDESK_SUDO_PASSWORD:';
    const readyMarker = 'SHELLDESK_SFTP_READY';
    const serverScript = [
      'server_path=',
      'for candidate in /usr/lib/openssh/sftp-server /usr/libexec/openssh/sftp-server /usr/lib/ssh/sftp-server /usr/libexec/sftp-server /usr/local/libexec/sftp-server /usr/local/lib/sftp-server; do',
      '  if [ -x "$candidate" ]; then server_path=$candidate; break; fi',
      'done',
      'if [ -z "$server_path" ] && command -v sftp-server >/dev/null 2>&1; then server_path=$(command -v sftp-server); fi',
      'if [ -z "$server_path" ]; then exit 127; fi',
      `printf ${escapeShellSingleQuotedArg(readyMarker)}`,
      'exec "$server_path" -e',
    ].join('\n');
    const quotedScript = escapeShellSingleQuotedArg(serverScript);
    const quotedPrompt = escapeShellSingleQuotedArg(prompt);

    return {
      command: [
        'if [ "$(id -u 2>/dev/null)" = "0" ]; then',
        `sh -c ${quotedScript};`,
        'else',
        `sudo -S -p ${quotedPrompt} sh -c ${quotedScript};`,
        'fi',
      ].join(' '),
      prompt,
      readyMarker,
    };
  }

  function connectSudoSftpChannel(activeConnection, options = {}) {
    if (!SFTPWrapper) {
      return Promise.reject(new Error('当前 ssh2 版本无法创建 sudo SFTP 通道。'));
    }

    const hasPassword = hasSudoPasswordOption(options);
    const sudoPassword = hasPassword ? options.sudoPassword ?? '' : '';
    const { command, prompt, readyMarker } = buildSudoSftpCommand();
    const readyMarkerBuffer = Buffer.from(readyMarker);

    return new Promise((resolve, reject) => {
      let settled = false;
      let sftpInitialized = false;
      let sftpCreated = false;
      let passwordSent = false;
      let stdoutBuffer = Buffer.alloc(0);
      let pendingAfterMarker = null;
      let stderrText = '';
      let sftp = null;
      let streamRef = null;

      const finish = (error, result) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);

        if (streamRef) {
          streamRef.removeListener('data', onStdout);
          streamRef.stderr?.removeListener('data', onStderr);
        }

        if (error) {
          try { streamRef?.destroy?.(); } catch { /* ignore */ }
          reject(error);
          return;
        }

        resolve(result);
      };

      const createFailureFromExit = (code) => {
        const result = { stdout: '', stderr: stderrText.trim(), code: code ?? 1 };

        if (isSudoPasswordRequired(result)) {
          return createElevationRequiredError(result);
        }

        if (passwordSent || isSudoAuthenticationFailure(result)) {
          return createElevationAuthFailedError(result);
        }

        if (code === 127) {
          return new Error('远程系统未找到可执行的 sftp-server，无法启用 sudo SFTP 通道。');
        }

        return new Error(result.stderr || `sudo SFTP 启动失败，退出码 ${code ?? 1}`);
      };

      const createSftp = () => {
        if (sftpCreated) {
          return;
        }

        sftpCreated = true;
        const chanInfo = {
          type: 'sftp',
          incoming: streamRef.incoming,
          outgoing: streamRef.outgoing,
        };

        try {
          sftp = new SFTPWrapper(activeConnection.client, chanInfo);

          if (activeConnection.client._chanMgr && typeof streamRef.incoming?.id === 'number') {
            activeConnection.client._chanMgr.update(streamRef.incoming.id, sftp);
          }

          sftp.once('ready', () => {
            sftpInitialized = true;
            finish(null, sftp);
          });
          sftp.once('error', (error) => {
            if (!sftpInitialized) {
              finish(error);
            }
          });
          streamRef.once('end', () => {
            try { sftp.push(null); } catch { /* ignore */ }
          });

          sftp._init();

          if (pendingAfterMarker?.length) {
            sftp.push(pendingAfterMarker);
            pendingAfterMarker = null;
          }
        } catch (error) {
          finish(error);
        }
      };

      const onStdout = (chunk) => {
        const buffer = Buffer.from(chunk);
        stdoutBuffer = stdoutBuffer.length ? Buffer.concat([stdoutBuffer, buffer]) : buffer;
        const markerIndex = stdoutBuffer.indexOf(readyMarkerBuffer);

        if (markerIndex === -1) {
          if (stdoutBuffer.length > 1024) {
            stdoutBuffer = stdoutBuffer.subarray(stdoutBuffer.length - 1024);
          }
          return;
        }

        const afterMarkerIndex = markerIndex + readyMarkerBuffer.length;
        pendingAfterMarker = afterMarkerIndex < stdoutBuffer.length
          ? stdoutBuffer.subarray(afterMarkerIndex)
          : null;
        stdoutBuffer = Buffer.alloc(0);
        streamRef.removeListener('data', onStdout);
        createSftp();
      };

      const onStderr = (chunk) => {
        stderrText = `${stderrText}${Buffer.from(chunk).toString('utf8')}`.slice(-4096);

        if (!stderrText.includes(prompt)) {
          return;
        }

        stderrText = '';

        if (!hasPassword) {
          finish(createElevationRequiredError({
            stderr: '需要 sudo 密码以打开提权 SFTP 通道。',
            code: 1,
          }));
          return;
        }

        passwordSent = true;
        streamRef.write(`${sudoPassword}\n`);
      };

      const timeout = setTimeout(() => {
        finish(new Error('sudo SFTP 握手超时。可能是 sudo 密码错误、sudo 需要 TTY，或当前账号没有 sudo 权限。'));
      }, 20000);

      activeConnection.client.exec(command, { pty: false }, (error, stream) => {
        if (error) {
          finish(error);
          return;
        }

        streamRef = stream;
        stream.on('data', onStdout);
        stream.stderr.on('data', onStderr);
        stream.once('error', finish);
        stream.once('exit', (code) => {
          if (!sftpInitialized && code !== 0) {
            finish(createFailureFromExit(code));
          }
        });
      });
    });
  }

  async function getSudoSftpChannel(activeConnection, options = {}) {
    const cached = elevatedSftpSessions.get(activeConnection.id);

    if (cached?.pending) {
      return cached.promise;
    }

    if (cached?.sftp && cached.client === activeConnection.client && !cached.closed) {
      return cached.sftp;
    }

    closeElevatedSftpSession(activeConnection.id);

    const pending = connectSudoSftpChannel(activeConnection, options)
      .then((sftp) => {
        const entry = {
          client: activeConnection.client,
          sftp,
          closed: false,
        };
        const markClosed = () => {
          entry.closed = true;
          if (elevatedSftpSessions.get(activeConnection.id) === entry) {
            elevatedSftpSessions.delete(activeConnection.id);
          }
        };

        sftp.once?.('close', markClosed);
        sftp.once?.('end', markClosed);
        sftp.once?.('error', markClosed);
        elevatedSftpSessions.set(activeConnection.id, entry);
        return sftp;
      })
      .catch((error) => {
        const current = elevatedSftpSessions.get(activeConnection.id);
        if (current?.promise === pending) {
          elevatedSftpSessions.delete(activeConnection.id);
        }
        throw error;
      });

    elevatedSftpSessions.set(activeConnection.id, {
      pending: true,
      promise: pending,
      client: activeConnection.client,
    });

    return pending;
  }

  async function createSudoSftpSession(activeConnection, options, callback) {
    const sftp = await getSudoSftpChannel(activeConnection, options);
    return callback(createBorrowedSftpChannel(sftp), createBorrowedSftpClient(sftp));
  }

  async function withSftpPermissionFallback(activeConnection, options, regularOperation, sudoSftpOperation, privilegedOperation) {
    try {
      return await regularOperation();
    } catch (error) {
      if (activeConnection.displayHost.systemType === 'windows' || !isPermissionDeniedError(error)) {
        throw error;
      }

      let sudoSftpError = null;

      if (canAttemptSudoSftp(activeConnection)) {
        try {
          return await createSudoSftpSession(activeConnection, options, sudoSftpOperation);
        } catch (errorWithSudoSftp) {
          if (isElevationPromptError(errorWithSudoSftp)) {
            throw errorWithSudoSftp;
          }

          sudoSftpError = errorWithSudoSftp;
        }
      }

      const configuredPrivilege = getConfiguredPrivilege(activeConnection, options);

      if (privilegedOperation && configuredPrivilege) {
        return privilegedOperation();
      }

      if (isSudoPrivilegeMode(activeConnection) && !hasSudoPasswordOption(options)) {
        throw createElevationRequiredError({
          stderr: '需要 sudo 密码才能访问该远程路径。',
          code: 1,
        });
      }

      if (sudoSftpError) {
        throw sudoSftpError;
      }

      throw error;
    }
  }

  async function readRemoteFileWithPrivilege(client, remotePath, privilege = null) {
    const script = [
      'remote_path=$1',
      'max_bytes=$2',
      'if [ ! -f "$remote_path" ]; then printf "%s\\n" "只能用记事本打开远程文件。" >&2; exit 40; fi',
      'size=$(wc -c < "$remote_path" 2>/dev/null | tr -dc "0-9") || exit 1',
      'if [ -z "$size" ]; then size=0; fi',
      'if [ "$size" -gt "$max_bytes" ]; then printf "文件超过 %s MB，请先下载后用本地编辑器打开。\\n" "$((max_bytes / 1024 / 1024))" >&2; exit 41; fi',
      'cat -- "$remote_path"',
    ].join('\n');
    const command = createPrivilegedShellCommand(script, [remotePath, String(maxRemoteTextFileBytes)], privilege);
    const result = normalizePrivilegeResult(
      await execRemoteCommandRawText(client, command, createPrivilegeStdin(privilege)),
      privilege,
    );

    if (result.code === 0) {
      return result.stdout;
    }

    assertPrivilegeResult(result, privilege);

    if (!privilege && isSudoPasswordRequired(result)) {
      throw createElevationRequiredError(result);
    }

    throw new Error(result.stderr.trim() || `提权读取文件失败，退出码 ${result.code}`);
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

  async function writeRemoteFileWithPrivilege(client, remotePath, content, privilege = null) {
    if (Buffer.byteLength(content, 'utf8') > maxRemoteTextWriteBytes) {
      throw new Error(`文件内容超过 ${Math.round(maxRemoteTextWriteBytes / 1024 / 1024)} MB，请使用上传功能替换大文件。`);
    }

    const script = [
      'remote_path=$1',
      'parent_dir=$(dirname -- "$remote_path") || exit 1',
      'if [ ! -d "$parent_dir" ]; then printf "%s\\n" "远程目录不存在。" >&2; exit 40; fi',
      'cat > "$remote_path"',
    ].join('\n');
    const command = createPrivilegedShellCommand(script, [remotePath], privilege);
    const result = normalizePrivilegeResult(
      await execRemoteCommandRawText(client, command, createPrivilegeStdin(privilege, content)),
      privilege,
    );

    if (result.code === 0) {
      return true;
    }

    assertPrivilegeResult(result, privilege);

    if (!privilege && isSudoPasswordRequired(result)) {
      throw createElevationRequiredError(result);
    }

    throw new Error(result.stderr.trim() || `提权写入文件失败，退出码 ${result.code}`);
  }

  async function execPrivilegedFileScript(activeConnection, script, args, label, options = {}) {
    const privilege = getConfiguredPrivilege(activeConnection, options);

    if (!privilege) {
      throw new Error(`${label}失败：当前主机未配置可用的提权方式。`);
    }

    const command = createPrivilegedShellCommand(script, args, privilege);
    const result = normalizePrivilegeResult(
      await execRemoteCommandRawText(activeConnection.client, command, createPrivilegeStdin(privilege)),
      privilege,
    );

    if (result.code === 0) {
      return result;
    }

    assertPrivilegeResult(result, privilege);
    throw new Error(result.stderr.trim() || `${label}失败，退出码 ${result.code}`);
  }

  async function listRemoteDirectoryWithPrivilege(activeConnection, remotePath, options = {}) {
    const script = [
      'target=$1',
      'if [ ! -d "$target" ]; then printf "%s\\n" "远程目录不存在。" >&2; exit 40; fi',
      'display_path=$(cd -- "$target" 2>/dev/null && pwd -P) || display_path="$target"',
      'printf "PATH\\t%s\\n" "$(printf "%s" "$display_path" | base64 | tr -d "\\n")"',
      'for entry in "$target"/* "$target"/.[!.]* "$target"/..?*; do',
      '  if [ ! -e "$entry" ] && [ ! -L "$entry" ]; then continue; fi',
      '  name=${entry##*/}',
      '  type=file',
      '  target_type=',
      '  if [ -L "$entry" ]; then',
      '    type=symlink',
      '    if [ -d "$entry" ]; then target_type=directory; elif [ -f "$entry" ]; then target_type=file; else target_type=unknown; fi',
      '  elif [ -d "$entry" ]; then',
      '    type=directory',
      '  elif [ -f "$entry" ]; then',
      '    type=file',
      '  fi',
      '  size=$(stat -Lc "%s" -- "$entry" 2>/dev/null || stat -c "%s" -- "$entry" 2>/dev/null || printf "0")',
      '  mtime=$(stat -Lc "%Y" -- "$entry" 2>/dev/null || stat -c "%Y" -- "$entry" 2>/dev/null || printf "0")',
      '  printf "ENTRY\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "$(printf "%s" "$name" | base64 | tr -d "\\n")" "$type" "$target_type" "$size" "$mtime"',
      'done',
    ].join('\n');
    const result = await execPrivilegedFileScript(activeConnection, script, [remotePath], '提权读取目录', options);

    return parsePrivilegedDirectoryListing(result.stdout, remotePath);
  }

  async function createRemoteDirectoryWithPrivilege(activeConnection, remotePath, options = {}) {
    const script = [
      'target=$1',
      'mkdir -- "$target"',
    ].join('\n');

    await execPrivilegedFileScript(activeConnection, script, [remotePath], '提权创建目录', options);
    return true;
  }

  async function ensureRemoteDirectoryWithPrivilege(activeConnection, remotePath, options = {}) {
    const script = [
      'target=$1',
      'if [ -d "$target" ]; then exit 0; fi',
      'mkdir -- "$target"',
    ].join('\n');

    await execPrivilegedFileScript(activeConnection, script, [remotePath], '提权创建目录', options);
    return true;
  }

  async function createRemoteFileWithPrivilege(activeConnection, remotePath, options = {}) {
    const script = [
      'target=$1',
      'parent_dir=$(dirname -- "$target") || exit 1',
      'if [ ! -d "$parent_dir" ]; then printf "%s\\n" "远程目录不存在。" >&2; exit 40; fi',
      ': > "$target"',
    ].join('\n');

    await execPrivilegedFileScript(activeConnection, script, [remotePath], '提权创建文件', options);
    return true;
  }

  async function renameRemotePathWithPrivilege(activeConnection, oldPath, newPath, options = {}) {
    const script = [
      'old_path=$1',
      'new_path=$2',
      'mv -- "$old_path" "$new_path"',
    ].join('\n');

    await execPrivilegedFileScript(activeConnection, script, [oldPath, newPath], '提权重命名', options);
    return true;
  }

  async function deleteRemotePathWithPrivilege(activeConnection, remotePath, entryType, options = {}) {
    const script = [
      'target=$1',
      'entry_type=$2',
      'max_targets=$3',
      'if [ "$entry_type" = "directory" ]; then',
      '  if [ ! -d "$target" ]; then printf "%s\\n" "远程目录不存在。" >&2; exit 40; fi',
      '  count=$(find -P "$target" -print 2>/dev/null | wc -l | tr -dc "0-9") || exit 1',
      '  if [ -z "$count" ]; then count=0; fi',
      '  if [ "$count" -gt "$max_targets" ]; then printf "删除目标超过 %s 项，请在终端中分批删除。\\n" "$max_targets" >&2; exit 41; fi',
      '  rm -rf -- "$target"',
      'else',
      '  if [ ! -e "$target" ] && [ ! -L "$target" ]; then printf "%s\\n" "远程文件不存在。" >&2; exit 40; fi',
      '  rm -f -- "$target"',
      'fi',
    ].join('\n');

    await execPrivilegedFileScript(activeConnection, script, [remotePath, entryType, String(maxRemoteDeleteTargets)], '提权删除', options);
    return true;
  }

  async function chmodRemotePathWithPrivilege(activeConnection, remotePath, mode, recursive, options = {}) {
    const script = [
      'target=$1',
      'mode=$2',
      'recursive=$3',
      'max_targets=$4',
      'if [ ! -e "$target" ] && [ ! -L "$target" ]; then printf "%s\\n" "远程路径不存在。" >&2; exit 40; fi',
      'if [ "$recursive" = "1" ] && [ -d "$target" ]; then',
      '  count=$(find -P "$target" -print 2>/dev/null | wc -l | tr -dc "0-9") || exit 1',
      '  if [ -z "$count" ]; then count=0; fi',
      '  if [ "$count" -gt "$max_targets" ]; then printf "递归目标超过 %s 项，请在终端中分批修改。\\n" "$max_targets" >&2; exit 41; fi',
      '  chmod -R "$mode" -- "$target"',
      'else',
      '  chmod "$mode" -- "$target"',
      'fi',
    ].join('\n');

    await execPrivilegedFileScript(
      activeConnection,
      script,
      [remotePath, mode.toString(8), recursive ? '1' : '0', String(maxRemotePermissionTargets)],
      '提权修改权限',
      options,
    );
    return true;
  }

  registerIpcHandler('connection:stat-path', async (_event, connectionId, rawPath, rawOptions) => {
    const remotePath = validateRemotePath(rawPath);
    const privilegeOptions = readFilePrivilegeOptions(rawOptions);
    const activeConnection = getActiveConnection(connectionId);
    if (isLocalConnection(activeConnection)) {
      return statLocalPath(remotePath);
    }

    return withActiveConnectionClientRetry(connectionId, (activeConnection) =>
      withSftpPermissionFallback(
        activeConnection,
        privilegeOptions,
        () => statRemotePath(activeConnection.client, remotePath),
        (_sftp, sudoClient) => statRemotePath(sudoClient, remotePath),
        null,
      ));
  });

  registerIpcHandler('connection:set-path-permissions', async (_event, connectionId, rawPath, rawOptions) => {
    const remotePath = validateMutableRemotePath(rawPath);
    const options = readPathPermissionOptions(rawOptions);
    const privilegeOptions = readFilePrivilegeOptions(rawOptions);
    const activeConnection = getActiveConnection(connectionId);
    if (isLocalConnection(activeConnection)) {
      return setLocalPathPermissions(remotePath, { ...options, ...privilegeOptions });
    }

    await withActiveConnectionClientRetry(connectionId, async (activeConnection) => {
      await withSftpPermissionFallback(
        activeConnection,
        privilegeOptions,
        () => chmodRemotePath(activeConnection.client, remotePath, options.mode, options.recursive),
        (_sftp, sudoClient) => chmodRemotePath(sudoClient, remotePath, options.mode, options.recursive),
        () => chmodRemotePathWithPrivilege(activeConnection, remotePath, options.mode, options.recursive, privilegeOptions),
      );
    });
    return true;
  });

  registerIpcHandler('connection:read-file', async (_event, connectionId, rawPath, rawOptions) => {
    const remotePath = validateRemotePath(rawPath);
    const options = readFilePrivilegeOptions(rawOptions);
    const activeConnection = getActiveConnection(connectionId);
    if (isLocalConnection(activeConnection)) {
      return readLocalTextFile(remotePath, options);
    }

    return withActiveConnectionClientRetry(connectionId, async (activeConnection) => {
      try {
        return await readRemoteFile(activeConnection.client, remotePath);
      } catch (error) {
        if (activeConnection.displayHost.systemType === 'windows' || !isPermissionDeniedError(error)) {
          throw error;
        }

        return readRemoteFileWithPrivilege(activeConnection.client, remotePath, getConfiguredPrivilege(activeConnection, options));
      }
    });
  });

  registerIpcHandler('connection:write-file', async (_event, connectionId, rawPath, content, rawOptions) => {
    const remotePath = validateMutableRemotePath(rawPath);
    if (typeof content !== 'string') {
      throw new Error('文件内容必须是字符串。');
    }
    const options = readFilePrivilegeOptions(rawOptions);
    const activeConnection = getActiveConnection(connectionId);
    if (isLocalConnection(activeConnection)) {
      return writeLocalTextFile(remotePath, content, options);
    }

    await withActiveConnectionClientRetry(connectionId, async (activeConnection) => {
      try {
        await writeRemoteFile(activeConnection.client, remotePath, content);
      } catch (error) {
        if (activeConnection.displayHost.systemType === 'windows' || !isPermissionDeniedError(error)) {
          throw error;
        }

        await writeRemoteFileWithPrivilege(activeConnection.client, remotePath, content, getConfiguredPrivilege(activeConnection, options));
      }
    });
    return true;
  });

  // ─── Transfer queue ──────────────────────────────────────────────────────────

  const activeTransferQueues = new Map();

  function createTransferCanceledError() {
    const error = new Error('传输已取消。');
    error.code = 'SHELLDESK_TRANSFER_CANCELED';
    return error;
  }

  function isTransferCanceledError(error) {
    return error?.code === 'SHELLDESK_TRANSFER_CANCELED' || /传输已取消/.test(error?.message ?? '');
  }

  function readTransferQueueId(rawQueueId) {
    if (typeof rawQueueId !== 'string' || !rawQueueId.trim()) {
      return '';
    }

    return readBoundedString(rawQueueId, '传输队列 ID', maxTransferQueueIdLength);
  }

  function readRemotePathList(rawPaths) {
    if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
      throw new Error('请选择要传输的远程项目。');
    }

    if (rawPaths.length > 500) {
      throw new Error('一次最多选择 500 个远程项目。');
    }

    return rawPaths.map((rawPath) => validateRemotePath(rawPath));
  }

  function readLocalUploadItems(rawItems) {
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      throw new Error('请选择要上传的本地项目。');
    }

    if (rawItems.length > 500) {
      throw new Error('一次最多选择 500 个本地项目。');
    }

    return rawItems.map((rawItem) => {
      const item = typeof rawItem === 'string' ? { path: rawItem } : rawItem;

      if (!item || typeof item !== 'object') {
        throw new Error('本地上传项目无效。');
      }

      const localPath = readBoundedString(item.path, '本地路径', 4096);
      const remoteName = typeof item.remoteName === 'string' && item.remoteName.trim()
        ? sanitizeLocalFileName(item.remoteName.trim(), 'upload')
        : '';

      if (!path.isAbsolute(localPath) || localPath.includes('\0') || !fs.existsSync(localPath)) {
        throw new Error('本地上传路径无效或不存在。');
      }

      return remoteName ? { localPath, remoteName } : { localPath };
    });
  }

  function toUploadSelectionItem(localPath) {
    const stats = fs.lstatSync(localPath);
    return {
      path: localPath,
      name: path.basename(localPath) || 'upload',
      type: stats.isDirectory() ? 'directory' : 'file',
      size: stats.isFile() ? stats.size : 0,
      modifiedAt: new Date(stats.mtimeMs).toISOString(),
    };
  }

  function sendTransferPayload(sender, channel, payload) {
    if (sender && !sender.isDestroyed()) {
      sender.send(channel, payload);
    }
  }

  function createTransferQueue(connectionId, type, sender, clientId = '') {
    const queueId = `transfer-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    let activeDestroy = null;
    let canceled = false;
    let ended = false;
    let lastSent = 0;
    let total = 0;
    let transferred = 0;
    let totalFiles = 0;
    let completedFiles = 0;
    let totalItems = 0;
    let completedItems = 0;
    let fileName = type === 'download' ? '准备下载...' : '准备上传...';
    let currentFileTransferred = 0;
    let currentFileTotal = 0;

    const createPayload = () => ({
      connectionId,
      queueId,
      ...(clientId ? { clientId } : {}),
      type,
      fileName,
      transferred,
      total,
      currentFileTransferred,
      currentFileTotal,
      completedFiles,
      totalFiles,
      completedItems,
      totalItems,
    });

    const sendProgress = (force = false) => {
      const now = Date.now();
      if (!force && now - lastSent < 100) {
        return;
      }

      lastSent = now;
      sendTransferPayload(sender, 'transfer:progress', createPayload());
    };

    const queue = {
      connectionId,
      queueId,
      clientId,
      get canceled() {
        return canceled;
      },
      assertActive() {
        if (canceled) {
          throw createTransferCanceledError();
        }
      },
      cancel() {
        canceled = true;
        if (activeDestroy) {
          activeDestroy(createTransferCanceledError());
        }
      },
      setTotals(nextTotal, nextTotalFiles, nextTotalItems) {
        total = nextTotal;
        totalFiles = nextTotalFiles;
        totalItems = nextTotalItems;
        sendProgress(true);
      },
      startFile(nextFileName, nextTotal) {
        this.assertActive();
        fileName = nextFileName;
        currentFileTransferred = 0;
        currentFileTotal = nextTotal;
        sendProgress(true);
      },
      addBytes(byteCount) {
        transferred += byteCount;
        currentFileTransferred += byteCount;
        sendProgress();
      },
      rollbackBytes(byteCount) {
        if (byteCount <= 0) {
          return;
        }

        transferred = Math.max(0, transferred - byteCount);
        currentFileTransferred = Math.max(0, currentFileTransferred - byteCount);
        sendProgress(true);
      },
      completeFile() {
        completedFiles += 1;
        completedItems += 1;
        currentFileTransferred = currentFileTotal;
        sendProgress(true);
      },
      completeDirectory(nextFileName) {
        fileName = nextFileName;
        completedItems += 1;
        currentFileTransferred = 0;
        currentFileTotal = 0;
        sendProgress(true);
      },
      setActiveDestroy(destroy) {
        activeDestroy = destroy;
      },
      clearActiveDestroy(destroy) {
        if (activeDestroy === destroy) {
          activeDestroy = null;
        }
      },
      finish(success, error) {
        if (ended) {
          return;
        }

        ended = true;
        if (activeTransferQueues.get(queueId) === queue) {
          activeTransferQueues.delete(queueId);
        }

        sendTransferPayload(sender, 'transfer:end', {
          ...createPayload(),
          success,
          error: error ? error.message ?? String(error) : undefined,
        });
      },
    };

    return queue;
  }

  function cancelActiveTransferQueue(connectionId, rawQueueId) {
    const queueId = readTransferQueueId(rawQueueId);

    if (queueId) {
      const queue = activeTransferQueues.get(queueId);

      if (!queue || queue.connectionId !== connectionId) {
        return false;
      }

      queue.cancel();
      return true;
    }

    let canceled = false;
    for (const queue of activeTransferQueues.values()) {
      if (queue.connectionId === connectionId) {
        queue.cancel();
        canceled = true;
      }
    }

    return canceled;
  }

  registerIpcHandler('connection:cancel-transfer', (_event, connectionId, rawQueueId) => {
    const activeConnection = getActiveConnection(connectionId);
    if (isLocalConnection(activeConnection)) {
      return cancelLocalTransfer(connectionId, readTransferQueueId(rawQueueId)) ||
        cancelActiveTransferQueue(connectionId, rawQueueId);
    }

    return cancelActiveTransferQueue(connectionId, rawQueueId);
  });

  function createSftpSession(client, callback) {
    return new Promise((resolve, reject) => {
      client.sftp((sftpError, sftp) => {
        if (sftpError) {
          reject(sftpError);
          return;
        }

        (async () => {
          try {
            resolve(await callback(sftp));
          } catch (error) {
            reject(error);
          } finally {
            try { sftp.end(); } catch (_) { /* ignore */ }
          }
        })();
      });
    });
  }

  registerIpcHandler('connection:check-sftp', async (_event, connectionId) => {
    const activeConnection = getActiveConnection(connectionId);
    if (isLocalConnection(activeConnection)) {
      return { available: true };
    }

    try {
      await withActiveConnectionClientRetry(connectionId, (activeConnection) =>
        createSftpSession(activeConnection.client, async () => true));
      return { available: true };
    } catch (error) {
      return { available: false, error: toErrorMessage(error) };
    }
  });

  registerIpcHandler('connection:zmodem-select-upload-files', async (event) => {
    cleanupExpiredZmodemUploadSelections();
    const senderWindow = BrowserWindow.fromWebContents(event.sender);

    const result = await dialog.showOpenDialog(senderWindow ?? BrowserWindow.getAllWindows()[0], {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '所有文件', extensions: ['*'] }],
      title: '选择要通过 ZMODEM 上传的文件',
    });

    if (result.canceled || !result.filePaths.length) {
      return { canceled: true, files: [] };
    }

    const files = result.filePaths
      .map((filePath) => createZmodemUploadSelection(filePath))
      .filter(Boolean)
      .map((selection) => ({
        id: selection.id,
        name: selection.name,
        size: selection.size,
        lastModified: selection.lastModified,
      }));

    if (!files.length) {
      throw new Error('没有可上传的本地文件。');
    }

    return { canceled: false, files };
  });

  registerIpcHandler('connection:zmodem-read-upload-file', async (_event, rawFileId, rawOffset, rawLength) => {
    const selection = getZmodemUploadSelection(rawFileId);
    const offset = Number(rawOffset);
    const requestedLength = Number(rawLength);

    if (
      !Number.isInteger(offset) ||
      !Number.isInteger(requestedLength) ||
      offset < 0 ||
      requestedLength < 1 ||
      requestedLength > maxZmodemReadChunkBytes
    ) {
      throw new Error('读取上传文件的范围无效。');
    }

    if (offset >= selection.size) {
      return new ArrayBuffer(0);
    }

    const length = Math.min(requestedLength, selection.size - offset);
    const buffer = Buffer.alloc(length);
    const fileHandle = await fs.promises.open(selection.path, 'r');

    try {
      const result = await fileHandle.read(buffer, 0, length, offset);
      return toIpcArrayBuffer(buffer.subarray(0, result.bytesRead));
    } finally {
      await fileHandle.close().catch(() => undefined);
    }
  });

  registerIpcHandler('connection:zmodem-release-upload-files', (_event, rawFileIds) => {
    const ids = Array.isArray(rawFileIds) ? rawFileIds : [];

    for (const id of ids) {
      if (typeof id === 'string') {
        zmodemUploadSelections.delete(id);
      }
    }

    cleanupExpiredZmodemUploadSelections();
    return true;
  });

  registerIpcHandler('connection:zmodem-save-file', async (event, rawFileName, rawContent) => {
    const fileName = sanitizeLocalFileName(typeof rawFileName === 'string' ? rawFileName : '', 'download');
    const content = readBinaryInput(rawContent, 'ZMODEM 下载内容');
    const senderWindow = BrowserWindow.fromWebContents(event.sender);

    const result = await dialog.showSaveDialog(senderWindow ?? BrowserWindow.getAllWindows()[0], {
      defaultPath: fileName,
      filters: [{ name: '所有文件', extensions: ['*'] }],
    });

    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }

    await fs.promises.writeFile(result.filePath, content);
    return { canceled: false, filePath: result.filePath, size: content.length };
  });

  function statSftpPath(sftp, targetPath) {
    return new Promise((resolve, reject) => {
      sftp.stat(targetPath, (statError, attrs) => {
        if (statError) {
          reject(statError);
          return;
        }

        resolve(attrs);
      });
    });
  }

  function readSftpDirectory(sftp, targetPath) {
    return new Promise((resolve, reject) => {
      sftp.readdir(targetPath, (readError, entries) => {
        if (readError) {
          reject(readError);
          return;
        }

        resolve(entries.filter((entry) => entry.filename !== '.' && entry.filename !== '..'));
      });
    });
  }

  function makeSftpDirectory(sftp, targetPath) {
    return new Promise((resolve, reject) => {
      sftp.mkdir(targetPath, (mkdirError) => {
        if (!mkdirError) {
          resolve(true);
          return;
        }

        sftp.stat(targetPath, (statError, attrs) => {
          if (!statError && attrs && getSftpEntryType(attrs) === 'directory') {
            resolve(true);
            return;
          }

          reject(mkdirError);
        });
      });
    });
  }

  async function collectRemoteDownloadPlan(sftp, roots, queue) {
    const directories = [];
    const files = [];
    let totalBytes = 0;
    let itemCount = 0;

    const countItem = () => {
      itemCount += 1;
      if (itemCount > maxTransferQueueItems) {
        throw new Error(`传输项目超过 ${maxTransferQueueItems} 项，请分批传输。`);
      }
    };

    const walk = async (remotePath, localPath, relativePath, fileOnly = false) => {
      queue.assertActive();
      const attrs = await statSftpPath(sftp, remotePath);
      const type = getSftpEntryType(attrs);

      if (type === 'directory') {
        if (fileOnly) {
          throw new Error('请选择批量下载来下载文件夹。');
        }

        countItem();
        directories.push({ remotePath, localPath, relativePath });
        const entries = await readSftpDirectory(sftp, remotePath);

        for (const entry of entries) {
          const childRemotePath = joinRemoteChildPath(remotePath, entry.filename);
          const childLocalPath = path.join(localPath, sanitizeLocalFileName(entry.filename, 'download'));
          const childRelativePath = `${relativePath}/${entry.filename}`;
          await walk(childRemotePath, childLocalPath, childRelativePath);
        }
        return;
      }

      countItem();
      const size = attrs.size ?? 0;
      totalBytes += size;
      files.push({ remotePath, localPath, relativePath, size });
    };

    for (const root of roots) {
      await walk(root.remotePath, root.localPath, root.relativePath, root.fileOnly);
    }

    return { directories, files, totalBytes, itemCount };
  }

  async function collectRemoteDownloadPlanWithPrivilege(activeConnection, roots, queue, options = {}) {
    const directories = [];
    const files = [];
    let totalBytes = 0;
    let itemCount = 0;

    const countItem = () => {
      itemCount += 1;
      if (itemCount > maxTransferQueueItems) {
        throw new Error(`传输项目超过 ${maxTransferQueueItems} 项，请分批传输。`);
      }
    };

    const localPathForEntry = (root, relativePath) => {
      const normalizedRootRelative = String(root.relativePath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      const normalizedRelative = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

      if (!normalizedRelative || normalizedRelative === normalizedRootRelative) {
        return root.localPath;
      }

      if (normalizedRootRelative && normalizedRelative.startsWith(`${normalizedRootRelative}/`)) {
        return path.join(root.localPath, sanitizeRelativeLocalPath(normalizedRelative.slice(normalizedRootRelative.length + 1)));
      }

      return path.join(path.dirname(root.localPath), sanitizeRelativeLocalPath(normalizedRelative));
    };

    const parseOutput = (output, root) => {
      for (const line of output.split(/\r?\n/)) {
        if (!line) {
          continue;
        }

        const parts = line.split('\t');

        if (parts[0] !== 'ENTRY' || parts.length < 5) {
          continue;
        }

        const remotePath = decodeBase64DirectoryField(parts[1]);
        const relativePath = decodeBase64DirectoryField(parts[2]);
        const type = parts[3] === 'directory' ? 'directory' : 'file';
        const size = Number(parts[4]);

        if (!remotePath || !relativePath) {
          continue;
        }

        countItem();

        const entry = {
          remotePath,
          localPath: localPathForEntry(root, relativePath),
          relativePath,
        };

        if (type === 'directory') {
          directories.push(entry);
          continue;
        }

        const normalizedSize = Number.isFinite(size) && size >= 0 ? size : 0;
        totalBytes += normalizedSize;
        files.push({ ...entry, size: normalizedSize });
      }
    };

    const script = [
      'target=$1',
      'relative_root=$2',
      'file_only=$3',
      'encode_field() { printf "%s" "$1" | base64 | tr -d "\\n"; }',
      'emit_entry() {',
      '  entry=$1',
      '  relative=$2',
      '  entry_type=file',
      '  if [ -L "$entry" ]; then',
      '    entry_type=file',
      '  elif [ -d "$entry" ]; then',
      '    entry_type=directory',
      '  fi',
      '  size=0',
      '  if [ "$entry_type" = "file" ]; then',
      '    size=$(stat -Lc "%s" -- "$entry" 2>/dev/null || stat -c "%s" -- "$entry" 2>/dev/null || wc -c < "$entry" 2>/dev/null || printf "0")',
      '  fi',
      '  printf "ENTRY\\t%s\\t%s\\t%s\\t%s\\n" "$(encode_field "$entry")" "$(encode_field "$relative")" "$entry_type" "$size"',
      '}',
      'if [ ! -e "$target" ] && [ ! -L "$target" ]; then printf "%s\\n" "远程路径不存在。" >&2; exit 40; fi',
      'if [ -L "$target" ] || [ ! -d "$target" ]; then',
      '  emit_entry "$target" "$relative_root"',
      '  exit 0',
      'fi',
      'if [ "$file_only" = "1" ]; then printf "%s\\n" "请选择批量下载来下载文件夹。" >&2; exit 41; fi',
      'target_prefix=${target%/}',
      'if [ -z "$target_prefix" ]; then target_prefix=/; fi',
      'emit_entry "$target_prefix" "$relative_root"',
      'find "$target_prefix" -mindepth 1 -print | while IFS= read -r entry; do',
      '  suffix=${entry#"$target_prefix"/}',
      '  if [ "$suffix" = "$entry" ]; then suffix=${entry#"$target_prefix"}; suffix=${suffix#/}; fi',
      '  if [ -n "$suffix" ]; then relative="$relative_root/$suffix"; else relative="$relative_root"; fi',
      '  emit_entry "$entry" "$relative"',
      'done',
    ].join('\n');

    for (const root of roots) {
      queue.assertActive();
      const result = await execPrivilegedFileScript(
        activeConnection,
        script,
        [root.remotePath, root.relativePath, root.fileOnly ? '1' : '0'],
        '提权准备下载',
        options,
      );
      parseOutput(result.stdout, root);
    }

    if (!itemCount) {
      throw new Error('没有可传输的文件。');
    }

    return { directories, files, totalBytes, itemCount };
  }

  function collectLocalUploadPlan(localPaths, remoteDirectory, queue) {
    const directories = [];
    const files = [];
    const rootRemotePaths = [];
    let totalBytes = 0;
    let itemCount = 0;

    const countItem = () => {
      itemCount += 1;
      if (itemCount > maxTransferQueueItems) {
        throw new Error(`传输项目超过 ${maxTransferQueueItems} 项，请分批传输。`);
      }
    };

    const walk = (localPath, remotePath, relativePath) => {
      queue.assertActive();
      const stats = fs.lstatSync(localPath);

      if (stats.isDirectory()) {
        countItem();
        directories.push({ localPath, remotePath, relativePath });
        const entries = fs.readdirSync(localPath, { withFileTypes: true })
          .sort((left, right) => remoteEntryCollator.compare(left.name, right.name));

        for (const entry of entries) {
          if (entry.isSymbolicLink()) {
            continue;
          }

          const childLocalPath = path.join(localPath, entry.name);
          const childRemotePath = validateMutableRemotePath(joinRemoteChildPath(remotePath, entry.name));
          const childRelativePath = `${relativePath}/${entry.name}`;
          walk(childLocalPath, childRemotePath, childRelativePath);
        }
        return;
      }

      if (!stats.isFile()) {
        return;
      }

      countItem();
      totalBytes += stats.size;
      files.push({ localPath, remotePath, relativePath, size: stats.size });
    };

    for (const localRoot of localPaths) {
      const localPath = typeof localRoot === 'string' ? localRoot : localRoot.localPath;
      const name = (typeof localRoot === 'object' && localRoot.remoteName)
        ? localRoot.remoteName
        : path.basename(localPath) || 'upload';
      const remotePath = validateMutableRemotePath(joinRemoteChildPath(remoteDirectory, name));
      rootRemotePaths.push(remotePath);
      walk(localPath, remotePath, name);
    }

    if (!directories.length && !files.length) {
      throw new Error('没有可传输的文件。');
    }

    return { directories, files, rootRemotePaths, totalBytes, itemCount };
  }

  function transferRemoteFileToLocal(sftp, file, queue) {
    queue.startFile(file.relativePath, file.size);
    fs.mkdirSync(path.dirname(file.localPath), { recursive: true });

    return new Promise((resolve, reject) => {
      let settled = false;
      let transferredForFile = 0;
      const readStream = sftp.createReadStream(file.remotePath);
      const writeStream = fs.createWriteStream(file.localPath, { flags: 'w' });
      const destroy = (error) => {
        readStream.destroy(error);
        writeStream.destroy(error);
      };

      const finish = () => {
        if (settled) return;
        settled = true;
        queue.clearActiveDestroy(destroy);
        queue.completeFile();
        resolve(file.size);
      };

      const fail = (error) => {
        if (settled) return;
        settled = true;
        queue.clearActiveDestroy(destroy);
        queue.rollbackBytes(transferredForFile);
        destroy();
        reject(error);
      };

      queue.setActiveDestroy(destroy);
      readStream.on('data', (chunk) => {
        transferredForFile += chunk.length;
        queue.addBytes(chunk.length);
      });
      readStream.on('error', fail);
      writeStream.on('error', fail);
      writeStream.on('finish', finish);
      readStream.pipe(writeStream);
    });
  }

  function transferLocalFileToRemote(sftp, file, queue) {
    queue.startFile(file.relativePath, file.size);

    return new Promise((resolve, reject) => {
      let settled = false;
      let transferredForFile = 0;
      const readStream = fs.createReadStream(file.localPath);
      const writeStream = sftp.createWriteStream(file.remotePath);
      const destroy = (error) => {
        readStream.destroy(error);
        writeStream.destroy(error);
      };

      const finish = () => {
        if (settled) return;
        settled = true;
        queue.clearActiveDestroy(destroy);
        queue.completeFile();
        resolve(file.size);
      };

      const fail = (error) => {
        if (settled) return;
        settled = true;
        queue.clearActiveDestroy(destroy);
        queue.rollbackBytes(transferredForFile);
        destroy();
        reject(error);
      };

      queue.setActiveDestroy(destroy);
      readStream.on('data', (chunk) => {
        transferredForFile += chunk.length;
        queue.addBytes(chunk.length);
      });
      readStream.on('error', fail);
      writeStream.on('error', fail);
      writeStream.on('close', finish);
      readStream.pipe(writeStream);
    });
  }

  function createPrivilegedTransferError(result, privilege, fallbackMessage) {
    try {
      assertPrivilegeResult(result, privilege);
    } catch (error) {
      return error;
    }

    if (!privilege && isSudoPasswordRequired(result)) {
      return createElevationRequiredError(result);
    }

    return new Error(result.stderr.trim() || fallbackMessage);
  }

  function transferRemoteFileToLocalWithPrivilege(activeConnection, file, queue, options = {}) {
    const privilege = getConfiguredPrivilege(activeConnection, options);

    if (!privilege) {
      throw new Error('下载失败：当前主机未配置可用的提权方式。');
    }

    const script = [
      'remote_path=$1',
      'if [ ! -f "$remote_path" ]; then printf "%s\\n" "只能下载普通文件。" >&2; exit 40; fi',
      'cat -- "$remote_path"',
    ].join('\n');
    const command = createPrivilegedShellCommand(script, [file.remotePath], privilege);

    queue.startFile(file.relativePath, file.size);
    fs.mkdirSync(path.dirname(file.localPath), { recursive: true });

    return new Promise((resolve, reject) => {
      let settled = false;
      let transferredForFile = 0;
      let sshClosed = false;
      let writeFinished = false;
      let exitCode = 0;
      const stderrChunks = [];
      let sshStream = null;
      let writeStream = null;

      const destroy = (error) => {
        if (sshStream) {
          sshStream.destroy(error);
        }
        if (writeStream) {
          writeStream.destroy(error);
        }
      };

      const fail = (error) => {
        if (settled) return;
        settled = true;
        queue.clearActiveDestroy(destroy);
        queue.rollbackBytes(transferredForFile);
        destroy();
        reject(error);
      };

      const finishIfReady = () => {
        if (settled || !sshClosed || !writeFinished) {
          return;
        }

        const stderr = decodeSshOutputBuffer(Buffer.concat(stderrChunks));
        const result = normalizePrivilegeResult({ stdout: '', stderr, code: exitCode ?? 0 }, privilege);

        if (result.code !== 0) {
          fail(createPrivilegedTransferError(result, privilege, `提权下载文件失败，退出码 ${result.code}`));
          return;
        }

        settled = true;
        queue.clearActiveDestroy(destroy);
        queue.completeFile();
        resolve(file.size);
      };

      activeConnection.client.exec(command, (error, stream) => {
        if (error) {
          fail(error);
          return;
        }

        sshStream = stream;
        writeStream = fs.createWriteStream(file.localPath, { flags: 'w' });
        queue.setActiveDestroy(destroy);

        stream.on('data', (chunk) => {
          const buffer = Buffer.from(chunk);
          transferredForFile += buffer.length;
          queue.addBytes(buffer.length);
        });
        stream.stderr.on('data', (chunk) => { stderrChunks.push(Buffer.from(chunk)); });
        stream.once('error', fail);
        writeStream.once('error', fail);
        writeStream.on('finish', () => {
          writeFinished = true;
          finishIfReady();
        });
        stream.on('close', (code) => {
          sshClosed = true;
          exitCode = code ?? 0;
          finishIfReady();
        });
        stream.pipe(writeStream);
        stream.end(createPrivilegeStdin(privilege), 'utf8');
      });
    });
  }

  function transferLocalFileToRemoteWithPrivilege(activeConnection, file, queue, options = {}) {
    const privilege = getConfiguredPrivilege(activeConnection, options);

    if (!privilege) {
      throw new Error('上传失败：当前主机未配置可用的提权方式。');
    }

    const readyMarker = `SHELLDESK_UPLOAD_READY_${crypto.randomUUID().replace(/-/g, '')}`;
    const script = [
      'remote_path=$1',
      'ready_marker=$2',
      'parent_dir=$(dirname -- "$remote_path") || exit 1',
      'base_name=$(basename -- "$remote_path") || exit 1',
      'if [ ! -d "$parent_dir" ]; then printf "%s\\n" "远程目录不存在。" >&2; exit 40; fi',
      'if [ "$parent_dir" = "/" ]; then tmp_path="/.${base_name}.shelldesk-upload.$$"; else tmp_path="${parent_dir%/}/.${base_name}.shelldesk-upload.$$"; fi',
      'cleanup_upload_tmp() { rm -f -- "$tmp_path"; }',
      'trap cleanup_upload_tmp INT TERM HUP',
      'printf "%s\\n" "$ready_marker" >&2',
      'cat > "$tmp_path" || { cleanup_upload_tmp; exit 1; }',
      'mv -f -- "$tmp_path" "$remote_path"',
    ].join('\n');
    const command = createPrivilegedShellCommand(script, [file.remotePath, readyMarker], privilege);

    queue.startFile(file.relativePath, file.size);

    return new Promise((resolve, reject) => {
      let settled = false;
      let transferredForFile = 0;
      let exitCode = 0;
      const stderrChunks = [];
      let sshStream = null;
      let readStream = null;
      let uploadStarted = false;
      let markerProbeText = '';
      let startupTimer = null;

      const destroy = (error) => {
        if (readStream) {
          readStream.destroy(error);
        }
        if (sshStream) {
          sshStream.destroy(error);
        }
      };

      const fail = (error) => {
        if (settled) return;
        settled = true;
        if (startupTimer) {
          clearTimeout(startupTimer);
          startupTimer = null;
        }
        queue.clearActiveDestroy(destroy);
        queue.rollbackBytes(transferredForFile);
        destroy();
        reject(error);
      };

      const startUpload = () => {
        if (settled || uploadStarted || !sshStream) {
          return;
        }

        uploadStarted = true;
        if (startupTimer) {
          clearTimeout(startupTimer);
          startupTimer = null;
        }

        readStream = fs.createReadStream(file.localPath);
        readStream.once('error', fail);
        readStream.on('data', (chunk) => {
          transferredForFile += chunk.length;
          queue.addBytes(chunk.length);
        });
        readStream.pipe(sshStream);
      };

      const handleStderrChunk = (chunk) => {
        const buffer = Buffer.from(chunk);
        stderrChunks.push(buffer);

        if (uploadStarted) {
          return;
        }

        markerProbeText = `${markerProbeText}${buffer.toString('utf8')}`;
        if (markerProbeText.includes(readyMarker)) {
          startUpload();
          return;
        }

        const maxProbeLength = readyMarker.length + 2048;
        if (markerProbeText.length > maxProbeLength) {
          markerProbeText = markerProbeText.slice(-maxProbeLength);
        }
      };

      activeConnection.client.exec(command, (error, stream) => {
        if (error) {
          fail(error);
          return;
        }

        sshStream = stream;
        queue.setActiveDestroy(destroy);

        stream.on('data', () => {});
        stream.stderr.on('data', handleStderrChunk);
        stream.once('error', fail);
        stream.on('close', (code) => {
          if (settled) {
            return;
          }

          if (startupTimer) {
            clearTimeout(startupTimer);
            startupTimer = null;
          }

          exitCode = code ?? 0;
          const stderr = decodeSshOutputBuffer(Buffer.concat(stderrChunks)).replace(readyMarker, '').trim();
          const result = normalizePrivilegeResult({ stdout: '', stderr, code: exitCode }, privilege);

          if (result.code !== 0) {
            fail(createPrivilegedTransferError(result, privilege, `提权上传文件失败，退出码 ${result.code}`));
            return;
          }

          if (!uploadStarted) {
            fail(new Error(result.stderr || '提权上传未进入远程接收阶段。'));
            return;
          }

          if (transferredForFile < file.size) {
            fail(new Error('上传在本地文件发送完成前结束。'));
            return;
          }

          settled = true;
          queue.clearActiveDestroy(destroy);
          queue.completeFile();
          resolve(file.size);
        });

        startupTimer = setTimeout(() => {
          const stderr = decodeSshOutputBuffer(Buffer.concat(stderrChunks)).replace(readyMarker, '').trim();
          fail(new Error(stderr || '提权上传启动超时，远端未进入文件接收阶段。'));
        }, 20000);
        stream.write(createPrivilegeStdin(privilege), 'utf8');
      });
    });
  }

  async function runTransferQueue(connectionId, type, sender, executor, options = {}) {
    const queue = createTransferQueue(connectionId, type, sender, options.transferClientId);
    activeTransferQueues.set(queue.queueId, queue);
    queue.setTotals(0, 0, 0);

    try {
      const result = await executor(queue);
      queue.finish(true);
      return { canceled: false, ...result };
    } catch (error) {
      queue.finish(false, error);
      if (isTransferCanceledError(error)) {
        return { canceled: true };
      }
      throw error;
    }
  }

  async function runDownloadTransfer(connectionId, sender, roots, options = {}) {
    return runTransferQueue(connectionId, 'download', sender, async (queue) => {
      let totalBytes = 0;
      let totalFiles = 0;
      let totalItems = 0;

      await withActiveConnectionClientRetry(connectionId, async (activeConnection) => {
        let plan = null;
        let privilegedPlan = '';

        try {
          plan = await createSftpSession(activeConnection.client, (sftp) =>
            collectRemoteDownloadPlan(sftp, roots, queue));
        } catch (error) {
          if (activeConnection.displayHost.systemType === 'windows' || !isPermissionDeniedError(error)) {
            throw error;
          }

          let sudoSftpError = null;

          if (canAttemptSudoSftp(activeConnection)) {
            try {
              plan = await createSudoSftpSession(activeConnection, options, (sudoSftp) =>
                collectRemoteDownloadPlan(sudoSftp, roots, queue));
              privilegedPlan = 'sudo-sftp';
            } catch (errorWithSudoSftp) {
              if (isElevationPromptError(errorWithSudoSftp)) {
                throw errorWithSudoSftp;
              }

              sudoSftpError = errorWithSudoSftp;
            }
          }

          if (!plan && getConfiguredPrivilege(activeConnection, options)) {
            plan = await collectRemoteDownloadPlanWithPrivilege(activeConnection, roots, queue, options);
            privilegedPlan = 'command';
          }

          if (!plan && isSudoPrivilegeMode(activeConnection) && !hasSudoPasswordOption(options)) {
            throw createElevationRequiredError({
              stderr: '需要 sudo 密码才能下载该远程路径。',
              code: 1,
            });
          }

          if (!plan) {
            throw sudoSftpError || error;
          }
        }

        totalBytes = plan.totalBytes;
        totalFiles = plan.files.length;
        totalItems = plan.itemCount;
        queue.setTotals(totalBytes, totalFiles, totalItems);

        for (const directory of plan.directories) {
          queue.assertActive();
          fs.mkdirSync(directory.localPath, { recursive: true });
          queue.completeDirectory(directory.relativePath);
        }

        if (privilegedPlan === 'sudo-sftp') {
          await createSudoSftpSession(activeConnection, options, async (sudoSftp) => {
            for (const file of plan.files) {
              queue.assertActive();
              await transferRemoteFileToLocal(sudoSftp, file, queue);
            }
          });
          return;
        }

        if (privilegedPlan === 'command') {
          for (const file of plan.files) {
            queue.assertActive();
            await transferRemoteFileToLocalWithPrivilege(activeConnection, file, queue, options);
          }
          return;
        }

        await createSftpSession(activeConnection.client, async (sftp) => {
          for (const file of plan.files) {
            queue.assertActive();

            try {
              await transferRemoteFileToLocal(sftp, file, queue);
            } catch (error) {
              if (activeConnection.displayHost.systemType === 'windows' || !isPermissionDeniedError(error)) {
                throw error;
              }

              let sudoSftpError = null;
              let transferredWithSudoSftp = false;

              if (canAttemptSudoSftp(activeConnection)) {
                try {
                  await createSudoSftpSession(activeConnection, options, (sudoSftp) =>
                    transferRemoteFileToLocal(sudoSftp, file, queue));
                  transferredWithSudoSftp = true;
                } catch (errorWithSudoSftp) {
                  if (isElevationPromptError(errorWithSudoSftp)) {
                    throw errorWithSudoSftp;
                  }

                  sudoSftpError = errorWithSudoSftp;
                }
              }

              if (transferredWithSudoSftp) {
                continue;
              }

              if (getConfiguredPrivilege(activeConnection, options)) {
                await transferRemoteFileToLocalWithPrivilege(activeConnection, file, queue, options);
                continue;
              }

              if (isSudoPrivilegeMode(activeConnection) && !hasSudoPasswordOption(options)) {
                throw createElevationRequiredError({
                  stderr: '需要 sudo 密码才能下载该远程文件。',
                  code: 1,
                });
              }

              throw sudoSftpError || error;
            }
          }
        });
      });

      return { size: totalBytes, fileCount: totalFiles, itemCount: totalItems };
    }, options);
  }

  async function runUploadTransfer(connectionId, sender, localPaths, remoteDirectory, options = {}) {
    return runTransferQueue(connectionId, 'upload', sender, async (queue) => {
      const plan = collectLocalUploadPlan(localPaths, remoteDirectory, queue);
      queue.setTotals(plan.totalBytes, plan.files.length, plan.itemCount);

      await withActiveConnectionClientRetry(connectionId, async (activeConnection) => {
        await createSftpSession(activeConnection.client, async (sftp) => {
          for (const directory of plan.directories) {
            queue.assertActive();

            try {
              await makeSftpDirectory(sftp, directory.remotePath);
            } catch (error) {
              if (activeConnection.displayHost.systemType === 'windows' || !isPermissionDeniedError(error)) {
                throw error;
              }

              let sudoSftpError = null;
              let createdWithSudoSftp = false;

              if (canAttemptSudoSftp(activeConnection)) {
                try {
                  await createSudoSftpSession(activeConnection, options, (sudoSftp) =>
                    makeSftpDirectory(sudoSftp, directory.remotePath));
                  createdWithSudoSftp = true;
                } catch (errorWithSudoSftp) {
                  if (isElevationPromptError(errorWithSudoSftp)) {
                    throw errorWithSudoSftp;
                  }

                  sudoSftpError = errorWithSudoSftp;
                }
              }

              if (!createdWithSudoSftp && getConfiguredPrivilege(activeConnection, options)) {
                await ensureRemoteDirectoryWithPrivilege(activeConnection, directory.remotePath, options);
                createdWithSudoSftp = true;
              }

              if (!createdWithSudoSftp && isSudoPrivilegeMode(activeConnection) && !hasSudoPasswordOption(options)) {
                throw createElevationRequiredError({
                  stderr: '需要 sudo 密码才能创建远程目录。',
                  code: 1,
                });
              }

              if (!createdWithSudoSftp) {
                throw sudoSftpError || error;
              }
            }

            queue.completeDirectory(directory.relativePath);
          }

          for (const file of plan.files) {
            queue.assertActive();

            try {
              await transferLocalFileToRemote(sftp, file, queue);
            } catch (error) {
              if (activeConnection.displayHost.systemType === 'windows' || !isPermissionDeniedError(error)) {
                throw error;
              }

              let sudoSftpError = null;
              let uploadedWithSudoSftp = false;

              if (canAttemptSudoSftp(activeConnection)) {
                try {
                  await createSudoSftpSession(activeConnection, options, (sudoSftp) =>
                    transferLocalFileToRemote(sudoSftp, file, queue));
                  uploadedWithSudoSftp = true;
                } catch (errorWithSudoSftp) {
                  if (isElevationPromptError(errorWithSudoSftp)) {
                    throw errorWithSudoSftp;
                  }

                  sudoSftpError = errorWithSudoSftp;
                }
              }

              if (uploadedWithSudoSftp) {
                continue;
              }

              if (getConfiguredPrivilege(activeConnection, options)) {
                await transferLocalFileToRemoteWithPrivilege(activeConnection, file, queue, options);
                continue;
              }

              if (isSudoPrivilegeMode(activeConnection) && !hasSudoPasswordOption(options)) {
                throw createElevationRequiredError({
                  stderr: '需要 sudo 密码才能上传到该远程路径。',
                  code: 1,
                });
              }

              throw sudoSftpError || error;
            }
          }
        });
      });

      return {
        remotePath: plan.rootRemotePaths[0],
        remotePaths: plan.rootRemotePaths,
        size: plan.totalBytes,
        fileCount: plan.files.length,
        itemCount: plan.itemCount,
      };
    }, options);
  }

  registerIpcHandler('connection:download-file', async (event, connectionId, rawPath, rawOptions) => {
    const remotePath = validateRemotePath(rawPath);
    const options = readFilePrivilegeOptions(rawOptions);
    const remoteFileName = getRemoteFileName(remotePath);
    const senderWindow = BrowserWindow.fromWebContents(event.sender);

    const result = await dialog.showSaveDialog(senderWindow ?? BrowserWindow.getAllWindows()[0], {
      defaultPath: sanitizeLocalFileName(remoteFileName),
      filters: [{ name: '所有文件', extensions: ['*'] }],
    });

    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }

    const activeConnection = getActiveConnection(connectionId);
    if (isLocalConnection(activeConnection)) {
      const transferResult = await copyLocalDownload(connectionId, event.sender, [remotePath], result.filePath, true, options);
      return { ...transferResult, filePath: result.filePath };
    }

    const transferResult = await runDownloadTransfer(connectionId, event.sender, [{
      remotePath,
      localPath: result.filePath,
      relativePath: remoteFileName,
      fileOnly: true,
    }], options);

    return { ...transferResult, filePath: result.filePath };
  });

  registerIpcHandler('connection:download-paths', async (event, connectionId, rawPaths, rawOptions) => {
    const remotePaths = readRemotePathList(rawPaths);
    const options = readFilePrivilegeOptions(rawOptions);
    const senderWindow = BrowserWindow.fromWebContents(event.sender);

    const result = await dialog.showOpenDialog(senderWindow ?? BrowserWindow.getAllWindows()[0], {
      properties: ['openDirectory', 'createDirectory'],
      title: '选择下载保存目录',
    });

    if (result.canceled || !result.filePaths.length) {
      return { canceled: true };
    }

    const localDirectory = result.filePaths[0];
    const activeConnection = getActiveConnection(connectionId);
    if (isLocalConnection(activeConnection)) {
      const transferResult = await copyLocalDownload(connectionId, event.sender, remotePaths, localDirectory, false, options);
      return { ...transferResult, directoryPath: localDirectory };
    }

    const roots = remotePaths.map((remotePath) => {
      const fileName = getRemoteFileName(remotePath);
      return {
        remotePath,
        localPath: path.join(localDirectory, sanitizeLocalFileName(fileName, 'download')),
        relativePath: fileName,
      };
    });
    const transferResult = await runDownloadTransfer(connectionId, event.sender, roots, options);

    return { ...transferResult, directoryPath: localDirectory };
  });

  registerIpcHandler('connection:select-upload-files', async (event) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(senderWindow ?? BrowserWindow.getAllWindows()[0], {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '所有文件', extensions: ['*'] }],
      title: '选择要上传的文件',
    });

    if (result.canceled || !result.filePaths.length) {
      return { canceled: true, items: [] };
    }

    return {
      canceled: false,
      items: result.filePaths.map(toUploadSelectionItem),
    };
  });

  registerIpcHandler('connection:select-upload-folders', async (event) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(senderWindow ?? BrowserWindow.getAllWindows()[0], {
      properties: ['openDirectory', 'multiSelections'],
      title: '选择要上传的文件夹',
    });

    if (result.canceled || !result.filePaths.length) {
      return { canceled: true, items: [] };
    }

    return {
      canceled: false,
      items: result.filePaths.map(toUploadSelectionItem),
    };
  });

  registerIpcHandler('connection:upload-file', async (event, connectionId, rawRemotePath, rawOptions) => {
    const currentPath = validateRemotePath(rawRemotePath);
    const options = readFilePrivilegeOptions(rawOptions);
    const senderWindow = BrowserWindow.fromWebContents(event.sender);

    const result = await dialog.showOpenDialog(senderWindow ?? BrowserWindow.getAllWindows()[0], {
      properties: ['openFile'],
      filters: [{ name: '所有文件', extensions: ['*'] }],
    });

    if (result.canceled || !result.filePaths.length) {
      return { canceled: true };
    }

    const activeConnection = getActiveConnection(connectionId);
    if (isLocalConnection(activeConnection)) {
      const transferResult = await copyLocalUpload(
        connectionId,
        event.sender,
        result.filePaths.slice(0, 1).map((localPath) => ({ localPath })),
        currentPath,
        options,
      );
      return { ...transferResult, remotePath: currentPath };
    }

    return runUploadTransfer(connectionId, event.sender, result.filePaths.slice(0, 1), currentPath, options);
  });

  registerIpcHandler('connection:upload-files', async (event, connectionId, rawRemotePath, rawOptions) => {
    const currentPath = validateRemotePath(rawRemotePath);
    const options = readFilePrivilegeOptions(rawOptions);
    const senderWindow = BrowserWindow.fromWebContents(event.sender);

    const result = await dialog.showOpenDialog(senderWindow ?? BrowserWindow.getAllWindows()[0], {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '所有文件', extensions: ['*'] }],
      title: '选择要上传的文件',
    });

    if (result.canceled || !result.filePaths.length) {
      return { canceled: true };
    }

    const activeConnection = getActiveConnection(connectionId);
    if (isLocalConnection(activeConnection)) {
      const transferResult = await copyLocalUpload(
        connectionId,
        event.sender,
        result.filePaths.map((localPath) => ({ localPath })),
        currentPath,
        options,
      );
      return { ...transferResult, remotePath: currentPath };
    }

    return runUploadTransfer(connectionId, event.sender, result.filePaths, currentPath, options);
  });

  registerIpcHandler('connection:upload-paths', async (event, connectionId, rawRemotePath, rawOptions) => {
    const currentPath = validateRemotePath(rawRemotePath);
    const options = readFilePrivilegeOptions(rawOptions);
    const senderWindow = BrowserWindow.fromWebContents(event.sender);

    const result = await dialog.showOpenDialog(senderWindow ?? BrowserWindow.getAllWindows()[0], {
      properties: ['openDirectory', 'multiSelections'],
      title: '选择要上传的文件夹',
    });

    if (result.canceled || !result.filePaths.length) {
      return { canceled: true };
    }

    const activeConnection = getActiveConnection(connectionId);
    if (isLocalConnection(activeConnection)) {
      const transferResult = await copyLocalUpload(
        connectionId,
        event.sender,
        result.filePaths.map((localPath) => ({ localPath })),
        currentPath,
        options,
      );
      return { ...transferResult, remotePath: currentPath };
    }

    return runUploadTransfer(connectionId, event.sender, result.filePaths, currentPath, options);
  });

  registerIpcHandler('connection:upload-local-paths', async (event, connectionId, rawRemotePath, rawItems, rawOptions) => {
    const currentPath = validateRemotePath(rawRemotePath);
    const localItems = readLocalUploadItems(rawItems);
    const options = readFilePrivilegeOptions(rawOptions);
    const activeConnection = getActiveConnection(connectionId);
    if (isLocalConnection(activeConnection)) {
      const transferResult = await copyLocalUpload(connectionId, event.sender, localItems, currentPath, options);
      return { ...transferResult, remotePath: currentPath };
    }

    return runUploadTransfer(connectionId, event.sender, localItems, currentPath, options);
  });

  registerIpcHandler('connection:get-status', async (_event, connectionId) => {
    const activeConnection = getActiveConnection(connectionId);
    if (isLocalConnection(activeConnection)) {
      return getLocalStatus();
    }

    return withActiveConnectionClientRetry(connectionId, (activeConnection) =>
      getRemoteStatus(activeConnection.client, activeConnection.displayHost.systemType));
  });

  registerIpcHandler('connection:get-system-info', async (_event, connectionId) => {
    const activeConnection = getActiveConnection(connectionId);
    if (isLocalConnection(activeConnection)) {
      return getLocalSystemInfo();
    }

    return withActiveConnectionClientRetry(connectionId, (activeConnection) =>
      getRemoteSystemInfo(activeConnection.client, activeConnection.displayHost.systemType));
  });

  registerIpcHandler('connection:get-metrics', async (_event, connectionId) => {
    const activeConnection = getActiveConnection(connectionId);
    if (isLocalConnection(activeConnection)) {
      return getLocalMetrics();
    }

    return withActiveConnectionClientRetry(connectionId, (activeConnection) =>
      getRemoteMetrics(activeConnection.client, activeConnection.displayHost.systemType));
  });

  registerIpcHandler('connection:run-command', async (_event, connectionId, rawCommand, rawStdin, rawOptions) => {
    const command = readBoundedString(rawCommand, '命令', maxRemoteCommandLength, { rejectLineBreaks: false });
    const stdin = typeof rawStdin === 'string'
      ? readBoundedString(rawStdin, '命令输入', maxRemoteCommandInputLength, { required: false, trim: false, rejectLineBreaks: false })
      : '';
    const options = readFilePrivilegeOptions(rawOptions);
    const activeConnection = getActiveConnection(connectionId);
    if (isLocalConnection(activeConnection)) {
      return runLocalCommand(command, stdin);
    }

    return withActiveConnectionClientRetry(connectionId, async (activeConnection) => {
      const privilege = getConfiguredPrivilege(activeConnection, options);

      if (privilege?.mode === 'sudo') {
        const result = await execRemoteCommandRaw(
          activeConnection.client,
          createSudoVerifiedUserCommand(command),
          createPrivilegeStdin(privilege, stdin),
        );
        assertPrivilegeResult(result, privilege);
        return result;
      }

      if (privilege?.mode === 'su-root') {
        const result = normalizePrivilegeResult(
          await execRemoteCommandRaw(
            activeConnection.client,
            createSuRootVerifiedUserCommand(command),
            createPrivilegeStdin(privilege, stdin),
          ),
          privilege,
        );
        assertPrivilegeResult(result, privilege);
        return result;
      }

      return execRemoteCommandRaw(activeConnection.client, command, stdin);
    });
  });

  registerIpcHandler('connection:run-command-stream', async (event, connectionId, rawCommand, rawStdin, rawStreamId, rawOptions) => {
    const command = readBoundedString(rawCommand, '命令', maxRemoteCommandLength, { rejectLineBreaks: false });
    const stdin = typeof rawStdin === 'string'
      ? readBoundedString(rawStdin, '命令输入', maxRemoteCommandInputLength, { required: false, trim: false, rejectLineBreaks: false })
      : '';
    const streamId = readBoundedString(rawStreamId, '命令流标识', 120);
    const options = readFilePrivilegeOptions(rawOptions);
    const activeConnection = getActiveConnection(connectionId);
    if (isLocalConnection(activeConnection)) {
      return runLocalCommand(command, stdin, {
        onChunk: (chunk, streamName) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send('connection:run-command-stream:chunk', {
              streamId,
              stream: streamName,
              chunk,
            });
          }
        },
      });
    }

    return withActiveConnectionClientRetry(connectionId, async (activeConnection) => {
      const privilege = getConfiguredPrivilege(activeConnection, options);

      if (privilege?.mode === 'sudo') {
        const result = await execRemoteCommandStream(
          event,
          activeConnection.client,
          createSudoVerifiedUserCommand(command),
          createPrivilegeStdin(privilege, stdin),
          streamId,
        );
        assertPrivilegeResult(result, privilege);
        return result;
      }

      if (privilege?.mode === 'su-root') {
        const result = normalizePrivilegeResult(
          await execRemoteCommandStream(
            event,
            activeConnection.client,
            createSuRootVerifiedUserCommand(command),
            createPrivilegeStdin(privilege, stdin),
            streamId,
          ),
          privilege,
        );
        assertPrivilegeResult(result, privilege);
        return result;
      }

      return execRemoteCommandStream(event, activeConnection.client, command, stdin, streamId);
    });
  });

  registerIpcHandler('connection:compress', async (_event, connectionId, rawSourcePaths, rawFormat, rawDestPath) => {
    const activeConnection = getActiveConnection(connectionId);

    if (!Array.isArray(rawSourcePaths) || rawSourcePaths.length === 0) {
      throw new Error('请选择要压缩的文件。');
    }

    const sourcePaths = rawSourcePaths.map((p) => validateRemotePath(p));
    const format = ['zip', 'tar', 'tar.gz', 'tgz', '7z'].includes(rawFormat) ? rawFormat : 'zip';
    const destPath = validateMutableRemotePath(rawDestPath);

    if (activeConnection.displayHost.systemType === 'windows') {
      if (format !== 'zip') {
        throw new Error('Windows 主机暂仅支持 ZIP 压缩。');
      }

      const sourceArray = `@(${sourcePaths.map(quotePowerShellString).join(', ')})`;
      const command = createPowerShellCommand(`Compress-Archive -LiteralPath ${sourceArray} -DestinationPath ${quotePowerShellString(destPath)} -Force`);
      await withActiveConnectionClientRetry(connectionId, (connection) =>
        execSshCommand(connection.client, command));
      return { format, destPath };
    }

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

    await withActiveConnectionClientRetry(connectionId, (connection) =>
      execSshCommand(connection.client, command));
    return { format, destPath };
  });

  registerIpcHandler('connection:decompress', async (_event, connectionId, rawArchivePath, rawDestDir) => {
    const activeConnection = getActiveConnection(connectionId);
    const archivePath = validateRemotePath(rawArchivePath);
    const archiveName = getRemoteFileName(archivePath, '');
    const escapedArchive = `'${archivePath.replace(/'/g, "'\\''")}'`;
    const destDir = rawDestDir ? validateRemotePath(rawDestDir) : validateRemotePath(getRemoteParentPath(archivePath));
    const escapedDest = `'${destDir.replace(/'/g, "'\\''")}'`;

    let command = '';

    if (activeConnection.displayHost.systemType === 'windows') {
      if (!archiveName.toLowerCase().endsWith('.zip')) {
        throw new Error('Windows 主机暂仅支持 ZIP 解压缩。');
      }

      command = createPowerShellCommand(`Expand-Archive -LiteralPath ${quotePowerShellString(archivePath)} -DestinationPath ${quotePowerShellString(destDir)} -Force`);
      await withActiveConnectionClientRetry(connectionId, (connection) =>
        execSshCommand(connection.client, command));
      return { archivePath, destDir };
    }

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

    await withActiveConnectionClientRetry(connectionId, (connection) =>
      execSshCommand(connection.client, command));
    return { archivePath, destDir };
  });
}

module.exports = {
  detectRemoteSystem,
  execRemoteCommandRaw,
  registerRemoteConnectionHandlers,
  statRemotePath,
  validateRemotePath,
};
