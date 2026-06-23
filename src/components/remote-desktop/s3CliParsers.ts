import { powershellSingleQuote, powershellStdinCommand, type RemoteCommandInput } from './remoteSystem';
import { tCurrent } from '../../i18n';

export type S3CliMode = 'aws' | 'mc';

export interface S3ConnectionConfig {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  region: string;
  pathStyle: boolean;
}

export interface S3BucketEntry {
  name: string;
  createdAt?: string;
}

export interface S3ObjectEntry {
  key: string;
  name: string;
  size?: number;
  lastModified?: string;
  type: 'prefix' | 'object';
  contentType?: string;
}

function shellSingleQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function toNumber(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function normalizeEndpoint(endpoint: string) {
  const trimmedValue = endpoint.trim();

  if (!/^https?:\/\/[^\s]+$/i.test(trimmedValue) || /[\r\n\u0000]/.test(trimmedValue)) {
    throw new Error(tCurrent('auto.s3CliParsers.15k0mm2'));
  }

  return trimmedValue.replace(/\/+$/, '');
}

function validateCredential(value: string, label: string) {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    throw new Error(tCurrent('auto.s3CliParsers.1uo8svj', { value0: label }));
  }

  if (trimmedValue.length > 300 || /[\r\n\u0000]/.test(trimmedValue)) {
    throw new Error(tCurrent('auto.s3CliParsers.1ainqu2', { value0: label }));
  }

  return trimmedValue;
}

function validateBucket(bucket: string) {
  const trimmedValue = bucket.trim();

  if (!trimmedValue || trimmedValue.length > 255 || /[\r\n\u0000/]/.test(trimmedValue)) {
    throw new Error(tCurrent('auto.s3CliParsers.s02cfq'));
  }

  return trimmedValue;
}

function validatePrefix(prefix: string) {
  const trimmedValue = prefix.trim().replace(/^\/+/, '');

  if (trimmedValue.length > 900 || /[\r\n\u0000]/.test(trimmedValue)) {
    throw new Error(tCurrent('auto.s3CliParsers.9l4pej'));
  }

  return trimmedValue;
}

function validateObjectKey(key: string) {
  const trimmedValue = key.trim().replace(/^\/+/, '');

  if (!trimmedValue || trimmedValue.length > 1000 || /[\r\n\u0000]/.test(trimmedValue)) {
    throw new Error(tCurrent('auto.s3CliParsers.12tp98i'));
  }

  return trimmedValue;
}

function validateRemoteDirectory(path: string) {
  const trimmedValue = path.trim();

  if (!trimmedValue || trimmedValue.length > 500 || /[\r\n\u0000]/.test(trimmedValue)) {
    throw new Error(tCurrent('auto.s3CliParsers.kyud8i'));
  }

  return trimmedValue;
}

function createAwsPrefix(config: S3ConnectionConfig, isWindowsHost: boolean) {
  const endpoint = normalizeEndpoint(config.endpoint);
  const accessKey = validateCredential(config.accessKey, 'Access Key');
  const secretKey = validateCredential(config.secretKey, 'Secret Key');
  const region = config.region.trim() || 'us-east-1';

  if (isWindowsHost) {
    return [
      `$env:AWS_ACCESS_KEY_ID = ${powershellSingleQuote(accessKey)}`,
      `$env:AWS_SECRET_ACCESS_KEY = ${powershellSingleQuote(secretKey)}`,
      `$env:AWS_DEFAULT_REGION = ${powershellSingleQuote(region)}`,
      '$env:AWS_EC2_METADATA_DISABLED = "true"',
      `$endpoint = ${powershellSingleQuote(endpoint)}`,
    ].join('\n');
  }

  return `AWS_ACCESS_KEY_ID=${shellSingleQuote(accessKey)} AWS_SECRET_ACCESS_KEY=${shellSingleQuote(secretKey)} AWS_DEFAULT_REGION=${shellSingleQuote(region)} AWS_EC2_METADATA_DISABLED=true aws --endpoint-url ${shellSingleQuote(endpoint)}`;
}

function createMcHostUrl(config: S3ConnectionConfig) {
  const endpoint = normalizeEndpoint(config.endpoint);
  const url = new URL(endpoint);

  url.username = validateCredential(config.accessKey, 'Access Key');
  url.password = validateCredential(config.secretKey, 'Secret Key');
  return url.toString().replace(/\/+$/, '');
}

function createMcPrefix(config: S3ConnectionConfig, isWindowsHost: boolean) {
  const hostUrl = createMcHostUrl(config);

  if (isWindowsHost) {
    return `$env:MC_HOST_shelldesk = ${powershellSingleQuote(hostUrl)}`;
  }

  return `MC_HOST_shelldesk=${shellSingleQuote(hostUrl)} mc`;
}

export function createS3DetectCommand(isWindowsHost: boolean): RemoteCommandInput {
  if (isWindowsHost) {
    return powershellStdinCommand(`
if (Get-Command mc -ErrorAction SilentlyContinue) { "mc" }
if (Get-Command aws -ErrorAction SilentlyContinue) { "aws" }
`);
  }

  return {
    command: 'for tool in mc aws; do if command -v "$tool" >/dev/null 2>&1; then echo "$tool"; fi; done',
  };
}

export function createS3ListBucketsCommand(mode: S3CliMode, config: S3ConnectionConfig, isWindowsHost: boolean): RemoteCommandInput {
  if (mode === 'aws') {
    if (isWindowsHost) {
      return powershellStdinCommand(`${createAwsPrefix(config, true)}\naws --endpoint-url $endpoint s3api list-buckets --output json`);
    }

    return { command: `${createAwsPrefix(config, false)} s3api list-buckets --output json` };
  }

  if (isWindowsHost) {
    return powershellStdinCommand(`${createMcPrefix(config, true)}\nmc --json ls shelldesk`);
  }

  return { command: `${createMcPrefix(config, false)} --json ls shelldesk` };
}

export function createS3ListObjectsCommand(mode: S3CliMode, config: S3ConnectionConfig, bucket: string, prefix: string, isWindowsHost: boolean): RemoteCommandInput {
  const safeBucket = validateBucket(bucket);
  const safePrefix = validatePrefix(prefix);

  if (mode === 'aws') {
    if (isWindowsHost) {
      return powershellStdinCommand(`${createAwsPrefix(config, true)}
aws --endpoint-url $endpoint s3api list-objects-v2 --bucket ${powershellSingleQuote(safeBucket)} --prefix ${powershellSingleQuote(safePrefix)} --delimiter "/" --max-keys 500 --output json`);
    }

    return {
      command: `${createAwsPrefix(config, false)} s3api list-objects-v2 --bucket ${shellSingleQuote(safeBucket)} --prefix ${shellSingleQuote(safePrefix)} --delimiter / --max-keys 500 --output json`,
    };
  }

  const aliasPath = `shelldesk/${safeBucket}/${safePrefix}`;
  if (isWindowsHost) {
    return powershellStdinCommand(`${createMcPrefix(config, true)}\nmc --json ls ${powershellSingleQuote(aliasPath)}`);
  }

  return { command: `${createMcPrefix(config, false)} --json ls ${shellSingleQuote(aliasPath)}` };
}

export function createS3DeleteObjectCommand(mode: S3CliMode, config: S3ConnectionConfig, bucket: string, key: string, isWindowsHost: boolean): RemoteCommandInput {
  const safeBucket = validateBucket(bucket);
  const safeKey = validateObjectKey(key);

  if (mode === 'aws') {
    if (isWindowsHost) {
      return powershellStdinCommand(`${createAwsPrefix(config, true)}
aws --endpoint-url $endpoint s3api delete-object --bucket ${powershellSingleQuote(safeBucket)} --key ${powershellSingleQuote(safeKey)}`);
    }

    return { command: `${createAwsPrefix(config, false)} s3api delete-object --bucket ${shellSingleQuote(safeBucket)} --key ${shellSingleQuote(safeKey)}` };
  }

  const aliasPath = `shelldesk/${safeBucket}/${safeKey}`;
  if (isWindowsHost) {
    return powershellStdinCommand(`${createMcPrefix(config, true)}\nmc rm ${powershellSingleQuote(aliasPath)}`);
  }

  return { command: `${createMcPrefix(config, false)} rm ${shellSingleQuote(aliasPath)}` };
}

export function createS3DownloadObjectCommand(mode: S3CliMode, config: S3ConnectionConfig, bucket: string, key: string, remoteDirectory: string, isWindowsHost: boolean): RemoteCommandInput {
  const safeBucket = validateBucket(bucket);
  const safeKey = validateObjectKey(key);
  const safeDirectory = validateRemoteDirectory(remoteDirectory);
  const fileName = safeKey.split('/').filter(Boolean).pop() ?? 'object.bin';
  const destination = `${safeDirectory.replace(/[\\/]+$/, '')}/${fileName}`;

  if (mode === 'aws') {
    if (isWindowsHost) {
      return powershellStdinCommand(`${createAwsPrefix(config, true)}
aws --endpoint-url $endpoint s3 cp ${powershellSingleQuote(`s3://${safeBucket}/${safeKey}`)} ${powershellSingleQuote(destination)}`);
    }

    return { command: `${createAwsPrefix(config, false)} s3 cp ${shellSingleQuote(`s3://${safeBucket}/${safeKey}`)} ${shellSingleQuote(destination)}` };
  }

  const aliasPath = `shelldesk/${safeBucket}/${safeKey}`;
  if (isWindowsHost) {
    return powershellStdinCommand(`${createMcPrefix(config, true)}\nmc cp ${powershellSingleQuote(aliasPath)} ${powershellSingleQuote(destination)}`);
  }

  return { command: `${createMcPrefix(config, false)} cp ${shellSingleQuote(aliasPath)} ${shellSingleQuote(destination)}` };
}

export function createS3UploadObjectCommand(mode: S3CliMode, config: S3ConnectionConfig, bucket: string, key: string, remoteFilePath: string, isWindowsHost: boolean): RemoteCommandInput {
  const safeBucket = validateBucket(bucket);
  const safeKey = validateObjectKey(key);
  const safeRemoteFilePath = validateRemoteDirectory(remoteFilePath);

  if (mode === 'aws') {
    if (isWindowsHost) {
      return powershellStdinCommand(`${createAwsPrefix(config, true)}
aws --endpoint-url $endpoint s3 cp ${powershellSingleQuote(safeRemoteFilePath)} ${powershellSingleQuote(`s3://${safeBucket}/${safeKey}`)}`);
    }

    return { command: `${createAwsPrefix(config, false)} s3 cp ${shellSingleQuote(safeRemoteFilePath)} ${shellSingleQuote(`s3://${safeBucket}/${safeKey}`)}` };
  }

  const aliasPath = `shelldesk/${safeBucket}/${safeKey}`;
  if (isWindowsHost) {
    return powershellStdinCommand(`${createMcPrefix(config, true)}\nmc cp ${powershellSingleQuote(safeRemoteFilePath)} ${powershellSingleQuote(aliasPath)}`);
  }

  return { command: `${createMcPrefix(config, false)} cp ${shellSingleQuote(safeRemoteFilePath)} ${shellSingleQuote(aliasPath)}` };
}

export function parseS3Buckets(mode: S3CliMode, stdout: string): S3BucketEntry[] {
  if (mode === 'aws') {
    const payload = JSON.parse(stdout) as { Buckets?: Array<{ Name?: string; CreationDate?: string }> };
    return (payload.Buckets ?? [])
      .map((bucket) => ({ name: String(bucket.Name ?? ''), createdAt: bucket.CreationDate }))
      .filter((bucket) => bucket.name);
  }

  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        const key = String(row.key ?? row.name ?? '').replace(/\/$/, '');
        return { name: key, createdAt: row.lastModified ? String(row.lastModified) : undefined };
      } catch {
        const parts = line.split(/\s+/);
        return { name: parts.at(-1)?.replace(/\/$/, '') ?? '' };
      }
    })
    .filter((bucket) => bucket.name && bucket.name !== '..');
}

export function parseS3Objects(mode: S3CliMode, stdout: string, prefix: string): S3ObjectEntry[] {
  const normalizedPrefix = validatePrefix(prefix);

  if (mode === 'aws') {
    const payload = JSON.parse(stdout || '{}') as {
      Contents?: Array<{ Key?: string; Size?: number; LastModified?: string }>;
      CommonPrefixes?: Array<{ Prefix?: string }>;
    };
    const prefixes = (payload.CommonPrefixes ?? [])
      .map((row) => String(row.Prefix ?? ''))
      .filter(Boolean)
      .map((key) => ({
        key,
        name: key.slice(normalizedPrefix.length).replace(/\/$/, '') || key,
        type: 'prefix' as const,
      }));
    const objects = (payload.Contents ?? [])
      .map((row) => {
        const key = String(row.Key ?? '');
        const name = key.slice(normalizedPrefix.length).split('/').filter(Boolean).pop() ?? key;
        return {
          key,
          name,
          size: toNumber(row.Size),
          lastModified: row.LastModified,
          type: 'object' as const,
        };
      })
      .filter((item) => item.key && item.key !== normalizedPrefix);

    return [...prefixes, ...objects];
  }

  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        const rawKey = String(row.key ?? row.name ?? '');
        const isPrefix = String(row.type ?? '').toLowerCase() === 'folder' || rawKey.endsWith('/');
        const key = isPrefix && !rawKey.startsWith(normalizedPrefix) ? `${normalizedPrefix}${rawKey}` : rawKey;
        const name = key.slice(normalizedPrefix.length).replace(/\/$/, '') || rawKey.replace(/\/$/, '');

        return {
          key,
          name,
          size: toNumber(row.size),
          lastModified: row.lastModified ? String(row.lastModified) : undefined,
          type: isPrefix ? 'prefix' as const : 'object' as const,
          contentType: row.contentType ? String(row.contentType) : undefined,
        };
      } catch {
        const name = line.split(/\s+/).at(-1) ?? '';
        return {
          key: `${normalizedPrefix}${name}`,
          name: name.replace(/\/$/, ''),
          type: name.endsWith('/') ? 'prefix' as const : 'object' as const,
        };
      }
    })
    .filter((item) => item.name && item.name !== '..');
}

function parseXml(value: unknown) {
  if (typeof value !== 'string') {
    throw new Error(tCurrent('auto.s3CliParsers.1lzmi3i'));
  }

  const document = new DOMParser().parseFromString(value, 'application/xml');
  const parserError = document.querySelector('parsererror');

  if (parserError) {
    throw new Error(tCurrent('auto.s3CliParsers.1lzmi3i'));
  }

  const errorCode = document.querySelector('Error > Code')?.textContent;
  const errorMessage = document.querySelector('Error > Message')?.textContent;
  if (errorCode || errorMessage) {
    throw new Error([errorCode, errorMessage].filter(Boolean).join(': '));
  }

  return document;
}

function textContent(parent: Element, selector: string) {
  return parent.querySelector(selector)?.textContent ?? '';
}

export function parseS3BucketsResponse(response: unknown): S3BucketEntry[] {
  const document = parseXml(response);

  return Array.from(document.querySelectorAll('Bucket'))
    .map((bucket) => ({
      name: textContent(bucket, 'Name'),
      createdAt: textContent(bucket, 'CreationDate') || undefined,
    }))
    .filter((bucket) => bucket.name);
}

export function parseS3ObjectsResponse(response: unknown, prefix: string): S3ObjectEntry[] {
  const normalizedPrefix = validatePrefix(prefix);
  const document = parseXml(response);
  const prefixes = Array.from(document.querySelectorAll('CommonPrefixes'))
    .map((row) => textContent(row, 'Prefix'))
    .filter(Boolean)
    .map((key) => ({
      key,
      name: key.slice(normalizedPrefix.length).replace(/\/$/, '') || key,
      type: 'prefix' as const,
    }));
  const objects = Array.from(document.querySelectorAll('Contents'))
    .map((row) => {
      const key = textContent(row, 'Key');
      const name = key.slice(normalizedPrefix.length).split('/').filter(Boolean).pop() ?? key;

      return {
        key,
        name,
        size: toNumber(textContent(row, 'Size')),
        lastModified: textContent(row, 'LastModified') || undefined,
        type: 'object' as const,
      };
    })
    .filter((item) => item.key && item.key !== normalizedPrefix);

  return [...prefixes, ...objects];
}

function encodePathSegment(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function createS3Path(config: S3ConnectionConfig, bucket?: string, key?: string) {
  const safeBucket = bucket ? validateBucket(bucket) : '';
  const safeKey = key ? validateObjectKey(key).split('/').map(encodePathSegment).join('/') : '';

  if (!safeBucket) return '/';
  if (config.pathStyle) {
    return `/${encodePathSegment(safeBucket)}${safeKey ? `/${safeKey}` : ''}`;
  }
  return safeKey ? `/${safeKey}` : '/';
}

function createS3TargetHost(config: S3ConnectionConfig, bucket?: string) {
  const endpoint = new URL(normalizeEndpoint(config.endpoint));
  const safeBucket = bucket ? validateBucket(bucket) : '';

  if (safeBucket && !config.pathStyle) {
    return `${safeBucket}.${endpoint.hostname}`;
  }

  return endpoint.hostname;
}

function createTunnelBase(config: S3ConnectionConfig, path: string, search = '', bucket?: string): ShellDeskHttpTunnelRequest {
  const endpoint = new URL(normalizeEndpoint(config.endpoint));
  return {
    connectionId: '',
    targetHost: createS3TargetHost(config, bucket),
    targetPort: Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)),
    path: `${path}${search}`,
    secure: endpoint.protocol === 'https:',
  };
}

function getHostHeader(config: S3ConnectionConfig, bucket?: string) {
  const endpoint = new URL(normalizeEndpoint(config.endpoint));
  const defaultPort = endpoint.protocol === 'https:' ? '443' : '80';
  const host = createS3TargetHost(config, bucket);
  return endpoint.port && endpoint.port !== defaultPort ? `${host}:${endpoint.port}` : host;
}

function toHex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(value: string) {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value).buffer as ArrayBuffer));
}

async function hmac(key: ArrayBuffer, value: string) {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(value).buffer as ArrayBuffer);
}

async function createSigningKey(secretKey: string, dateStamp: string, region: string) {
  const dateKey = await hmac(new TextEncoder().encode(`AWS4${secretKey}`).buffer as ArrayBuffer, dateStamp);
  const regionKey = await hmac(dateKey, region);
  const serviceKey = await hmac(regionKey, 's3');
  return hmac(serviceKey, 'aws4_request');
}

async function createS3SignedHeaders(config: S3ConnectionConfig, method: 'GET' | 'DELETE', path: string, search = '', bucket?: string) {
  const accessKey = validateCredential(config.accessKey, 'Access Key');
  const secretKey = validateCredential(config.secretKey, 'Secret Key');
  const region = config.region.trim() || 'us-east-1';
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const host = getHostHeader(config, bucket);
  const payloadHash = 'UNSIGNED-PAYLOAD';
  const canonicalQuery = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const canonicalQueryString = Array.from(canonicalQuery.entries())
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey))
    .map(([key, value]) => `${encodePathSegment(key)}=${encodePathSegment(value)}`)
    .join('&');
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [
    method,
    path,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join('\n');
  const signingKey = await createSigningKey(secretKey, dateStamp, region);
  const signature = toHex(await hmac(signingKey, stringToSign));

  return {
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    Host: host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
}

async function createS3TunnelRequest(
  method: 'GET' | 'DELETE',
  mode: S3CliMode,
  config: S3ConnectionConfig,
  path: string,
  search = '',
  bucket?: string,
): Promise<ShellDeskHttpTunnelRequest> {
  void mode;
  const request = createTunnelBase(config, path, search, bucket);
  request.headers = await createS3SignedHeaders(config, method, path, search, bucket);

  return request;
}

export function createS3ListBucketsTunnelRequest(mode: S3CliMode, config: S3ConnectionConfig) {
  return createS3TunnelRequest('GET', mode, config, '/');
}

export function createS3ListObjectsTunnelRequest(mode: S3CliMode, config: S3ConnectionConfig, bucket: string, prefix: string) {
  const normalizedPrefix = validatePrefix(prefix);
  const search = new URLSearchParams({
    'list-type': '2',
    delimiter: '/',
    'max-keys': '500',
  });
  if (normalizedPrefix) {
    search.set('prefix', normalizedPrefix);
  }

  return createS3TunnelRequest('GET', mode, config, createS3Path(config, bucket), `?${search.toString()}`, bucket);
}

export function createS3DeleteObjectTunnelRequest(mode: S3CliMode, config: S3ConnectionConfig, bucket: string, key: string) {
  return createS3TunnelRequest('DELETE', mode, config, createS3Path(config, bucket, key), '', bucket);
}

export function createS3ObjectUrl(config: S3ConnectionConfig, bucket: string, key: string) {
  const endpoint = normalizeEndpoint(config.endpoint);
  const safeBucket = validateBucket(bucket);
  const safeKey = validateObjectKey(key).split('/').map(encodeURIComponent).join('/');

  if (config.pathStyle) {
    return `${endpoint}/${encodeURIComponent(safeBucket)}/${safeKey}`;
  }

  const url = new URL(endpoint);
  url.hostname = `${safeBucket}.${url.hostname}`;
  url.pathname = `/${safeKey}`;
  return url.toString();
}
