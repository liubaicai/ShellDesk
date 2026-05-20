import type RFB from '@novnc/novnc';
import type { RfbCredentials } from '@novnc/novnc';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';

import { getErrorMessage } from './desktopUtils';

interface RemoteVncViewerProps {
  connectionId: string;
}

type VncStatus = 'idle' | 'starting' | 'connecting' | 'connected' | 'error';

interface VncCredentialsRequiredDetail {
  types?: string[];
}

interface VncDesktopNameDetail {
  name?: string;
}

interface VncDisconnectDetail {
  clean?: boolean;
}

interface VncSecurityFailureDetail {
  reason?: string;
  status?: number;
}

const defaultVncPort = 5900;

function createVncId() {
  if ('randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `vnc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getEventDetail<T>(event: Event): T {
  return (event as CustomEvent<T>).detail;
}

function parseVncPort(value: string) {
  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : defaultVncPort;
}

function getVncStatusLabel(status: VncStatus) {
  switch (status) {
    case 'starting':
      return '准备连接';
    case 'connecting':
      return '握手中';
    case 'connected':
      return '已连接';
    case 'error':
      return '连接失败';
    default:
      return '未连接';
  }
}

function formatVncProbeResult(probe: ShellDeskVncProbeResult) {
  const securityTypes = probe.securityTypes.map((type) => `${type.name}(${type.code})`).join('、') || '未知';
  return `${probe.banner} · ${securityTypes}`;
}

function RemoteVncViewer({ connectionId }: RemoteVncViewerProps) {
  const api = window.guiSSH;
  const screenRef = useRef<HTMLDivElement | null>(null);
  const rfbRef = useRef<RFB | null>(null);
  const vncIdRef = useRef('');
  const handshakeTimerRef = useRef<number | null>(null);
  const viewportRefreshTimersRef = useRef<number[]>([]);
  const disconnectingRef = useRef(false);
  const [status, setStatus] = useState<VncStatus>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState(String(defaultVncPort));
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [shared, setShared] = useState(true);
  const [viewOnly, setViewOnly] = useState(false);
  const [scaleViewport, setScaleViewport] = useState(true);
  const [resizeSession, setResizeSession] = useState(false);
  const [desktopName, setDesktopName] = useState('');
  const [connectedAt, setConnectedAt] = useState('');
  const [probeMessage, setProbeMessage] = useState('');
  const [isProbing, setIsProbing] = useState(false);
  const [diagnosticMessage, setDiagnosticMessage] = useState('');

  const viewOnlyRef = useRef(viewOnly);
  viewOnlyRef.current = viewOnly;
  const scaleViewportRef = useRef(scaleViewport);
  scaleViewportRef.current = scaleViewport;
  const resizeSessionRef = useRef(resizeSession);
  resizeSessionRef.current = resizeSession;

  const isBusy = status === 'starting' || status === 'connecting';
  const isConnected = status === 'connected';
  const isLocked = isBusy || isConnected;

  const stopProxy = useCallback(async (vncId: string) => {
    if (!vncId || !api?.connections) {
      return;
    }

    await api.connections.vncStop(connectionId, vncId).catch(() => undefined);
  }, [api, connectionId]);

  const clearScreen = () => {
    if (screenRef.current) {
      screenRef.current.replaceChildren();
    }
  };

  const clearHandshakeTimer = () => {
    if (handshakeTimerRef.current !== null) {
      window.clearTimeout(handshakeTimerRef.current);
      handshakeTimerRef.current = null;
    }
  };

  const clearViewportRefreshTimers = () => {
    for (const timer of viewportRefreshTimersRef.current) {
      window.clearTimeout(timer);
    }

    viewportRefreshTimersRef.current = [];
  };

  const refreshVncViewport = useCallback((repeat = false) => {
    const applyViewport = () => {
      const rfb = rfbRef.current;

      if (!rfb) {
        return;
      }

      rfb.viewOnly = viewOnly;
      rfb.resizeSession = resizeSession;
      rfb.clipViewport = true;
      rfb.scaleViewport = scaleViewport;
    };

    window.requestAnimationFrame(applyViewport);

    if (!repeat) {
      return;
    }

    clearViewportRefreshTimers();
    viewportRefreshTimersRef.current = [80, 220, 520].map((delay) => window.setTimeout(applyViewport, delay));
  }, [resizeSession, scaleViewport, viewOnly]);

  const disconnectVnc = useCallback(async () => {
    const currentVncId = vncIdRef.current;
    disconnectingRef.current = true;
    clearHandshakeTimer();
    clearViewportRefreshTimers();
    vncIdRef.current = '';
    setDesktopName('');
    setConnectedAt('');
    setProbeMessage('');
    setDiagnosticMessage('');

    if (rfbRef.current) {
      try {
        rfbRef.current.disconnect();
      } catch {
        // noVNC can throw if the socket has already closed.
      }
      rfbRef.current = null;
    }

    clearScreen();
    await stopProxy(currentVncId);
    disconnectingRef.current = false;
    setStatus('idle');
  }, [stopProxy]);

  const connectVnc = useCallback(async () => {
    if (!api?.connections || !screenRef.current) {
      setStatus('error');
      setErrorMessage('ShellDesk IPC 未就绪，无法启动 VNC。');
      return;
    }

    const targetHost = host.trim() || '127.0.0.1';
    const targetPort = parseVncPort(port);
    const nextVncId = createVncId();

    await disconnectVnc();
    disconnectingRef.current = false;
    vncIdRef.current = nextVncId;
    setStatus('starting');
    setErrorMessage('');
    setDesktopName('');
    setConnectedAt('');
    setProbeMessage('');
    setDiagnosticMessage('');

    try {
      const proxy = await api.connections.vncStart(connectionId, {
        host: targetHost,
        port: targetPort,
        vncId: nextVncId,
      });

      if (vncIdRef.current !== nextVncId || !screenRef.current) {
        await stopProxy(nextVncId);
        return;
      }

      setStatus('connecting');
      handshakeTimerRef.current = window.setTimeout(() => {
        if (vncIdRef.current !== nextVncId) {
          return;
        }

        vncIdRef.current = '';
        rfbRef.current?.disconnect();
        rfbRef.current = null;
        clearScreen();
        setStatus('error');
        setErrorMessage('VNC 握手超时：SSH 隧道已打开，但 noVNC 没有完成 RFB 握手。请确认 VNC 密码、安全类型和目标服务状态。');
        void stopProxy(nextVncId);
      }, 25000);

      const credentials: RfbCredentials = {};
      const trimmedUsername = username.trim();

      if (trimmedUsername) {
        credentials.username = trimmedUsername;
      }

      if (password) {
        credentials.password = password;
      }

      const { default: RfbClient } = await import('@novnc/novnc');
      const rfb = new RfbClient(screenRef.current, proxy.webSocketUrl, {
        credentials,
        shared,
      });

      rfbRef.current = rfb;
      rfb.background = '#070b11';
      rfb.compressionLevel = 6;
      rfb.dragViewport = true;
      rfb.focusOnClick = true;
      rfb.qualityLevel = 4;
      rfb.showDotCursor = true;
      // clipViewport 设为 true（在 scaleViewport=false 时会正确设置 _viewportLoc）
      // scaleViewport 先不设（默认 false），等首帧 framebuffer 到达后再设为 true，
      // 否则构造时 _viewportLoc 为 {w:0,h:0}，autoscale 算出 Infinity 导致画面不可见。
      rfb.clipViewport = true;
      rfb.viewOnly = viewOnly;
      rfb.resizeSession = resizeSession;

      rfb.addEventListener('connect', () => {
        if (vncIdRef.current !== nextVncId) {
          return;
        }

        clearHandshakeTimer();
        setStatus('connected');
        setConnectedAt(new Date().toISOString());
        setDiagnosticMessage('viewport: 等待首帧画面...');
      });

      rfb.addEventListener('desktopname', (event) => {
        if (vncIdRef.current !== nextVncId) {
          return;
        }

        setDesktopName(getEventDetail<VncDesktopNameDetail>(event).name || '');
      });

      rfb.addEventListener('credentialsrequired', (event) => {
        if (vncIdRef.current !== nextVncId) {
          return;
        }

        const requestedTypes = getEventDetail<VncCredentialsRequiredDetail>(event).types ?? [];
        const nextCredentials: RfbCredentials = {};

        if (requestedTypes.includes('username') && trimmedUsername) {
          nextCredentials.username = trimmedUsername;
        }

        if (requestedTypes.includes('password') && password) {
          nextCredentials.password = password;
        }

        if (requestedTypes.includes('target')) {
          nextCredentials.target = targetHost;
        }

        const hasMissingCredential = requestedTypes.some((type) => !(type in nextCredentials));

        if (hasMissingCredential) {
          clearHandshakeTimer();
          vncIdRef.current = '';
          rfbRef.current = null;
          clearScreen();
          void stopProxy(nextVncId);
          setStatus('error');
          setErrorMessage(`VNC 服务需要 ${requestedTypes.join('、')} 凭据。`);
          rfb.disconnect();
          return;
        }

        rfb.sendCredentials(nextCredentials);
      });

      rfb.addEventListener('serververification', () => {
        rfb.approveServer();
      });

      rfb.addEventListener('securityfailure', (event) => {
        if (vncIdRef.current !== nextVncId) {
          return;
        }

        const detail = getEventDetail<VncSecurityFailureDetail>(event);
        clearHandshakeTimer();
        setStatus('error');
        setErrorMessage(detail.reason || `VNC 安全协商失败${detail.status ? ` (${detail.status})` : ''}。`);
      });

      rfb.addEventListener('disconnect', (event) => {
        if (vncIdRef.current !== nextVncId) {
          return;
        }

        const detail = getEventDetail<VncDisconnectDetail>(event);
        const wasManual = disconnectingRef.current;
        clearHandshakeTimer();
        vncIdRef.current = '';
        rfbRef.current = null;
        clearScreen();
        void stopProxy(nextVncId);
        setDesktopName('');
        setConnectedAt('');
        setProbeMessage('');
        setDiagnosticMessage('');

        if (wasManual || detail.clean) {
          setStatus('idle');
          return;
        }

        setStatus('error');
        setErrorMessage('VNC 连接已意外断开，请检查地址、端口、防火墙或服务状态。');
      });
    } catch (error) {
      clearHandshakeTimer();
      if (vncIdRef.current === nextVncId) {
        vncIdRef.current = '';
      }

      setStatus('error');
      setErrorMessage(getErrorMessage(error));
      setProbeMessage('');
      setDiagnosticMessage('');
      await stopProxy(nextVncId);
    }
  }, [
    api,
    connectionId,
    disconnectVnc,
    host,
    password,
    port,
    resizeSession,
    scaleViewport,
    shared,
    stopProxy,
    username,
    viewOnly,
  ]);

  const probeVnc = useCallback(async () => {
    if (!api?.connections || isLocked || isProbing) {
      return;
    }

    const targetHost = host.trim() || '127.0.0.1';
    const targetPort = parseVncPort(port);

    setIsProbing(true);
    setErrorMessage('');
    setProbeMessage('');
    setDiagnosticMessage('');

    try {
      const probe = await api.connections.vncProbe(connectionId, {
        host: targetHost,
        port: targetPort,
      });
      setProbeMessage(`隧道检测成功：${formatVncProbeResult(probe)}`);
    } catch (error) {
      setErrorMessage(`VNC 隧道检测失败：${getErrorMessage(error)}`);
    } finally {
      setIsProbing(false);
    }
  }, [api, connectionId, host, isLocked, isProbing, port]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void connectVnc();
  };

  useEffect(() => {
    if (!api?.events.onVncDiagnostic) {
      return undefined;
    }

    return api.events.onVncDiagnostic((payload) => {
      if (payload.connectionId !== connectionId || payload.vncId !== vncIdRef.current) {
        return;
      }

      setDiagnosticMessage(`${payload.stage}: ${payload.detail}`);
    });
  }, [api, connectionId]);

  // 监听 SSH 连接断开，记录原因到状态栏
  useEffect(() => {
    if (!api?.events.onConnectionClosed) {
      return undefined;
    }

    return api.events.onConnectionClosed((payload) => {
      if (payload.connectionId !== connectionId) {
        return;
      }

      const time = new Date().toLocaleTimeString('zh-CN');
      setStatus('error');
      setErrorMessage(`SSH 已断开${payload.reason ? `：${payload.reason}` : ''} (${time})`);
      setDiagnosticMessage('');
    });
  }, [api, connectionId]);

  // 在 connect 事件后，等待 noVNC 收到首帧 framebuffer 再应用视口设置
  useEffect(() => {
    if (status !== 'connected' || !screenRef.current) {
      return;
    }

    const screen = screenRef.current;
    const rfb = rfbRef.current;

    if (!rfb) {
      return;
    }

    let disposed = false;
    let retries = 0;
    const maxRetries = 120; // ~2s at 60fps

    const applySettings = () => {
      // 首帧到达后 _viewportLoc 已有正确尺寸（由 _resize → _updateClip 设置），
      // 此时将 scaleViewport 从默认 false 改为目标值，autoscale 会拿到正确参数。
      rfb.scaleViewport = scaleViewportRef.current;
      rfb.viewOnly = viewOnlyRef.current;
      rfb.resizeSession = resizeSessionRef.current;
      setDiagnosticMessage('');
    };

    // noVNC 构造函数中已创建 canvas，但首帧 framebuffer 到达后 canvas 才会有尺寸。
    // 首帧渲染发生在 noVNC 自己的 rAF 回调中，所以需要在此之后执行。
    const tryApply = () => {
      if (disposed) {
        return;
      }

      const canvas = screen.querySelector('canvas');

      // canvas 存在且有非零尺寸 → 首帧已渲染，可以安全应用设置
      if (canvas && canvas.width > 0 && canvas.height > 0) {
        applySettings();
        return;
      }

      retries += 1;

      if (retries >= maxRetries) {
        // 超时后强制应用（canvas 0x0 时 scaleViewport setter 是 no-op，但至少兜底）
        applySettings();
        return;
      }

      requestAnimationFrame(tryApply);
    };

    // 先给一帧让 noVNC 处理 connect 后可能立即到达的 framebuffer
    requestAnimationFrame(tryApply);

    return () => {
      disposed = true;
    };
  }, [status]);

  useEffect(() => {
    const rfb = rfbRef.current;

    if (!rfb) {
      return;
    }

    rfb.viewOnly = viewOnly;
    rfb.scaleViewport = scaleViewport;
    rfb.resizeSession = resizeSession;
    refreshVncViewport(false);
  }, [resizeSession, scaleViewport, viewOnly]);

  useEffect(() => {
    const screenElement = screenRef.current;

    if (!screenElement || typeof ResizeObserver === 'undefined') {
      return undefined;
    }

    const resizeObserver = new ResizeObserver(() => refreshVncViewport(false));
    resizeObserver.observe(screenElement);

    return () => resizeObserver.disconnect();
  }, [refreshVncViewport]);

  useEffect(() => {
    return () => {
      const currentVncId = vncIdRef.current;
      vncIdRef.current = '';

      if (rfbRef.current) {
        try {
          rfbRef.current.disconnect();
        } catch {
          // ignore shutdown races
        }
      }

      clearHandshakeTimer();
      clearViewportRefreshTimers();
      void stopProxy(currentVncId);
    };
  }, [stopProxy]);

  return (
    <div className={`vnc-viewer-pane ${status}`}>
      <form className="vnc-toolbar" onSubmit={handleSubmit}>
        <div className="vnc-target-fields">
          <label className="vnc-field host">
            <span>主机</span>
            <input
              type="text"
              value={host}
              onChange={(event) => setHost(event.target.value)}
              placeholder="127.0.0.1"
              disabled={isLocked}
              spellCheck={false}
            />
          </label>
          <label className="vnc-field port">
            <span>端口</span>
            <input
              type="text"
              value={port}
              onChange={(event) => setPort(event.target.value)}
              placeholder="5900"
              disabled={isLocked}
              inputMode="numeric"
            />
          </label>
          <label className="vnc-field username">
            <span>用户</span>
            <input
              type="text"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="可选"
              disabled={isLocked}
              spellCheck={false}
            />
          </label>
          <label className="vnc-field password">
            <span>密码</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="可留空"
              disabled={isLocked}
            />
          </label>
        </div>

        <div className="vnc-toolbar-actions">
          <label className="vnc-toggle">
            <input type="checkbox" checked={shared} onChange={(event) => setShared(event.target.checked)} disabled={isLocked} />
            <span>共享</span>
          </label>
          <label className="vnc-toggle">
            <input type="checkbox" checked={scaleViewport} onChange={(event) => setScaleViewport(event.target.checked)} />
            <span>缩放</span>
          </label>
          <label className="vnc-toggle">
            <input type="checkbox" checked={resizeSession} onChange={(event) => setResizeSession(event.target.checked)} />
            <span>同步分辨率</span>
          </label>
          <label className="vnc-toggle">
            <input type="checkbox" checked={viewOnly} onChange={(event) => setViewOnly(event.target.checked)} />
            <span>只看</span>
          </label>

          {isConnected ? (
            <button type="button" className="vnc-control-btn" onClick={() => rfbRef.current?.sendCtrlAltDel()}>
              Ctrl+Alt+Del
            </button>
          ) : null}
          {!isLocked ? (
            <button type="button" className="vnc-control-btn" onClick={() => void probeVnc()} disabled={isProbing}>
              {isProbing ? '检测中' : '检测'}
            </button>
          ) : null}
          {isLocked ? (
            <button type="button" className="vnc-control-btn danger" onClick={() => void disconnectVnc()}>
              断开
            </button>
          ) : (
            <button type="submit" className="vnc-control-btn primary" disabled={isBusy}>
              连接
            </button>
          )}
        </div>
      </form>

      {errorMessage ? <div className="vnc-error-banner">{errorMessage}</div> : null}

      <div className="vnc-stage">
        <div ref={screenRef} className="vnc-screen" />
        {!isConnected ? (
          <div className="vnc-stage-overlay">
            <strong>{getVncStatusLabel(status)}</strong>
            <span>SSH 隧道 · {host.trim() || '127.0.0.1'}:{parseVncPort(port)}</span>
          </div>
        ) : null}
        <footer className="vnc-statusbar">
          <span className={`vnc-status-dot ${isConnected ? 'online' : ''}`} aria-hidden="true" />
          <strong>{getVncStatusLabel(status)}</strong>
          <span>{desktopName || `SSH 隧道 · ${host.trim() || '127.0.0.1'}:${parseVncPort(port)}`}</span>
          {diagnosticMessage || probeMessage ? <em>{diagnosticMessage || probeMessage}</em> : null}
          {connectedAt ? <time dateTime={connectedAt}>{new Date(connectedAt).toLocaleTimeString('zh-CN')}</time> : null}
        </footer>
      </div>
    </div>
  );
}

export default RemoteVncViewer;
