import { powershellStdinCommand, type RemoteCommandInput } from './remoteSystem';
import { shellSingleQuote } from './shellUtils';
import type { ApacheDistro, ApacheInstallation, ApacheSitesLayout } from './apacheManagerTypes';

const apacheFieldMarker = '__SHELLDESK_APACHE_FIELD__';
const apacheFileMarker = '__SHELLDESK_APACHE_FILE__';
const apacheTemplateMarker = '__SHELLDESK_APACHE_TEMPLATE__';

function windowsUnsupported(marker = apacheFieldMarker): RemoteCommandInput {
  return powershellStdinCommand(`[Console]::Out.WriteLine("${marker}|error|Apache Manager does not support Windows hosts.")`);
}

function sudoCommand(command: string) {
  return `if [ "$(id -u 2>/dev/null)" = "0" ]; then sh -c ${shellSingleQuote(command)}; else sudo -n sh -c ${shellSingleQuote(command)}; fi`;
}

function basename(filePath: string) {
  return filePath.split(/[\\/]/).pop() || filePath;
}

function dirname(filePath: string) {
  return filePath.replace(/\/[^/]*$/, '') || '/';
}

function normalizeNullable(value: string) {
  const trimmed = value.trim();
  return trimmed && trimmed !== 'null' ? trimmed : null;
}

function first(values: Map<string, string>, key: string, fallback = '') {
  return values.get(key)?.trim() || fallback;
}

function parseDistro(value: string): ApacheDistro {
  if (value === 'debian' || value === 'rhel' || value === 'alpine') return value;
  return 'unknown';
}

function parseSitesLayout(value: string): ApacheSitesLayout {
  return value === 'debian' ? 'debian' : 'rhel';
}

function createHeredocDelimiter(content: string) {
  let delimiter = 'SHELLDESK_APACHE_CONFIG_EOF';
  let index = 0;
  while (content.includes(delimiter)) {
    index += 1;
    delimiter = `SHELLDESK_APACHE_CONFIG_EOF_${index}`;
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

export function validateApacheConfigPath(filePath: string, installation: ApacheInstallation) {
  return (
    filePath === installation.configPath
    || isPathUnder(filePath, installation.configDir)
    || isPathUnder(filePath, installation.availableDir)
    || isPathUnder(filePath, installation.enabledDir)
    || isPathUnder(filePath, installation.confDir)
  );
}

export function createApacheDetectCommand(isWindowsHost = false): RemoteCommandInput {
  if (isWindowsHost) return windowsUnsupported();

  return {
    command: `
emit() { printf '${apacheFieldMarker}|%s|%s\\n' "$1" "$2"; }
distro=unknown
if [ -f /etc/os-release ]; then
  os_id="$(sed -n 's/^ID=//p' /etc/os-release | tr -d '"' | head -n 1)"
  os_like="$(sed -n 's/^ID_LIKE=//p' /etc/os-release | tr -d '"' | head -n 1)"
  case "$os_id $os_like" in
    *alpine*) distro=alpine ;;
    *debian*|*ubuntu*) distro=debian ;;
    *rhel*|*fedora*|*centos*) distro=rhel ;;
  esac
fi
if [ "$distro" = "unknown" ]; then
  uname_value="$(uname -a 2>/dev/null || true)"
  case "$uname_value" in
    *Alpine*) distro=alpine ;;
    *Debian*|*Ubuntu*) distro=debian ;;
    *Red\\ Hat*|*CentOS*|*Fedora*) distro=rhel ;;
  esac
fi
if command -v apache2ctl >/dev/null 2>&1; then
  control_bin="$(command -v apache2ctl)"
elif command -v apachectl >/dev/null 2>&1; then
  control_bin="$(command -v apachectl)"
else
  control_bin=""
fi
if command -v apache2 >/dev/null 2>&1; then
  server_bin="$(command -v apache2)"
elif command -v httpd >/dev/null 2>&1; then
  server_bin="$(command -v httpd)"
else
  server_bin=""
fi
if [ -z "$control_bin" ] && [ -z "$server_bin" ]; then
  emit found false
  exit 0
fi
[ -n "$control_bin" ] || control_bin="$server_bin"
version="$($server_bin -v 2>/dev/null | sed -n 's/^Server version:[[:space:]]*//p' | head -n 1)"
[ -n "$version" ] || version="$($control_bin -v 2>/dev/null | sed -n 's/^Server version:[[:space:]]*//p' | head -n 1)"
if [ "$distro" = "debian" ] || [ -d /etc/apache2 ]; then
  config_path="/etc/apache2/apache2.conf"
  config_dir="/etc/apache2"
  modules_dir="/etc/apache2/mods-enabled"
  available_dir="/etc/apache2/sites-available"
  enabled_dir="/etc/apache2/sites-enabled"
  conf_dir="/etc/apache2/conf-enabled"
  log_dir="/var/log/apache2"
  sites_layout=debian
  service_name=apache2
else
  config_path="/etc/httpd/conf/httpd.conf"
  config_dir="/etc/httpd"
  modules_dir="/etc/httpd/conf.modules.d"
  available_dir=""
  enabled_dir=""
  conf_dir="/etc/httpd/conf.d"
  log_dir="/var/log/httpd"
  sites_layout=rhel
  service_name=httpd
fi
loaded_modules="$($control_bin -M 2>/dev/null | awk '{print $1}' | sed 's/_module$//' | paste -sd ',' -)"
if command -v systemctl >/dev/null 2>&1; then
  is_running="$(systemctl is-active "$service_name" 2>/dev/null | grep -qx active && printf true || printf false)"
else
  is_running="$(pgrep -x apache2 >/dev/null 2>&1 || pgrep -x httpd >/dev/null 2>&1; if [ "$?" = "0" ]; then printf true; else printf false; fi)"
fi
emit found true
emit version "$version"
emit configPath "$config_path"
emit configDir "$config_dir"
emit modulesDir "$modules_dir"
emit availableDir "$available_dir"
emit enabledDir "$enabled_dir"
emit confDir "$conf_dir"
emit logDir "$log_dir"
emit binaryPath "$control_bin"
emit distro "$distro"
emit sitesLayout "$sites_layout"
emit isRunning "$is_running"
emit loadedModules "$loaded_modules"
`.trim(),
  };
}

export function parseApacheDetectOutput(stdout: string): ApacheInstallation | null {
  const values = new Map<string, string>();

  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^__SHELLDESK_APACHE_FIELD__\|([^|]+)\|(.*)$/);
    if (match) values.set(match[1], match[2]);
  }

  if (first(values, 'found') === 'false' || !values.has('version')) return null;

  const configDir = first(values, 'configDir', '/etc/apache2');

  return {
    version: first(values, 'version'),
    configPath: first(values, 'configPath', `${configDir}/apache2.conf`),
    configDir,
    modulesDir: first(values, 'modulesDir', `${configDir}/mods-enabled`),
    availableDir: normalizeNullable(first(values, 'availableDir')),
    enabledDir: normalizeNullable(first(values, 'enabledDir')),
    confDir: first(values, 'confDir', `${configDir}/conf-enabled`),
    logDir: first(values, 'logDir', '/var/log/apache2'),
    binaryPath: first(values, 'binaryPath', 'apache2ctl'),
    distro: parseDistro(first(values, 'distro')),
    sitesLayout: parseSitesLayout(first(values, 'sitesLayout')),
    isRunning: first(values, 'isRunning') === 'true',
    loadedModules: first(values, 'loadedModules').split(',').map((value) => value.trim()).filter(Boolean),
  };
}

export function createApacheListConfigsCommand(installation: ApacheInstallation, isWindowsHost = false): RemoteCommandInput {
  if (isWindowsHost) return windowsUnsupported(apacheFileMarker);

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
  printf '${apacheFileMarker}|%s|%s|%s|%s\\n' "$file" "$enabled" "$size" "$mtime"
}
is_enabled_debian() {
  file="$1"
  [ -n "$enabled_dir" ] && [ -e "$enabled_dir/$(basename "$file")" ]
}
if [ -n "$available_dir" ] && [ -d "$available_dir" ]; then
  find "$available_dir" -maxdepth 1 -type f -name '*.conf' 2>/dev/null | sort | while IFS= read -r file; do
    if is_enabled_debian "$file"; then emit_file "$file" true; else emit_file "$file" false; fi
  done
fi
if [ -d "$conf_dir" ]; then
  find "$conf_dir" -maxdepth 1 -type f \\( -name '*.conf' -o -name '*.conf.disabled' \\) 2>/dev/null | sort | while IFS= read -r file; do
    case "$file" in
      *.disabled) emit_file "$file" false ;;
      *) emit_file "$file" true ;;
    esac
  done
fi
`.trim(),
  };
}

export function parseApacheListConfigs(stdout: string): { path: string; enabled: boolean; size: number; mtime: number }[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.match(/^__SHELLDESK_APACHE_FILE__\|([^|]+)\|(true|false)\|(\d+)\|(\d+)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({
      path: match[1],
      enabled: match[2] === 'true',
      size: Number(match[3]),
      mtime: Number(match[4]),
    }));
}

export interface ApacheTemplateTargetBackup {
  exists: boolean;
  backupPath: string | null;
  wasEnabled: boolean;
}

export function parseApacheTemplateTargetBackup(stdout: string): ApacheTemplateTargetBackup {
  const values = new Map<string, string>();

  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^__SHELLDESK_APACHE_TEMPLATE__\|([^|]+)\|(.*)$/);
    if (match) values.set(match[1], match[2]);
  }

  return {
    exists: values.get('exists') === 'true',
    backupPath: normalizeNullable(values.get('backupPath') ?? ''),
    wasEnabled: values.get('wasEnabled') === 'true',
  };
}

export function createApachePrepareTemplateTargetCommand(filePath: string, installation: ApacheInstallation, isWindowsHost = false): RemoteCommandInput {
  if (isWindowsHost) return windowsUnsupported();

  const safeFilename = basename(filePath).replace(/\.disabled$/i, '');
  const enabledPath = installation.sitesLayout === 'debian' && installation.enabledDir
    ? `${installation.enabledDir}/${safeFilename}`
    : '';
  const enabledPathAssignment = enabledPath ? shellSingleQuote(enabledPath) : "''";

  return {
    command: sudoCommand(`
target=${shellSingleQuote(filePath)}
enabled_path=${enabledPathAssignment}
emit() { printf '${apacheTemplateMarker}|%s|%s\\n' "$1" "$2"; }
if [ -d "$target" ]; then
  printf 'Target path is a directory: %s\\n' "$target" >&2
  exit 1
fi
was_enabled=false
if [ -n "$enabled_path" ] && [ -e "$enabled_path" ]; then
  was_enabled=true
fi
if [ -e "$target" ]; then
  backup="$target.shelldesk-template-backup.$(date +%Y%m%d%H%M%S).bak"
  cp -p -- "$target" "$backup"
  emit exists true
  emit backupPath "$backup"
  emit wasEnabled "$was_enabled"
else
  emit exists false
  emit backupPath ""
  emit wasEnabled false
fi
`.trim()),
  };
}

export function createApacheReadConfigCommand(filePath: string, isWindowsHost = false): RemoteCommandInput {
  if (isWindowsHost) return windowsUnsupported();
  return { command: `cat -- ${shellSingleQuote(filePath)} 2>/dev/null || sudo -n cat -- ${shellSingleQuote(filePath)}` };
}

export function createApacheEnableSiteCommand(filePath: string, installation: ApacheInstallation, isWindowsHost = false): RemoteCommandInput {
  if (isWindowsHost) return windowsUnsupported();

  const safeFilename = basename(filePath);
  if (installation.sitesLayout === 'debian' && installation.availableDir && installation.enabledDir) {
    const source = `${installation.availableDir}/${safeFilename}`;
    const target = `${installation.enabledDir}/${safeFilename}`;
    return { command: sudoCommand(`ln -sf ${shellSingleQuote(source)} ${shellSingleQuote(target)}`) };
  }

  const disabled = `${installation.confDir}/${safeFilename.replace(/\.conf$/i, '')}.conf.disabled`;
  const enabled = `${installation.confDir}/${safeFilename.replace(/\.disabled$/i, '')}`;
  return { command: sudoCommand(`mv ${shellSingleQuote(disabled)} ${shellSingleQuote(enabled)}`) };
}

export function createApacheDisableSiteCommand(filePath: string, installation: ApacheInstallation, isWindowsHost = false): RemoteCommandInput {
  if (isWindowsHost) return windowsUnsupported();

  const safeFilename = basename(filePath);
  if (installation.sitesLayout === 'debian' && installation.enabledDir) {
    return { command: sudoCommand(`rm -f -- ${shellSingleQuote(`${installation.enabledDir}/${safeFilename}`)}`) };
  }

  const target = filePath.endsWith('.disabled') ? filePath : `${filePath}.disabled`;
  return { command: sudoCommand(`mv ${shellSingleQuote(filePath)} ${shellSingleQuote(target)}`) };
}

export function createApacheBackupCommand(filePath: string, isWindowsHost = false): RemoteCommandInput {
  if (isWindowsHost) return windowsUnsupported();
  return { command: sudoCommand(`cp -- ${shellSingleQuote(filePath)} ${shellSingleQuote(`${filePath}.bak`)}.$(date +%Y%m%d%H%M%S)`) };
}

export function createApacheWriteConfigCommand(filePath: string, content: string, isWindowsHost = false): RemoteCommandInput {
  if (isWindowsHost) return windowsUnsupported();
  const delimiter = createHeredocDelimiter(content);

  return {
    command: `
tmp="$(mktemp 2>/dev/null || printf "/tmp/shelldesk-apache-write-$$")"
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

export function createApacheTestCommand(isWindowsHost = false): RemoteCommandInput {
  if (isWindowsHost) return windowsUnsupported();
  return { command: 'sudo -n apachectl configtest 2>&1 || sudo -n apache2ctl configtest 2>&1 || sudo -n httpd -t 2>&1 || apachectl configtest 2>&1 || apache2ctl configtest 2>&1 || httpd -t 2>&1' };
}

export function createApacheReloadCommand(isWindowsHost = false): RemoteCommandInput {
  if (isWindowsHost) return windowsUnsupported();
  return { command: 'sudo -n systemctl reload apache2 2>&1 || sudo -n systemctl reload httpd 2>&1 || sudo -n apachectl graceful 2>&1 || sudo -n apache2ctl graceful 2>&1 || sudo -n httpd -k graceful 2>&1 || apachectl graceful 2>&1 || apache2ctl graceful 2>&1 || httpd -k graceful 2>&1' };
}

export function createApacheMoveConfigToBackupCommand(filePath: string, backupPath: string, installation: ApacheInstallation, isWindowsHost = false): RemoteCommandInput {
  if (isWindowsHost) return windowsUnsupported();

  const safeFilename = basename(filePath).replace(/\.disabled$/i, '');
  const unlinkEnabled = installation.enabledDir
    ? `rm -f -- ${shellSingleQuote(`${installation.enabledDir}/${safeFilename}`)}; `
    : '';

  return { command: sudoCommand(`mkdir -p ${shellSingleQuote(dirname(backupPath))}; ${unlinkEnabled}mv -- ${shellSingleQuote(filePath)} ${shellSingleQuote(backupPath)}`) };
}

export function createApacheRestoreDeletedConfigCommand(backupPath: string, filePath: string, installation: ApacheInstallation, isEnabled: boolean, isWindowsHost = false): RemoteCommandInput {
  if (isWindowsHost) return windowsUnsupported();

  const safeFilename = basename(filePath).replace(/\.disabled$/i, '');
  const restoreEnabled = isEnabled && installation.sitesLayout === 'debian' && installation.enabledDir
    ? `; ln -sf ${shellSingleQuote(filePath)} ${shellSingleQuote(`${installation.enabledDir}/${safeFilename}`)}`
    : '';

  return { command: sudoCommand(`mv -- ${shellSingleQuote(backupPath)} ${shellSingleQuote(filePath)}${restoreEnabled}`) };
}

export function createApacheCleanupCreatedConfigCommand(filePath: string, installation: ApacheInstallation, isWindowsHost = false): RemoteCommandInput {
  if (isWindowsHost) return windowsUnsupported();

  const safeFilename = basename(filePath).replace(/\.disabled$/i, '');
  const unlinkEnabled = installation.enabledDir
    ? `rm -f -- ${shellSingleQuote(`${installation.enabledDir}/${safeFilename}`)}; `
    : '';

  return { command: sudoCommand(`${unlinkEnabled}rm -f -- ${shellSingleQuote(filePath)}`) };
}

export function createApacheRollbackTemplateConfigCommand(filePath: string, backupPath: string | null, wasEnabled: boolean, installation: ApacheInstallation, isWindowsHost = false): RemoteCommandInput {
  if (isWindowsHost) return windowsUnsupported();

  if (!backupPath) return createApacheCleanupCreatedConfigCommand(filePath, installation, isWindowsHost);

  const safeFilename = basename(filePath).replace(/\.disabled$/i, '');
  const enabledPath = installation.sitesLayout === 'debian' && installation.enabledDir
    ? `${installation.enabledDir}/${safeFilename}`
    : '';
  const resetEnabled = enabledPath ? `rm -f -- ${shellSingleQuote(enabledPath)}; ` : '';
  const restoreEnabled = wasEnabled && enabledPath
    ? `; ln -sf ${shellSingleQuote(filePath)} ${shellSingleQuote(enabledPath)}`
    : '';

  return { command: sudoCommand(`${resetEnabled}cp -p -- ${shellSingleQuote(backupPath)} ${shellSingleQuote(filePath)}${restoreEnabled}`) };
}
