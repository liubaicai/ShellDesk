import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';

import type { RemoteConnectionInfo } from './RemoteDesktop';

const desktopApps = [
  { key: 'files', label: '文件管理', icon: '📁', description: 'Windows 风格 SFTP 资源管理器' },
  { key: 'terminal', label: '终端', icon: '>_', description: '交互式 SSH Shell' },
  { key: 'browser', label: '浏览器', icon: '🌐', description: '远程源请求' },
  { key: 'monitor', label: '系统监视器', icon: '📊', description: '服务器状态' },
] as const;

type DesktopAppKey = (typeof desktopApps)[number]['key'];

interface RemoteDesktopProps {
  connection: RemoteConnectionInfo;
  onDisconnect: () => void;
}

interface RemoteFileEntry {
  name: string;
  longname: string;
  type: 'directory' | 'file' | 'symlink';
  size: number;
  modifiedAt: string;
}

interface RemoteDirectoryResult {
  path: string;
  entries: RemoteFileEntry[];
}

interface RemoteStatusItem {
  key: string;
  label: string;
  value: string;
}

interface RemoteStatusReport {
  refreshedAt: string;
  items: RemoteStatusItem[];
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
  browser: { x: 190, y: 68, width: 940, height: 560 },
  monitor: { x: 224, y: 86, width: 820, height: 520 },
};

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
  }

  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }

  return '操作失败。';
}

function normalizeBrowserUrl(value: string) {
  const url = value.trim();

  if (!url) {
    return 'http://127.0.0.1';
  }

  if (/^https?:\/\//i.test(url)) {
    return url;
  }

  return `http://${url}`;
}

function joinRemotePath(basePath: string, entryName: string) {
  const base = basePath.trim() || '.';

  if (base === '/') {
    return `/${entryName}`;
  }

  if (base === '.') {
    return entryName;
  }

  return `${base.replace(/\/+$/, '')}/${entryName}`;
}

function getParentRemotePath(remotePath: string) {
  const path = remotePath.trim() || '.';

  if (path === '/') {
    return '/';
  }

  if (path === '.') {
    return '..';
  }

  const normalized = path.replace(/\/+$/, '');
  const slashIndex = normalized.lastIndexOf('/');

  if (slashIndex < 0) {
    return '.';
  }

  if (slashIndex === 0) {
    return '/';
  }

  return normalized.slice(0, slashIndex);
}

function formatBytes(size: number) {
  if (!Number.isFinite(size) || size < 0) {
    return '-';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = size;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatDateTime(value: string) {
  if (!value) {
    return '-';
  }

  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

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
  };
}

function getAppInfo(appKey: DesktopAppKey) {
  return desktopApps.find((app) => app.key === appKey) ?? desktopApps[0];
}

function getFileIcon(entry: RemoteFileEntry) {
  if (entry.type === 'directory') {
    return '📁';
  }

  if (entry.type === 'symlink') {
    return '🔗';
  }

  return '📄';
}

function getFileTypeLabel(entry: RemoteFileEntry) {
  if (entry.type === 'directory') {
    return '文件夹';
  }

  if (entry.type === 'symlink') {
    return '快捷方式';
  }

  return '文件';
}

function RemoteTerminal({ connectionId, terminalId }: { connectionId: string; terminalId: string }) {
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const lastSizeRef = useRef({ columns: 0, rows: 0 });
  const isTerminalReadyRef = useRef(false);
  const useLegacyTerminalIpcRef = useRef(false);

  useEffect(() => {
    const host = terminalHostRef.current;
    const api = window.guiSSH;

    if (!host || !api?.connections || !api.events) {
      return;
    }

    let disposed = false;
    let animationFrame = 0;
    let startWarningTimer = 0;
    const supportsTerminalIpcOptions = typeof api.connections.getIpcCapabilities === 'function';
    isTerminalReadyRef.current = false;
    const terminal = new XTerminal({
      allowTransparency: true,
      cursorBlink: true,
      cursorStyle: 'block',
      fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 10000,
      theme: {
        background: '#05090f',
        foreground: '#d7fbe8',
        cursor: '#8cf7d5',
        selectionBackground: '#29546f',
        black: '#111827',
        red: '#ff6f8f',
        green: '#8cf7d5',
        yellow: '#ffe08a',
        blue: '#43c7ff',
        magenta: '#c084fc',
        cyan: '#67e8f9',
        white: '#edf4ff',
      },
    });
    const fitAddon = new FitAddon();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    terminal.focus();
    terminal.writeln('正在启动 SSH 终端...');

    const getTerminalSize = () => {
      try {
        fitAddon.fit();
      } catch {
        return { columns: 100, rows: 30 };
      }

      return {
        columns: Math.min(Math.max(terminal.cols || 100, 20), 300),
        rows: Math.min(Math.max(terminal.rows || 30, 5), 120),
      };
    };

    const fitAndSyncSize = () => {
      if (disposed) {
        return;
      }

      const { columns, rows } = getTerminalSize();

      if (lastSizeRef.current.columns === columns && lastSizeRef.current.rows === rows) {
        return;
      }

      lastSizeRef.current = { columns, rows };
      if (supportsTerminalIpcOptions) {
        api.connections
          .resizeTerminal(connectionId, terminalId, columns, rows, { legacy: useLegacyTerminalIpcRef.current })
          .catch(() => undefined);
      } else {
        const resizeTerminal = api.connections.resizeTerminal as unknown as (
          nextConnectionId: string,
          nextColumns: number,
          nextRows: number,
        ) => Promise<boolean>;
        resizeTerminal(connectionId, columns, rows).catch(() => undefined);
      }
    };

    const removeTerminalData = api.events.onTerminalData((payload) => {
      if (payload.connectionId === connectionId && (payload.terminalId === terminalId || !payload.terminalId)) {
        if (!payload.terminalId) {
          useLegacyTerminalIpcRef.current = true;
        }

        terminal.write(payload.data);
      }
    });
    const removeTerminalExit = api.events.onTerminalExit((payload) => {
      if (payload.connectionId === connectionId && (payload.terminalId === terminalId || !payload.terminalId)) {
        isTerminalReadyRef.current = false;
        terminal.writeln('\r\n终端会话已结束。');
      }
    });
    const inputDisposable = terminal.onData((data) => {
      if (!isTerminalReadyRef.current) {
        return;
      }

      const writePromise = supportsTerminalIpcOptions
        ? api.connections.writeTerminal(connectionId, terminalId, data, { legacy: useLegacyTerminalIpcRef.current })
        : (api.connections.writeTerminal as unknown as (
            nextConnectionId: string,
            nextData: string,
          ) => Promise<boolean>)(connectionId, data);

      writePromise.catch((error: unknown) => {
        terminal.writeln(`\r\n发送失败：${getErrorMessage(error)}`);
      });
    });
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fitAndSyncSize);

    resizeObserver?.observe(host);
    animationFrame = window.requestAnimationFrame(() => {
      const { columns, rows } = getTerminalSize();
      lastSizeRef.current = { columns, rows };
      terminal.writeln('正在申请远程 Shell...');
      startWarningTimer = window.setTimeout(() => {
        if (!disposed && !isTerminalReadyRef.current) {
          terminal.writeln('\r\n终端仍在启动：远程服务器尚未返回 Shell，请检查服务器是否允许交互式登录。');
        }
      }, 12000);

      const capabilitiesPromise = supportsTerminalIpcOptions
        ? api.connections.getIpcCapabilities()
        : Promise.resolve({ terminalSessions: false });

      capabilitiesPromise
        .then((capabilities) => {
          useLegacyTerminalIpcRef.current = !capabilities.terminalSessions;

          if (useLegacyTerminalIpcRef.current) {
            terminal.writeln('检测到旧版 Electron 主进程，使用单终端兼容模式。');
          }

          if (supportsTerminalIpcOptions) {
            return api.connections.startTerminal(connectionId, terminalId, columns, rows, {
              legacy: useLegacyTerminalIpcRef.current,
            });
          }

          return (api.connections.startTerminal as unknown as (nextConnectionId: string) => Promise<boolean>)(connectionId);
        })
        .then(() => {
          window.clearTimeout(startWarningTimer);

          if (disposed) {
            return;
          }

          isTerminalReadyRef.current = true;
          terminal.writeln('\r\n终端已连接。');
          fitAndSyncSize();
          terminal.focus();
        })
        .catch((error: unknown) => {
          window.clearTimeout(startWarningTimer);

          if (disposed) {
            return;
          }

          terminal.writeln(`\r\n终端启动失败：${getErrorMessage(error)}`);
        });
    });

    return () => {
      disposed = true;
      isTerminalReadyRef.current = false;
      window.clearTimeout(startWarningTimer);
      window.cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      inputDisposable.dispose();
      removeTerminalData();
      removeTerminalExit();
      if (supportsTerminalIpcOptions && !useLegacyTerminalIpcRef.current) {
        api.connections.closeTerminal(connectionId, terminalId).catch(() => undefined);
      }

      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [connectionId, terminalId]);

  return (
    <div className="terminal-pane xterm-terminal-pane">
      <div ref={terminalHostRef} className="terminal-host" />
    </div>
  );
}

function RemoteBrowser({ connection }: { connection: RemoteConnectionInfo }) {
  const [browserAddress, setBrowserAddress] = useState('http://127.0.0.1');
  const [browserSrc, setBrowserSrc] = useState('http://127.0.0.1');
  const browserViewRef = useRef<HTMLElement | null>(null);

  const submitBrowserAddress = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextUrl = normalizeBrowserUrl(browserAddress);
    setBrowserAddress(nextUrl);
    setBrowserSrc(nextUrl);
  };

  const navigateWebview = (action: 'back' | 'forward' | 'reload') => {
    const webview = browserViewRef.current as (HTMLElement & {
      goBack?: () => void;
      goForward?: () => void;
      reload?: () => void;
    }) | null;

    if (action === 'back') {
      webview?.goBack?.();
    } else if (action === 'forward') {
      webview?.goForward?.();
    } else {
      webview?.reload?.();
    }
  };

  return (
    <div className="remote-browser-pane">
      <form className="browser-toolbar" onSubmit={submitBrowserAddress}>
        <button type="button" onClick={() => navigateWebview('back')}>‹</button>
        <button type="button" onClick={() => navigateWebview('forward')}>›</button>
        <button type="button" onClick={() => navigateWebview('reload')}>刷新</button>
        <input
          value={browserAddress}
          onChange={(event) => setBrowserAddress(event.target.value)}
          placeholder="127.0.0.1 / 10.0.0.12:8080 / https://example.com"
          autoCapitalize="off"
          spellCheck={false}
        />
        <button type="submit">打开</button>
      </form>
      <div className="proxy-note">此浏览器使用 SSH SOCKS5 隧道；127.0.0.1、localhost 和局域网 IP 都从目标服务器侧访问。</div>
      <webview
        ref={browserViewRef}
        className="remote-webview"
        partition={connection.partition}
        src={browserSrc}
      />
    </div>
  );
}

function RemoteFileExplorer({ connectionId }: { connectionId: string }) {
  const [remotePath, setRemotePath] = useState('.');
  const [pathDraft, setPathDraft] = useState('.');
  const [fileEntries, setFileEntries] = useState<RemoteFileEntry[]>([]);
  const [selectedEntryName, setSelectedEntryName] = useState('');
  const [filesError, setFilesError] = useState('');
  const [isFilesLoading, setIsFilesLoading] = useState(false);
  const [filesRefreshToken, setFilesRefreshToken] = useState(0);
  const selectedEntry = fileEntries.find((entry) => entry.name === selectedEntryName) ?? null;

  useEffect(() => {
    setPathDraft(remotePath);
  }, [remotePath]);

  useEffect(() => {
    if (!window.guiSSH?.connections) {
      setFilesError('当前运行环境不支持 SFTP 文件浏览。');
      return;
    }

    let cancelled = false;

    const loadFiles = async () => {
      setIsFilesLoading(true);
      setFilesError('');
      setSelectedEntryName('');

      try {
        const result: RemoteDirectoryResult = await window.guiSSH!.connections.listDirectory(connectionId, remotePath);

        if (!cancelled) {
          setFileEntries(result.entries);
          setRemotePath(result.path);
          setPathDraft(result.path);
        }
      } catch (error) {
        if (!cancelled) {
          setFileEntries([]);
          setFilesError(getErrorMessage(error));
        }
      } finally {
        if (!cancelled) {
          setIsFilesLoading(false);
        }
      }
    };

    void loadFiles();

    return () => {
      cancelled = true;
    };
  }, [connectionId, filesRefreshToken, remotePath]);

  const navigateToPath = (nextPath: string) => {
    setRemotePath(nextPath.trim() || '.');
  };

  const submitRemotePath = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    navigateToPath(pathDraft);
  };

  const openFileEntry = (entry: RemoteFileEntry) => {
    if (entry.type === 'directory') {
      navigateToPath(joinRemotePath(remotePath, entry.name));
    }
  };

  const refreshFiles = () => {
    setFilesRefreshToken((currentToken) => currentToken + 1);
  };

  const createDirectory = async () => {
    const directoryName = window.prompt('请输入要在当前目录下创建的目录名。');

    if (directoryName === null) {
      return;
    }

    const nextName = directoryName.trim();

    if (!nextName || nextName.includes('/') || nextName.includes('\\') || nextName.includes('\0')) {
      setFilesError('目录名无效。');
      return;
    }

    try {
      setFilesError('');
      await window.guiSSH?.connections.createDirectory(connectionId, joinRemotePath(remotePath, nextName));
      refreshFiles();
    } catch (error) {
      setFilesError(getErrorMessage(error));
    }
  };

  const deleteSelectedEntry = async () => {
    if (!selectedEntry) {
      return;
    }

    const remoteEntryPath = joinRemotePath(remotePath, selectedEntry.name);

    if (!window.confirm(`确认删除远程${selectedEntry.type === 'directory' ? '目录' : '文件'}「${remoteEntryPath}」？`)) {
      return;
    }

    try {
      setFilesError('');
      await window.guiSSH?.connections.deletePath(connectionId, remoteEntryPath, selectedEntry.type);
      refreshFiles();
    } catch (error) {
      setFilesError(getErrorMessage(error));
    }
  };

  return (
    <div className="file-pane explorer-pane">
      <div className="explorer-ribbon">
        <button type="button" onClick={() => navigateToPath(getParentRemotePath(remotePath))}>上级</button>
        <button type="button" onClick={refreshFiles}>刷新</button>
        <button type="button" onClick={createDirectory}>新建文件夹</button>
        <button type="button" onClick={deleteSelectedEntry} disabled={!selectedEntry}>删除</button>
      </div>

      <form className="explorer-addressbar" onSubmit={submitRemotePath}>
        <span>路径</span>
        <input value={pathDraft} onChange={(event) => setPathDraft(event.target.value)} spellCheck={false} />
        <button type="submit">转到</button>
      </form>

      <div className="explorer-layout">
        <aside className="explorer-sidebar" aria-label="快速访问">
          <button type="button" className={remotePath === '.' ? 'active' : ''} onClick={() => navigateToPath('.')}>快速访问</button>
          <button type="button" className={remotePath === '/' ? 'active' : ''} onClick={() => navigateToPath('/')}>此电脑</button>
          <button type="button" onClick={() => navigateToPath('/home')}>Home</button>
          <button type="button" onClick={() => navigateToPath('/tmp')}>临时文件</button>
          <button type="button" onClick={() => navigateToPath('/var')}>系统目录</button>
        </aside>

        <section className="explorer-main" aria-label="远程文件列表">
          {filesError ? <div className="error-banner">{filesError}</div> : null}
          {isFilesLoading ? <div className="empty-inline">正在读取远程目录...</div> : null}

          <div className="explorer-table" role="table">
            <div className="explorer-row explorer-header" role="row">
              <span>名称</span>
              <span>修改日期</span>
              <span>类型</span>
              <span>大小</span>
            </div>
            {fileEntries.map((entry) => (
              <button
                key={`${entry.type}:${entry.name}`}
                type="button"
                className={`explorer-row ${selectedEntryName === entry.name ? 'selected' : ''}`}
                onClick={() => setSelectedEntryName(entry.name)}
                onDoubleClick={() => openFileEntry(entry)}
              >
                <span className="explorer-name-cell"><b>{getFileIcon(entry)}</b>{entry.name}</span>
                <span>{formatDateTime(entry.modifiedAt)}</span>
                <span>{getFileTypeLabel(entry)}</span>
                <span>{entry.type === 'directory' ? '' : formatBytes(entry.size)}</span>
              </button>
            ))}
          </div>

          {!isFilesLoading && !filesError && !fileEntries.length ? <div className="empty-inline">该目录为空。</div> : null}
        </section>
      </div>

      <div className="explorer-statusbar">
        <span>{fileEntries.length} 个项目</span>
        <span>{selectedEntry ? `已选择：${selectedEntry.name}` : '未选择项目'}</span>
      </div>
    </div>
  );
}

function RemoteMonitor({ connectionId }: { connectionId: string }) {
  const [statusReport, setStatusReport] = useState<RemoteStatusReport | null>(null);
  const [statusError, setStatusError] = useState('');
  const [isStatusLoading, setIsStatusLoading] = useState(false);
  const isRefreshingStatusRef = useRef(false);

  const refreshStatus = async () => {
    if (!window.guiSSH?.connections) {
      setStatusError('当前运行环境不支持资源监视。');
      return;
    }

    if (isRefreshingStatusRef.current) {
      return;
    }

    isRefreshingStatusRef.current = true;
    setIsStatusLoading(true);
    setStatusError('');

    try {
      const report: RemoteStatusReport = await window.guiSSH.connections.getStatus(connectionId);
      setStatusReport(report);
    } catch (error) {
      setStatusReport(null);
      setStatusError(getErrorMessage(error));
    } finally {
      isRefreshingStatusRef.current = false;
      setIsStatusLoading(false);
    }
  };

  useEffect(() => {
    void refreshStatus();
    const refreshTimer = window.setInterval(() => {
      void refreshStatus();
    }, 8000);

    return () => window.clearInterval(refreshTimer);
  }, [connectionId]);

  return (
    <div className="monitor-pane">
      <div className="monitor-toolbar">
        <span>{statusReport ? `刷新于 ${formatDateTime(statusReport.refreshedAt)}` : '尚未读取状态'}</span>
        <button type="button" className="command-button" onClick={refreshStatus} disabled={isStatusLoading}>
          {isStatusLoading ? '刷新中...' : '刷新'}
        </button>
      </div>
      {statusError ? <div className="error-banner">{statusError}</div> : null}
      <div className="status-grid">
        {statusReport?.items.map((item) => (
          <article key={item.key} className="status-card">
            <strong>{item.label}</strong>
            <pre>{item.value}</pre>
          </article>
        ))}
      </div>
    </div>
  );
}

function RemoteDesktopShell({ connection, onDisconnect }: RemoteDesktopProps) {
  const desktopSurfaceRef = useRef<HTMLElement | null>(null);
  const windowPointerStateRef = useRef<DesktopWindowPointerState | null>(null);
  const windowSequenceRef = useRef(1);
  const zIndexRef = useRef(1);
  const [desktopWindows, setDesktopWindows] = useState<DesktopWindowState[]>(() => [createDesktopWindow('terminal', 1, 1)]);
  const [focusedWindowId, setFocusedWindowId] = useState('terminal-1');
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

  const renderWindowContent = (desktopWindow: DesktopWindowState) => {
    if (desktopWindow.appKey === 'terminal') {
      return <RemoteTerminal connectionId={connection.id} terminalId={desktopWindow.terminalId ?? desktopWindow.id} />;
    }

    if (desktopWindow.appKey === 'browser') {
      return <RemoteBrowser connection={connection} />;
    }

    if (desktopWindow.appKey === 'files') {
      return <RemoteFileExplorer connectionId={connection.id} />;
    }

    return <RemoteMonitor connectionId={connection.id} />;
  };

  return (
    <main className="remote-desktop-page">
      <div className="remote-menubar drag-region">
        <div className="remote-menu-left">
          <strong>GUI-SSH Desktop</strong>
          <span>{connection.host.username}@{connection.host.address}:{connection.host.port}</span>
        </div>
        <div className="remote-menu-right no-drag">
          <span>SOCKS :{connection.proxyPort}</span>
          <button type="button" onClick={onDisconnect}>断开连接</button>
        </div>
      </div>

      <section ref={desktopSurfaceRef} className="remote-desktop-surface no-drag">
        <div className="desktop-summary-card hide-after" onAnimationEnd={(event) => event.currentTarget.style.display = 'none'}>
          <span>已连接</span>
          <strong>{connection.host.name}</strong>
          <small>连接时间 {formatDateTime(connection.connectedAt)}</small>
        </div>

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
                <div className="traffic-lights" aria-label="窗口控制" onPointerDown={(event) => event.stopPropagation()}>
                  <button type="button" className="red" aria-label="关闭窗口" title="关闭" onClick={() => closeDesktopWindow(desktopWindow.id)} />
                  <span className="yellow" aria-hidden="true" />
                  <button
                    type="button"
                    className="green"
                    aria-label={desktopWindow.isMaximized ? '还原窗口' : '最大化窗口'}
                    title={desktopWindow.isMaximized ? '还原' : '最大化'}
                    onClick={() => toggleWindowMaximize(desktopWindow.id)}
                  />
                </div>
                <div className="desktop-window-title">
                  <strong>{appInfo.label}</strong>
                  <small>{appInfo.description}</small>
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
          {desktopApps.map((app) => (
            <button
              key={app.key}
              type="button"
              className={focusedWindow?.appKey === app.key ? 'active' : ''}
              onClick={() => openDesktopWindow(app.key)}
              title={app.label}
            >
              {app.icon}
            </button>
          ))}
        </nav>
      </section>
    </main>
  );
}

export default RemoteDesktopShell;
