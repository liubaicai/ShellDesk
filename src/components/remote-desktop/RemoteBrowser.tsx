import { type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { getErrorMessage } from './desktopUtils';

const defaultBrowserUrl = 'http://127.0.0.1/';

interface RemoteBrowserProps {
  partition: string;
  bookmarkScope: string;
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

function normalizeBrowserUrl(value: string) {
  const url = value.trim();

  if (!url) {
    return defaultBrowserUrl;
  }

  if (/^about:blank$/i.test(url)) {
    return 'about:blank';
  }

  if (/^https?:\/\//i.test(url)) {
    return canonicalizeBrowserUrl(url);
  }

  return canonicalizeBrowserUrl(`http://${url}`);
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
  return bookmarks.map((bookmark) => ({
    ...bookmark,
    title: bookmark.title.trim() || getBrowserTitle(bookmark.url),
    url: normalizeBrowserUrl(bookmark.url),
  }));
}

function RemoteBrowser({ partition, bookmarkScope, onChromeChange }: RemoteBrowserProps) {
  const [browserAddress, setBrowserAddress] = useState(defaultBrowserUrl);
  const [browserSrc, setBrowserSrc] = useState(defaultBrowserUrl);
  const [currentUrl, setCurrentUrl] = useState(defaultBrowserUrl);
  const [pageTitle, setPageTitle] = useState(getBrowserTitle(defaultBrowserUrl));
  const [loadError, setLoadError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [bookmarks, setBookmarks] = useState<BrowserBookmark[]>([]);
  const [bookmarkDraft, setBookmarkDraft] = useState<BrowserBookmarkDraft | null>(null);
  const [bookmarkMenu, setBookmarkMenu] = useState<BrowserBookmarkMenuState | null>(null);
  const browserViewRef = useRef<BrowserWebview | null>(null);
  const isWebviewReadyRef = useRef(false);
  const bookmarkTriggerRef = useRef<HTMLDivElement | null>(null);
  const bookmarkPopoverRef = useRef<HTMLDivElement | null>(null);
  const bookmarkMenuPopoverRef = useRef<HTMLDivElement | null>(null);
  const bookmarkMenuTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const lastPersistedBookmarksRef = useRef('');
  const areBookmarksReadyRef = useRef(false);

  const currentBookmark = bookmarks.find((bookmark) => areBrowserUrlsEquivalent(bookmark.url, currentUrl)) ?? null;
  const activeBookmarkMenuBookmark = bookmarkMenu
    ? bookmarks.find((bookmark) => bookmark.id === bookmarkMenu.bookmarkId) ?? null
    : null;

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
      setLoadError('');
      syncNavigationState(nextUrl);
    };
    const handleDidStartNavigation: EventListener = (event) => {
      const browserEvent = event as BrowserNavigationEvent;

      if (!browserEvent.isMainFrame) {
        return;
      }

      const nextUrl = canonicalizeBrowserUrl(browserEvent.url);
      setLoadError('');
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
      setLoadError('');
      syncNavigationState(nextUrl);
    };
    const handleDidNavigateInPage: EventListener = (event) => {
      const browserEvent = event as BrowserNavigationEvent;
      const nextUrl = canonicalizeBrowserUrl(browserEvent.url);
      syncNavigationState(nextUrl);
    };
    const handleDidStartLoading = () => {
      setLoadError('');
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
        setLoadError(`${browserEvent.errorDescription || '页面加载失败。'} (${browserEvent.errorCode})`);
      }

      setIsLoading(false);
      syncNavigationState(failedUrl);
    };
    const handlePageTitleUpdated: EventListener = (event) => {
      const browserEvent = event as BrowserTitleUpdatedEvent;
      syncNavigationState(undefined, browserEvent.title);
    };
    const handleDomReady = (_event: Event) => {
      isWebviewReadyRef.current = true;
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
    onChromeChange?.({
      title: pageTitle || getBrowserTitle(currentUrl || browserAddress || defaultBrowserUrl),
      status: loadError ? '加载失败' : isLoading ? '加载中' : '已就绪',
      tone: loadError ? 'error' : isLoading ? 'loading' : 'idle',
    });
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

  const loadBrowserUrl = (value: string) => {
    const nextUrl = normalizeBrowserUrl(value);
    const webview = browserViewRef.current;

    setLoadError('');
    setBrowserAddress(nextUrl);
    setCurrentUrl(nextUrl);
    setPageTitle(getBrowserTitle(nextUrl));
    setIsLoading(true);

    if (!webview || !isWebviewReadyRef.current) {
      setBrowserSrc(nextUrl);
      return;
    }

    void webview.loadURL(nextUrl).catch((error: unknown) => {
      setLoadError(getErrorMessage(error));
    });
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
        setLoadError('');
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

  const updateBookmarkDraftField = (field: keyof BrowserBookmarkDraft, value: string | null) => {
    setBookmarkDraft((currentDraft) => (
      currentDraft ? { ...currentDraft, [field]: value } : currentDraft
    ));
  };

  const commitBookmarkDraft = () => {
    if (!bookmarkDraft) {
      return;
    }

    const normalizedUrl = normalizeBrowserUrl(bookmarkDraft.url);
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
            ←
          </button>
          <button type="button" onClick={() => navigateWebview('forward')} disabled={!canGoForward} aria-label="前进" title="前进">
            →
          </button>
          <button
            type="button"
            onClick={() => navigateWebview('reload')}
            aria-label={isLoading ? '停止加载' : '刷新页面'}
            title={isLoading ? '停止加载' : '刷新页面'}
          >
            {isLoading ? '×' : '↻'}
          </button>
          <button type="button" onClick={() => navigateWebview('home')} aria-label="打开主页" title="主页">
            ⌂
          </button>
          <div className="browser-address-shell">
            <span className="browser-security-icon" aria-hidden="true">▣</span>
            <input
              value={browserAddress}
              onChange={(event) => setBrowserAddress(event.target.value)}
              placeholder="搜索或输入网址"
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
                {currentBookmark ? '★' : '☆'}
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

            <button type="button" className="browser-menu-button" aria-label="浏览器菜单" title="菜单">
              ☰
            </button>
            <button type="submit" className="browser-kebab-button" aria-label="打开地址" title="打开地址">
              ⋮
            </button>
          </div>
        </form>

        {bookmarks.length ? (
        <div className="browser-bookmark-bar">
          <div className="browser-bookmark-list" aria-label="书签栏">
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
                      ⋯
                    </button>
                  </div>
                );
              })}
          </div>
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

      {loadError ? <div className="browser-error-banner">{loadError}</div> : null}

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
      </div>
    </div>
  );
}

export default RemoteBrowser;
