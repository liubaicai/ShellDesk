import type { FrpsConfig, FrpsProxyInfo, FrpsServiceMode } from './frpsTypes';

function parseValue(rawValue: string): string | number | boolean {
  const trimmed = rawValue.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  const numberValue = Number(trimmed);
  return Number.isFinite(numberValue) ? numberValue : trimmed;
}

function asNumber(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function asBoolean(value: unknown, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

function asRecord(value: unknown) {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function asLogLevel(value: unknown): FrpsConfig['logLevel'] {
  return value === 'trace' || value === 'debug' || value === 'warn' || value === 'error' ? value : 'info';
}

export function parseFrpsDetectOutput(stdout: string) {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const installed = lines.some((line) => line === 'installed=true') || lines.some((line) => /frps/i.test(line) && /version|v?\d+\.\d+/i.test(line));
  const versionLine = lines.find((line) => line.startsWith('version='))?.replace(/^version=/, '').trim()
    || lines.find((line) => /^v?\d+\.\d+\.\d+/.test(line) || /frps/i.test(line)) || '';
  const systemdAvailable = lines.includes('systemd=true') || lines.some((line) => /^#\s*\/.*frps\.service/.test(line));
  const explicitConfigPath = lines.find((line) => line.startsWith('configPath='))?.replace(/^configPath=/, '').trim();
  const configPathLine = lines.find((line) => /frps\.toml/i.test(line));
  const extractedConfigPath = configPathLine?.match(/(?:-c\s+|^)(%USERPROFILE%\\\.frp\\frps\.toml|[^\s"']*frps\.toml)/i)?.[1];
  const configPath = explicitConfigPath || extractedConfigPath || (lines.some((line) => line.includes('%USERPROFILE%')) ? '%USERPROFILE%\\.frp\\frps.toml' : '/etc/frp/frps.toml');

  return {
    installed,
    version: versionLine.replace(/^frps\s+version\s+/i, '').trim(),
    systemdAvailable,
    configPath,
  };
}

export function parseFrpsStatusOutput(stdout: string, serviceMode: FrpsServiceMode) {
  const text = stdout.trim().toLowerCase();
  if (serviceMode === 'systemd') {
    return text.split(/\s+/).includes('active');
  }
  return text.split(/\s+/).some((token) => /^\d+$/.test(token));
}

export function parseFrpsConfigToml(content: string): FrpsConfig {
  const values: Record<string, unknown> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trim();
    if (!line) continue;
    const match = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    values[key] = parseValue(rawValue);
  }

  return {
    bindAddr: asString(values.bindAddr, '0.0.0.0'),
    bindPort: asNumber(values.bindPort, 7000),
    token: asString(values['auth.token'] ?? values.token),
    vhostHTTPPort: asNumber(values.vhostHTTPPort, 80),
    vhostHTTPSPort: asNumber(values.vhostHTTPSPort, 443),
    subDomainHost: asString(values.subDomainHost),
    dashboardAddr: asString(values['webServer.addr'] ?? values.dashboardAddr, '0.0.0.0'),
    dashboardPort: asNumber(values['webServer.port'] ?? values.dashboardPort, 7500),
    dashboardUser: asString(values['webServer.user'] ?? values.dashboardUser, 'admin'),
    dashboardPassword: asString(values['webServer.password'] ?? values.dashboardPassword, 'admin'),
    logTo: asString(values['log.to'] ?? values.logTo, '/var/log/frps.log'),
    logLevel: asLogLevel(values['log.level'] ?? values.logLevel),
    logMaxDays: asNumber(values['log.maxDays'] ?? values.logMaxDays, 3),
    maxPoolCount: asNumber(values['transport.maxPoolCount'] ?? values.maxPoolCount, 10),
    tcpMux: asBoolean(values['transport.tcpMux'] ?? values.tcpMux, true),
  };
}

export function parseFrpsDashboardApi(response: string): FrpsProxyInfo[] {
  const blocks = response
    .split(/__SHELLDESK_FRPS_PROXY_TYPE__=([a-z0-9-]+)/i)
    .slice(1);
  if (blocks.length) {
    const parsedItems: FrpsProxyInfo[] = [];
    for (let index = 0; index < blocks.length; index += 2) {
      parsedItems.push(...parseFrpsDashboardPayload(blocks[index + 1] || '', blocks[index]));
    }
    return parsedItems;
  }
  return parseFrpsDashboardPayload(response);
}

function parseFrpsDashboardPayload(response: string, fallbackType = ''): FrpsProxyInfo[] {
  try {
    const payload = JSON.parse(response) as unknown;
    const source = Array.isArray(payload)
      ? payload
      : typeof payload === 'object' && payload
        ? Object.values(payload as Record<string, unknown>).flatMap((value) => Array.isArray(value) ? value : [])
        : [];

    return source
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => {
        const conf = asRecord(item.conf);
        const statusText = String(item.status ?? item.phase ?? '').toLowerCase();
        const status: FrpsProxyInfo['status'] = statusText.includes('online') || statusText.includes('active') || statusText.includes('running') ? 'online' : 'offline';
        return {
          name: String(item.name ?? item.proxyName ?? conf.name ?? ''),
          type: String(item.type ?? item.proxyType ?? conf.type ?? fallbackType),
          status,
          clientAddr: String(item.clientAddr ?? item.clientAddress ?? item.remoteAddr ?? ''),
          lastStartTime: typeof item.lastStartTime === 'string' ? item.lastStartTime : undefined,
          lastCloseTime: typeof item.lastCloseTime === 'string' ? item.lastCloseTime : undefined,
          trafficIn: asNumber(item.todayTrafficIn ?? item.trafficIn, 0),
          trafficOut: asNumber(item.todayTrafficOut ?? item.trafficOut, 0),
          curConns: asNumber(item.curConns ?? item.connections, 0),
        };
      })
      .filter((item) => item.name);
  } catch {
    return [];
  }
}

export function parseFrpsLogs(stdout: string) {
  return stdout
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !/^-- No entries --$/i.test(line))
    .join('\n');
}
