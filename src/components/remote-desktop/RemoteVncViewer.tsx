import type RFB from '@novnc/novnc';
import type { RfbCredentials } from '@novnc/novnc';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';

import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import DismissibleAlert from './DismissibleAlert';

interface RemoteVncViewerProps {
  connectionId: string;
}

type VncStatus = 'idle' | 'probing' | 'starting' | 'connecting' | 'connected' | 'disconnected' | 'error';
type VncPerformanceMode = 'smooth' | 'balanced' | 'quality';
type VncViewMode = 'fit' | 'native' | 'scale';
type VncFailureKind = 'auth' | 'target' | 'proxy' | 'timeout' | 'disconnect' | 'ssh' | null;
type VncDiagnosticTone = 'info' | 'success' | 'warning' | 'error';

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

interface VncClipboardDetail {
  text?: string;
}

interface VncDiagnosticEntry {
  id: string;
  timestamp: string;
  stage: string;
  detail: string;
  tone: VncDiagnosticTone;
}

interface VncStoredTarget {
  host: string;
  port: number;
  username: string;
  shared: boolean;
}

const defaultVncPort = 5900;
const maxDiagnostics = 80;
const vncInspectorPreferenceKey = 'vnc.diagnostic-inspector.v1';
const vncTargetPreferenceKey = 'vnc.last-target.v1';
const defaultVncStoredTarget: VncStoredTarget = {
  host: '127.0.0.1',
  port: defaultVncPort,
  username: '',
  shared: true,
};
const vncPerformancePresets: Record<VncPerformanceMode, { label: string; compressionLevel: number; qualityLevel: number }> = {
  smooth: { label: '流畅', compressionLevel: 1, qualityLevel: 2 },
  balanced: { label: '均衡', compressionLevel: 4, qualityLevel: 4 },
  quality: { label: '清晰', compressionLevel: 6, qualityLevel: 7 },
};
const vncViewModes: Record<VncViewMode, { label: string; description: string; scaleViewport: boolean; resizeSession: boolean }> = {
  fit: {
    label: '适配',
    description: '按窗口缩放远端画面',
    scaleViewport: true,
    resizeSession: false,
  },
  native: {
    label: '原始',
    description: '保留远端实际像素',
    scaleViewport: false,
    resizeSession: false,
  },
  scale: {
    label: '同步',
    description: '请求远端跟随窗口分辨率',
    scaleViewport: true,
    resizeSession: true,
  },
};

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

function isStoredVncTarget(value: unknown): value is VncStoredTarget {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const target = value as Partial<VncStoredTarget>;
  return (
    typeof target.host === 'string' &&
    typeof target.port === 'number' &&
    Number.isInteger(target.port) &&
    target.port >= 1 &&
    target.port <= 65535 &&
    typeof target.username === 'string' &&
    typeof target.shared === 'boolean'
  );
}

async function readStoredVncTarget() {
  try {
    const storedTarget = await window.guiSSH?.preferences?.get(vncTargetPreferenceKey);

    return isStoredVncTarget(storedTarget) ? storedTarget : defaultVncStoredTarget;
  } catch {
    return defaultVncStoredTarget;
  }
}

async function writeStoredVncTarget(target: VncStoredTarget) {
  await window.guiSSH?.preferences?.set(vncTargetPreferenceKey, target).catch(() => undefined);
}

async function readVncInspectorOpen() {
  try {
    return await window.guiSSH?.preferences?.get(vncInspectorPreferenceKey) !== 'closed';
  } catch {
    return true;
  }
}

async function writeVncInspectorOpen(isOpen: boolean) {
  await window.guiSSH?.preferences?.set(vncInspectorPreferenceKey, isOpen ? 'open' : 'closed').catch(() => undefined);
}

function getVncStatusLabel(status: VncStatus) {
  switch (status) {
    case 'probing':
      return '检测中';
    case 'starting':
      return '准备连接';
    case 'connecting':
      return '握手中';
    case 'connected':
      return '已连接';
    case 'disconnected':
      return '已断开';
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

function formatDuration(durationMs: number) {
  if (durationMs < 1000) {
    return `${Math.round(durationMs)} ms`;
  }

  return `${(durationMs / 1000).toFixed(1)} s`;
}

function getFailureCopy(failureKind: VncFailureKind, errorMessage: string) {
  switch (failureKind) {
    case 'auth':
      return {
        title: '认证失败',
        detail: errorMessage || 'VNC 服务拒绝了当前凭据或安全协商。',
      };
    case 'target':
      return {
        title: '目标不可达',
        detail: errorMessage || 'SSH 已连接，但当前 VNC 地址或端口无法探测。',
      };
    case 'proxy':
      return {
        title: '代理未就绪',
        detail: errorMessage || '本地 WebSocket 桥或 noVNC 客户端未能启动。',
      };
    case 'timeout':
      return {
        title: '握手超时',
        detail: errorMessage || '隧道已经建立，但 RFB 握手没有完成。',
      };
    case 'disconnect':
      return {
        title: '连接中断',
        detail: errorMessage || '远端关闭了 VNC 会话。',
      };
    case 'ssh':
      return {
        title: 'SSH 已断开',
        detail: errorMessage || '承载 VNC 的 SSH 连接已结束。',
      };
    default:
      return {
        title: getVncStatusLabel(errorMessage ? 'error' : 'idle'),
        detail: errorMessage,
      };
  }
}

function RemoteVncViewer({ connectionId }: RemoteVncViewerProps) {
  const api = window.guiSSH;
  const screenRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const rfbRef = useRef<RFB | null>(null);
  const vncIdRef = useRef('');
  const handshakeTimerRef = useRef<number | null>(null);
  const connectStartedAtRef = useRef(0);
  const viewportRefreshTimersRef = useRef<number[]>([]);
  const disconnectingRef = useRef(false);
  const diagnosticCounterRef = useRef(0);
  const isInspectorPreferenceReadyRef = useRef(false);
  const [status, setStatus] = useState<VncStatus>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [failureKind, setFailureKind] = useState<VncFailureKind>(null);
  const [host, setHost] = useState(defaultVncStoredTarget.host);
  const [port, setPort] = useState(String(defaultVncStoredTarget.port));
  const [username, setUsername] = useState(defaultVncStoredTarget.username);
  const [password, setPassword] = useState('');
  const [shared, setShared] = useState(defaultVncStoredTarget.shared);
  const [viewOnly, setViewOnly] = useState(false);
  const [viewMode, setViewMode] = useState<VncViewMode>('fit');
  const [performanceMode, setPerformanceMode] = useState<VncPerformanceMode>('smooth');
  const [desktopName, setDesktopName] = useState('');
  const [connectedAt, setConnectedAt] = useState('');
  const [latencyLabel, setLatencyLabel] = useState('');
  const [diagnostics, setDiagnostics] = useState<VncDiagnosticEntry[]>([]);
  const [showInspector, setShowInspector] = useState(true);
  const [clipboardText, setClipboardText] = useState('');
  const [clipboardNotice, setClipboardNotice] = useState('剪贴板仅在你点击发送或复制时同步。');
  const [isStageFullscreen, setIsStageFullscreen] = useState(false);

  const viewOnlyRef = useRef(viewOnly);
  viewOnlyRef.current = viewOnly;
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;

  const isBusy = status === 'probing' || status === 'starting' || status === 'connecting';
  const isConnected = status === 'connected';
  const isTargetLocked = isBusy || isConnected;
  const targetLabel = `${host.trim() || '127.0.0.1'}:${parseVncPort(port)}`;
  const latestDiagnostic = diagnostics[diagnostics.length - 1];
  const failureCopy = getFailureCopy(failureKind, errorMessage);

  useEffect(() => {
    let disposed = false;

    void readStoredVncTarget().then((target) => {
      if (disposed) {
        return;
      }

      setHost(target.host);
      setPort(String(target.port));
      setUsername(target.username);
      setShared(target.shared);
    });

    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    let disposed = false;

    void readVncInspectorOpen().then((isOpen) => {
      if (disposed) {
        return;
      }

      setShowInspector(isOpen);
      isInspectorPreferenceReadyRef.current = true;
    });

    return () => {
      disposed = true;
    };
  }, []);

  const appendDiagnostic = useCallback((stage: string, detail: string, tone: VncDiagnosticTone = 'info') => {
    diagnosticCounterRef.current += 1;

    setDiagnostics((currentDiagnostics) => [
      ...currentDiagnostics.slice(-(maxDiagnostics - 1)),
      {
        id: `vnc-diagnostic-${diagnosticCounterRef.current}`,
        timestamp: new Date().toISOString(),
        stage,
        detail,
        tone,
      },
    ]);
  }, []);

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

      const nextViewMode = vncViewModes[viewMode];
      rfb.viewOnly = viewOnly;
      rfb.resizeSession = nextViewMode.resizeSession;
      rfb.clipViewport = true;
      rfb.scaleViewport = nextViewMode.scaleViewport;
    };

    window.requestAnimationFrame(applyViewport);

    if (!repeat) {
      return;
    }

    clearViewportRefreshTimers();
    viewportRefreshTimersRef.current = [80, 220, 520].map((delay) => window.setTimeout(applyViewport, delay));
  }, [viewMode, viewOnly]);

  const disconnectVnc = useCallback(async () => {
    const currentVncId = vncIdRef.current;
    disconnectingRef.current = true;
    clearHandshakeTimer();
    clearViewportRefreshTimers();
    vncIdRef.current = '';
    setDesktopName('');
    setConnectedAt('');
    setLatencyLabel('');
    setFailureKind(null);
    setErrorMessage('');

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
    setStatus(currentVncId ? 'disconnected' : 'idle');

    if (currentVncId) {
      appendDiagnostic('session', '用户已断开 VNC 会话。', 'warning');
    }
  }, [appendDiagnostic, stopProxy]);

  const connectVnc = useCallback(async () => {
    if (!api?.connections || !screenRef.current) {
      setStatus('error');
      setFailureKind('proxy');
      setErrorMessage('ShellDesk IPC 未就绪，无法启动 VNC。');
      return;
    }

    const targetHost = host.trim() || '127.0.0.1';
    const targetPort = parseVncPort(port);
    const trimmedUsername = username.trim();
    const nextVncId = createVncId();

    void writeStoredVncTarget({
      host: targetHost,
      port: targetPort,
      username: trimmedUsername,
      shared,
    });

    await disconnectVnc();
    disconnectingRef.current = false;
    vncIdRef.current = nextVncId;
    connectStartedAtRef.current = performance.now();
    setStatus('starting');
    setErrorMessage('');
    setFailureKind(null);
    setDesktopName('');
    setConnectedAt('');
    setLatencyLabel('');
    setDiagnostics([]);
    appendDiagnostic('session', `准备连接 SSH 可达目标 ${targetHost}:${targetPort}。`);

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
      appendDiagnostic('proxy', `本地 WebSocket 桥已启动，等待 RFB 握手。`, 'success');
      handshakeTimerRef.current = window.setTimeout(() => {
        if (vncIdRef.current !== nextVncId) {
          return;
        }

        vncIdRef.current = '';
        rfbRef.current?.disconnect();
        rfbRef.current = null;
        clearScreen();
        setStatus('error');
        setFailureKind('timeout');
        setErrorMessage('SSH 通道已打开，但 noVNC 没有完成 RFB 握手。请确认 VNC 密码、安全类型和目标服务状态。');
        appendDiagnostic('rfb', 'RFB 握手等待超过 25 秒。', 'error');
        void stopProxy(nextVncId);
      }, 25000);

      const credentials: RfbCredentials = {};

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
      const performancePreset = vncPerformancePresets[performanceMode];
      const initialViewMode = vncViewModes[viewMode];

      rfbRef.current = rfb;
      rfb.background = '#070b11';
      rfb.compressionLevel = performancePreset.compressionLevel;
      rfb.dragViewport = true;
      rfb.focusOnClick = true;
      rfb.qualityLevel = performancePreset.qualityLevel;
      rfb.showDotCursor = true;
      // clipViewport 设为 true（在 scaleViewport=false 时会正确设置 _viewportLoc）
      // scaleViewport 先不设（默认 false），等首帧 framebuffer 到达后再设为 true，
      // 否则构造时 _viewportLoc 为 {w:0,h:0}，autoscale 算出 Infinity 导致画面不可见。
      rfb.clipViewport = true;
      rfb.viewOnly = viewOnly;
      rfb.resizeSession = initialViewMode.resizeSession;

      rfb.addEventListener('connect', () => {
        if (vncIdRef.current !== nextVncId) {
          return;
        }

        clearHandshakeTimer();
        setStatus('connected');
        setConnectedAt(new Date().toISOString());
        setLatencyLabel(`握手 ${formatDuration(performance.now() - connectStartedAtRef.current)}`);
        appendDiagnostic('rfb', 'RFB 已连接，等待首帧画面。', 'success');
      });

      rfb.addEventListener('desktopname', (event) => {
        if (vncIdRef.current !== nextVncId) {
          return;
        }

        setDesktopName(getEventDetail<VncDesktopNameDetail>(event).name || '');
      });

      rfb.addEventListener('clipboard', (event) => {
        if (vncIdRef.current !== nextVncId) {
          return;
        }

        const text = getEventDetail<VncClipboardDetail>(event).text ?? '';
        setClipboardText(text);
        setClipboardNotice(`已收到远端剪贴板 ${text.length} 个字符。`);
        appendDiagnostic('clipboard', `收到远端剪贴板 ${text.length} 个字符。`, 'success');
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
          setFailureKind('auth');
          setErrorMessage(`VNC 服务需要 ${requestedTypes.join('、')} 凭据。`);
          appendDiagnostic('auth', `服务请求 ${requestedTypes.join('、')} 凭据。`, 'error');
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
        vncIdRef.current = '';
        rfbRef.current = null;
        clearScreen();
        setStatus('error');
        setFailureKind('auth');
        setErrorMessage(detail.reason || `VNC 安全协商失败${detail.status ? ` (${detail.status})` : ''}。`);
        appendDiagnostic('auth', detail.status ? `安全协商失败，状态 ${detail.status}。` : '安全协商失败。', 'error');
        void stopProxy(nextVncId);
        rfb.disconnect();
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

        if (wasManual || detail.clean) {
          setStatus('disconnected');
          appendDiagnostic('session', 'VNC 会话已正常结束。', 'warning');
          return;
        }

        setStatus('error');
        setFailureKind('disconnect');
        setErrorMessage('VNC 连接已意外断开，请检查地址、端口、防火墙或服务状态。');
        appendDiagnostic('session', '远端 VNC 连接意外断开。', 'error');
      });
    } catch (error) {
      clearHandshakeTimer();
      if (vncIdRef.current === nextVncId) {
        vncIdRef.current = '';
      }

      setStatus('error');
      setFailureKind('proxy');
      setErrorMessage(getErrorMessage(error));
      appendDiagnostic('proxy', getErrorMessage(error), 'error');
      await stopProxy(nextVncId);
    }
  }, [
    api,
    appendDiagnostic,
    connectionId,
    disconnectVnc,
    host,
    password,
    performanceMode,
    port,
    shared,
    stopProxy,
    username,
    viewMode,
    viewOnly,
  ]);

  const probeVnc = useCallback(async () => {
    if (!api?.connections || isTargetLocked) {
      return;
    }

    const targetHost = host.trim() || '127.0.0.1';
    const targetPort = parseVncPort(port);

    const probeStartedAt = performance.now();
    setStatus('probing');
    setErrorMessage('');
    setFailureKind(null);
    setLatencyLabel('');
    appendDiagnostic('probe', `检测 SSH 可达目标 ${targetHost}:${targetPort}。`);

    try {
      const probe = await api.connections.vncProbe(connectionId, {
        host: targetHost,
        port: targetPort,
      });
      const duration = formatDuration(performance.now() - probeStartedAt);
      setLatencyLabel(`探测 ${duration}`);
      setStatus('idle');
      appendDiagnostic('probe', `通道检测成功：${formatVncProbeResult(probe)}，耗时 ${duration}。`, 'success');
    } catch (error) {
      setStatus('error');
      setFailureKind('target');
      setErrorMessage(`VNC 通道检测失败：${getErrorMessage(error)}`);
      appendDiagnostic('probe', `通道检测失败：${getErrorMessage(error)}`, 'error');
    }
  }, [api, appendDiagnostic, connectionId, host, isTargetLocked, port]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void connectVnc();
  };

  const readLocalClipboard = useCallback(async () => {
    if (!navigator.clipboard?.readText) {
      setClipboardNotice('当前环境无法读取本机剪贴板。');
      return;
    }

    try {
      const text = await navigator.clipboard.readText();
      setClipboardText(text);
      setClipboardNotice(`已读取本机剪贴板 ${text.length} 个字符。`);
    } catch (error) {
      setClipboardNotice(`读取本机剪贴板失败：${getErrorMessage(error)}`);
    }
  }, []);

  const sendClipboardToRemote = useCallback(() => {
    const rfb = rfbRef.current;

    if (!rfb || !isConnected) {
      setClipboardNotice('连接 VNC 后才能发送剪贴板。');
      return;
    }

    rfb.clipboardPasteFrom(clipboardText);
    setClipboardNotice(`已发送 ${clipboardText.length} 个字符到远端。`);
    appendDiagnostic('clipboard', `发送剪贴板 ${clipboardText.length} 个字符到远端。`, 'success');
  }, [appendDiagnostic, clipboardText, isConnected]);

  const writeLocalClipboard = useCallback(async () => {
    if (!navigator.clipboard?.writeText) {
      setClipboardNotice('当前环境无法写入本机剪贴板。');
      return;
    }

    try {
      await navigator.clipboard.writeText(clipboardText);
      setClipboardNotice(`已复制 ${clipboardText.length} 个字符到本机剪贴板。`);
    } catch (error) {
      setClipboardNotice(`写入本机剪贴板失败：${getErrorMessage(error)}`);
    }
  }, [clipboardText]);

  const toggleStageFullscreen = useCallback(async () => {
    const stage = stageRef.current;

    if (!stage) {
      return;
    }

    try {
      if (document.fullscreenElement === stage) {
        await document.exitFullscreen();
        return;
      }

      await stage.requestFullscreen();
    } catch (error) {
      setErrorMessage(`无法切换沉浸模式：${getErrorMessage(error)}`);
    }
  }, []);

  useEffect(() => {
    if (!api?.events.onVncDiagnostic) {
      return undefined;
    }

    return api.events.onVncDiagnostic((payload) => {
      if (payload.connectionId !== connectionId || payload.vncId !== vncIdRef.current) {
        return;
      }

      appendDiagnostic(payload.stage, payload.detail);
    });
  }, [api, appendDiagnostic, connectionId]);

  // 监听 SSH 连接断开，记录原因到状态栏
  useEffect(() => {
    if (!api?.events.onConnectionClosed) {
      return undefined;
    }

    return api.events.onConnectionClosed((payload) => {
      if (payload.connectionId !== connectionId) {
        return;
      }

      const currentVncId = vncIdRef.current;
      const time = new Date().toLocaleTimeString(getShellDeskLocale());
      vncIdRef.current = '';
      clearHandshakeTimer();
      clearViewportRefreshTimers();

      if (rfbRef.current) {
        try {
          rfbRef.current.disconnect();
        } catch {
          // Ignore teardown races after the SSH transport goes away.
        }

        rfbRef.current = null;
      }

      clearScreen();
      setStatus('error');
      setFailureKind('ssh');
      setErrorMessage(`SSH 已断开${payload.reason ? `：${payload.reason}` : ''} (${time})`);
      setDesktopName('');
      setConnectedAt('');
      setLatencyLabel('');
      appendDiagnostic('ssh', `承载 VNC 的 SSH 连接已断开${payload.reason ? `：${payload.reason}` : ''}。`, 'error');
      void stopProxy(currentVncId);
    });
  }, [api, appendDiagnostic, connectionId, stopProxy]);

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
      const nextViewMode = vncViewModes[viewModeRef.current];
      rfb.scaleViewport = nextViewMode.scaleViewport;
      rfb.viewOnly = viewOnlyRef.current;
      rfb.resizeSession = nextViewMode.resizeSession;
      appendDiagnostic('viewport', `${nextViewMode.label}模式已应用。`, 'success');
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
  }, [appendDiagnostic, status]);

  useEffect(() => {
    const rfb = rfbRef.current;

    if (!rfb) {
      return;
    }

    const nextViewMode = vncViewModes[viewMode];
    rfb.viewOnly = viewOnly;
    rfb.scaleViewport = nextViewMode.scaleViewport;
    rfb.resizeSession = nextViewMode.resizeSession;
    refreshVncViewport(false);
  }, [refreshVncViewport, viewMode, viewOnly]);

  useEffect(() => {
    const rfb = rfbRef.current;

    if (!rfb) {
      return;
    }

    const performancePreset = vncPerformancePresets[performanceMode];
    rfb.compressionLevel = performancePreset.compressionLevel;
    rfb.qualityLevel = performancePreset.qualityLevel;
    appendDiagnostic('performance', `切换为${performancePreset.label}模式。`);
  }, [appendDiagnostic, performanceMode]);

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
    const updateFullscreenState = () => setIsStageFullscreen(document.fullscreenElement === stageRef.current);

    document.addEventListener('fullscreenchange', updateFullscreenState);

    return () => document.removeEventListener('fullscreenchange', updateFullscreenState);
  }, []);

  useEffect(() => {
    if (!isInspectorPreferenceReadyRef.current) {
      return;
    }

    void writeVncInspectorOpen(showInspector);
  }, [showInspector]);

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
      <form className={`vnc-toolbar ${isConnected ? 'compact' : ''}`} onSubmit={handleSubmit}>
        {isConnected ? (
          <div className="vnc-connected-target">
            <span>SSH 通道</span>
            <strong title={desktopName || targetLabel}>{desktopName || targetLabel}</strong>
            <em>{targetLabel}</em>
          </div>
        ) : (
          <div className="vnc-target-fields">
            <label className="vnc-field host">
              <span>主机</span>
              <input
                type="text"
                value={host}
                onChange={(event) => setHost(event.target.value)}
                placeholder="127.0.0.1"
                disabled={isTargetLocked}
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
                disabled={isTargetLocked}
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
                disabled={isTargetLocked}
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
                disabled={isTargetLocked}
              />
            </label>
          </div>
        )}
        <div className="vnc-toolbar-actions">
          {isConnected ? (
            <button type="button" className="vnc-control-btn" onClick={() => rfbRef.current?.sendCtrlAltDel()} disabled={viewOnly}>
              Ctrl+Alt+Del
            </button>
          ) : null}
          {isConnected ? (
            <button type="button" className="vnc-control-btn" onClick={() => void toggleStageFullscreen()}>
              {isStageFullscreen ? '退出沉浸' : '沉浸'}
            </button>
          ) : null}
          <button
            type="button"
            className={`vnc-control-btn ${showInspector ? 'active' : ''}`}
            onClick={() => setShowInspector((currentShowInspector) => !currentShowInspector)}
            aria-pressed={showInspector}
          >
            {showInspector ? '收起面板' : '诊断面板'}
          </button>
          {!isConnected ? (
            <button type="button" className="vnc-control-btn" onClick={() => void probeVnc()} disabled={isBusy}>
              {status === 'probing' ? '检测中' : '检测'}
            </button>
          ) : null}
          {isConnected || status === 'starting' || status === 'connecting' ? (
            <button type="button" className="vnc-control-btn danger" onClick={() => void disconnectVnc()}>
              断开
            </button>
          ) : (
            <button type="submit" className="vnc-control-btn primary" disabled={isBusy}>
              {status === 'disconnected' || status === 'error' ? '重连' : '连接'}
            </button>
          )}
        </div>
      </form>

      {errorMessage ? (
        <DismissibleAlert className="vnc-error-banner" onDismiss={() => setErrorMessage('')} role="alert">
          {errorMessage}
        </DismissibleAlert>
      ) : null}

      <div className={`vnc-workspace ${showInspector ? '' : 'inspector-closed'}`}>
        <div ref={stageRef} className="vnc-stage">
          <div ref={screenRef} className="vnc-screen" />
          {isStageFullscreen ? (
            <button type="button" className="vnc-fullscreen-exit vnc-control-btn" onClick={() => void toggleStageFullscreen()}>
              退出沉浸
            </button>
          ) : null}
          {!isConnected ? (
            <div className="vnc-stage-overlay">
              <strong>{status === 'error' ? failureCopy.title : getVncStatusLabel(status)}</strong>
              {status === 'error' && failureCopy.detail ? <span>{failureCopy.detail}</span> : null}
              <small>SSH 通道 · {targetLabel}</small>
              {!isBusy ? (
                <div className="vnc-overlay-actions">
                  <button type="button" className="vnc-control-btn primary" onClick={() => void connectVnc()}>
                    {status === 'disconnected' || status === 'error' ? '重连' : '连接'}
                  </button>
                  <button type="button" className="vnc-control-btn" onClick={() => void probeVnc()}>
                    检测
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
          <footer className="vnc-statusbar">
            <span className={`vnc-status-dot ${isConnected ? 'online' : ''}`} aria-hidden="true" />
            <strong>{getVncStatusLabel(status)}</strong>
            <span>{desktopName || `SSH 通道 · ${targetLabel}`}</span>
            {latencyLabel ? <em className="latency">{latencyLabel}</em> : null}
            {latestDiagnostic ? <em title={latestDiagnostic.detail}>{latestDiagnostic.stage}: {latestDiagnostic.detail}</em> : null}
            {connectedAt ? <time dateTime={connectedAt}>{new Date(connectedAt).toLocaleTimeString(getShellDeskLocale())}</time> : null}
          </footer>
        </div>

        {showInspector ? (
          <aside className="vnc-inspector">
            <section className="vnc-inspector-section">
              <header className="vnc-section-head">
                <strong>查看与性能</strong>
                <span>{vncViewModes[viewMode].description}</span>
              </header>
              <div className="vnc-view-mode-picker" role="group" aria-label="VNC 查看模式">
                {(Object.keys(vncViewModes) as VncViewMode[]).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={viewMode === mode ? 'active' : ''}
                    onClick={() => setViewMode(mode)}
                    aria-pressed={viewMode === mode}
                  >
                    {vncViewModes[mode].label}
                  </button>
                ))}
              </div>
              <label className="vnc-field performance">
                <span>性能模式</span>
                <select value={performanceMode} onChange={(event) => setPerformanceMode(event.target.value as VncPerformanceMode)}>
                  <option value="smooth">流畅</option>
                  <option value="balanced">均衡</option>
                  <option value="quality">清晰</option>
                </select>
              </label>
              <div className="vnc-toggle-row">
                <label className="vnc-toggle">
                  <input type="checkbox" checked={shared} onChange={(event) => setShared(event.target.checked)} disabled={isTargetLocked} />
                  <span>共享会话</span>
                </label>
                <label className="vnc-toggle">
                  <input type="checkbox" checked={viewOnly} onChange={(event) => setViewOnly(event.target.checked)} />
                  <span>只读输入</span>
                </label>
              </div>
            </section>

            <section className="vnc-inspector-section">
              <header className="vnc-section-head">
                <strong>剪贴板</strong>
                <span>{isConnected ? '显式同步，避免误发内容' : '连接后发送到远端'}</span>
              </header>
              <textarea
                className="vnc-clipboard-editor"
                value={clipboardText}
                onChange={(event) => setClipboardText(event.target.value)}
                placeholder="从本机读取、粘贴文本，或等待远端剪贴板到达"
                spellCheck={false}
              />
              <div className="vnc-inline-actions">
                <button type="button" className="vnc-control-btn" onClick={() => void readLocalClipboard()}>
                  读取本机
                </button>
                <button type="button" className="vnc-control-btn primary" onClick={sendClipboardToRemote} disabled={!isConnected}>
                  发送远端
                </button>
                <button type="button" className="vnc-control-btn" onClick={() => void writeLocalClipboard()} disabled={!clipboardText}>
                  复制本机
                </button>
              </div>
              <p className="vnc-clipboard-note">{clipboardNotice}</p>
            </section>

            <section className="vnc-inspector-section diagnostics">
              <header className="vnc-section-head">
                <strong>诊断时间线</strong>
                <button type="button" onClick={() => setDiagnostics([])} disabled={diagnostics.length === 0}>
                  清空
                </button>
              </header>
              {diagnostics.length === 0 ? (
                <p className="vnc-diagnostic-empty">探测或连接后显示代理、SSH 流和 RFB 阶段。</p>
              ) : (
                <ol className="vnc-diagnostic-list">
                  {diagnostics.map((diagnostic) => (
                    <li key={diagnostic.id} className={diagnostic.tone}>
                      <time dateTime={diagnostic.timestamp}>{new Date(diagnostic.timestamp).toLocaleTimeString(getShellDeskLocale())}</time>
                      <strong>{diagnostic.stage}</strong>
                      <span>{diagnostic.detail}</span>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </aside>
        ) : null}
      </div>
    </div>
  );
}

export default RemoteVncViewer;
