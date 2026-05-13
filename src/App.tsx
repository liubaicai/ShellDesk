import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';

const hostsStorageKey = 'gui-ssh:hosts';
const ungroupedKey = '__ungrouped__';

const navigationItems = [
  { key: 'H', label: '主机', active: true },
  { key: 'K', label: '钥匙串' },
  { key: 'P', label: '代理' },
  { key: 'F', label: '端口转发' },
  { key: 'C', label: '代码片段' },
  { key: 'N', label: '已知主机' },
  { key: 'L', label: '日志' },
];

const plannedFeatures = ['SFTP', '终端', '串口', '密钥', '代理'];

const desktopApps = [
  { key: 'terminal', label: '终端', icon: '⌘', description: 'SSH Shell' },
  { key: 'browser', label: '浏览器', icon: '◎', description: '远程源请求' },
  { key: 'files', label: '文件管理器', icon: '▣', description: 'SFTP 浏览' },
  { key: 'monitor', label: '资源监视器', icon: '◌', description: '服务器状态' },
] as const;

interface Host {
  id: string;
  name: string;
  address: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  password: string;
  keyPath: string;
  passphrase: string;
  group: string;
  tags: string[];
  note: string;
  createdAt: string;
  updatedAt: string;
}

type StoredHost = Omit<Host, 'authMethod' | 'password' | 'keyPath' | 'passphrase'> &
  Partial<Pick<Host, 'authMethod' | 'password' | 'keyPath' | 'passphrase'>>;

interface HostFormState {
  name: string;
  address: string;
  port: string;
  username: string;
  authMethod: AuthMethod;
  password: string;
  keyPath: string;
  passphrase: string;
  group: string;
  tags: string;
  note: string;
}

interface HostGroup {
  key: string;
  name: string;
  count: number;
}

type ViewMode = 'grid' | 'list';
type AuthMethod = 'password' | 'key';
type DesktopAppKey = (typeof desktopApps)[number]['key'];

interface RemoteConnectionInfo {
  id: string;
  partition: string;
  proxyPort: number;
  connectedAt: string;
  host: Pick<Host, 'name' | 'address' | 'port' | 'username' | 'authMethod'>;
}

interface TerminalPayload {
  connectionId: string;
  data: string;
}

interface ConnectionClosedPayload {
  connectionId: string;
  reason?: string;
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

interface CredentialFormState {
  password: string;
  passphrase: string;
  saveCredential: boolean;
}

const emptyHostForm: HostFormState = {
  name: '',
  address: '',
  port: '22',
  username: '',
  authMethod: 'password',
  password: '',
  keyPath: '',
  passphrase: '',
  group: '',
  tags: '',
  note: '',
};

const emptyCredentialForm: CredentialFormState = {
  password: '',
  passphrase: '',
  saveCredential: true,
};

function createId() {
  if ('randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
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

function isAuthFailureMessage(message: string) {
  return /认证失败|authentication methods failed|password|private key|passphrase|密钥|口令/i.test(message);
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

function parseTags(value: string) {
  return value
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function formatTags(tags: string[]) {
  return tags.join(', ');
}

function getAuthMethod(value: unknown): AuthMethod {
  return value === 'key' ? 'key' : 'password';
}

function getAuthLabel(host: Pick<Host, 'authMethod' | 'password' | 'keyPath' | 'passphrase'>) {
  if (host.authMethod === 'key') {
    if (!host.keyPath) {
      return '密钥登录';
    }

    return host.passphrase ? `密钥 · ${host.keyPath} · 口令已保存` : `密钥 · ${host.keyPath}`;
  }

  return host.password ? '密码登录 · 已保存' : '密码登录';
}

function getAuthBadgeLabel(host: Pick<Host, 'authMethod' | 'password'>) {
  if (host.authMethod === 'key') {
    return '密钥';
  }

  return host.password ? '密码已保存' : '密码';
}

function isStoredHost(value: unknown): value is StoredHost {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const host = value as Partial<StoredHost>;
  return (
    typeof host.id === 'string' &&
    typeof host.name === 'string' &&
    typeof host.address === 'string' &&
    typeof host.port === 'number' &&
    Number.isInteger(host.port) &&
    typeof host.username === 'string' &&
    typeof host.group === 'string' &&
    Array.isArray(host.tags) &&
    host.tags.every((tag) => typeof tag === 'string') &&
    typeof host.note === 'string' &&
    typeof host.createdAt === 'string' &&
    typeof host.updatedAt === 'string'
  );
}

function normalizeStoredHost(host: StoredHost): Host {
  return {
    ...host,
    authMethod: getAuthMethod(host.authMethod),
    password: typeof host.password === 'string' ? host.password : '',
    keyPath: typeof host.keyPath === 'string' ? host.keyPath : '',
    passphrase: typeof host.passphrase === 'string' ? host.passphrase : '',
  };
}

function readStoredHosts(): Host[] {
  try {
    const rawHosts = window.localStorage.getItem(hostsStorageKey);

    if (!rawHosts) {
      return [];
    }

    const parsedHosts: unknown = JSON.parse(rawHosts);

    if (!Array.isArray(parsedHosts)) {
      return [];
    }

    return parsedHosts.filter(isStoredHost).map(normalizeStoredHost);
  } catch {
    return [];
  }
}

function validateHostForm(form: HostFormState) {
  const port = Number(form.port);

  if (!form.name.trim()) {
    return '请输入主机名称。';
  }

  if (!form.address.trim()) {
    return '请输入主机地址。';
  }

  if (!form.username.trim()) {
    return '请输入用户名。';
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return '端口必须是 1 到 65535 之间的整数。';
  }

  if (form.name.trim().length > 80) {
    return '主机名称不能超过 80 个字符。';
  }

  if (form.address.trim().length > 255) {
    return '主机地址不能超过 255 个字符。';
  }

  if (form.username.trim().length > 128) {
    return '用户名不能超过 128 个字符。';
  }

  if (form.authMethod === 'key' && !form.keyPath.trim()) {
    return '选择密钥登录时需要选择私钥文件。';
  }

  if (form.password.length > 4096) {
    return '密码长度不能超过 4096 个字符。';
  }

  if (form.keyPath.length > 1024) {
    return '密钥路径不能超过 1024 个字符。';
  }

  if (form.passphrase.length > 4096) {
    return '密钥口令长度不能超过 4096 个字符。';
  }

  return '';
}

function createHostFromForm(form: HostFormState): Host {
  const now = new Date().toISOString();

  return {
    id: createId(),
    name: form.name.trim(),
    address: form.address.trim(),
    port: Number(form.port),
    username: form.username.trim(),
    authMethod: form.authMethod,
    password: form.authMethod === 'password' ? form.password : '',
    keyPath: form.authMethod === 'key' ? form.keyPath.trim() : '',
    passphrase: form.authMethod === 'key' ? form.passphrase : '',
    group: form.group.trim(),
    tags: parseTags(form.tags),
    note: form.note.trim(),
    createdAt: now,
    updatedAt: now,
  };
}

function updateHostFromForm(host: Host, form: HostFormState): Host {
  return {
    ...host,
    name: form.name.trim(),
    address: form.address.trim(),
    port: Number(form.port),
    username: form.username.trim(),
    authMethod: form.authMethod,
    password: form.authMethod === 'password' ? form.password : '',
    keyPath: form.authMethod === 'key' ? form.keyPath.trim() : '',
    passphrase: form.authMethod === 'key' ? form.passphrase : '',
    group: form.group.trim(),
    tags: parseTags(form.tags),
    note: form.note.trim(),
    updatedAt: new Date().toISOString(),
  };
}

function toFormState(host: Host): HostFormState {
  return {
    name: host.name,
    address: host.address,
    port: String(host.port),
    username: host.username,
    authMethod: host.authMethod,
    password: host.password,
    keyPath: host.keyPath,
    passphrase: host.passphrase,
    group: host.group,
    tags: formatTags(host.tags),
    note: host.note,
  };
}

function getHostGroupKey(host: Host) {
  return host.group || ungroupedKey;
}

interface RemoteDesktopProps {
  connection: RemoteConnectionInfo;
  onDisconnect: () => void;
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
  const isRefreshingStatusRef = useRef(false);
  const activeDesktopApp = desktopApps.find((app) => app.key === activeApp) ?? desktopApps[0];

  const appendTerminalOutput = (value: string) => {
    setTerminalOutput((currentOutput) => `${currentOutput}${value}`.slice(-60000));
  };

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
      .startTerminal(connection.id)
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

    window.guiSSH.connections.writeTerminal(connection.id, `${command}\n`).catch((error: unknown) => {
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

      <section className="remote-desktop-surface no-drag">
        <div className="desktop-summary-card">
          <span>已连接</span>
          <strong>{connection.host.name}</strong>
          <small>连接时间 {formatDateTime(connection.connectedAt)}</small>
        </div>

        <div className="desktop-icons" aria-label="桌面应用">
          {desktopApps.map((app) => (
            <button
              key={app.key}
              type="button"
              className={activeApp === app.key ? 'active' : ''}
              onClick={() => setActiveApp(app.key)}
            >
              <span>{app.icon}</span>
              <strong>{app.label}</strong>
            </button>
          ))}
        </div>

        <section className="desktop-window" aria-label={activeDesktopApp.label}>
          <header className="desktop-window-titlebar">
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

function App() {
  const [hosts, setHosts] = useState<Host[]>(readStoredHosts);
  const [form, setForm] = useState<HostFormState>(emptyHostForm);
  const [editingHostId, setEditingHostId] = useState<string | null>(null);
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeGroupKey, setActiveGroupKey] = useState<string | null>(null);
  const [formError, setFormError] = useState('');
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [statusMessage, setStatusMessage] = useState('');
  const [connection, setConnection] = useState<RemoteConnectionInfo | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [credentialHostId, setCredentialHostId] = useState<string | null>(null);
  const [credentialForm, setCredentialForm] = useState<CredentialFormState>(emptyCredentialForm);
  const [credentialError, setCredentialError] = useState('');
  const platform = window.guiSSH?.platform;
  const windowControls = window.guiSSH?.window;
  const showWindowControls = Boolean(windowControls) && platform !== 'darwin';
  const editingHost = hosts.find((host) => host.id === editingHostId) ?? null;
  const selectedHost = hosts.find((host) => host.id === selectedHostId) ?? hosts[0] ?? null;
  const credentialHost = hosts.find((host) => host.id === credentialHostId) ?? null;

  const hostGroups = useMemo<HostGroup[]>(() => {
    const groups = new Map<string, HostGroup>();

    for (const host of hosts) {
      const key = getHostGroupKey(host);
      const name = host.group || '未分组';
      const currentGroup = groups.get(key);

      groups.set(key, {
        key,
        name,
        count: (currentGroup?.count ?? 0) + 1,
      });
    }

    return Array.from(groups.values()).sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
  }, [hosts]);

  const filteredHosts = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    return hosts.filter((host) => {
      const matchesGroup = !activeGroupKey || getHostGroupKey(host) === activeGroupKey;
      const matchesQuery =
        !query ||
        [host.name, host.address, host.username, host.group, host.note, host.keyPath, getAuthLabel(host), ...host.tags]
          .join(' ')
          .toLowerCase()
          .includes(query);

      return matchesGroup && matchesQuery;
    });
  }, [activeGroupKey, hosts, searchQuery]);

  const activeGroupName = hostGroups.find((group) => group.key === activeGroupKey)?.name;

  useEffect(() => {
    window.localStorage.setItem(hostsStorageKey, JSON.stringify(hosts));
  }, [hosts]);

  useEffect(() => {
    if (selectedHostId && hosts.some((host) => host.id === selectedHostId)) {
      return;
    }

    setSelectedHostId(hosts[0]?.id ?? null);
  }, [hosts, selectedHostId]);

  useEffect(() => {
    if (!connection || !window.guiSSH?.events) {
      return;
    }

    return window.guiSSH.events.onConnectionClosed((payload: ConnectionClosedPayload) => {
      if (payload.connectionId === connection.id) {
        setConnection(null);
        setStatusMessage(payload.reason || 'SSH 连接已断开。');
      }
    });
  }, [connection]);

  const minimizeWindow = () => {
    void windowControls?.minimize();
  };

  const toggleMaximizeWindow = () => {
    void windowControls?.toggleMaximize();
  };

  const closeWindow = () => {
    void windowControls?.close();
  };

  const resetForm = () => {
    setForm(emptyHostForm);
    setEditingHostId(null);
    setFormError('');
  };

  const openCreateHost = () => {
    resetForm();
    setIsEditorOpen(true);
  };

  const closeEditor = () => {
    resetForm();
    setIsEditorOpen(false);
  };

  const updateFormField = <Field extends keyof HostFormState>(field: Field, value: HostFormState[Field]) => {
    setForm((currentForm) => ({ ...currentForm, [field]: value }));
    setFormError('');
  };

  const selectPrivateKeyFile = async () => {
    const filePath = await window.guiSSH?.files.selectPrivateKeyFile();

    if (!filePath) {
      return;
    }

    updateFormField('authMethod', 'key');
    updateFormField('keyPath', filePath);
  };

  const updateCredentialField = <Field extends keyof CredentialFormState>(
    field: Field,
    value: CredentialFormState[Field],
  ) => {
    setCredentialForm((currentForm) => ({ ...currentForm, [field]: value }));
    setCredentialError('');
  };

  const openCredentialDialog = (host: Host, message = '') => {
    setCredentialHostId(host.id);
    setCredentialForm({
      password: host.password,
      passphrase: host.passphrase,
      saveCredential: true,
    });
    setCredentialError(message);
  };

  const closeCredentialDialog = () => {
    setCredentialHostId(null);
    setCredentialForm(emptyCredentialForm);
    setCredentialError('');
  };

  const submitHost = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const validationError = validateHostForm(form);

    if (validationError) {
      setFormError(validationError);
      return;
    }

    if (editingHost) {
      const updatedHost = updateHostFromForm(editingHost, form);
      setHosts((currentHosts) => currentHosts.map((host) => (host.id === editingHost.id ? updatedHost : host)));
      setSelectedHostId(updatedHost.id);
      setStatusMessage(`已更新主机：${updatedHost.name}`);
    } else {
      const nextHost = createHostFromForm(form);
      setHosts((currentHosts) => [nextHost, ...currentHosts]);
      setSelectedHostId(nextHost.id);
      setStatusMessage(`已添加主机：${nextHost.name}`);
    }

    closeEditor();
  };

  const startEditingHost = (host: Host) => {
    setEditingHostId(host.id);
    setSelectedHostId(host.id);
    setForm(toFormState(host));
    setFormError('');
    setIsEditorOpen(true);
  };

  const deleteHost = (host: Host) => {
    if (!window.confirm(`确认删除主机「${host.name}」？`)) {
      return;
    }

    const nextHosts = hosts.filter((currentHost) => currentHost.id !== host.id);
    setHosts(nextHosts);
    setStatusMessage(`已删除主机：${host.name}`);

    if (selectedHostId === host.id) {
      setSelectedHostId(nextHosts[0]?.id ?? null);
    }

    if (editingHostId === host.id) {
      closeEditor();
    }
  };

  const connectHost = async (host: Host, credentials?: CredentialFormState) => {
    if (!window.guiSSH?.connections) {
      setStatusMessage('当前运行环境不支持 SSH 连接。');
      return false;
    }

    const hostForConnection: Host = credentials
      ? {
          ...host,
          password: host.authMethod === 'password' ? credentials.password : host.password,
          passphrase: host.authMethod === 'key' ? credentials.passphrase : host.passphrase,
        }
      : host;

    setIsConnecting(true);
    setStatusMessage(`正在连接 ${host.name}...`);

    try {
      const nextConnection = await window.guiSSH.connections.connect(hostForConnection);

      if (credentials?.saveCredential) {
        setHosts((currentHosts) =>
          currentHosts.map((currentHost) =>
            currentHost.id === host.id
              ? {
                  ...currentHost,
                  password: host.authMethod === 'password' ? credentials.password : currentHost.password,
                  passphrase: host.authMethod === 'key' ? credentials.passphrase : currentHost.passphrase,
                  updatedAt: new Date().toISOString(),
                }
              : currentHost,
          ),
        );
      }

      setConnection({ ...nextConnection, host: nextConnection.host ?? hostForConnection });
      setStatusMessage(`已连接：${host.name}`);
      closeCredentialDialog();
      return true;
    } catch (error) {
      const message = getErrorMessage(error);
      setStatusMessage(`连接失败：${message}`);

      if (isAuthFailureMessage(message)) {
        openCredentialDialog(hostForConnection, message);
      }

      return false;
    } finally {
      setIsConnecting(false);
    }
  };

  const connectSelectedHost = async () => {
    if (!selectedHost) {
      setStatusMessage('请先选择一台主机。');
      return;
    }

    if (selectedHost.authMethod === 'password' && !selectedHost.password) {
      openCredentialDialog(selectedHost, '请输入该主机的 SSH 密码后连接。');
      return;
    }

    await connectHost(selectedHost);
  };

  const submitCredentialConnection = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!credentialHost) {
      return;
    }

    if (credentialHost.authMethod === 'password' && !credentialForm.password) {
      setCredentialError('请输入 SSH 密码。');
      return;
    }

    await connectHost(credentialHost, credentialForm);
  };

  const disconnectCurrentHost = async () => {
    if (!connection) {
      return;
    }

    const closedConnection = connection;
    setConnection(null);
    setStatusMessage(`正在断开 ${closedConnection.host.name}...`);

    try {
      await window.guiSSH?.connections.disconnect(closedConnection.id);
      setStatusMessage(`已断开：${closedConnection.host.name}`);
    } catch (error) {
      setStatusMessage(`断开连接失败：${getErrorMessage(error)}`);
    }
  };

  const clearFilters = () => {
    setActiveGroupKey(null);
    setSearchQuery('');
  };

  return (
    <div className="app-shell">
      <header className="top-chrome drag-region">
        <div className="workspace-tabs" aria-label="工作区标签">
          <button type="button" className="workspace-tab active">Vaults</button>
          <button type="button" className="workspace-tab">SFTP</button>
          <button type="button" className="workspace-tab add-tab" aria-label="新增工作区">+</button>
        </div>

        <div className="chrome-tools" aria-label="全局工具">
          <span>AI</span>
          <span>通知</span>
          <span>同步</span>
          <span>设置</span>
        </div>

        {showWindowControls ? (
          <div className="titlebar-controls no-drag">
            <button type="button" aria-label="最小化" onClick={minimizeWindow}>−</button>
            <button type="button" aria-label="最大化" onClick={toggleMaximizeWindow}>□</button>
            <button type="button" aria-label="关闭" className="danger" onClick={closeWindow}>×</button>
          </div>
        ) : null}
      </header>

      {connection ? (
        <RemoteDesktop connection={connection} onDisconnect={disconnectCurrentHost} />
      ) : (
      <div className="app-layout">
        <aside className="side-nav">
          <div className="brand-panel">
            <span className="brand-logo">GS</span>
            <strong>GUI-SSH</strong>
          </div>

          <nav className="feature-nav" aria-label="功能导航">
            {navigationItems.map((item) => (
              <button key={item.label} type="button" className={`feature-nav-item ${item.active ? 'active' : ''}`}>
                <span>{item.key}</span>
                {item.label}
              </button>
            ))}
          </nav>

          <button type="button" className="settings-entry">设置</button>
        </aside>

        <main className="vault-page">
          <div className="command-bar no-drag">
            <label className="global-search">
              <span>查找</span>
              <input
                type="search"
                placeholder="查找主机或 ssh user@hostname / ssh -p 2222 user@host"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
              />
            </label>

            <button type="button" className="command-button" onClick={connectSelectedHost} disabled={isConnecting}>
              {isConnecting ? '连接中...' : '连接'}
            </button>

            <div className="view-switch" aria-label="视图切换">
              <button type="button" className={viewMode === 'grid' ? 'active' : ''} onClick={() => setViewMode('grid')}>网格</button>
              <button type="button" className={viewMode === 'list' ? 'active' : ''} onClick={() => setViewMode('list')}>列表</button>
            </div>

            <button type="button" className="primary-action" onClick={openCreateHost}>+ 新建主机</button>
            <button type="button" className="command-button muted">终端</button>
            <button type="button" className="command-button muted">串口</button>
          </div>

          <section className="vault-content">
            <div className="content-filter-row">
              <button type="button" className={`filter-tab ${!activeGroupKey && !searchQuery ? 'active' : ''}`} onClick={clearFilters}>
                全部主机
              </button>
              <span>{activeGroupName ? `当前分组：${activeGroupName}` : `${hosts.length} 台主机`}</span>
            </div>

            {statusMessage ? <div className="status-banner">{statusMessage}</div> : null}

            <section className="vault-section">
              <div className="section-heading">
                <h2>分组</h2>
                <span>共 {hostGroups.length} 个</span>
              </div>

              {hostGroups.length ? (
                <div className="group-grid">
                  {hostGroups.map((group) => (
                    <button
                      key={group.key}
                      type="button"
                      className={`group-card ${activeGroupKey === group.key ? 'active' : ''}`}
                      onClick={() => setActiveGroupKey(group.key)}
                    >
                      <span className="group-icon">G</span>
                      <span>
                        <strong>{group.name}</strong>
                        <small>{group.count} 台主机</small>
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="empty-inline">添加主机后会自动生成分组。</div>
              )}
            </section>

            <section className="vault-section host-section">
              <div className="section-heading">
                <h2>主机</h2>
                <span>{filteredHosts.length} 条 <b>0 个在线</b></span>
              </div>

              {filteredHosts.length ? (
                <div className={`host-grid ${viewMode}`}>
                  {filteredHosts.map((host) => (
                    <article key={host.id} className={`host-card ${selectedHost?.id === host.id ? 'selected' : ''}`}>
                      <button type="button" className="host-card-main" onClick={() => setSelectedHostId(host.id)}>
                        <span className="host-avatar">S</span>
                        <span className="host-summary">
                          <strong>{host.name}</strong>
                          <small>{host.username ? `${host.username}@` : ''}{host.address}:{host.port}</small>
                          <span>{host.group || '未分组'} · {host.tags.length ? host.tags.join(' / ') : '无标签'}</span>
                          <em className={`auth-badge ${host.authMethod}`}>{getAuthBadgeLabel(host)}</em>
                        </span>
                      </button>
                      <div className="host-card-actions">
                        <button type="button" onClick={() => startEditingHost(host)}>编辑</button>
                        <button type="button" className="danger-text" onClick={() => deleteHost(host)}>删除</button>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="empty-state">
                  <span>EMPTY</span>
                  <h3>{hosts.length ? '没有匹配的主机' : '主机列表为空'}</h3>
                  <p>{hosts.length ? '清空搜索或切换分组后再试。' : '点击“新建主机”添加第一台 SSH 主机。'}</p>
                </div>
              )}
            </section>

            <section className="feature-plan">
              <div className="section-heading">
                <h2>后续功能区</h2>
                <span>布局预留</span>
              </div>
              <div className="plan-grid">
                {plannedFeatures.map((feature) => (
                  <div key={feature} className="plan-card">
                    <strong>{feature}</strong>
                    <span>待接入</span>
                  </div>
                ))}
              </div>
            </section>
          </section>

          {isEditorOpen ? (
            <aside className="editor-panel no-drag" aria-label={editingHost ? '编辑主机' : '新建主机'}>
              <div className="editor-header">
                <span>
                  <strong>{editingHost ? '编辑主机' : '新建主机'}</strong>
                  <small>{editingHost ? editingHost.name : '保存到本地 Vault'}</small>
                </span>
                <button type="button" onClick={closeEditor} aria-label="关闭表单">×</button>
              </div>

              <form className="host-form" onSubmit={submitHost}>
                <label className="field">
                  <span>主机名称</span>
                  <input
                    value={form.name}
                    maxLength={80}
                    onChange={(event) => updateFormField('name', event.target.value)}
                    placeholder="例如：Production Web"
                  />
                </label>

                <label className="field">
                  <span>地址</span>
                  <input
                    value={form.address}
                    maxLength={255}
                    onChange={(event) => updateFormField('address', event.target.value)}
                    placeholder="192.168.100.21 或 github.com"
                  />
                </label>

                <div className="editor-grid">
                  <label className="field">
                    <span>用户名</span>
                    <input
                      value={form.username}
                      onChange={(event) => updateFormField('username', event.target.value)}
                      placeholder="root"
                    />
                  </label>

                  <label className="field">
                    <span>端口</span>
                    <input
                      value={form.port}
                      inputMode="numeric"
                      onChange={(event) => updateFormField('port', event.target.value)}
                      placeholder="22"
                    />
                  </label>
                </div>

                <div className="auth-method-section">
                  <span className="field-label">登录方式</span>
                  <div className="auth-switch" role="group" aria-label="登录方式">
                    <button
                      type="button"
                      className={form.authMethod === 'password' ? 'active' : ''}
                      onClick={() => {
                        updateFormField('authMethod', 'password');
                        updateFormField('keyPath', '');
                        updateFormField('passphrase', '');
                      }}
                    >
                      <strong>密码登录</strong>
                      <small>保存密码到主机信息</small>
                    </button>
                    <button
                      type="button"
                      className={form.authMethod === 'key' ? 'active' : ''}
                      onClick={() => {
                        updateFormField('authMethod', 'key');
                        updateFormField('password', '');
                      }}
                    >
                      <strong>密钥登录</strong>
                      <small>选择私钥文件</small>
                    </button>
                  </div>
                </div>

                {form.authMethod === 'key' ? (
                  <>
                    <label className="field">
                      <span>私钥文件</span>
                      <div className="file-picker-row">
                        <input value={form.keyPath} readOnly placeholder="请选择 SSH 私钥文件" />
                        <button type="button" className="command-button" onClick={selectPrivateKeyFile}>
                          选择文件
                        </button>
                      </div>
                    </label>
                    <label className="field">
                      <span>密钥口令（可选）</span>
                      <input
                        type="password"
                        value={form.passphrase}
                        onChange={(event) => updateFormField('passphrase', event.target.value)}
                        placeholder="私钥加密时填写"
                      />
                    </label>
                  </>
                ) : (
                  <label className="field">
                    <span>密码</span>
                    <input
                      type="password"
                      value={form.password}
                      onChange={(event) => updateFormField('password', event.target.value)}
                      placeholder="输入并保存该主机密码"
                    />
                  </label>
                )}

                <label className="field">
                  <span>分组</span>
                  <input
                    value={form.group}
                    onChange={(event) => updateFormField('group', event.target.value)}
                    placeholder="AWS / Production / Lab"
                  />
                </label>

                <label className="field">
                  <span>标签</span>
                  <input
                    value={form.tags}
                    onChange={(event) => updateFormField('tags', event.target.value)}
                    placeholder="linux, prod, db"
                  />
                </label>

                <label className="field">
                  <span>备注</span>
                  <textarea
                    value={form.note}
                    onChange={(event) => updateFormField('note', event.target.value)}
                    placeholder="用途、跳板机、维护窗口等"
                    rows={4}
                  />
                </label>

                {formError ? <div className="error-banner">{formError}</div> : null}

                <div className="form-actions">
                  <button type="submit" className="primary-action">{editingHost ? '保存修改' : '添加主机'}</button>
                  <button type="button" className="command-button" onClick={resetForm}>清空</button>
                </div>
              </form>
            </aside>
          ) : null}

          {credentialHost ? (
            <aside className="credential-panel no-drag" aria-label="连接凭据">
              <div className="editor-header">
                <span>
                  <strong>连接凭据</strong>
                  <small>{credentialHost.username}@{credentialHost.address}:{credentialHost.port}</small>
                </span>
                <button type="button" onClick={closeCredentialDialog} aria-label="关闭连接凭据">×</button>
              </div>

              <form className="host-form" onSubmit={submitCredentialConnection}>
                {credentialHost.authMethod === 'password' ? (
                  <label className="field">
                    <span>SSH 密码</span>
                    <input
                      type="password"
                      value={credentialForm.password}
                      onChange={(event) => updateCredentialField('password', event.target.value)}
                      placeholder="输入该主机的 SSH 密码"
                      autoFocus
                    />
                  </label>
                ) : (
                  <>
                    <div className="credential-note">当前使用私钥登录：{credentialHost.keyPath}</div>
                    <label className="field">
                      <span>密钥口令（私钥加密时填写）</span>
                      <input
                        type="password"
                        value={credentialForm.passphrase}
                        onChange={(event) => updateCredentialField('passphrase', event.target.value)}
                        placeholder="没有口令可留空"
                        autoFocus
                      />
                    </label>
                  </>
                )}

                <label className="check-field">
                  <input
                    type="checkbox"
                    checked={credentialForm.saveCredential}
                    onChange={(event) => updateCredentialField('saveCredential', event.target.checked)}
                  />
                  <span>连接成功后保存到此主机配置</span>
                </label>

                {credentialError ? <div className="error-banner">{credentialError}</div> : null}

                <div className="form-actions">
                  <button type="submit" className="primary-action" disabled={isConnecting}>
                    {isConnecting ? '连接中...' : '连接'}
                  </button>
                  <button type="button" className="command-button" onClick={closeCredentialDialog}>取消</button>
                </div>
              </form>
            </aside>
          ) : null}
        </main>
      </div>
      )}
    </div>
  );
}

export default App;
