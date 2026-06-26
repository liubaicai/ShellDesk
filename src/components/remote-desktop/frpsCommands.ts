import { powershellSingleQuote, powershellStdinCommand, type RemoteCommandInput } from './remoteSystem';
import { shellSingleQuote } from './shellUtils';
import type { FrpsConfig } from './frpsTypes';

const FRP_VERSION = '0.61.1';
const LINUX_CONFIG_PATH = '/etc/frp/frps.toml';
const WINDOWS_CONFIG_PATH = '%USERPROFILE%\\.frp\\frps.toml';

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

function windowsFrpsVersionScript(executableExpression = powershellSingleQuote('frps')) {
  return `
function Invoke-ShellDeskFrpsVersion {
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
Invoke-ShellDeskFrpsVersion ${executableExpression}
`;
}

function unixFrpsVersionCommand(executable = 'frps') {
  const quotedExecutable = shellSingleQuote(executable);
  return `${quotedExecutable} --version 2>/dev/null || ${quotedExecutable} -v 2>/dev/null || ${quotedExecutable} version 2>/dev/null`;
}

function unixEnsureSystemdServiceCommand(configPath: string) {
  const serviceContent = `[Unit]
Description=frps server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/frps -c ${configPath}
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
`;
  const encodedService = encodeUtf8Base64(serviceContent);
  return `
frps_systemctl() {
  if [ "$(id -u 2>/dev/null)" = "0" ]; then
    systemctl "$@"
  elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo -n systemctl "$@"
  else
    systemctl "$@"
  fi
}

ensure_frps_service() {
  if systemctl cat frps >/dev/null 2>&1; then
    return 0
  fi
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "systemctl is not available." >&2
    return 1
  fi
  if ! command -v frps >/dev/null 2>&1 && [ ! -x /usr/local/bin/frps ]; then
    echo "frps is not installed or is not in PATH." >&2
    return 1
  fi
  if [ ! -x /usr/local/bin/frps ]; then
    FRPS_BIN="$(command -v frps)"
    SERVICE_CONTENT="$(echo '${encodedService}' | base64 -d | sed "s#ExecStart=/usr/local/bin/frps#ExecStart=$FRPS_BIN#")"
  else
    SERVICE_CONTENT="$(echo '${encodedService}' | base64 -d)"
  fi
  if [ "$(id -u 2>/dev/null)" = "0" ]; then
    printf '%s' "$SERVICE_CONTENT" > /etc/systemd/system/frps.service
    frps_systemctl daemon-reload
  elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    printf '%s' "$SERVICE_CONTENT" | sudo -n tee /etc/systemd/system/frps.service >/dev/null
    frps_systemctl daemon-reload
  else
    echo "Creating frps.service requires root or passwordless sudo." >&2
    return 1
  fi
}
`;
}

function unixSystemctlHelperCommand() {
  return `
frps_systemctl() {
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

function unixSystemctlStatusCommand() {
  return `
${unixSystemctlHelperCommand()}
frps_systemctl is-active frps 2>/dev/null || true
`;
}

function unixFrpsProcessPidsCommand(configPath: string) {
  return `ps -eo pid=,comm=,args= | awk -v cfg=${shellSingleQuote(configPath)} '$2 == "frps" && index($0, "-c " cfg) { print $1 }'`;
}

function tomlString(value: string) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function encodeUtf8Base64(value: string) {
  return btoa(unescape(encodeURIComponent(value)));
}

export function generateFrpsToml(config: FrpsConfig) {
  const lines = [
    `bindAddr = ${tomlString(config.bindAddr || '0.0.0.0')}`,
    `bindPort = ${Number.isFinite(config.bindPort) ? config.bindPort : 7000}`,
  ];

  if (config.token.trim()) {
    lines.push(`auth.token = ${tomlString(config.token)}`);
  }

  lines.push(
    '',
    `vhostHTTPPort = ${Number.isFinite(config.vhostHTTPPort) ? config.vhostHTTPPort : 80}`,
    `vhostHTTPSPort = ${Number.isFinite(config.vhostHTTPSPort) ? config.vhostHTTPSPort : 443}`,
  );
  if (config.subDomainHost.trim()) {
    lines.push(`subDomainHost = ${tomlString(config.subDomainHost)}`);
  }

  lines.push(
    '',
    `webServer.addr = ${tomlString(config.dashboardAddr || '0.0.0.0')}`,
    `webServer.port = ${Number.isFinite(config.dashboardPort) ? config.dashboardPort : 7500}`,
    `webServer.user = ${tomlString(config.dashboardUser || 'admin')}`,
    `webServer.password = ${tomlString(config.dashboardPassword || 'admin')}`,
    '',
    `log.to = ${tomlString(config.logTo || '/var/log/frps.log')}`,
    `log.level = ${tomlString(config.logLevel || 'info')}`,
    `log.maxDays = ${Number.isFinite(config.logMaxDays) ? config.logMaxDays : 3}`,
    '',
    `transport.maxPoolCount = ${Number.isFinite(config.maxPoolCount) ? config.maxPoolCount : 10}`,
    `transport.tcpMux = ${config.tcpMux ? 'true' : 'false'}`,
  );

  return `${lines.join('\n')}\n`;
}

export function createFrpsDetectCommand(isWindows: boolean): RemoteCommandInput {
  if (isWindows) {
    return powershellStdinCommand(`
$frps = Get-Command frps -ErrorAction SilentlyContinue | Select-Object -First 1
if ($frps) {
  "installed=true"
  "path=$($frps.Source)"
  $versionOutput = & {
${windowsFrpsVersionScript()}
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

  return command(`
if command -v frps >/dev/null 2>&1; then
  echo "installed=true"
  echo "path=$(command -v frps)"
  FRPS_VERSION_OUTPUT="$(${unixFrpsVersionCommand()} || true)"
  echo "version=$(printf '%s\\n' "$FRPS_VERSION_OUTPUT" | head -n 1)"
else
  echo "installed=false"
  echo "version="
fi
echo "---"
if command -v systemctl >/dev/null 2>&1; then
  if systemctl cat frps >/dev/null 2>&1; then
    echo "systemd=true"
    systemctl is-active frps 2>/dev/null || true
    echo "---SERVICE---"
    systemctl cat frps 2>/dev/null || true
  else
    echo "systemd=false"
  fi
else
  echo "systemd=false"
fi
echo "---CONFIG---"
if [ -f ${shellSingleQuote(LINUX_CONFIG_PATH)} ]; then
  echo ${shellSingleQuote(LINUX_CONFIG_PATH)}
elif [ -f ./frps.toml ]; then
  echo "./frps.toml"
else
  echo ${shellSingleQuote(LINUX_CONFIG_PATH)}
fi
`);
}

export function createFrpsInstallCommand(isWindows: boolean): RemoteCommandInput {
  if (isWindows) {
    return powershellStdinCommand(`
$version = "${FRP_VERSION}"
$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq "Arm64") { "arm64" } else { "amd64" }
$base = "frp_${FRP_VERSION}_windows_$arch"
$url = "https://github.com/fatedier/frp/releases/download/v$version/$base.zip"
$download = Join-Path $env:TEMP "$base.zip"
$extract = Join-Path $env:TEMP $base
$destDir = Join-Path $env:USERPROFILE "bin"
$dest = Join-Path $destDir "frps.exe"
New-Item -ItemType Directory -Force -Path $destDir | Out-Null
Write-Host "Downloading $url"
Invoke-WebRequest -Uri $url -OutFile $download -UseBasicParsing
if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
Expand-Archive -Path $download -DestinationPath $env:TEMP -Force
Copy-Item (Join-Path $extract "frps.exe") $dest -Force
if (($env:PATH -split ';') -notcontains $destDir) {
  [Environment]::SetEnvironmentVariable("PATH", "$destDir;$env:PATH", "User")
  $env:PATH = "$destDir;$env:PATH"
}
${windowsFrpsVersionScript('$dest')}
`);
  }

  return command(`
set -e
VERSION="${FRP_VERSION}"
OS="linux"
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
mv "/tmp/$BASE/frps" /usr/local/bin/frps
chmod +x /usr/local/bin/frps
${unixFrpsVersionCommand('/usr/local/bin/frps')}
`);
}

export function createFrpsStartCommand(isWindows: boolean, serviceMode: string, configPath?: string): RemoteCommandInput {
  const resolvedConfigPath = configPathOrDefault(isWindows, configPath);
  if (isWindows) {
    return powershellStdinCommand(`
${windowsPathAssignment(resolvedConfigPath)}
Start-Process -FilePath "frps" -ArgumentList @("-c", $path) -WindowStyle Hidden
`);
  }
  if (serviceMode === 'systemd') return command(`${unixEnsureSystemdServiceCommand(resolvedConfigPath)}ensure_frps_service && frps_systemctl start frps 2>&1`);
  return command(`nohup frps -c ${shellSingleQuote(resolvedConfigPath)} > /var/log/frps.log 2>&1 & echo $!`);
}

export function createFrpsStopCommand(isWindows: boolean, serviceMode: string, configPath?: string): RemoteCommandInput {
  if (isWindows) {
    return powershellStdinCommand('Get-Process frps -ErrorAction SilentlyContinue | Stop-Process -Force');
  }
  if (serviceMode === 'systemd') return command(`${unixSystemctlHelperCommand()}frps_systemctl is-active --quiet frps || exit 0\nfrps_systemctl stop frps 2>&1`);
  const pidsCommand = unixFrpsProcessPidsCommand(configPathOrDefault(false, configPath));
  return command(`PIDS="$(${pidsCommand})"; if [ -n "$PIDS" ]; then kill $PIDS 2>/dev/null || true; fi`);
}

export function createFrpsRestartCommand(isWindows: boolean, serviceMode: string, configPath?: string): RemoteCommandInput {
  const resolvedConfigPath = configPathOrDefault(isWindows, configPath);
  if (isWindows) {
    return powershellStdinCommand(`
Get-Process frps -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1
${windowsPathAssignment(resolvedConfigPath)}
Start-Process -FilePath "frps" -ArgumentList @("-c", $path) -WindowStyle Hidden
`);
  }
  if (serviceMode === 'systemd') return command(`${unixEnsureSystemdServiceCommand(resolvedConfigPath)}ensure_frps_service && frps_systemctl restart frps 2>&1`);
  const pidsCommand = unixFrpsProcessPidsCommand(resolvedConfigPath);
  return command(`PIDS="$(${pidsCommand})"; if [ -n "$PIDS" ]; then kill $PIDS 2>/dev/null || true; fi; nohup frps -c ${shellSingleQuote(resolvedConfigPath)} > /var/log/frps.log 2>&1 & echo $!`);
}

export function createFrpsStatusCommand(isWindows: boolean, serviceMode: string, configPath?: string): RemoteCommandInput {
  if (isWindows) return powershellStdinCommand('Get-Process frps -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object { $_.Id }');
  if (serviceMode === 'systemd') return command(unixSystemctlStatusCommand());
  return command(`${unixFrpsProcessPidsCommand(configPathOrDefault(false, configPath))} || true`);
}

export function createFrpsLogsCommand(isWindows: boolean, serviceMode: string, lines: number): RemoteCommandInput {
  const safeLines = Math.max(10, Math.min(1000, Math.trunc(lines) || 50));
  if (isWindows) {
    return powershellStdinCommand(`
$log = Join-Path $env:USERPROFILE ".frp\\frps.log"
if (Test-Path $log) { Get-Content $log -Tail ${safeLines} } else { "No log file" }
`);
  }
  if (serviceMode === 'systemd') return command(`journalctl -u frps --no-pager -n ${safeLines} 2>&1`);
  return command(`tail -n ${safeLines} /var/log/frps.log 2>&1`);
}

export function createFrpsReadConfigCommand(configPath: string): RemoteCommandInput {
  if (isLikelyWindowsPath(configPath)) {
    return powershellStdinCommand(`${windowsPathAssignment(configPath)}\nif (Test-Path $path) { Get-Content $path -Raw }`);
  }
  return command(`cat ${shellSingleQuote(configPath)} 2>/dev/null || true`);
}

export function createFrpsWriteConfigCommand(configPath: string, content: string): RemoteCommandInput {
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

export function createFrpsEnableAutostartCommand(isWindows: boolean, serviceMode: string, configPath?: string): RemoteCommandInput {
  const resolvedConfigPath = configPathOrDefault(isWindows, configPath);
  if (isWindows) {
    return powershellStdinCommand(`
$taskName = "ShellDesk frps"
${windowsPathAssignment(resolvedConfigPath)}
$action = New-ScheduledTaskAction -Execute "frps" -Argument "-c ""$path"""
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Force | Out-Null
`);
  }
  if (serviceMode === 'systemd') return command(`${unixEnsureSystemdServiceCommand(resolvedConfigPath)}ensure_frps_service && frps_systemctl enable frps 2>&1`);
  const processPattern = `frps -c ${resolvedConfigPath}`;
  return command(`(crontab -l 2>/dev/null | grep -v -F ${shellSingleQuote(processPattern)}; echo ${shellSingleQuote(`@reboot nohup frps -c ${resolvedConfigPath} > /var/log/frps.log 2>&1 &`)}) | crontab -`);
}

export function createFrpsDashboardCommand(dashboardAddr: string, dashboardPort: number, user: string, password: string): RemoteCommandInput {
  const safeAddr = dashboardAddr.trim() || '127.0.0.1';
  const safePort = Number.isFinite(dashboardPort) ? Math.trunc(dashboardPort) : 7500;
  const safeUser = user.trim() || 'admin';
  const dashboardBaseUrl = `http://${safeAddr}:${safePort}/api/proxy/`;
  return command(`
for FRPS_PROXY_TYPE in tcp udp http https stcp xtcp tcpmux; do
  printf '__SHELLDESK_FRPS_PROXY_TYPE__=%s\\n' "$FRPS_PROXY_TYPE"
  curl -s -u ${shellSingleQuote(`${safeUser}:${password}`)} ${shellSingleQuote(dashboardBaseUrl)}"$FRPS_PROXY_TYPE"
  printf '\\n'
done
`);
}

export function createFrpsEnsureServiceCommand(isWindows: boolean, configPath: string): RemoteCommandInput {
  if (isWindows) return command('echo "systemd is not available on Windows."');
  return command(`${unixEnsureSystemdServiceCommand(configPath)}ensure_frps_service`);
}
