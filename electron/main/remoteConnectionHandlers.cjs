const { BrowserWindow, dialog } = require('electron');
const fs = require('node:fs');
const { TextDecoder } = require('node:util');
const {
  maxRemoteCommandInputLength,
  maxRemoteCommandLength,
  maxRemoteTextFileBytes,
  maxRemoteTextWriteBytes,
} = require('./constants.cjs');
const { getActiveConnection } = require('./connectionManager.cjs');
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
const maxDirectorySymlinkTargetStats = 80;
const remoteEntryCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

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

            resolve(listedEntries.sort((left, right) => {
              const leftSortType = left.type === 'symlink' && left.targetType === 'directory' ? 'directory' : left.type;
              const rightSortType = right.type === 'symlink' && right.targetType === 'directory' ? 'directory' : right.type;

              if (leftSortType === rightSortType) {
                return remoteEntryCollator.compare(left.name, right.name);
              }

              return leftSortType === 'directory' ? -1 : 1;
            }));
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

const unixSystemInfoItems = [
  { key: 'os', label: '操作系统', icon: '\u{1F5A5}\uFE0F', command: 'cat /etc/os-release 2>/dev/null | grep -E "^PRETTY_NAME|^NAME|^VERSION" | head -5 || uname -s' },
  { key: 'kernel', label: '内核版本', icon: '\u2699\uFE0F', command: 'uname -r' },
  { key: 'hostname', label: '主机名', icon: '\u{1F3E0}', command: 'hostname -f 2>/dev/null || hostname' },
  { key: 'arch', label: '系统架构', icon: '\u{1F9E9}', command: 'uname -m' },
  { key: 'cpu', label: 'CPU', icon: '\u{1F4BB}', command: 'lscpu 2>/dev/null | grep -E "^Model name|^Socket|^Core|^Thread|^CPU\\(s\\):" | head -6 || cat /proc/cpuinfo 2>/dev/null | grep "model name" | head -1' },
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
    return buffer.toString('utf16le');
  }

  const utf8Text = buffer.toString('utf8');

  if (!utf8Text.includes('\uFFFD')) {
    return utf8Text;
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

  return bestText;
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

function registerRemoteConnectionHandlers(registerIpcHandler) {
  registerIpcHandler('connection:start-terminal', async (event, connectionId, rawTerminalId, rawColumns, rawRows, rawLaunchOptions) => {
    const activeConnection = getActiveConnection(connectionId);
    const terminalId = validateTerminalId(rawTerminalId);
    const columns = Number(rawColumns) || 100;
    const rows = Number(rawRows) || 30;
    const launchOptions = readTerminalLaunchOptions(rawLaunchOptions);

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
        const closeTerminalStream = () => {
          if (streamClosed) {
            return;
          }

          streamClosed = true;

          if (activeConnection.terminalSessions.get(terminalId) === stream) {
            activeConnection.terminalSessions.delete(terminalId);
          }

          if (!event.sender.isDestroyed()) {
            event.sender.send('terminal:exit', { connectionId, terminalId, code: exitCode, signal: exitSignal });
          }
        };

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
        stream.once('exit', (code, signal) => {
          exitCode = Number.isInteger(code) ? code : null;
          exitSignal = typeof signal === 'string' ? signal : null;
        });
        stream.once('error', closeTerminalStream);
        stream.once('close', closeTerminalStream);
        const startupInput = createTerminalStartupInput(launchOptions, activeConnection.displayHost.systemType);

        if (startupInput) {
          stream.write(startupInput);
        }

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
      terminalStream.on('error', () => undefined);
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

  registerIpcHandler('connection:set-path-permissions', async (_event, connectionId, rawPath, rawOptions) => {
    const activeConnection = getActiveConnection(connectionId);
    const remotePath = validateMutableRemotePath(rawPath);
    const options = readPathPermissionOptions(rawOptions);
    await chmodRemotePath(activeConnection.client, remotePath, options.mode, options.recursive);
    return true;
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

        const fileName = getRemoteFileName(remotePath);
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
    const remoteFileName = getRemoteFileName(remotePath);
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
    const destPath = joinRemoteChildPath(currentPath, fileName);
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
    return getRemoteStatus(activeConnection.client, activeConnection.displayHost.systemType);
  });

  registerIpcHandler('connection:get-system-info', async (_event, connectionId) => {
    const activeConnection = getActiveConnection(connectionId);
    return getRemoteSystemInfo(activeConnection.client, activeConnection.displayHost.systemType);
  });

  registerIpcHandler('connection:get-metrics', async (_event, connectionId) => {
    const activeConnection = getActiveConnection(connectionId);
    return getRemoteMetrics(activeConnection.client, activeConnection.displayHost.systemType);
  });

  registerIpcHandler('connection:run-command', async (_event, connectionId, rawCommand, rawStdin) => {
    const activeConnection = getActiveConnection(connectionId);
    const command = readBoundedString(rawCommand, '命令', maxRemoteCommandLength, { rejectLineBreaks: false });
    const stdin = typeof rawStdin === 'string'
      ? readBoundedString(rawStdin, '命令输入', maxRemoteCommandInputLength, { required: false, trim: false, rejectLineBreaks: false })
      : '';
    return execRemoteCommandRaw(activeConnection.client, command, stdin);
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
      await execSshCommand(activeConnection.client, command);
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

    await execSshCommand(activeConnection.client, command);
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
      await execSshCommand(activeConnection.client, command);
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

    await execSshCommand(activeConnection.client, command);
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
