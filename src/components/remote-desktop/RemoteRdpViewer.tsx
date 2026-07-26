import {
  ClipboardCheck,
  ClipboardCopy,
  Expand,
  KeyRound,
  Maximize2,
  MonitorUp,
  PanelRightClose,
  PanelRightOpen,
  PlugZap,
  RefreshCw,
  ScanLine,
  ShieldCheck,
  Unplug,
} from 'lucide-react';
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { UserInteraction } from '@devolutions/iron-remote-desktop';

import rdpViewerIcon from '../../assets/desktop-icons/rdp-viewer.png';
import { tCurrent } from '../../i18n';
import DismissibleAlert from './DismissibleAlert';
import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import {
  loadRemoteConnectionProfile,
  readProfileBoolean,
  readProfileString,
  saveRemoteConnectionProfile,
} from './remoteConnectionProfiles';

interface RemoteRdpViewerProps {
  connectionId: string;
  hostId: string;
  initialTarget?: { host: string; port: number };
}

type RdpStatus =
  | 'loading'
  | 'idle'
  | 'probing'
  | 'starting'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';
type RdpViewMode = 'fit' | 'real' | 'full';
type RdpResolution = 'adaptive' | '1920x1080' | '1600x900' | '1366x768' | '1280x720';
type RdpBackendModule = typeof import('@devolutions/iron-remote-desktop-rdp');
type RdpInteraction = Omit<UserInteraction, 'setScale'> & {
  setScale: (scale: RdpViewMode) => void;
};
type IronRemoteDesktopElement = HTMLElement & {
  module: RdpBackendModule['Backend'];
  scale: RdpViewMode;
  flexcenter: string;
  verbose: string;
};

interface RdpReadyDetail {
  irgUserInteraction: RdpInteraction;
}

interface DiagnosticEntry {
  id: string;
  time: string;
  stage: string;
  detail: string;
}

const defaultRdpPort = 3389;
const maxDiagnostics = 40;
const resolutionSizes: Record<Exclude<RdpResolution, 'adaptive'>, { width: number; height: number }> = {
  '1920x1080': { width: 1920, height: 1080 },
  '1600x900': { width: 1600, height: 900 },
  '1366x768': { width: 1366, height: 768 },
  '1280x720': { width: 1280, height: 720 },
};

function createRdpId() {
  if ('randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `rdp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function parsePort(value: string) {
  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : defaultRdpPort;
}

function normalizeResolution(value: string): RdpResolution {
  return value === '1920x1080'
    || value === '1600x900'
    || value === '1366x768'
    || value === '1280x720'
    ? value
    : 'adaptive';
}

function normalizeViewMode(value: string): RdpViewMode {
  return value === 'real' || value === 'full' ? value : 'fit';
}

function statusLabel(status: RdpStatus) {
  switch (status) {
    case 'loading':
      return tCurrent('rdp.status.loading');
    case 'probing':
      return tCurrent('rdp.status.probing');
    case 'starting':
      return tCurrent('rdp.status.starting');
    case 'connecting':
      return tCurrent('rdp.status.connecting');
    case 'connected':
      return tCurrent('rdp.status.connected');
    case 'disconnected':
      return tCurrent('rdp.status.disconnected');
    case 'error':
      return tCurrent('rdp.status.error');
    default:
      return tCurrent('rdp.status.ready');
  }
}

function resolveIronError(error: unknown) {
  if (error && typeof error === 'object' && 'kind' in error && typeof error.kind === 'function') {
    const kind = Number(error.kind());
    switch (kind) {
      case 1:
        return tCurrent('rdp.error.wrongPassword');
      case 2:
        return tCurrent('rdp.error.logonFailure');
      case 3:
        return tCurrent('rdp.error.accessDenied');
      case 4:
        return tCurrent('rdp.error.cleanPath');
      case 5:
        return tCurrent('rdp.error.proxy');
      case 6:
        return tCurrent('rdp.error.negotiation');
      default:
        break;
    }
  }

  const message = getErrorMessage(error);
  return message === '[object Object]' ? tCurrent('rdp.error.connection') : message;
}

function RemoteRdpViewer({
  connectionId,
  hostId,
  initialTarget,
}: RemoteRdpViewerProps) {
  const api = window.guiSSH;
  const mountRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const interactionRef = useRef<RdpInteraction | null>(null);
  const backendRef = useRef<RdpBackendModule | null>(null);
  const rdpIdRef = useRef('');
  const disconnectingRef = useRef(false);
  const resizeTimerRef = useRef<number | null>(null);
  const diagnosticCounterRef = useRef(0);

  const [status, setStatus] = useState<RdpStatus>('loading');
  const [clientReady, setClientReady] = useState(false);
  const [host, setHost] = useState(initialTarget?.host ?? '127.0.0.1');
  const [port, setPort] = useState(String(initialTarget?.port ?? defaultRdpPort));
  const [username, setUsername] = useState('');
  const [domain, setDomain] = useState('');
  const [password, setPassword] = useState('');
  const [resolution, setResolution] = useState<RdpResolution>('adaptive');
  const [colorDepth, setColorDepth] = useState('16');
  const [viewMode, setViewMode] = useState<RdpViewMode>('fit');
  const [clipboardEnabled, setClipboardEnabled] = useState(true);
  const [autoClipboard, setAutoClipboard] = useState(true);
  const [showInspector, setShowInspector] = useState(true);
  const [errorMessage, setErrorMessage] = useState('');
  const [notice, setNotice] = useState('');
  const [connectedAt, setConnectedAt] = useState('');
  const [remoteClipboardPending, setRemoteClipboardPending] = useState(false);
  const [diagnostics, setDiagnostics] = useState<DiagnosticEntry[]>([]);

  const isConnected = status === 'connected';
  const isBusy = status === 'loading'
    || status === 'probing'
    || status === 'starting'
    || status === 'connecting';
  const targetLabel = `${host.trim() || '127.0.0.1'}:${parsePort(port)}`;
  const connectedDuration = useMemo(() => {
    if (!connectedAt) {
      return '';
    }
    const started = new Date(connectedAt);
    return Number.isNaN(started.getTime())
      ? ''
      : started.toLocaleTimeString(getShellDeskLocale(), {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });
  }, [connectedAt]);

  const appendDiagnostic = useCallback((stage: string, detail: string) => {
    diagnosticCounterRef.current += 1;
    const entry: DiagnosticEntry = {
      id: `rdp-diagnostic-${diagnosticCounterRef.current}`,
      time: new Date().toLocaleTimeString(getShellDeskLocale(), {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
      stage,
      detail,
    };
    setDiagnostics((current) => [...current.slice(-(maxDiagnostics - 1)), entry]);
  }, []);

  const stopProxy = useCallback(async (rdpId: string) => {
    if (!rdpId || !api?.connections?.rdpStop) {
      return;
    }
    await api.connections.rdpStop(connectionId, rdpId).catch(() => undefined);
  }, [api, connectionId]);

  const disconnectRdp = useCallback(async (showDisconnected = true) => {
    const currentRdpId = rdpIdRef.current;
    rdpIdRef.current = '';
    disconnectingRef.current = true;
    try {
      interactionRef.current?.shutdown();
      interactionRef.current?.setVisibility(false);
    } catch {
      // Ignore teardown races after a remote disconnect.
    }
    await stopProxy(currentRdpId);
    setConnectedAt('');
    setRemoteClipboardPending(false);
    if (showDisconnected) {
      setStatus('disconnected');
      setNotice(tCurrent('rdp.notice.disconnected'));
    }
  }, [stopProxy]);

  useEffect(() => {
    let active = true;
    let element: IronRemoteDesktopElement | null = null;
    let readyListener: ((event: Event) => void) | null = null;

    const prepareClient = async () => {
      try {
        const backend = await import('@devolutions/iron-remote-desktop-rdp');
        await backend.init('warn');
        await import('@devolutions/iron-remote-desktop');
        if (!active || !mountRef.current) {
          return;
        }

        backendRef.current = backend;
        element = document.createElement('iron-remote-desktop') as IronRemoteDesktopElement;
        element.module = backend.Backend;
        element.scale = 'fit';
        element.flexcenter = 'true';
        element.verbose = 'false';
        readyListener = (event: Event) => {
          const detail = (event as CustomEvent<RdpReadyDetail>).detail;
          if (!active || !detail?.irgUserInteraction) {
            return;
          }
          interactionRef.current = detail.irgUserInteraction;
          setClientReady(true);
          setStatus('idle');
        };
        element.addEventListener('ready', readyListener);
        mountRef.current.replaceChildren(element);
      } catch (error) {
        if (!active) {
          return;
        }
        setStatus('error');
        setErrorMessage(tCurrent('rdp.error.clientLoad', { error: getErrorMessage(error) }));
      }
    };

    void prepareClient();
    return () => {
      active = false;
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current);
      }
      try {
        interactionRef.current?.shutdown();
      } catch {
        // Ignore component shutdown races.
      }
      const currentRdpId = rdpIdRef.current;
      rdpIdRef.current = '';
      void stopProxy(currentRdpId);
      if (element && readyListener) {
        element.removeEventListener('ready', readyListener);
      }
      element?.remove();
      interactionRef.current = null;
      backendRef.current = null;
    };
  }, [stopProxy]);

  useEffect(() => {
    let active = true;
    void loadRemoteConnectionProfile(hostId, 'rdp-viewer').then((profile) => {
      if (!active || !profile) {
        return;
      }
      if (!initialTarget) {
        setHost(readProfileString(profile, 'host', '127.0.0.1'));
        setPort(readProfileString(profile, 'port', String(defaultRdpPort)));
      }
      setUsername(readProfileString(profile, 'username', ''));
      setDomain(readProfileString(profile, 'domain', ''));
      setResolution(normalizeResolution(readProfileString(profile, 'resolution', 'adaptive')));
      setViewMode(normalizeViewMode(readProfileString(profile, 'viewMode', 'fit')));
      setClipboardEnabled(readProfileBoolean(profile, 'clipboardEnabled', true));
      setAutoClipboard(readProfileBoolean(profile, 'autoClipboard', true));
    });
    return () => {
      active = false;
    };
  }, [hostId, initialTarget]);

  useEffect(() => {
    if (!api?.events?.onRdpDiagnostic) {
      return undefined;
    }
    return api.events.onRdpDiagnostic((payload) => {
      if (payload.connectionId === connectionId && payload.rdpId === rdpIdRef.current) {
        appendDiagnostic(payload.stage, payload.detail);
      }
    });
  }, [api, appendDiagnostic, connectionId]);

  useEffect(() => {
    if (!api?.events?.onConnectionClosed) {
      return undefined;
    }
    return api.events.onConnectionClosed((payload) => {
      if (payload.connectionId !== connectionId || !rdpIdRef.current) {
        return;
      }
      const currentRdpId = rdpIdRef.current;
      rdpIdRef.current = '';
      interactionRef.current?.shutdown();
      void stopProxy(currentRdpId);
      setStatus('error');
      setConnectedAt('');
      setErrorMessage(payload.reason || tCurrent('rdp.error.sshClosed'));
    });
  }, [api, connectionId, stopProxy]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || status !== 'connected' || resolution !== 'adaptive' || !clientReady) {
      return undefined;
    }
    const resize = () => {
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current);
      }
      resizeTimerRef.current = window.setTimeout(() => {
        const bounds = stage.getBoundingClientRect();
        const width = Math.max(320, Math.floor(bounds.width / 2) * 2);
        const height = Math.max(240, Math.floor((bounds.height - 34) / 2) * 2);
        interactionRef.current?.resize(width, height);
      }, 180);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(stage);
    resize();
    return () => {
      observer.disconnect();
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
    };
  }, [clientReady, resolution, status]);

  const probeRdp = useCallback(async () => {
    if (!api?.connections?.rdpProbe) {
      setErrorMessage(tCurrent('rdp.error.nativeUnavailable'));
      return;
    }
    const targetHost = host.trim();
    if (!targetHost) {
      setErrorMessage(tCurrent('rdp.error.hostRequired'));
      return;
    }
    const targetPort = parsePort(port);
    const probeId = createRdpId();
    setStatus('probing');
    setErrorMessage('');
    setNotice('');
    try {
      const result = await api.connections.rdpProbe(connectionId, {
        host: targetHost,
        port: targetPort,
        rdpId: probeId,
      });
      setStatus('idle');
      setNotice(tCurrent('rdp.notice.probeReady', { protocol: result.securityProtocol }));
    } catch (error) {
      setStatus('error');
      setErrorMessage(resolveIronError(error));
    }
  }, [api, connectionId, host, port]);

  const connectRdp = useCallback(async () => {
    const interaction = interactionRef.current;
    const backend = backendRef.current;
    if (!api?.connections?.rdpStart || !interaction || !backend || !clientReady) {
      setStatus('error');
      setErrorMessage(tCurrent('rdp.error.clientNotReady'));
      return;
    }
    const targetHost = host.trim();
    if (!targetHost) {
      setErrorMessage(tCurrent('rdp.error.hostRequired'));
      return;
    }

    await disconnectRdp(false);
    disconnectingRef.current = false;
    const targetPort = parsePort(port);
    const nextRdpId = createRdpId();
    rdpIdRef.current = nextRdpId;
    setStatus('starting');
    setErrorMessage('');
    setNotice('');
    setDiagnostics([]);
    appendDiagnostic('session', tCurrent('rdp.diagnostic.connecting', { target: `${targetHost}:${targetPort}` }));

    try {
      const proxy = await api.connections.rdpStart(connectionId, {
        host: targetHost,
        port: targetPort,
        rdpId: nextRdpId,
      });
      if (rdpIdRef.current !== nextRdpId) {
        await stopProxy(nextRdpId);
        return;
      }

      setStatus('connecting');
      interaction.setEnableClipboard(clipboardEnabled);
      interaction.setEnableAutoClipboard(autoClipboard);
      interaction.onWarningCallback((warning) => appendDiagnostic('client', warning));
      interaction.onClipboardRemoteUpdateCallback(() => {
        setRemoteClipboardPending(true);
        setNotice(tCurrent('rdp.notice.remoteClipboard'));
      });
      const stageBounds = stageRef.current?.getBoundingClientRect();
      const desktopSize = resolution === 'adaptive'
        ? {
            width: Math.max(320, Math.floor(stageBounds?.width || 1280)),
            height: Math.max(240, Math.floor((stageBounds?.height || 754) - 34)),
          }
        : resolutionSizes[resolution];
      const config = interaction
        .configBuilder()
        .withUsername(username.trim())
        .withPassword(password)
        .withDestination(proxy.destination)
        .withProxyAddress(proxy.webSocketUrl)
        .withServerDomain(domain.trim())
        .withAuthToken(proxy.authToken)
        .withDesktopSize(desktopSize)
        .withExtension(backend.displayControl(resolution === 'adaptive'))
        .build();
      const session = await interaction.connect(config);
      if (rdpIdRef.current !== nextRdpId) {
        interaction.shutdown();
        await stopProxy(nextRdpId);
        return;
      }

      interaction.setVisibility(true);
      interaction.setScale(viewMode);
      setPassword('');
      setStatus('connected');
      setConnectedAt(new Date().toISOString());
      setNotice(tCurrent('rdp.notice.connected', { target: proxy.destination }));
      appendDiagnostic('session', tCurrent('rdp.diagnostic.connected'));
      void saveRemoteConnectionProfile(hostId, 'rdp-viewer', {
        host: targetHost,
        port: String(targetPort),
        username: username.trim(),
        domain: domain.trim(),
        resolution,
        colorDepth,
        viewMode,
        clipboardEnabled,
        autoClipboard,
      }).catch(() => undefined);

      void session.run().then((termination) => {
        if (rdpIdRef.current !== nextRdpId) {
          return;
        }
        const reason = termination.reason();
        rdpIdRef.current = '';
        interaction.setVisibility(false);
        void stopProxy(nextRdpId);
        setConnectedAt('');
        if (disconnectingRef.current) {
          setStatus('disconnected');
          return;
        }
        setStatus('error');
        setErrorMessage(reason || tCurrent('rdp.error.remoteClosed'));
      }).catch((error) => {
        if (rdpIdRef.current !== nextRdpId) {
          return;
        }
        rdpIdRef.current = '';
        interaction.setVisibility(false);
        void stopProxy(nextRdpId);
        setConnectedAt('');
        setStatus('error');
        setErrorMessage(resolveIronError(error));
      });
    } catch (error) {
      if (rdpIdRef.current === nextRdpId) {
        rdpIdRef.current = '';
      }
      interaction.setVisibility(false);
      await stopProxy(nextRdpId);
      setStatus('error');
      setConnectedAt('');
      setErrorMessage(resolveIronError(error));
    }
  }, [
    api,
    appendDiagnostic,
    autoClipboard,
    clientReady,
    clipboardEnabled,
    colorDepth,
    connectionId,
    disconnectRdp,
    domain,
    host,
    hostId,
    password,
    port,
    resolution,
    stopProxy,
    username,
    viewMode,
  ]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    void connectRdp();
  };

  const changeViewMode = (nextMode: RdpViewMode) => {
    setViewMode(nextMode);
    interactionRef.current?.setScale(nextMode);
  };

  const toggleFullscreen = async () => {
    const stage = stageRef.current;
    if (!stage) {
      return;
    }
    try {
      if (document.fullscreenElement === stage) {
        await document.exitFullscreen();
      } else {
        await stage.requestFullscreen();
      }
    } catch (error) {
      setErrorMessage(tCurrent('rdp.error.fullscreen', { error: getErrorMessage(error) }));
    }
  };

  const sendLocalClipboard = async () => {
    try {
      await interactionRef.current?.sendClipboardData();
      setNotice(tCurrent('rdp.notice.clipboardSent'));
    } catch (error) {
      setErrorMessage(tCurrent('rdp.error.clipboard', { error: getErrorMessage(error) }));
    }
  };

  const saveRemoteClipboard = async () => {
    try {
      await interactionRef.current?.saveRemoteClipboardData();
      setRemoteClipboardPending(false);
      setNotice(tCurrent('rdp.notice.clipboardSaved'));
    } catch (error) {
      setErrorMessage(tCurrent('rdp.error.clipboard', { error: getErrorMessage(error) }));
    }
  };

  return (
    <section className={`rdp-viewer ${status}`}>
      <header className="rdp-header">
        <div className="rdp-heading">
          <img src={rdpViewerIcon} alt="" aria-hidden="true" />
          <div>
            <strong>{tCurrent('rdp.title')}</strong>
            <span>{isConnected ? targetLabel : tCurrent('rdp.subtitle')}</span>
          </div>
        </div>
        <div className="rdp-header-actions">
          <span className={`rdp-connection-badge ${isConnected ? 'online' : ''}`}>
            <i aria-hidden="true" />
            {statusLabel(status)}
          </span>
          {isConnected ? (
            <>
              <button type="button" onClick={() => interactionRef.current?.ctrlAltDel()} title={tCurrent('rdp.action.ctrlAltDel')}>
                <KeyRound size={16} />
                <span>{tCurrent('rdp.action.ctrlAltDel')}</span>
              </button>
              <button type="button" onClick={() => void toggleFullscreen()} title={tCurrent('rdp.action.fullscreen')}>
                <Maximize2 size={16} />
              </button>
              <button type="button" className="danger" onClick={() => void disconnectRdp()}>
                <Unplug size={16} />
                <span>{tCurrent('rdp.action.disconnect')}</span>
              </button>
            </>
          ) : (
            <button type="button" onClick={() => void probeRdp()} disabled={isBusy}>
              <ScanLine size={16} />
              <span>{tCurrent('rdp.action.probe')}</span>
            </button>
          )}
          <button
            type="button"
            className={showInspector ? 'active' : ''}
            onClick={() => setShowInspector((current) => !current)}
            title={tCurrent('rdp.action.inspector')}
          >
            {showInspector ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
          </button>
        </div>
      </header>

      {!isConnected ? (
        <form className="rdp-connect-bar" onSubmit={handleSubmit}>
          <label className="host">
            <span>{tCurrent('rdp.field.host')}</span>
            <input value={host} onChange={(event) => setHost(event.target.value)} disabled={isBusy} />
          </label>
          <label className="port">
            <span>{tCurrent('rdp.field.port')}</span>
            <input
              type="number"
              min="1"
              max="65535"
              value={port}
              onChange={(event) => setPort(event.target.value)}
              disabled={isBusy}
            />
          </label>
          <label>
            <span>{tCurrent('rdp.field.username')}</span>
            <input value={username} onChange={(event) => setUsername(event.target.value)} disabled={isBusy} autoComplete="username" />
          </label>
          <label>
            <span>{tCurrent('rdp.field.domain')}</span>
            <input value={domain} onChange={(event) => setDomain(event.target.value)} disabled={isBusy} />
          </label>
          <label>
            <span>{tCurrent('rdp.field.password')}</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={isBusy}
              autoComplete="current-password"
            />
          </label>
          <button type="submit" className="primary" disabled={isBusy || !clientReady}>
            {isBusy ? <RefreshCw className="spin" size={17} /> : <PlugZap size={17} />}
            <span>{isBusy ? statusLabel(status) : tCurrent('rdp.action.connect')}</span>
          </button>
        </form>
      ) : null}

      {errorMessage ? (
        <DismissibleAlert className="rdp-alert error" onDismiss={() => setErrorMessage('')}>
          {errorMessage}
        </DismissibleAlert>
      ) : null}
      {notice ? (
        <DismissibleAlert className="rdp-alert notice" onDismiss={() => setNotice('')}>
          {notice}
        </DismissibleAlert>
      ) : null}

      <div className={`rdp-workspace ${showInspector ? '' : 'inspector-closed'}`}>
        <div ref={stageRef} className="rdp-stage">
          <div ref={mountRef} className="rdp-canvas" />
          {!isConnected ? (
            <div className="rdp-empty-state">
              <span className="rdp-empty-icon"><MonitorUp size={34} /></span>
              <strong>{clientReady ? tCurrent('rdp.empty.ready') : tCurrent('rdp.empty.loading')}</strong>
              <p>{tCurrent('rdp.empty.description')}</p>
              <div>
                <span><ShieldCheck size={14} /> {tCurrent('rdp.empty.ssh')}</span>
                <span><Expand size={14} /> {tCurrent('rdp.empty.adaptive')}</span>
                <span><ClipboardCheck size={14} /> {tCurrent('rdp.empty.clipboard')}</span>
              </div>
            </div>
          ) : null}
          <footer className="rdp-statusbar">
            <span><i className={isConnected ? 'online' : ''} /> {statusLabel(status)}</span>
            <span>{targetLabel}</span>
            <span>{resolution === 'adaptive' ? tCurrent('rdp.resolution.adaptive') : resolution}</span>
            <span>{tCurrent('rdp.colorDepth.value', { depth: colorDepth })}</span>
            {connectedDuration ? <span>{tCurrent('rdp.status.since', { time: connectedDuration })}</span> : null}
          </footer>
        </div>

        {showInspector ? (
          <aside className="rdp-inspector">
            <section>
              <div className="rdp-section-heading">
                <div>
                  <strong>{tCurrent('rdp.inspector.display')}</strong>
                  <span>{tCurrent('rdp.inspector.displayHint')}</span>
                </div>
                <MonitorUp size={17} />
              </div>
              <div className="rdp-segmented" role="group" aria-label={tCurrent('rdp.field.viewMode')}>
                {(['fit', 'real', 'full'] as RdpViewMode[]).map((mode) => (
                  <button
                    type="button"
                    key={mode}
                    className={viewMode === mode ? 'active' : ''}
                    onClick={() => changeViewMode(mode)}
                  >
                    {tCurrent(`rdp.view.${mode}`)}
                  </button>
                ))}
              </div>
              <label>
                <span>{tCurrent('rdp.field.resolution')}</span>
                <select
                  value={resolution}
                  onChange={(event) => setResolution(normalizeResolution(event.target.value))}
                  disabled={isConnected}
                >
                  <option value="adaptive">{tCurrent('rdp.resolution.adaptive')}</option>
                  <option value="1920x1080">1920 × 1080</option>
                  <option value="1600x900">1600 × 900</option>
                  <option value="1366x768">1366 × 768</option>
                  <option value="1280x720">1280 × 720</option>
                </select>
              </label>
              <label>
                <span>{tCurrent('rdp.field.colorDepth')}</span>
                <select value={colorDepth} onChange={(event) => setColorDepth(event.target.value)} disabled={isConnected}>
                  <option value="16">{tCurrent('rdp.colorDepth.ironRdp')}</option>
                </select>
              </label>
              <p className="rdp-field-note">{tCurrent('rdp.colorDepth.hint')}</p>
            </section>

            <section>
              <div className="rdp-section-heading">
                <div>
                  <strong>{tCurrent('rdp.inspector.clipboard')}</strong>
                  <span>{tCurrent('rdp.inspector.clipboardHint')}</span>
                </div>
                <ClipboardCopy size={17} />
              </div>
              <label className="rdp-switch-row">
                <span>
                  <strong>{tCurrent('rdp.clipboard.enabled')}</strong>
                  <small>{tCurrent('rdp.clipboard.enabledHint')}</small>
                </span>
                <input
                  type="checkbox"
                  checked={clipboardEnabled}
                  onChange={(event) => setClipboardEnabled(event.target.checked)}
                  disabled={isConnected}
                />
              </label>
              <label className="rdp-switch-row">
                <span>
                  <strong>{tCurrent('rdp.clipboard.auto')}</strong>
                  <small>{tCurrent('rdp.clipboard.autoHint')}</small>
                </span>
                <input
                  type="checkbox"
                  checked={autoClipboard}
                  onChange={(event) => {
                    setAutoClipboard(event.target.checked);
                    interactionRef.current?.setEnableAutoClipboard(event.target.checked);
                  }}
                  disabled={!clipboardEnabled}
                />
              </label>
              <div className="rdp-inline-actions">
                <button type="button" onClick={() => void sendLocalClipboard()} disabled={!isConnected || !clipboardEnabled}>
                  <ClipboardCopy size={15} />
                  {tCurrent('rdp.clipboard.send')}
                </button>
                <button
                  type="button"
                  className={remoteClipboardPending ? 'primary' : ''}
                  onClick={() => void saveRemoteClipboard()}
                  disabled={!isConnected || !clipboardEnabled}
                >
                  <ClipboardCheck size={15} />
                  {tCurrent('rdp.clipboard.receive')}
                </button>
              </div>
            </section>

            <section className="rdp-diagnostics">
              <div className="rdp-section-heading">
                <div>
                  <strong>{tCurrent('rdp.inspector.diagnostics')}</strong>
                  <span>{tCurrent('rdp.inspector.diagnosticsHint')}</span>
                </div>
                <ShieldCheck size={17} />
              </div>
              {diagnostics.length ? (
                <ol>
                  {diagnostics.slice(-8).reverse().map((entry) => (
                    <li key={entry.id}>
                      <span>{entry.time}</span>
                      <strong>{entry.stage}</strong>
                      <p>{entry.detail}</p>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="rdp-diagnostic-empty">{tCurrent('rdp.diagnostic.empty')}</p>
              )}
            </section>
          </aside>
        ) : null}
      </div>
    </section>
  );
}

export default RemoteRdpViewer;
