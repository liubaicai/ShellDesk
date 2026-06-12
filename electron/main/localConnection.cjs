const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { spawn } = childProcess;
const { TextDecoder } = require('node:util');

const {
  maxRemoteTextFileBytes,
  maxRemoteTextWriteBytes,
} = require('./constants.cjs');
const {
  quotePowerShellString,
  readBoundedString,
  toErrorMessage,
} = require('./validation.cjs');
const {
  cleanPowerShellCliXmlOutput,
  createPowerShellCliXmlStreamCleaner,
} = require('./powershellCliXml.cjs');

const maxLocalTransferItems = 20000;
const maxLocalCommandOutputBytes = 16 * 1024 * 1024;
const activeLocalTransfers = new Map();
let nodePty = null;
let didPatchNodePtyConsoleListAgent = false;

function isLocalPermissionError(error) {
  const message = String(error?.message ?? error ?? '');
  return error?.code === 'EACCES' ||
    error?.code === 'EPERM' ||
    /permission denied|access denied|operation not permitted|eacces|eperm/i.test(message);
}

function hasSudoPasswordOption(options = {}) {
  return Object.prototype.hasOwnProperty.call(options, 'sudoPassword');
}

function toIpcArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function decodeWindowsOutputBuffer(buffer) {
  const utf8Text = buffer.toString('utf8');

  if (!utf8Text.includes('\uFFFD')) {
    return cleanPowerShellCliXmlOutput(utf8Text);
  }

  try {
    return cleanPowerShellCliXmlOutput(new TextDecoder('gb18030', { fatal: false }).decode(buffer));
  } catch {
    return cleanPowerShellCliXmlOutput(utf8Text);
  }
}

function decodeLocalOutputBuffer(buffer) {
  return process.platform === 'win32' ? decodeWindowsOutputBuffer(buffer) : buffer.toString('utf8');
}

function createLocalOutputDecoder() {
  if (process.platform !== 'win32') {
    const utf8Decoder = new TextDecoder('utf-8', { fatal: false });
    return {
      decode(chunk) {
        return utf8Decoder.decode(Buffer.from(chunk), { stream: true });
      },
    };
  }

  let mode = 'auto';
  const utf8Decoder = new TextDecoder('utf-8', { fatal: false });
  const gb18030Decoder = new TextDecoder('gb18030', { fatal: false });

  return {
    decode(chunk) {
      const buffer = Buffer.from(chunk);

      if (mode === 'gb18030') {
        return gb18030Decoder.decode(buffer, { stream: true });
      }

      const utf8Text = utf8Decoder.decode(buffer, { stream: true });
      if (!utf8Text.includes('\uFFFD')) {
        return utf8Text;
      }

      mode = 'gb18030';
      return gb18030Decoder.decode(buffer, { stream: true });
    },
  };
}

function sendLocalTerminalText(sender, connectionId, terminalId, text, cleaner = null, flush = false) {
  const normalizedText = process.platform === 'win32' ? text.replace(/\x7f/g, '\b') : text;
  const cleanedText = cleaner ? cleaner.push(normalizedText, flush) : normalizedText;
  const outputText = process.platform === 'win32'
    ? cleanedText.replace(/\r?\n/g, '\r\n')
    : cleanedText;

  if (!outputText || sender.isDestroyed()) {
    return;
  }

  const buffer = Buffer.from(outputText, 'utf8');
  sender.send('terminal:data', {
    connectionId,
    terminalId,
    data: outputText,
    bytes: toIpcArrayBuffer(buffer),
  });
}

function loadNodePty() {
  if (nodePty) {
    return nodePty;
  }

  patchNodePtyConsoleListAgent();

  try {
    nodePty = require('node-pty');
    return nodePty;
  } catch (error) {
    throw new Error(`本地终端 PTY 后端不可用：${toErrorMessage(error)}`);
  }
}

function patchNodePtyConsoleListAgent() {
  if (process.platform !== 'win32' || didPatchNodePtyConsoleListAgent) {
    return;
  }

  didPatchNodePtyConsoleListAgent = true;
  const originalFork = childProcess.fork;

  if (typeof originalFork !== 'function' || originalFork.__shelldeskPatchedConptyAgent) {
    return;
  }

  const patchedFork = function patchedFork(modulePath, args, options) {
    const normalizedPath = typeof modulePath === 'string' ? modulePath.replace(/\\/g, '/') : '';
    const isNodePtyConsoleListAgent = normalizedPath.includes('/node-pty/') &&
      normalizedPath.endsWith('/conpty_console_list_agent');

    if (!isNodePtyConsoleListAgent) {
      return originalFork.apply(this, arguments);
    }

    const forkArgs = Array.isArray(args) ? args : [];
    const forkOptions = Array.isArray(args) ? options : args;
    const child = originalFork.call(this, modulePath, forkArgs, {
      ...(forkOptions || {}),
      silent: true,
    });

    child.stdout?.on('data', () => undefined);
    child.stderr?.on('data', () => undefined);
    child.on('error', () => undefined);
    return child;
  };

  Object.defineProperty(patchedFork, '__shelldeskPatchedConptyAgent', {
    value: true,
  });
  childProcess.fork = patchedFork;
}

function isLocalConnection(activeConnection) {
  return activeConnection?.kind === 'local' || activeConnection?.client?.__shelldeskLocalClient === true;
}

function createLocalClient() {
  return {
    __shelldeskLocalClient: true,
    removeAllListeners() {},
    on() {},
    end() {},
  };
}

function getLocalUsername() {
  try {
    return os.userInfo().username || process.env.USERNAME || process.env.USER || 'local';
  } catch {
    return process.env.USERNAME || process.env.USER || 'local';
  }
}

function getLocalSystemType() {
  if (process.platform === 'win32') {
    return 'windows';
  }

  if (process.platform === 'darwin') {
    return 'macos';
  }

  if (process.platform === 'linux') {
    return 'linux';
  }

  return 'unix';
}

function getLocalSystemName() {
  if (process.platform === 'win32') {
    return `Windows ${os.release()}`;
  }

  if (process.platform === 'darwin') {
    return `macOS ${os.release()}`;
  }

  return `${os.type()} ${os.release()}`;
}

function createLocalDisplayHost() {
  return {
    id: 'local',
    name: '本地模式',
    address: 'localhost',
    port: 0,
    username: getLocalUsername(),
    authMethod: 'agent',
    privilegeMode: undefined,
    systemType: getLocalSystemType(),
    systemName: getLocalSystemName(),
  };
}

function getLocalHomeDirectory() {
  return os.homedir() || process.cwd();
}

function normalizeWindowsLocalPath(rawPath) {
  const trimmed = String(rawPath || '').trim();

  if (!trimmed || trimmed === '.' || trimmed === '~') {
    return getLocalHomeDirectory();
  }

  if (trimmed === '/') {
    return '/';
  }

  const withoutLeadingDriveSlash = trimmed.replace(/^\/([a-z]:)/i, '$1');
  const nativePath = withoutLeadingDriveSlash.replace(/\//g, '\\');

  if (/^[a-z]:\\?$/i.test(nativePath)) {
    return `${nativePath.slice(0, 2)}\\`;
  }

  if (path.win32.isAbsolute(nativePath)) {
    return path.win32.normalize(nativePath);
  }

  return path.win32.resolve(getLocalHomeDirectory(), nativePath);
}

function normalizePosixLocalPath(rawPath) {
  const trimmed = String(rawPath || '').trim();

  if (!trimmed || trimmed === '.' || trimmed === '~') {
    return getLocalHomeDirectory();
  }

  if (path.posix.isAbsolute(trimmed)) {
    return path.posix.normalize(trimmed);
  }

  return path.posix.resolve(getLocalHomeDirectory(), trimmed);
}

function normalizeLocalPath(rawPath) {
  if (process.platform === 'win32') {
    return normalizeWindowsLocalPath(rawPath);
  }

  return normalizePosixLocalPath(rawPath);
}

function toDisplayPath(localPath) {
  if (process.platform !== 'win32') {
    return localPath;
  }

  if (localPath === '/') {
    return '/';
  }

  const normalized = path.win32.normalize(localPath).replace(/\\/g, '/');
  return /^[a-z]:$/i.test(normalized) ? `${normalized}/` : normalized;
}

function getPathModuleForLocal() {
  return process.platform === 'win32' ? path.win32 : path.posix;
}

async function cleanupLocalTempDirectory(tempDirectory) {
  try {
    await fs.promises.rm(tempDirectory, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup only.
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readWindowsElevationResultFile(resultPath, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() <= deadline) {
    try {
      const rawText = await fs.promises.readFile(resultPath, 'utf8');
      const jsonText = rawText.replace(/^\uFEFF/u, '').trim();

      if (jsonText) {
        return JSON.parse(jsonText);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        lastError = error;
      }
    }

    await delay(100);
  }

  if (lastError) {
    throw lastError;
  }

  return null;
}

function collectChildProcessOutput(child, stdin = '', outputLimit = maxLocalCommandOutputBytes) {
  return new Promise((resolve, reject) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const appendChunk = (chunks, chunk, streamName) => {
      const buffer = Buffer.from(chunk);

      if (streamName === 'stderr') {
        stderrBytes += buffer.length;
      } else {
        stdoutBytes += buffer.length;
      }

      if (stdoutBytes + stderrBytes <= outputLimit) {
        chunks.push(buffer);
      }
    };

    const finish = (callback) => {
      if (settled) {
        return;
      }

      settled = true;
      callback();
    };

    child.stdout?.on('data', (chunk) => appendChunk(stdoutChunks, chunk, 'stdout'));
    child.stderr?.on('data', (chunk) => appendChunk(stderrChunks, chunk, 'stderr'));
    child.once('error', (error) => finish(() => reject(error)));
    child.once('close', (code) => finish(() => {
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        code: Number.isInteger(code) ? code : 0,
        truncated: stdoutBytes + stderrBytes > outputLimit,
      });
    }));

    if (stdin) {
      child.stdin?.write(stdin);
    }

    child.stdin?.end();
  });
}

async function runWindowsElevatedPowerShell(scriptBody) {
  const tempDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'shelldesk-elevated-'));
  const operationScriptPath = path.join(tempDirectory, 'operation.ps1');
  const launcherScriptPath = path.join(tempDirectory, 'launch.ps1');
  const resultPath = path.join(tempDirectory, 'result.json');

  const operationScript = `
$ErrorActionPreference = 'Stop'
$resultPath = ${quotePowerShellString(resultPath)}
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
try {
${scriptBody}
  [System.IO.File]::WriteAllText($resultPath, (@{ ok = $true } | ConvertTo-Json -Compress), $utf8NoBom)
  exit 0
} catch {
  [System.IO.File]::WriteAllText($resultPath, (@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress), $utf8NoBom)
  exit 1
}
`;
  const launcherScript = `
$ErrorActionPreference = 'Stop'
$process = Start-Process -FilePath 'powershell.exe' -ArgumentList @(
  '-NoProfile',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
  ${quotePowerShellString(operationScriptPath)}
) -Verb RunAs -Wait -PassThru
if ($null -ne $process.ExitCode) {
  exit $process.ExitCode
}
`;

  try {
    await fs.promises.writeFile(operationScriptPath, operationScript, 'utf8');
    await fs.promises.writeFile(launcherScriptPath, launcherScript, 'utf8');

    const result = await collectChildProcessOutput(spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      launcherScriptPath,
    ], {
      cwd: tempDirectory,
      windowsHide: true,
    }));

    let operationResult = null;
    try {
      operationResult = await readWindowsElevationResultFile(resultPath);
    } catch {
      if (result.code !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim() || '管理员授权已取消或提权操作未完成。';
        throw new Error(detail);
      }

      throw new Error('提权操作没有返回执行结果。');
    }

    if (!operationResult && result.code === 0) {
      return;
    }

    if (!operationResult) {
      const detail = result.stderr.trim() || result.stdout.trim() || '管理员授权已取消或提权操作未完成。';
      throw new Error(detail);
    }

    if (!operationResult?.ok) {
      throw new Error(operationResult?.error || '提权操作失败。');
    }
  } finally {
    await cleanupLocalTempDirectory(tempDirectory);
  }
}

async function runLocalSudoCommand(args, sudoPassword, stdin = '') {
  if (!Array.isArray(args) || args.length === 0) {
    throw new Error('sudo 命令无效。');
  }

  const result = await collectChildProcessOutput(spawn('sudo', [
    '-S',
    '-p',
    '',
    '--',
    ...args,
  ], {
    cwd: getLocalHomeDirectory(),
    env: process.env,
  }), `${sudoPassword ?? ''}\n${stdin}`);

  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `sudo 命令失败，退出码 ${result.code}`);
  }

  return result;
}

async function runLocalSudoShell(script, args, options = {}, stdin = '') {
  if (!hasSudoPasswordOption(options)) {
    throw new Error('需要 sudo 密码才能完成本地提权操作。');
  }

  return runLocalSudoCommand(['/bin/sh', '-c', script, 'shelldesk', ...args], options.sudoPassword ?? '', stdin);
}

async function runWithLocalElevation(action, elevatedAction, options = {}) {
  try {
    return await action();
  } catch (error) {
    if (!isLocalPermissionError(error)) {
      throw error;
    }

    if (process.platform === 'win32' || hasSudoPasswordOption(options)) {
      return elevatedAction();
    }

    throw error;
  }
}

function isMutableLocalPath(localPath) {
  if (!localPath || localPath === '/' || localPath === getLocalHomeDirectory()) {
    return false;
  }

  if (process.platform === 'win32' && /^[a-z]:\\?$/i.test(localPath)) {
    return false;
  }

  return true;
}

function toLocalEntryType(stats) {
  if (stats.isSymbolicLink()) {
    return 'symlink';
  }

  if (stats.isDirectory()) {
    return 'directory';
  }

  return 'file';
}

function shouldSkipLocalDirectoryEntryError(error) {
  return ['EACCES', 'ENOENT', 'EPERM', 'EBUSY'].includes(error?.code);
}

async function getLocalSymlinkTargetType(localPath) {
  try {
    const stats = await fs.promises.stat(localPath);
    if (stats.isDirectory()) {
      if (process.platform === 'win32') {
        try {
          const directory = await fs.promises.opendir(localPath);
          await directory.close();
        } catch {
          return 'unknown';
        }
      }

      return 'directory';
    }
    if (stats.isFile()) {
      return 'file';
    }
  } catch {
    return 'unknown';
  }

  return 'unknown';
}

async function getLocalSymlinkTargetPath(localPath) {
  try {
    return await fs.promises.readlink(localPath);
  } catch {
    return '';
  }
}

async function createLocalDirectoryReadError(localPath, error) {
  if (process.platform !== 'win32' || !['EACCES', 'EPERM'].includes(error?.code)) {
    return error;
  }

  try {
    const stats = await fs.promises.lstat(localPath);
    if (!stats.isSymbolicLink()) {
      return error;
    }
  } catch {
    return error;
  }

  const targetPath = await getLocalSymlinkTargetPath(localPath);
  const targetHint = targetPath ? `请直接打开目标路径：${toDisplayPath(targetPath)}。` : '请改为打开它指向的真实目录。';

  return new Error(`无法打开 Windows 兼容性目录链接：${toDisplayPath(localPath)}。${targetHint}`);
}

async function readLocalDirectoryEntry(localPath, dirent) {
  const pathModule = getPathModuleForLocal();
  const entryPath = pathModule.join(localPath, dirent.name);

  try {
    const entryStats = await fs.promises.lstat(entryPath);
    const type = toLocalEntryType(entryStats);
    const targetPath = type === 'symlink' ? await getLocalSymlinkTargetPath(entryPath) : '';

    return {
      name: dirent.name,
      longname: dirent.name,
      type,
      ...(type === 'symlink' ? {
        targetType: await getLocalSymlinkTargetType(entryPath),
        ...(targetPath ? { targetPath: toDisplayPath(targetPath) } : {}),
      } : {}),
      size: entryStats.isFile() ? entryStats.size : 0,
      modifiedAt: new Date(entryStats.mtimeMs).toISOString(),
    };
  } catch (error) {
    if (shouldSkipLocalDirectoryEntryError(error)) {
      return null;
    }

    throw error;
  }
}

async function listWindowsDriveRoots() {
  const entries = [];

  await Promise.all('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(async (letter) => {
    const drivePath = `${letter}:\\`;
    try {
      const stats = await fs.promises.stat(drivePath);
      if (stats.isDirectory()) {
        entries.push({
          name: `${letter}:`,
          longname: `${letter}:\\`,
          type: 'directory',
          size: 0,
          modifiedAt: new Date(stats.mtimeMs).toISOString(),
        });
      }
    } catch {
      // Ignore missing drive letters.
    }
  }));

  entries.sort((first, second) => first.name.localeCompare(second.name, 'zh-CN', { numeric: true }));
  return { path: '/', entries };
}

async function listLocalDirectory(rawPath) {
  const localPath = normalizeLocalPath(rawPath);

  if (process.platform === 'win32' && localPath === '/') {
    return listWindowsDriveRoots();
  }

  const stats = await fs.promises.stat(localPath);
  if (!stats.isDirectory()) {
    throw new Error('本地路径不是目录。');
  }

  let dirents;
  try {
    dirents = await fs.promises.readdir(localPath, { withFileTypes: true });
  } catch (error) {
    throw await createLocalDirectoryReadError(localPath, error);
  }

  const entries = (await Promise.all(dirents.map((dirent) => readLocalDirectoryEntry(localPath, dirent))))
    .filter(Boolean);

  return {
    path: toDisplayPath(localPath),
    entries,
  };
}

function getWindowsElevatedPathLiteral(localPath) {
  return quotePowerShellString(path.win32.normalize(localPath));
}

async function createLocalDirectoryElevated(localPath, options = {}) {
  if (process.platform === 'win32') {
    await runWindowsElevatedPowerShell(`
New-Item -ItemType Directory -LiteralPath ${getWindowsElevatedPathLiteral(localPath)} -ErrorAction Stop | Out-Null
`);
    return;
  }

  await runLocalSudoShell('mkdir "$1"', [localPath], options);
}

async function createLocalFileElevated(localPath, options = {}) {
  if (process.platform === 'win32') {
    await runWindowsElevatedPowerShell(`
if (Test-Path -LiteralPath ${getWindowsElevatedPathLiteral(localPath)}) {
  throw '文件已存在。'
}
New-Item -ItemType File -LiteralPath ${getWindowsElevatedPathLiteral(localPath)} -ErrorAction Stop | Out-Null
`);
    return;
  }

  await runLocalSudoShell('set -C; : > "$1"', [localPath], options);
}

async function deleteLocalPathElevated(localPath, entryType, options = {}) {
  if (process.platform === 'win32') {
    const recurse = entryType === 'directory' ? '-Recurse' : '';
    await runWindowsElevatedPowerShell(`
Remove-Item -LiteralPath ${getWindowsElevatedPathLiteral(localPath)} -Force ${recurse} -ErrorAction Stop
`);
    return;
  }

  await runLocalSudoShell(entryType === 'directory' ? 'rm -rf "$1"' : 'rm -f "$1"', [localPath], options);
}

async function renameLocalPathElevated(oldPath, newPath, options = {}) {
  if (process.platform === 'win32') {
    await runWindowsElevatedPowerShell(`
Move-Item -LiteralPath ${getWindowsElevatedPathLiteral(oldPath)} -Destination ${getWindowsElevatedPathLiteral(newPath)} -ErrorAction Stop
`);
    return;
  }

  await runLocalSudoShell('mv "$1" "$2"', [oldPath, newPath], options);
}

async function readLocalTextFileElevated(localPath, options = {}) {
  if (process.platform === 'win32') {
    const tempDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'shelldesk-read-'));
    const tempFile = path.join(tempDirectory, path.basename(localPath) || 'file.txt');

    try {
      await runWindowsElevatedPowerShell(`
if (-not (Test-Path -LiteralPath ${getWindowsElevatedPathLiteral(localPath)} -PathType Leaf)) {
  throw '只能用记事本打开本地文件。'
}
Copy-Item -LiteralPath ${getWindowsElevatedPathLiteral(localPath)} -Destination ${quotePowerShellString(tempFile)} -Force -ErrorAction Stop
`);
      const stats = await fs.promises.stat(tempFile);
      if (stats.size > maxRemoteTextFileBytes) {
        throw new Error(`文件超过 ${Math.round(maxRemoteTextFileBytes / 1024 / 1024)} MB，请用本地编辑器打开。`);
      }

      return fs.promises.readFile(tempFile, 'utf8');
    } finally {
      await cleanupLocalTempDirectory(tempDirectory);
    }
  }

  const result = await runLocalSudoShell('test -f "$1" && cat "$1"', [localPath], options);
  if (Buffer.byteLength(result.stdout, 'utf8') > maxRemoteTextFileBytes) {
    throw new Error(`文件超过 ${Math.round(maxRemoteTextFileBytes / 1024 / 1024)} MB，请用本地编辑器打开。`);
  }

  return result.stdout;
}

async function writeLocalTextFileElevated(localPath, content, options = {}) {
  const tempDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'shelldesk-write-'));
  const tempFile = path.join(tempDirectory, 'content.txt');

  try {
    await fs.promises.writeFile(tempFile, content, 'utf8');

    if (process.platform === 'win32') {
      await runWindowsElevatedPowerShell(`
Copy-Item -LiteralPath ${quotePowerShellString(tempFile)} -Destination ${getWindowsElevatedPathLiteral(localPath)} -Force -ErrorAction Stop
`);
      return;
    }

    await runLocalSudoShell('cat "$1" > "$2"', [tempFile, localPath], options);
  } finally {
    await cleanupLocalTempDirectory(tempDirectory);
  }
}

async function setLocalPathPermissionsElevated(localPath, options = {}) {
  if (process.platform === 'win32') {
    throw new Error('Windows 本地路径权限编辑暂不支持 chmod 语义。');
  }

  await runLocalSudoShell(
    options.recursive ? 'chmod -R "$1" "$2"' : 'chmod "$1" "$2"',
    [options.mode.toString(8), localPath],
    options,
  );
}

function assertMutableLocalPath(localPath) {
  if (!isMutableLocalPath(localPath)) {
    throw new Error('不允许对该本地路径执行管理操作。');
  }
}

async function createLocalDirectory(rawPath, options = {}) {
  const localPath = normalizeLocalPath(rawPath);
  assertMutableLocalPath(localPath);
  await runWithLocalElevation(
    () => fs.promises.mkdir(localPath, { recursive: false }),
    () => createLocalDirectoryElevated(localPath, options),
    options,
  );
  return true;
}

async function createLocalFile(rawPath, options = {}) {
  const localPath = normalizeLocalPath(rawPath);
  assertMutableLocalPath(localPath);
  await runWithLocalElevation(async () => {
    const handle = await fs.promises.open(localPath, 'wx');
    await handle.close();
  }, () => createLocalFileElevated(localPath, options), options);
  return true;
}

async function deleteLocalPath(rawPath, entryType, options = {}) {
  const localPath = normalizeLocalPath(rawPath);
  assertMutableLocalPath(localPath);

  await runWithLocalElevation(async () => {
    if (entryType === 'directory') {
      await fs.promises.rm(localPath, { recursive: true, force: false });
      return;
    }

    await fs.promises.unlink(localPath);
  }, () => deleteLocalPathElevated(localPath, entryType, options), options);
  return true;
}

async function renameLocalPath(rawOldPath, rawNewPath, options = {}) {
  const oldPath = normalizeLocalPath(rawOldPath);
  const newPath = normalizeLocalPath(rawNewPath);
  assertMutableLocalPath(oldPath);
  assertMutableLocalPath(newPath);
  await runWithLocalElevation(
    () => fs.promises.rename(oldPath, newPath),
    () => renameLocalPathElevated(oldPath, newPath, options),
    options,
  );
  return true;
}

async function statLocalPath(rawPath) {
  const localPath = normalizeLocalPath(rawPath);
  const stats = await fs.promises.lstat(localPath);
  return {
    type: toLocalEntryType(stats),
    size: stats.size,
    mode: stats.mode,
    owner: Number.isInteger(stats.uid) ? stats.uid : 0,
    group: Number.isInteger(stats.gid) ? stats.gid : 0,
    modifiedAt: new Date(stats.mtimeMs).toISOString(),
    accessedAt: new Date(stats.atimeMs).toISOString(),
  };
}

async function readLocalTextFile(rawPath, options = {}) {
  const localPath = normalizeLocalPath(rawPath);
  return runWithLocalElevation(async () => {
    const stats = await fs.promises.stat(localPath);

    if (!stats.isFile()) {
      throw new Error('只能用记事本打开本地文件。');
    }

    if (stats.size > maxRemoteTextFileBytes) {
      throw new Error(`文件超过 ${Math.round(maxRemoteTextFileBytes / 1024 / 1024)} MB，请用本地编辑器打开。`);
    }

    return fs.promises.readFile(localPath, 'utf8');
  }, () => readLocalTextFileElevated(localPath, options), options);
}

async function writeLocalTextFile(rawPath, content, options = {}) {
  if (Buffer.byteLength(content, 'utf8') > maxRemoteTextWriteBytes) {
    throw new Error(`文件内容超过 ${Math.round(maxRemoteTextWriteBytes / 1024 / 1024)} MB，请使用本地编辑器保存大文件。`);
  }

  const localPath = normalizeLocalPath(rawPath);
  assertMutableLocalPath(localPath);
  await runWithLocalElevation(
    () => fs.promises.writeFile(localPath, content, 'utf8'),
    () => writeLocalTextFileElevated(localPath, content, options),
    options,
  );
  return true;
}

async function setLocalPathPermissions(rawPath, options) {
  const localPath = normalizeLocalPath(rawPath);
  assertMutableLocalPath(localPath);
  await runWithLocalElevation(
    () => fs.promises.chmod(localPath, options.mode),
    () => setLocalPathPermissionsElevated(localPath, options),
    options,
  );
  return true;
}

function getCommandShellArgs(command) {
  if (process.platform === 'win32') {
    return {
      file: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `chcp 65001>nul & ${command}`],
    };
  }

  return {
    file: process.env.SHELL || '/bin/sh',
    args: ['-lc', command],
  };
}

function runLocalCommand(rawCommand, stdin = '', callbacks = {}) {
  const command = readBoundedString(rawCommand, '命令', 256 * 1024, { rejectLineBreaks: false });
  const shell = getCommandShellArgs(command);

  return new Promise((resolve, reject) => {
    const child = spawn(shell.file, shell.args, {
      cwd: getLocalHomeDirectory(),
      env: {
        ...process.env,
        TERM: process.env.TERM || 'xterm-256color',
        COLORTERM: process.env.COLORTERM || 'truecolor',
      },
      windowsHide: true,
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    const stdoutDecoder = createLocalOutputDecoder();
    const stderrDecoder = createLocalOutputDecoder();
    const shouldCleanCliXml = process.platform === 'win32';
    const stdoutCleaner = shouldCleanCliXml ? createPowerShellCliXmlStreamCleaner() : null;
    const stderrCleaner = shouldCleanCliXml ? createPowerShellCliXmlStreamCleaner() : null;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const appendChunk = (chunks, chunk, streamName) => {
      const buffer = Buffer.from(chunk);
      if (streamName === 'stderr') {
        stderrBytes += buffer.length;
      } else {
        stdoutBytes += buffer.length;
      }

      if (stdoutBytes + stderrBytes <= maxLocalCommandOutputBytes) {
        chunks.push(buffer);
      }

      const decoder = streamName === 'stderr' ? stderrDecoder : stdoutDecoder;
      const cleaner = streamName === 'stderr' ? stderrCleaner : stdoutCleaner;
      const decodedText = decoder.decode(buffer);
      const outputText = cleaner ? cleaner.push(decodedText) : decodedText;

      if (outputText) {
        callbacks.onChunk?.(outputText, streamName);
      }
    };

    const flushChunkCleaner = (streamName) => {
      const cleaner = streamName === 'stderr' ? stderrCleaner : stdoutCleaner;
      const outputText = cleaner ? cleaner.push('', true) : '';

      if (outputText) {
        callbacks.onChunk?.(outputText, streamName);
      }
    };

    const finish = (callback) => {
      if (settled) {
        return;
      }

      settled = true;
      callback();
    };

    child.stdout.on('data', (chunk) => appendChunk(stdoutChunks, chunk, 'stdout'));
    child.stderr.on('data', (chunk) => appendChunk(stderrChunks, chunk, 'stderr'));
    child.once('error', (error) => finish(() => reject(error)));
    child.once('close', (code) => finish(() => {
      flushChunkCleaner('stdout');
      flushChunkCleaner('stderr');

      const truncated = stdoutBytes + stderrBytes > maxLocalCommandOutputBytes
        ? '\n[SHELLDESK] 输出超过限制，已截断。'
        : '';
      resolve({
        stdout: `${decodeLocalOutputBuffer(Buffer.concat(stdoutChunks))}${truncated}`,
        stderr: decodeLocalOutputBuffer(Buffer.concat(stderrChunks)),
        code: Number.isInteger(code) ? code : 0,
      });
    }));

    if (stdin) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

function getLocalTerminalShell() {
  if (process.platform === 'win32') {
    const startupCommand = [
      "try { Remove-Module PSReadLine -ErrorAction SilentlyContinue } catch {}",
      "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)",
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
      "$OutputEncoding = [Console]::OutputEncoding",
    ].join('; ');

    return {
      file: 'powershell.exe',
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NoExit',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        startupCommand,
      ],
    };
  }

  return {
    file: process.env.SHELL || '/bin/sh',
    args: ['-l'],
  };
}

function sendLocalPtyData(sender, connectionId, terminalId, data, sendTerminalData, cleaner = null) {
  if (Buffer.isBuffer(data)) {
    if (cleaner) {
      sendLocalTerminalText(sender, connectionId, terminalId, data.toString('utf8'), cleaner);
      return;
    }

    sendTerminalData(sender, connectionId, terminalId, data);
    return;
  }

  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    if (cleaner) {
      sendLocalTerminalText(sender, connectionId, terminalId, Buffer.from(data).toString('utf8'), cleaner);
      return;
    }

    sendTerminalData(sender, connectionId, terminalId, Buffer.from(data));
    return;
  }

  sendLocalTerminalText(sender, connectionId, terminalId, String(data || ''), cleaner);
}

function createLocalTerminalSession(ptyProcess) {
  let closed = false;
  const disposables = [];
  const session = {
    get destroyed() {
      return closed || Boolean(ptyProcess.killed);
    },
    write(data) {
      if (!closed) {
        ptyProcess.write(data);
      }
    },
    setWindow(rows, columns) {
      if (!closed && Number.isInteger(columns) && Number.isInteger(rows)) {
        ptyProcess.resize(columns, rows);
      }
    },
    end() {
      session.dispose();
    },
    dispose() {
      if (closed || ptyProcess.killed) {
        return;
      }

      closed = true;
      while (disposables.length) {
        disposables.pop()?.dispose?.();
      }
      try {
        ptyProcess.kill();
      } catch {
        // Ignore stale PTY cleanup errors.
      }
    },
    on(eventName, handler) {
      if (eventName === 'exit' || eventName === 'close') {
        const disposable = ptyProcess.onExit((event) => handler(event.exitCode, event.signal));
        disposables.push(disposable);
      }
      return session;
    },
    removeAllListeners() {
      while (disposables.length) {
        disposables.pop()?.dispose?.();
      }
    },
    addDisposable(disposable) {
      disposables.push(disposable);
    },
    markClosed() {
      closed = true;
    },
  };

  return session;
}

async function startLocalTerminal(activeConnection, terminalId, columns, rows, sender, sendTerminalData) {
  const existingSession = activeConnection.terminalSessions.get(terminalId);

  if (existingSession && !existingSession.destroyed) {
    return true;
  }

  const pty = loadNodePty();
  const shell = getLocalTerminalShell();
  const ptyProcess = pty.spawn(shell.file, shell.args, {
    name: 'xterm-256color',
    cols: columns,
    rows,
    cwd: getLocalHomeDirectory(),
    env: {
      ...process.env,
      TERM: process.env.TERM || 'xterm-256color',
      COLORTERM: process.env.COLORTERM || 'truecolor',
    },
    ...(process.platform === 'win32' ? {} : { encoding: null }),
  });
  const terminalSession = createLocalTerminalSession(ptyProcess);
  const outputCleaner = process.platform === 'win32'
    ? createPowerShellCliXmlStreamCleaner({ preservePlainTextWhitespace: true })
    : null;
  let exitCode = null;
  let exitSignal = null;
  let closed = false;

  const closeTerminal = () => {
    if (closed) {
      return;
    }

    closed = true;
    if (outputCleaner) {
      sendLocalTerminalText(sender, activeConnection.id, terminalId, '', outputCleaner, true);
    }

    if (activeConnection.terminalSessions.get(terminalId) === terminalSession) {
      activeConnection.terminalSessions.delete(terminalId);
    }

    if (!sender.isDestroyed()) {
      sender.send('terminal:exit', { connectionId: activeConnection.id, terminalId, code: exitCode, signal: exitSignal });
    }
  };

  const dataDisposable = ptyProcess.onData((data) => {
    sendLocalPtyData(sender, activeConnection.id, terminalId, data, sendTerminalData, outputCleaner);
  });
  const exitDisposable = ptyProcess.onExit((event) => {
    terminalSession.markClosed();
    exitCode = Number.isInteger(event.exitCode) ? event.exitCode : null;
    exitSignal = Number.isInteger(event.signal) ? String(event.signal) : null;
    terminalSession.removeAllListeners();
    closeTerminal();
  });
  terminalSession.addDisposable(dataDisposable);
  terminalSession.addDisposable(exitDisposable);

  activeConnection.terminalSessions.set(terminalId, terminalSession);
  return true;
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${days} 天 ${hours} 小时 ${minutes} 分钟`;
}

function formatBytes(value) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let nextValue = Math.max(0, Number(value) || 0);
  let unitIndex = 0;

  while (nextValue >= 1024 && unitIndex < units.length - 1) {
    nextValue /= 1024;
    unitIndex += 1;
  }

  return `${nextValue.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function getLocalDiskInfo() {
  try {
    if (typeof fs.statfsSync !== 'function') {
      return process.cwd();
    }

    const stats = fs.statfsSync(process.cwd());
    const total = Number(stats.blocks) * Number(stats.bsize);
    const free = Number(stats.bfree) * Number(stats.bsize);

    if (!Number.isFinite(total) || total <= 0) {
      return process.cwd();
    }

    return `${process.cwd()} - Total: ${formatBytes(total)}, Free: ${formatBytes(free)}`;
  } catch {
    return process.cwd();
  }
}

async function getLocalStatus() {
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  return {
    refreshedAt: new Date().toISOString(),
    items: [
      { key: 'hostname', label: '主机名', value: os.hostname() || 'localhost' },
      { key: 'user', label: '当前用户', value: getLocalUsername() },
      { key: 'kernel', label: '系统版本', value: getLocalSystemName() },
      { key: 'uptime', label: '运行时间', value: formatDuration(os.uptime()) },
      { key: 'disk', label: '工作目录', value: process.cwd() },
      { key: 'memory', label: '内存', value: `Total: ${formatBytes(totalMemory)}, Used: ${formatBytes(totalMemory - freeMemory)}, Free: ${formatBytes(freeMemory)}` },
      { key: 'network', label: '网络接口', value: Object.keys(os.networkInterfaces()).join(', ') || 'unavailable' },
    ],
  };
}

async function getLocalSystemInfo() {
  const cpus = os.cpus();
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  return {
    refreshedAt: new Date().toISOString(),
    items: [
      { key: 'os', label: '操作系统', icon: '\u{1F5A5}\uFE0F', value: getLocalSystemName() },
      { key: 'kernel', label: '内核版本', icon: '\u2699\uFE0F', value: os.release() },
      { key: 'hostname', label: '主机名', icon: '\u{1F3E0}', value: os.hostname() || 'localhost' },
      { key: 'arch', label: '系统架构', icon: '\u{1F9E9}', value: `${os.platform()} ${os.arch()}` },
      { key: 'cpu', label: 'CPU', icon: '\u{1F4BB}', value: `${cpus[0]?.model || '未检测到'}；逻辑核心 ${cpus.length || 0}` },
      { key: 'memory', label: '内存', icon: '\u{1F9E0}', value: `已用 ${formatBytes(totalMemory - freeMemory)} / 总计 ${formatBytes(totalMemory)}，空闲 ${formatBytes(freeMemory)}` },
      { key: 'disk', label: '磁盘', icon: '\u{1F4BD}', value: getLocalDiskInfo() },
      { key: 'uptime', label: '运行时间', icon: '\u23F1\uFE0F', value: formatDuration(os.uptime()) },
      { key: 'load', label: '系统负载', icon: '\u26A1', value: os.loadavg().map((value) => value.toFixed(2)).join(', ') },
      { key: 'shell', label: '默认 Shell', icon: '\u{1F4BB}', value: process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : (process.env.SHELL || '/bin/sh') },
      { key: 'user', label: '当前用户', icon: '\u{1F464}', value: getLocalUsername() },
      { key: 'locale', label: '系统语言', icon: '\u{1F30D}', value: Intl.DateTimeFormat().resolvedOptions().locale || process.env.LANG || 'unknown' },
      { key: 'timezone', label: '时区', icon: '\u{1F30D}', value: Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown' },
      { key: 'gpu', label: 'GPU', icon: '\u{1F3AE}', value: '未检测' },
      { key: 'virt', label: '硬件型号', icon: '\u{1F4EB}', value: os.machine ? os.machine() : os.arch() },
      { key: 'boot', label: '启动模式', icon: '\u{1F504}', value: '本地系统' },
    ],
  };
}

function getCpuTimesSnapshot() {
  return os.cpus().reduce((total, cpu) => {
    total.idle += cpu.times.idle;
    total.total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
    return total;
  }, { idle: 0, total: 0 });
}

async function getLocalMetrics() {
  const first = getCpuTimesSnapshot();
  await new Promise((resolve) => setTimeout(resolve, 120));
  const second = getCpuTimesSnapshot();
  const totalDelta = second.total - first.total;
  const idleDelta = second.idle - first.idle;
  const cpuPercent = totalDelta > 0 ? Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100)) : null;
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();

  return {
    refreshedAt: new Date().toISOString(),
    cpuPercent: cpuPercent === null ? null : Number(cpuPercent.toFixed(1)),
    memoryPercent: totalMemory > 0 ? Number((((totalMemory - freeMemory) / totalMemory) * 100).toFixed(1)) : null,
    netRxBytes: null,
    netTxBytes: null,
  };
}

function createTransferPayload(connectionId, queueId, clientId, type, fileName, transferred, total, completedItems, totalItems) {
  return {
    connectionId,
    queueId,
    ...(clientId ? { clientId } : {}),
    type,
    fileName,
    transferred,
    total,
    currentFileTransferred: transferred,
    currentFileTotal: total,
    completedFiles: completedItems,
    totalFiles: totalItems,
    completedItems,
    totalItems,
  };
}

function sendTransferEvent(sender, channel, payload) {
  if (sender && !sender.isDestroyed()) {
    sender.send(channel, payload);
  }
}

async function collectCopyPlan(sourcePath, destPath, plan) {
  if (plan.length > maxLocalTransferItems) {
    throw new Error(`传输项目超过 ${maxLocalTransferItems} 项，请分批操作。`);
  }

  const stats = await fs.promises.lstat(sourcePath);

  if (stats.isDirectory()) {
    plan.push({ type: 'directory', sourcePath, destPath, size: 0 });
    const entries = await fs.promises.readdir(sourcePath);
    const pathModule = getPathModuleForLocal();
    for (const entry of entries) {
      await collectCopyPlan(pathModule.join(sourcePath, entry), pathModule.join(destPath, entry), plan);
    }
    return plan;
  }

  plan.push({ type: 'file', sourcePath, destPath, size: stats.isFile() ? stats.size : 0 });
  return plan;
}

async function copyPlanEntries(connectionId, sender, type, plan, options = {}) {
  const queueId = `local-transfer-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const clientId = typeof options.transferClientId === 'string' ? options.transferClientId : '';
  const total = plan.reduce((sum, item) => sum + item.size, 0);
  let transferred = 0;
  let completedItems = 0;
  let currentFileName = type === 'download' ? '准备下载...' : '准备上传...';
  let canceled = false;

  activeLocalTransfers.set(queueId, {
    connectionId,
    cancel: () => {
      canceled = true;
    },
  });

  const sendProgress = () => {
    sendTransferEvent(sender, 'transfer:progress', createTransferPayload(
      connectionId,
      queueId,
      clientId,
      type,
      currentFileName,
      transferred,
      total,
      completedItems,
      plan.length,
    ));
  };

  try {
    sendProgress();
    for (const item of plan) {
      if (canceled) {
        throw new Error('传输已取消。');
      }

      currentFileName = path.basename(item.sourcePath) || item.sourcePath;

      if (item.type === 'directory') {
        await fs.promises.mkdir(item.destPath, { recursive: true });
      } else {
        await fs.promises.mkdir(path.dirname(item.destPath), { recursive: true });
        await fs.promises.copyFile(item.sourcePath, item.destPath);
        transferred += item.size;
      }

      completedItems += 1;
      sendProgress();
    }

    sendTransferEvent(sender, 'transfer:end', {
      ...createTransferPayload(connectionId, queueId, clientId, type, currentFileName, transferred, total, completedItems, plan.length),
      success: true,
    });

    return {
      canceled: false,
      size: transferred,
      fileCount: plan.filter((item) => item.type === 'file').length,
      itemCount: plan.length,
    };
  } catch (error) {
    sendTransferEvent(sender, 'transfer:end', {
      ...createTransferPayload(connectionId, queueId, clientId, type, currentFileName, transferred, total, completedItems, plan.length),
      success: false,
      error: toErrorMessage(error),
    });
    throw error;
  } finally {
    if (activeLocalTransfers.get(queueId)?.connectionId === connectionId) {
      activeLocalTransfers.delete(queueId);
    }
  }
}

async function copyLocalDownload(connectionId, sender, rawRemotePaths, destinationPath, fileOnly = false, options = {}) {
  const pathModule = getPathModuleForLocal();
  const plan = [];

  for (const rawRemotePath of rawRemotePaths) {
    const sourcePath = normalizeLocalPath(rawRemotePath);
    const destination = fileOnly
      ? destinationPath
      : pathModule.join(destinationPath, pathModule.basename(sourcePath));
    await collectCopyPlan(sourcePath, destination, plan);
  }

  return copyPlanEntries(connectionId, sender, 'download', plan, options);
}

async function copyLocalUpload(connectionId, sender, rawItems, rawTargetPath, options = {}) {
  const targetPath = normalizeLocalPath(rawTargetPath);
  const targetStats = await fs.promises.stat(targetPath);
  if (!targetStats.isDirectory()) {
    throw new Error('本地上传目标不是目录。');
  }

  const pathModule = getPathModuleForLocal();
  const plan = [];
  for (const item of rawItems) {
    const localPath = readBoundedString(item.localPath || item.path, '本地路径', 4096);
    const sourcePath = pathModule.normalize(localPath);
    const remoteName = item.remoteName || pathModule.basename(sourcePath);
    await collectCopyPlan(sourcePath, pathModule.join(targetPath, remoteName), plan);
  }

  return copyPlanEntries(connectionId, sender, 'upload', plan, options);
}

function cancelLocalTransfer(connectionId, queueId = '') {
  if (queueId) {
    const transfer = activeLocalTransfers.get(queueId);

    if (!transfer || transfer.connectionId !== connectionId) {
      return false;
    }

    transfer.cancel();
    return true;
  }

  let canceled = false;
  for (const transfer of activeLocalTransfers.values()) {
    if (transfer.connectionId === connectionId) {
      transfer.cancel();
      canceled = true;
    }
  }

  return canceled;
}

module.exports = {
  cancelLocalTransfer,
  copyLocalDownload,
  copyLocalUpload,
  createLocalClient,
  createLocalDisplayHost,
  getLocalMetrics,
  getLocalStatus,
  getLocalSystemInfo,
  isLocalConnection,
  listLocalDirectory,
  createLocalDirectory,
  createLocalFile,
  deleteLocalPath,
  readLocalTextFile,
  renameLocalPath,
  runLocalCommand,
  setLocalPathPermissions,
  startLocalTerminal,
  statLocalPath,
  writeLocalTextFile,
};
