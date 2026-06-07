import { type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { getErrorMessage } from './desktopUtils';
import { tCurrent } from '../../i18n';

const defaultBrowserUrl = 'http://127.0.0.1/';
const browserBlankUrl = 'about:blank';
const browserStartAddress = '';
const browserStartPageTitle = tCurrent('auto.remoteBrowser.z0eh12');
const recentVisitLimit = 8;
const browserStartPageCardLimit = 6;
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
  { label: tCurrent('auto.remoteBrowser.d4d2lo'), port: 3000 },
  { label: 'Vite', port: 5173 },
  { label: tCurrent('auto.remoteBrowser.gkha7'), port: 8000 },
  { label: tCurrent('auto.remoteBrowser.cit5ds'), port: 8080 },
  { label: tCurrent('auto.remoteBrowser.1rq6sfi'), port: 9000 },
] as const;

interface RemoteBrowserContext {
  name: string;
  address: string;
  port: number;
  username: string;
  proxyPort: number;
}

interface RemoteBrowserProps {
  connectionId: string;
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

interface BrowserStartPageCard {
  id: string;
  title: string;
  subtitle: string;
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

function getUrlFromBrowserLoadErrorDetail(detail: string) {
  const match = detail.match(/\bhttps?:\/\/[^\s'"<>)]*/i);
  return match?.[0] ? canonicalizeBrowserUrl(match[0]) : null;
}

function getBrowserTitle(url: string, title = '') {
  const nextTitle = title.trim();

  if (nextTitle) {
    return nextTitle;
  }

  if (url === 'about:blank') {
    return tCurrent('auto.remoteBrowser.1qhgtsv');
  }

  try {
    const parsedUrl = new URL(url);
    return parsedUrl.hostname || parsedUrl.href;
  } catch {
    return url || tCurrent('auto.remoteBrowser.claw1h');
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
    return await window.guiSSH?.preferences?.get(getBrowserBookmarkBarPreferenceKey(scope)) === 'visible';
  } catch {
    return false;
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
      hint: tCurrent('auto.remoteBrowser.wsgx3b'),
      url: getBrowserHostUrl('127.0.0.1'),
    },
    {
      id: 'remote-host',
      label: context.address,
      hint: tCurrent('auto.remoteBrowser.10tjf3d'),
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

function getBrowserStartPageCards(bookmarks: BrowserBookmark[]) {
  if (bookmarks.length) {
    return bookmarks.slice(0, browserStartPageCardLimit).map((bookmark): BrowserStartPageCard => ({
      id: bookmark.id,
      title: bookmark.title,
      subtitle: bookmark.url,
      url: bookmark.url,
    }));
  }

  return [
    {
      id: 'home-loopback',
      title: '127.0.0.1',
      subtitle: defaultBrowserUrl,
      url: defaultBrowserUrl,
    },
    ...loopbackServiceTargets.map((target) => {
      const url = getBrowserHostUrl('127.0.0.1', target.port);

      return {
        id: `home-loopback-${target.port}`,
        title: `127.0.0.1:${target.port}`,
        subtitle: target.label,
        url,
      };
    }),
  ].slice(0, browserStartPageCardLimit);
}

function getBrowserStartCardProbePort(url: string) {
  try {
    const parsedUrl = new URL(url);
    const host = parsedUrl.hostname.toLowerCase();

    if (![
      '127.0.0.1',
      'localhost',
      'localhost.',
      '::1',
      '[::1]',
      '0:0:0:0:0:0:0:1',
      '[0:0:0:0:0:0:0:1]',
    ].includes(host)) {
      return null;
    }

    if (parsedUrl.port) {
      return Number(parsedUrl.port);
    }

    if (parsedUrl.protocol === 'http:') {
      return 80;
    }

    if (parsedUrl.protocol === 'https:') {
      return 443;
    }
  } catch {
    return null;
  }

  return null;
}

function getBrowserStartProbePorts(cards: BrowserStartPageCard[]) {
  const ports = new Set<number>();

  for (const card of cards) {
    const port = getBrowserStartCardProbePort(card.url);

    if (port) {
      ports.add(port);
    }
  }

  return [...ports].sort((left, right) => left - right);
}

function buildBrowserStartPortProbeCommand(ports: number[]) {
  const portArgs = ports
    .filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535)
    .map((port) => String(port))
    .join(' ');

  if (!portArgs) {
    return 'exit 0';
  }

  return `
shelldesk_has_tcp_listener() {
  probe_port="$1"
  case "$probe_port" in
    ''|*[!0-9]*) return 1 ;;
  esac
  if [ "$probe_port" -lt 1 ] || [ "$probe_port" -gt 65535 ]; then
    return 1
  fi

  probe_hex=$(printf '%04X' "$probe_port" 2>/dev/null || true)
  if [ -n "$probe_hex" ]; then
    for probe_file in /proc/net/tcp /proc/net/tcp6; do
      if [ -r "$probe_file" ] && awk -v port="$probe_hex" '
        NR > 1 && $4 == "0A" {
          split($2, local, ":")
          if (toupper(local[2]) == port) found = 1
        }
        END { exit found ? 0 : 1 }
      ' "$probe_file" 2>/dev/null; then
        return 0
      fi
    done
  fi

  if command -v ss >/dev/null 2>&1; then
    if (ss -H -ltn 2>/dev/null || ss -ltn 2>/dev/null) | awk -v port="$probe_port" '
      /LISTEN/ {
        local_index = ($1 ~ /^(tcp|tcp6)$/) ? 5 : 4
        value = $local_index
        gsub(/^\\[/, "", value)
        n = split(value, parts, ":")
        endpoint_port = parts[n]
        gsub(/[^0-9].*$/, "", endpoint_port)
        if (endpoint_port == port) found = 1
      }
      END { exit found ? 0 : 1 }
    '; then
      return 0
    fi
  fi

  if command -v netstat >/dev/null 2>&1; then
    if (netstat -ltn 2>/dev/null || netstat -tnl 2>/dev/null) | awk -v port="$probe_port" '
      /^[Tt][Cc][Pp]/ && /LISTEN/ {
        n = split($4, parts, ":")
        endpoint_port = parts[n]
        gsub(/[^0-9].*$/, "", endpoint_port)
        if (endpoint_port == port) found = 1
      }
      END { exit found ? 0 : 1 }
    '; then
      return 0
    fi
  fi

  return 1
}

for port in ${portArgs}; do
  if shelldesk_has_tcp_listener "$port"; then
    printf 'OPEN\\t%s\\n' "$port"
  else
    printf 'CLOSED\\t%s\\n' "$port"
  fi
done
`;
}

function getOpenPortsFromProbeOutput(output: string) {
  const openPorts = new Set<number>();

  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^OPEN\t(\d{1,5})$/);

    if (!match) {
      continue;
    }

    const port = Number(match[1]);

    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      openPorts.add(port);
    }
  }

  return openPorts;
}

function getBrowserStartCardMeta(url: string) {
  try {
    const parsedUrl = new URL(url);
    const host = parsedUrl.hostname.replace(/^www\./i, '');

    if (host === '127.0.0.1') {
      return parsedUrl.port ? `PORT ${parsedUrl.port}` : 'LOOPBACK';
    }

    return parsedUrl.port ? `${host}:${parsedUrl.port}` : host;
  } catch {
    return 'BOOKMARK';
  }
}

function getBrowserProtocolLabel(url: string) {
  if (/^https:\/\//i.test(url)) {
    return 'HTTPS';
  }

  if (/^http:\/\//i.test(url)) {
    return 'HTTP';
  }

  return tCurrent('auto.remoteBrowser.1qhgtsv2');
}

function getBrowserErrorDiagnosis(error: BrowserLoadErrorState) {
  if (error.kind === 'protocol') {
    return {
      title: tCurrent('auto.remoteBrowser.ofpb6e'),
      summary: tCurrent('auto.remoteBrowser.1uevwwr'),
      checks: [
        tCurrent('auto.remoteBrowser.13gh3cf'),
        tCurrent('auto.remoteBrowser.17oz1qm'),
      ],
    };
  }

  const signature = `${error.code ?? ''} ${error.detail}`.toUpperCase();

  if (error.kind === 'certificate' || /CERT|TLS|SSL|-20\d/.test(signature)) {
    return {
      title: tCurrent('auto.remoteBrowser.jw3yrd'),
      summary: tCurrent('auto.remoteBrowser.1r6zh40'),
      checks: [
        tCurrent('auto.remoteBrowser.qq5fwr'),
        tCurrent('auto.remoteBrowser.kl9k0o'),
      ],
    };
  }

  if (/NAME_NOT_RESOLVED|DNS|-105/.test(signature)) {
    return {
      title: tCurrent('auto.remoteBrowser.nvg62g'),
      summary: tCurrent('auto.remoteBrowser.k7fs4q'),
      checks: [
        tCurrent('auto.remoteBrowser.pzfcp0'),
        tCurrent('auto.remoteBrowser.121kr7a'),
      ],
    };
  }

  if (/CONNECTION_REFUSED|-102/.test(signature)) {
    return {
      title: tCurrent('auto.remoteBrowser.47kn08'),
      summary: tCurrent('auto.remoteBrowser.27vgqw'),
      checks: [
        tCurrent('auto.remoteBrowser.5ds2z1'),
        tCurrent('auto.remoteBrowser.1hpemmt'),
      ],
    };
  }

  if (/PROXY|SOCKS|TUNNEL|SOCKET_NOT_CONNECTED|-130|-111|-15/.test(signature)) {
    return {
      title: tCurrent('auto.remoteBrowser.9i6mad'),
      summary: tCurrent('auto.remoteBrowser.1jz0kpf'),
      checks: [
        tCurrent('auto.remoteBrowser.hsfk2p'),
        tCurrent('auto.remoteBrowser.1xwz4ng'),
      ],
    };
  }

  return {
    title: tCurrent('auto.remoteBrowser.dte5kz'),
    summary: tCurrent('auto.remoteBrowser.13bp659'),
    checks: [
      tCurrent('auto.remoteBrowser.12ri9mw'),
      tCurrent('auto.remoteBrowser.1ittmnw'),
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
      {name === 'home' ? <path d="M4.75 11.25 12 5.25l7.25 6M6.75 10v8.75h10.5V10M10 18.75v-4.5h4v4.5" /> : null}
      {name === 'more' ? <path d="M12 5.5v.01M12 12v.01M12 18.5v.01" /> : null}
      {name === 'panel' ? <path d="M5 7h14M5 12h14M5 17h9" /> : null}
      {name === 'reload' ? <path d="M18.4 8.2v4.6h-4.6M5.6 15.8v-4.6h4.6M17.65 12.8a5.75 5.75 0 0 1-9.85 3.15L5.6 13.75M6.35 11.2a5.75 5.75 0 0 1 9.85-3.15l2.2 2.2" /> : null}
      {name === 'route' ? <path d="M7 18a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm10-6a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM9.5 14.5l5-5" /> : null}
      {name === 'shield' ? <path d="M12 21s7-3.1 7-9V5l-7-2-7 2v7c0 5.9 7 9 7 9Zm-3.2-9.2 2 2 4.5-5" /> : null}
      {name === 'stop' ? <path d="M7 7h10v10H7z" /> : null}
    </svg>
  );
}

function RemoteBrowser({ connectionId, partition, bookmarkScope, context, onChromeChange }: RemoteBrowserProps) {
  const [browserAddress, setBrowserAddress] = useState(browserStartAddress);
  const [browserSrc, setBrowserSrc] = useState(browserBlankUrl);
  const [currentUrl, setCurrentUrl] = useState(browserBlankUrl);
  const [pageTitle, setPageTitle] = useState(browserStartPageTitle);
  const [loadError, setLoadError] = useState<BrowserLoadErrorState | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isTrustingCertificate, setIsTrustingCertificate] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [bookmarks, setBookmarks] = useState<BrowserBookmark[]>([]);
  const [recentVisits, setRecentVisits] = useState<BrowserRecentVisit[]>([]);
  const [isBookmarkBarOpen, setIsBookmarkBarOpen] = useState(false);
  const [isQuickPanelOpen, setIsQuickPanelOpen] = useState(false);
  const [showStartPage, setShowStartPage] = useState(true);
  const [startPagePortStatus, setStartPagePortStatus] = useState<Record<number, 'unknown' | 'open' | 'closed'>>({});
  const [bookmarkDraft, setBookmarkDraft] = useState<BrowserBookmarkDraft | null>(null);
  const [bookmarkMenu, setBookmarkMenu] = useState<BrowserBookmarkMenuState | null>(null);
  const [toolbarMenu, setToolbarMenu] = useState<BrowserToolbarMenuState | null>(null);
  const browserViewRef = useRef<BrowserWebview | null>(null);
  const isWebviewReadyRef = useRef(false);
  const isStartPageRef = useRef(true);
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

  const currentBookmark = showStartPage
    ? null
    : bookmarks.find((bookmark) => areBrowserUrlsEquivalent(bookmark.url, currentUrl)) ?? null;
  const activeBookmarkMenuBookmark = bookmarkMenu
    ? bookmarks.find((bookmark) => bookmark.id === bookmarkMenu.bookmarkId) ?? null
    : null;
  const quickTargets = getBrowserQuickTargets(context);
  const startPageCards = getBrowserStartPageCards(bookmarks);
  const startPageProbePorts = getBrowserStartProbePorts(startPageCards);
  const startPageProbeKey = startPageProbePorts.join(',');
  const addressProtocolLabel = showStartPage ? 'HOME' : getBrowserProtocolLabel(currentUrl);
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
    const fallbackUrl = browserSrc || currentUrl || browserBlankUrl;
    let resolvedUrl = canonicalizeBrowserUrl(nextUrl || fallbackUrl);
    let resolvedTitle = getBrowserTitle(resolvedUrl, nextTitle || '');
    let nextCanGoBack = false;
    let nextCanGoForward = false;
    let nextIsLoading = false;

    if (webview && isWebviewReadyRef.current) {
      try {
        resolvedUrl = canonicalizeBrowserUrl(nextUrl || webview.getURL() || fallbackUrl);
        resolvedTitle = getBrowserTitle(resolvedUrl, nextTitle || webview.getTitle() || '');
        nextCanGoBack = webview.canGoBack();
        nextCanGoForward = webview.canGoForward();
        nextIsLoading = webview.isLoading();
      } catch {
        resolvedUrl = canonicalizeBrowserUrl(nextUrl || fallbackUrl);
        resolvedTitle = getBrowserTitle(resolvedUrl, nextTitle || pageTitle);
      }
    } else {
      resolvedUrl = canonicalizeBrowserUrl(nextUrl || fallbackUrl);
      resolvedTitle = getBrowserTitle(resolvedUrl, nextTitle || pageTitle);
    }

    if (resolvedUrl === browserBlankUrl) {
      isStartPageRef.current = true;
      setShowStartPage(true);
      setCurrentUrl(browserBlankUrl);
      setBrowserAddress(browserStartAddress);
      setPageTitle(browserStartPageTitle);
      setCanGoBack(nextCanGoBack);
      setCanGoForward(nextCanGoForward);
      setIsLoading(false);
      return;
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
    if (!showStartPage) {
      return;
    }

    const ports = startPageProbePorts;

    if (!ports.length) {
      setStartPagePortStatus({});
      return;
    }

    let disposed = false;

    setStartPagePortStatus(() => {
      const nextStatus: Record<number, 'unknown' | 'open' | 'closed'> = {};

      for (const port of ports) {
        nextStatus[port] = 'unknown';
      }

      return nextStatus;
    });

    const runCommand = window.guiSSH?.connections?.runCommand;

    if (!runCommand) {
      return () => {
        disposed = true;
      };
    }

    void runCommand(connectionId, buildBrowserStartPortProbeCommand(ports)).then((result) => {
      if (disposed) {
        return;
      }

      const openPorts = result.code === 0
        ? getOpenPortsFromProbeOutput(result.stdout)
        : new Set<number>();
      const nextStatus: Record<number, 'unknown' | 'open' | 'closed'> = {};

      for (const port of ports) {
        nextStatus[port] = openPorts.has(port) ? 'open' : 'closed';
      }

      setStartPagePortStatus(nextStatus);
    }).catch(() => {
      if (!disposed) {
        setStartPagePortStatus(() => {
          const nextStatus: Record<number, 'unknown' | 'open' | 'closed'> = {};

          for (const port of ports) {
            nextStatus[port] = 'closed';
          }

          return nextStatus;
        });
      }
    });

    return () => {
      disposed = true;
    };
  }, [connectionId, showStartPage, startPageProbeKey]);

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

    const leaveStartPageForUrl = (url: string) => {
      if (url === browserBlankUrl) {
        return;
      }

      isStartPageRef.current = false;
      setShowStartPage(false);
    };

    const handleLoadCommit: EventListener = (event) => {
      const browserEvent = event as BrowserLoadCommitEvent;

      if (!browserEvent.isMainFrame) {
        return;
      }

      const nextUrl = canonicalizeBrowserUrl(browserEvent.url);
      leaveStartPageForUrl(nextUrl);
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
      leaveStartPageForUrl(nextUrl);
      setLoadError(null);

      if (nextUrl === browserBlankUrl) {
        syncNavigationState(nextUrl);
        return;
      }

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
      leaveStartPageForUrl(nextUrl);
      setLoadError(null);
      syncNavigationState(nextUrl);
      rememberRecentVisit(nextUrl);
    };
    const handleDidNavigateInPage: EventListener = (event) => {
      const browserEvent = event as BrowserNavigationEvent;
      const nextUrl = canonicalizeBrowserUrl(browserEvent.url);
      leaveStartPageForUrl(nextUrl);
      syncNavigationState(nextUrl);
      rememberRecentVisit(nextUrl);
    };
    const handleDidStartLoading = () => {
      const loadingUrl = canonicalizeBrowserUrl(webview.getURL() || browserSrc || currentUrl || browserBlankUrl);

      if (loadingUrl === browserBlankUrl) {
        setLoadError(null);
        syncNavigationState(loadingUrl);
        return;
      }

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

      const detailUrl = getUrlFromBrowserLoadErrorDetail(browserEvent.errorDescription);
      const failedUrl = canonicalizeBrowserUrl(detailUrl || browserEvent.validatedURL || webview.getURL() || browserSrc || currentUrl || browserBlankUrl);

      if (failedUrl === browserBlankUrl) {
        setLoadError(null);
        syncNavigationState(failedUrl);
        return;
      }

      if (browserEvent.errorCode !== -3) {
        setLoadError({
          kind: isCertificateLoadError(browserEvent.errorDescription, browserEvent.errorCode) ? 'certificate' : 'load',
          url: failedUrl,
          detail: browserEvent.errorDescription || tCurrent('auto.remoteBrowser.a4eeab'),
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
      const titleUrl = canonicalizeBrowserUrl(webview.getURL() || browserSrc || currentUrl || browserBlankUrl);

      if (titleUrl === browserBlankUrl) {
        syncNavigationState(titleUrl);
        return;
      }

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
      title: showStartPage ? '' : pageTitle || getBrowserTitle(currentUrl || browserAddress || defaultBrowserUrl),
      status: loadError ? tCurrent('auto.remoteBrowser.kvpltc') : showStartPage ? tCurrent('auto.remoteBrowser.z0eh122') : isLoading ? tCurrent('auto.remoteBrowser.1hlxe0e') : tCurrent('auto.remoteBrowser.1vu0k2a'),
      tone: loadError ? 'error' : isLoading ? 'loading' : 'idle',
    } as const;
    const payloadKey = `${payload.tone}\n${payload.status}\n${payload.title}`;

    if (payloadKey === lastChromePayloadRef.current) {
      return;
    }

    lastChromePayloadRef.current = payloadKey;
    onChromeChange(payload);
  }, [browserAddress, currentUrl, isLoading, loadError, onChromeChange, pageTitle, showStartPage]);

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

    if (nextUrl === browserBlankUrl) {
      openStartPage();
      return;
    }

    isStartPageRef.current = false;
    setShowStartPage(false);
    setIsQuickPanelOpen(false);

    if (!nextUrl) {
      setLoadError({
        kind: 'protocol',
        url: value.trim(),
        detail: tCurrent('auto.remoteBrowser.1lrjovw'),
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

  const openStartPage = () => {
    const webview = browserViewRef.current;

    isStartPageRef.current = true;
    setShowStartPage(true);
    setLoadError(null);
    setIsLoading(false);
    setIsQuickPanelOpen(false);
    setBrowserAddress(browserStartAddress);
    setCurrentUrl(browserBlankUrl);
    setPageTitle(browserStartPageTitle);
    setCanGoBack(false);
    setCanGoForward(false);
    setBrowserSrc(browserBlankUrl);

    if (!webview || !isWebviewReadyRef.current) {
      return;
    }

    try {
      webview.stop();
      void webview.loadURL(browserBlankUrl).catch(() => undefined);
    } catch {
      // Ignore webview teardown races while switching back to the internal start page.
    }
  };

  const continueWithInvalidCertificate = async (url: string) => {
    const nextUrl = resolveBrowserUrl(url);

    if (!nextUrl || !isHttpsBrowserUrl(nextUrl)) {
      setLoadError({
        kind: 'certificate',
        url,
        detail: tCurrent('auto.remoteBrowser.1nq1h7k'),
      });
      return;
    }

    const trustBrowserCertificate = window.guiSSH?.connections.trustBrowserCertificate;

    if (!trustBrowserCertificate) {
      setLoadError({
        kind: 'certificate',
        url: nextUrl,
        detail: tCurrent('auto.remoteBrowser.ebwnne'),
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

    if (action === 'home') {
      openStartPage();
      return;
    }

    if (!webview || !isWebviewReadyRef.current) {
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
    } else if (isLoading) {
      webview.stop();
    } else {
      webview.reload();
    }
  };

  const openBookmarkDraft = (bookmark?: BrowserBookmark | null) => {
    const sourceUrl = bookmark?.url || (showStartPage ? defaultBrowserUrl : currentUrl) || normalizeBrowserUrl(browserAddress);
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
        detail: tCurrent('auto.remoteBrowser.9ipm58'),
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
          <button type="button" onClick={() => navigateWebview('back')} disabled={!canGoBack} aria-label={tCurrent('auto.remoteBrowser.r5m4oz')} title={tCurrent('auto.remoteBrowser.r5m4oz2')}>
            <BrowserIcon name="arrow-left" />
          </button>
          <button type="button" onClick={() => navigateWebview('forward')} disabled={!canGoForward} aria-label={tCurrent('auto.remoteBrowser.be2j21')} title={tCurrent('auto.remoteBrowser.be2j212')}>
            <BrowserIcon name="arrow-right" />
          </button>
          <button
            type="button"
            onClick={() => navigateWebview('reload')}
            aria-label={isLoading ? tCurrent('auto.remoteBrowser.3vav5g') : tCurrent('auto.remoteBrowser.1a17ftx')}
            title={isLoading ? tCurrent('auto.remoteBrowser.3vav5g2') : tCurrent('auto.remoteBrowser.1a17ftx2')}
          >
            <BrowserIcon name={isLoading ? 'stop' : 'reload'} />
          </button>
          <button type="button" onClick={() => navigateWebview('home')} aria-label={tCurrent('auto.remoteBrowser.1uimc52')} title={tCurrent('auto.remoteBrowser.1qogcjh')}>
            <BrowserIcon name="home" />
          </button>
          <div className="browser-address-shell">
            <span className="browser-security-icon" aria-label={tCurrent('auto.remoteBrowser.1w6pnal', { value0: addressProtocolLabel })}>
              <BrowserIcon name="shield" />
              <em>{addressProtocolLabel}</em>
            </span>
            <input
              value={browserAddress}
              onChange={(event) => setBrowserAddress(event.target.value)}
              placeholder={tCurrent('auto.remoteBrowser.1isrg1t')}
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
                aria-label={currentBookmark ? tCurrent('auto.remoteBrowser.u0djar') : tCurrent('auto.remoteBrowser.mzw4n1')}
                title={currentBookmark ? tCurrent('auto.remoteBrowser.u0djar2') : tCurrent('auto.remoteBrowser.mzw4n12')}
              >
                <BrowserIcon name="star" filled={Boolean(currentBookmark)} />
              </button>

              {bookmarkDraft ? (
                <div ref={bookmarkPopoverRef} className="browser-bookmark-popover" role="dialog" aria-label={tCurrent('auto.remoteBrowser.1y73au8')}>
                  <div className="browser-bookmark-popover-header">
                    <strong>{bookmarkDraft.id ? tCurrent('auto.remoteBrowser.1tj2124') : tCurrent('auto.remoteBrowser.u0jxf6')}</strong>
                    <button type="button" aria-label={tCurrent('auto.remoteBrowser.14ipoko')} onClick={closeBookmarkDraft}>
                      ×
                    </button>
                  </div>

                  <label className="browser-bookmark-field">
                    <span>{tCurrent('auto.remoteBrowser.hzx914')}</span>
                    <input
                      value={bookmarkDraft.title}
                      onChange={(event) => updateBookmarkDraftField('title', event.target.value)}
                      onKeyDown={handleBookmarkDraftKeyDown}
                      placeholder={tCurrent('auto.remoteBrowser.tef9js')}
                    />
                  </label>

                  <label className="browser-bookmark-field">
                    <span>{tCurrent('auto.remoteBrowser.1qeky7x')}</span>
                    <input
                      value={bookmarkDraft.url}
                      onChange={(event) => updateBookmarkDraftField('url', event.target.value)}
                      onKeyDown={handleBookmarkDraftKeyDown}
                      placeholder="http://127.0.0.1/"
                    />
                  </label>

                  <div className="browser-bookmark-popover-actions">
                    <button type="button" className="primary" onClick={commitBookmarkDraft}>
                      {tCurrent('auto.remoteBrowser.1c3mapc')}</button>
                    <button type="button" onClick={closeBookmarkDraft}>
                      {tCurrent('auto.remoteBrowser.1589w37')}</button>
                    {bookmarkDraft.id ? (
                      <button type="button" className="danger-text" onClick={() => deleteBookmark(bookmarkDraft.id!)}>
                        {tCurrent('auto.remoteBrowser.1t2vi4h')}</button>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>

            <button type="submit" className="browser-go-button" aria-label={tCurrent('auto.remoteBrowser.1kqwl0m')} title={tCurrent('auto.remoteBrowser.1kqwl0m2')}>
              <BrowserIcon name="go" />
            </button>
            <button
              ref={toolbarMenuTriggerRef}
              type="button"
              className={`browser-overflow-button ${toolbarMenu ? 'active' : ''}`}
              aria-label={tCurrent('auto.remoteBrowser.13djrd')}
              aria-expanded={Boolean(toolbarMenu)}
              title={tCurrent('auto.remoteBrowser.1yyx3wq')}
              onClick={(event) => toggleToolbarMenu(event.currentTarget)}
            >
              <BrowserIcon name="more" />
            </button>
          </div>
        </form>

        {isQuickPanelOpen ? (
          <section className="browser-shortcut-panel" aria-label={tCurrent('auto.remoteBrowser.18vr6a0')}>
            <div className="browser-target-column">
              <strong>{tCurrent('auto.remoteBrowser.1m5og4v')}</strong>
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
                {tCurrent('auto.remoteBrowser.177rjv7')}</strong>
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
                <p>{tCurrent('auto.remoteBrowser.ija02q')}</p>
              )}
            </div>
          </section>
        ) : null}

        {isBookmarkBarOpen ? (
          <div className="browser-bookmark-bar">
            {bookmarks.length ? (
              <div className="browser-bookmark-list" aria-label={tCurrent('auto.remoteBrowser.1nxadi2')}>
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
                        aria-label={tCurrent('auto.remoteBrowser.cojylo')}
                        title={tCurrent('auto.remoteBrowser.cojylo2')}
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
                <span>{tCurrent('auto.remoteBrowser.118m1ju')}</span>
                <button type="button" onClick={() => openBookmarkDraft()}>
                  {tCurrent('auto.remoteBrowser.mzw4n13')}</button>
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
          aria-label={tCurrent('auto.remoteBrowser.5u66fz')}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              openBookmarkDraft(activeBookmarkMenuBookmark);
              setBookmarkMenu(null);
            }}
          >
            {tCurrent('auto.remoteBrowser.qreyeg')}</button>
          <button
            type="button"
            role="menuitem"
            className="danger-text"
            onClick={() => deleteBookmark(activeBookmarkMenuBookmark.id)}
          >
            {tCurrent('auto.remoteBrowser.1t2vi4h2')}</button>
        </div>,
        document.body,
      ) : null}

      {toolbarMenu ? createPortal(
        <div
          ref={toolbarMenuPopoverRef}
          className="browser-toolbar-menu-panel"
          style={{ left: toolbarMenu.x, top: toolbarMenu.y }}
          role="menu"
          aria-label={tCurrent('auto.remoteBrowser.13djrd2')}
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
            <span>{tCurrent('auto.remoteBrowser.16gvmo0')}</span>
            <em>{isQuickPanelOpen ? tCurrent('auto.remoteBrowser.gk08uy') : tCurrent('auto.remoteBrowser.12zbdao')}</em>
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
            <span>{tCurrent('auto.remoteBrowser.16oyw0u')}</span>
            <em>{isBookmarkBarOpen ? tCurrent('auto.remoteBrowser.f6y3nk') : tCurrent('auto.remoteBrowser.1x51kzl')}</em>
          </button>
        </div>,
        document.body,
      ) : null}

      <div className={`browser-viewport ${isLoading ? 'loading' : ''} ${showStartPage ? 'start' : ''}`}>
        <div className={`browser-progress ${isLoading ? 'visible' : ''}`} aria-hidden="true" />
        {showStartPage ? (
          <section className="browser-start-page" aria-label={tCurrent('auto.remoteBrowser.sy7nhr')}>
            <div className="browser-start-grid">
              {startPageCards.map((card) => {
                const probePort = getBrowserStartCardProbePort(card.url);
                const isOpen = Boolean(probePort && startPagePortStatus[probePort] === 'open');

                return (
                  <button
                    key={card.id}
                    type="button"
                    className={`browser-start-card ${isOpen ? 'open' : ''}`}
                    title={card.url}
                    onClick={() => loadBrowserUrl(card.url)}
                  >
                    <span className="browser-start-card-top">
                      <span className="browser-start-card-meta">
                        <span className="browser-start-card-dot" aria-hidden="true" />
                        {getBrowserStartCardMeta(card.url)}
                      </span>
                      <span className="browser-start-card-arrow" aria-hidden="true">
                        <BrowserIcon name="go" />
                      </span>
                    </span>
                    <strong>{card.title}</strong>
                    <small>{card.subtitle}</small>
                  </button>
                );
              })}
            </div>
          </section>
        ) : null}
        <webview
          ref={(element) => {
            browserViewRef.current = element as BrowserWebview | null;
          }}
          className={`remote-webview ${showStartPage ? 'hidden' : ''}`}
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
                    {isTrustingCertificate ? tCurrent('auto.remoteBrowser.avwp1u') : tCurrent('auto.remoteBrowser.qmibsc')}
                  </button>
                ) : null}
                {loadError.kind === 'load' ? (
                  <button type="button" onClick={() => loadBrowserUrl(loadError.url)}>
                    {tCurrent('auto.remoteBrowser.1ghz5wv')}</button>
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    setLoadError(null);
                    setIsQuickPanelOpen(true);
                  }}
                >
                  {tCurrent('auto.remoteBrowser.1pb3g2r')}</button>
              </footer>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

export default RemoteBrowser;
