import { type FormEvent, type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from 'react';

import { tCurrent } from '../../i18n';

import BrowserChrome from './BrowserChrome';
import BrowserFloatingMenus from './BrowserFloatingMenus';
import BrowserViewport from './BrowserViewport';
import { getErrorMessage } from './desktopUtils';
import {
  createBookmarkId,
  getBrowserProtocolLabel,
  isBrowserBookmark,
  normalizeBookmarks,
  readBrowserBookmarkBarOpen,
  readBrowserRecentVisits,
  writeBrowserBookmarkBarOpen,
  writeBrowserRecentVisits,
} from './browserBookmarkUtils';
import {
  buildBrowserStartPortProbeCommand,
  getBrowserQuickTargets,
  getBrowserStartPageCards,
  getBrowserStartProbePorts,
  getOpenPortsFromProbeOutput,
} from './browserPortProbe';
import type {
  BrowserBookmark,
  BrowserBookmarkDraft,
  BrowserBookmarkMenuState,
  BrowserLoadErrorState,
  BrowserRecentVisit,
  BrowserToolbarMenuState,
  RemoteBrowserProps,
} from './browserTypes';
import {
  areBrowserUrlsEquivalent,
  browserBlankUrl,
  browserStartAddress,
  browserStartPageTitle,
  canonicalizeBrowserUrl,
  defaultBrowserUrl,
  getBrowserTitle,
  isCertificateLoadError,
  isHttpsBrowserUrl,
  normalizeBrowserUrl,
  recentVisitLimit,
  resolveBrowserUrl,
} from './browserUrlUtils';

function RemoteBrowser({ connectionId, partition, bookmarkScope, context, initialUrl, onChromeChange }: RemoteBrowserProps) {
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
  const [browserFrameKey, setBrowserFrameKey] = useState(0);
  const browserViewRef = useRef<HTMLIFrameElement | null>(null);
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
  const browserNavigationRequestRef = useRef(0);
  const initialUrlRequestRef = useRef('');

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
    const fallbackUrl = browserSrc || currentUrl || browserBlankUrl;
    let resolvedUrl = canonicalizeBrowserUrl(nextUrl || fallbackUrl);
    let resolvedTitle = getBrowserTitle(resolvedUrl, nextTitle || '');
    resolvedUrl = canonicalizeBrowserUrl(nextUrl || fallbackUrl);
    resolvedTitle = getBrowserTitle(resolvedUrl, nextTitle || pageTitle);

    if (resolvedUrl === browserBlankUrl) {
      isStartPageRef.current = true;
      setShowStartPage(true);
      setCurrentUrl(browserBlankUrl);
      setBrowserAddress(browserStartAddress);
      setPageTitle(browserStartPageTitle);
      setCanGoBack(false);
      setCanGoForward(false);
      setIsLoading(false);
      return;
    }

    setCurrentUrl(resolvedUrl);
    setBrowserAddress(resolvedUrl);
    setPageTitle(resolvedTitle);
    setCanGoBack(false);
    setCanGoForward(false);
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

    if (!guiSSH?.vault || !areBookmarksReadyRef.current) {
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

    void readBrowserRecentVisits(bookmarkScope, recentVisitLimit).then((storedVisits) => {
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
    const frame = browserViewRef.current;

    if (!frame || showStartPage) {
      return;
    }

    const loadedUrl = canonicalizeBrowserUrl(currentUrl || browserSrc || browserBlankUrl);
    const handleLoad = () => {
      isWebviewReadyRef.current = true;
      setLoadError(null);
      setIsLoading(false);
      syncNavigationState(loadedUrl);
      rememberRecentVisit(loadedUrl);
    };
    const handleError = () => {
      if (loadedUrl === browserBlankUrl) {
        return;
      }
      setLoadError({
        kind: 'load',
        url: loadedUrl,
        detail: tCurrent('auto.remoteBrowser.a4eeab'),
      });
      setIsLoading(false);
    };

    frame.addEventListener('load', handleLoad);
    frame.addEventListener('error', handleError);

    return () => {
      isWebviewReadyRef.current = false;
      frame.removeEventListener('load', handleLoad);
      frame.removeEventListener('error', handleError);
    };
  }, [browserFrameKey, browserSrc, currentUrl, showStartPage]);

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

  const loadBrowserUrl = async (value: string) => {
    const nextUrl = resolveBrowserUrl(value);

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
    const requestId = browserNavigationRequestRef.current + 1;
    browserNavigationRequestRef.current = requestId;

    try {
      const resolved = await window.guiSSH?.connections?.resolveBrowserUrl?.(connectionId, nextUrl);
      if (browserNavigationRequestRef.current !== requestId) {
        return;
      }
      const nextBrowserSrc = resolved?.browserUrl || nextUrl;
      if (!showStartPage && nextBrowserSrc === browserSrc) {
        setBrowserFrameKey((value) => value + 1);
      }
      setBrowserSrc(nextBrowserSrc);
    } catch (error) {
      if (browserNavigationRequestRef.current !== requestId) {
        return;
      }
      const detail = getErrorMessage(error);
      setLoadError({
        kind: isCertificateLoadError(detail) ? 'certificate' : 'load',
        url: nextUrl,
        detail,
      });
      setIsLoading(false);
    }
  };

  useEffect(() => {
    const nextInitialUrl = initialUrl?.trim();

    if (!nextInitialUrl || initialUrlRequestRef.current === nextInitialUrl) {
      return;
    }

    initialUrlRequestRef.current = nextInitialUrl;
    void loadBrowserUrl(nextInitialUrl);
  }, [initialUrl]);

  const openStartPage = () => {
    browserNavigationRequestRef.current += 1;
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
    if (action === 'home') {
      openStartPage();
      return;
    }

    if (action === 'back' || action === 'forward') {
      return;
    }

    if (isLoading) {
      setBrowserSrc(browserBlankUrl);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setBrowserFrameKey((value) => value + 1);
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
      <BrowserChrome
        browserAddress={browserAddress} setBrowserAddress={setBrowserAddress}
        addressProtocolLabel={addressProtocolLabel} isLoading={isLoading}
        canGoBack={canGoBack} canGoForward={canGoForward}
        currentUrl={currentUrl} currentBookmark={currentBookmark}
        bookmarks={bookmarks} recentVisits={recentVisits} quickTargets={quickTargets}
        isQuickPanelOpen={isQuickPanelOpen} isBookmarkBarOpen={isBookmarkBarOpen}
        bookmarkDraft={bookmarkDraft} bookmarkMenu={bookmarkMenu} toolbarMenu={toolbarMenu}
        bookmarkTriggerRef={bookmarkTriggerRef} bookmarkPopoverRef={bookmarkPopoverRef}
        toolbarMenuTriggerRef={toolbarMenuTriggerRef} bookmarkMenuTriggerRefs={bookmarkMenuTriggerRefs}
        onSubmitAddress={submitBrowserAddress}
        onNavigateWebview={navigateWebview}
        onNavigateUrl={(url) => void loadBrowserUrl(url)}
        onOpenBookmarkDraft={openBookmarkDraft}
        onCloseBookmarkDraft={closeBookmarkDraft}
        onUpdateBookmarkDraftField={updateBookmarkDraftField}
        onBookmarkDraftKeyDown={handleBookmarkDraftKeyDown}
        onCommitBookmarkDraft={commitBookmarkDraft}
        onDeleteBookmark={deleteBookmark}
        onToggleBookmarkMenu={toggleBookmarkMenu}
        onToggleToolbarMenu={toggleToolbarMenu}
      />

      <BrowserFloatingMenus
        bookmarkMenu={bookmarkMenu} activeBookmarkMenuBookmark={activeBookmarkMenuBookmark}
        toolbarMenu={toolbarMenu} isQuickPanelOpen={isQuickPanelOpen} isBookmarkBarOpen={isBookmarkBarOpen}
        bookmarkMenuPopoverRef={bookmarkMenuPopoverRef} toolbarMenuPopoverRef={toolbarMenuPopoverRef}
        onOpenBookmarkDraft={openBookmarkDraft}
        onClearBookmarkMenu={() => setBookmarkMenu(null)}
        onDeleteBookmark={deleteBookmark}
        onToggleQuickPanel={() => {
          setIsQuickPanelOpen((open) => !open);
          setToolbarMenu(null);
        }}
        onToggleBookmarkBar={() => {
          toggleBookmarkBar();
          setToolbarMenu(null);
        }}
      />

      <BrowserViewport
        isLoading={isLoading} showStartPage={showStartPage}
        startPageCards={startPageCards} startPagePortStatus={startPagePortStatus}
        browserFrameKey={browserFrameKey} browserSrc={browserSrc}
        pageTitle={pageTitle} browserAddress={browserAddress}
        loadError={loadError} isTrustingCertificate={isTrustingCertificate}
        browserViewRef={browserViewRef}
        onNavigate={(url) => void loadBrowserUrl(url)}
        onTrustCertificate={(url) => void continueWithInvalidCertificate(url)}
        onClearErrorAndOpenQuickPanel={() => {
          setLoadError(null);
          setIsQuickPanelOpen(true);
        }}
      />
    </div>
  );
}

export default RemoteBrowser;
