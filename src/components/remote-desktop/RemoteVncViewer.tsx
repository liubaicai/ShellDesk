import type RFB from '@novnc/novnc';
import type { RfbCredentials } from '@novnc/novnc';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';

import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import DismissibleAlert from './DismissibleAlert';
import { loadRemoteConnectionProfile, readProfileBoolean, readProfileString, saveRemoteConnectionProfile } from './remoteConnectionProfiles';
import { tCurrent } from '../../i18n';

interface RemoteVncViewerProps {
  connectionId: string;
  hostId: string;
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
  smooth: { label: tCurrent('auto.remoteVncViewer.1w91dwr'), compressionLevel: 1, qualityLevel: 2 },
  balanced: { label: tCurrent('auto.remoteVncViewer.1cezww5'), compressionLevel: 4, qualityLevel: 4 },
  quality: { label: tCurrent('auto.remoteVncViewer.6uopsg'), compressionLevel: 6, qualityLevel: 7 },
};
const vncViewModes: Record<VncViewMode, { label: string; description: string; scaleViewport: boolean; resizeSession: boolean }> = {
  fit: {
    label: tCurrent('auto.remoteVncViewer.1ftcrko'),
    description: tCurrent('auto.remoteVncViewer.1gwh5e9'),
    scaleViewport: true,
    resizeSession: false,
  },
  native: {
    label: tCurrent('auto.remoteVncViewer.q7054v'),
    description: tCurrent('auto.remoteVncViewer.51yl20'),
    scaleViewport: false,
    resizeSession: false,
  },
  scale: {
    label: tCurrent('auto.remoteVncViewer.1fjkikq'),
    description: tCurrent('auto.remoteVncViewer.j8jp3w'),
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
      return tCurrent('auto.remoteVncViewer.xr2jgj');
    case 'starting':
      return tCurrent('auto.remoteVncViewer.19oz4az');
    case 'connecting':
      return tCurrent('auto.remoteVncViewer.1e234t4');
    case 'connected':
      return tCurrent('auto.remoteVncViewer.r2jbz0');
    case 'disconnected':
      return tCurrent('auto.remoteVncViewer.2dtce0');
    case 'error':
      return tCurrent('auto.remoteVncViewer.13c4qw6');
    default:
      return tCurrent('auto.remoteVncViewer.1x8ir3o');
  }
}

function formatVncProbeResult(probe: ShellDeskVncProbeResult) {
  const securityTypes = probe.securityTypes.map((type) => `${type.name}(${type.code})`).join('、') || tCurrent('auto.remoteVncViewer.1lpnuh4');
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
        title: tCurrent('auto.remoteVncViewer.pa8mu8'),
        detail: errorMessage || tCurrent('auto.remoteVncViewer.1wuhto6'),
      };
    case 'target':
      return {
        title: tCurrent('auto.remoteVncViewer.1fuxuu0'),
        detail: errorMessage || tCurrent('auto.remoteVncViewer.1kj5m0h'),
      };
    case 'proxy':
      return {
        title: tCurrent('auto.remoteVncViewer.6kdbjt'),
        detail: errorMessage || tCurrent('auto.remoteVncViewer.1b1gab'),
      };
    case 'timeout':
      return {
        title: tCurrent('auto.remoteVncViewer.1nhbfm'),
        detail: errorMessage || tCurrent('auto.remoteVncViewer.g3899r'),
      };
    case 'disconnect':
      return {
        title: tCurrent('auto.remoteVncViewer.uusy6y'),
        detail: errorMessage || tCurrent('auto.remoteVncViewer.1nbfypu'),
      };
    case 'ssh':
      return {
        title: tCurrent('auto.remoteVncViewer.x2ryv2'),
        detail: errorMessage || tCurrent('auto.remoteVncViewer.wjd59p'),
      };
    default:
      return {
        title: getVncStatusLabel(errorMessage ? 'error' : 'idle'),
        detail: errorMessage,
      };
  }
}

function RemoteVncViewer({ connectionId, hostId }: RemoteVncViewerProps) {
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
  const [clipboardNotice, setClipboardNotice] = useState(tCurrent('auto.remoteVncViewer.1ue13zr'));
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

    void (async () => {
      const profile = await loadRemoteConnectionProfile(hostId, 'vnc');

      if (disposed) {
        return;
      }

      if (profile) {
        setHost(readProfileString(profile, 'host', defaultVncStoredTarget.host));
        setPort(readProfileString(profile, 'port', String(defaultVncStoredTarget.port)));
        setUsername(readProfileString(profile, 'username', defaultVncStoredTarget.username));
        setPassword(readProfileString(profile, 'password', ''));
        setShared(readProfileBoolean(profile, 'shared', defaultVncStoredTarget.shared));
        return;
      }

      const target = await readStoredVncTarget();

      if (disposed) {
        return;
      }

      setHost(target.host);
      setPort(String(target.port));
      setUsername(target.username);
      setShared(target.shared);
    })();

    return () => {
      disposed = true;
    };
  }, [hostId]);

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
      appendDiagnostic('session', tCurrent('auto.remoteVncViewer.1kyri4v'), 'warning');
    }
  }, [appendDiagnostic, stopProxy]);

  const connectVnc = useCallback(async () => {
    if (!api?.connections || !screenRef.current) {
      setStatus('error');
      setFailureKind('proxy');
      setErrorMessage(tCurrent('auto.remoteVncViewer.xh1cuy'));
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
    appendDiagnostic('session', tCurrent('auto.remoteVncViewer.1fk2932', { value0: targetHost, value1: targetPort }));

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
      appendDiagnostic('proxy', tCurrent('auto.remoteVncViewer.1t0f05w'), 'success');
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
        setErrorMessage(tCurrent('auto.remoteVncViewer.z04e0a'));
        appendDiagnostic('rfb', tCurrent('auto.remoteVncViewer.1s81832'), 'error');
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
      // Keep clipViewport enabled so noVNC maintains _viewportLoc when scaleViewport is false.
      // Defer scaleViewport until the first framebuffer arrives; otherwise _viewportLoc starts
      // at {w:0,h:0}, autoscale computes Infinity, and the display can disappear.
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
        setLatencyLabel(tCurrent('auto.remoteVncViewer.nl7mmu', { value0: formatDuration(performance.now() - connectStartedAtRef.current) }));
        appendDiagnostic('rfb', tCurrent('auto.remoteVncViewer.53f91k'), 'success');
        void saveRemoteConnectionProfile(hostId, 'vnc', {
          host: targetHost,
          port: String(targetPort),
          username: trimmedUsername,
          password,
          shared,
        }).catch(() => undefined);
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
        setClipboardNotice(tCurrent('auto.remoteVncViewer.mqxyx5', { value0: text.length }));
        appendDiagnostic('clipboard', tCurrent('auto.remoteVncViewer.1xgy9l', { value0: text.length }), 'success');
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
          setErrorMessage(tCurrent('auto.remoteVncViewer.12etlmr', { value0: requestedTypes.join('、') }));
          appendDiagnostic('auth', tCurrent('auto.remoteVncViewer.1n7tpno', { value0: requestedTypes.join('、') }), 'error');
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
        setErrorMessage(detail.reason || tCurrent('auto.remoteVncViewer.3ztbo9', { value0: detail.status ? ` (${detail.status})` : '' }));
        appendDiagnostic('auth', detail.status ? tCurrent('auto.remoteVncViewer.n55eod', { value0: detail.status }) : tCurrent('auto.remoteVncViewer.3w5si3'), 'error');
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
          appendDiagnostic('session', tCurrent('auto.remoteVncViewer.1ue8ccg'), 'warning');
          return;
        }

        setStatus('error');
        setFailureKind('disconnect');
        setErrorMessage(tCurrent('auto.remoteVncViewer.15l8vv8'));
        appendDiagnostic('session', tCurrent('auto.remoteVncViewer.hf3tw8'), 'error');
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
    hostId,
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
    appendDiagnostic('probe', tCurrent('auto.remoteVncViewer.92ouu9', { value0: targetHost, value1: targetPort }));

    try {
      const probe = await api.connections.vncProbe(connectionId, {
        host: targetHost,
        port: targetPort,
      });
      const duration = formatDuration(performance.now() - probeStartedAt);
      setLatencyLabel(tCurrent('auto.remoteVncViewer.j1d6f7', { value0: duration }));
      setStatus('idle');
      appendDiagnostic('probe', tCurrent('auto.remoteVncViewer.rfrtus', { value0: formatVncProbeResult(probe), value1: duration }), 'success');
    } catch (error) {
      setStatus('error');
      setFailureKind('target');
      setErrorMessage(tCurrent('auto.remoteVncViewer.lnwsoh', { value0: getErrorMessage(error) }));
      appendDiagnostic('probe', tCurrent('auto.remoteVncViewer.1xmbnr0', { value0: getErrorMessage(error) }), 'error');
    }
  }, [api, appendDiagnostic, connectionId, host, isTargetLocked, port]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void connectVnc();
  };

  const readLocalClipboard = useCallback(async () => {
    if (!navigator.clipboard?.readText) {
      setClipboardNotice(tCurrent('auto.remoteVncViewer.1lf2z9w'));
      return;
    }

    try {
      const text = await navigator.clipboard.readText();
      setClipboardText(text);
      setClipboardNotice(tCurrent('auto.remoteVncViewer.jjd669', { value0: text.length }));
    } catch (error) {
      setClipboardNotice(tCurrent('auto.remoteVncViewer.tkpkre', { value0: getErrorMessage(error) }));
    }
  }, []);

  const sendClipboardToRemote = useCallback(() => {
    const rfb = rfbRef.current;

    if (!rfb || !isConnected) {
      setClipboardNotice(tCurrent('auto.remoteVncViewer.1p4vjno'));
      return;
    }

    rfb.clipboardPasteFrom(clipboardText);
    setClipboardNotice(tCurrent('auto.remoteVncViewer.pvg4ae', { value0: clipboardText.length }));
    appendDiagnostic('clipboard', tCurrent('auto.remoteVncViewer.149mt91', { value0: clipboardText.length }), 'success');
  }, [appendDiagnostic, clipboardText, isConnected]);

  const writeLocalClipboard = useCallback(async () => {
    if (!navigator.clipboard?.writeText) {
      setClipboardNotice(tCurrent('auto.remoteVncViewer.oup7lf'));
      return;
    }

    try {
      await navigator.clipboard.writeText(clipboardText);
      setClipboardNotice(tCurrent('auto.remoteVncViewer.xvvxyd', { value0: clipboardText.length }));
    } catch (error) {
      setClipboardNotice(tCurrent('auto.remoteVncViewer.b59pk1', { value0: getErrorMessage(error) }));
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
      setErrorMessage(tCurrent('auto.remoteVncViewer.19sa1t1', { value0: getErrorMessage(error) }));
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

  // Track SSH disconnects and surface the reason in the status bar.
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
      setErrorMessage(tCurrent('auto.remoteVncViewer.1gy2uhu', { value0: payload.reason ? `：${payload.reason}` : '', value1: time }));
      setDesktopName('');
      setConnectedAt('');
      setLatencyLabel('');
      appendDiagnostic('ssh', tCurrent('auto.remoteVncViewer.14q669f', { value0: payload.reason ? `：${payload.reason}` : '' }), 'error');
      void stopProxy(currentVncId);
    });
  }, [api, appendDiagnostic, connectionId, stopProxy]);

  // After connect, wait for noVNC to receive the first framebuffer before applying viewport settings.
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
      // Once the first frame arrives, _viewportLoc has valid dimensions from _resize -> _updateClip.
      // Setting scaleViewport here gives autoscale real inputs.
      const nextViewMode = vncViewModes[viewModeRef.current];
      rfb.scaleViewport = nextViewMode.scaleViewport;
      rfb.viewOnly = viewOnlyRef.current;
      rfb.resizeSession = nextViewMode.resizeSession;
      appendDiagnostic('viewport', tCurrent('auto.remoteVncViewer.e45oxs', { value0: nextViewMode.label }), 'success');
    };

    // noVNC creates the canvas in the constructor, but it gets dimensions only after the first framebuffer.
    // The first render runs in noVNC's own rAF callback, so apply settings afterward.
    const tryApply = () => {
      if (disposed) {
        return;
      }

      const canvas = screen.querySelector('canvas');

      // A non-zero canvas means the first frame rendered and settings can be applied safely.
      if (canvas && canvas.width > 0 && canvas.height > 0) {
        applySettings();
        return;
      }

      retries += 1;

      if (retries >= maxRetries) {
        // Force apply after timeout; scaleViewport is a no-op on a 0x0 canvas, but this is a fallback.
        applySettings();
        return;
      }

      requestAnimationFrame(tryApply);
    };

    // Give noVNC one frame to process a framebuffer that may arrive right after connect.
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
    appendDiagnostic('performance', tCurrent('auto.remoteVncViewer.1jojrg7', { value0: performancePreset.label }));
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
            <span>{tCurrent('auto.remoteVncViewer.18eis48')}</span>
            <strong title={desktopName || targetLabel}>{desktopName || targetLabel}</strong>
            <em>{targetLabel}</em>
          </div>
        ) : (
          <div className="vnc-target-fields">
            <label className="vnc-field host">
              <span>{tCurrent('auto.remoteVncViewer.5kj63k')}</span>
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
              <span>{tCurrent('auto.remoteVncViewer.19ijc5j')}</span>
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
              <span>{tCurrent('auto.remoteVncViewer.1in002o')}</span>
              <input
                type="text"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder={tCurrent('auto.remoteVncViewer.zflkxh')}
                disabled={isTargetLocked}
                spellCheck={false}
              />
            </label>
            <label className="vnc-field password">
              <span>{tCurrent('auto.remoteVncViewer.1aph6eg')}</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={tCurrent('auto.remoteVncViewer.y7iiel')}
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
              {isStageFullscreen ? tCurrent('auto.remoteVncViewer.1dol172') : tCurrent('auto.remoteVncViewer.9i1w7o')}
            </button>
          ) : null}
          <button
            type="button"
            className={`vnc-control-btn ${showInspector ? 'active' : ''}`}
            onClick={() => setShowInspector((currentShowInspector) => !currentShowInspector)}
            aria-pressed={showInspector}
          >
            {showInspector ? tCurrent('auto.remoteVncViewer.1u09do5') : tCurrent('auto.remoteVncViewer.rlpt4b')}
          </button>
          {!isConnected ? (
            <button type="button" className="vnc-control-btn" onClick={() => void probeVnc()} disabled={isBusy}>
              {status === 'probing' ? tCurrent('auto.remoteVncViewer.xr2jgj2') : tCurrent('auto.remoteVncViewer.8kqmt8')}
            </button>
          ) : null}
          {isConnected || status === 'starting' || status === 'connecting' ? (
            <button type="button" className="vnc-control-btn danger" onClick={() => void disconnectVnc()}>
              {tCurrent('auto.remoteVncViewer.a4u4dk')}</button>
          ) : (
            <button type="submit" className="vnc-control-btn primary" disabled={isBusy}>
              {status === 'disconnected' || status === 'error' ? tCurrent('auto.remoteVncViewer.jv7zn6') : tCurrent('auto.remoteVncViewer.8l8re4')}
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
              {tCurrent('auto.remoteVncViewer.1dol1722')}</button>
          ) : null}
          {!isConnected ? (
            <div className="vnc-stage-overlay">
              <strong>{status === 'error' ? failureCopy.title : getVncStatusLabel(status)}</strong>
              {status === 'error' && failureCopy.detail ? <span>{failureCopy.detail}</span> : null}
              <small>{tCurrent('auto.remoteVncViewer.18ky425')}{targetLabel}</small>
              {!isBusy ? (
                <div className="vnc-overlay-actions">
                  <button type="button" className="vnc-control-btn primary" onClick={() => void connectVnc()}>
                    {status === 'disconnected' || status === 'error' ? tCurrent('auto.remoteVncViewer.jv7zn62') : tCurrent('auto.remoteVncViewer.8l8re42')}
                  </button>
                  <button type="button" className="vnc-control-btn" onClick={() => void probeVnc()}>
                    {tCurrent('auto.remoteVncViewer.8kqmt82')}</button>
                </div>
              ) : null}
            </div>
          ) : null}
          <footer className="vnc-statusbar">
            <span className={`vnc-status-dot ${isConnected ? 'online' : ''}`} aria-hidden="true" />
            <strong>{getVncStatusLabel(status)}</strong>
            <span>{desktopName || tCurrent('auto.remoteVncViewer.niu2zi', { value0: targetLabel })}</span>
            {latencyLabel ? <em className="latency">{latencyLabel}</em> : null}
            {latestDiagnostic ? <em title={latestDiagnostic.detail}>{latestDiagnostic.stage}: {latestDiagnostic.detail}</em> : null}
            {connectedAt ? <time dateTime={connectedAt}>{new Date(connectedAt).toLocaleTimeString(getShellDeskLocale())}</time> : null}
          </footer>
        </div>

        {showInspector ? (
          <aside className="vnc-inspector">
            <section className="vnc-inspector-section">
              <header className="vnc-section-head">
                <strong>{tCurrent('auto.remoteVncViewer.1l5q37d')}</strong>
                <span>{vncViewModes[viewMode].description}</span>
              </header>
              <div className="vnc-view-mode-picker" role="group" aria-label={tCurrent('auto.remoteVncViewer.1hkbwym')}>
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
                <span>{tCurrent('auto.remoteVncViewer.16dw9y5')}</span>
                <select value={performanceMode} onChange={(event) => setPerformanceMode(event.target.value as VncPerformanceMode)}>
                  <option value="smooth">{tCurrent('auto.remoteVncViewer.1w91dwr2')}</option>
                  <option value="balanced">{tCurrent('auto.remoteVncViewer.1cezww52')}</option>
                  <option value="quality">{tCurrent('auto.remoteVncViewer.6uopsg2')}</option>
                </select>
              </label>
              <div className="vnc-toggle-row">
                <label className="vnc-toggle">
                  <input type="checkbox" checked={shared} onChange={(event) => setShared(event.target.checked)} disabled={isTargetLocked} />
                  <span>{tCurrent('auto.remoteVncViewer.1qaaj9c')}</span>
                </label>
                <label className="vnc-toggle">
                  <input type="checkbox" checked={viewOnly} onChange={(event) => setViewOnly(event.target.checked)} />
                  <span>{tCurrent('auto.remoteVncViewer.1hpsjfm')}</span>
                </label>
              </div>
            </section>

            <section className="vnc-inspector-section">
              <header className="vnc-section-head">
                <strong>{tCurrent('auto.remoteVncViewer.1itxse4')}</strong>
                <span>{isConnected ? tCurrent('auto.remoteVncViewer.1he1l9x') : tCurrent('auto.remoteVncViewer.1a871b9')}</span>
              </header>
              <textarea
                className="vnc-clipboard-editor"
                value={clipboardText}
                onChange={(event) => setClipboardText(event.target.value)}
                placeholder={tCurrent('auto.remoteVncViewer.28mw90')}
                spellCheck={false}
              />
              <div className="vnc-inline-actions">
                <button type="button" className="vnc-control-btn" onClick={() => void readLocalClipboard()}>
                  {tCurrent('auto.remoteVncViewer.1kaj7uu')}</button>
                <button type="button" className="vnc-control-btn primary" onClick={sendClipboardToRemote} disabled={!isConnected}>
                  {tCurrent('auto.remoteVncViewer.ox3xgq')}</button>
                <button type="button" className="vnc-control-btn" onClick={() => void writeLocalClipboard()} disabled={!clipboardText}>
                  {tCurrent('auto.remoteVncViewer.1sos7h4')}</button>
              </div>
              <p className="vnc-clipboard-note">{clipboardNotice}</p>
            </section>

            <section className="vnc-inspector-section diagnostics">
              <header className="vnc-section-head">
                <strong>{tCurrent('auto.remoteVncViewer.1bddxhz')}</strong>
                <button type="button" onClick={() => setDiagnostics([])} disabled={diagnostics.length === 0}>
                  {tCurrent('auto.remoteVncViewer.9mbwb2')}</button>
              </header>
              {diagnostics.length === 0 ? (
                <p className="vnc-diagnostic-empty">{tCurrent('auto.remoteVncViewer.yhuqo7')}</p>
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
