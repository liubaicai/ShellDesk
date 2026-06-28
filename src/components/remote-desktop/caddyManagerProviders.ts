import { powershellStdinCommand, type RemoteCommandInput } from './remoteSystem';
import { tCurrent } from '../../i18n';
import { shellSingleQuote } from './shellUtils';
import type { CaddyInstallation } from './caddyManagerTypes';

const caddyFieldMarker = '__SHELLDESK_CADDY_FIELD__';

function windowsUnsupported(marker = caddyFieldMarker): RemoteCommandInput {
  return powershellStdinCommand(`[Console]::Out.WriteLine("${marker}|error|${tCurrent('auto.remoteCaddyManager.windowsUnsupported')}")`);
}

function sudoCommand(command: string) {
  return `if [ "$(id -u 2>/dev/null)" = "0" ]; then sh -c ${shellSingleQuote(command)}; else sudo -n sh -c ${shellSingleQuote(command)}; fi`;
}

function first(values: Map<string, string>, key: string, fallback = '') {
  return values.get(key)?.trim() || fallback;
}

function createHeredocDelimiter(content: string) {
  let delimiter = 'SHELLDESK_CADDY_CONFIG_EOF';
  let index = 0;
  while (content.includes(delimiter)) {
    index += 1;
    delimiter = `SHELLDESK_CADDY_CONFIG_EOF_${index}`;
  }
  return delimiter;
}

function parseDistro(value: string): CaddyInstallation['distro'] {
  if (value === 'debian' || value === 'rhel' || value === 'alpine') return value;
  return 'unknown';
}

export function createCaddyDetectCommand(isWindowsHost = false): RemoteCommandInput {
  if (isWindowsHost) return windowsUnsupported();

  return {
    command: `
emit() { printf '${caddyFieldMarker}|%s|%s\\n' "$1" "$2"; }
if ! command -v caddy >/dev/null 2>&1; then
  emit found false
  exit 0
fi
version="$(caddy version 2>/dev/null | awk '{print $1}' || true)"
[ -n "$version" ] || version="$(caddy version 2>&1 | head -n 1)"
config_path="/etc/caddy/Caddyfile"
[ -f "$config_path" ] || config_path="$(find /etc/caddy -maxdepth 2 -type f -name Caddyfile 2>/dev/null | head -n 1)"
[ -n "$config_path" ] || config_path="/etc/caddy/Caddyfile"
config_dir="$(dirname "$config_path")"
distro=unknown
if [ -f /etc/alpine-release ]; then
  distro=alpine
elif [ -f /etc/debian_version ]; then
  distro=debian
elif [ -f /etc/redhat-release ] || [ -f /etc/centos-release ] || [ -f /etc/fedora-release ]; then
  distro=rhel
fi
if command -v systemctl >/dev/null 2>&1; then
  is_running="$(systemctl is-active caddy 2>/dev/null | grep -qx active && printf true || printf false)"
else
  is_running="$(pgrep caddy >/dev/null 2>&1 && printf true || printf false)"
fi
admin_api_url="http://localhost:2019"
is_admin_api_enabled="$(caddy list-modules 2>/dev/null | grep -q '^admin\\.api' && printf true || printf false)"
emit found true
emit version "$version"
emit configPath "$config_path"
emit configDir "$config_dir"
emit isAdminApiEnabled "$is_admin_api_enabled"
emit adminApiUrl "$admin_api_url"
emit isRunning "$is_running"
emit distro "$distro"
`.trim(),
  };
}

export function parseCaddyDetectOutput(stdout: string): CaddyInstallation | null {
  const values = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^__SHELLDESK_CADDY_FIELD__\|([^|]+)\|(.*)$/);
    if (match) values.set(match[1], match[2]);
  }
  if (first(values, 'found') === 'false' || !values.has('version')) return null;
  const configPath = first(values, 'configPath', '/etc/caddy/Caddyfile');
  return {
    version: first(values, 'version'),
    configPath,
    configDir: first(values, 'configDir', configPath.replace(/\/[^/]*$/, '') || '/etc/caddy'),
    isAdminApiEnabled: first(values, 'isAdminApiEnabled') !== 'false',
    adminApiUrl: first(values, 'adminApiUrl', 'http://localhost:2019'),
    isRunning: first(values, 'isRunning') === 'true',
    distro: parseDistro(first(values, 'distro')),
  };
}

export function createCaddyReadConfigCommand(filePath: string, isWindowsHost = false): RemoteCommandInput {
  if (isWindowsHost) return windowsUnsupported();
  return { command: `cat -- ${shellSingleQuote(filePath)} 2>/dev/null || sudo -n cat -- ${shellSingleQuote(filePath)}` };
}

export function createCaddyWriteConfigCommand(filePath: string, content: string, isWindowsHost = false): RemoteCommandInput {
  if (isWindowsHost) return windowsUnsupported();
  const delimiter = createHeredocDelimiter(content);
  return {
    command: `
tmp="$(mktemp 2>/dev/null || printf "/tmp/shelldesk-caddy-write-$$")"
trap 'rm -f -- "$tmp"' EXIT HUP INT TERM
cat > "$tmp" <<'${delimiter}'
${content}
${delimiter}
if [ "$(id -u 2>/dev/null)" = "0" ]; then
  install -m 0644 "$tmp" ${shellSingleQuote(filePath)}
else
  sudo -n install -m 0644 "$tmp" ${shellSingleQuote(filePath)}
fi
`.trim(),
  };
}

export function createCaddyBackupCommand(filePath: string, isWindowsHost = false): RemoteCommandInput {
  if (isWindowsHost) return windowsUnsupported();
  return { command: sudoCommand(`cp -- ${shellSingleQuote(filePath)} ${shellSingleQuote(`${filePath}.bak`)}.$(date +%Y%m%d%H%M%S)`) };
}

export function createCaddyTestCommand(configPath: string, isWindowsHost = false): RemoteCommandInput {
  if (isWindowsHost) return windowsUnsupported();
  const quotedConfigPath = shellSingleQuote(configPath);
  return { command: `sudo -n caddy validate --config ${quotedConfigPath} --adapter caddyfile 2>&1 || caddy validate --config ${quotedConfigPath} --adapter caddyfile 2>&1` };
}

export function createCaddyReloadCommand(configPath: string, isWindowsHost = false): RemoteCommandInput {
  if (isWindowsHost) return windowsUnsupported();
  const quotedConfigPath = shellSingleQuote(configPath);
  return { command: `sudo -n caddy reload --config ${quotedConfigPath} --adapter caddyfile 2>&1 || caddy reload --config ${quotedConfigPath} --adapter caddyfile 2>&1` };
}

export function createCaddyDeleteCommand(filePath: string, configDir: string, isWindowsHost = false): RemoteCommandInput {
  if (isWindowsHost) return windowsUnsupported();
  const backupDir = `${configDir}/.shelldesk-backups`;
  const filename = filePath.split('/').pop() || 'Caddyfile';
  return { command: sudoCommand(`mkdir -p ${shellSingleQuote(backupDir)}; mv -- ${shellSingleQuote(filePath)} ${shellSingleQuote(`${backupDir}/${filename}`)}.$(date +%Y%m%d%H%M%S)`) };
}

export function createCaddyCreateSiteCommand(configPath: string, content: string, isWindowsHost = false): RemoteCommandInput {
  if (isWindowsHost) return windowsUnsupported();
  const delimiter = createHeredocDelimiter(content);
  return {
    command: `
tmp="$(mktemp 2>/dev/null || printf "/tmp/shelldesk-caddy-site-$$")"
trap 'rm -f -- "$tmp"' EXIT HUP INT TERM
cat > "$tmp" <<'${delimiter}'

${content.trim()}
${delimiter}
if [ "$(id -u 2>/dev/null)" = "0" ]; then
  cat "$tmp" >> ${shellSingleQuote(configPath)}
else
  sudo -n sh -c ${shellSingleQuote(`cat "$1" >> ${shellSingleQuote(configPath)}`)} sh "$tmp"
fi
`.trim(),
  };
}
