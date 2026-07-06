import { type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';

import { tCurrent } from '../../i18n';

import BrowserIcon from './BrowserIcon';
import type {
  BrowserBookmark,
  BrowserBookmarkDraft,
  BrowserBookmarkMenuState,
  BrowserQuickTarget,
  BrowserRecentVisit,
  BrowserToolbarMenuState,
} from './browserTypes';
import { getBookmarkAccent, getBookmarkMonogram } from './browserBookmarkUtils';
import { areBrowserUrlsEquivalent } from './browserUrlUtils';

interface BrowserChromeProps {
  browserAddress: string;
  setBrowserAddress: (value: string) => void;
  addressProtocolLabel: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  currentUrl: string;
  currentBookmark: BrowserBookmark | null;
  bookmarks: BrowserBookmark[];
  recentVisits: BrowserRecentVisit[];
  quickTargets: BrowserQuickTarget[];
  isQuickPanelOpen: boolean;
  isBookmarkBarOpen: boolean;
  bookmarkDraft: BrowserBookmarkDraft | null;
  bookmarkMenu: BrowserBookmarkMenuState | null;
  toolbarMenu: BrowserToolbarMenuState | null;
  bookmarkTriggerRef: RefObject<HTMLDivElement | null>;
  bookmarkPopoverRef: RefObject<HTMLDivElement | null>;
  toolbarMenuTriggerRef: RefObject<HTMLButtonElement | null>;
  bookmarkMenuTriggerRefs: RefObject<Map<string, HTMLButtonElement>>;
  onSubmitAddress: (event: FormEvent<HTMLFormElement>) => void;
  onNavigateWebview: (action: 'back' | 'forward' | 'reload' | 'home') => void;
  onNavigateUrl: (url: string) => void;
  onOpenBookmarkDraft: (bookmark?: BrowserBookmark | null) => void;
  onCloseBookmarkDraft: () => void;
  onUpdateBookmarkDraftField: (field: keyof BrowserBookmarkDraft, value: string | null) => void;
  onBookmarkDraftKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  onCommitBookmarkDraft: () => void;
  onDeleteBookmark: (bookmarkId: string) => void;
  onToggleBookmarkMenu: (bookmark: BrowserBookmark, element: HTMLButtonElement) => void;
  onToggleToolbarMenu: (element: HTMLButtonElement) => void;
}

function BrowserChrome({
  browserAddress,
  setBrowserAddress,
  addressProtocolLabel,
  isLoading,
  canGoBack,
  canGoForward,
  currentUrl,
  currentBookmark,
  bookmarks,
  recentVisits,
  quickTargets,
  isQuickPanelOpen,
  isBookmarkBarOpen,
  bookmarkDraft,
  bookmarkMenu,
  toolbarMenu,
  bookmarkTriggerRef,
  bookmarkPopoverRef,
  toolbarMenuTriggerRef,
  bookmarkMenuTriggerRefs,
  onSubmitAddress,
  onNavigateWebview,
  onNavigateUrl,
  onOpenBookmarkDraft,
  onCloseBookmarkDraft,
  onUpdateBookmarkDraftField,
  onBookmarkDraftKeyDown,
  onCommitBookmarkDraft,
  onDeleteBookmark,
  onToggleBookmarkMenu,
  onToggleToolbarMenu,
}: BrowserChromeProps) {
  return (
    <div className="browser-chrome">
      <form className="browser-toolbar" onSubmit={onSubmitAddress}>
        <button type="button" onClick={() => onNavigateWebview('back')} disabled={!canGoBack} aria-label={tCurrent('auto.remoteBrowser.r5m4oz')} title={tCurrent('auto.remoteBrowser.r5m4oz2')}>
          <BrowserIcon name="arrow-left" />
        </button>
        <button type="button" onClick={() => onNavigateWebview('forward')} disabled={!canGoForward} aria-label={tCurrent('auto.remoteBrowser.be2j21')} title={tCurrent('auto.remoteBrowser.be2j212')}>
          <BrowserIcon name="arrow-right" />
        </button>
        <button
          type="button"
          onClick={() => onNavigateWebview('reload')}
          aria-label={isLoading ? tCurrent('auto.remoteBrowser.3vav5g') : tCurrent('auto.remoteBrowser.1a17ftx')}
          title={isLoading ? tCurrent('auto.remoteBrowser.3vav5g2') : tCurrent('auto.remoteBrowser.1a17ftx2')}
        >
          <BrowserIcon name={isLoading ? 'stop' : 'reload'} />
        </button>
        <button type="button" onClick={() => onNavigateWebview('home')} aria-label={tCurrent('auto.remoteBrowser.1uimc52')} title={tCurrent('auto.remoteBrowser.1qogcjh')}>
          <BrowserIcon name="home" />
        </button>
        <div className="browser-address-shell">
          <span className="browser-security-icon" aria-label={tCurrent('auto.remoteBrowser.1w6pnal', { value0: addressProtocolLabel })}>
            <BrowserIcon name="shield" />
            <em>{addressProtocolLabel}</em>
          </span>
          <input
            data-testid="browser-address-input"
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
              onClick={() => onOpenBookmarkDraft(currentBookmark)}
              aria-label={currentBookmark ? tCurrent('auto.remoteBrowser.u0djar') : tCurrent('auto.remoteBrowser.mzw4n1')}
              title={currentBookmark ? tCurrent('auto.remoteBrowser.u0djar2') : tCurrent('auto.remoteBrowser.mzw4n12')}
            >
              <BrowserIcon name="star" filled={Boolean(currentBookmark)} />
            </button>

            {bookmarkDraft ? (
              <div ref={bookmarkPopoverRef} className="browser-bookmark-popover" role="dialog" aria-label={tCurrent('auto.remoteBrowser.1y73au8')}>
                <div className="browser-bookmark-popover-header">
                  <strong>{bookmarkDraft.id ? tCurrent('auto.remoteBrowser.1tj2124') : tCurrent('auto.remoteBrowser.u0jxf6')}</strong>
                  <button type="button" aria-label={tCurrent('auto.remoteBrowser.14ipoko')} onClick={onCloseBookmarkDraft}>
                    ×
                  </button>
                </div>

                <label className="browser-bookmark-field">
                  <span>{tCurrent('auto.remoteBrowser.hzx914')}</span>
                  <input
                    value={bookmarkDraft.title}
                    onChange={(event) => onUpdateBookmarkDraftField('title', event.target.value)}
                    onKeyDown={onBookmarkDraftKeyDown}
                    placeholder={tCurrent('auto.remoteBrowser.tef9js')}
                  />
                </label>

                <label className="browser-bookmark-field">
                  <span>{tCurrent('auto.remoteBrowser.1qeky7x')}</span>
                  <input
                    value={bookmarkDraft.url}
                    onChange={(event) => onUpdateBookmarkDraftField('url', event.target.value)}
                    onKeyDown={onBookmarkDraftKeyDown}
                    placeholder="http://127.0.0.1/"
                  />
                </label>

                <div className="browser-bookmark-popover-actions">
                  <button type="button" className="primary" onClick={onCommitBookmarkDraft}>
                    {tCurrent('auto.remoteBrowser.1c3mapc')}</button>
                  <button type="button" onClick={onCloseBookmarkDraft}>
                    {tCurrent('auto.remoteBrowser.1589w37')}</button>
                  {bookmarkDraft.id ? (
                    <button type="button" className="danger-text" onClick={() => onDeleteBookmark(bookmarkDraft.id!)}>
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
            onClick={(event) => onToggleToolbarMenu(event.currentTarget)}
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
                  onClick={() => onNavigateUrl(target.url)}
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
                  <button key={visit.url} type="button" title={visit.url} onClick={() => onNavigateUrl(visit.url)}>
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
                    <button type="button" className="browser-bookmark-link" onClick={() => onNavigateUrl(bookmark.url)} title={bookmark.url}>
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
                        onToggleBookmarkMenu(bookmark, event.currentTarget);
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
              <button type="button" onClick={() => onOpenBookmarkDraft()}>
                {tCurrent('auto.remoteBrowser.mzw4n13')}</button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

export default BrowserChrome;
