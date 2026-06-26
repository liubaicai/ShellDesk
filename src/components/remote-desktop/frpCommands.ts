import { powershellSingleQuote, powershellStdinCommand, type RemoteCommandInput } from './remoteSystem';
import { shellSingleQuote } from './shellUtils';
import type { FrpcConfig, FrpcProxy } from './frpTypes';

const FRP_VERSION = '0.61.1';
const LINUX_CONFIG_PATH = '/etc/frp/frpc.toml';
const MACOS_CONFIG_PATH = '/usr/local/etc/frp/frpc.toml';
const WINDOWS_CONFIG_PATH = '%USERPROFILE%\\.frp\\frpc.toml';

function command(value: string): RemoteCommandInput {
  return { command: value };
}

function isLikelyWindowsPath(path: string) {
  return /^%USERPROFILE%/i.test(path) || /^[a-z]:\\/i.test(path) || path.includes('\\');
}

function configPathOrDefault(isWindows: boolean, configPath?: string) {
  const trimmed = configPath?.trim();
  return trimmed || (isWindows ? WINDOWS_CONFIG_PATH : LINUX_CONFIG_PATH);
}

function windowsPathAssignment(configPath: string) {
  const pathExpression = configPath.replace(/^%USERPROFILE%/i, '$env:USERPROFILE');
  return `$path = ${powershellSingleQuote(pathExpression)} -replace '^\\$env:USERPROFILE', $env:USERPROFILE`;
}

function tomlString(value: string) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function tomlArray(values: string[]) {
  return `[${values.map(tomlString).join(', ')}]`;
}

function encodeUtf8Base64(value: string) {
  return btoa(unescape(encodeURIComponent(value)));
}

function appendOptionalBoolean(lines: string[], key: keyof FrpcProxy, proxy: FrpcProxy) {
  const value = proxy[key];
  if (typeof value === 'boolean') {
    lines.push(`${key} = ${value ? 'true' : 'false'}`);
  }
}

export function generateFrpcToml(config: FrpcConfig) {
  const lines = [
    `serverAddr = ${tomlString(config.server.serverAddr)}`,
    `serverPort = ${Number.isFinite(config.server.serverPort) ? config.server.serverPort : 7000}`,
  ];

  if (config.server.token.trim()) {
    lines.push(`auth.token = ${tomlString(config.server.token)}`);
  }

  for (const proxy of config.proxies) {
    lines.push('', '[[proxies]]');
    lines.push(`name = ${tomlString(proxy.name)}`);
    lines.push(`type = ${tomlString(proxy.type)}`);
    lines.push(`localIP = ${tomlString(proxy.localIP || '127.0.0.1')}`);
    lines.push(`localPort = ${Number.isFinite(proxy.localPort) ? proxy.localPort : 0}`);

    if (typeof proxy.remotePort === 'number' && Number.isFinite(proxy.remotePort)) {
      lines.push(`remotePort = ${proxy.remotePort}`);
    }
    if (proxy.customDomains?.length) {
      lines.push(`customDomains = ${tomlArray(proxy.customDomains)}`);
    }
    if (proxy.subDomain) {
      lines.push(`subDomain = ${tomlString(proxy.subDomain)}`);
    }
    if (proxy.secretKey) {
      lines.push(`secretKey = ${tomlString(proxy.secretKey)}`);
    }
    appendOptionalBoolean(lines, 'encryption', proxy);
    appendOptionalBoolean(lines, 'compression', proxy);
    if (proxy.locations?.length) {
      lines.push(`locations = ${tomlArray(proxy.locations)}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

export function createFrpcDetectCommand(isWindows: boolean, isMac = false): RemoteCommandInput {
  if (isWindows) {
    return powershellStdinCommand(`
$frpc = Get-Command frpc -ErrorAction SilentlyContinue | Select-Object -First 1
if ($frpc) {
  "installed=true"
  "path=$($frpc.Source)"
  $version = (& frpc version 2>&1 | Select-Object -First 1).ToString()
  "version=$version"
} else {
  "installed=false"
  "version="
}
"---"
"systemd=false"
"configPath=${WINDOWS_CONFIG_PATH}"
`);
  }

  const defaultUnixConfigPath = isMac ? MACOS_CONFIG_PATH : LINUX_CONFIG_PATH;
  return command(`
if command -v frpc >/dev/null 2>&1; then
  echo "installed=true"
  echo "path=$(command -v frpc)"
  echo "version=$(frpc version 2>&1 | head -n 1)"
else
  echo "installed=false"
  echo "version="
fi
echo "---"
if command -v systemctl >/dev/null 2>&1; then
  echo "systemd=true"
  systemctl is-active frpc 2>/dev/null || true
  echo "---SERVICE---"
  systemctl cat frpc 2>/dev/null || true
else
  echo "systemd=false"
fi
echo "---CONFIG---"
if [ -f ${shellSingleQuote(defaultUnixConfigPath)} ]; then
  echo ${shellSingleQuote(defaultUnixConfigPath)}
elif [ -f /etc/frp/frpc.toml ]; then
  echo "/etc/frp/frpc.toml"
elif [ -f ./frpc.toml ]; then
  echo "./frpc.toml"
else
  echo ${shellSingleQuote(defaultUnixConfigPath)}
fi
`);
}

export function createFrpcInstallCommand(isWindows: boolean, isMac = false): RemoteCommandInput {
  if (isWindows) {
    return powershellStdinCommand(`
$version = "${FRP_VERSION}"
$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq "Arm64") { "arm64" } else { "amd64" }
$base = "frp_${FRP_VERSION}_windows_$arch"
$url = "https://github.com/fatedier/frp/releases/download/v$version/$base.zip"
$download = Join-Path $env:TEMP "$base.zip"
$extract = Join-Path $env:TEMP $base
$destDir = Join-Path $env:USERPROFILE "bin"
$dest = Join-Path $destDir "frpc.exe"
New-Item -ItemType Directory -Force -Path $destDir | Out-Null
Write-Host "Downloading $url"
Invoke-WebRequest -Uri $url -OutFile $download -UseBasicParsing
if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
Expand-Archive -Path $download -DestinationPath $env:TEMP -Force
Copy-Item (Join-Path $extract "frpc.exe") $dest -Force
if (($env:PATH -split ';') -notcontains $destDir) {
  [Environment]::SetEnvironmentVariable("PATH", "$destDir;$env:PATH", "User")
  $env:PATH = "$destDir;$env:PATH"
}
frpc version
`);
  }

  return command(`
set -e
VERSION="${FRP_VERSION}"
OS="${isMac ? 'darwin' : 'linux'}"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) FRP_ARCH="amd64" ;;
  aarch64|arm64) FRP_ARCH="arm64" ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac
BASE="frp_\${VERSION}_\${OS}_\${FRP_ARCH}"
URL="https://github.com/fatedier/frp/releases/download/v\${VERSION}/\${BASE}.tar.gz"
echo "Downloading $URL"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$URL" | tar xz -C /tmp
elif command -v wget >/dev/null 2>&1; then
  wget -qO- "$URL" | tar xz -C /tmp
else
  echo "Neither curl nor wget found." >&2
  exit 1
fi
mkdir -p /etc/frp /usr/local/bin
mv "/tmp/$BASE/frpc" /usr/local/bin/frpc
chmod +x /usr/local/bin/frpc
/usr/local/bin/frpc version
`);
}

export function createFrpcStartCommand(isWindows: boolean, serviceMode: string, configPath?: string): RemoteCommandInput {
  const resolvedConfigPath = configPathOrDefault(isWindows, configPath);
  if (isWindows) {
    return powershellStdinCommand(`
${windowsPathAssignment(resolvedConfigPath)}
Start-Process -FilePath "frpc" -ArgumentList @("-c", $path) -WindowStyle Hidden
`);
  }
  if (serviceMode === 'systemd') return command('systemctl start frpc 2>&1');
  return command(`nohup frpc -c ${shellSingleQuote(resolvedConfigPath)} > /var/log/frpc.log 2>&1 & echo $!`);
}

export function createFrpcStopCommand(isWindows: boolean, serviceMode: string, configPath?: string): RemoteCommandInput {
  if (isWindows) {
    return powershellStdinCommand('Get-Process frpc -ErrorAction SilentlyContinue | Stop-Process -Force');
  }
  if (serviceMode === 'systemd') return command('systemctl stop frpc 2>&1');
  const processPattern = `frpc -c ${configPathOrDefault(false, configPath)}`;
  return command(`pkill -f ${shellSingleQuote(processPattern)} 2>/dev/null || true`);
}

export function createFrpcRestartCommand(isWindows: boolean, serviceMode: string, configPath?: string): RemoteCommandInput {
  const resolvedConfigPath = configPathOrDefault(isWindows, configPath);
  if (isWindows) {
    return powershellStdinCommand(`
Get-Process frpc -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1
${windowsPathAssignment(resolvedConfigPath)}
Start-Process -FilePath "frpc" -ArgumentList @("-c", $path) -WindowStyle Hidden
`);
  }
  if (serviceMode === 'systemd') return command('systemctl restart frpc 2>&1');
  const processPattern = `frpc -c ${resolvedConfigPath}`;
  return command(`pkill -f ${shellSingleQuote(processPattern)} 2>/dev/null || true; nohup frpc -c ${shellSingleQuote(resolvedConfigPath)} > /var/log/frpc.log 2>&1 & echo $!`);
}

export function createFrpcStatusCommand(isWindows: boolean, serviceMode: string, configPath?: string): RemoteCommandInput {
  if (isWindows) return powershellStdinCommand('Get-Process frpc -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object { $_.Id }');
  if (serviceMode === 'systemd') return command('systemctl is-active frpc 2>/dev/null || true');
  const processPattern = `frpc -c ${configPathOrDefault(false, configPath)}`;
  return command(`pgrep -f ${shellSingleQuote(processPattern)} 2>/dev/null || true`);
}

export function createFrpcLogsCommand(isWindows: boolean, serviceMode: string, lines: number): RemoteCommandInput {
  const safeLines = Math.max(10, Math.min(1000, Math.trunc(lines) || 50));
  if (isWindows) {
    return powershellStdinCommand(`
$log = Join-Path $env:USERPROFILE ".frp\\frpc.log"
if (Test-Path $log) { Get-Content $log -Tail ${safeLines} } else { "No log file" }
`);
  }
  if (serviceMode === 'systemd') return command(`journalctl -u frpc --no-pager -n ${safeLines} 2>&1`);
  return command(`tail -n ${safeLines} /var/log/frpc.log 2>&1`);
}

export function createFrpcReadConfigCommand(configPath: string): RemoteCommandInput {
  if (isLikelyWindowsPath(configPath)) {
    return powershellStdinCommand(`${windowsPathAssignment(configPath)}\nif (Test-Path $path) { Get-Content $path -Raw }`);
  }
  return command(`cat ${shellSingleQuote(configPath)} 2>/dev/null || true`);
}

export function createFrpcWriteConfigCommand(configPath: string, content: string): RemoteCommandInput {
  const base64Content = encodeUtf8Base64(content);
  if (isLikelyWindowsPath(configPath)) {
    return powershellStdinCommand(`
${windowsPathAssignment(configPath)}
New-Item -ItemType Directory -Force -Path (Split-Path $path) | Out-Null
[IO.File]::WriteAllBytes($path, [Convert]::FromBase64String('${base64Content}'))
`);
  }
  return command(`mkdir -p "$(dirname ${shellSingleQuote(configPath)})" && if base64 -d >/dev/null 2>&1 </dev/null; then echo '${base64Content}' | base64 -d > ${shellSingleQuote(configPath)}; else echo '${base64Content}' | base64 -D > ${shellSingleQuote(configPath)}; fi`);
}

export function createFrpcEnableAutostartCommand(isWindows: boolean, serviceMode: string, configPath?: string): RemoteCommandInput {
  const resolvedConfigPath = configPathOrDefault(isWindows, configPath);
  if (isWindows) {
    return powershellStdinCommand(`
$taskName = "ShellDesk frpc"
${windowsPathAssignment(resolvedConfigPath)}
$action = New-ScheduledTaskAction -Execute "frpc" -Argument "-c ""$path"""
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Force | Out-Null
`);
  }
  if (serviceMode === 'systemd') return command('systemctl enable frpc 2>&1');
  const processPattern = `frpc -c ${resolvedConfigPath}`;
  return command(`(crontab -l 2>/dev/null | grep -v -F ${shellSingleQuote(processPattern)}; echo ${shellSingleQuote(`@reboot nohup frpc -c ${resolvedConfigPath} > /var/log/frpc.log 2>&1 &`)}) | crontab -`);
}

export function createFrpcAdminStatusCommand(adminAddr: string, adminPort: number): RemoteCommandInput {
  const safeAddr = adminAddr.trim() || '127.0.0.1';
  const safePort = Number.isFinite(adminPort) ? Math.trunc(adminPort) : 7400;
  return command(`curl -s ${shellSingleQuote(`http://${safeAddr}:${safePort}/api/proxy/http`)}`);
}

export function createFrpcGenerateConfigCommand(config: FrpcConfig): RemoteCommandInput {
  return createFrpcWriteConfigCommand(LINUX_CONFIG_PATH, generateFrpcToml(config));
}
