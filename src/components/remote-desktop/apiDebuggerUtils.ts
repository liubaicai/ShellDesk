import { powershellCommand, powershellSingleQuote } from './remoteSystem';
import { tCurrent } from '../../i18n';

export type ApiDebugMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';

export interface ApiDebugHeader {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
}

export interface ApiDebugRequest {
  id: string;
  method: ApiDebugMethod;
  url: string;
  headers: ApiDebugHeader[];
  body: string;
  timeoutSeconds: number;
}

export interface ApiDebugResponse {
  status?: number;
  durationMs: number;
  headersText: string;
  body: string;
  stderr?: string;
  exitCode: number;
  raw: string;
}

const markerToken = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
const metaMarker = `__SHELLDESK_API_META_${markerToken}__`;
const headersMarker = `__SHELLDESK_API_HEADERS_${markerToken}__`;
const bodyMarker = `__SHELLDESK_API_BODY_${markerToken}__`;
const exitMarker = `__SHELLDESK_API_EXIT_${markerToken}__`;

function shellSingleQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function clampTimeout(value: number) {
  if (!Number.isFinite(value)) {
    return 10;
  }

  return Math.min(Math.max(Math.round(value), 1), 120);
}

function validateUrl(value: string) {
  const trimmed = value.trim();

  if (!trimmed || /[\r\n]/.test(trimmed)) {
    throw new Error(tCurrent('auto.apiDebuggerUtils.nkx2v8'));
  }

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(trimmed);
  } catch {
    throw new Error(tCurrent('auto.apiDebuggerUtils.ulggqz'));
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(tCurrent('auto.apiDebuggerUtils.136po5i'));
  }

  return trimmed;
}

function getEnabledHeaders(request: ApiDebugRequest) {
  return request.headers
    .filter((header) => header.enabled && (header.key.trim() || header.value.trim()))
    .map((header) => ({
      key: header.key.trim(),
      value: header.value.replace(/[\r\n]+/g, ' ').trim(),
    }));
}

export function validateApiRequest(request: ApiDebugRequest) {
  validateUrl(request.url);

  getEnabledHeaders(request).forEach((header) => {
    if (!header.key) {
      throw new Error(tCurrent('auto.apiDebuggerUtils.tum8o7'));
    }

    if (!/^[A-Za-z0-9!#$%&'*+.^_|~-]+$/.test(header.key)) {
      throw new Error(tCurrent('auto.apiDebuggerUtils.1oqjl34', { value0: header.key }));
    }
  });
}

function createBodyMarker(body: string) {
  let marker = `SHELLDESK_API_BODY_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  while (body.includes(marker)) {
    marker += '_X';
  }

  return marker;
}

function shouldSendBody(request: ApiDebugRequest) {
  return request.body.length > 0 && request.method !== 'GET' && request.method !== 'HEAD';
}

export function createApiDebugCommand(request: ApiDebugRequest, isWindowsHost: boolean) {
  validateApiRequest(request);
  const url = validateUrl(request.url);
  const timeout = clampTimeout(request.timeoutSeconds);
  const headers = getEnabledHeaders(request);
  const sendBody = shouldSendBody(request);

  if (isWindowsHost) {
    const headerArgs = headers.map((header) => `$curlArgs += @("-H", ${powershellSingleQuote(`${header.key}: ${header.value}`)})`).join('\n');
    const bodySetupScript = sendBody ? `
$requestBodyFile = New-TemporaryFile
[System.IO.File]::WriteAllText($requestBodyFile.FullName, ${powershellSingleQuote(request.body)}, [System.Text.UTF8Encoding]::new($false))
` : '$requestBodyFile = $null';
    const bodyArgScript = sendBody ? '$curlArgs += @("--data-binary", "@$($requestBodyFile.FullName)")' : '';

    return powershellCommand(`
$headersFile = New-TemporaryFile
$bodyFile = New-TemporaryFile
${bodySetupScript}
$curlArgs = @("-sS", "-L", "--max-time", "${timeout}", "-X", "${request.method}", "-D", $headersFile.FullName, "-o", $bodyFile.FullName, "-w", "\`n${metaMarker} http_code=%{http_code} time_total=%{time_total} remote_ip=%{remote_ip}")
${headerArgs}
${bodyArgScript}
$curlArgs += @(${powershellSingleQuote(url)})
& curl.exe @curlArgs
$curlCode = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }
$headersText = Get-Content -LiteralPath $headersFile.FullName -Raw -ErrorAction SilentlyContinue
$charset = ''
if ($headersText -match '(?im)^Content-Type:\\s*.*charset=([^;\\s]+)') {
  $charset = $matches[1].Trim('"').Trim("'")
}
try {
  $encoding = if ($charset) { [System.Text.Encoding]::GetEncoding($charset) } else { [System.Text.UTF8Encoding]::new($false, $true) }
} catch {
  $encoding = [System.Text.UTF8Encoding]::new($false, $false)
}
$bodyBytes = [System.IO.File]::ReadAllBytes($bodyFile.FullName)
$bodyText = $encoding.GetString($bodyBytes)
"${headersMarker}"
$headersText
"${bodyMarker}"
$bodyText
"${exitMarker} $curlCode"
Remove-Item -LiteralPath $headersFile.FullName, $bodyFile.FullName -Force -ErrorAction SilentlyContinue
if ($requestBodyFile) { Remove-Item -LiteralPath $requestBodyFile.FullName -Force -ErrorAction SilentlyContinue }
exit $curlCode
`);
  }

  const headerArgs = headers.map((header) => `-H ${shellSingleQuote(`${header.key}: ${header.value}`)}`).join(' ');
  const bodyMarkerText = createBodyMarker(request.body);
  const bodySetup = sendBody
    ? `request_body_file=$(mktemp "\${TMPDIR:-/tmp}/shelldesk-api-body.XXXXXX"); cat > "$request_body_file" <<'${bodyMarkerText}'\n${request.body}\n${bodyMarkerText}\nbody_arg="--data-binary @$request_body_file"`
    : `request_body_file=""; body_arg=""`;

  return tCurrent('auto.apiDebuggerUtils.147yyqv', { value0: bodySetup, value1: timeout, value2: request.method, value3: metaMarker, value4: headerArgs, value5: shellSingleQuote(url), value6: headersMarker, value7: bodyMarker, value8: exitMarker, value9: sendBody ? '"$request_body_file"' : '' });
}

function textBetween(text: string, startMarker: string, endMarker: string) {
  const startIndex = text.indexOf(startMarker);

  if (startIndex < 0) {
    return '';
  }

  const contentStart = startIndex + startMarker.length;
  const endIndex = text.indexOf(endMarker, contentStart);
  const content = endIndex < 0 ? text.slice(contentStart) : text.slice(contentStart, endIndex);
  return content.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
}

export function parseApiDebugResponse(stdout: string, stderr: string, fallbackDurationMs: number): ApiDebugResponse {
  const metaMatch = stdout.match(new RegExp(`${metaMarker}\\s+http_code=(\\d+)\\s+time_total=([\\d.]+)\\s+remote_ip=([^\\s]*)`));
  const exitMatch = stdout.match(new RegExp(`${exitMarker}\\s+(\\d+)`));
  const status = metaMatch ? Number.parseInt(metaMatch[1], 10) : undefined;
  const durationMs = metaMatch ? Math.round(Number.parseFloat(metaMatch[2]) * 1000) : fallbackDurationMs;
  const headersText = textBetween(stdout, headersMarker, bodyMarker);
  const body = textBetween(stdout, bodyMarker, exitMarker);
  const exitCode = exitMatch ? Number.parseInt(exitMatch[1], 10) : 0;

  return {
    status: status && status > 0 ? status : undefined,
    durationMs,
    headersText,
    body,
    stderr: stderr.trim() || undefined,
    exitCode,
    raw: [stdout, stderr].filter(Boolean).join('\n'),
  };
}

export function createCurlPreview(request: ApiDebugRequest) {
  validateApiRequest(request);
  const url = validateUrl(request.url);
  const timeout = clampTimeout(request.timeoutSeconds);
  const headers = getEnabledHeaders(request).map((header) => `-H ${shellSingleQuote(`${header.key}: ${header.value}`)}`);
  const body = shouldSendBody(request) ? [`--data-binary ${shellSingleQuote(request.body)}`] : [];

  return [
    'curl',
    '-L',
    '--max-time',
    String(timeout),
    '-X',
    request.method,
    ...headers,
    ...body,
    shellSingleQuote(url),
  ].join(' ');
}

export function formatJsonBody(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    return '';
  }

  return JSON.stringify(JSON.parse(trimmed), null, 2);
}

export function createRequestId() {
  return `api-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createHeaderId() {
  return `header-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
