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

function windowsFrpcVersionScript(executableExpression = powershellSingleQuote('frpc')) {
  return `
function Invoke-ShellDeskFrpcVersion {
  param([string]$Executable)
  foreach ($argument in @("--version", "-v", "version")) {
    $output = & $Executable $argument 2>&1
    if ($LASTEXITCODE -eq 0 -and $output) {
      $output | Select-Object -First 1
      return
    }
  }
  if ($output) { $output | Select-Object -First 1 }
}
Invoke-ShellDeskFrpcVersion ${executableExpression}
`;
}

function unixFrpcVersionCommand(executable = 'frpc') {
  const quotedExecutable = shellSingleQuote(executable);
  return `${quotedExecutable} --version 2>/dev/null || ${quotedExecutable} -v 2>/dev/null || ${quotedExecutable} version 2>/dev/null`;
}

function unixEnsureSystemdServiceCommand(configPath: string) {
  const serviceContent = `[Unit]
Description=frpc client
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/frpc -c ${configPath}
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
`;
  const encodedService = encodeUtf8Base64(serviceContent);
  return `
frpc_systemctl() {
  if [ "$(id -u 2>/dev/null)" = "0" ]; then
    systemctl "$@"
  elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo -n systemctl "$@"
  else
    systemctl "$@"
  fi
}

ensure_frpc_service() {
  if systemctl cat frpc >/dev/null 2>&1; then
    return 0
  fi
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "systemctl is not available." >&2
    return 1
  fi
  if ! command -v frpc >/dev/null 2>&1 && [ ! -x /usr/local/bin/frpc ]; then
    echo "frpc is not installed or is not in PATH." >&2
    return 1
  fi
  if [ ! -x /usr/local/bin/frpc ]; then
    FRPC_BIN="$(command -v frpc)"
    SERVICE_CONTENT="$(echo '${encodedService}' | base64 -d | sed "s#ExecStart=/usr/local/bin/frpc#ExecStart=$FRPC_BIN#")"
  else
    SERVICE_CONTENT="$(echo '${encodedService}' | base64 -d)"
  fi
  if [ "$(id -u 2>/dev/null)" = "0" ]; then
    printf '%s' "$SERVICE_CONTENT" > /etc/systemd/system/frpc.service
    frpc_systemctl daemon-reload
  elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    printf '%s' "$SERVICE_CONTENT" | sudo -n tee /etc/systemd/system/frpc.service >/dev/null
    frpc_systemctl daemon-reload
  else
    echo "Creating frpc.service requires root or passwordless sudo." >&2
    return 1
  fi
}
`;
}

function unixSystemctlHelperCommand() {
  return `
frpc_systemctl() {
  if [ "$(id -u 2>/dev/null)" = "0" ]; then
    systemctl "$@"
  elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo -n systemctl "$@"
  else
    systemctl "$@"
  fi
}
`;
}

function unixSystemctlCommand(action: string) {
  return `
${unixSystemctlHelperCommand()}
frpc_systemctl ${action} 2>&1
`;
}

function unixSystemctlStatusCommand() {
  return `
${unixSystemctlHelperCommand()}
frpc_systemctl is-active frpc 2>/dev/null || true
`;
}

function unixFrpcProcessPidsCommand(configPath: string) {
  return `ps -eo pid=,comm=,args= | awk -v cfg=${shellSingleQuote(configPath)} '$2 == "frpc" && index($0, "-c " cfg) { print $1 }'`;
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

function appendProxyTransportBoolean(lines: string[], fieldName: string, key: keyof FrpcProxy, proxy: FrpcProxy) {
  const value = proxy[key];
  if (typeof value === 'boolean') {
    lines.push(`${fieldName} = ${value ? 'true' : 'false'}`);
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
    appendProxyTransportBoolean(lines, 'transport.useEncryption', 'encryption', proxy);
    appendProxyTransportBoolean(lines, 'transport.useCompression', 'compression', proxy);
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
  $versionOutput = & {
${windowsFrpcVersionScript()}
  }
  $version = if ($versionOutput) { ($versionOutput | Select-Object -First 1).ToString() } else { "" }
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
  FRPC_VERSION_OUTPUT="$(${unixFrpcVersionCommand()} || true)"
  echo "version=$(printf '%s\\n' "$FRPC_VERSION_OUTPUT" | head -n 1)"
else
  echo "installed=false"
  echo "version="
fi
echo "---"
if command -v systemctl >/dev/null 2>&1; then
  if systemctl cat frpc >/dev/null 2>&1; then
    echo "systemd=true"
    systemctl is-active frpc 2>/dev/null || true
    echo "---SERVICE---"
    systemctl cat frpc 2>/dev/null || true
  else
    echo "systemd=false"
  fi
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
${windowsFrpcVersionScript('$dest')}
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
${unixFrpcVersionCommand('/usr/local/bin/frpc')}
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
  if (serviceMode === 'systemd') return command(`${unixEnsureSystemdServiceCommand(resolvedConfigPath)}ensure_frpc_service && frpc_systemctl start frpc 2>&1`);
  return command(`nohup frpc -c ${shellSingleQuote(resolvedConfigPath)} > /var/log/frpc.log 2>&1 & echo $!`);
}

export function createFrpcStopCommand(isWindows: boolean, serviceMode: string, configPath?: string): RemoteCommandInput {
  if (isWindows) {
    return powershellStdinCommand('Get-Process frpc -ErrorAction SilentlyContinue | Stop-Process -Force');
  }
  if (serviceMode === 'systemd') return command(`${unixSystemctlHelperCommand()}frpc_systemctl is-active --quiet frpc || exit 0\nfrpc_systemctl stop frpc 2>&1`);
  const pidsCommand = unixFrpcProcessPidsCommand(configPathOrDefault(false, configPath));
  return command(`PIDS="$(${pidsCommand})"; if [ -n "$PIDS" ]; then kill $PIDS 2>/dev/null || true; fi`);
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
  if (serviceMode === 'systemd') return command(`${unixEnsureSystemdServiceCommand(resolvedConfigPath)}ensure_frpc_service && frpc_systemctl restart frpc 2>&1`);
  const pidsCommand = unixFrpcProcessPidsCommand(resolvedConfigPath);
  return command(`PIDS="$(${pidsCommand})"; if [ -n "$PIDS" ]; then kill $PIDS 2>/dev/null || true; fi; nohup frpc -c ${shellSingleQuote(resolvedConfigPath)} > /var/log/frpc.log 2>&1 & echo $!`);
}

export function createFrpcStatusCommand(isWindows: boolean, serviceMode: string, configPath?: string): RemoteCommandInput {
  if (isWindows) return powershellStdinCommand('Get-Process frpc -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object { $_.Id }');
  if (serviceMode === 'systemd') return command(unixSystemctlStatusCommand());
  return command(`${unixFrpcProcessPidsCommand(configPathOrDefault(false, configPath))} || true`);
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
  if (serviceMode === 'systemd') return command(`${unixEnsureSystemdServiceCommand(resolvedConfigPath)}ensure_frpc_service && frpc_systemctl enable frpc 2>&1`);
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
