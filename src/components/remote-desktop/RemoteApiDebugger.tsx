import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import DismissibleAlert from './DismissibleAlert';

import {
  createApiDebugCommand,
  createCurlPreview,
  createHeaderId,
  createParamId,
  createRequestId,
  detectApiResponseFormat,
  formatJsonBody,
  getResponseContentType,
  type ApiDebugBodyType,
  isSensitiveHeaderName,
  maskSensitiveHeaders,
  maskSensitiveValue,
  parseCurlCommand,
  parseApiDebugResponse,
  type ApiDebugAuthConfig,
  type ApiDebugHeader,
  type ApiDebugMethod,
  type ApiDebugQueryParam,
  type ApiDebugRequest,
  type ApiDebugResponse,
  type ApiDebugResponseFormat,
} from './apiDebuggerUtils';
import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import { isWindowsSystem } from './remoteSystem';
import type { RemoteSystemType } from './types';
import { tCurrent } from '../../i18n';

interface RemoteApiDebuggerProps {
  connectionId: string;
  systemType?: RemoteSystemType;
}

type RequestTab = 'headers' | 'params' | 'body';
type ResponseTab = 'body' | 'headers' | 'raw';

interface ApiSavedRequest {
  id: string;
  name: string;
  request: ApiDebugRequest;
}

interface ApiEnvironmentVariable {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
}

interface ApiRunRecord {
  id: string;
  request: ApiDebugRequest;
  response: ApiDebugResponse;
  startedAt: string;
}

const methods: ApiDebugMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];
const bodyTypes: Array<{ value: ApiDebugBodyType; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'json', label: 'JSON' },
  { value: 'form', label: 'Form URL-Encoded' },
  { value: 'raw', label: 'Raw' },
];
const maxHistory = 20;
const historyTextLimitBytes = 500 * 1024;
const defaultAuth: ApiDebugAuthConfig = {
  type: 'none',
  bearerToken: '',
  basicUsername: '',
  basicPassword: '',
  apiKeyName: 'X-API-Key',
  apiKeyValue: '',
};

function runCmd(connectionId: string, command: string) {
  const api = window.guiSSH?.connections;

  if (!api) {
    throw new Error(tCurrent('auto.remoteApiDebugger.g77vf3'));
  }

  return api.runCommand(connectionId, command);
}

function createDefaultRequest(): ApiDebugRequest {
  return {
    id: createRequestId(),
    method: 'GET',
    url: 'http://127.0.0.1:8080/health',
    headers: [
      { id: createHeaderId(), key: 'Accept', value: 'application/json', enabled: true },
      { id: createHeaderId(), key: 'Content-Type', value: 'application/json', enabled: false },
    ],
    queryParams: [],
    auth: defaultAuth,
    bodyType: 'none',
    formBody: [],
    body: '',
    timeoutSeconds: 10,
    followRedirects: true,
    ignoreSslErrors: false,
    userAgent: '',
  };
}

function cloneRequest(request: ApiDebugRequest): ApiDebugRequest {
  return {
    ...request,
    id: createRequestId(),
    headers: request.headers.map((header) => ({ ...header })),
    queryParams: (request.queryParams ?? []).map((param) => ({ ...param })),
    bodyType: request.bodyType ?? 'raw',
    formBody: (request.formBody ?? []).map((param) => ({ ...param })),
    auth: { ...defaultAuth, ...request.auth },
    followRedirects: request.followRedirects ?? true,
    ignoreSslErrors: request.ignoreSslErrors ?? false,
    userAgent: request.userAgent ?? '',
  };
}

function getStatusTone(response?: ApiDebugResponse) {
  const status = response?.status;

  if (!status) return 'unknown';
  if (status >= 200 && status < 300) return 'success';
  if (status >= 300 && status < 400) return 'redirect';
  if (status >= 400) return 'danger';
  return 'unknown';
}

function utf8ByteLength(value: string) {
  return new TextEncoder().encode(value).length;
}

function truncateUtf8Text(value: string, maxBytes: number, label: string) {
  if (utf8ByteLength(value) <= maxBytes) {
    return value;
  }

  const suffix = `\n\n[ShellDesk] ${label} was truncated in request history because it exceeded ${maxBytes} bytes.`;
  const suffixBytes = utf8ByteLength(suffix);
  const targetBytes = Math.max(maxBytes - suffixBytes, 0);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let end = value.length;

  while (end > 0 && encoder.encode(value.slice(0, end)).length > targetBytes) {
    end = Math.max(Math.floor(end * 0.9), end - 1);
  }

  return `${decoder.decode(encoder.encode(value.slice(0, end)))}${suffix}`;
}

function limitHistoryResponse(response: ApiDebugResponse): ApiDebugResponse {
  return {
    ...response,
    body: truncateUtf8Text(response.body, historyTextLimitBytes, 'Response body'),
    raw: truncateUtf8Text(response.raw, historyTextLimitBytes, 'Raw response'),
  };
}

function parseUrlQueryParams(url: string): ApiDebugQueryParam[] | null {
  try {
    const parsedUrl = new URL(url.trim());
    return Array.from(parsedUrl.searchParams.entries()).map(([key, value]) => ({
      id: createParamId(),
      key,
      value,
      enabled: true,
    }));
  } catch {
    return null;
  }
}

function syncUrlQueryParams(url: string, params: ApiDebugQueryParam[]) {
  try {
    const parsedUrl = new URL(url.trim());
    parsedUrl.search = '';
    params
      .filter((param) => param.enabled && param.key.trim())
      .forEach((param) => parsedUrl.searchParams.append(param.key.trim(), param.value));
    return parsedUrl.toString();
  } catch {
    return url;
  }
}

function encodeBasicAuth(username: string, password: string) {
  return btoa(unescape(encodeURIComponent(`${username}:${password}`)));
}

function applyAuthHeaders(headers: ApiDebugHeader[], auth: ApiDebugAuthConfig) {
  const nextHeaders = headers.filter((header) => !header.managedByAuth || header.managedByBody);

  if (auth.type === 'bearer' && auth.bearerToken.trim()) {
    nextHeaders.push({
      id: createHeaderId(),
      key: 'Authorization',
      value: `Bearer ${auth.bearerToken.trim()}`,
      enabled: true,
      managedByAuth: true,
    });
  }

  if (auth.type === 'basic' && (auth.basicUsername || auth.basicPassword)) {
    nextHeaders.push({
      id: createHeaderId(),
      key: 'Authorization',
      value: `Basic ${encodeBasicAuth(auth.basicUsername, auth.basicPassword)}`,
      enabled: true,
      managedByAuth: true,
    });
  }

  if (auth.type === 'apiKey' && auth.apiKeyName.trim() && auth.apiKeyValue) {
    nextHeaders.push({
      id: createHeaderId(),
      key: auth.apiKeyName.trim(),
      value: auth.apiKeyValue,
      enabled: true,
      managedByAuth: true,
    });
  }

  return nextHeaders;
}

function applyBodyContentType(headers: ApiDebugHeader[], bodyType: ApiDebugBodyType) {
  const contentType = bodyType === 'json'
    ? 'application/json'
    : bodyType === 'form'
      ? 'application/x-www-form-urlencoded'
      : '';

  if (!contentType) {
    return headers;
  }

  const existingHeader = headers.find((header) => header.key.trim().toLowerCase() === 'content-type');

  if (existingHeader) {
    return headers.map((header) => (
      header.id === existingHeader.id
        ? { ...header, value: contentType, enabled: true }
        : header
    ));
  }

  return [
    ...headers,
    {
      id: createHeaderId(),
      key: 'Content-Type',
      value: contentType,
      enabled: true,
      managedByAuth: true,
      managedByBody: true,
    },
  ];
}

function createVariableId() {
  return `env-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createSavedRequestName(request: ApiDebugRequest) {
  const urlLabel = request.url.trim() || 'Untitled';
  return `${request.method} ${urlLabel}`.slice(0, 80);
}

function replaceEnvironmentVariables(value: string, variables: ApiEnvironmentVariable[]) {
  const variableMap = new Map(
    variables
      .filter((variable) => variable.enabled && variable.key.trim())
      .map((variable) => [variable.key.trim(), variable.value]),
  );

  return value.replace(/\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g, (match, key: string) => variableMap.get(key) ?? match);
}

function materializeRequest(request: ApiDebugRequest, variables: ApiEnvironmentVariable[]) {
  return {
    ...cloneRequest(request),
    url: replaceEnvironmentVariables(request.url, variables),
    headers: request.headers.map((header) => ({
      ...header,
      value: replaceEnvironmentVariables(header.value, variables),
    })),
    queryParams: (request.queryParams ?? []).map((param) => ({
      ...param,
      value: replaceEnvironmentVariables(param.value, variables),
    })),
    formBody: (request.formBody ?? []).map((param) => ({
      ...param,
      key: replaceEnvironmentVariables(param.key, variables),
      value: replaceEnvironmentVariables(param.value, variables),
    })),
    body: replaceEnvironmentVariables(request.body, variables),
  };
}

function getHeaderDisplayValue(header: ApiDebugHeader, showSensitive: boolean) {
  if (showSensitive || !isSensitiveHeaderName(header.key)) {
    return header.value;
  }

  return maskSensitiveValue(header.value);
}

function getHeaderSummary(request: ApiDebugRequest, showSensitive: boolean) {
  const headers = (showSensitive ? request : maskSensitiveHeaders(request)).headers
    .filter((header) => header.enabled && header.key.trim())
    .map((header) => `${header.key.trim()}: ${header.value || '-'}`);

  return headers.length ? headers.join(' · ') : 'No headers';
}

function getFormatLabel(format: ApiDebugResponseFormat, contentType: string) {
  const labelMap: Record<ApiDebugResponseFormat, string> = {
    json: 'JSON',
    html: 'HTML',
    xml: 'XML',
    text: 'Text',
    binary: 'Binary',
  };

  return contentType ? `${labelMap[format]} · ${contentType}` : labelMap[format];
}

function parseJsonResponseBody(body: string) {
  try {
    return { value: JSON.parse(body) as unknown, error: '' };
  } catch (error) {
    return { value: null, error: getErrorMessage(error) };
  }
}

function getJsonValueType(value: unknown) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value === 'object' ? 'object' : typeof value;
}

function isJsonContainer(value: unknown) {
  return value !== null && typeof value === 'object';
}

function shouldCollapseJsonValue(value: unknown, depth: number) {
  if (typeof value === 'string') {
    return value.length > 120;
  }

  if (Array.isArray(value)) {
    return depth > 0 || value.length > 12;
  }

  if (value && typeof value === 'object') {
    return depth > 0 || Object.keys(value).length > 12;
  }

  return false;
}

function createJsonPath(parentPath: string, key: string | number) {
  return parentPath ? `${parentPath}.${key}` : String(key);
}

function collectDefaultCollapsedJsonPaths(value: unknown, path = 'root', depth = 0, paths = new Set<string>()) {
  if (shouldCollapseJsonValue(value, depth)) {
    paths.add(path);
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectDefaultCollapsedJsonPaths(item, createJsonPath(path, index), depth + 1, paths));
  } else if (value && typeof value === 'object') {
    Object.entries(value as Record<string, unknown>).forEach(([key, item]) => collectDefaultCollapsedJsonPaths(item, createJsonPath(path, key), depth + 1, paths));
  }

  return paths;
}

function formatJsonPrimitive(value: unknown, expanded: boolean) {
  if (typeof value === 'string') {
    const displayValue = expanded || value.length <= 120 ? value : `${value.slice(0, 120)}...`;
    return `"${displayValue}"`;
  }

  return String(value);
}

function JsonTree({ value }: { value: unknown }) {
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(() => collectDefaultCollapsedJsonPaths(value));
  const [expandedStringPaths, setExpandedStringPaths] = useState<Set<string>>(() => new Set());

  const togglePath = (path: string) => {
    setCollapsedPaths((currentPaths) => {
      const nextPaths = new Set(currentPaths);
      if (nextPaths.has(path)) {
        nextPaths.delete(path);
      } else {
        nextPaths.add(path);
      }
      return nextPaths;
    });
  };

  const toggleString = (path: string) => {
    setExpandedStringPaths((currentPaths) => {
      const nextPaths = new Set(currentPaths);
      if (nextPaths.has(path)) {
        nextPaths.delete(path);
      } else {
        nextPaths.add(path);
      }
      return nextPaths;
    });
  };

  const renderValue = (currentValue: unknown, keyName: string | number | null, path: string, depth: number): ReactElement => {
    const type = getJsonValueType(currentValue);
    const isContainer = isJsonContainer(currentValue);
    const isCollapsed = collapsedPaths.has(path);
    const entries = Array.isArray(currentValue)
      ? currentValue.map((item, index) => [index, item] as const)
      : currentValue && typeof currentValue === 'object'
        ? Object.entries(currentValue as Record<string, unknown>)
        : [];
    const summary = Array.isArray(currentValue) ? `[${entries.length}]` : `{${entries.length}}`;
    const expandedString = expandedStringPaths.has(path);

    return (
      <div key={path} style={{ paddingLeft: depth ? 14 : 0, lineHeight: 1.65 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, minWidth: 0 }}>
          {isContainer ? (
            <button
              type="button"
              onClick={() => togglePath(path)}
              aria-label={isCollapsed ? '展开 JSON 节点' : '折叠 JSON 节点'}
              style={{ width: 20, border: 0, background: 'transparent', color: 'var(--api-text)', cursor: 'pointer', padding: 0 }}
            >
              {isCollapsed ? '▸' : '▾'}
            </button>
          ) : (
            <span style={{ width: 20 }} />
          )}
          {keyName !== null ? <strong style={{ color: 'var(--api-text)' }}>{keyName}:</strong> : null}
          <span style={{ color: 'var(--api-muted)', fontSize: 11, fontWeight: 740 }}>{type}</span>
          {isContainer ? (
            <span style={{ color: 'var(--api-muted)' }}>{isCollapsed ? summary : Array.isArray(currentValue) ? '[' : '{'}</span>
          ) : (
            <span style={{ color: 'var(--api-text)', wordBreak: 'break-word' }}>{formatJsonPrimitive(currentValue, expandedString)}</span>
          )}
          {typeof currentValue === 'string' && currentValue.length > 120 ? (
            <button
              type="button"
              onClick={() => toggleString(path)}
              style={{ border: 0, background: 'transparent', color: 'var(--api-accent)', cursor: 'pointer', padding: 0, fontSize: 12 }}
            >
              {expandedString ? '收起' : '展开'}
            </button>
          ) : null}
        </div>
        {isContainer && !isCollapsed ? (
          <>
            {entries.map(([entryKey, entryValue]) => renderValue(entryValue, entryKey, createJsonPath(path, entryKey), depth + 1))}
            <div style={{ paddingLeft: 20, color: 'var(--api-muted)' }}>{Array.isArray(currentValue) ? ']' : '}'}</div>
          </>
        ) : null}
      </div>
    );
  };

  return <div className="api-response-output" style={{ whiteSpace: 'normal', overflow: 'auto' }}>{renderValue(value, null, 'root', 0)}</div>;
}

function RemoteApiDebugger({ connectionId, systemType }: RemoteApiDebuggerProps) {
  const isWindowsHost = isWindowsSystem(systemType);
  const [request, setRequest] = useState<ApiDebugRequest>(() => createDefaultRequest());
  const [requestTab, setRequestTab] = useState<RequestTab>('headers');
  const [responseTab, setResponseTab] = useState<ResponseTab>('body');
  const [history, setHistory] = useState<ApiRunRecord[]>([]);
  const [savedRequests, setSavedRequests] = useState<ApiSavedRequest[]>([]);
  const [environmentVariables, setEnvironmentVariables] = useState<ApiEnvironmentVariable[]>([]);
  const [showEnvironmentEditor, setShowEnvironmentEditor] = useState(false);
  const [editingSavedRequestId, setEditingSavedRequestId] = useState('');
  const [editingSavedRequestName, setEditingSavedRequestName] = useState('');
  const [activeRunId, setActiveRunId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showSensitive, setShowSensitive] = useState(false);
  const [pendingFullCurlCopy, setPendingFullCurlCopy] = useState(false);
  const [showCurlImport, setShowCurlImport] = useState(false);
  const [curlImportText, setCurlImportText] = useState('');
  const [showNetworkOptions, setShowNetworkOptions] = useState(false);

  const activeRun = useMemo(() => history.find((run) => run.id === activeRunId) ?? history[0] ?? null, [activeRunId, history]);
  const jsonBodyError = useMemo(() => {
    if ((request.bodyType ?? 'raw') !== 'json' || !request.body.trim()) {
      return '';
    }

    try {
      JSON.parse(request.body);
      return '';
    } catch (error) {
      return getErrorMessage(error);
    }
  }, [request.body, request.bodyType]);
  const curlPreview = useMemo(() => {
    try {
      const previewRequest = materializeRequest(request, environmentVariables);
      return createCurlPreview(showSensitive ? previewRequest : maskSensitiveHeaders(previewRequest));
    } catch {
      return '';
    }
  }, [environmentVariables, request, showSensitive]);
  const activeResponseFormat = useMemo(() => (
    activeRun ? detectApiResponseFormat(activeRun.response.headersText, activeRun.response.body) : null
  ), [activeRun]);
  const activeResponseContentType = useMemo(() => (
    activeRun ? getResponseContentType(activeRun.response.headersText) : ''
  ), [activeRun]);
  const parsedJsonResponse = useMemo(() => {
    if (!activeRun || activeResponseFormat !== 'json') {
      return null;
    }

    return parseJsonResponseBody(activeRun.response.body);
  }, [activeRun, activeResponseFormat]);

  const updateRequest = <Key extends keyof ApiDebugRequest>(key: Key, value: ApiDebugRequest[Key]) => {
    setRequest((currentRequest) => ({ ...currentRequest, [key]: value }));
  };

  const updateUrl = (url: string) => {
    setRequest((currentRequest) => {
      const parsedParams = parseUrlQueryParams(url);
      return {
        ...currentRequest,
        url,
        queryParams: parsedParams ?? currentRequest.queryParams,
      };
    });
  };

  const updateHeader = (id: string, patch: Partial<ApiDebugHeader>) => {
    setRequest((currentRequest) => ({
      ...currentRequest,
      headers: currentRequest.headers.map((header) => (header.id === id ? { ...header, ...patch } : header)),
    }));
  };

  const addHeader = () => {
    setRequest((currentRequest) => ({
      ...currentRequest,
      headers: [...currentRequest.headers, { id: createHeaderId(), key: '', value: '', enabled: true }],
    }));
  };

  const updateBodyType = (bodyType: ApiDebugBodyType) => {
    setRequest((currentRequest) => ({
      ...currentRequest,
      bodyType,
      headers: applyBodyContentType(currentRequest.headers, bodyType),
    }));
  };

  const updateFormBodyParam = (id: string, patch: Partial<ApiDebugQueryParam>) => {
    setRequest((currentRequest) => ({
      ...currentRequest,
      formBody: (currentRequest.formBody ?? []).map((param) => (param.id === id ? { ...param, ...patch } : param)),
    }));
  };

  const addFormBodyParam = () => {
    setRequest((currentRequest) => ({
      ...currentRequest,
      formBody: [...(currentRequest.formBody ?? []), { id: createParamId(), key: '', value: '', enabled: true }],
    }));
  };

  const removeFormBodyParam = (id: string) => {
    setRequest((currentRequest) => ({
      ...currentRequest,
      formBody: (currentRequest.formBody ?? []).filter((param) => param.id !== id),
    }));
  };

  const removeHeader = (id: string) => {
    setRequest((currentRequest) => ({
      ...currentRequest,
      headers: currentRequest.headers.filter((header) => header.id !== id),
    }));
  };

  const updateParam = (id: string, patch: Partial<ApiDebugQueryParam>) => {
    setRequest((currentRequest) => {
      const queryParams = (currentRequest.queryParams ?? []).map((param) => (param.id === id ? { ...param, ...patch } : param));
      return {
        ...currentRequest,
        queryParams,
        url: syncUrlQueryParams(currentRequest.url, queryParams),
      };
    });
  };

  const addParam = () => {
    setRequest((currentRequest) => {
      const queryParams = [...(currentRequest.queryParams ?? []), { id: createParamId(), key: '', value: '', enabled: true }];
      return { ...currentRequest, queryParams };
    });
  };

  const removeParam = (id: string) => {
    setRequest((currentRequest) => {
      const queryParams = (currentRequest.queryParams ?? []).filter((param) => param.id !== id);
      return {
        ...currentRequest,
        queryParams,
        url: syncUrlQueryParams(currentRequest.url, queryParams),
      };
    });
  };

  const updateAuth = (patch: Partial<ApiDebugAuthConfig>) => {
    setRequest((currentRequest) => {
      const auth = { ...defaultAuth, ...currentRequest.auth, ...patch };
      return {
        ...currentRequest,
        auth,
        headers: applyAuthHeaders(currentRequest.headers, auth),
      };
    });
  };

  const importCurl = () => {
    try {
      const importedRequest = parseCurlCommand(curlImportText);
      setRequest(importedRequest);
      setShowCurlImport(false);
      setCurlImportText('');
      setRequestTab('headers');
      setError('');
      setNotice('已导入 curl 命令。');
    } catch (error) {
      setError(`curl 导入失败：${getErrorMessage(error)}`);
    }
  };

  const updateEnvironmentVariable = (id: string, patch: Partial<ApiEnvironmentVariable>) => {
    setEnvironmentVariables((currentVariables) => currentVariables.map((variable) => (variable.id === id ? { ...variable, ...patch } : variable)));
  };

  const addEnvironmentVariable = () => {
    setEnvironmentVariables((currentVariables) => [...currentVariables, { id: createVariableId(), key: '', value: '', enabled: true }]);
    setShowEnvironmentEditor(true);
  };

  const removeEnvironmentVariable = (id: string) => {
    setEnvironmentVariables((currentVariables) => currentVariables.filter((variable) => variable.id !== id));
  };

  const saveCurrentRequest = () => {
    const requestSnapshot = cloneRequest(request);
    setSavedRequests((currentRequests) => [
      {
        id: createRequestId(),
        name: createSavedRequestName(requestSnapshot),
        request: requestSnapshot,
      },
      ...currentRequests,
    ]);
    setNotice('已收藏当前请求。');
  };

  const loadSavedRequest = (savedRequest: ApiSavedRequest) => {
    setRequest(cloneRequest(savedRequest.request));
    setEditingSavedRequestId('');
    setEditingSavedRequestName('');
    setError('');
    setNotice('');
  };

  const startRenameSavedRequest = (savedRequest: ApiSavedRequest) => {
    setEditingSavedRequestId(savedRequest.id);
    setEditingSavedRequestName(savedRequest.name);
  };

  const commitRenameSavedRequest = () => {
    const nextName = editingSavedRequestName.trim();

    if (!editingSavedRequestId || !nextName) {
      return;
    }

    setSavedRequests((currentRequests) => currentRequests.map((savedRequest) => (
      savedRequest.id === editingSavedRequestId ? { ...savedRequest, name: nextName } : savedRequest
    )));
    setEditingSavedRequestId('');
    setEditingSavedRequestName('');
  };

  const removeSavedRequest = (id: string) => {
    setSavedRequests((currentRequests) => currentRequests.filter((savedRequest) => savedRequest.id !== id));
  };

  const sendRequest = async () => {
    setLoading(true);
    setError('');
    setNotice('');
    const started = performance.now();

    try {
      const requestSnapshot = materializeRequest(request, environmentVariables);
      const command = createApiDebugCommand(requestSnapshot, isWindowsHost);
      const result = await runCmd(connectionId, command);
      const response = limitHistoryResponse(parseApiDebugResponse(result.stdout, result.stderr, Math.round(performance.now() - started)));
      const run: ApiRunRecord = {
        id: createRequestId(),
        request: requestSnapshot,
        response,
        startedAt: new Date().toLocaleTimeString(getShellDeskLocale()),
      };

      setHistory((currentHistory) => [run, ...currentHistory].slice(0, maxHistory));
      setActiveRunId(run.id);
      setResponseTab('body');

      if (result.code !== 0 || response.stderr) {
        setNotice(response.stderr || tCurrent('auto.remoteApiDebugger.b94fvr', { value0: response.exitCode }));
      }
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  };

  const loadHistoryRun = (run: ApiRunRecord) => {
    setRequest(cloneRequest(run.request));
    setActiveRunId(run.id);
    setError('');
    setNotice('');
  };

  const copyCurl = async () => {
    if (showSensitive && !pendingFullCurlCopy) {
      setPendingFullCurlCopy(true);
      setNotice('将复制包含完整敏感信息的 curl，请再次确认。');
      return;
    }

    const materializedRequest = materializeRequest(request, environmentVariables);
    const text = createCurlPreview(showSensitive && pendingFullCurlCopy ? materializedRequest : maskSensitiveHeaders(materializedRequest));
    await navigator.clipboard.writeText(text);
    setPendingFullCurlCopy(false);
    setNotice(tCurrent('auto.remoteApiDebugger.1e5k4ep'));
  };

  const auth = { ...defaultAuth, ...request.auth };

  const copyResponse = async () => {
    if (!activeRun) {
      return;
    }

    await navigator.clipboard.writeText(activeRun.response.body || activeRun.response.headersText || activeRun.response.raw);
    setNotice(tCurrent('auto.remoteApiDebugger.wnngk9'));
  };

  const formatJsonResponse = () => {
    if (!activeRun) {
      return;
    }

    try {
      const formattedBody = formatJsonBody(activeRun.response.body);
      const nextRun = {
        ...activeRun,
        response: { ...activeRun.response, body: formattedBody },
      };
      setHistory((currentHistory) => currentHistory.map((run) => (run.id === activeRun.id ? nextRun : run)));
      setNotice(tCurrent('auto.remoteApiDebugger.ed12q0'));
    } catch (error) {
      setError(tCurrent('auto.remoteApiDebugger.usdhbr', { value0: getErrorMessage(error) }));
    }
  };

  const formatJsonRequestBody = () => {
    try {
      updateRequest('body', formatJsonBody(request.body));
      setError('');
    } catch (error) {
      setError(`JSON 格式错误：${getErrorMessage(error)}`);
    }
  };

  return (
    <section className="api-debugger">
      <aside className="api-history">
        <div className="api-history-head">
          <strong>收藏</strong>
          <span>{savedRequests.length} 个请求</span>
        </div>
        <div className="api-history-list" style={{ flex: '0 0 auto', maxHeight: 210 }}>
          {savedRequests.map((savedRequest) => (
            <div key={savedRequest.id} style={{ border: '1px solid var(--api-border)', borderRadius: 7, marginBottom: 8, padding: 8 }}>
              {editingSavedRequestId === savedRequest.id ? (
                <div className="api-header-row" style={{ gridTemplateColumns: 'minmax(0, 1fr) 58px 58px' }}>
                  <input value={editingSavedRequestName} onChange={(event) => setEditingSavedRequestName(event.target.value)} aria-label="收藏名称" />
                  <button type="button" onClick={commitRenameSavedRequest}>保存</button>
                  <button type="button" onClick={() => setEditingSavedRequestId('')}>取消</button>
                </div>
              ) : (
                <>
                  <button type="button" onClick={() => loadSavedRequest(savedRequest)}>
                    <strong>{savedRequest.name}</strong>
                    <span title={savedRequest.request.url}>{savedRequest.request.url}</span>
                  </button>
                  <div className="api-response-actions" style={{ justifyContent: 'flex-end', marginTop: 6 }}>
                    <button type="button" onClick={() => startRenameSavedRequest(savedRequest)}>重命名</button>
                    <button type="button" onClick={() => removeSavedRequest(savedRequest.id)}>删除</button>
                  </div>
                </>
              )}
            </div>
          ))}
          {!savedRequests.length ? <div className="api-history-empty" style={{ minHeight: 72 }}>暂无收藏</div> : null}
        </div>
        <div className="api-history-head">
          <strong>{tCurrent('auto.remoteApiDebugger.1nw1cic')}</strong>
          <span>{tCurrent('auto.remoteApiDebugger.1a41w7e')}{maxHistory} {tCurrent('auto.remoteApiDebugger.a5jtgs')}</span>
        </div>
        <div className="api-history-list">
          {history.map((run) => (
            <button
              key={run.id}
              type="button"
              className={`${activeRun?.id === run.id ? 'active' : ''} ${getStatusTone(run.response)}`}
              onClick={() => loadHistoryRun(run)}
            >
              <strong>{run.request.method} {run.response.status ?? 'ERR'}</strong>
              <span title={run.request.url}>{run.request.url}</span>
              <span title={getHeaderSummary(run.request, showSensitive)}>{getHeaderSummary(run.request, showSensitive)}</span>
              <em>{run.startedAt} · {run.response.durationMs} ms</em>
            </button>
          ))}
          {!history.length ? <div className="api-history-empty">{tCurrent('auto.remoteApiDebugger.q4qf1w')}</div> : null}
        </div>
      </aside>

      <main className="api-main">
        <header className="api-request-line">
          <select value={request.method} onChange={(event) => updateRequest('method', event.target.value as ApiDebugMethod)} aria-label={tCurrent('auto.remoteApiDebugger.jv69fp')}>
            {methods.map((method) => <option key={method} value={method}>{method}</option>)}
          </select>
          <input value={request.url} onChange={(event) => updateUrl(event.target.value)} placeholder="http://127.0.0.1:8080/health" />
          <input
            className="api-timeout"
            type="number"
            min={1}
            max={120}
            value={request.timeoutSeconds}
            onChange={(event) => updateRequest('timeoutSeconds', Number(event.target.value))}
            aria-label={tCurrent('auto.remoteApiDebugger.tabbi8')}
          />
          <button type="button" onClick={() => setShowNetworkOptions((value) => !value)} aria-label="高级网络选项" title="高级网络选项">⚙</button>
          <button type="button" onClick={() => setShowCurlImport((value) => !value)}>导入 curl</button>
          <button type="button" onClick={saveCurrentRequest} aria-label="收藏当前请求">☆</button>
          <button type="button" className="primary" onClick={sendRequest} disabled={loading}>{loading ? tCurrent('auto.remoteApiDebugger.19ewkta') : tCurrent('auto.remoteApiDebugger.j5vidj')}</button>
        </header>
        {showCurlImport ? (
          <section className="api-request-line" style={{ minHeight: 0, alignItems: 'stretch', flexDirection: 'column' }}>
            <textarea
              className="api-body-editor"
              style={{ minHeight: 96 }}
              value={curlImportText}
              onChange={(event) => setCurlImportText(event.target.value)}
              placeholder={"curl -X POST https://api.example.com/items -H 'Content-Type: application/json' -d '{\"name\":\"demo\"}'"}
              aria-label="curl 命令"
            />
            <div className="api-response-actions" style={{ justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => { setShowCurlImport(false); setCurlImportText(''); }}>取消</button>
              <button type="button" className="primary" onClick={importCurl} disabled={!curlImportText.trim()}>导入</button>
            </div>
          </section>
        ) : null}
        {showNetworkOptions ? (
          <section className="api-request-line" style={{ minHeight: 0, alignItems: 'stretch', flexDirection: 'column' }}>
            <div className="api-header-editor" style={{ padding: 0 }}>
              <label className="api-header-row" style={{ gridTemplateColumns: 'minmax(0, 1fr) 90px 1fr 58px' }}>
                <span>Follow Redirects</span>
                <input
                  type="checkbox"
                  checked={request.followRedirects ?? true}
                  onChange={(event) => updateRequest('followRedirects', event.target.checked)}
                />
                <span style={{ color: 'var(--api-muted)', fontSize: 12 }}>curl -L</span>
                <span />
              </label>
              <label className="api-header-row" style={{ gridTemplateColumns: 'minmax(0, 1fr) 90px 1fr 58px' }}>
                <span>Ignore SSL Errors</span>
                <input
                  type="checkbox"
                  checked={request.ignoreSslErrors ?? false}
                  onChange={(event) => updateRequest('ignoreSslErrors', event.target.checked)}
                />
                <span style={{ color: 'var(--api-muted)', fontSize: 12 }}>curl -k</span>
                <span />
              </label>
              <div className="api-header-row" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 2fr) 1fr 58px' }}>
                <span>Custom User-Agent</span>
                <input
                  value={request.userAgent ?? ''}
                  onChange={(event) => updateRequest('userAgent', event.target.value)}
                  placeholder="ShellDesk/1.0"
                />
                <span style={{ color: 'var(--api-muted)', fontSize: 12 }}>curl -A</span>
                <button type="button" onClick={() => updateRequest('userAgent', '')}>清空</button>
              </div>
            </div>
          </section>
        ) : null}
        <section className="api-request-line" style={{ minHeight: 0, alignItems: 'stretch', flexDirection: 'column' }}>
          <div className="api-response-actions">
            <button type="button" onClick={() => setShowEnvironmentEditor((value) => !value)}>
              环境变量
            </button>
            <button type="button" onClick={addEnvironmentVariable}>新增变量</button>
          </div>
          {showEnvironmentEditor ? (
            <div className="api-header-editor" style={{ padding: 0 }}>
              {environmentVariables.map((variable) => (
                <div key={variable.id} className="api-header-row">
                  <label className="api-header-enabled">
                    <input type="checkbox" checked={variable.enabled} onChange={(event) => updateEnvironmentVariable(variable.id, { enabled: event.target.checked })} />
                  </label>
                  <input value={variable.key} onChange={(event) => updateEnvironmentVariable(variable.id, { key: event.target.value })} placeholder="baseUrl" />
                  <input value={variable.value} onChange={(event) => updateEnvironmentVariable(variable.id, { value: event.target.value })} placeholder="https://api.example.com" />
                  <button type="button" onClick={() => removeEnvironmentVariable(variable.id)}>{tCurrent('auto.remoteApiDebugger.1t2vi4h')}</button>
                </div>
              ))}
              {!environmentVariables.length ? <span style={{ color: 'var(--api-muted)', fontSize: 12 }}>在 URL、Header value、Body 中使用 {'{{variableName}}'}</span> : null}
            </div>
          ) : null}
        </section>

        {error ? <DismissibleAlert className="api-alert danger" onDismiss={() => setError('')} role="alert">{error}</DismissibleAlert> : null}
        {notice ? <DismissibleAlert className="api-alert info" onDismiss={() => setNotice('')}>{notice}</DismissibleAlert> : null}

        <section className="api-request-panel">
          <div className="api-tabs">
            <button type="button" className={requestTab === 'headers' ? 'active' : ''} onClick={() => setRequestTab('headers')}>Headers</button>
            <button type="button" className={requestTab === 'params' ? 'active' : ''} onClick={() => setRequestTab('params')}>Params</button>
            <button type="button" className={requestTab === 'body' ? 'active' : ''} onClick={() => setRequestTab('body')}>Body</button>
            <button type="button" className={showSensitive ? 'active' : ''} onClick={() => { setShowSensitive((value) => !value); setPendingFullCurlCopy(false); }}>
              {showSensitive ? '隐藏敏感信息' : '显示敏感信息'}
            </button>
            <button type="button" onClick={copyCurl} disabled={!curlPreview}>{tCurrent('auto.remoteApiDebugger.up9ow0')}</button>
          </div>

          {requestTab === 'headers' ? (
            <div className="api-header-editor">
              <div className="api-header-row">
                <span />
                <select value={auth.type} onChange={(event) => updateAuth({ type: event.target.value as ApiDebugAuthConfig['type'] })} aria-label="Auth">
                  <option value="none">None</option>
                  <option value="bearer">Bearer Token</option>
                  <option value="basic">Basic Auth</option>
                  <option value="apiKey">API Key</option>
                </select>
                {auth.type === 'bearer' ? (
                  <input value={showSensitive ? auth.bearerToken : maskSensitiveValue(auth.bearerToken)} readOnly={!showSensitive && Boolean(auth.bearerToken)} onChange={(event) => updateAuth({ bearerToken: event.target.value })} placeholder="Token" />
                ) : auth.type === 'basic' ? (
                  <input value={auth.basicUsername} onChange={(event) => updateAuth({ basicUsername: event.target.value })} placeholder="Username" />
                ) : auth.type === 'apiKey' ? (
                  <input value={auth.apiKeyName} onChange={(event) => updateAuth({ apiKeyName: event.target.value })} placeholder="X-API-Key" />
                ) : (
                  <span />
                )}
                {auth.type === 'basic' ? (
                  <input value={showSensitive ? auth.basicPassword : maskSensitiveValue(auth.basicPassword)} readOnly={!showSensitive && Boolean(auth.basicPassword)} onChange={(event) => updateAuth({ basicPassword: event.target.value })} placeholder="Password" />
                ) : auth.type === 'apiKey' ? (
                  <input value={showSensitive ? auth.apiKeyValue : maskSensitiveValue(auth.apiKeyValue)} readOnly={!showSensitive && Boolean(auth.apiKeyValue)} onChange={(event) => updateAuth({ apiKeyValue: event.target.value })} placeholder="Value" />
                ) : (
                  <span />
                )}
              </div>
              {request.headers.map((header) => (
                <div key={header.id} className="api-header-row">
                  <label className="api-header-enabled">
                    <input type="checkbox" checked={header.enabled} disabled={header.managedByAuth} onChange={(event) => updateHeader(header.id, { enabled: event.target.checked })} />
                  </label>
                  <input value={header.key} readOnly={header.managedByAuth} onChange={(event) => updateHeader(header.id, { key: event.target.value })} placeholder="Header" />
                  <input
                    value={getHeaderDisplayValue(header, showSensitive)}
                    readOnly={header.managedByAuth || (!showSensitive && isSensitiveHeaderName(header.key))}
                    onChange={(event) => updateHeader(header.id, { value: event.target.value })}
                    placeholder="Value"
                  />
                  <button type="button" disabled={header.managedByAuth} onClick={() => removeHeader(header.id)}>{tCurrent('auto.remoteApiDebugger.1t2vi4h')}</button>
                </div>
              ))}
              <button type="button" className="api-add-header" onClick={addHeader}>{tCurrent('auto.remoteApiDebugger.151vjqk')}</button>
            </div>
          ) : requestTab === 'params' ? (
            <div className="api-header-editor">
              {(request.queryParams ?? []).map((param) => (
                <div key={param.id} className="api-header-row">
                  <label className="api-header-enabled">
                    <input type="checkbox" checked={param.enabled} onChange={(event) => updateParam(param.id, { enabled: event.target.checked })} />
                  </label>
                  <input value={param.key} onChange={(event) => updateParam(param.id, { key: event.target.value })} placeholder="Key" />
                  <input value={param.value} onChange={(event) => updateParam(param.id, { value: event.target.value })} placeholder="Value" />
                  <button type="button" onClick={() => removeParam(param.id)}>{tCurrent('auto.remoteApiDebugger.1t2vi4h')}</button>
                </div>
              ))}
              <button type="button" className="api-add-header" onClick={addParam}>新增参数</button>
            </div>
          ) : (
            <>
              <div className="api-request-line" style={{ minHeight: 42 }}>
                <select value={request.bodyType ?? 'raw'} onChange={(event) => updateBodyType(event.target.value as ApiDebugBodyType)} aria-label="Body 类型">
                  {bodyTypes.map((bodyType) => <option key={bodyType.value} value={bodyType.value}>{bodyType.label}</option>)}
                </select>
                {(request.bodyType ?? 'raw') === 'json' ? (
                  <button type="button" onClick={formatJsonRequestBody}>格式化</button>
                ) : null}
                {jsonBodyError ? <span style={{ color: 'var(--api-danger)', fontSize: 12, fontWeight: 730 }}>JSON 语法错误</span> : null}
              </div>
              {(request.bodyType ?? 'raw') === 'none' ? (
                <div className="api-history-empty">None 模式不会发送请求 Body。</div>
              ) : (request.bodyType ?? 'raw') === 'form' ? (
                <div className="api-header-editor">
                  {(request.formBody ?? []).map((param) => (
                    <div key={param.id} className="api-header-row">
                      <label className="api-header-enabled">
                        <input type="checkbox" checked={param.enabled} onChange={(event) => updateFormBodyParam(param.id, { enabled: event.target.checked })} />
                      </label>
                      <input value={param.key} onChange={(event) => updateFormBodyParam(param.id, { key: event.target.value })} placeholder="Key" />
                      <input value={param.value} onChange={(event) => updateFormBodyParam(param.id, { value: event.target.value })} placeholder="Value" />
                      <button type="button" onClick={() => removeFormBodyParam(param.id)}>{tCurrent('auto.remoteApiDebugger.1t2vi4h')}</button>
                    </div>
                  ))}
                  <button type="button" className="api-add-header" onClick={addFormBodyParam}>新增表单项</button>
                </div>
              ) : (
                <textarea
                  className="api-body-editor"
                  style={jsonBodyError ? { borderColor: 'var(--api-danger)' } : undefined}
                  value={request.body}
                  onChange={(event) => updateRequest('body', event.target.value)}
                  placeholder={request.method === 'GET' || request.method === 'HEAD' ? tCurrent('auto.remoteApiDebugger.1fcxvg1') : '{"hello":"world"}'}
                />
              )}
            </>
          )}
          {curlPreview ? <pre className="api-response-output">{curlPreview}</pre> : null}
        </section>

        <section className="api-response-panel">
          <div className="api-response-head">
            <div>
              <span>{tCurrent('auto.remoteApiDebugger.1qrcixw')}</span>
              <strong className={getStatusTone(activeRun?.response)}>
                {activeRun?.response.status ? `HTTP ${activeRun.response.status}` : activeRun ? tCurrent('auto.remoteApiDebugger.ewqer7', { value0: activeRun.response.exitCode }) : tCurrent('auto.remoteApiDebugger.8s70iv')}
              </strong>
              {activeRun ? <em>{activeRun.response.durationMs} ms</em> : null}
              {activeRun && activeResponseFormat ? (
                <em title={activeResponseContentType || 'Content-Type 未返回'}>
                  {getFormatLabel(activeResponseFormat, activeResponseContentType)}
                </em>
              ) : null}
            </div>
            <div className="api-response-actions">
              <button type="button" onClick={formatJsonResponse} disabled={!activeRun?.response.body}>{tCurrent('auto.remoteApiDebugger.1i126as')}</button>
              <button type="button" onClick={copyResponse} disabled={!activeRun}>{tCurrent('auto.remoteApiDebugger.d29aqr')}</button>
            </div>
          </div>

          <div className="api-tabs response">
            <button type="button" className={responseTab === 'body' ? 'active' : ''} onClick={() => setResponseTab('body')}>Body</button>
            <button type="button" className={responseTab === 'headers' ? 'active' : ''} onClick={() => setResponseTab('headers')}>Headers</button>
            <button type="button" className={responseTab === 'raw' ? 'active' : ''} onClick={() => setResponseTab('raw')}>Raw</button>
          </div>

          {activeRun && responseTab === 'body' && activeResponseFormat === 'json' && parsedJsonResponse && !parsedJsonResponse.error ? (
            <JsonTree key={activeRun.id} value={parsedJsonResponse.value} />
          ) : (
            <pre className="api-response-output">
              {activeRun
                ? responseTab === 'body'
                  ? activeRun.response.body || tCurrent('auto.remoteApiDebugger.35uav9')
                  : responseTab === 'headers'
                    ? activeRun.response.headersText || tCurrent('auto.remoteApiDebugger.tsbvt6')
                    : activeRun.response.raw || tCurrent('auto.remoteApiDebugger.1dwwbpe')
                : tCurrent('auto.remoteApiDebugger.1j708x')}
            </pre>
          )}
        </section>
      </main>
    </section>
  );
}

export default RemoteApiDebugger;
