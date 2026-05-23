import { type CSSProperties, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { RemoteBrowser, RemoteContainerManager, RemoteDiskAnalyzer, RemoteFileExplorer, RemoteLogViewer, RemoteMonitor, RemoteMySQL, RemoteNetworkDiagnostics, RemoteNotepad, RemotePortManager, RemoteProcessManager, RemoteRedis, RemoteServiceManager, RemoteSettings, RemoteSqlite, RemoteTerminal, RemoteVncViewer } from './components/remote-desktop';
import type { RemoteProcessManagerLaunchOptions } from './components/remote-desktop/RemoteProcessManager';
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
  { key: 'files', label: '文件管理', description: 'Windows 风格 SFTP 资源管理器' },
  { key: 'terminal', label: '终端', description: '交互式 SSH Shell' },
  { key: 'notepad', label: '记事本', description: '远程文件编辑器' },
  { key: 'browser', label: '浏览器', description: '远程源请求' },
  { key: 'vnc', label: 'VNC Viewer', description: '连接本机或内网 VNC 桌面' },
  { key: 'log-viewer', label: '日志查看', description: 'journalctl / /var/log / Event Log' },
  { key: 'monitor', label: '系统监视器', description: '服务器状态' },
  { key: 'mysql', label: 'MySQL', description: 'MySQL 数据库管理' },
  { key: 'redis', label: 'Redis', description: 'Redis 数据库管理' },
  { key: 'service-manager', label: '服务管理', description: 'systemd / Windows Services' },
  { key: 'container-manager', label: '容器管理', description: 'Docker / Podman 容器与镜像' },
  { key: 'port-manager', label: '端口监听', description: '端口占用与连接状态' },
  { key: 'network-diagnostics', label: '网络诊断', description: 'Ping / DNS / HTTP / TCP' },
  { key: 'disk-analyzer', label: '磁盘分析', description: '空间占用与大文件定位' },
  { key: 'procmanager', label: '进程管理', description: '进程查看、搜索和终止' },
  { key: 'settings', label: '系统设置', description: '网络、镜像源、更新、Hosts、路由、磁盘' },
  { key: 'sqlite', label: 'SQLite', description: 'SQLite 数据库查看与编辑' },
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
  processManagerLaunchOptions?: RemoteProcessManagerLaunchOptions;
  fileExplorerInitialPath?: string;
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
  'log-viewer': { x: 118, y: 46, width: 1080, height: 650 },
  monitor: { x: 224, y: 86, width: 820, height: 520 },
  mysql: { x: 100, y: 40, width: 1020, height: 620 },
  redis: { x: 100, y: 40, width: 1020, height: 620 },
  'service-manager': { x: 110, y: 44, width: 1080, height: 650 },
  'container-manager': { x: 104, y: 42, width: 1100, height: 660 },
  'port-manager': { x: 116, y: 48, width: 1120, height: 650 },
  'network-diagnostics': { x: 120, y: 52, width: 1060, height: 640 },
  'disk-analyzer': { x: 110, y: 46, width: 1120, height: 650 },
  procmanager: { x: 126, y: 54, width: 1100, height: 640 },
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

function DesktopAppIcon({ appKey }: { appKey: DesktopAppKey }) {
  const iconProps = {
    className: 'desktop-app-icon',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };

  if (appKey === 'files') {
    return (
      <svg {...iconProps}>
        <path d="M3.5 6.75A2.25 2.25 0 0 1 5.75 4.5h4.05l1.7 2h6.75a2.25 2.25 0 0 1 2.25 2.25v8a2.75 2.75 0 0 1-2.75 2.75H6.25a2.75 2.75 0 0 1-2.75-2.75v-10Z" />
        <path d="M4 9h16" />
      </svg>
    );
  }

  if (appKey === 'terminal') {
    return (
      <svg {...iconProps}>
        <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
        <path d="m7.25 9 2.8 2.5-2.8 2.5" />
        <path d="M12.25 14.25h4.5" />
      </svg>
    );
  }

  if (appKey === 'notepad') {
    return (
      <svg {...iconProps}>
        <path d="M6 3.75h8.25L18 7.5v12.75H6V3.75Z" />
        <path d="M14 4v4h4" />
        <path d="M8.75 10.5h5.5M8.75 14h6.5M8.75 17.5h3.5" />
      </svg>
    );
  }

  if (appKey === 'browser') {
    return (
      <svg {...iconProps}>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M3.75 12h16.5" />
        <path d="M12 3.5c2.2 2.35 3.3 5.18 3.3 8.5s-1.1 6.15-3.3 8.5c-2.2-2.35-3.3-5.18-3.3-8.5S9.8 5.85 12 3.5Z" />
      </svg>
    );
  }

  if (appKey === 'vnc') {
    return (
      <svg {...iconProps}>
        <rect x="3.5" y="5" width="17" height="11.5" rx="2.25" />
        <path d="M8.5 20h7M12 16.5V20" />
        <path d="M7.25 9.5h9.5M7.25 12.5h4.5" />
      </svg>
    );
  }

  if (appKey === 'log-viewer') {
    return (
      <svg {...iconProps}>
        <path d="M6 3.75h8.25L18 7.5v12.75H6V3.75Z" />
        <path d="M14 4v4h4" />
        <path d="M8.75 11h6.5M8.75 14.25h6.5M8.75 17.5h4" />
        <circle cx="17.5" cy="17.5" r="2.25" />
      </svg>
    );
  }

  if (appKey === 'monitor') {
    return (
      <svg {...iconProps}>
        <path d="M4.25 18.75V5.25" />
        <path d="M4.25 18.75h15.5" />
        <path d="m7 15 3.15-3.4 2.75 2.25 4.45-5.2" />
        <path d="M16.75 8.65h2.1v2.1" />
      </svg>
    );
  }

  if (appKey === 'mysql') {
    return (
      <svg {...iconProps}>
        <ellipse cx="12" cy="5.75" rx="6.75" ry="2.75" />
        <path d="M5.25 5.75v8.5C5.25 15.77 8.27 17 12 17s6.75-1.23 6.75-2.75v-8.5" />
        <path d="M5.25 10c0 1.52 3.02 2.75 6.75 2.75S18.75 11.52 18.75 10" />
        <path d="M9.25 20.25h5.5" />
      </svg>
    );
  }

  if (appKey === 'redis') {
    return (
      <svg {...iconProps}>
        <path d="m12 3.75 7 3.4-7 3.35-7-3.35 7-3.4Z" />
        <path d="m5 11 7 3.35L19 11" />
        <path d="m5 14.9 7 3.35 7-3.35" />
      </svg>
    );
  }

  if (appKey === 'service-manager') {
    return (
      <svg {...iconProps}>
        <path d="M5 7h14M5 12h14M5 17h14" />
        <circle cx="9" cy="7" r="1.75" fill="currentColor" stroke="none" />
        <circle cx="15" cy="12" r="1.75" fill="currentColor" stroke="none" />
        <circle cx="11.5" cy="17" r="1.75" fill="currentColor" stroke="none" />
      </svg>
    );
  }

  if (appKey === 'container-manager') {
    return (
      <svg {...iconProps}>
        <path d="M5 8.5h14v8.25H5V8.5Z" />
        <path d="M8.5 8.5v8.25M12 8.5v8.25M15.5 8.5v8.25" />
        <path d="M7 5h10v3.5H7V5Z" />
        <path d="M6.25 19h11.5" />
      </svg>
    );
  }

  if (appKey === 'port-manager') {
    return (
      <svg {...iconProps}>
        <path d="M4.25 7.5h5.25l2.5 4.5h7.75" />
        <path d="M4.25 16.5h5.25l2.5-4.5" />
        <circle cx="4.25" cy="7.5" r="1.75" />
        <circle cx="4.25" cy="16.5" r="1.75" />
        <circle cx="19.75" cy="12" r="1.75" />
        <path d="M13.25 7.5h2.75M15.75 16.5h2.25" />
      </svg>
    );
  }

  if (appKey === 'network-diagnostics') {
    return (
      <svg {...iconProps}>
        <path d="M4.5 12a7.5 7.5 0 0 1 15 0" />
        <path d="M7.25 12a4.75 4.75 0 0 1 9.5 0" />
        <path d="M10 12a2 2 0 0 1 4 0" />
        <path d="M12 14.25v5" />
        <path d="M8.5 19.25h7" />
        <circle cx="12" cy="4.75" r="1.5" />
      </svg>
    );
  }

  if (appKey === 'disk-analyzer') {
    return (
      <svg {...iconProps}>
        <ellipse cx="12" cy="6" rx="6.5" ry="2.75" />
        <path d="M5.5 6v8.5c0 1.52 2.91 2.75 6.5 2.75s6.5-1.23 6.5-2.75V6" />
        <path d="M5.5 10.25C5.5 11.77 8.41 13 12 13s6.5-1.23 6.5-2.75" />
        <path d="M8.5 20h7" />
        <path d="M15.75 16.75 18.5 20" />
      </svg>
    );
  }

  if (appKey === 'procmanager') {
    return (
      <svg {...iconProps}>
        <rect x="7" y="7" width="10" height="10" rx="2" />
        <path d="M10 3.75v2.5M14 3.75v2.5M10 17.75v2.5M14 17.75v2.5M3.75 10h2.5M3.75 14h2.5M17.75 10h2.5M17.75 14h2.5" />
        <path d="M9.75 12h1.7l1.05-2.2 1.35 4.4.95-2.2h1.45" />
      </svg>
    );
  }

  if (appKey === 'settings') {
    return (
      <svg {...iconProps}>
        <path d="M12 8.75a3.25 3.25 0 1 1 0 6.5 3.25 3.25 0 0 1 0-6.5Z" />
        <path d="m18.65 13.5 1.85 1.38-1.75 3.03-2.18-.9a7.18 7.18 0 0 1-1.65.95l-.3 2.29h-3.5l-.3-2.29a7.18 7.18 0 0 1-1.65-.95l-2.18.9-1.75-3.03L7.35 13.5a7.55 7.55 0 0 1 0-1.9L5.5 10.12l1.75-3.03 2.18.9c.5-.39 1.05-.7 1.65-.95l.3-2.29h3.5l.3 2.29c.6.25 1.15.56 1.65.95l2.18-.9 1.75 3.03-1.85 1.48c.08.62.08 1.27 0 1.9Z" />
      </svg>
    );
  }

  return (
    <svg {...iconProps}>
      <path d="M6.25 4.25h9l2.5 2.5v13H6.25V4.25Z" />
      <path d="M15 4.5V7h2.5" />
      <ellipse cx="12" cy="10" rx="4" ry="1.7" />
      <path d="M8 10v5.25c0 .94 1.8 1.7 4 1.7s4-.76 4-1.7V10" />
      <path d="M8 12.75c0 .94 1.8 1.7 4 1.7s4-.76 4-1.7" />
    </svg>
  );
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

  const openFileManagerAtPath = (directoryPath: string) => {
    const existingWindow = getTopDesktopWindow(desktopWindows, (desktopWindow) => desktopWindow.appKey === 'files');

    if (existingWindow) {
      zIndexRef.current += 1;
      const nextZIndex = zIndexRef.current;
      setFocusedWindowId(existingWindow.id);
      setDesktopWindows((currentWindows) => currentWindows.map((desktopWindow) => (
        desktopWindow.id === existingWindow.id
          ? { ...desktopWindow, isMinimized: false, zIndex: nextZIndex, fileExplorerInitialPath: directoryPath }
          : desktopWindow
      )));
      return;
    }

    appendDesktopWindow('files', (nextWindow) => {
      nextWindow.fileExplorerInitialPath = directoryPath;
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

  const openProcessManager = (launchOptions?: RemoteProcessManagerLaunchOptions) => {
    const existingWindow = getTopDesktopWindow(desktopWindows, (desktopWindow) => desktopWindow.appKey === 'procmanager');

    if (existingWindow) {
      zIndexRef.current += 1;
      const nextZIndex = zIndexRef.current;

      setFocusedWindowId(existingWindow.id);
      setDesktopWindows((currentWindows) => currentWindows.map((desktopWindow) => (
        desktopWindow.id === existingWindow.id
          ? {
              ...desktopWindow,
              isMinimized: false,
              zIndex: nextZIndex,
              processManagerLaunchOptions: launchOptions ? { ...launchOptions } : desktopWindow.processManagerLaunchOptions,
            }
          : desktopWindow
      )));
      return;
    }

    appendDesktopWindow('procmanager', (nextWindow) => {
      nextWindow.processManagerLaunchOptions = launchOptions ? { ...launchOptions } : undefined;
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
    setDesktopWindows((currentWindows) => {
      const windowIndex = currentWindows.findIndex((desktopWindow) => desktopWindow.id === windowId);
      const desktopWindow = currentWindows[windowIndex];

      if (
        !desktopWindow ||
        (
          desktopWindow.chromeTitle === payload.title &&
          desktopWindow.chromeStatus === payload.status &&
          desktopWindow.chromeTone === payload.tone
        )
      ) {
        return currentWindows;
      }

      return currentWindows.map((currentWindow) => (
        currentWindow.id === windowId
          ? {
              ...currentWindow,
              chromeTitle: payload.title,
              chromeStatus: payload.status,
              chromeTone: payload.tone,
            }
          : currentWindow
      ));
    });
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
          context={{
            name: connection.host.name,
            address: connection.host.address,
            port: connection.host.port,
            username: connection.host.username,
            proxyPort: connection.proxyPort,
          }}
          onChromeChange={(payload) => updateWindowChrome(desktopWindow.id, payload)}
        />
      );
    }

    if (desktopWindow.appKey === 'files') {
      return <RemoteFileExplorer connectionId={connection.id} systemType={connection.host.systemType} initialPath={desktopWindow.fileExplorerInitialPath} onOpenFile={openNotepadFile} onOpenSqliteFile={openSqliteFile} onOpenTerminal={openTerminalAtPath} />;
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

    if (desktopWindow.appKey === 'log-viewer') {
      return <RemoteLogViewer connectionId={connection.id} systemType={connection.host.systemType} />;
    }

    if (desktopWindow.appKey === 'settings') {
      return <RemoteSettings connectionId={connection.id} systemType={connection.host.systemType} />;
    }

    if (desktopWindow.appKey === 'procmanager') {
      return <RemoteProcessManager connectionId={connection.id} systemType={connection.host.systemType} launchOptions={desktopWindow.processManagerLaunchOptions} />;
    }

    if (desktopWindow.appKey === 'service-manager') {
      return <RemoteServiceManager connectionId={connection.id} systemType={connection.host.systemType} />;
    }

    if (desktopWindow.appKey === 'container-manager') {
      return <RemoteContainerManager connectionId={connection.id} systemType={connection.host.systemType} />;
    }

    if (desktopWindow.appKey === 'port-manager') {
      return <RemotePortManager connectionId={connection.id} systemType={connection.host.systemType} onOpenProcessManager={openProcessManager} />;
    }

    if (desktopWindow.appKey === 'network-diagnostics') {
      return <RemoteNetworkDiagnostics connectionId={connection.id} systemType={connection.host.systemType} />;
    }

    if (desktopWindow.appKey === 'disk-analyzer') {
      return <RemoteDiskAnalyzer connectionId={connection.id} systemType={connection.host.systemType} onOpenFileManager={openFileManagerAtPath} />;
    }

    if (desktopWindow.appKey === 'sqlite') {
      return <RemoteSqlite connectionId={connection.id} initialFilePath={desktopWindow.notepadInitialPath} systemType={connection.host.systemType} />;
    }

    return <RemoteMonitor connectionId={connection.id} systemType={connection.host.systemType} onOpenProcessManager={openProcessManager} />;
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
              <span className={`desktop-app-icon-shell desktop-app-icon-${app.key}`}>
                <DesktopAppIcon appKey={app.key} />
              </span>
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
                  <span className={`desktop-title-icon desktop-app-icon-${desktopWindow.appKey}`}>
                    <DesktopAppIcon appKey={desktopWindow.appKey} />
                  </span>
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
                  <span className={`dock-app-icon desktop-app-icon-${app.key}`}>
                    <DesktopAppIcon appKey={app.key} />
                  </span>
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
