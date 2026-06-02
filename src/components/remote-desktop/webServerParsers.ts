import { powershellStdinCommand, type RemoteCommandInput } from './remoteSystem';
import { tCurrent } from '../../i18n';

export type WebServerKind = 'nginx' | 'apache' | 'caddy';
export type WebServerAction = 'test' | 'reload' | 'restart';

export interface WebServerService {
  kind: WebServerKind;
  binary: string;
  serviceName: string;
  version: string;
  status: string;
  available: boolean;
}

export interface WebSiteConfigSummary {
  id: string;
  kind: WebServerKind;
  enabled: boolean;
  filePath: string;
  serverNames: string[];
  listens: string[];
  root?: string;
  accessLog?: string;
  errorLog?: string;
  certificateFiles: string[];
  rawConfig: string;
}

export interface WebServerSnapshot {
  services: WebServerService[];
  sites: WebSiteConfigSummary[];
  rawOutput: string;
}

function shellSingleQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function uniq(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function firstMatch(text: string, pattern: RegExp) {
  return text.match(pattern)?.[1]?.trim();
}

function allMatches(text: string, pattern: RegExp) {
  return uniq(Array.from(text.matchAll(pattern)).flatMap((match) => (
    match[1]?.split(/\s+/).map((value) => value.replace(/;$/, '')) ?? []
  )));
}

function stripQuotes(value?: string) {
  return value?.trim().replace(/^['"]|['"]$/g, '');
}

function sanitizeServiceName(serviceName: string, fallback: string) {
  const value = serviceName.trim() || fallback;

  if (!/^[a-zA-Z0-9_.@-]{1,80}$/.test(value)) {
    throw new Error(tCurrent('auto.webServerParsers.173awd4'));
  }

  return value;
}

export function getWebServerLabel(kind: WebServerKind) {
  const labels: Record<WebServerKind, string> = {
    nginx: 'Nginx',
    apache: 'Apache',
    caddy: 'Caddy',
  };

  return labels[kind];
}

export function createWebServerSnapshotCommand(isWindowsHost: boolean): RemoteCommandInput {
  if (isWindowsHost) {
    return powershellStdinCommand(`
function Write-Service([string]$Kind, [string]$Binary, [string]$Service, [string]$Version) {
  $status = "unknown"
  try {
    $svc = Get-Service -Name $Service -ErrorAction SilentlyContinue
    if ($svc) { $status = $svc.Status.ToString() }
  } catch {}
  [Console]::Out.WriteLine("__SHELLDESK_WEB_SERVICE__|$Kind|$Binary|$Service|$status|$Version")
}
if (Get-Command nginx -ErrorAction SilentlyContinue) { Write-Service "nginx" "nginx" "nginx" ((nginx -v 2>&1 | Out-String).Trim()) }
if (Get-Command httpd -ErrorAction SilentlyContinue) { Write-Service "apache" "httpd" "Apache" ((httpd -v 2>&1 | Select-Object -First 1 | Out-String).Trim()) }
if (Get-Command caddy -ErrorAction SilentlyContinue) { Write-Service "caddy" "caddy" "caddy" ((caddy version 2>&1 | Out-String).Trim()) }
`);
  }

  return {
    command: `
service_status() {
  name="$1"
  systemctl is-active "$name" 2>/dev/null || service "$name" status >/dev/null 2>&1 && printf 'active' || printf 'unknown'
}
emit_service() {
  kind="$1"; binary="$2"; service="$3"; version="$4"
  status=$(service_status "$service")
  printf '__SHELLDESK_WEB_SERVICE__|%s|%s|%s|%s|%s\\n' "$kind" "$binary" "$service" "$status" "$version"
}
emit_file() {
  kind="$1"; enabled="$2"; file="$3"
  [ -f "$file" ] || return 0
  printf '__SHELLDESK_WEB_FILE__|%s|%s|%s\\n' "$kind" "$enabled" "$file"
  (cat "$file" 2>/dev/null || sudo -n cat "$file" 2>&1) | sed -n '1,260p'
  printf '\\n__SHELLDESK_WEB_END_FILE__\\n'
}
find_files() {
  kind="$1"; enabled="$2"; shift 2
  for target in "$@"; do
    if [ -f "$target" ]; then
      emit_file "$kind" "$enabled" "$target"
    elif [ -d "$target" ]; then
      find "$target" -maxdepth 2 -type f 2>/dev/null | sort | head -n 80 | while IFS= read -r file; do emit_file "$kind" "$enabled" "$file"; done
    fi
  done
}
if command -v nginx >/dev/null 2>&1; then
  emit_service nginx nginx nginx "$(nginx -v 2>&1 | head -n 1)"
  find_files nginx true /etc/nginx/sites-enabled /etc/nginx/conf.d
  find_files nginx false /etc/nginx/nginx.conf /etc/nginx/sites-available
fi
if command -v apache2 >/dev/null 2>&1 || command -v httpd >/dev/null 2>&1; then
  apache_bin=$(command -v apache2 >/dev/null 2>&1 && printf apache2 || printf httpd)
  apache_service=$(command -v apache2 >/dev/null 2>&1 && printf apache2 || printf httpd)
  emit_service apache "$apache_bin" "$apache_service" "$($apache_bin -v 2>&1 | head -n 1)"
  find_files apache true /etc/apache2/sites-enabled /etc/httpd/conf.d
  find_files apache false /etc/apache2/sites-available /etc/apache2/apache2.conf /etc/httpd/conf/httpd.conf
fi
if command -v caddy >/dev/null 2>&1; then
  emit_service caddy caddy caddy "$(caddy version 2>&1 | head -n 1)"
  find_files caddy true /etc/caddy/Caddyfile /etc/caddy/conf.d /usr/local/etc/caddy/Caddyfile
fi
`.trim(),
  };
}

export function createWebServerActionCommand(kind: WebServerKind, action: WebServerAction, serviceName: string, isWindowsHost: boolean): RemoteCommandInput {
  const service = sanitizeServiceName(serviceName, kind === 'apache' ? 'apache2' : kind);

  if (isWindowsHost) {
    if (action === 'test') {
      const command = kind === 'nginx'
        ? 'nginx -t'
        : kind === 'apache'
          ? 'httpd -t'
          : 'caddy validate';
      return powershellStdinCommand(`${command}; exit $LASTEXITCODE`);
    }

    const verb = action === 'reload' ? 'Restart-Service' : 'Restart-Service';
    return powershellStdinCommand(`${verb} -Name ${shellSingleQuote(service)} -ErrorAction Stop`);
  }

  if (kind === 'nginx') {
    if (action === 'test') return { command: 'sudo -n nginx -t 2>&1 || nginx -t 2>&1' };
    if (action === 'reload') return { command: `sudo -n systemctl reload ${shellSingleQuote(service)} 2>&1 || sudo -n nginx -s reload 2>&1 || nginx -s reload 2>&1` };
    return { command: `sudo -n systemctl restart ${shellSingleQuote(service)} 2>&1 || sudo -n service ${shellSingleQuote(service)} restart 2>&1` };
  }

  if (kind === 'apache') {
    if (action === 'test') return { command: 'sudo -n apachectl configtest 2>&1 || apachectl configtest 2>&1' };
    if (action === 'reload') return { command: `sudo -n systemctl reload ${shellSingleQuote(service)} 2>&1 || sudo -n service ${shellSingleQuote(service)} reload 2>&1` };
    return { command: `sudo -n systemctl restart ${shellSingleQuote(service)} 2>&1 || sudo -n service ${shellSingleQuote(service)} restart 2>&1` };
  }

  if (action === 'test') return { command: 'sudo -n caddy validate --config /etc/caddy/Caddyfile 2>&1 || caddy validate --config /etc/caddy/Caddyfile 2>&1 || caddy validate 2>&1' };
  if (action === 'reload') return { command: `sudo -n systemctl reload ${shellSingleQuote(service)} 2>&1 || sudo -n caddy reload --config /etc/caddy/Caddyfile 2>&1 || caddy reload --config /etc/caddy/Caddyfile 2>&1` };
  return { command: `sudo -n systemctl restart ${shellSingleQuote(service)} 2>&1 || sudo -n service ${shellSingleQuote(service)} restart 2>&1` };
}

function parseNginxSite(filePath: string, enabled: boolean, rawConfig: string): WebSiteConfigSummary {
  const serverNames = allMatches(rawConfig, /^\s*server_name\s+([^;]+);/gm);
  const listens = allMatches(rawConfig, /^\s*listen\s+([^;]+);/gm);
  const certificateFiles = allMatches(rawConfig, /^\s*ssl_certificate\s+([^;]+);/gm).map(stripQuotes).filter((value): value is string => Boolean(value));

  return {
    id: `nginx:${filePath}`,
    kind: 'nginx',
    enabled,
    filePath,
    serverNames: serverNames.length ? serverNames : [filePath.split(/[\\/]/).pop() ?? filePath],
    listens,
    root: stripQuotes(firstMatch(rawConfig, /^\s*root\s+([^;]+);/m)),
    accessLog: stripQuotes(firstMatch(rawConfig, /^\s*access_log\s+([^;\s]+).*;/m)),
    errorLog: stripQuotes(firstMatch(rawConfig, /^\s*error_log\s+([^;\s]+).*;/m)),
    certificateFiles,
    rawConfig,
  };
}

function parseApacheSite(filePath: string, enabled: boolean, rawConfig: string): WebSiteConfigSummary {
  const serverName = firstMatch(rawConfig, /^\s*ServerName\s+(.+)$/im);
  const aliases = allMatches(rawConfig, /^\s*ServerAlias\s+(.+)$/gim);
  const listens = allMatches(rawConfig, /^\s*<VirtualHost\s+([^>]+)>/gim);
  const certificateFiles = allMatches(rawConfig, /^\s*SSLCertificateFile\s+(.+)$/gim).map(stripQuotes).filter((value): value is string => Boolean(value));

  return {
    id: `apache:${filePath}`,
    kind: 'apache',
    enabled,
    filePath,
    serverNames: uniq([serverName ?? '', ...aliases]).length ? uniq([serverName ?? '', ...aliases]) : [filePath.split(/[\\/]/).pop() ?? filePath],
    listens,
    root: stripQuotes(firstMatch(rawConfig, /^\s*DocumentRoot\s+(.+)$/im)),
    accessLog: stripQuotes(firstMatch(rawConfig, /^\s*(?:CustomLog|TransferLog)\s+([^\s]+).*$/im)),
    errorLog: stripQuotes(firstMatch(rawConfig, /^\s*ErrorLog\s+([^\s]+).*$/im)),
    certificateFiles,
    rawConfig,
  };
}

function parseCaddySite(filePath: string, enabled: boolean, rawConfig: string): WebSiteConfigSummary {
  const blockNames = allMatches(rawConfig, /^\s*([^#\s{}][^{}]*?)\s*\{/gm)
    .filter((value) => !/^(handle|route|handle_path|reverse_proxy|header|tls|log)\b/i.test(value));
  const root = firstMatch(rawConfig, /^\s*root\s+\*?\s+(.+)$/im);
  const logFile = firstMatch(rawConfig, /^\s*output\s+file\s+(.+)$/im);
  const certs = allMatches(rawConfig, /^\s*tls\s+([^\s{}]+)(?:\s+([^\s{}]+))?/gim);

  return {
    id: `caddy:${filePath}`,
    kind: 'caddy',
    enabled,
    filePath,
    serverNames: blockNames.length ? blockNames : [filePath.split(/[\\/]/).pop() ?? filePath],
    listens: blockNames.filter((value) => /:\d+/.test(value)),
    root: stripQuotes(root),
    accessLog: stripQuotes(logFile),
    errorLog: undefined,
    certificateFiles: certs.map(stripQuotes).filter((value): value is string => Boolean(value) && value !== 'internal'),
    rawConfig,
  };
}

export function parseWebServerSnapshot(stdout: string, stderr: string): WebServerSnapshot {
  const rawOutput = [stdout, stderr].filter(Boolean).join('\n');
  const services: WebServerService[] = [];
  const sites: WebSiteConfigSummary[] = [];
  const lines = rawOutput.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (line.startsWith('__SHELLDESK_WEB_SERVICE__|')) {
      const [, kind = '', binary = '', serviceName = '', status = '', version = ''] = line.split('|');
      if (kind === 'nginx' || kind === 'apache' || kind === 'caddy') {
        services.push({ kind, binary, serviceName, status, version, available: true });
      }
      continue;
    }

    if (line.startsWith('__SHELLDESK_WEB_FILE__|')) {
      const [, kind = '', enabled = '', filePath = ''] = line.split('|');
      const contentLines: string[] = [];
      index += 1;

      while (index < lines.length && lines[index] !== '__SHELLDESK_WEB_END_FILE__') {
        contentLines.push(lines[index]);
        index += 1;
      }

      const rawConfig = contentLines.join('\n').trim();
      if (!rawConfig || !(kind === 'nginx' || kind === 'apache' || kind === 'caddy')) continue;

      const isEnabled = enabled === 'true';
      if (kind === 'nginx') sites.push(parseNginxSite(filePath, isEnabled, rawConfig));
      if (kind === 'apache') sites.push(parseApacheSite(filePath, isEnabled, rawConfig));
      if (kind === 'caddy') sites.push(parseCaddySite(filePath, isEnabled, rawConfig));
    }
  }

  return { services, sites, rawOutput };
}
