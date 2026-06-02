import { useMemo, useState } from 'react';
import DismissibleAlert from './DismissibleAlert';

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
import { tCurrent } from '../../i18n';

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
    const text = createCurlPreview(request);
    await navigator.clipboard.writeText(text);
    setNotice(tCurrent('auto.remoteApiDebugger.1e5k4ep'));
  };

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

  return (
    <section className="api-debugger">
      <aside className="api-history">
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
          <input value={request.url} onChange={(event) => updateRequest('url', event.target.value)} placeholder="http://127.0.0.1:8080/health" />
          <input
            className="api-timeout"
            type="number"
            min={1}
            max={120}
            value={request.timeoutSeconds}
            onChange={(event) => updateRequest('timeoutSeconds', Number(event.target.value))}
            aria-label={tCurrent('auto.remoteApiDebugger.tabbi8')}
          />
          <button type="button" className="primary" onClick={sendRequest} disabled={loading}>{loading ? tCurrent('auto.remoteApiDebugger.19ewkta') : tCurrent('auto.remoteApiDebugger.j5vidj')}</button>
        </header>

        {error ? <DismissibleAlert className="api-alert danger" onDismiss={() => setError('')} role="alert">{error}</DismissibleAlert> : null}
        {notice ? <DismissibleAlert className="api-alert info" onDismiss={() => setNotice('')}>{notice}</DismissibleAlert> : null}

        <section className="api-request-panel">
          <div className="api-tabs">
            <button type="button" className={requestTab === 'headers' ? 'active' : ''} onClick={() => setRequestTab('headers')}>Headers</button>
            <button type="button" className={requestTab === 'body' ? 'active' : ''} onClick={() => setRequestTab('body')}>Body</button>
            <button type="button" onClick={copyCurl} disabled={!curlPreview}>{tCurrent('auto.remoteApiDebugger.up9ow0')}</button>
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
                  <button type="button" onClick={() => removeHeader(header.id)}>{tCurrent('auto.remoteApiDebugger.1t2vi4h')}</button>
                </div>
              ))}
              <button type="button" className="api-add-header" onClick={addHeader}>{tCurrent('auto.remoteApiDebugger.151vjqk')}</button>
            </div>
          ) : (
            <textarea
              className="api-body-editor"
              value={request.body}
              onChange={(event) => updateRequest('body', event.target.value)}
              placeholder={request.method === 'GET' || request.method === 'HEAD' ? tCurrent('auto.remoteApiDebugger.1fcxvg1') : '{"hello":"world"}'}
            />
          )}
        </section>

        <section className="api-response-panel">
          <div className="api-response-head">
            <div>
              <span>{tCurrent('auto.remoteApiDebugger.1qrcixw')}</span>
              <strong className={getStatusTone(activeRun?.response)}>
                {activeRun?.response.status ? `HTTP ${activeRun.response.status}` : activeRun ? tCurrent('auto.remoteApiDebugger.ewqer7', { value0: activeRun.response.exitCode }) : tCurrent('auto.remoteApiDebugger.8s70iv')}
              </strong>
              {activeRun ? <em>{activeRun.response.durationMs} ms</em> : null}
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

          <pre className="api-response-output">
            {activeRun
              ? responseTab === 'body'
                ? activeRun.response.body || tCurrent('auto.remoteApiDebugger.35uav9')
                : responseTab === 'headers'
                  ? activeRun.response.headersText || tCurrent('auto.remoteApiDebugger.tsbvt6')
                  : activeRun.response.raw || tCurrent('auto.remoteApiDebugger.1dwwbpe')
              : tCurrent('auto.remoteApiDebugger.1j708x')}
          </pre>
        </section>
      </main>
    </section>
  );
}

export default RemoteApiDebugger;
