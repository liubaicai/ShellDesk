import { type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { getErrorMessage } from './desktopUtils';

const defaultBrowserUrl = 'http://127.0.0.1/';
const recentVisitLimit = 8;
const browserRecentPreferencePrefix = 'browser.recent.';
const browserBookmarkBarPreferencePrefix = 'browser.bookmark-bar.';
const browserDefaultPageColorCss = `
:where(html) {
  color-scheme: light;
}

:where(body) {
  background: #ffffff;
  color: #111827;
}

:where(a) {
  color: #0645ad;
}

:where(a:visited) {
  color: #0b0080;
}
`;

const loopbackServiceTargets = [
  { label: '开发服务', port: 3000 },
  { label: 'Vite', port: 5173 },
  { label: '管理后台', port: 8080 },
  { label: '面板', port: 9000 },
] as const;

interface RemoteBrowserContext {
  name: string;
  address: string;
  port: number;
  username: string;
  proxyPort: number;
}

interface RemoteBrowserProps {
  partition: string;
  bookmarkScope: string;
  context: RemoteBrowserContext;
  onChromeChange?: (payload: { title: string; status: string; tone: 'idle' | 'loading' | 'error' }) => void;
}

interface BrowserBookmark {
  id: string;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
}

interface BrowserBookmarkDraft {
  id: string | null;
  title: string;
  url: string;
}

interface BrowserBookmarkMenuState {
  bookmarkId: string;
  x: number;
  y: number;
}

interface BrowserToolbarMenuState {
  x: number;
  y: number;
}

interface BrowserRecentVisit {
  url: string;
  title: string;
  visitedAt: string;
}

interface BrowserLoadErrorState {
  kind: 'load' | 'protocol' | 'certificate';
  url: string;
  detail: string;
  code?: number;
}

interface BrowserQuickTarget {
  id: string;
  label: string;
  hint: string;
  url: string;
}

interface BrowserLoadCommitEvent extends Event {
  isMainFrame: boolean;
  url: string;
}

interface BrowserNavigationEvent extends Event {
  isMainFrame: boolean;
  url: string;
}

interface BrowserFailLoadEvent extends Event {
  errorCode: number;
  errorDescription: string;
  isMainFrame: boolean;
  validatedURL: string;
}

interface BrowserTitleUpdatedEvent extends Event {
  title: string;
}

interface BrowserWebview extends HTMLElement {
  canGoBack(): boolean;
  canGoForward(): boolean;
  getTitle(): string;
  getURL(): string;
  goBack(): void;
  goForward(): void;
  insertCSS(css: string): Promise<string>;
  isLoading(): boolean;
  loadURL(url: string): Promise<void>;
  reload(): void;
  stop(): void;
}

function createBookmarkId() {
  if ('randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function canonicalizeBrowserUrl(value: string) {
  const url = value.trim();

  if (!url || /^about:blank$/i.test(url)) {
    return url ? 'about:blank' : defaultBrowserUrl;
  }

  try {
    return new URL(url).toString();
  } catch {
    return url;
  }
}

function normalizeLoopbackUrlHost(url: URL) {
  const host = url.hostname.toLowerCase();

  if (
    host === 'localhost' ||
    host === 'localhost.' ||
    host === '::1' ||
    host === '[::1]' ||
    host === '0:0:0:0:0:0:0:1' ||
    host === '[0:0:0:0:0:0:0:1]'
  ) {
    url.hostname = '127.0.0.1';
  }

  return url;
}

function resolveBrowserUrl(value: string) {
  const url = value.trim();

  if (!url) {
    return defaultBrowserUrl;
  }

  if (/^about:blank$/i.test(url)) {
    return 'about:blank';
  }

  const schemeMatch = url.match(/^([a-z][a-z\d+.-]*):/i);
  const hasWebScheme = /^https?:/i.test(url);
  const isBareHostWithPort = /^[^/?#\s]+:\d+(?:[/?#]|$)/.test(url);

  if (schemeMatch && !hasWebScheme && !isBareHostWithPort) {
    return null;
  }

  try {
    const normalizedUrl = new URL(hasWebScheme ? url : `http://${url}`);

    if (normalizedUrl.protocol !== 'http:' && normalizedUrl.protocol !== 'https:') {
      return null;
    }

    return normalizeLoopbackUrlHost(normalizedUrl).toString();
  } catch {
    return null;
  }
}

function normalizeBrowserUrl(value: string) {
  return resolveBrowserUrl(value) ?? defaultBrowserUrl;
}

function isHttpsBrowserUrl(value: string) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return /^https:\/\//i.test(value);
  }
}

function isCertificateLoadError(detail: string, code?: number) {
  const signature = `${code ?? ''} ${detail}`.toUpperCase();
  return (typeof code === 'number' && code <= -200 && code > -300) || /CERT|TLS|SSL/.test(signature);
}

function getBrowserTitle(url: string, title = '') {
  const nextTitle = title.trim();

  if (nextTitle) {
    return nextTitle;
  }

  if (url === 'about:blank') {
    return '空白页';
  }

  try {
    const parsedUrl = new URL(url);
    return parsedUrl.hostname || parsedUrl.href;
  } catch {
    return url || '远程浏览器';
  }
}

function getBookmarkHost(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return url.replace(/^https?:\/\//i, '').split('/')[0] || 'site';
  }
}

function getBookmarkMonogram(title: string, url: string) {
  const source = title.trim() || getBookmarkHost(url);
  const match = source.match(/[A-Za-z0-9\u4e00-\u9fff]/u);
  return (match?.[0] || '•').toUpperCase();
}

function getBookmarkAccent(url: string) {
  const host = getBookmarkHost(url);
  let hash = 0;

  for (const char of host) {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  }

  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 78% 62%)`;
}

function areBrowserUrlsEquivalent(left: string, right: string) {
  return canonicalizeBrowserUrl(left) === canonicalizeBrowserUrl(right);
}

function isBrowserBookmark(value: unknown): value is BrowserBookmark {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const bookmark = value as Partial<BrowserBookmark>;
  return (
    typeof bookmark.id === 'string' &&
    typeof bookmark.title === 'string' &&
    typeof bookmark.url === 'string' &&
    typeof bookmark.createdAt === 'string' &&
    typeof bookmark.updatedAt === 'string'
  );
}

function normalizeBookmarks(bookmarks: BrowserBookmark[]) {
  return bookmarks.flatMap((bookmark) => {
    const url = resolveBrowserUrl(bookmark.url);

    return url
      ? [{
          ...bookmark,
          title: bookmark.title.trim() || getBrowserTitle(url),
          url,
        }]
      : [];
  });
}

function isBrowserRecentVisit(value: unknown): value is BrowserRecentVisit {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const visit = value as Partial<BrowserRecentVisit>;
  return (
    typeof visit.url === 'string' &&
    typeof visit.title === 'string' &&
    typeof visit.visitedAt === 'string'
  );
}

function encodePreferenceScope(scope: string) {
  return encodeURIComponent(scope).replace(/[!'()*~]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function getBrowserRecentPreferenceKey(scope: string) {
  return `${browserRecentPreferencePrefix}${encodePreferenceScope(scope)}`;
}

async function readBrowserRecentVisits(scope: string) {
  try {
    const storedVisits = await window.guiSSH?.preferences?.get(getBrowserRecentPreferenceKey(scope));

    if (!Array.isArray(storedVisits)) {
      return [];
    }

    return storedVisits.filter(isBrowserRecentVisit).flatMap((visit) => {
      const url = resolveBrowserUrl(visit.url);

      return url
        ? [{
            ...visit,
            url,
            title: visit.title.trim() || getBrowserTitle(url),
          }]
        : [];
    }).slice(0, recentVisitLimit);
  } catch {
    return [];
  }
}

async function writeBrowserRecentVisits(scope: string, visits: BrowserRecentVisit[]) {
  await window.guiSSH?.preferences?.set(getBrowserRecentPreferenceKey(scope), visits).catch(() => undefined);
}

function getBrowserBookmarkBarPreferenceKey(scope: string) {
  return `${browserBookmarkBarPreferencePrefix}${encodePreferenceScope(scope)}`;
}

async function readBrowserBookmarkBarOpen(scope: string) {
  try {
    return await window.guiSSH?.preferences?.get(getBrowserBookmarkBarPreferenceKey(scope)) !== 'hidden';
  } catch {
    return true;
  }
}

async function writeBrowserBookmarkBarOpen(scope: string, isOpen: boolean) {
  await window.guiSSH?.preferences?.set(getBrowserBookmarkBarPreferenceKey(scope), isOpen ? 'visible' : 'hidden').catch(() => undefined);
}

function getBrowserHostUrl(host: string, port?: number) {
  const value = host.trim() || '127.0.0.1';
  const urlHost = value.includes(':') && !value.startsWith('[') ? `[${value}]` : value;
  return `http://${urlHost}${port && port !== 80 ? `:${port}` : ''}/`;
}

function getBrowserQuickTargets(context: RemoteBrowserContext) {
  const targets: BrowserQuickTarget[] = [
    {
      id: 'loopback',
      label: '127.0.0.1',
      hint: '远程回环地址',
      url: getBrowserHostUrl('127.0.0.1'),
    },
    {
      id: 'remote-host',
      label: context.address,
      hint: '远程主机地址',
      url: getBrowserHostUrl(context.address),
    },
    ...loopbackServiceTargets.map((target) => ({
      id: `loopback-${target.port}`,
      label: `127.0.0.1:${target.port}`,
      hint: target.label,
      url: getBrowserHostUrl('127.0.0.1', target.port),
    })),
  ];
  const visitedTargets = new Set<string>();

  return targets.filter((target) => {
    if (visitedTargets.has(target.url)) {
      return false;
    }

    visitedTargets.add(target.url);
    return true;
  });
}

function getBrowserProtocolLabel(url: string) {
  if (/^https:\/\//i.test(url)) {
    return 'HTTPS';
  }

  if (/^http:\/\//i.test(url)) {
    return 'HTTP';
  }

  return '空白页';
}

function getBrowserErrorDiagnosis(error: BrowserLoadErrorState) {
  if (error.kind === 'protocol') {
    return {
      title: '地址协议已拦截',
      summary: '远程浏览器只允许打开 HTTP、HTTPS 和空白页。',
      checks: [
        '把裸域名、短主机名或 localhost 地址直接输入地址栏即可自动补全。',
        '需要打开本地文件或应用协议时，请回到对应 ShellDesk 工具处理。',
      ],
    };
  }

  const signature = `${error.code ?? ''} ${error.detail}`.toUpperCase();

  if (error.kind === 'certificate' || /CERT|TLS|SSL|-20\d/.test(signature)) {
    return {
      title: 'TLS 校验失败',
      summary: '目标 HTTPS 证书没有通过校验。',
      checks: [
        '确认目标服务证书、域名和系统时间是否匹配。',
        '如果确认这是可信的内网或自签服务，可以选择继续访问。',
      ],
    };
  }

  if (/NAME_NOT_RESOLVED|DNS|-105/.test(signature)) {
    return {
      title: 'DNS 无法解析',
      summary: '远程网络路径没有解析出这个主机名。',
      checks: [
        '先尝试远程主机地址或 127.0.0.1 快捷入口。',
        '确认远端 DNS、hosts 或内网域名是否在当前 SSH 网络里可用。',
      ],
    };
  }

  if (/CONNECTION_REFUSED|-102/.test(signature)) {
    return {
      title: '连接被拒绝',
      summary: '目标地址可达，但端口上没有接受连接的服务。',
      checks: [
        '确认服务已在远端启动，并监听了目标端口。',
        'localhost 服务请优先使用 127.0.0.1 与常用端口快捷入口。',
      ],
    };
  }

  if (/PROXY|SOCKS|TUNNEL|SOCKET_NOT_CONNECTED|-130|-111|-15/.test(signature)) {
    return {
      title: '代理路径异常',
      summary: '浏览器没有通过当前 SSH 代理完成访问。',
      checks: [
        '确认远程连接仍在线，代理端口没有被关闭。',
        '再试一个远程 localhost 页面，用来区分代理和目标服务故障。',
      ],
    };
  }

  return {
    title: '页面加载失败',
    summary: 'ShellDesk 没有拿到可渲染的远程页面。',
    checks: [
      '检查 URL、端口和远端服务状态。',
      '如果是内网地址，确认它能从当前远程主机所在网络访问。',
    ],
  };
}

type BrowserIconName =
  | 'arrow-left'
  | 'arrow-right'
  | 'clock'
  | 'go'
  | 'home'
  | 'more'
  | 'panel'
  | 'reload'
  | 'route'
  | 'shield'
  | 'star'
  | 'stop';

function BrowserIcon({ name, filled = false }: { name: BrowserIconName; filled?: boolean }) {
  if (name === 'star') {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path
          d="m12 3.6 2.54 5.15 5.69.83-4.12 4.01.97 5.67L12 16.59l-5.08 2.67.97-5.67L3.77 9.58l5.69-.83L12 3.6Z"
          fill={filled ? 'currentColor' : 'none'}
        />
      </svg>
    );
  }

  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      {name === 'arrow-left' ? <path d="m14.5 5-7 7 7 7M8 12h9" /> : null}
      {name === 'arrow-right' ? <path d="m9.5 5 7 7-7 7M16 12H7" /> : null}
      {name === 'clock' ? <path d="M12 7v5l3.5 2M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z" /> : null}
      {name === 'go' ? <path d="M5 12h13M13 6l6 6-6 6" /> : null}
      {name === 'home' ? <path d="m4 10 8-6 8 6M7 9.5V20h10V9.5M10 20v-5h4v5" /> : null}
      {name === 'more' ? <path d="M12 5.5v.01M12 12v.01M12 18.5v.01" /> : null}
      {name === 'panel' ? <path d="M5 7h14M5 12h14M5 17h9" /> : null}
      {name === 'reload' ? <path d="M19 8v5h-5M5 16v-5h5M18.2 13a6.5 6.5 0 0 1-11.1 3M5.8 11A6.5 6.5 0 0 1 17 8" /> : null}
      {name === 'route' ? <path d="M7 18a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm10-6a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM9.5 14.5l5-5" /> : null}
      {name === 'shield' ? <path d="M12 21s7-3.1 7-9V5l-7-2-7 2v7c0 5.9 7 9 7 9Zm-3.2-9.2 2 2 4.5-5" /> : null}
      {name === 'stop' ? <path d="M7 7h10v10H7z" /> : null}
    </svg>
  );
}

function RemoteBrowser({ partition, bookmarkScope, context, onChromeChange }: RemoteBrowserProps) {
  const [browserAddress, setBrowserAddress] = useState(defaultBrowserUrl);
  const [browserSrc, setBrowserSrc] = useState(defaultBrowserUrl);
  const [currentUrl, setCurrentUrl] = useState(defaultBrowserUrl);
  const [pageTitle, setPageTitle] = useState(getBrowserTitle(defaultBrowserUrl));
  const [loadError, setLoadError] = useState<BrowserLoadErrorState | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isTrustingCertificate, setIsTrustingCertificate] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [bookmarks, setBookmarks] = useState<BrowserBookmark[]>([]);
  const [recentVisits, setRecentVisits] = useState<BrowserRecentVisit[]>([]);
  const [isBookmarkBarOpen, setIsBookmarkBarOpen] = useState(true);
  const [isQuickPanelOpen, setIsQuickPanelOpen] = useState(false);
  const [bookmarkDraft, setBookmarkDraft] = useState<BrowserBookmarkDraft | null>(null);
  const [bookmarkMenu, setBookmarkMenu] = useState<BrowserBookmarkMenuState | null>(null);
  const [toolbarMenu, setToolbarMenu] = useState<BrowserToolbarMenuState | null>(null);
  const browserViewRef = useRef<BrowserWebview | null>(null);
  const isWebviewReadyRef = useRef(false);
  const bookmarkTriggerRef = useRef<HTMLDivElement | null>(null);
  const bookmarkPopoverRef = useRef<HTMLDivElement | null>(null);
  const bookmarkMenuPopoverRef = useRef<HTMLDivElement | null>(null);
  const toolbarMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const toolbarMenuPopoverRef = useRef<HTMLDivElement | null>(null);
  const bookmarkMenuTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const lastPersistedBookmarksRef = useRef('');
  const lastChromePayloadRef = useRef('');
  const areBookmarksReadyRef = useRef(false);
  const areRecentVisitsReadyRef = useRef(false);

  const currentBookmark = bookmarks.find((bookmark) => areBrowserUrlsEquivalent(bookmark.url, currentUrl)) ?? null;
  const activeBookmarkMenuBookmark = bookmarkMenu
    ? bookmarks.find((bookmark) => bookmark.id === bookmarkMenu.bookmarkId) ?? null
    : null;
  const quickTargets = getBrowserQuickTargets(context);
  const errorDiagnosis = loadError ? getBrowserErrorDiagnosis(loadError) : null;

  const rememberRecentVisit = (url: string, title = '') => {
    const resolvedUrl = resolveBrowserUrl(url);

    if (!resolvedUrl || resolvedUrl === 'about:blank') {
      return;
    }

    setRecentVisits((currentVisits) => [
      {
        url: resolvedUrl,
        title: getBrowserTitle(resolvedUrl, title),
        visitedAt: new Date().toISOString(),
      },
      ...currentVisits.filter((visit) => !areBrowserUrlsEquivalent(visit.url, resolvedUrl)),
    ].slice(0, recentVisitLimit));
  };

  const syncNavigationState = (nextUrl?: string, nextTitle?: string) => {
    const webview = browserViewRef.current;
    let resolvedUrl = canonicalizeBrowserUrl(nextUrl || defaultBrowserUrl);
    let resolvedTitle = getBrowserTitle(resolvedUrl, nextTitle || '');
    let nextCanGoBack = false;
    let nextCanGoForward = false;
    let nextIsLoading = false;

    if (webview && isWebviewReadyRef.current) {
      try {
        resolvedUrl = canonicalizeBrowserUrl(nextUrl || webview.getURL() || defaultBrowserUrl);
        resolvedTitle = getBrowserTitle(resolvedUrl, nextTitle || webview.getTitle() || '');
        nextCanGoBack = webview.canGoBack();
        nextCanGoForward = webview.canGoForward();
        nextIsLoading = webview.isLoading();
      } catch {
        resolvedUrl = canonicalizeBrowserUrl(nextUrl || browserSrc || currentUrl || defaultBrowserUrl);
        resolvedTitle = getBrowserTitle(resolvedUrl, nextTitle || pageTitle);
      }
    } else {
      resolvedUrl = canonicalizeBrowserUrl(nextUrl || browserSrc || currentUrl || defaultBrowserUrl);
      resolvedTitle = getBrowserTitle(resolvedUrl, nextTitle || pageTitle);
    }

    setCurrentUrl(resolvedUrl);
    setBrowserAddress(resolvedUrl);
    setPageTitle(resolvedTitle);
    setCanGoBack(nextCanGoBack);
    setCanGoForward(nextCanGoForward);
    setIsLoading(nextIsLoading);
  };

  useEffect(() => {
    const guiSSH = window.guiSSH;

    if (!guiSSH?.vault) {
      return;
    }

    let disposed = false;
    areBookmarksReadyRef.current = false;

    void guiSSH.vault.getBookmarks(bookmarkScope).then((storedBookmarks) => {
      if (!disposed) {
        const normalizedBookmarks = normalizeBookmarks(storedBookmarks.filter(isBrowserBookmark));
        setBookmarks(normalizedBookmarks);
        lastPersistedBookmarksRef.current = JSON.stringify(normalizedBookmarks);
        areBookmarksReadyRef.current = true;
      }
    }).catch(() => undefined);

    return () => {
      disposed = true;
    };
  }, [bookmarkScope]);

  useEffect(() => {
    const guiSSH = window.guiSSH;

    if (!guiSSH?.vault) {
      return;
    }

    if (!areBookmarksReadyRef.current) {
      return;
    }

    const normalizedBookmarks = normalizeBookmarks(bookmarks);
    const serializedBookmarks = JSON.stringify(normalizedBookmarks);

    if (serializedBookmarks === lastPersistedBookmarksRef.current) {
      return;
    }

    let cancelled = false;

    void guiSSH.vault.saveBookmarks(bookmarkScope, normalizedBookmarks).then((storedBookmarks) => {
      if (!cancelled) {
        const nextBookmarks = normalizeBookmarks(storedBookmarks.filter(isBrowserBookmark));
        lastPersistedBookmarksRef.current = JSON.stringify(nextBookmarks);
        setBookmarks(nextBookmarks);
      }
    }).catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [bookmarkScope, bookmarks]);

  useEffect(() => {
    const guiSSH = window.guiSSH;

    if (!guiSSH?.events.onVaultChanged || !guiSSH.vault) {
      return;
    }

    return guiSSH.events.onVaultChanged((payload) => {
      if (payload.kind !== 'bookmarks' || payload.scope !== bookmarkScope) {
        return;
      }

      void guiSSH.vault.getBookmarks(bookmarkScope).then((storedBookmarks) => {
        const normalizedBookmarks = normalizeBookmarks(storedBookmarks.filter(isBrowserBookmark));
        setBookmarks(normalizedBookmarks);
        lastPersistedBookmarksRef.current = JSON.stringify(normalizedBookmarks);
        areBookmarksReadyRef.current = true;
      }).catch(() => undefined);
    });
  }, [bookmarkScope]);

  useEffect(() => {
    let disposed = false;
    areRecentVisitsReadyRef.current = false;

    void readBrowserRecentVisits(bookmarkScope).then((storedVisits) => {
      if (disposed) {
        return;
      }

      setRecentVisits(storedVisits);
      areRecentVisitsReadyRef.current = true;
    });

    return () => {
      disposed = true;
    };
  }, [bookmarkScope]);

  useEffect(() => {
    let disposed = false;

    void readBrowserBookmarkBarOpen(bookmarkScope).then((isOpen) => {
      if (!disposed) {
        setIsBookmarkBarOpen(isOpen);
      }
    });

    return () => {
      disposed = true;
    };
  }, [bookmarkScope]);

  useEffect(() => {
    if (!areRecentVisitsReadyRef.current) {
      areRecentVisitsReadyRef.current = true;
      return;
    }

    void writeBrowserRecentVisits(bookmarkScope, recentVisits);
  }, [bookmarkScope, recentVisits]);

  useEffect(() => {
    const webview = browserViewRef.current;

    if (!webview) {
      return;
    }

    isWebviewReadyRef.current = false;

    const handleLoadCommit: EventListener = (event) => {
      const browserEvent = event as BrowserLoadCommitEvent;

      if (!browserEvent.isMainFrame) {
        return;
      }

      const nextUrl = canonicalizeBrowserUrl(browserEvent.url);
      setLoadError(null);
      syncNavigationState(nextUrl);
      rememberRecentVisit(nextUrl);
    };
    const handleDidStartNavigation: EventListener = (event) => {
      const browserEvent = event as BrowserNavigationEvent;

      if (!browserEvent.isMainFrame) {
        return;
      }

      const nextUrl = canonicalizeBrowserUrl(browserEvent.url);
      setLoadError(null);
      setIsLoading(true);
      setCurrentUrl(nextUrl);
      setBrowserAddress(nextUrl);

      if (isWebviewReadyRef.current) {
        try {
          setCanGoBack(webview.canGoBack());
          setCanGoForward(webview.canGoForward());
        } catch {
          setCanGoBack(false);
          setCanGoForward(false);
        }
      } else {
        setCanGoBack(false);
        setCanGoForward(false);
      }
    };
    const handleDidNavigate: EventListener = (event) => {
      const browserEvent = event as BrowserNavigationEvent;
      const nextUrl = canonicalizeBrowserUrl(browserEvent.url);
      setLoadError(null);
      syncNavigationState(nextUrl);
      rememberRecentVisit(nextUrl);
    };
    const handleDidNavigateInPage: EventListener = (event) => {
      const browserEvent = event as BrowserNavigationEvent;
      const nextUrl = canonicalizeBrowserUrl(browserEvent.url);
      syncNavigationState(nextUrl);
      rememberRecentVisit(nextUrl);
    };
    const handleDidStartLoading = () => {
      setLoadError(null);
      setIsLoading(true);

      if (isWebviewReadyRef.current) {
        syncNavigationState();
      }
    };
    const handleDidStopLoading = () => {
      if (isWebviewReadyRef.current) {
        syncNavigationState();
      } else {
        setIsLoading(false);
      }
    };
    const handleDidFailLoad: EventListener = (event) => {
      const browserEvent = event as BrowserFailLoadEvent;

      if (!browserEvent.isMainFrame) {
        return;
      }

      const failedUrl = canonicalizeBrowserUrl(browserEvent.validatedURL || webview.getURL() || defaultBrowserUrl);

      if (browserEvent.errorCode !== -3) {
        setLoadError({
          kind: isCertificateLoadError(browserEvent.errorDescription, browserEvent.errorCode) ? 'certificate' : 'load',
          url: failedUrl,
          detail: browserEvent.errorDescription || '页面加载失败。',
          code: browserEvent.errorCode,
        });
      } else {
        setLoadError(null);
      }

      setIsLoading(false);
      syncNavigationState(failedUrl);
    };
    const handlePageTitleUpdated: EventListener = (event) => {
      const browserEvent = event as BrowserTitleUpdatedEvent;
      syncNavigationState(undefined, browserEvent.title);
      rememberRecentVisit(webview.getURL() || defaultBrowserUrl, browserEvent.title);
    };
    const handleDomReady = (_event: Event) => {
      isWebviewReadyRef.current = true;
      void webview.insertCSS(browserDefaultPageColorCss).catch(() => undefined);
      syncNavigationState();
    };

    webview.addEventListener('load-commit', handleLoadCommit);
    webview.addEventListener('did-start-navigation', handleDidStartNavigation);
    webview.addEventListener('did-navigate', handleDidNavigate);
    webview.addEventListener('did-navigate-in-page', handleDidNavigateInPage);
    webview.addEventListener('did-start-loading', handleDidStartLoading);
    webview.addEventListener('did-stop-loading', handleDidStopLoading);
    webview.addEventListener('did-fail-load', handleDidFailLoad);
    webview.addEventListener('page-title-updated', handlePageTitleUpdated);
    webview.addEventListener('dom-ready', handleDomReady);

    return () => {
      isWebviewReadyRef.current = false;
      webview.removeEventListener('load-commit', handleLoadCommit);
      webview.removeEventListener('did-start-navigation', handleDidStartNavigation);
      webview.removeEventListener('did-navigate', handleDidNavigate);
      webview.removeEventListener('did-navigate-in-page', handleDidNavigateInPage);
      webview.removeEventListener('did-start-loading', handleDidStartLoading);
      webview.removeEventListener('did-stop-loading', handleDidStopLoading);
      webview.removeEventListener('did-fail-load', handleDidFailLoad);
      webview.removeEventListener('page-title-updated', handlePageTitleUpdated);
      webview.removeEventListener('dom-ready', handleDomReady);
    };
  }, [partition]);

  useEffect(() => {
    if (!onChromeChange) {
      return;
    }

    const payload = {
      title: pageTitle || getBrowserTitle(currentUrl || browserAddress || defaultBrowserUrl),
      status: loadError ? '加载失败' : isLoading ? '远程加载中' : 'SSH 代理',
      tone: loadError ? 'error' : isLoading ? 'loading' : 'idle',
    } as const;
    const payloadKey = `${payload.tone}\n${payload.status}\n${payload.title}`;

    if (payloadKey === lastChromePayloadRef.current) {
      return;
    }

    lastChromePayloadRef.current = payloadKey;
    onChromeChange(payload);
  }, [browserAddress, currentUrl, isLoading, loadError, onChromeChange, pageTitle]);

  useEffect(() => {
    if (!bookmarkDraft) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;

      if (
        (bookmarkTriggerRef.current && bookmarkTriggerRef.current.contains(target)) ||
        (bookmarkPopoverRef.current && bookmarkPopoverRef.current.contains(target))
      ) {
        return;
      }

      closeBookmarkDraft();
    };

    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [bookmarkDraft]);

  useEffect(() => {
    if (!bookmarkMenu) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      const trigger = bookmarkMenuTriggerRefs.current.get(bookmarkMenu.bookmarkId) ?? null;

      if (
        (trigger && trigger.contains(target)) ||
        (bookmarkMenuPopoverRef.current && bookmarkMenuPopoverRef.current.contains(target))
      ) {
        return;
      }

      setBookmarkMenu(null);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setBookmarkMenu(null);
      }
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [bookmarkMenu]);

  useEffect(() => {
    if (!toolbarMenu) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;

      if (
        (toolbarMenuTriggerRef.current && toolbarMenuTriggerRef.current.contains(target)) ||
        (toolbarMenuPopoverRef.current && toolbarMenuPopoverRef.current.contains(target))
      ) {
        return;
      }

      setToolbarMenu(null);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setToolbarMenu(null);
      }
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [toolbarMenu]);

  const loadBrowserUrl = (value: string) => {
    const nextUrl = resolveBrowserUrl(value);
    const webview = browserViewRef.current;

    if (!nextUrl) {
      setLoadError({
        kind: 'protocol',
        url: value.trim(),
        detail: '地址没有使用允许的 Web 协议。',
      });
      setIsLoading(false);
      return;
    }

    setLoadError(null);
    setBrowserAddress(nextUrl);
    setCurrentUrl(nextUrl);
    setPageTitle(getBrowserTitle(nextUrl));
    setIsLoading(true);

    if (!webview || !isWebviewReadyRef.current) {
      setBrowserSrc(nextUrl);
      return;
    }

    void webview.loadURL(nextUrl).catch((error: unknown) => {
      const detail = getErrorMessage(error);

      setLoadError({
        kind: isCertificateLoadError(detail) ? 'certificate' : 'load',
        url: nextUrl,
        detail,
      });
      setIsLoading(false);
    });
  };

  const continueWithInvalidCertificate = async (url: string) => {
    const nextUrl = resolveBrowserUrl(url);

    if (!nextUrl || !isHttpsBrowserUrl(nextUrl)) {
      setLoadError({
        kind: 'certificate',
        url,
        detail: '只能为 HTTPS 地址添加临时证书例外。',
      });
      return;
    }

    const trustBrowserCertificate = window.guiSSH?.connections.trustBrowserCertificate;

    if (!trustBrowserCertificate) {
      setLoadError({
        kind: 'certificate',
        url: nextUrl,
        detail: '当前运行环境不支持证书例外。',
      });
      return;
    }

    setIsTrustingCertificate(true);

    try {
      await trustBrowserCertificate(partition, nextUrl);
      loadBrowserUrl(nextUrl);
    } catch (error) {
      setLoadError({
        kind: 'certificate',
        url: nextUrl,
        detail: getErrorMessage(error),
      });
      setIsLoading(false);
    } finally {
      setIsTrustingCertificate(false);
    }
  };

  const submitBrowserAddress = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    loadBrowserUrl(browserAddress);
  };

  const navigateWebview = (action: 'back' | 'forward' | 'reload' | 'home') => {
    const webview = browserViewRef.current;

    if (!webview || !isWebviewReadyRef.current) {
      if (action === 'home') {
        setBrowserSrc(defaultBrowserUrl);
        setBrowserAddress(defaultBrowserUrl);
        setCurrentUrl(defaultBrowserUrl);
        setPageTitle(getBrowserTitle(defaultBrowserUrl));
        setLoadError(null);
        setIsLoading(true);
      }
      return;
    }

    if (action === 'back') {
      if (webview.canGoBack()) {
        webview.goBack();
      }
    } else if (action === 'forward') {
      if (webview.canGoForward()) {
        webview.goForward();
      }
    } else if (action === 'home') {
      loadBrowserUrl(defaultBrowserUrl);
    } else if (isLoading) {
      webview.stop();
    } else {
      webview.reload();
    }
  };

  const openBookmarkDraft = (bookmark?: BrowserBookmark | null) => {
    const sourceUrl = bookmark?.url || currentUrl || normalizeBrowserUrl(browserAddress);
    setBookmarkDraft({
      id: bookmark?.id ?? null,
      title: bookmark?.title || getBrowserTitle(sourceUrl, pageTitle),
      url: sourceUrl,
    });
  };

  const closeBookmarkDraft = () => {
    setBookmarkDraft(null);
  };

  const toggleBookmarkMenu = (bookmark: BrowserBookmark, element: HTMLButtonElement) => {
    if (bookmarkMenu?.bookmarkId === bookmark.id) {
      setBookmarkMenu(null);
      return;
    }

    const rect = element.getBoundingClientRect();
    const menuWidth = 126;
    const menuHeight = 78;
    const gap = 6;
    const maxLeft = Math.max(12, window.innerWidth - menuWidth - 12);
    const x = Math.min(Math.max(12, rect.right - menuWidth), maxLeft);
    const prefersBottom = rect.bottom + gap + menuHeight <= window.innerHeight - 12;
    const y = prefersBottom
      ? rect.bottom + gap
      : Math.max(12, rect.top - gap - menuHeight);

    setBookmarkMenu({
      bookmarkId: bookmark.id,
      x,
      y,
    });
  };

  const toggleToolbarMenu = (element: HTMLButtonElement) => {
    if (toolbarMenu) {
      setToolbarMenu(null);
      return;
    }

    const rect = element.getBoundingClientRect();
    const menuWidth = 186;
    const menuHeight = 106;
    const gap = 7;
    const maxLeft = Math.max(10, window.innerWidth - menuWidth - 10);
    const x = Math.min(Math.max(10, rect.right - menuWidth), maxLeft);
    const y = rect.bottom + gap + menuHeight <= window.innerHeight - 10
      ? rect.bottom + gap
      : Math.max(10, rect.top - gap - menuHeight);

    setToolbarMenu({ x, y });
  };

  const toggleBookmarkBar = () => {
    setIsBookmarkBarOpen((isOpen) => {
      const nextIsOpen = !isOpen;
      void writeBrowserBookmarkBarOpen(bookmarkScope, nextIsOpen);
      return nextIsOpen;
    });
  };

  const updateBookmarkDraftField = (field: keyof BrowserBookmarkDraft, value: string | null) => {
    setBookmarkDraft((currentDraft) => (
      currentDraft ? { ...currentDraft, [field]: value } : currentDraft
    ));
  };

  const commitBookmarkDraft = () => {
    if (!bookmarkDraft) {
      return;
    }

    const normalizedUrl = resolveBrowserUrl(bookmarkDraft.url);

    if (!normalizedUrl) {
      setLoadError({
        kind: 'protocol',
        url: bookmarkDraft.url.trim(),
        detail: '书签地址没有使用允许的 Web 协议。',
      });
      return;
    }

    const normalizedTitle = bookmarkDraft.title.trim() || getBrowserTitle(normalizedUrl, pageTitle);
    const now = new Date().toISOString();

    setBookmarks((currentBookmarks) => {
      if (bookmarkDraft.id) {
        return currentBookmarks.map((bookmark) => (
          bookmark.id === bookmarkDraft.id
            ? {
                ...bookmark,
                title: normalizedTitle,
                url: normalizedUrl,
                updatedAt: now,
              }
            : bookmark
        ));
      }

      return [
        {
          id: createBookmarkId(),
          title: normalizedTitle,
          url: normalizedUrl,
          createdAt: now,
          updatedAt: now,
        },
        ...currentBookmarks.filter((bookmark) => !areBrowserUrlsEquivalent(bookmark.url, normalizedUrl)),
      ];
    });
    closeBookmarkDraft();
  };

  const handleBookmarkDraftKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      commitBookmarkDraft();
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeBookmarkDraft();
    }
  };

  const deleteBookmark = (bookmarkId: string) => {
    setBookmarks((currentBookmarks) => currentBookmarks.filter((bookmark) => bookmark.id !== bookmarkId));
    setBookmarkMenu((currentMenu) => (currentMenu?.bookmarkId === bookmarkId ? null : currentMenu));

    if (bookmarkDraft?.id === bookmarkId) {
      closeBookmarkDraft();
    }
  };

  return (
    <div className="remote-browser-pane">
      <div className="browser-chrome">
        <form className="browser-toolbar" onSubmit={submitBrowserAddress}>
          <button type="button" onClick={() => navigateWebview('back')} disabled={!canGoBack} aria-label="后退" title="后退">
            <BrowserIcon name="arrow-left" />
          </button>
          <button type="button" onClick={() => navigateWebview('forward')} disabled={!canGoForward} aria-label="前进" title="前进">
            <BrowserIcon name="arrow-right" />
          </button>
          <button
            type="button"
            onClick={() => navigateWebview('reload')}
            aria-label={isLoading ? '停止加载' : '刷新页面'}
            title={isLoading ? '停止加载' : '刷新页面'}
          >
            <BrowserIcon name={isLoading ? 'stop' : 'reload'} />
          </button>
          <button type="button" onClick={() => navigateWebview('home')} aria-label="打开主页" title="主页">
            <BrowserIcon name="home" />
          </button>
          <div className="browser-address-shell">
            <span className="browser-security-icon" aria-label={`地址协议 ${getBrowserProtocolLabel(currentUrl)}`}>
              <BrowserIcon name="shield" />
              <em>{getBrowserProtocolLabel(currentUrl)}</em>
            </span>
            <input
              value={browserAddress}
              onChange={(event) => setBrowserAddress(event.target.value)}
              placeholder="输入域名、localhost 或内网地址"
              autoCapitalize="off"
              spellCheck={false}
            />
          </div>
          <div className="browser-toolbar-actions">
            <div ref={bookmarkTriggerRef} className="browser-bookmark-trigger-wrap">
              <button
                type="button"
                className={`browser-bookmark-trigger ${currentBookmark ? 'active' : ''}`}
                onClick={() => openBookmarkDraft(currentBookmark)}
                aria-label={currentBookmark ? '编辑当前页书签' : '收藏当前页'}
                title={currentBookmark ? '编辑当前页书签' : '收藏当前页'}
              >
                <BrowserIcon name="star" filled={Boolean(currentBookmark)} />
              </button>

              {bookmarkDraft ? (
                <div ref={bookmarkPopoverRef} className="browser-bookmark-popover" role="dialog" aria-label="书签编辑器">
                  <div className="browser-bookmark-popover-header">
                    <strong>{bookmarkDraft.id ? '编辑书签' : '添加书签'}</strong>
                    <button type="button" aria-label="关闭书签编辑器" onClick={closeBookmarkDraft}>
                      ×
                    </button>
                  </div>

                  <label className="browser-bookmark-field">
                    <span>名称</span>
                    <input
                      value={bookmarkDraft.title}
                      onChange={(event) => updateBookmarkDraftField('title', event.target.value)}
                      onKeyDown={handleBookmarkDraftKeyDown}
                      placeholder="书签名称"
                    />
                  </label>

                  <label className="browser-bookmark-field">
                    <span>地址</span>
                    <input
                      value={bookmarkDraft.url}
                      onChange={(event) => updateBookmarkDraftField('url', event.target.value)}
                      onKeyDown={handleBookmarkDraftKeyDown}
                      placeholder="http://127.0.0.1/"
                    />
                  </label>

                  <div className="browser-bookmark-popover-actions">
                    <button type="button" className="primary" onClick={commitBookmarkDraft}>
                      保存
                    </button>
                    <button type="button" onClick={closeBookmarkDraft}>
                      取消
                    </button>
                    {bookmarkDraft.id ? (
                      <button type="button" className="danger-text" onClick={() => deleteBookmark(bookmarkDraft.id!)}>
                        删除
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>

            <button type="submit" className="browser-go-button" aria-label="打开地址" title="打开地址">
              <BrowserIcon name="go" />
            </button>
            <button
              ref={toolbarMenuTriggerRef}
              type="button"
              className={`browser-overflow-button ${toolbarMenu ? 'active' : ''}`}
              aria-label="浏览器菜单"
              aria-expanded={Boolean(toolbarMenu)}
              title="菜单"
              onClick={(event) => toggleToolbarMenu(event.currentTarget)}
            >
              <BrowserIcon name="more" />
            </button>
          </div>
        </form>

        {isQuickPanelOpen ? (
          <section className="browser-shortcut-panel" aria-label="快捷访问和最近访问">
            <div className="browser-target-column">
              <strong>快捷地址</strong>
              <div className="browser-target-grid">
                {quickTargets.map((target) => (
                  <button
                    key={target.id}
                    type="button"
                    className={areBrowserUrlsEquivalent(target.url, currentUrl) ? 'active' : ''}
                    onClick={() => loadBrowserUrl(target.url)}
                  >
                    <span>{target.label}</span>
                    <small>{target.hint}</small>
                  </button>
                ))}
              </div>
            </div>

            <div className="browser-recent-column">
              <strong>
                <BrowserIcon name="clock" />
                最近访问
              </strong>
              {recentVisits.length ? (
                <div className="browser-recent-list">
                  {recentVisits.map((visit) => (
                    <button key={visit.url} type="button" title={visit.url} onClick={() => loadBrowserUrl(visit.url)}>
                      <span>{visit.title}</span>
                      <small>{visit.url}</small>
                    </button>
                  ))}
                </div>
              ) : (
                <p>访问远程页面后，这里会保留本连接最近打开的地址。</p>
              )}
            </div>
          </section>
        ) : null}

        {isBookmarkBarOpen ? (
          <div className="browser-bookmark-bar">
            {bookmarks.length ? (
              <div className="browser-bookmark-list" aria-label="连接级书签栏">
                {bookmarks.map((bookmark) => {
                  const bookmarkStyle = {
                    '--bookmark-accent': getBookmarkAccent(bookmark.url),
                  } as CSSProperties;

                  return (
                    <div
                      key={bookmark.id}
                      className={`browser-bookmark-chip ${currentBookmark?.id === bookmark.id ? 'active' : ''}`}
                      style={bookmarkStyle}
                    >
                      <button type="button" className="browser-bookmark-link" onClick={() => loadBrowserUrl(bookmark.url)} title={bookmark.url}>
                        <span className="browser-bookmark-favicon" aria-hidden="true">
                          {getBookmarkMonogram(bookmark.title, bookmark.url)}
                        </span>
                        <span className="browser-bookmark-label">{bookmark.title}</span>
                      </button>
                      <button
                        ref={(element) => {
                          if (element) {
                            bookmarkMenuTriggerRefs.current.set(bookmark.id, element);
                          } else {
                            bookmarkMenuTriggerRefs.current.delete(bookmark.id);
                          }
                        }}
                        type="button"
                        className={`browser-bookmark-menu-button ${bookmarkMenu?.bookmarkId === bookmark.id ? 'active' : ''}`}
                        aria-label="书签操作"
                        title="书签操作"
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleBookmarkMenu(bookmark, event.currentTarget);
                        }}
                      >
                        ···
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="browser-bookmark-empty">
                <span>此连接还没有书签。</span>
                <button type="button" onClick={() => openBookmarkDraft()}>
                  收藏当前页
                </button>
              </div>
            )}
          </div>
        ) : null}
      </div>

      {bookmarkMenu && activeBookmarkMenuBookmark ? createPortal(
        <div
          ref={bookmarkMenuPopoverRef}
          className="browser-bookmark-menu-panel browser-bookmark-menu-panel-floating"
          style={{ left: bookmarkMenu.x, top: bookmarkMenu.y }}
          role="menu"
          aria-label="书签操作菜单"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              openBookmarkDraft(activeBookmarkMenuBookmark);
              setBookmarkMenu(null);
            }}
          >
            编辑
          </button>
          <button
            type="button"
            role="menuitem"
            className="danger-text"
            onClick={() => deleteBookmark(activeBookmarkMenuBookmark.id)}
          >
            删除
          </button>
        </div>,
        document.body,
      ) : null}

      {toolbarMenu ? createPortal(
        <div
          ref={toolbarMenuPopoverRef}
          className="browser-toolbar-menu-panel"
          style={{ left: toolbarMenu.x, top: toolbarMenu.y }}
          role="menu"
          aria-label="浏览器菜单"
        >
          <button
            type="button"
            role="menuitem"
            className={isQuickPanelOpen ? 'active' : ''}
            onClick={() => {
              setIsQuickPanelOpen((open) => !open);
              setToolbarMenu(null);
            }}
          >
            <span>快捷与最近</span>
            <em>{isQuickPanelOpen ? '收起' : '展开'}</em>
          </button>
          <button
            type="button"
            role="menuitem"
            className={isBookmarkBarOpen ? 'active' : ''}
            onClick={() => {
              toggleBookmarkBar();
              setToolbarMenu(null);
            }}
          >
            <span>书签栏</span>
            <em>{isBookmarkBarOpen ? '隐藏' : '显示'}</em>
          </button>
        </div>,
        document.body,
      ) : null}

      <div className={`browser-viewport ${isLoading ? 'loading' : ''}`}>
        <div className={`browser-progress ${isLoading ? 'visible' : ''}`} aria-hidden="true" />
        <webview
          ref={(element) => {
            browserViewRef.current = element as BrowserWebview | null;
          }}
          className="remote-webview"
          partition={partition}
          src={browserSrc}
        />
        {loadError && errorDiagnosis ? (
          <section className="browser-error-page" role="alert" aria-live="polite">
            <div>
              <span>{errorDiagnosis.title}</span>
              <strong>{errorDiagnosis.summary}</strong>
              <code>{loadError.url || browserAddress}</code>
              <p>{loadError.detail}{typeof loadError.code === 'number' ? ` (${loadError.code})` : ''}</p>
              <ul>
                {errorDiagnosis.checks.map((check) => <li key={check}>{check}</li>)}
              </ul>
              <footer>
                {loadError.kind === 'certificate' && isHttpsBrowserUrl(loadError.url) ? (
                  <button
                    type="button"
                    className="browser-warning-action"
                    disabled={isTrustingCertificate}
                    onClick={() => void continueWithInvalidCertificate(loadError.url)}
                  >
                    {isTrustingCertificate ? '正在继续' : '继续访问'}
                  </button>
                ) : null}
                {loadError.kind === 'load' ? (
                  <button type="button" onClick={() => loadBrowserUrl(loadError.url)}>
                    重新加载
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    setLoadError(null);
                    setIsQuickPanelOpen(true);
                  }}
                >
                  查看快捷地址
                </button>
              </footer>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

export default RemoteBrowser;
