import { powershellCommand, powershellSingleQuote } from './remoteSystem';
import { tCurrent } from '../../i18n';

export type ApiDebugMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';

export interface ApiDebugHeader {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
  managedByAuth?: boolean;
  managedByBody?: boolean;
}

export interface ApiDebugQueryParam {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
}

export type ApiDebugBodyType = 'none' | 'json' | 'form' | 'raw';

export type ApiDebugAuthType = 'none' | 'bearer' | 'basic' | 'apiKey';

export interface ApiDebugAuthConfig {
  type: ApiDebugAuthType;
  bearerToken: string;
  basicUsername: string;
  basicPassword: string;
  apiKeyName: string;
  apiKeyValue: string;
}

export interface ApiDebugRequest {
  id: string;
  method: ApiDebugMethod;
  url: string;
  headers: ApiDebugHeader[];
  queryParams?: ApiDebugQueryParam[];
  auth?: ApiDebugAuthConfig;
  bodyType?: ApiDebugBodyType;
  formBody?: ApiDebugQueryParam[];
  body: string;
  timeoutSeconds: number;
  followRedirects?: boolean;
  ignoreSslErrors?: boolean;
  userAgent?: string;
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

export type ApiDebugResponseFormat = 'json' | 'html' | 'xml' | 'text' | 'binary';

const markerToken = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
const metaMarker = `__SHELLDESK_API_META_${markerToken}__`;
const headersMarker = `__SHELLDESK_API_HEADERS_${markerToken}__`;
const bodyMarker = `__SHELLDESK_API_BODY_${markerToken}__`;
const truncatedMarker = `__SHELLDESK_API_TRUNCATED_${markerToken}__`;
const exitMarker = `__SHELLDESK_API_EXIT_${markerToken}__`;
const apiDebugResponseMaxBytes = 2 * 1024 * 1024;
const inlineCurlBodyMaxBytes = 4096;

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

function createUrlWithEnabledParams(request: ApiDebugRequest) {
  const trimmedUrl = validateUrl(request.url);

  if (!request.queryParams) {
    return trimmedUrl;
  }

  const parsedUrl = new URL(trimmedUrl);
  parsedUrl.search = '';

  request.queryParams
    .filter((param) => param.enabled && param.key.trim())
    .forEach((param) => parsedUrl.searchParams.append(param.key.trim(), param.value));

  return parsedUrl.toString();
}

function getEnabledHeaders(request: ApiDebugRequest) {
  return request.headers
    .filter((header) => header.enabled && (header.key.trim() || header.value.trim()))
    .map((header) => ({
      key: header.key.trim(),
      value: header.value.replace(/[\r\n]+/g, ' ').trim(),
    }));
}

function validateApiRequest(request: ApiDebugRequest) {
  createUrlWithEnabledParams(request);

  getEnabledHeaders(request).forEach((header) => {
    if (!header.key) {
      throw new Error(tCurrent('auto.apiDebuggerUtils.tum8o7'));
    }

    if (!/^[A-Za-z0-9!#$%&'*+.^_|~-]+$/.test(header.key)) {
      throw new Error(tCurrent('auto.apiDebuggerUtils.1oqjl34', { value0: header.key }));
    }
  });

  if ((request.bodyType ?? 'raw') === 'json' && request.body.trim()) {
    JSON.parse(request.body);
  }
}

function createRequestBody(request: ApiDebugRequest) {
  const bodyType = request.bodyType ?? 'raw';

  if (bodyType === 'none') {
    return '';
  }

  if (bodyType === 'form') {
    const formParams = new URLSearchParams();
    (request.formBody ?? [])
      .filter((param) => param.enabled && param.key.trim())
      .forEach((param) => formParams.append(param.key.trim(), param.value));
    return formParams.toString();
  }

  return request.body;
}

function shouldFollowRedirects(request: ApiDebugRequest) {
  return request.followRedirects ?? true;
}

function shouldIgnoreSslErrors(request: ApiDebugRequest) {
  return request.ignoreSslErrors ?? false;
}

function getUserAgent(request: ApiDebugRequest) {
  return (request.userAgent ?? '').trim().replace(/[\r\n]+/g, ' ');
}

function shouldSendBody(method: ApiDebugMethod, requestBody: string) {
  return requestBody.length > 0 && method !== 'GET' && method !== 'HEAD';
}

function utf8ByteLength(value: string) {
  return new TextEncoder().encode(value).length;
}

function base64EncodeUtf8(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';

  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.slice(index, index + 0x8000));
  }

  return btoa(binary);
}

function createResponseTruncationNotice(maxBytes: number, actualBytes?: number) {
  const actualText = actualBytes && actualBytes > maxBytes ? ` Remote response size: ${actualBytes} bytes.` : '';
  return `\n\n[ShellDesk] Response body was truncated because it exceeded the ${maxBytes} byte safety limit.${actualText}`;
}

export function createApiDebugCommand(request: ApiDebugRequest, isWindowsHost: boolean) {
  validateApiRequest(request);
  const url = createUrlWithEnabledParams(request);
  const timeout = clampTimeout(request.timeoutSeconds);
  const headers = getEnabledHeaders(request);
  const requestBody = createRequestBody(request);
  const sendBody = shouldSendBody(request.method, requestBody);
  const useStdinBody = sendBody && utf8ByteLength(requestBody) > inlineCurlBodyMaxBytes;
  const userAgent = getUserAgent(request);

  if (isWindowsHost) {
    const headerArgs = headers.map((header) => `$curlArgs += @("-H", ${powershellSingleQuote(`${header.key}: ${header.value}`)})`).join('\n');
    const redirectArg = shouldFollowRedirects(request) ? '$curlArgs += "-L"' : '';
    const sslArg = shouldIgnoreSslErrors(request) ? '$curlArgs += "-k"' : '';
    const userAgentArg = userAgent ? `$curlArgs += @("-A", ${powershellSingleQuote(userAgent)})` : '';
    const bodyBase64 = base64EncodeUtf8(requestBody);
    const bodySetupScript = sendBody ? `
$requestBodyFile = New-TemporaryFile
[System.IO.File]::WriteAllBytes($requestBodyFile.FullName, [System.Convert]::FromBase64String(${powershellSingleQuote(bodyBase64)}))
` : '$requestBodyFile = $null';
    const bodyArgScript = sendBody ? '$curlArgs += @("--data-binary", "@$($requestBodyFile.FullName)")' : '';

    return powershellCommand(`
$headersFile = New-TemporaryFile
$bodyFile = New-TemporaryFile
${bodySetupScript}
$curlArgs = @("-sS", "--max-time", "${timeout}", "--max-filesize", "${apiDebugResponseMaxBytes}", "-X", "${request.method}", "-D", $headersFile.FullName, "-o", $bodyFile.FullName, "-w", "\`n${metaMarker} http_code=%{http_code} time_total=%{time_total} remote_ip=%{remote_ip}")
${redirectArg}
${sslArg}
${userAgentArg}
${headerArgs}
${bodyArgScript}
$curlArgs += @(${powershellSingleQuote(url)})
try {
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
  "${truncatedMarker} 0 $($bodyBytes.Length)"
  "${exitMarker} $curlCode"
  exit $curlCode
} finally {
  Remove-Item -LiteralPath $headersFile.FullName, $bodyFile.FullName -Force -ErrorAction SilentlyContinue
  if ($requestBodyFile) { Remove-Item -LiteralPath $requestBodyFile.FullName -Force -ErrorAction SilentlyContinue }
}
`);
  }

  const headerArgs = headers.map((header) => `-H ${shellSingleQuote(`${header.key}: ${header.value}`)}`).join(' ');
  const redirectArg = shouldFollowRedirects(request) ? '-L' : '';
  const sslArg = shouldIgnoreSslErrors(request) ? '-k' : '';
  const userAgentArg = userAgent ? `-A ${shellSingleQuote(userAgent)}` : '';
  const bodyBase64 = base64EncodeUtf8(requestBody);
  const bodySetup = sendBody
    ? useStdinBody
      ? `body_arg="--data-binary @-"`
      : `request_body_file=$(mktemp "\${TMPDIR:-/tmp}/shelldesk-api-body.XXXXXX")
if ! printf %s ${shellSingleQuote(bodyBase64)} | base64 -d > "$request_body_file" 2>/dev/null; then
  if ! printf %s ${shellSingleQuote(bodyBase64)} | base64 -D > "$request_body_file"; then
    printf 'base64 decode failed.\\n' >&2
    exit 127
  fi
fi
body_arg="--data-binary @$request_body_file"`
    : `request_body_file=""; body_arg=""`;
  const curlCommand = `curl -sS ${redirectArg} ${sslArg} --max-time ${timeout} --max-filesize ${apiDebugResponseMaxBytes} -X ${request.method} -D "$headers_file" -o "$body_file" -w '\\n${metaMarker} http_code=%{http_code} time_total=%{time_total} remote_ip=%{remote_ip}\\n' ${userAgentArg} ${headerArgs} $body_arg ${shellSingleQuote(url)}`;
  const curlInvocation = useStdinBody
    ? `{ printf %s ${shellSingleQuote(bodyBase64)} | base64 -d 2>/dev/null || printf %s ${shellSingleQuote(bodyBase64)} | base64 -D; } | ${curlCommand}
curl_code=$?`
    : `${curlCommand}
curl_code=$?`;

  return `
if ! command -v curl >/dev/null 2>&1; then
  printf 'curl is not installed or current PATH is unavailable.\\n' >&2
  exit 127
fi
${sendBody ? `if ! command -v base64 >/dev/null 2>&1; then
  printf 'base64 is not installed or current PATH is unavailable.\\n' >&2
  exit 127
fi` : ''}
headers_file=$(mktemp "\${TMPDIR:-/tmp}/shelldesk-api-headers.XXXXXX")
body_file=$(mktemp "\${TMPDIR:-/tmp}/shelldesk-api-response.XXXXXX")
request_body_file=""
cleanup() {
  rm -f "$headers_file" "$body_file"
  if [ -n "$request_body_file" ]; then
    rm -f "$request_body_file"
  fi
}
trap cleanup EXIT
trap 'cleanup; exit 130' HUP INT TERM
${bodySetup}
${curlInvocation}
body_size=$(wc -c < "$body_file" 2>/dev/null || printf '0')
body_truncated=0
if [ "$body_size" -gt ${apiDebugResponseMaxBytes} ]; then
  body_truncated=1
fi
printf '${headersMarker}\\n'
cat "$headers_file" 2>/dev/null || true
printf '\\n${bodyMarker}\\n'
if [ "$body_truncated" -eq 1 ]; then
  head -c ${apiDebugResponseMaxBytes} "$body_file" 2>/dev/null || true
else
  cat "$body_file" 2>/dev/null || true
fi
printf '\\n${truncatedMarker} %s %s\\n' "$body_truncated" "$body_size"
printf '${exitMarker} %s\\n' "$curl_code"
exit "$curl_code"
`;
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
  const truncatedMatch = stdout.match(new RegExp(`${truncatedMarker}\\s+(\\d+)\\s+(\\d+)`));
  const exitMatch = stdout.match(new RegExp(`${exitMarker}\\s+(\\d+)`));
  const status = metaMatch ? Number.parseInt(metaMatch[1], 10) : undefined;
  const durationMs = metaMatch ? Math.round(Number.parseFloat(metaMatch[2]) * 1000) : fallbackDurationMs;
  const headersText = textBetween(stdout, headersMarker, bodyMarker);
  const parsedBody = truncatedMatch ? textBetween(stdout, bodyMarker, truncatedMarker) : textBetween(stdout, bodyMarker, exitMarker);
  const exitCode = exitMatch ? Number.parseInt(exitMatch[1], 10) : 0;
  const bodySize = truncatedMatch ? Number.parseInt(truncatedMatch[2], 10) : utf8ByteLength(parsedBody);
  const isTruncated = Boolean(
    (truncatedMatch && truncatedMatch[1] === '1')
    || exitCode === 63
    || /maximum file size|max-filesize|file size exceeded/i.test(stderr)
    || bodySize > apiDebugResponseMaxBytes,
  );
  const truncationNotice = isTruncated ? createResponseTruncationNotice(apiDebugResponseMaxBytes, bodySize) : '';
  const body = isTruncated && !parsedBody.includes('[ShellDesk] Response body was truncated')
    ? `${parsedBody}${truncationNotice}`
    : parsedBody;
  const raw = [stdout, stderr].filter(Boolean).join('\n');

  return {
    status: status && status > 0 ? status : undefined,
    durationMs,
    headersText,
    body,
    stderr: stderr.trim() || undefined,
    exitCode,
    raw: isTruncated && raw && !raw.includes('[ShellDesk] Response body was truncated') ? `${raw}${truncationNotice}` : raw,
  };
}

export function createCurlPreview(request: ApiDebugRequest) {
  validateApiRequest(request);
  const url = createUrlWithEnabledParams(request);
  const timeout = clampTimeout(request.timeoutSeconds);
  const headers = getEnabledHeaders(request).map((header) => `-H ${shellSingleQuote(`${header.key}: ${header.value}`)}`);
  const requestBody = createRequestBody(request);
  const sendBody = shouldSendBody(request.method, requestBody);
  const largeBody = utf8ByteLength(requestBody) > inlineCurlBodyMaxBytes;
  const body = sendBody
    ? [largeBody ? '--data-binary @-' : `--data-binary ${shellSingleQuote(requestBody)}`]
    : [];
  const userAgent = getUserAgent(request);
  const command = [
    'curl',
    ...(shouldFollowRedirects(request) ? ['-L'] : []),
    ...(shouldIgnoreSslErrors(request) ? ['-k'] : []),
    '--max-time',
    String(timeout),
    '--max-filesize',
    String(apiDebugResponseMaxBytes),
    '-X',
    request.method,
    ...(userAgent ? ['-A', shellSingleQuote(userAgent)] : []),
    ...headers,
    ...body,
    shellSingleQuote(url),
  ].join(' ');

  return sendBody && largeBody
    ? `printf %s ${shellSingleQuote(base64EncodeUtf8(requestBody))} | base64 -d | ${command}`
    : command;
}

function getLastHeaderBlock(headersText: string) {
  const blocks = headersText
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  return blocks[blocks.length - 1] ?? headersText;
}

export function getResponseContentType(headersText: string) {
  const headerBlock = getLastHeaderBlock(headersText);
  const match = headerBlock.match(/^content-type:\s*([^;\r\n]+)/im);
  return match ? match[1].trim().toLowerCase() : '';
}

export function detectApiResponseFormat(headersText: string, body: string): ApiDebugResponseFormat {
  const contentType = getResponseContentType(headersText);

  if (/\b(json|problem\+json|ld\+json)\b/i.test(contentType)) return 'json';
  if (/\bhtml?\b/i.test(contentType)) return 'html';
  if (/\b(xml|svg)\b/i.test(contentType) || /\+xml\b/i.test(contentType)) return 'xml';
  if (/^(image|audio|video|font)\//i.test(contentType) || /\b(octet-stream|pdf|zip|gzip|tar|rar|7z|wasm)\b/i.test(contentType)) return 'binary';
  if (/^text\//i.test(contentType)) return 'text';

  const trimmed = body.trim();
  if (!trimmed) return 'text';

  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      JSON.parse(trimmed);
      return 'json';
    } catch {
      // Continue with the structural sniffing below.
    }
  }

  if (/^<!doctype\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) return 'html';
  if (/^<\?xml\b/i.test(trimmed) || /^<[A-Za-z][\w:.-]*(\s|>|\/>)/.test(trimmed)) return 'xml';
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(body)) return 'binary';
  return 'text';
}

function tokenizeCurlCommand(command: string) {
  const tokens: string[] = [];
  let token = '';
  let quote: '"' | "'" | '' = '';
  let escaped = false;

  for (const char of command.replace(/\\\r?\n/g, ' ')) {
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }

    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = '';
      } else {
        token += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (token) {
        tokens.push(token);
        token = '';
      }
      continue;
    }

    token += char;
  }

  if (escaped) {
    token += '\\';
  }

  if (quote) {
    throw new Error(tCurrent('auto.apiDebuggerUtils.curlUnclosedQuote'));
  }

  if (token) {
    tokens.push(token);
  }

  return tokens;
}

function nextCurlValue(tokens: string[], index: number, option: string) {
  const equalsIndex = option.indexOf('=');

  if (equalsIndex > -1) {
    return { value: option.slice(equalsIndex + 1), index };
  }

  const value = tokens[index + 1];

  if (value === undefined) {
    throw new Error(tCurrent('auto.apiDebuggerUtils.curlMissingValue', { value0: option }));
  }

  return { value, index: index + 1 };
}

function methodFromCurlValue(value: string): ApiDebugMethod {
  const upper = value.trim().toUpperCase();
  const methods: ApiDebugMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];
  return methods.includes(upper as ApiDebugMethod) ? upper as ApiDebugMethod : 'GET';
}

function expandCombinedShortCurlOptions(tokens: string[]) {
  return tokens.flatMap((token, index) => (
    index > 0 && /^-[kLIG]{2,}$/.test(token)
      ? token.slice(1).split('').map((flag) => `-${flag}`)
      : [token]
  ));
}

function appendCookieHeader(headers: ApiDebugHeader[], cookie: string) {
  const existingCookieHeader = headers.find((header) => header.key.trim().toLowerCase() === 'cookie');

  if (existingCookieHeader) {
    existingCookieHeader.value = existingCookieHeader.value
      ? `${existingCookieHeader.value}; ${cookie}`
      : cookie;
    return;
  }

  headers.push({
    id: createHeaderId(),
    key: 'Cookie',
    value: cookie,
    enabled: true,
  });
}

export function parseCurlCommand(command: string): ApiDebugRequest {
  const tokens = expandCombinedShortCurlOptions(tokenizeCurlCommand(command.trim()));

  if (!tokens.length || tokens[0] !== 'curl') {
    throw new Error(tCurrent('auto.apiDebuggerUtils.curlMustStart'));
  }

  let method: ApiDebugMethod = 'GET';
  let url = '';
  let body = '';
  let bodyType: ApiDebugBodyType = 'none';
  let followRedirects = false;
  let ignoreSslErrors = false;
  let userAgent = '';
  let forceGetWithData = false;
  const headers: ApiDebugHeader[] = [];
  const auth = {
    type: 'none' as ApiDebugAuthType,
    bearerToken: '',
    basicUsername: '',
    basicPassword: '',
    apiKeyName: 'X-API-Key',
    apiKeyValue: '',
  };

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token === '-L' || token === '--location') {
      followRedirects = true;
      continue;
    }

    if (token === '-I' || token === '--head') {
      method = 'HEAD';
      continue;
    }

    if (token === '-G' || token === '--get') {
      method = 'GET';
      forceGetWithData = true;
      continue;
    }

    if (token === '-k' || token === '--insecure') {
      ignoreSslErrors = true;
      continue;
    }

    if (token === '--compressed') {
      continue;
    }

    if (token === '-X' || token === '--request' || token.startsWith('--request=')) {
      const result = nextCurlValue(tokens, index, token);
      method = methodFromCurlValue(result.value);
      index = result.index;
      continue;
    }

    if (token === '-H' || token === '--header' || token.startsWith('--header=')) {
      const result = nextCurlValue(tokens, index, token);
      const separatorIndex = result.value.indexOf(':');
      if (separatorIndex > 0) {
        headers.push({
          id: createHeaderId(),
          key: result.value.slice(0, separatorIndex).trim(),
          value: result.value.slice(separatorIndex + 1).trim(),
          enabled: true,
        });
      }
      index = result.index;
      continue;
    }

    if (token === '-d' || token === '--data' || token === '--data-urlencode' || token === '--data-raw' || token === '--data-binary' || token.startsWith('--data=') || token.startsWith('--data-urlencode=') || token.startsWith('--data-raw=') || token.startsWith('--data-binary=')) {
      const result = nextCurlValue(tokens, index, token);
      if (result.value.startsWith('@')) {
        throw new Error(tCurrent('auto.apiDebuggerUtils.curlDataFileUnsupported', { value0: result.value }));
      }
      const joinsWithAmpersand = token === '-d' || token === '--data' || token === '--data-urlencode' || token.startsWith('--data=') || token.startsWith('--data-urlencode=');
      body = body ? `${body}${joinsWithAmpersand ? '&' : ''}${result.value}` : result.value;
      bodyType = 'raw';
      if (method === 'GET' && !forceGetWithData) {
        method = 'POST';
      }
      index = result.index;
      continue;
    }

    if (token === '-u' || token === '--user' || token.startsWith('--user=')) {
      const result = nextCurlValue(tokens, index, token);
      const separatorIndex = result.value.indexOf(':');
      auth.basicUsername = separatorIndex >= 0 ? result.value.slice(0, separatorIndex) : result.value;
      auth.basicPassword = separatorIndex >= 0 ? result.value.slice(separatorIndex + 1) : '';
      auth.type = 'basic';
      index = result.index;
      continue;
    }

    if (token === '-b' || token === '--cookie' || token.startsWith('--cookie=')) {
      const result = nextCurlValue(tokens, index, token);
      appendCookieHeader(headers, result.value);
      index = result.index;
      continue;
    }

    if (token === '-A' || token === '--user-agent' || token.startsWith('--user-agent=')) {
      const result = nextCurlValue(tokens, index, token);
      userAgent = result.value;
      index = result.index;
      continue;
    }

    if (token === '--url' || token.startsWith('--url=')) {
      const result = nextCurlValue(tokens, index, token);
      url = result.value;
      index = result.index;
      continue;
    }

    if (!token.startsWith('-')) {
      url = token;
    }
  }

  if (!url) {
    throw new Error(tCurrent('auto.apiDebuggerUtils.curlNoUrl'));
  }

  const validatedUrl = validateUrl(url);
  const parsedUrl = new URL(validatedUrl);
  const queryParams = Array.from(parsedUrl.searchParams.entries()).map(([key, value]) => ({
    id: createParamId(),
    key,
    value,
    enabled: true,
  }));

  if (forceGetWithData && body) {
    Array.from(new URLSearchParams(body).entries()).forEach(([key, value]) => {
      queryParams.push({
        id: createParamId(),
        key,
        value,
        enabled: true,
      });
    });
    body = '';
    bodyType = 'none';
    method = 'GET';
  }

  const contentType = headers.find((header) => header.key.toLowerCase() === 'content-type')?.value.toLowerCase() ?? '';
  if (body) {
    if (contentType.includes('application/json')) {
      bodyType = 'json';
    } else if (contentType.includes('application/x-www-form-urlencoded')) {
      bodyType = 'form';
    }
  }

  const request: ApiDebugRequest = {
    id: createRequestId(),
    method,
    url: validatedUrl,
    headers,
    queryParams,
    auth,
    bodyType,
    formBody: [],
    body: bodyType === 'form' ? '' : body,
    timeoutSeconds: 10,
    followRedirects,
    ignoreSslErrors,
    userAgent,
  };

  if (bodyType === 'form') {
    request.formBody = Array.from(new URLSearchParams(body).entries()).map(([key, value]) => ({
      id: createParamId(),
      key,
      value,
      enabled: true,
    }));
  }

  return request;
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

export function createParamId() {
  return `param-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function isSensitiveHeaderName(value: string) {
  return /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)$/i.test(value.trim());
}

export function maskSensitiveValue(value: string) {
  if (!value) {
    return '';
  }

  return `${value.slice(0, 8)}***`;
}

export function maskSensitiveHeaders(request: ApiDebugRequest): ApiDebugRequest {
  return {
    ...request,
    headers: request.headers.map((header) => ({
      ...header,
      value: isSensitiveHeaderName(header.key) ? maskSensitiveValue(header.value) : header.value,
    })),
  };
}
