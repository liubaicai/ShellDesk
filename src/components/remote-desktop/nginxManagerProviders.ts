import { powershellStdinCommand, type RemoteCommandInput } from './remoteSystem';
import { tCurrent } from '../../i18n';
import { shellSingleQuote } from './shellUtils';
import type { NginxDistro, NginxInstallation, NginxSitesLayout } from './nginxManagerTypes';

const nginxFieldMarker = '__SHELLDESK_NGINX_FIELD__';
const nginxFileMarker = '__SHELLDESK_NGINX_FILE__';

function windowsUnsupported(marker = nginxFieldMarker): RemoteCommandInput {
  return powershellStdinCommand(`[Console]::Out.WriteLine("${marker}|error|${tCurrent('auto.remoteNginxManager.windowsUnsupported')}")`);
}

function sudoCommand(command: string) {
  return `if [ "$(id -u 2>/dev/null)" = "0" ]; then sh -c ${shellSingleQuote(command)}; else sudo -n sh -c ${shellSingleQuote(command)}; fi`;
}

function basename(filePath: string) {
  return filePath.split(/[\\/]/).pop() || filePath;
}

function normalizeNullable(value: string) {
  const trimmed = value.trim();
  return trimmed && trimmed !== 'null' ? trimmed : null;
}

function first(values: Map<string, string>, key: string, fallback = '') {
  return values.get(key)?.trim() || fallback;
}

function parseDistro(value: string): NginxDistro {
  if (value === 'debian' || value === 'rhel' || value === 'alpine') return value;
  return 'unknown';
}

function parseSitesLayout(value: string): NginxSitesLayout {
  return value === 'debian' ? 'debian' : 'rhel';
}

function createHeredocDelimiter(content: string) {
  let delimiter = 'SHELLDESK_NGINX_CONFIG_EOF';
  let index = 0;
  while (content.includes(delimiter)) {
    index += 1;
    delimiter = `SHELLDESK_NGINX_CONFIG_EOF_${index}`;
  }
  return delimiter;
}

function isPathUnder(filePath: string, directory: string | null | undefined) {
  if (!directory) return false;
  const normalizePath = (value: string) => {
    const parts: string[] = [];
    for (const part of value.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') {
        parts.pop();
        continue;
      }
      parts.push(part);
    }
    return `/${parts.join('/')}`;
  };
  const normalizedFilePath = normalizePath(filePath);
  const base = normalizePath(directory);
  return normalizedFilePath === base || normalizedFilePath.startsWith(`${base}/`);
}

// Provider commands run privileged operations; callers should pass discovered Nginx paths only.
export function validateNginxConfigPath(filePath: string, installation: NginxInstallation) {
  return (
    filePath === installation.configPath
    || isPathUnder(filePath, installation.configDir)
    || isPathUnder(filePath, installation.availableDir)
    || isPathUnder(filePath, installation.enabledDir)
    || isPathUnder(filePath, installation.confDir)
    || isPathUnder(filePath, '/etc/nginx')
  );
}

export function createNginxDetectCommand(isWindowsHost = false): RemoteCommandInput {
  if (isWindowsHost) return windowsUnsupported();

  return {
    command: `
emit() { printf '${nginxFieldMarker}|%s|%s\\n' "$1" "$2"; }
if ! command -v nginx >/dev/null 2>&1; then
  emit found false
  exit 0
fi
bin="$(command -v nginx)"
version="$(nginx -v 2>&1 | sed 's/^nginx version: //')"
build="$(nginx -V 2>&1 || true)"
config_path="$(printf '%s\\n' "$build" | sed -n 's/.*--conf-path=\\([^[:space:]]*\\).*/\\1/p' | head -n 1)"
error_log="$(printf '%s\\n' "$build" | sed -n 's/.*--error-log-path=\\([^[:space:]]*\\).*/\\1/p' | head -n 1)"
pid_path="$(printf '%s\\n' "$build" | sed -n 's/.*--pid-path=\\([^[:space:]]*\\).*/\\1/p' | head -n 1)"
[ -n "$config_path" ] || config_path="/etc/nginx/nginx.conf"
config_dir="$(dirname "$config_path")"
[ -n "$error_log" ] || error_log="/var/log/nginx/error.log"
[ -n "$pid_path" ] || pid_path="/run/nginx.pid"
distro=unknown
if [ -f /etc/alpine-release ]; then
  distro=alpine
elif [ -f /etc/debian_version ]; then
  distro=debian
elif [ -f /etc/redhat-release ] || [ -f /etc/centos-release ] || [ -f /etc/fedora-release ]; then
  distro=rhel
fi
available_dir="$config_dir/sites-available"
enabled_dir="$config_dir/sites-enabled"
conf_dir="$config_dir/conf.d"
if [ ! -d "$conf_dir" ] && [ -d /etc/nginx/conf.d ]; then
  conf_dir="/etc/nginx/conf.d"
fi
if [ -d "$available_dir" ] || [ -d "$enabled_dir" ]; then
  sites_layout=debian
elif [ -d /etc/nginx/sites-available ] || [ -d /etc/nginx/sites-enabled ]; then
  sites_layout=debian
  available_dir="/etc/nginx/sites-available"
  enabled_dir="/etc/nginx/sites-enabled"
else
  sites_layout=rhel
  available_dir=""
  enabled_dir=""
fi
modules="$(printf '%s\\n' "$build" | tr ' ' '\\n' | sed -n 's/^--with-\\(.*_module\\)$/\\1/p;s/^--add-module=\\(.*\\)$/\\1/p' | paste -sd ',' -)"
if command -v systemctl >/dev/null 2>&1; then
  is_running="$(systemctl is-active nginx 2>/dev/null | grep -qx active && printf true || printf false)"
else
  is_running="$(nginx -t >/dev/null 2>&1 && pgrep nginx >/dev/null 2>&1 && printf true || printf false)"
fi
emit found true
emit version "$version"
emit modules "$modules"
emit configPath "$config_path"
emit configDir "$config_dir"
emit errorLogPath "$error_log"
emit pidFile "$pid_path"
emit binaryPath "$bin"
emit distro "$distro"
emit sitesLayout "$sites_layout"
emit availableDir "$available_dir"
emit enabledDir "$enabled_dir"
emit confDir "$conf_dir"
emit logDir "/var/log/nginx"
emit isRunning "$is_running"
`.trim(),
  };
}

export function parseNginxDetectOutput(stdout: string): NginxInstallation | null {
  const values = new Map<string, string>();

  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^__SHELLDESK_NGINX_FIELD__\|([^|]+)\|(.*)$/);
    if (match) values.set(match[1], match[2]);
  }

  if (first(values, 'found') === 'false' || !values.has('version')) return null;

  const configDir = first(values, 'configDir', '/etc/nginx');

  return {
    version: first(values, 'version'),
    modules: first(values, 'modules').split(',').map((value) => value.trim()).filter(Boolean),
    configPath: first(values, 'configPath', `${configDir}/nginx.conf`),
    configDir,
    errorLogPath: first(values, 'errorLogPath', '/var/log/nginx/error.log'),
    pidFile: first(values, 'pidFile', '/run/nginx.pid'),
    binaryPath: first(values, 'binaryPath', 'nginx'),
    distro: parseDistro(first(values, 'distro')),
    sitesLayout: parseSitesLayout(first(values, 'sitesLayout')),
    availableDir: normalizeNullable(first(values, 'availableDir')),
    enabledDir: normalizeNullable(first(values, 'enabledDir')),
    confDir: first(values, 'confDir', `${configDir}/conf.d`),
    logDir: first(values, 'logDir', '/var/log/nginx'),
    isRunning: first(values, 'isRunning') === 'true',
  };
}

export function createNginxListConfigsCommand(installation: NginxInstallation, isWindowsHost = false): RemoteCommandInput {
  if (isWindowsHost) return windowsUnsupported(nginxFileMarker);

  const availableDir = installation.availableDir ? shellSingleQuote(installation.availableDir) : "''";
  const enabledDir = installation.enabledDir ? shellSingleQuote(installation.enabledDir) : "''";
  const confDir = shellSingleQuote(installation.confDir);

  return {
    command: `
available_dir=${availableDir}
enabled_dir=${enabledDir}
conf_dir=${confDir}
emit_file() {
  file="$1"; enabled="$2"
  [ -f "$file" ] || return 0
  size="$(stat -c %s "$file" 2>/dev/null || wc -c < "$file" 2>/dev/null || printf 0)"
  mtime="$(stat -c %Y "$file" 2>/dev/null || printf 0)"
  printf '${nginxFileMarker}|%s|%s|%s|%s\\n' "$file" "$enabled" "$size" "$mtime"
}
is_enabled_debian() {
  file="$1"
  base="$(basename "$file")"
  { [ -n "$enabled_dir" ] && [ -e "$enabled_dir/$base" ]; } || [ -e "/etc/nginx/sites-enabled/$base" ]
}
has_available_peer() {
  file="$1"
  base="$(basename "$file")"
  { [ -n "$available_dir" ] && [ -e "$available_dir/$base" ]; } || [ -e "/etc/nginx/sites-available/$base" ]
}
list_available_dir() {
  dir="$1"
  [ -n "$dir" ] && [ -d "$dir" ] || return 0
  find "$dir" -maxdepth 1 -type f ! -name '.*' ! -name '*.bak' ! -name '*.bak.*' 2>/dev/null | sort | while IFS= read -r file; do
    if is_enabled_debian "$file"; then emit_file "$file" true; else emit_file "$file" false; fi
  done
}
list_enabled_dir() {
  dir="$1"
  [ -n "$dir" ] && [ -d "$dir" ] || return 0
  find -L "$dir" -maxdepth 1 -type f ! -name '.*' 2>/dev/null | sort | while IFS= read -r file; do
    if has_available_peer "$file"; then continue; fi
    emit_file "$file" true
  done
}
list_conf_dir() {
  dir="$1"
  [ -n "$dir" ] && [ -d "$dir" ] || return 0
  find "$dir" -maxdepth 1 -type f \\( -name '*.conf' -o -name '*.conf.disabled' \\) 2>/dev/null | sort | while IFS= read -r file; do
    case "$file" in
      *.disabled) emit_file "$file" false ;;
      *) emit_file "$file" true ;;
    esac
  done
}
list_available_dir "$available_dir"
[ "$available_dir" = "/etc/nginx/sites-available" ] || list_available_dir "/etc/nginx/sites-available"
list_enabled_dir "$enabled_dir"
[ "$enabled_dir" = "/etc/nginx/sites-enabled" ] || list_enabled_dir "/etc/nginx/sites-enabled"
list_conf_dir "$conf_dir"
[ "$conf_dir" = "/etc/nginx/conf.d" ] || list_conf_dir "/etc/nginx/conf.d"
`.trim(),
  };
}

export function parseNginxListConfigs(stdout: string): { path: string; enabled: boolean; size: number; mtime: number }[] {
  return stdout
    .split(/\r?\n/)
    // Marker parsing intentionally treats "|" as a field delimiter; Nginx config paths containing "|" are not supported.
    .map((line) => line.match(/^__SHELLDESK_NGINX_FILE__\|([^|]+)\|(true|false)\|(\d+)\|(\d+)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({
      path: match[1],
      enabled: match[2] === 'true',
      size: Number(match[3]),
      mtime: Number(match[4]),
    }));
}

export function createNginxReadConfigCommand(filePath: string, isWindowsHost = false): RemoteCommandInput {
  if (isWindowsHost) return windowsUnsupported();

  return {
    command: `cat -- ${shellSingleQuote(filePath)} 2>/dev/null || sudo -n cat -- ${shellSingleQuote(filePath)}`,
  };
}

export function createNginxEnableSiteCommand(filename: string, installation: NginxInstallation, isWindowsHost = false): RemoteCommandInput {
  if (isWindowsHost) return windowsUnsupported();

  const safeFilename = basename(filename);
  if (installation.sitesLayout === 'debian' && installation.availableDir && installation.enabledDir) {
    const source = `${installation.availableDir}/${safeFilename}`;
    const target = `${installation.enabledDir}/${safeFilename}`;
    return { command: sudoCommand(`ln -sf ${shellSingleQuote(source)} ${shellSingleQuote(target)}`) };
  }

  const disabled = `${installation.confDir}/${safeFilename.replace(/\.conf$/i, '')}.conf.disabled`;
  const enabled = `${installation.confDir}/${safeFilename.replace(/\.disabled$/i, '')}`;
  return { command: sudoCommand(`mv ${shellSingleQuote(disabled)} ${shellSingleQuote(enabled)}`) };
}

export function createNginxDisableSiteCommand(filePath: string, installation: NginxInstallation, isWindowsHost = false): RemoteCommandInput {
  if (isWindowsHost) return windowsUnsupported();

  const safeFilename = basename(filePath);
  if (installation.sitesLayout === 'debian' && installation.enabledDir) {
    if (isPathUnder(filePath, installation.enabledDir)) {
      const disabledDir = installation.availableDir ?? `${installation.configDir}/.shelldesk-disabled`;
      const disabledPath = `${disabledDir}/${safeFilename}`;
      return {
        command: sudoCommand(
          `[ -L ${shellSingleQuote(filePath)} ] && rm -f -- ${shellSingleQuote(filePath)} || { mkdir -p -- ${shellSingleQuote(disabledDir)}; mv -- ${shellSingleQuote(filePath)} ${shellSingleQuote(disabledPath)}; }`,
        ),
      };
    }

    return { command: sudoCommand(`rm -f -- ${shellSingleQuote(`${installation.enabledDir}/${safeFilename}`)}`) };
  }

  const target = filePath.endsWith('.disabled') ? filePath : `${filePath}.disabled`;
  return { command: sudoCommand(`mv ${shellSingleQuote(filePath)} ${shellSingleQuote(target)}`) };
}

export function createNginxBackupCommand(filePath: string, isWindowsHost = false): RemoteCommandInput {
  if (isWindowsHost) return windowsUnsupported();

  return {
    command: sudoCommand(`cp -- ${shellSingleQuote(filePath)} ${shellSingleQuote(`${filePath}.bak`)}.$(date +%Y%m%d%H%M%S)`),
  };
}

export function createNginxWriteConfigCommand(filePath: string, content: string, isWindowsHost = false): RemoteCommandInput {
  if (isWindowsHost) return windowsUnsupported();

  const delimiter = createHeredocDelimiter(content);

  return {
    command: `
tmp="$(mktemp 2>/dev/null || printf "/tmp/shelldesk-nginx-write-$$")"
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

export function createNginxTestCommand(isWindowsHost = false): RemoteCommandInput {
  if (isWindowsHost) return windowsUnsupported();

  return { command: 'sudo -n nginx -t 2>&1 || nginx -t 2>&1' };
}

export function createNginxReloadCommand(isWindowsHost = false): RemoteCommandInput {
  if (isWindowsHost) return windowsUnsupported();

  return { command: 'sudo -n systemctl reload nginx 2>&1 || sudo -n nginx -s reload 2>&1 || nginx -s reload 2>&1' };
}

export function createNginxDeleteCommand(filePath: string, installation: NginxInstallation, isWindowsHost = false): RemoteCommandInput {
  if (isWindowsHost) return windowsUnsupported();

  const backupDir = `${installation.configDir}/.shelldesk-backups`;
  const backupPrefix = `${backupDir}/${basename(filePath)}.`;
  const unlinkEnabled = installation.enabledDir && !isPathUnder(filePath, installation.enabledDir)
    ? `rm -f -- ${shellSingleQuote(`${installation.enabledDir}/${basename(filePath).replace(/\.disabled$/i, '')}`)}; `
    : '';

  return {
    command: sudoCommand(`mkdir -p ${shellSingleQuote(backupDir)}; ${unlinkEnabled}mv -- ${shellSingleQuote(filePath)} ${shellSingleQuote(backupPrefix)}$(date +%Y%m%d%H%M%S)`),
  };
}

export function createNginxMoveConfigToBackupCommand(filePath: string, backupPath: string, installation: NginxInstallation, isWindowsHost = false): RemoteCommandInput {
  if (isWindowsHost) return windowsUnsupported();

  const safeFilename = basename(filePath).replace(/\.disabled$/i, '');
  const unlinkEnabled = installation.enabledDir && !isPathUnder(filePath, installation.enabledDir)
    ? `rm -f -- ${shellSingleQuote(`${installation.enabledDir}/${safeFilename}`)}; `
    : '';

  return {
    command: sudoCommand(`mkdir -p ${shellSingleQuote(basename(backupPath) === backupPath ? installation.configDir : backupPath.replace(/\/[^/]*$/, ''))}; ${unlinkEnabled}mv -- ${shellSingleQuote(filePath)} ${shellSingleQuote(backupPath)}`),
  };
}

export function createNginxRestoreDeletedConfigCommand(backupPath: string, originalPath: string, installation: NginxInstallation, enabled: boolean, isWindowsHost = false): RemoteCommandInput {
  if (isWindowsHost) return windowsUnsupported();

  const safeFilename = basename(originalPath).replace(/\.disabled$/i, '');
  const restoreEnabled = enabled && installation.sitesLayout === 'debian' && installation.enabledDir && !isPathUnder(originalPath, installation.enabledDir)
    ? `; ln -sf ${shellSingleQuote(originalPath)} ${shellSingleQuote(`${installation.enabledDir}/${safeFilename}`)}`
    : '';

  return { command: sudoCommand(`mv -- ${shellSingleQuote(backupPath)} ${shellSingleQuote(originalPath)}${restoreEnabled}`) };
}

export function createNginxCleanupCreatedConfigCommand(filePath: string, installation: NginxInstallation, isWindowsHost = false): RemoteCommandInput {
  if (isWindowsHost) return windowsUnsupported();

  const safeFilename = basename(filePath).replace(/\.disabled$/i, '');
  const unlinkEnabled = installation.enabledDir && !isPathUnder(filePath, installation.enabledDir)
    ? `rm -f -- ${shellSingleQuote(`${installation.enabledDir}/${safeFilename}`)}; `
    : '';

  return { command: sudoCommand(`${unlinkEnabled}rm -f -- ${shellSingleQuote(filePath)}`) };
}

// Used by backup/restore UI (future)
export function createNginxListBackupsCommand(configDir: string, isWindowsHost = false): RemoteCommandInput {
  if (isWindowsHost) return windowsUnsupported();

  return { command: `ls -la -- ${shellSingleQuote(`${configDir}/.shelldesk-backups`)} 2>&1` };
}

// Used by backup/restore UI (future)
export function createNginxRestoreBackupCommand(backupPath: string, originalPath: string, isWindowsHost = false): RemoteCommandInput {
  if (isWindowsHost) return windowsUnsupported();

  return { command: sudoCommand(`cp -- ${shellSingleQuote(backupPath)} ${shellSingleQuote(originalPath)}`) };
}
