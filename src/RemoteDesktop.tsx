import { type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';

import RemoteDesktopShell from './RemoteDesktopShell';

const desktopApps = [
  { key: 'terminal', label: '终端', icon: '>_', description: 'SSH Shell' },
  { key: 'browser', label: '浏览器', icon: '◎', description: '远程源请求' },
  { key: 'files', label: '文件管理器', icon: '📁', description: 'SFTP 浏览' },
  { key: 'monitor', label: '资源监视器', icon: '▱', description: '服务器状态' },
] as const;

type DesktopAppKey = (typeof desktopApps)[number]['key'];

const desktopShortcuts: ReadonlyArray<{
  key: string;
  label: string;
  icon: string;
  appKey?: DesktopAppKey;
}> = [
  { key: 'computer', label: '此电脑', icon: '🖥️', appKey: 'files' },
  { key: 'database', label: '数据库', icon: '🗄️', appKey: 'browser' },
  { key: 'terminal', label: '终端', icon: '>_', appKey: 'terminal' },
  { key: 'auth', label: '授权应用', icon: '🔐', appKey: 'browser' },
  { key: 'trash', label: '回收站', icon: '🗑️', appKey: 'files' },
  { key: 'tools', label: '实用工具', icon: '🧰', appKey: 'monitor' },
  { key: 'files', label: '文件', icon: '📁', appKey: 'files' },
  { key: 'settings', label: '设置', icon: '⚙️', appKey: 'monitor' },
  { key: 'tasks', label: '任务管理器', icon: '📈', appKey: 'monitor' },
  { key: 'apps', label: '应用中心', icon: '◇', appKey: 'browser' },
  { key: 'site', label: '网站搭建', icon: '🌐', appKey: 'browser' },
];

interface DesktopWindowFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

type DesktopWindowInteractionMode = 'move' | 'resize';

interface DesktopWindowPointerState {
  pointerId: number;
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
const defaultWindowFrame: DesktopWindowFrame = {
  x: 174,
  y: 66,
  width: 860,
  height: 560,
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

export interface RemoteConnectionInfo {
  id: string;
  partition: string;
  proxyPort: number;
  connectedAt: string;
  host: {
    name: string;
    address: string;
    port: number;
    username: string;
    authMethod: 'password' | 'key';
  };
}

interface TerminalPayload {
  connectionId: string;
  data: string;
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

interface RemoteDesktopProps {
  connection: RemoteConnectionInfo;
  onDisconnect: () => void;
}

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

function stripAnsi(value: string) {
  return value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, '');
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

function RemoteDesktop({ connection, onDisconnect }: RemoteDesktopProps) {
  const [activeApp, setActiveApp] = useState<DesktopAppKey>('terminal');
  const [terminalOutput, setTerminalOutput] = useState('正在启动 SSH 终端...\n');
  const [terminalInput, setTerminalInput] = useState('');
  const [browserAddress, setBrowserAddress] = useState('http://127.0.0.1');
  const [browserSrc, setBrowserSrc] = useState('http://127.0.0.1');
  const [remotePath, setRemotePath] = useState('.');
  const [pathDraft, setPathDraft] = useState('.');
  const [fileEntries, setFileEntries] = useState<RemoteFileEntry[]>([]);
  const [filesError, setFilesError] = useState('');
  const [isFilesLoading, setIsFilesLoading] = useState(false);
  const [filesRefreshToken, setFilesRefreshToken] = useState(0);
  const [statusReport, setStatusReport] = useState<RemoteStatusReport | null>(null);
  const [statusError, setStatusError] = useState('');
  const [isStatusLoading, setIsStatusLoading] = useState(false);
  const terminalOutputRef = useRef<HTMLPreElement | null>(null);
  const browserViewRef = useRef<HTMLElement | null>(null);
  const desktopSurfaceRef = useRef<HTMLElement | null>(null);
  const isRefreshingStatusRef = useRef(false);
  const windowPointerStateRef = useRef<DesktopWindowPointerState | null>(null);
  const [windowFrame, setWindowFrame] = useState(defaultWindowFrame);
  const activeDesktopApp = desktopApps.find((app) => app.key === activeApp) ?? desktopApps[0];
  const desktopWindowStyle: CSSProperties = {
    width: windowFrame.width,
    height: windowFrame.height,
    transform: `translate3d(${windowFrame.x}px, ${windowFrame.y}px, 0)`,
  };

  const appendTerminalOutput = (value: string) => {
    setTerminalOutput((currentOutput) => `${currentOutput}${value}`.slice(-60000));
  };

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
      setWindowFrame((currentFrame) => clampWindowFrame(currentFrame, width, height));
    });

    resizeObserver.observe(surface);

    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    if (!window.guiSSH?.connections || !window.guiSSH.events) {
      appendTerminalOutput('当前运行环境不支持 SSH 终端。\n');
      return;
    }

    let disposed = false;
    const removeTerminalData = window.guiSSH.events.onTerminalData((payload: TerminalPayload) => {
      if (payload.connectionId === connection.id) {
        appendTerminalOutput(stripAnsi(payload.data));
      }
    });
    const removeTerminalExit = window.guiSSH.events.onTerminalExit((payload: { connectionId: string }) => {
      if (payload.connectionId === connection.id) {
        appendTerminalOutput('\n终端会话已结束。\n');
      }
    });

    window.guiSSH.connections
      .startTerminal(connection.id, 'legacy-terminal', 100, 30)
      .then(() => {
        if (!disposed) {
          appendTerminalOutput('终端已连接。\n');
        }
      })
      .catch((error: unknown) => {
        if (!disposed) {
          appendTerminalOutput(`终端启动失败：${getErrorMessage(error)}\n`);
        }
      });

    return () => {
      disposed = true;
      removeTerminalData();
      removeTerminalExit();
    };
  }, [connection.id]);

  useEffect(() => {
    if (terminalOutputRef.current) {
      terminalOutputRef.current.scrollTop = terminalOutputRef.current.scrollHeight;
    }
  }, [terminalOutput]);

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

      try {
        const result: RemoteDirectoryResult = await window.guiSSH!.connections.listDirectory(connection.id, remotePath);

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
  }, [connection.id, filesRefreshToken, remotePath]);

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
      const report: RemoteStatusReport = await window.guiSSH.connections.getStatus(connection.id);
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
    if (activeApp !== 'monitor') {
      return;
    }

    void refreshStatus();
    const refreshTimer = window.setInterval(() => {
      void refreshStatus();
    }, 8000);

    return () => window.clearInterval(refreshTimer);
  }, [activeApp, connection.id]);

  const submitTerminalInput = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!window.guiSSH?.connections) {
      appendTerminalOutput('当前运行环境不支持 SSH 终端。\n');
      return;
    }

    const command = terminalInput;
    setTerminalInput('');

    window.guiSSH.connections.writeTerminal(connection.id, 'legacy-terminal', `${command}\n`).catch((error: unknown) => {
      appendTerminalOutput(`\n发送失败：${getErrorMessage(error)}\n`);
    });
  };

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

  const submitRemotePath = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setRemotePath(pathDraft.trim() || '.');
  };

  const openFileEntry = (entry: RemoteFileEntry) => {
    if (entry.type === 'directory') {
      setRemotePath(joinRemotePath(remotePath, entry.name));
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
      await window.guiSSH?.connections.createDirectory(connection.id, joinRemotePath(remotePath, nextName));
      refreshFiles();
    } catch (error) {
      setFilesError(getErrorMessage(error));
    }
  };

  const deleteFileEntry = async (entry: RemoteFileEntry) => {
    const remoteEntryPath = joinRemotePath(remotePath, entry.name);

    if (!window.confirm(`确认删除远程${entry.type === 'directory' ? '目录' : '文件'}「${remoteEntryPath}」？`)) {
      return;
    }

    try {
      setFilesError('');
      await window.guiSSH?.connections.deletePath(connection.id, remoteEntryPath, entry.type);
      refreshFiles();
    } catch (error) {
      setFilesError(getErrorMessage(error));
    }
  };

  const activateDesktopShortcut = (appKey?: DesktopAppKey) => {
    if (appKey) {
      setActiveApp(appKey);
    }
  };

  const startWindowInteraction = (event: ReactPointerEvent<HTMLElement>, mode: DesktopWindowInteractionMode) => {
    if (event.button !== 0) {
      return;
    }

    const surface = desktopSurfaceRef.current;

    if (!surface) {
      return;
    }

    const surfaceRect = surface.getBoundingClientRect();
    const startFrame = clampWindowFrame(windowFrame, surfaceRect.width, surfaceRect.height);

    windowPointerStateRef.current = {
      pointerId: event.pointerId,
      mode,
      originX: event.clientX,
      originY: event.clientY,
      startFrame,
      surfaceWidth: surfaceRect.width,
      surfaceHeight: surfaceRect.height,
    };

    setWindowFrame(startFrame);
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

    setWindowFrame(clampWindowFrame(nextFrame, pointerState.surfaceWidth, pointerState.surfaceHeight));
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

  const renderActiveApp = () => {
    if (activeApp === 'terminal') {
      return (
        <div className="terminal-pane">
          <pre ref={terminalOutputRef} className="terminal-output">{terminalOutput}</pre>
          <form className="terminal-input-row" onSubmit={submitTerminalInput}>
            <span>$</span>
            <input
              value={terminalInput}
              onChange={(event) => setTerminalInput(event.target.value)}
              placeholder="输入命令，按 Enter 发送"
              autoCapitalize="off"
              spellCheck={false}
            />
          </form>
        </div>
      );
    }

    if (activeApp === 'browser') {
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

    if (activeApp === 'files') {
      return (
        <div className="file-pane">
          <form className="file-toolbar" onSubmit={submitRemotePath}>
            <button type="button" onClick={() => setRemotePath(getParentRemotePath(remotePath))}>上级</button>
            <input value={pathDraft} onChange={(event) => setPathDraft(event.target.value)} spellCheck={false} />
            <button type="submit">前往</button>
            <button type="button" onClick={refreshFiles}>刷新</button>
            <button type="button" onClick={createDirectory}>新建目录</button>
          </form>

          {filesError ? <div className="error-banner">{filesError}</div> : null}
          {isFilesLoading ? <div className="empty-inline">正在读取远程目录...</div> : null}

          <div className="file-list" role="table" aria-label="远程文件列表">
            <div className="file-row header" role="row">
              <span>名称</span>
              <span>类型</span>
              <span>大小</span>
              <span>修改时间</span>
              <span>操作</span>
            </div>
            {fileEntries.map((entry) => (
              <div
                key={`${entry.type}:${entry.name}`}
                className={`file-row ${entry.type}`}
                onDoubleClick={() => openFileEntry(entry)}
              >
                <button
                  type="button"
                  className="file-name-button"
                  onClick={() => entry.type === 'directory' && setPathDraft(joinRemotePath(remotePath, entry.name))}
                >
                  {entry.type === 'directory' ? 'DIR' : entry.type === 'symlink' ? 'LNK' : 'FILE'} {entry.name}
                </button>
                <span>{entry.type === 'directory' ? '目录' : entry.type === 'symlink' ? '链接' : '文件'}</span>
                <span>{entry.type === 'directory' ? '-' : formatBytes(entry.size)}</span>
                <span>{formatDateTime(entry.modifiedAt)}</span>
                <button type="button" className="file-action-button" onClick={() => deleteFileEntry(entry)}>删除</button>
              </div>
            ))}
          </div>

          {!isFilesLoading && !filesError && !fileEntries.length ? <div className="empty-inline">该目录为空。</div> : null}
        </div>
      );
    }

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
          {desktopShortcuts.map((shortcut) => (
            <button
              key={shortcut.key}
              type="button"
              className={shortcut.appKey === activeApp ? 'active' : ''}
              onClick={() => activateDesktopShortcut(shortcut.appKey)}
            >
              <span>{shortcut.icon}</span>
              <strong>{shortcut.label}</strong>
            </button>
          ))}
        </div>

        <section className="desktop-window" aria-label={activeDesktopApp.label} style={desktopWindowStyle}>
          <header
            className="desktop-window-titlebar"
            onPointerDown={(event) => startWindowInteraction(event, 'move')}
            onPointerMove={updateWindowInteraction}
            onPointerUp={finishWindowInteraction}
            onPointerCancel={finishWindowInteraction}
          >
            <div className="traffic-lights" aria-hidden="true">
              <span className="red" />
              <span className="yellow" />
              <span className="green" />
            </div>
            <div>
              <strong>{activeDesktopApp.label}</strong>
              <small>{activeDesktopApp.description}</small>
            </div>
          </header>
          <div className="desktop-window-body">{renderActiveApp()}</div>
          <div
            className="desktop-window-resize-handle"
            onPointerDown={(event) => startWindowInteraction(event, 'resize')}
            onPointerMove={updateWindowInteraction}
            onPointerUp={finishWindowInteraction}
            onPointerCancel={finishWindowInteraction}
            aria-hidden="true"
          />
        </section>

        <nav className="mac-dock" aria-label="远程桌面 Dock">
          {desktopApps.map((app) => (
            <button
              key={app.key}
              type="button"
              className={activeApp === app.key ? 'active' : ''}
              onClick={() => setActiveApp(app.key)}
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
