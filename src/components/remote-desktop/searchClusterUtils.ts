import { powershellCommand, powershellSingleQuote } from './remoteSystem';

export interface SearchClusterConnectionConfig {
  url: string;
  username: string;
  password: string;
  timeoutSeconds: number;
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
    throw new Error('请输入有效的集群 URL。');
  }

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(trimmed);
  } catch {
    throw new Error('集群 URL 格式不正确。');
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('仅支持 http:// 或 https:// 集群 URL。');
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

  if (options.isWindowsHost) {
    const authArgs = authText ? `$curlArgs += @("-u", ${powershellSingleQuote(authText)})` : '';
    const bodySetup = body ? `
$bodyFile = New-TemporaryFile
[System.IO.File]::WriteAllText($bodyFile.FullName, ${powershellSingleQuote(body)}, [System.Text.UTF8Encoding]::new($false))
$curlArgs += @("-H", "Content-Type: application/json", "--data-binary", "@$($bodyFile.FullName)")
` : '$bodyFile = $null';

    return {
      command: powershellCommand(`
$curlArgs = @("-sS", "--max-time", "${timeout}", "-X", "${method}")
${authArgs}
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

  if (body) {
    return {
      command: `
if ! command -v curl >/dev/null 2>&1; then
  printf 'curl 未安装或当前 PATH 不可用。\\n' >&2
  exit 127
fi
body_file=$(mktemp "\${TMPDIR:-/tmp}/shelldesk-search-body.XXXXXX")
cat > "$body_file"
curl -sS --max-time ${timeout} -X ${method} ${authArgs} -H 'Content-Type: application/json' --data-binary "@$body_file" ${shellSingleQuote(url)}
curl_code=$?
rm -f "$body_file"
exit "$curl_code"
`,
      stdin: body,
    };
  }

  return {
    command: `
if ! command -v curl >/dev/null 2>&1; then
  printf 'curl 未安装或当前 PATH 不可用。\\n' >&2
  exit 127
fi
curl -sS --max-time ${timeout} -X ${method} ${authArgs} ${shellSingleQuote(url)}
`,
  };
}

export function parseJsonResponse<T>(stdout: string, stderr: string, code: number, label: string): T {
  if (code !== 0) {
    throw new Error(stderr || stdout || `${label} 请求失败，退出码 ${code}`);
  }

  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(`${label} 返回不是有效 JSON。`);
  }
}

export function normalizeIndices(rows: Array<Record<string, unknown>>): SearchClusterIndex[] {
  return rows.map((row) => ({
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

export function normalizeShards(rows: Array<Record<string, unknown>>): SearchClusterShard[] {
  return rows.map((row) => ({
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
