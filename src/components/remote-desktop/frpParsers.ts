import type { FrpcConfig, FrpcProxy, FrpcProxyStatus, FrpcProxyType, FrpcServiceMode } from './frpTypes';

const proxyTypes = new Set<FrpcProxyType>(['tcp', 'udp', 'http', 'https', 'stcp', 'xtcp']);

function parseValue(rawValue: string): string | number | boolean | string[] {
  const trimmed = rawValue.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map((item) => parseValue(item))
      .filter((item): item is string => typeof item === 'string');
  }
  const numberValue = Number(trimmed);
  return Number.isFinite(numberValue) ? numberValue : trimmed;
}

function asProxyType(value: unknown): FrpcProxyType {
  return typeof value === 'string' && proxyTypes.has(value as FrpcProxyType) ? value as FrpcProxyType : 'tcp';
}

function asNumber(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;
}

export function parseFrpcDetectOutput(stdout: string) {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const installed = lines.some((line) => line === 'installed=true') || lines.some((line) => /frpc/i.test(line) && /version|v?\d+\.\d+/i.test(line));
  const versionLine = lines.find((line) => line.startsWith('version='))?.replace(/^version=/, '').trim()
    || lines.find((line) => /^v?\d+\.\d+\.\d+/.test(line) || /frpc/i.test(line)) || '';
  const systemdAvailable = lines.includes('systemd=true') || lines.some((line) => /^#\s*\/.*frpc\.service/.test(line));
  const explicitConfigPath = lines.find((line) => line.startsWith('configPath='))?.replace(/^configPath=/, '').trim();
  const configPathLine = lines.find((line) => /frpc\.toml/i.test(line));
  const extractedConfigPath = configPathLine?.match(/(?:-c\s+|^)(%USERPROFILE%\\\.frp\\frpc\.toml|[^\s"']*frpc\.toml)/i)?.[1];
  const configPath = explicitConfigPath || extractedConfigPath || (lines.some((line) => line.includes('%USERPROFILE%')) ? '%USERPROFILE%\\.frp\\frpc.toml' : '/etc/frp/frpc.toml');

  return {
    installed,
    version: versionLine.replace(/^frpc\s+version\s+/i, '').trim(),
    systemdAvailable,
    configPath,
  };
}

export function parseFrpcStatusOutput(stdout: string, serviceMode: FrpcServiceMode) {
  const text = stdout.trim().toLowerCase();
  if (serviceMode === 'systemd') {
    return text.split(/\s+/).includes('active');
  }
  return text.split(/\s+/).some((token) => /^\d+$/.test(token));
}

export function parseFrpcConfigToml(content: string): FrpcConfig {
  const config: FrpcConfig = {
    server: {
      serverAddr: '',
      serverPort: 7000,
      token: '',
    },
    proxies: [],
  };
  let currentProxy: Partial<FrpcProxy> | null = null;

  const finishProxy = () => {
    if (!currentProxy) return;
    const proxyValues = currentProxy as Partial<FrpcProxy> & Record<string, unknown>;
    config.proxies.push({
      name: asString(currentProxy.name, 'proxy'),
      type: asProxyType(currentProxy.type),
      localIP: asString(currentProxy.localIP, '127.0.0.1'),
      localPort: asNumber(currentProxy.localPort),
      remotePort: typeof currentProxy.remotePort === 'number' ? currentProxy.remotePort : undefined,
      customDomains: asStringArray(currentProxy.customDomains),
      subDomain: currentProxy.subDomain,
      secretKey: currentProxy.secretKey,
      encryption: typeof proxyValues['transport.useEncryption'] === 'boolean' ? proxyValues['transport.useEncryption'] : currentProxy.encryption,
      compression: typeof proxyValues['transport.useCompression'] === 'boolean' ? proxyValues['transport.useCompression'] : currentProxy.compression,
      locations: asStringArray(currentProxy.locations),
    });
  };

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trim();
    if (!line) continue;
    if (line === '[[proxies]]') {
      finishProxy();
      currentProxy = {};
      continue;
    }

    const match = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    const value = parseValue(rawValue);

    if (currentProxy) {
      (currentProxy as Record<string, unknown>)[key] = value;
      continue;
    }

    if (key === 'serverAddr') config.server.serverAddr = asString(value);
    if (key === 'serverPort') config.server.serverPort = asNumber(value, 7000);
    if (key === 'auth.token' || key === 'token') config.server.token = asString(value);
  }
  finishProxy();

  return config;
}

export function parseFrpcAdminApi(response: string) {
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
        const statusText = String(item.status ?? item.phase ?? '').toLowerCase();
        const status: FrpcProxyStatus = statusText.includes('online') || statusText.includes('active') || statusText.includes('running')
          ? 'active'
          : statusText.includes('error') || statusText.includes('fail')
            ? 'error'
            : statusText.includes('offline') || statusText.includes('inactive')
              ? 'inactive'
              : 'unknown';
        return {
          name: String(item.name ?? item.proxyName ?? ''),
          status,
          connections: asNumber(item.curConns ?? item.connections, 0),
          trafficIn: asNumber(item.todayTrafficIn ?? item.trafficIn, 0),
          trafficOut: asNumber(item.todayTrafficOut ?? item.trafficOut, 0),
        };
      })
      .filter((item) => item.name);
  } catch {
    return [];
  }
}

export function parseFrpcLogs(stdout: string) {
  return stdout
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !/^-- No entries --$/i.test(line))
    .join('\n');
}
