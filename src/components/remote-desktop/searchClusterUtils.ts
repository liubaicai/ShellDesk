import { tCurrent } from '../../i18n';

export interface SearchClusterConnectionConfig {
  url: string;
  username: string;
  password: string;
  timeoutSeconds: number;
  ignoreSslCertificate: boolean;
}

export interface SearchClusterHealth {
  cluster_name?: string;
  status?: 'green' | 'yellow' | 'red' | string;
  number_of_nodes?: number;
  number_of_data_nodes?: number;
  active_primary_shards?: number;
  active_shards?: number;
  relocating_shards?: number;
  initializing_shards?: number;
  unassigned_shards?: number;
}

export interface SearchClusterIndex {
  health: string;
  status: string;
  index: string;
  docsCount: number;
  docsDeleted: number;
  storeSize: string;
  pri: string;
  rep: string;
}

export interface SearchClusterShard {
  index: string;
  shard: string;
  prirep: string;
  state: string;
  docs: string;
  store: string;
  ip: string;
  node: string;
}

function normalizeBaseUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/, '');

  if (!trimmed || /[\r\n]/.test(trimmed)) {
    throw new Error(tCurrent('auto.searchClusterUtils.15lrf4g'));
  }

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(trimmed);
  } catch {
    throw new Error(tCurrent('auto.searchClusterUtils.1xfokcr'));
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(tCurrent('auto.searchClusterUtils.1atgbi'));
  }

  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function summarizeSearchError(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (isRecord(value)) {
    const reason = typeof value.reason === 'string' ? value.reason : '';
    const type = typeof value.type === 'string' ? value.type : '';

    if (reason && type) {
      return `${type}: ${reason}`;
    }

    if (reason || type) {
      return reason || type;
    }
  }

  try {
    return JSON.stringify(value);
  } catch {
    return tCurrent('auto.searchClusterUtils.1m4f5ms');
  }
}

export function createSearchClusterTunnelRequest(
  config: SearchClusterConnectionConfig,
  path: string,
  body?: unknown,
): ShellDeskHttpTunnelRequest {
  const url = new URL(normalizeBaseUrl(config.url));
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const basePath = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  const targetPort = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const username = config.username.trim();

  return {
    connectionId: '',
    targetHost: url.hostname,
    targetPort,
    path: `${basePath}${normalizedPath}`,
    auth: username ? { username, password: config.password } : null,
    body,
    ignoreSsl: config.ignoreSslCertificate,
    secure: url.protocol === 'https:',
    timeoutSeconds: config.timeoutSeconds,
  };
}

export function parseJsonResponse<T>(parsed: unknown, label: string): T {
  if (isRecord(parsed) && parsed.error !== undefined) {
    const status = parsed.status !== undefined ? `HTTP ${String(parsed.status)}` : tCurrent('auto.searchClusterUtils.1t4bmu5');
    throw new Error(tCurrent('auto.searchClusterUtils.gxlawy', { value0: label, value1: status, value2: summarizeSearchError(parsed.error) }));
  }

  return parsed as T;
}

function normalizeCatRows(rows: unknown, label: string): Array<Record<string, unknown>> {
  if (!Array.isArray(rows)) {
    throw new Error(tCurrent('auto.searchClusterUtils.1r2c3h2', { value0: label }));
  }

  return rows.filter(isRecord);
}

export function normalizeIndices(rows: unknown): SearchClusterIndex[] {
  return normalizeCatRows(rows, 'Indices').map((row) => ({
    health: String(row.health ?? ''),
    status: String(row.status ?? ''),
    index: String(row.index ?? ''),
    docsCount: Number(row['docs.count'] ?? 0),
    docsDeleted: Number(row['docs.deleted'] ?? 0),
    storeSize: String(row['store.size'] ?? row['pri.store.size'] ?? ''),
    pri: String(row.pri ?? ''),
    rep: String(row.rep ?? ''),
  })).filter((item) => item.index);
}

export function normalizeShards(rows: unknown): SearchClusterShard[] {
  return normalizeCatRows(rows, 'Shards').map((row) => ({
    index: String(row.index ?? ''),
    shard: String(row.shard ?? ''),
    prirep: String(row.prirep ?? ''),
    state: String(row.state ?? ''),
    docs: String(row.docs ?? ''),
    store: String(row.store ?? ''),
    ip: String(row.ip ?? ''),
    node: String(row.node ?? ''),
  })).filter((item) => item.index);
}
