import { useMemo, useState } from 'react';

import {
  createApiDebugCommand,
  createCurlPreview,
  createHeaderId,
  createRequestId,
  formatJsonBody,
  parseApiDebugResponse,
  type ApiDebugHeader,
  type ApiDebugMethod,
  type ApiDebugRequest,
  type ApiDebugResponse,
} from './apiDebuggerUtils';
import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import { isWindowsSystem } from './remoteSystem';
import type { RemoteSystemType } from './types';

interface RemoteApiDebuggerProps {
  connectionId: string;
  systemType?: RemoteSystemType;
}

type RequestTab = 'headers' | 'body';
type ResponseTab = 'body' | 'headers' | 'raw';

interface ApiRunRecord {
  id: string;
  request: ApiDebugRequest;
  response: ApiDebugResponse;
  startedAt: string;
}

const methods: ApiDebugMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];
const maxHistory = 20;

function runCmd(connectionId: string, command: string) {
  const api = window.guiSSH?.connections;

  if (!api) {
    throw new Error('ShellDesk IPC 未就绪。');
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
    body: '',
    timeoutSeconds: 10,
  };
}

function cloneRequest(request: ApiDebugRequest): ApiDebugRequest {
  return {
    ...request,
    id: createRequestId(),
    headers: request.headers.map((header) => ({ ...header })),
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

function RemoteApiDebugger({ connectionId, systemType }: RemoteApiDebuggerProps) {
  const isWindowsHost = isWindowsSystem(systemType);
  const [request, setRequest] = useState<ApiDebugRequest>(() => createDefaultRequest());
  const [requestTab, setRequestTab] = useState<RequestTab>('headers');
  const [responseTab, setResponseTab] = useState<ResponseTab>('body');
  const [history, setHistory] = useState<ApiRunRecord[]>([]);
  const [activeRunId, setActiveRunId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const activeRun = useMemo(() => history.find((run) => run.id === activeRunId) ?? history[0] ?? null, [activeRunId, history]);
  const curlPreview = useMemo(() => {
    try {
      return createCurlPreview(request);
    } catch {
      return '';
    }
  }, [request]);

  const updateRequest = <Key extends keyof ApiDebugRequest>(key: Key, value: ApiDebugRequest[Key]) => {
    setRequest((currentRequest) => ({ ...currentRequest, [key]: value }));
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

  const removeHeader = (id: string) => {
    setRequest((currentRequest) => ({
      ...currentRequest,
      headers: currentRequest.headers.filter((header) => header.id !== id),
    }));
  };

  const sendRequest = async () => {
    setLoading(true);
    setError('');
    setNotice('');
    const started = performance.now();

    try {
      const requestSnapshot = cloneRequest(request);
      const command = createApiDebugCommand(requestSnapshot, isWindowsHost);
      const result = await runCmd(connectionId, command);
      const response = parseApiDebugResponse(result.stdout, result.stderr, Math.round(performance.now() - started));
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
        setNotice(response.stderr || `curl 退出码 ${response.exitCode}`);
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
    const text = createCurlPreview(request);
    await navigator.clipboard.writeText(text);
    setNotice('已复制 curl 命令。');
  };

  const copyResponse = async () => {
    if (!activeRun) {
      return;
    }

    await navigator.clipboard.writeText(activeRun.response.body || activeRun.response.headersText || activeRun.response.raw);
    setNotice('已复制响应内容。');
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
      setNotice('JSON 已格式化。');
    } catch (error) {
      setError(`JSON 格式化失败：${getErrorMessage(error)}`);
    }
  };

  return (
    <section className="api-debugger">
      <aside className="api-history">
        <div className="api-history-head">
          <strong>请求历史</strong>
          <span>最近 {maxHistory} 次</span>
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
              <em>{run.startedAt} · {run.response.durationMs} ms</em>
            </button>
          ))}
          {!history.length ? <div className="api-history-empty">暂无请求历史。</div> : null}
        </div>
      </aside>

      <main className="api-main">
        <header className="api-request-line">
          <select value={request.method} onChange={(event) => updateRequest('method', event.target.value as ApiDebugMethod)} aria-label="HTTP 方法">
            {methods.map((method) => <option key={method} value={method}>{method}</option>)}
          </select>
          <input value={request.url} onChange={(event) => updateRequest('url', event.target.value)} placeholder="http://127.0.0.1:8080/health" />
          <input
            className="api-timeout"
            type="number"
            min={1}
            max={120}
            value={request.timeoutSeconds}
            onChange={(event) => updateRequest('timeoutSeconds', Number(event.target.value))}
            aria-label="超时秒数"
          />
          <button type="button" className="primary" onClick={sendRequest} disabled={loading}>{loading ? '发送中' : '发送'}</button>
        </header>

        {error ? <div className="api-alert danger">{error}</div> : null}
        {notice ? <div className="api-alert info">{notice}</div> : null}

        <section className="api-request-panel">
          <div className="api-tabs">
            <button type="button" className={requestTab === 'headers' ? 'active' : ''} onClick={() => setRequestTab('headers')}>Headers</button>
            <button type="button" className={requestTab === 'body' ? 'active' : ''} onClick={() => setRequestTab('body')}>Body</button>
            <button type="button" onClick={copyCurl} disabled={!curlPreview}>复制 curl</button>
          </div>

          {requestTab === 'headers' ? (
            <div className="api-header-editor">
              {request.headers.map((header) => (
                <div key={header.id} className="api-header-row">
                  <label className="api-header-enabled">
                    <input type="checkbox" checked={header.enabled} onChange={(event) => updateHeader(header.id, { enabled: event.target.checked })} />
                  </label>
                  <input value={header.key} onChange={(event) => updateHeader(header.id, { key: event.target.value })} placeholder="Header" />
                  <input value={header.value} onChange={(event) => updateHeader(header.id, { value: event.target.value })} placeholder="Value" />
                  <button type="button" onClick={() => removeHeader(header.id)}>删除</button>
                </div>
              ))}
              <button type="button" className="api-add-header" onClick={addHeader}>新增 Header</button>
            </div>
          ) : (
            <textarea
              className="api-body-editor"
              value={request.body}
              onChange={(event) => updateRequest('body', event.target.value)}
              placeholder={request.method === 'GET' || request.method === 'HEAD' ? 'GET/HEAD 不发送 body' : '{"hello":"world"}'}
            />
          )}
        </section>

        <section className="api-response-panel">
          <div className="api-response-head">
            <div>
              <span>响应</span>
              <strong className={getStatusTone(activeRun?.response)}>
                {activeRun?.response.status ? `HTTP ${activeRun.response.status}` : activeRun ? `退出码 ${activeRun.response.exitCode}` : '尚未发送'}
              </strong>
              {activeRun ? <em>{activeRun.response.durationMs} ms</em> : null}
            </div>
            <div className="api-response-actions">
              <button type="button" onClick={formatJsonResponse} disabled={!activeRun?.response.body}>格式化 JSON</button>
              <button type="button" onClick={copyResponse} disabled={!activeRun}>复制响应</button>
            </div>
          </div>

          <div className="api-tabs response">
            <button type="button" className={responseTab === 'body' ? 'active' : ''} onClick={() => setResponseTab('body')}>Body</button>
            <button type="button" className={responseTab === 'headers' ? 'active' : ''} onClick={() => setResponseTab('headers')}>Headers</button>
            <button type="button" className={responseTab === 'raw' ? 'active' : ''} onClick={() => setResponseTab('raw')}>Raw</button>
          </div>

          <pre className="api-response-output">
            {activeRun
              ? responseTab === 'body'
                ? activeRun.response.body || '响应体为空。'
                : responseTab === 'headers'
                  ? activeRun.response.headersText || '响应头为空。'
                  : activeRun.response.raw || '没有原始输出。'
              : '配置请求后点击发送。'}
          </pre>
        </section>
      </main>
    </section>
  );
}

export default RemoteApiDebugger;
