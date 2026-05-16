import { type CSSProperties, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';

import { RemoteBrowser, RemoteFileExplorer, RemoteMonitor, RemoteMySQL, RemoteNotepad, RemoteSettings, RemoteTerminal } from './components/remote-desktop';
import type { RemoteConnectionInfo } from './components/remote-desktop/types';

const desktopApps = [
  { key: 'files', label: '文件管理', icon: '📁', description: 'Windows 风格 SFTP 资源管理器' },
  { key: 'terminal', label: '终端', icon: '>_', description: '交互式 SSH Shell' },
  { key: 'notepad', label: '记事本', icon: '📝', description: '远程文件编辑器' },
  { key: 'browser', label: '浏览器', icon: '🌐', description: '远程源请求' },
  { key: 'monitor', label: '系统监视器', icon: '📊', description: '服务器状态' },
  { key: 'mysql', label: 'MySQL', icon: '🐬', description: 'MySQL 数据库管理' },
  { key: 'settings', label: '系统设置', icon: '\u2699\uFE0F', description: '网络、镜像源、更新、Hosts、路由、磁盘' },
] as const;

/** 始终固定在 Dock 栏的应用，其他应用仅在桌面显示，打开时才会动态出现在 Dock */
const dockPinnedApps: DesktopAppKey[] = ['files', 'terminal', 'browser', 'monitor', 'settings'];

type DesktopAppKey = (typeof desktopApps)[number]['key'];

interface RemoteDesktopProps {
  connection: RemoteConnectionInfo;
  settings: GuiSshAppSettings;
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
  zIndex: number;
  terminalId?: string;
  chromeTitle?: string;
  chromeStatus?: string;
  chromeTone?: 'idle' | 'loading' | 'error';
  notepadInitialPath?: string;
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

const windowEdgePadding = 14;
const windowDockSafeArea = 92;
const windowMinWidth = 360;
const windowMinHeight = 260;

const defaultWindowFrames: Record<DesktopAppKey, DesktopWindowFrame> = {
  files: { x: 172, y: 62, width: 920, height: 560 },
  terminal: { x: 206, y: 80, width: 780, height: 500 },
  notepad: { x: 140, y: 50, width: 860, height: 580 },
  browser: { x: 190, y: 68, width: 940, height: 560 },
  monitor: { x: 224, y: 86, width: 820, height: 520 },
  mysql: { x: 100, y: 40, width: 1020, height: 620 },
  settings: { x: 160, y: 55, width: 960, height: 580 },
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
    zIndex,
    terminalId: appKey === 'terminal' ? `terminal-${sequence}` : undefined,
    chromeTitle: isBrowserWindow ? '127.0.0.1' : undefined,
    chromeStatus: isBrowserWindow ? '已就绪' : undefined,
    chromeTone: isBrowserWindow ? 'idle' : undefined,
  };
}

function getAppInfo(appKey: DesktopAppKey) {
  return desktopApps.find((app) => app.key === appKey) ?? desktopApps[0];
}

function RemoteDesktopShell({ connection, settings }: RemoteDesktopProps) {
  const desktopSurfaceRef = useRef<HTMLElement | null>(null);
  const windowPointerStateRef = useRef<DesktopWindowPointerState | null>(null);
  const windowSequenceRef = useRef(0);
  const zIndexRef = useRef(0);
  const [desktopWindows, setDesktopWindows] = useState<DesktopWindowState[]>([]);
  const [focusedWindowId, setFocusedWindowId] = useState('');
  const focusedWindow = desktopWindows.find((desktopWindow) => desktopWindow.id === focusedWindowId) ?? null;

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
      desktopWindow.id === windowId ? { ...desktopWindow, zIndex: nextZIndex } : desktopWindow
    )));
  };

  const openDesktopWindow = (appKey: DesktopAppKey) => {
    windowSequenceRef.current += 1;
    zIndexRef.current += 1;
    const nextWindow = createDesktopWindow(appKey, windowSequenceRef.current, zIndexRef.current);
    const surface = desktopSurfaceRef.current;

    if (surface) {
      const surfaceRect = surface.getBoundingClientRect();
      nextWindow.frame = clampWindowFrame(nextWindow.frame, surfaceRect.width, surfaceRect.height);
    }

    setDesktopWindows((currentWindows) => [...currentWindows, nextWindow]);
    setFocusedWindowId(nextWindow.id);
  };

  const openNotepadFile = (filePath: string) => {
    windowSequenceRef.current += 1;
    zIndexRef.current += 1;
    const nextWindow = createDesktopWindow('notepad', windowSequenceRef.current, zIndexRef.current);
    nextWindow.notepadInitialPath = filePath;
    const surface = desktopSurfaceRef.current;

    if (surface) {
      const surfaceRect = surface.getBoundingClientRect();
      nextWindow.frame = clampWindowFrame(nextWindow.frame, surfaceRect.width, surfaceRect.height);
    }

    setDesktopWindows((currentWindows) => [...currentWindows, nextWindow]);
    setFocusedWindowId(nextWindow.id);
  };

  const closeDesktopWindow = (windowId: string) => {
    setDesktopWindows((currentWindows) => {
      const nextWindows = currentWindows.filter((desktopWindow) => desktopWindow.id !== windowId);
      const nextFocusedWindow = nextWindows.reduce<DesktopWindowState | null>((currentTopWindow, desktopWindow) => {
        if (!currentTopWindow || desktopWindow.zIndex > currentTopWindow.zIndex) {
          return desktopWindow;
        }

        return currentTopWindow;
      }, null);

      setFocusedWindowId(nextFocusedWindow?.id ?? '');
      return nextWindows;
    });
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

    if (!surface || !desktopWindow || desktopWindow.isMaximized) {
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
    payload: { title: string; status: string; tone: 'idle' | 'loading' | 'error' },
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

  const renderWindowContent = (desktopWindow: DesktopWindowState) => {
    if (desktopWindow.appKey === 'terminal') {
      return (
        <RemoteTerminal
          connectionId={connection.id}
          terminalId={desktopWindow.terminalId ?? desktopWindow.id}
          settings={settings}
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
      return <RemoteFileExplorer connectionId={connection.id} onOpenFile={openNotepadFile} />;
    }

    if (desktopWindow.appKey === 'notepad') {
      return <RemoteNotepad connectionId={connection.id} initialFilePath={desktopWindow.notepadInitialPath} />;
    }

    if (desktopWindow.appKey === 'mysql') {
      return <RemoteMySQL connectionId={connection.id} />;
    }

    if (desktopWindow.appKey === 'settings') {
      return <RemoteSettings connectionId={connection.id} />;
    }

    return <RemoteMonitor connectionId={connection.id} />;
  };

  return (
    <main className="remote-desktop-page">
      <section ref={desktopSurfaceRef} className="remote-desktop-surface no-drag">
        <div className="desktop-icons" aria-label="桌面应用">
          {desktopApps.map((app) => (
            <button
              key={app.key}
              type="button"
              className={focusedWindow?.appKey === app.key ? 'active' : ''}
              onClick={() => openDesktopWindow(app.key)}
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
              className={`desktop-window ${desktopWindow.id === focusedWindowId ? 'focused' : ''} ${desktopWindow.isMaximized ? 'maximized' : ''}`}
              aria-label={appInfo.label}
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
                  {desktopWindow.appKey === 'browser' ? (
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
                  <button type="button" className="win-btn minimize" aria-label="最小化窗口" title="最小化" onClick={() => closeDesktopWindow(desktopWindow.id)}>
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

            return dockApps.map((app) => (
              <button
                key={app.key}
                type="button"
                className={focusedWindow?.appKey === app.key ? 'active' : ''}
                onClick={() => openDesktopWindow(app.key)}
                title={app.label}
              >
                {app.icon}
              </button>
            ));
          })()}
        </nav>
      </section>
    </main>
  );
}

export default RemoteDesktopShell;
