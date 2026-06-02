import { powershellCommand, powershellSingleQuote } from './remoteSystem';
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

function shellSingleQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function clampTimeout(value: number) {
  if (!Number.isFinite(value)) return 10;
  return Math.min(Math.max(Math.round(value), 1), 120);
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

function joinUrl(baseUrl: string, path: string) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizeBaseUrl(baseUrl)}${normalizedPath}`;
}

function getAuthText(config: SearchClusterConnectionConfig) {
  const username = config.username.trim();

  if (!username) {
    return '';
  }

  return `${username}:${config.password}`;
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

export function createSearchClusterCommand(
  config: SearchClusterConnectionConfig,
  path: string,
  options: { method?: 'GET' | 'POST'; body?: string; isWindowsHost: boolean },
): { command: string; stdin?: string } {
  const url = joinUrl(config.url, path);
  const timeout = clampTimeout(config.timeoutSeconds);
  const method = options.method ?? 'GET';
  const body = options.body ?? '';
  const authText = getAuthText(config);
  const insecureArg = config.ignoreSslCertificate ? '--insecure' : '';

  if (options.isWindowsHost) {
    const authArgs = authText ? `$curlArgs += @("-u", ${powershellSingleQuote(authText)})` : '';
    const insecureArgs = insecureArg ? `$curlArgs += @(${powershellSingleQuote(insecureArg)})` : '';
    const bodySetup = body ? `
$bodyFile = New-TemporaryFile
[System.IO.File]::WriteAllText($bodyFile.FullName, ${powershellSingleQuote(body)}, [System.Text.UTF8Encoding]::new($false))
$curlArgs += @("-H", "Content-Type: application/json", "--data-binary", "@$($bodyFile.FullName)")
` : '$bodyFile = $null';

    return {
      command: powershellCommand(`
$curlArgs = @("-sS", "--max-time", "${timeout}", "-X", "${method}")
${authArgs}
${insecureArgs}
${bodySetup}
$curlArgs += @(${powershellSingleQuote(url)})
& curl.exe @curlArgs
$curlCode = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }
if ($bodyFile) { Remove-Item -LiteralPath $bodyFile.FullName -Force -ErrorAction SilentlyContinue }
exit $curlCode
`),
    };
  }

  const authArgs = authText ? `-u ${shellSingleQuote(authText)}` : '';
  const insecureArgs = insecureArg ? shellSingleQuote(insecureArg) : '';

  if (body) {
    return {
      command: tCurrent('auto.searchClusterUtils.lzad6z', { value0: timeout, value1: method, value2: insecureArgs, value3: authArgs, value4: shellSingleQuote(url) }),
      stdin: body,
    };
  }

  return {
    command: tCurrent('auto.searchClusterUtils.18nh1h0', { value0: timeout, value1: method, value2: insecureArgs, value3: authArgs, value4: shellSingleQuote(url) }),
  };
}

export function parseJsonResponse<T>(stdout: string, stderr: string, code: number, label: string): T {
  if (code !== 0) {
    throw new Error(stderr || stdout || tCurrent('auto.searchClusterUtils.57s8f6', { value0: label, value1: code }));
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(tCurrent('auto.searchClusterUtils.1m1c877', { value0: label }));
  }

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
