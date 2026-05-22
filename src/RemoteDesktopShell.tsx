import { type CSSProperties, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { RemoteBrowser, RemoteFileExplorer, RemoteMonitor, RemoteMySQL, RemoteNotepad, RemoteProcessManager, RemoteRedis, RemoteSettings, RemoteSqlite, RemoteTerminal, RemoteVncViewer } from './components/remote-desktop';
import type {
  RemoteTerminalChromePayload,
  RemoteTerminalLaunchOptions,
  RemoteTerminalSessionEvent,
  RemoteTerminalSessionState,
  RemoteTerminalSessionStatus,
  RemoteTerminalToolAction,
  RemoteTerminalToolRequest,
} from './components/remote-desktop/RemoteTerminal';
import type { RemoteConnectionInfo } from './components/remote-desktop/types';

const desktopApps = [
  { key: 'files', label: '文件管理', icon: '📁', description: 'Windows 风格 SFTP 资源管理器' },
  { key: 'terminal', label: '终端', icon: '>_', description: '交互式 SSH Shell' },
  { key: 'notepad', label: '记事本', icon: '📝', description: '远程文件编辑器' },
  { key: 'browser', label: '浏览器', icon: '🌐', description: '远程源请求' },
  { key: 'vnc', label: 'VNC Viewer', icon: 'VNC', description: '连接本机或内网 VNC 桌面' },
  { key: 'monitor', label: '系统监视器', icon: '📊', description: '服务器状态' },
  { key: 'mysql', label: 'MySQL', icon: '🐬', description: 'MySQL 数据库管理' },
  { key: 'redis', label: 'Redis', icon: '🔴', description: 'Redis 数据库管理' },
  { key: 'procmanager', label: '进程管理', icon: '\u2699\uFE0F', description: '进程查看、搜索和终止' },
  { key: 'settings', label: '系统设置', icon: '\uD83D\uDD27', description: '网络、镜像源、更新、Hosts、路由、磁盘' },
  { key: 'sqlite', label: 'SQLite', icon: '📦', description: 'SQLite 数据库查看与编辑' },
] as const;

/** 始终固定在 Dock 栏的应用，其他应用仅在桌面显示，打开时才会动态出现在 Dock */
const dockPinnedApps: DesktopAppKey[] = ['files', 'terminal', 'browser'];

type DesktopAppKey = (typeof desktopApps)[number]['key'];

interface RemoteDesktopProps {
  connection: RemoteConnectionInfo;
  settings: ShellDeskAppSettings;
  onSettingsChange?: (settings: ShellDeskAppSettings) => void;
  onTerminalSessionEvent?: (event: RemoteTerminalSessionEvent) => void;
}

interface DesktopWindowFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DesktopWindowState {
  id: string;
  appKey: DesktopAppKey;
  frame: DesktopWindowFrame;
  previousFrame?: DesktopWindowFrame;
  isMaximized: boolean;
  isMinimized: boolean;
  zIndex: number;
  terminalId?: string;
  terminalLaunchOptions?: RemoteTerminalLaunchOptions;
  terminalStatus?: RemoteTerminalSessionStatus;
  terminalToolRequest?: RemoteTerminalToolRequest;
  chromeTitle?: string;
  chromeStatus?: string;
  chromeTone?: 'idle' | 'loading' | 'error';
  notepadInitialPath?: string;
  notepadInitialContent?: string;
  notepadInitialTitle?: string;
}

type DesktopWindowInteractionMode = 'move' | 'resize';

interface DesktopWindowPointerState {
  pointerId: number;
  windowId: string;
  mode: DesktopWindowInteractionMode;
  originX: number;
  originY: number;
  startFrame: DesktopWindowFrame;
  surfaceWidth: number;
  surfaceHeight: number;
}

interface TerminalTitlebarMenuState {
  windowId: string;
  x: number;
  y: number;
}

const windowEdgePadding = 14;
const windowDockSafeArea = 92;
const windowMinWidth = 360;
const windowMinHeight = 260;

const defaultWindowFrames: Record<DesktopAppKey, DesktopWindowFrame> = {
  files: { x: 132, y: 54, width: 980, height: 580 },
  terminal: { x: 206, y: 80, width: 780, height: 500 },
  notepad: { x: 140, y: 50, width: 860, height: 580 },
  browser: { x: 150, y: 58, width: 1000, height: 600 },
  vnc: { x: 118, y: 46, width: 1040, height: 650 },
  monitor: { x: 224, y: 86, width: 820, height: 520 },
  mysql: { x: 100, y: 40, width: 1020, height: 620 },
  redis: { x: 100, y: 40, width: 1020, height: 620 },
  procmanager: { x: 160, y: 60, width: 980, height: 580 },
  settings: { x: 160, y: 55, width: 960, height: 580 },
  sqlite: { x: 100, y: 40, width: 1020, height: 620 },
};

function clampWindowFrame(frame: DesktopWindowFrame, surfaceWidth: number, surfaceHeight: number): DesktopWindowFrame {
  const maxWidth = Math.max(windowMinWidth, surfaceWidth - windowEdgePadding * 2);
  const maxHeight = Math.max(windowMinHeight, surfaceHeight - windowEdgePadding - windowDockSafeArea);
  const width = Math.min(Math.max(frame.width, windowMinWidth), maxWidth);
  const height = Math.min(Math.max(frame.height, windowMinHeight), maxHeight);
  const maxX = Math.max(windowEdgePadding, surfaceWidth - windowEdgePadding - width);
  const maxY = Math.max(windowEdgePadding, surfaceHeight - windowDockSafeArea - height);

  return {
    x: Math.min(Math.max(frame.x, windowEdgePadding), maxX),
    y: Math.min(Math.max(frame.y, windowEdgePadding), maxY),
    width,
    height,
  };
}

function getMaximizedWindowFrame(surfaceWidth: number, surfaceHeight: number) {
  return clampWindowFrame(
    {
      x: windowEdgePadding,
      y: windowEdgePadding,
      width: surfaceWidth - windowEdgePadding * 2,
      height: surfaceHeight - windowEdgePadding - windowDockSafeArea,
    },
    surfaceWidth,
    surfaceHeight,
  );
}

function createDesktopWindow(appKey: DesktopAppKey, sequence: number, zIndex: number): DesktopWindowState {
  const baseFrame = defaultWindowFrames[appKey];
  const offset = ((sequence - 1) % 7) * 28;
  const isBrowserWindow = appKey === 'browser';

  return {
    id: `${appKey}-${sequence}`,
    appKey,
    frame: {
      ...baseFrame,
      x: baseFrame.x + offset,
      y: baseFrame.y + offset,
    },
    isMaximized: false,
    isMinimized: false,
    zIndex,
    terminalId: appKey === 'terminal' ? `terminal-${sequence}` : undefined,
    terminalStatus: appKey === 'terminal' ? 'idle' : undefined,
    chromeTitle: isBrowserWindow ? '127.0.0.1' : undefined,
    chromeStatus: isBrowserWindow ? '已就绪' : undefined,
    chromeTone: isBrowserWindow ? 'idle' : undefined,
  };
}

function getAppInfo(appKey: DesktopAppKey) {
  return desktopApps.find((app) => app.key === appKey) ?? desktopApps[0];
}

function getTopDesktopWindow(
  desktopWindows: DesktopWindowState[],
  predicate: (desktopWindow: DesktopWindowState) => boolean = () => true,
) {
  return desktopWindows.reduce<DesktopWindowState | null>((currentTopWindow, desktopWindow) => {
    if (!predicate(desktopWindow)) {
      return currentTopWindow;
    }

    if (!currentTopWindow || desktopWindow.zIndex > currentTopWindow.zIndex) {
      return desktopWindow;
    }

    return currentTopWindow;
  }, null);
}

function getDesktopWallpaperStyle(settings: ShellDeskAppSettings): CSSProperties | undefined {
  if (settings.desktopWallpaperMode !== 'custom' || !settings.desktopWallpaperDataUrl) {
    return undefined;
  }

  const wallpaperUrl = `url(${JSON.stringify(settings.desktopWallpaperDataUrl)})`;

  return {
    backgroundImage: `linear-gradient(180deg, rgba(7, 10, 16, 0.12), rgba(7, 10, 16, 0.38)), ${wallpaperUrl}`,
    backgroundPosition: 'center, center',
    backgroundRepeat: 'no-repeat, no-repeat',
    backgroundSize: 'cover, cover',
  };
}

function RemoteDesktopShell({ connection, settings, onSettingsChange, onTerminalSessionEvent }: RemoteDesktopProps) {
  const desktopSurfaceRef = useRef<HTMLElement | null>(null);
  const windowPointerStateRef = useRef<DesktopWindowPointerState | null>(null);
  const windowSequenceRef = useRef(0);
  const terminalToolRequestSequenceRef = useRef(0);
  const zIndexRef = useRef(0);
  const [desktopWindows, setDesktopWindows] = useState<DesktopWindowState[]>([]);
  const [focusedWindowId, setFocusedWindowId] = useState('');
  const [desktopContextMenu, setDesktopContextMenu] = useState<{ x: number; y: number; appKey: DesktopAppKey } | null>(null);
  const [terminalTitlebarMenu, setTerminalTitlebarMenu] = useState<TerminalTitlebarMenuState | null>(null);
  const [pendingCloseWindowId, setPendingCloseWindowId] = useState('');
  const focusedWindow = desktopWindows.find((desktopWindow) => desktopWindow.id === focusedWindowId && !desktopWindow.isMinimized) ?? null;
  const terminalTitlebarMenuWindow = desktopWindows.find((desktopWindow) => desktopWindow.id === terminalTitlebarMenu?.windowId && desktopWindow.appKey === 'terminal') ?? null;
  const pendingCloseWindow = desktopWindows.find((desktopWindow) => desktopWindow.id === pendingCloseWindowId) ?? null;
  const desktopWallpaperStyle = getDesktopWallpaperStyle(settings);

  useEffect(() => {
    const surface = desktopSurfaceRef.current;

    if (!surface || typeof ResizeObserver === 'undefined') {
      return;
    }

    const resizeObserver = new ResizeObserver(([entry]) => {
      if (!entry) {
        return;
      }

      const { width, height } = entry.contentRect;
      setDesktopWindows((currentWindows) => currentWindows.map((desktopWindow) => {
        if (desktopWindow.isMaximized) {
          return { ...desktopWindow, frame: getMaximizedWindowFrame(width, height) };
        }

        return { ...desktopWindow, frame: clampWindowFrame(desktopWindow.frame, width, height) };
      }));
    });

    resizeObserver.observe(surface);

    return () => resizeObserver.disconnect();
  }, []);

  const bringWindowToFront = (windowId: string) => {
    zIndexRef.current += 1;
    const nextZIndex = zIndexRef.current;
    setFocusedWindowId(windowId);
    setDesktopWindows((currentWindows) => currentWindows.map((desktopWindow) => (
      desktopWindow.id === windowId ? { ...desktopWindow, isMinimized: false, zIndex: nextZIndex } : desktopWindow
    )));
  };

  const appendDesktopWindow = (
    appKey: DesktopAppKey,
    configureWindow?: (desktopWindow: DesktopWindowState) => void,
  ) => {
    windowSequenceRef.current += 1;
    zIndexRef.current += 1;
    const nextWindow = createDesktopWindow(appKey, windowSequenceRef.current, zIndexRef.current);
    const surface = desktopSurfaceRef.current;

    configureWindow?.(nextWindow);

    if (surface) {
      const surfaceRect = surface.getBoundingClientRect();
      nextWindow.frame = clampWindowFrame(nextWindow.frame, surfaceRect.width, surfaceRect.height);
    }

    setDesktopWindows((currentWindows) => [...currentWindows, nextWindow]);
    setFocusedWindowId(nextWindow.id);
  };

  const openDesktopWindow = (appKey: DesktopAppKey) => {
    appendDesktopWindow(appKey);
  };

  const openTerminalWindow = (launchOptions?: RemoteTerminalLaunchOptions) => {
    appendDesktopWindow('terminal', (nextWindow) => {
      nextWindow.terminalLaunchOptions = launchOptions;
    });
  };

  const openNotepadFile = (filePath: string) => {
    appendDesktopWindow('notepad', (nextWindow) => {
      nextWindow.notepadInitialPath = filePath;
    });
  };

  const openSqliteFile = (filePath: string) => {
    appendDesktopWindow('sqlite', (nextWindow) => {
      nextWindow.notepadInitialPath = filePath;
    });
  };

  const openNotepadNote = (note: { title: string; content: string }) => {
    appendDesktopWindow('notepad', (nextWindow) => {
      nextWindow.notepadInitialContent = note.content;
      nextWindow.notepadInitialTitle = note.title;
    });
  };

  const openTerminalAtPath = (directoryPath: string) => {
    openTerminalWindow({
      title: directoryPath,
      workingDirectory: directoryPath,
    });
  };

  const removeDesktopWindow = (windowId: string) => {
    setDesktopWindows((currentWindows) => {
      const nextWindows = currentWindows.filter((desktopWindow) => desktopWindow.id !== windowId);
      const nextFocusedWindow = getTopDesktopWindow(nextWindows, (desktopWindow) => !desktopWindow.isMinimized);

      setFocusedWindowId(nextFocusedWindow?.id ?? '');
      return nextWindows;
    });
  };

  const closeDesktopWindow = (windowId: string) => {
    const desktopWindow = desktopWindows.find((currentWindow) => currentWindow.id === windowId);

    if (desktopWindow?.appKey === 'terminal' && desktopWindow.terminalStatus === 'running') {
      setPendingCloseWindowId(windowId);
      return;
    }

    removeDesktopWindow(windowId);
  };

  const minimizeDesktopWindow = (windowId: string) => {
    windowPointerStateRef.current = null;
    setDesktopWindows((currentWindows) => {
      const nextWindows = currentWindows.map((desktopWindow) => (
        desktopWindow.id === windowId ? { ...desktopWindow, isMinimized: true } : desktopWindow
      ));
      const nextFocusedWindow = getTopDesktopWindow(nextWindows, (desktopWindow) => !desktopWindow.isMinimized);

      setFocusedWindowId(nextFocusedWindow?.id ?? '');
      return nextWindows;
    });
  };

  const activateDockApp = (appKey: DesktopAppKey) => {
    const appWindows = desktopWindows.filter((desktopWindow) => desktopWindow.appKey === appKey);
    const visibleWindow = getTopDesktopWindow(appWindows, (desktopWindow) => !desktopWindow.isMinimized);
    const minimizedWindow = getTopDesktopWindow(appWindows, (desktopWindow) => desktopWindow.isMinimized);
    const windowToActivate = visibleWindow ?? minimizedWindow;

    if (windowToActivate) {
      bringWindowToFront(windowToActivate.id);
      return;
    }

    openDesktopWindow(appKey);
  };

  const toggleWindowMaximize = (windowId: string) => {
    const surface = desktopSurfaceRef.current;

    if (!surface) {
      return;
    }

    const surfaceRect = surface.getBoundingClientRect();
    zIndexRef.current += 1;
    const nextZIndex = zIndexRef.current;
    setFocusedWindowId(windowId);
    setDesktopWindows((currentWindows) => currentWindows.map((desktopWindow) => {
      if (desktopWindow.id !== windowId) {
        return desktopWindow;
      }

      if (desktopWindow.isMaximized) {
        return {
          ...desktopWindow,
          frame: clampWindowFrame(desktopWindow.previousFrame ?? defaultWindowFrames[desktopWindow.appKey], surfaceRect.width, surfaceRect.height),
          previousFrame: undefined,
          isMaximized: false,
          zIndex: nextZIndex,
        };
      }

      return {
        ...desktopWindow,
        previousFrame: desktopWindow.frame,
        frame: getMaximizedWindowFrame(surfaceRect.width, surfaceRect.height),
        isMaximized: true,
        zIndex: nextZIndex,
      };
    }));
  };

  const startWindowInteraction = (event: ReactPointerEvent<HTMLElement>, windowId: string, mode: DesktopWindowInteractionMode) => {
    if (event.button !== 0) {
      return;
    }

    const surface = desktopSurfaceRef.current;
    const desktopWindow = desktopWindows.find((currentWindow) => currentWindow.id === windowId);

    if (!surface || !desktopWindow || desktopWindow.isMaximized || desktopWindow.isMinimized) {
      return;
    }

    const surfaceRect = surface.getBoundingClientRect();
    const startFrame = clampWindowFrame(desktopWindow.frame, surfaceRect.width, surfaceRect.height);

    windowPointerStateRef.current = {
      pointerId: event.pointerId,
      windowId,
      mode,
      originX: event.clientX,
      originY: event.clientY,
      startFrame,
      surfaceWidth: surfaceRect.width,
      surfaceHeight: surfaceRect.height,
    };

    bringWindowToFront(windowId);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const updateWindowInteraction = (event: ReactPointerEvent<HTMLElement>) => {
    const pointerState = windowPointerStateRef.current;

    if (!pointerState || pointerState.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = event.clientX - pointerState.originX;
    const deltaY = event.clientY - pointerState.originY;
    const nextFrame = pointerState.mode === 'move'
      ? {
          ...pointerState.startFrame,
          x: pointerState.startFrame.x + deltaX,
          y: pointerState.startFrame.y + deltaY,
        }
      : {
          ...pointerState.startFrame,
          width: pointerState.startFrame.width + deltaX,
          height: pointerState.startFrame.height + deltaY,
        };

    setDesktopWindows((currentWindows) => currentWindows.map((desktopWindow) => (
      desktopWindow.id === pointerState.windowId
        ? { ...desktopWindow, frame: clampWindowFrame(nextFrame, pointerState.surfaceWidth, pointerState.surfaceHeight) }
        : desktopWindow
    )));
    event.preventDefault();
  };

  const finishWindowInteraction = (event: ReactPointerEvent<HTMLElement>) => {
    const pointerState = windowPointerStateRef.current;

    if (!pointerState || pointerState.pointerId !== event.pointerId) {
      return;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    windowPointerStateRef.current = null;
  };

  const updateWindowChrome = (
    windowId: string,
    payload: RemoteTerminalChromePayload,
  ) => {
    setDesktopWindows((currentWindows) => currentWindows.map((desktopWindow) => (
      desktopWindow.id === windowId
        ? {
            ...desktopWindow,
            chromeTitle: payload.title,
            chromeStatus: payload.status,
            chromeTone: payload.tone,
          }
        : desktopWindow
    )));
  };

  const updateTerminalSessionState = (windowId: string, payload: RemoteTerminalSessionState) => {
    setDesktopWindows((currentWindows) => currentWindows.map((desktopWindow) => (
      desktopWindow.id === windowId
        ? {
            ...desktopWindow,
            terminalStatus: payload.status,
          }
      : desktopWindow
    )));
  };

  const requestTerminalTool = (windowId: string, action: RemoteTerminalToolAction) => {
    terminalToolRequestSequenceRef.current += 1;
    const terminalToolRequest: RemoteTerminalToolRequest = {
      id: `terminal-tool-${terminalToolRequestSequenceRef.current}`,
      action,
    };

    setDesktopWindows((currentWindows) => currentWindows.map((desktopWindow) => (
      desktopWindow.id === windowId
        ? { ...desktopWindow, terminalToolRequest }
        : desktopWindow
    )));
    setTerminalTitlebarMenu(null);
  };

  const completeTerminalToolRequest = (windowId: string, requestId: string) => {
    setDesktopWindows((currentWindows) => currentWindows.map((desktopWindow) => (
      desktopWindow.id === windowId && desktopWindow.terminalToolRequest?.id === requestId
        ? { ...desktopWindow, terminalToolRequest: undefined }
        : desktopWindow
    )));
  };

  const renderWindowContent = (desktopWindow: DesktopWindowState) => {
    if (desktopWindow.appKey === 'terminal') {
      return (
        <RemoteTerminal
          connectionId={connection.id}
          terminalId={desktopWindow.terminalId ?? desktopWindow.id}
          settings={settings}
          systemType={connection.host.systemType}
          launchOptions={desktopWindow.terminalLaunchOptions}
          toolRequest={desktopWindow.terminalToolRequest}
          onChromeChange={(payload) => updateWindowChrome(desktopWindow.id, payload)}
          onToolRequestHandled={(requestId) => completeTerminalToolRequest(desktopWindow.id, requestId)}
          onOpenTerminal={openTerminalWindow}
          onOpenNote={openNotepadNote}
          onSessionEvent={onTerminalSessionEvent}
          onSessionStateChange={(payload) => updateTerminalSessionState(desktopWindow.id, payload)}
          onSettingsChange={onSettingsChange}
        />
      );
    }

    if (desktopWindow.appKey === 'browser') {
      return (
        <RemoteBrowser
          partition={connection.partition}
          bookmarkScope={`${connection.host.username}@${connection.host.address}:${connection.host.port}`}
          onChromeChange={(payload) => updateWindowChrome(desktopWindow.id, payload)}
        />
      );
    }

    if (desktopWindow.appKey === 'files') {
      return <RemoteFileExplorer connectionId={connection.id} systemType={connection.host.systemType} onOpenFile={openNotepadFile} onOpenSqliteFile={openSqliteFile} onOpenTerminal={openTerminalAtPath} />;
    }

    if (desktopWindow.appKey === 'notepad') {
      return <RemoteNotepad connectionId={connection.id} initialFilePath={desktopWindow.notepadInitialPath} initialContent={desktopWindow.notepadInitialContent} initialTitle={desktopWindow.notepadInitialTitle} systemType={connection.host.systemType} />;
    }

    if (desktopWindow.appKey === 'mysql') {
      return <RemoteMySQL connectionId={connection.id} />;
    }

    if (desktopWindow.appKey === 'redis') {
      return <RemoteRedis connectionId={connection.id} />;
    }

    if (desktopWindow.appKey === 'vnc') {
      return <RemoteVncViewer connectionId={connection.id} />;
    }

    if (desktopWindow.appKey === 'settings') {
      return <RemoteSettings connectionId={connection.id} systemType={connection.host.systemType} />;
    }

    if (desktopWindow.appKey === 'procmanager') {
      return <RemoteProcessManager connectionId={connection.id} systemType={connection.host.systemType} />;
    }

    if (desktopWindow.appKey === 'sqlite') {
      return <RemoteSqlite connectionId={connection.id} initialFilePath={desktopWindow.notepadInitialPath} systemType={connection.host.systemType} />;
    }

    return <RemoteMonitor connectionId={connection.id} systemType={connection.host.systemType} />;
  };

  return (
    <>
      <main className="remote-desktop-page">
        <section
          ref={desktopSurfaceRef}
          className={`remote-desktop-surface no-drag ${desktopWallpaperStyle ? 'has-custom-wallpaper' : ''}`}
          style={desktopWallpaperStyle}
        >
          <div className="desktop-icons" aria-label="桌面应用">
          {desktopApps.map((app) => (
            <button
              key={app.key}
              type="button"
              className={focusedWindow?.appKey === app.key ? 'active' : ''}
              onDoubleClick={() => openDesktopWindow(app.key)}
              onContextMenu={(event) => {
                event.preventDefault();
                setDesktopContextMenu({ x: event.clientX, y: event.clientY, appKey: app.key });
              }}
            >
              <span>{app.icon}</span>
              <strong>{app.label}</strong>
            </button>
          ))}
        </div>

        {desktopWindows.map((desktopWindow) => {
          const appInfo = getAppInfo(desktopWindow.appKey);
          const desktopWindowStyle: CSSProperties = {
            width: desktopWindow.frame.width,
            height: desktopWindow.frame.height,
            transform: `translate3d(${desktopWindow.frame.x}px, ${desktopWindow.frame.y}px, 0)`,
            zIndex: 10 + desktopWindow.zIndex,
          };

          return (
            <section
              key={desktopWindow.id}
              className={`desktop-window desktop-window-${desktopWindow.appKey} ${desktopWindow.id === focusedWindowId ? 'focused' : ''} ${desktopWindow.isMaximized ? 'maximized' : ''} ${desktopWindow.isMinimized ? 'minimized' : ''}`}
              aria-label={appInfo.label}
              aria-hidden={desktopWindow.isMinimized}
              style={desktopWindowStyle}
              onPointerDownCapture={() => bringWindowToFront(desktopWindow.id)}
            >
              <header
                className="desktop-window-titlebar"
                onPointerDown={(event) => startWindowInteraction(event, desktopWindow.id, 'move')}
                onPointerMove={updateWindowInteraction}
                onPointerUp={finishWindowInteraction}
                onPointerCancel={finishWindowInteraction}
              >
                <div className="desktop-window-title">
                  {desktopWindow.appKey === 'browser' || desktopWindow.appKey === 'terminal' ? (
                    <>
                      <span className="desktop-window-kicker">{appInfo.label}</span>
                      <strong title={desktopWindow.chromeTitle || appInfo.label}>
                        {desktopWindow.chromeTitle || appInfo.label}
                      </strong>
                      {desktopWindow.chromeStatus ? (
                        <span className={`desktop-window-state-pill ${desktopWindow.chromeTone || 'idle'}`}>
                          {desktopWindow.chromeStatus}
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <strong>{appInfo.label}</strong>
                  )}
                </div>
                <div className="win-titlebar-controls" aria-label="窗口控制" onPointerDown={(event) => event.stopPropagation()}>
                  {desktopWindow.appKey === 'terminal' ? (
                    <button
                      type="button"
                      className={`win-btn terminal-tools ${terminalTitlebarMenu?.windowId === desktopWindow.id ? 'active' : ''}`}
                      aria-label="终端工具"
                      aria-haspopup="menu"
                      aria-expanded={terminalTitlebarMenu?.windowId === desktopWindow.id}
                      title="终端工具"
                      onClick={(event) => {
                        if (terminalTitlebarMenu?.windowId === desktopWindow.id) {
                          setTerminalTitlebarMenu(null);
                          return;
                        }

                        const buttonRect = event.currentTarget.getBoundingClientRect();
                        const menuWidth = 190;
                        const menuEdgePadding = 8;
                        setTerminalTitlebarMenu({
                          windowId: desktopWindow.id,
                          x: Math.max(menuEdgePadding, Math.min(buttonRect.right - menuWidth, window.innerWidth - menuWidth - menuEdgePadding)),
                          y: buttonRect.bottom + 5,
                        });
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                        <circle cx="2" cy="6" r="1.2" fill="currentColor" />
                        <circle cx="6" cy="6" r="1.2" fill="currentColor" />
                        <circle cx="10" cy="6" r="1.2" fill="currentColor" />
                      </svg>
                    </button>
                  ) : null}
                  <button type="button" className="win-btn minimize" aria-label="最小化窗口" title="最小化" onClick={() => minimizeDesktopWindow(desktopWindow.id)}>
                    <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor" /></svg>
                  </button>
                  <button
                    type="button"
                    className="win-btn maximize"
                    aria-label={desktopWindow.isMaximized ? '还原窗口' : '最大化窗口'}
                    title={desktopWindow.isMaximized ? '还原' : '最大化'}
                    onClick={() => toggleWindowMaximize(desktopWindow.id)}
                  >
                    {desktopWindow.isMaximized ? (
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
                        <rect x="0.5" y="2.5" width="7" height="7" rx="0.5" />
                        <path d="M2.5 2.5V0.5H9.5V7.5H7.5" />
                      </svg>
                    ) : (
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
                        <rect x="0.5" y="0.5" width="9" height="9" rx="0.5" />
                      </svg>
                    )}
                  </button>
                  <button type="button" className="win-btn close" aria-label="关闭窗口" title="关闭" onClick={() => closeDesktopWindow(desktopWindow.id)}>
                    <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1.2">
                      <line x1="1" y1="1" x2="9" y2="9" />
                      <line x1="9" y1="1" x2="1" y2="9" />
                    </svg>
                  </button>
                </div>
              </header>
              <div className="desktop-window-body">{renderWindowContent(desktopWindow)}</div>
              {!desktopWindow.isMaximized ? (
                <div
                  className="desktop-window-resize-handle"
                  onPointerDown={(event) => startWindowInteraction(event, desktopWindow.id, 'resize')}
                  onPointerMove={updateWindowInteraction}
                  onPointerUp={finishWindowInteraction}
                  onPointerCancel={finishWindowInteraction}
                  aria-hidden="true"
                />
              ) : null}
            </section>
          );
        })}

        <nav className="mac-dock" aria-label="远程桌面 Dock">
          {(() => {
            const openAppKeys = new Set(desktopWindows.map((w) => w.appKey));
            const dockApps = [
              ...desktopApps.filter((app) => dockPinnedApps.includes(app.key as DesktopAppKey)),
              ...desktopApps.filter((app) => !dockPinnedApps.includes(app.key as DesktopAppKey) && openAppKeys.has(app.key)),
            ];

            return dockApps.map((app) => {
              const appWindows = desktopWindows.filter((desktopWindow) => desktopWindow.appKey === app.key);
              const hasOpenWindows = appWindows.length > 0;
              const hasVisibleWindows = appWindows.some((desktopWindow) => !desktopWindow.isMinimized);
              const isMinimizedOnly = hasOpenWindows && !hasVisibleWindows;
              const dockButtonClassName = [
                focusedWindow?.appKey === app.key ? 'active' : '',
                hasOpenWindows ? 'open' : '',
                isMinimizedOnly ? 'minimized' : '',
              ].filter(Boolean).join(' ');
              const dockButtonLabel = isMinimizedOnly
                ? `还原${app.label}`
                : hasOpenWindows
                  ? `切换到${app.label}`
                  : `打开${app.label}`;

              return (
                <button
                  key={app.key}
                  type="button"
                  className={dockButtonClassName}
                  onClick={() => activateDockApp(app.key)}
                  aria-label={dockButtonLabel}
                  title={dockButtonLabel}
                >
                  {app.icon}
                </button>
              );
            });
          })()}
        </nav>
      </section>
    </main>

    {desktopContextMenu ? createPortal(
      <>
        <div
          className="context-menu-overlay"
          onClick={() => setDesktopContextMenu(null)}
          onContextMenu={(e) => { e.preventDefault(); setDesktopContextMenu(null); }}
        />
        <div
          className="context-menu"
          style={{ left: desktopContextMenu!.x, top: desktopContextMenu!.y }}
          role="menu"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const { appKey } = desktopContextMenu!;
              setDesktopContextMenu(null);
              openDesktopWindow(appKey);
            }}
          >
            打开
          </button>
        </div>
      </>,
      document.body,
    ) : null}

    {terminalTitlebarMenu && terminalTitlebarMenuWindow ? createPortal(
      <>
        <div
          className="context-menu-overlay"
          onClick={() => setTerminalTitlebarMenu(null)}
          onContextMenu={(event) => {
            event.preventDefault();
            setTerminalTitlebarMenu(null);
          }}
        />
        <div
          className="context-menu terminal-titlebar-menu"
          style={{ left: terminalTitlebarMenu.x, top: terminalTitlebarMenu.y }}
          role="menu"
          aria-label="终端工具"
        >
          <button type="button" role="menuitem" onClick={() => requestTerminalTool(terminalTitlebarMenuWindow.id, 'new-terminal')}>
            新建终端窗口
          </button>
          <button type="button" role="menuitem" onClick={() => requestTerminalTool(terminalTitlebarMenuWindow.id, 'search')}>
            搜索输出
          </button>
          <button type="button" role="menuitem" onClick={() => requestTerminalTool(terminalTitlebarMenuWindow.id, 'clear')}>
            清屏
          </button>
          <div className="context-menu-sep" />
          <button type="button" role="menuitem" onClick={() => requestTerminalTool(terminalTitlebarMenuWindow.id, 'toggle-follow')}>
            切换自动跟随
          </button>
          <button type="button" role="menuitem" onClick={() => requestTerminalTool(terminalTitlebarMenuWindow.id, 'scroll-bottom')}>
            滚动到底部
          </button>
          {terminalTitlebarMenuWindow.terminalStatus === 'exited' ? (
            <button type="button" role="menuitem" onClick={() => requestTerminalTool(terminalTitlebarMenuWindow.id, 'restart')}>
              重新创建会话
            </button>
          ) : null}
          {onSettingsChange ? (
            <>
              <div className="context-menu-sep" />
              <button type="button" role="menuitem" onClick={() => requestTerminalTool(terminalTitlebarMenuWindow.id, 'settings')}>
                终端设置
              </button>
            </>
          ) : null}
        </div>
      </>,
      document.body,
    ) : null}

    {pendingCloseWindow ? createPortal(
      <div className="notepad-modal-overlay" role="presentation" onClick={() => setPendingCloseWindowId('')}>
        <div
          className="notepad-modal"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="terminal-close-confirm-title"
          onClick={(event) => event.stopPropagation()}
        >
          <div id="terminal-close-confirm-title" className="notepad-modal-title">关闭终端窗口</div>
          <div className="notepad-modal-message">
            该终端会话仍在运行，关闭窗口会结束当前 Shell。
          </div>
          <div className="notepad-modal-actions">
            <button type="button" className="notepad-modal-btn" onClick={() => setPendingCloseWindowId('')}>取消</button>
            <button type="button" className="notepad-modal-btn danger" onClick={() => {
              const windowId = pendingCloseWindow.id;
              setPendingCloseWindowId('');
              removeDesktopWindow(windowId);
            }}>
              关闭
            </button>
          </div>
        </div>
      </div>,
      document.body,
    ) : null}
  </>
  );
}

export default RemoteDesktopShell;
