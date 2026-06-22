import { type RefObject } from 'react';
import { createPortal } from 'react-dom';

import { tCurrent } from '../../i18n';

import type { BrowserBookmark, BrowserBookmarkMenuState, BrowserToolbarMenuState } from './browserTypes';

interface BrowserFloatingMenusProps {
  bookmarkMenu: BrowserBookmarkMenuState | null;
  activeBookmarkMenuBookmark: BrowserBookmark | null;
  toolbarMenu: BrowserToolbarMenuState | null;
  isQuickPanelOpen: boolean;
  isBookmarkBarOpen: boolean;
  bookmarkMenuPopoverRef: RefObject<HTMLDivElement | null>;
  toolbarMenuPopoverRef: RefObject<HTMLDivElement | null>;
  onOpenBookmarkDraft: (bookmark: BrowserBookmark) => void;
  onClearBookmarkMenu: () => void;
  onDeleteBookmark: (bookmarkId: string) => void;
  onToggleQuickPanel: () => void;
  onToggleBookmarkBar: () => void;
}

function BrowserFloatingMenus({
  bookmarkMenu,
  activeBookmarkMenuBookmark,
  toolbarMenu,
  isQuickPanelOpen,
  isBookmarkBarOpen,
  bookmarkMenuPopoverRef,
  toolbarMenuPopoverRef,
  onOpenBookmarkDraft,
  onClearBookmarkMenu,
  onDeleteBookmark,
  onToggleQuickPanel,
  onToggleBookmarkBar,
}: BrowserFloatingMenusProps) {
  return (
    <>
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
              onOpenBookmarkDraft(activeBookmarkMenuBookmark);
              onClearBookmarkMenu();
            }}
          >
            {tCurrent('auto.remoteBrowser.qreyeg')}</button>
          <button
            type="button"
            role="menuitem"
            className="danger-text"
            onClick={() => onDeleteBookmark(activeBookmarkMenuBookmark.id)}
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
            onClick={onToggleQuickPanel}
          >
            <span>{tCurrent('auto.remoteBrowser.16gvmo0')}</span>
            <em>{isQuickPanelOpen ? tCurrent('auto.remoteBrowser.gk08uy') : tCurrent('auto.remoteBrowser.12zbdao')}</em>
          </button>
          <button
            type="button"
            role="menuitem"
            className={isBookmarkBarOpen ? 'active' : ''}
            onClick={onToggleBookmarkBar}
          >
            <span>{tCurrent('auto.remoteBrowser.16oyw0u')}</span>
            <em>{isBookmarkBarOpen ? tCurrent('auto.remoteBrowser.f6y3nk') : tCurrent('auto.remoteBrowser.1x51kzl')}</em>
          </button>
        </div>,
        document.body,
      ) : null}
    </>
  );
}

export default BrowserFloatingMenus;
