import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  memo,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  Suspense,
  useEffect,
  useRef,
} from 'react';

import { t } from '../../i18n';
import type { DesktopWindowFrame, DesktopWindowState } from '../../remoteDesktopWindowModel';
import { DesktopAppIcon } from './RemoteDesktopAppIcon';

interface RemoteDesktopWindowProps {
  appLabel: string;
  desktopWindow: DesktopWindowState;
  isFocused: boolean;
  isTerminalTitlebarMenuOpen: boolean;
  language: ShellDeskAppSettings['language'];
  livePointerFrame: DesktopWindowFrame | null;
  renderSettings: ShellDeskAppSettings;
  onBringToFront: (windowId: string) => void;
  onClose: (windowId: string) => void;
  onFinishInteraction: (event: ReactPointerEvent<HTMLElement>) => void;
  onKeyboardFrameChange: (windowId: string, mode: 'move' | 'resize', deltaX: number, deltaY: number) => void;
  onMinimize: (windowId: string) => void;
  onOpenTerminalTitlebarMenu: (windowId: string, buttonRect: DOMRect) => void;
  onResizePointerDown: (event: ReactPointerEvent<HTMLElement>, windowId: string) => void;
  onTitlebarPointerDown: (event: ReactPointerEvent<HTMLElement>, windowId: string) => void;
  onToggleMaximize: (windowId: string) => void;
  onUpdateInteraction: (event: ReactPointerEvent<HTMLElement>) => void;
  renderContent: (desktopWindow: DesktopWindowState) => ReactNode;
}

const RemoteDesktopWindow = memo(function RemoteDesktopWindow({
  appLabel,
  desktopWindow,
  isFocused,
  isTerminalTitlebarMenuOpen,
  language,
  livePointerFrame,
  onBringToFront,
  onClose,
  onFinishInteraction,
  onKeyboardFrameChange,
  onMinimize,
  onOpenTerminalTitlebarMenu,
  onResizePointerDown,
  onTitlebarPointerDown,
  onToggleMaximize,
  onUpdateInteraction,
  renderContent,
}: RemoteDesktopWindowProps) {
  const windowRef = useRef<HTMLElement | null>(null);
  const wasFocusedRef = useRef(false);
  const renderedFrame = livePointerFrame ?? desktopWindow.frame;
  const desktopWindowStyle: CSSProperties = {
    width: renderedFrame.width,
    height: renderedFrame.height,
    transform: `translate3d(${renderedFrame.x}px, ${renderedFrame.y}px, 0)`,
    zIndex: 10 + desktopWindow.zIndex,
  };
  const titleId = `desktop-window-title-${desktopWindow.id}`;

  useEffect(() => {
    if (
      isFocused
      && !wasFocusedRef.current
      && !desktopWindow.isMinimized
      && !windowRef.current?.contains(document.activeElement)
    ) {
      windowRef.current?.focus({ preventScroll: true });
    }

    wasFocusedRef.current = isFocused;
  }, [desktopWindow.isMinimized, isFocused]);

  const handleTitlebarKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!event.altKey || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      return;
    }

    event.preventDefault();
    const step = 16;
    const deltaX = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
    const deltaY = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
    onKeyboardFrameChange(desktopWindow.id, event.shiftKey ? 'resize' : 'move', deltaX, deltaY);
  };

  return (
    <section
      ref={windowRef}
      className={`desktop-window desktop-window-${desktopWindow.appKey} ${isFocused ? 'focused' : ''} ${desktopWindow.isMaximized ? 'maximized' : ''} ${desktopWindow.isMinimized ? 'minimized' : ''}`}
      role="dialog"
      aria-labelledby={titleId}
      aria-hidden={desktopWindow.isMinimized}
      tabIndex={-1}
      style={desktopWindowStyle}
      onPointerDownCapture={() => onBringToFront(desktopWindow.id)}
    >
      <header
        className="desktop-window-titlebar"
        tabIndex={0}
        aria-label={t('desktop.window.keyboardMoveHint', language, { app: appLabel })}
        onPointerDown={(event) => onTitlebarPointerDown(event, desktopWindow.id)}
        onKeyDown={handleTitlebarKeyDown}
        onPointerMove={onUpdateInteraction}
        onPointerUp={onFinishInteraction}
        onPointerCancel={onFinishInteraction}
      >
        <div id={titleId} className="desktop-window-title">
          <span className={`desktop-title-icon desktop-app-icon-${desktopWindow.appKey}`}>
            <DesktopAppIcon appKey={desktopWindow.appKey} />
          </span>
          {desktopWindow.appKey === 'browser' ? (
            <>
              <span className="desktop-window-kicker">{appLabel}</span>
              {desktopWindow.chromeTitle ? (
                <strong title={desktopWindow.chromeTitle}>
                  {desktopWindow.chromeTitle}
                </strong>
              ) : null}
              {desktopWindow.chromeStatus ? (
                <span className={`desktop-window-state-pill ${desktopWindow.chromeTone || 'idle'}`}>
                  {desktopWindow.chromeStatus}
                </span>
              ) : null}
            </>
          ) : desktopWindow.appKey === 'terminal' ? (
            <>
              <strong title={desktopWindow.chromeTitle || appLabel}>
                {desktopWindow.chromeTitle || appLabel}
              </strong>
              {desktopWindow.chromeStatus && desktopWindow.chromeTone !== 'idle' ? (
                <span className={`desktop-window-state-pill ${desktopWindow.chromeTone || 'idle'}`}>
                  {desktopWindow.chromeStatus}
                </span>
              ) : null}
            </>
          ) : (
            <strong>{appLabel}</strong>
          )}
        </div>
        <div className="win-titlebar-controls" aria-label={t('desktop.window.controls', language)} onPointerDown={(event) => event.stopPropagation()}>
          {desktopWindow.appKey === 'terminal' ? (
            <button
              type="button"
              className={`win-btn terminal-tools ${isTerminalTitlebarMenuOpen ? 'active' : ''}`}
              aria-label={t('terminal.titlebar.tools', language)}
              aria-haspopup="menu"
              aria-expanded={isTerminalTitlebarMenuOpen}
              title={t('terminal.titlebar.tools', language)}
              onClick={(event) => onOpenTerminalTitlebarMenu(desktopWindow.id, event.currentTarget.getBoundingClientRect())}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <circle cx="2" cy="6" r="1.2" fill="currentColor" />
                <circle cx="6" cy="6" r="1.2" fill="currentColor" />
                <circle cx="10" cy="6" r="1.2" fill="currentColor" />
              </svg>
            </button>
          ) : null}
          <button type="button" className="win-btn minimize" aria-label={t('desktop.window.minimize', language)} title={t('desktop.window.minimizeTitle', language)} onClick={() => onMinimize(desktopWindow.id)}>
            <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor" /></svg>
          </button>
          <button
            type="button"
            className="win-btn maximize"
            aria-label={desktopWindow.isMaximized ? t('desktop.window.restoreWindow', language) : t('desktop.window.maximizeWindow', language)}
            title={desktopWindow.isMaximized ? t('desktop.window.restoreTitle', language) : t('desktop.window.maximizeTitle', language)}
            onClick={() => onToggleMaximize(desktopWindow.id)}
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
          <button type="button" className="win-btn close" aria-label={t('desktop.window.close', language)} title={t('desktop.window.closeTitle', language)} onClick={() => onClose(desktopWindow.id)}>
            <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1.2">
              <line x1="1" y1="1" x2="9" y2="9" />
              <line x1="9" y1="1" x2="1" y2="9" />
            </svg>
          </button>
        </div>
      </header>
      <div className="desktop-window-body">
        <Suspense fallback={<div className="desktop-window-loading">{t('desktop.window.loading', language)}</div>}>
          {renderContent(desktopWindow)}
        </Suspense>
      </div>
      {!desktopWindow.isMaximized ? (
        <div
          className="desktop-window-resize-handle"
          onPointerDown={(event) => onResizePointerDown(event, desktopWindow.id)}
          onPointerMove={onUpdateInteraction}
          onPointerUp={onFinishInteraction}
          onPointerCancel={onFinishInteraction}
          aria-hidden="true"
        />
      ) : null}
    </section>
  );
}, (previousProps, nextProps) => (
  previousProps.desktopWindow === nextProps.desktopWindow &&
  previousProps.isFocused === nextProps.isFocused &&
  previousProps.isTerminalTitlebarMenuOpen === nextProps.isTerminalTitlebarMenuOpen &&
  previousProps.language === nextProps.language &&
  previousProps.livePointerFrame === nextProps.livePointerFrame &&
  previousProps.renderSettings === nextProps.renderSettings &&
  previousProps.appLabel === nextProps.appLabel
));

export default RemoteDesktopWindow;
