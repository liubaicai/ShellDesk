import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { useRef, useState } from 'react';

import { defaultAppSettings } from '../../src/appDefaultSettings';
import { DesktopLaunchpad } from '../../src/components/remote-desktop/DesktopLaunchpad';
import RemoteDesktopWindow from '../../src/components/remote-desktop/RemoteDesktopWindow';
import { createStaticDesktopCapabilitySnapshot } from '../../src/features/remote-desktop/desktopCapabilities';
import { loadFullMessageCatalog } from '../../src/i18n';
import { desktopApps } from '../../src/remoteDesktopCatalog';
import { createDesktopWindow } from '../../src/remoteDesktopWindowModel';
import '../../src/styles/critical.scss';
import '../../src/styles/deferred.scss';

await loadFullMessageCatalog();

function AccessibilityHarness() {
  const launchpadButtonRef = useRef<HTMLButtonElement | null>(null);
  const windowButtonRef = useRef<HTMLButtonElement | null>(null);
  const [isLaunchpadOpen, setIsLaunchpadOpen] = useState(false);
  const [isWindowVisible, setIsWindowVisible] = useState(false);
  const [contextMenuPosition, setContextMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [desktopWindow, setDesktopWindow] = useState(() => createDesktopWindow('terminal', 1, 1, 'zh-CN'));
  const capabilitySnapshot = createStaticDesktopCapabilitySnapshot('ubuntu');
  const launchpadApps = desktopApps.filter((app) => ['files', 'terminal', 'browser', 'settings'].includes(app.key));

  const closeLaunchpad = (restoreFocus = true) => {
    setIsLaunchpadOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => launchpadButtonRef.current?.focus());
  };
  const closeWindow = () => {
    setIsWindowVisible(false);
    window.requestAnimationFrame(() => windowButtonRef.current?.focus());
  };

  return (
    <main>
      <button ref={launchpadButtonRef} id="open-launchpad" type="button" onClick={() => setIsLaunchpadOpen(true)}>
        打开 Launchpad
      </button>
      <button ref={windowButtonRef} id="open-window" type="button" onClick={() => setIsWindowVisible(true)}>
        打开终端窗口
      </button>
      <section
        id="context-menu-surface"
        className="remote-desktop-surface"
        style={{ position: 'relative', width: 420, height: 180, marginTop: 16 }}
        onContextMenu={(event) => {
          event.preventDefault();
          setContextMenuPosition({ x: event.clientX, y: event.clientY });
        }}
      >
        虚拟桌面空白区域
      </section>

      {isLaunchpadOpen ? (
        <DesktopLaunchpad
          apps={launchpadApps}
          capabilityFilter="all"
          capabilitySnapshot={capabilitySnapshot}
          isOpen
          language="zh-CN"
          search=""
          seenAppCatalogVersion={20}
          onCapabilityFilterChange={() => undefined}
          onClose={closeLaunchpad}
          onContextMenu={() => undefined}
          onOpenApp={() => false}
          onPointerDown={() => undefined}
          onRefreshCapabilities={() => undefined}
          onSearchChange={() => undefined}
        />
      ) : null}

      {isWindowVisible ? (
        <div className="remote-desktop-page" style={{ position: 'relative', width: 900, height: 640 }}>
          <RemoteDesktopWindow
            appLabel="终端"
            desktopWindow={desktopWindow}
            isFocused
            isTerminalTitlebarMenuOpen={false}
            language="zh-CN"
            livePointerFrame={null}
            renderSettings={defaultAppSettings}
            onBringToFront={() => undefined}
            onClose={closeWindow}
            onFinishInteraction={() => undefined}
            onKeyboardFrameChange={(_windowId, mode, deltaX, deltaY) => {
              setDesktopWindow((currentWindow) => ({
                ...currentWindow,
                frame: mode === 'move'
                  ? { ...currentWindow.frame, x: currentWindow.frame.x + deltaX, y: currentWindow.frame.y + deltaY }
                  : { ...currentWindow.frame, width: currentWindow.frame.width + deltaX, height: currentWindow.frame.height + deltaY },
              }));
            }}
            onMinimize={() => undefined}
            onOpenTerminalTitlebarMenu={() => undefined}
            onResizePointerDown={() => undefined}
            onTitlebarPointerDown={() => undefined}
            onToggleMaximize={() => setDesktopWindow((currentWindow) => ({ ...currentWindow, isMaximized: !currentWindow.isMaximized }))}
            onUpdateInteraction={() => undefined}
            renderContent={() => <div>终端内容</div>}
          />
        </div>
      ) : null}

      {contextMenuPosition ? createPortal(
        <>
          <div
            className="context-menu-overlay"
            onClick={() => setContextMenuPosition(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setContextMenuPosition(null);
            }}
          />
          <div
            className="context-menu"
            style={{ left: contextMenuPosition.x, top: contextMenuPosition.y }}
            role="menu"
          >
            <button type="button" role="menuitem">新建文件夹</button>
          </div>
        </>,
        document.body,
      ) : null}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<AccessibilityHarness />);
