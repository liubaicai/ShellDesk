import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { DesktopAppAvailabilityStatus, DesktopCapabilitySnapshot } from '../../features/remote-desktop/desktopCapabilities';
import {
  focusFirstElement,
  handleModalKeyboardNavigation,
  handleRovingKeyboardNavigation,
} from '../../features/remote-desktop/desktopKeyboardNavigation';
import {
  desktopAppGroups,
  getAppCapability,
  getAppDescription,
  getAppGroupLabel,
  getAppLabel,
  type DesktopAppInfo,
  type DesktopAppKey,
} from '../../remoteDesktopCatalog';
import type { LaunchpadTooltipState } from '../../remoteDesktopWindowModel';
import { t } from '../../i18n';
import { DesktopAppIcon } from './RemoteDesktopAppIcon';

interface DesktopLaunchpadProps {
  apps: DesktopAppInfo[];
  capabilityFilter: 'all' | DesktopAppAvailabilityStatus;
  capabilitySnapshot: DesktopCapabilitySnapshot;
  isOpen: boolean;
  language: ShellDeskAppSettings['language'];
  search: string;
  seenAppCatalogVersion: number;
  onCapabilityFilterChange: (filter: 'all' | DesktopAppAvailabilityStatus) => void;
  onClose: (restoreFocus?: boolean) => void;
  onContextMenu: (appKey: DesktopAppKey, x: number, y: number) => void;
  onOpenApp: (appKey: DesktopAppKey) => boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>, appKey: DesktopAppKey) => void;
  onRefreshCapabilities: () => void;
  onSearchChange: (value: string) => void;
}

export function DesktopLaunchpad({
  apps,
  capabilityFilter,
  capabilitySnapshot,
  isOpen,
  language,
  search,
  seenAppCatalogVersion,
  onCapabilityFilterChange,
  onClose,
  onContextMenu,
  onOpenApp,
  onPointerDown,
  onRefreshCapabilities,
  onSearchChange,
}: DesktopLaunchpadProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const [tooltip, setTooltip] = useState<LaunchpadTooltipState | null>(null);
  const [focusedAppKey, setFocusedAppKey] = useState<DesktopAppKey | null>(null);
  const appKeySignature = apps.map((app) => app.key).join(',');
  const appGroups = desktopAppGroups
    .map((group) => ({ ...group, apps: apps.filter((app) => app.group === group.key) }))
    .filter((group) => group.apps.length > 0);

  useEffect(() => {
    if (isOpen) {
      setFocusedAppKey((currentKey) => apps.some((app) => app.key === currentKey) ? currentKey : apps[0]?.key ?? null);
      focusFirstElement(panelRef.current, '.launchpad-search input');
    }
  }, [appKeySignature, isOpen]);

  const showTooltip = (element: HTMLElement, description: string) => {
    const rect = element.getBoundingClientRect();
    const placement = rect.bottom + 68 > window.innerHeight ? 'top' : 'bottom';
    setTooltip({
      description,
      x: rect.left + rect.width / 2,
      y: placement === 'bottom' ? rect.bottom + 10 : rect.top - 10,
      placement,
    });
  };

  const activateApp = (appKey: DesktopAppKey) => {
    if (onOpenApp(appKey)) {
      onClose(false);
    }
  };

  return (
    <>
      {createPortal(
        <div className={`launchpad-overlay ${isOpen ? 'open' : 'closing'}`} role="presentation" onClick={() => onClose()}>
          <section
            ref={panelRef}
            className="launchpad-panel"
            role="dialog"
            aria-modal="true"
            aria-label={t('desktop.launchpad.allApps', language)}
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              handleModalKeyboardNavigation(event, event.currentTarget, () => onClose());
              handleRovingKeyboardNavigation(event, event.currentTarget, '[data-launchpad-app]', 6);
            }}
          >
            <header className="launchpad-header">
              <div>
                <span>{t('desktop.launchpad.allApps', language)}</span>
                <strong>{t('desktop.launchpad.componentCount', language, { count: apps.length })}</strong>
              </div>
              <label className="launchpad-search">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                  <circle cx="7" cy="7" r="4.25" />
                  <path d="m10.25 10.25 3 3" />
                </svg>
                <input
                  value={search}
                  onChange={(event) => onSearchChange(event.target.value)}
                  placeholder={t('desktop.launchpad.searchPlaceholder', language)}
                  aria-label={t('desktop.launchpad.searchPlaceholder', language)}
                />
              </label>
              <button
                type="button"
                className="launchpad-refresh-capabilities"
                onClick={onRefreshCapabilities}
                aria-label={t('desktop.capability.refresh', language)}
                title={t('desktop.capability.refresh', language)}
              >
                ↻
              </button>
              <button type="button" className="launchpad-close" aria-label={t('desktop.launchpad.close', language)} onClick={() => onClose()}>
                <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                  <line x1="2" y1="2" x2="10" y2="10" />
                  <line x1="10" y1="2" x2="2" y2="10" />
                </svg>
              </button>
            </header>
            <div className="launchpad-capability-filters" role="toolbar" aria-label={t('desktop.capability.filterLabel', language)}>
              {([
                ['all', 'desktop.capability.filter.all'],
                ['available', 'desktop.capability.filter.available'],
                ['missing', 'desktop.capability.filter.missing'],
                ['unsupported', 'desktop.capability.filter.unsupported'],
                ['unknown', 'desktop.capability.filter.unknown'],
              ] as const).map(([value, labelId]) => (
                <button
                  key={value}
                  type="button"
                  className={capabilityFilter === value ? 'active' : ''}
                  aria-pressed={capabilityFilter === value}
                  onClick={() => onCapabilityFilterChange(value)}
                >
                  {t(labelId, language)}
                </button>
              ))}
            </div>
            <div className="launchpad-groups">
              {appGroups.map((group) => (
                <section key={group.key} className="launchpad-group" aria-labelledby={`launchpad-group-${group.key}`}>
                  <header className="launchpad-group-header">
                    <h2 id={`launchpad-group-${group.key}`}>{getAppGroupLabel(group, language)}</h2>
                    <span>{t('desktop.launchpad.groupCount', language, { count: group.apps.length })}</span>
                  </header>
                  <div className="launchpad-grid">
                    {group.apps.map((app) => {
                      const appLabel = getAppLabel(app, language);
                      const availability = capabilitySnapshot[app.key];
                      const availabilityLabel = t(`desktop.capability.status.${availability.status}` as Parameters<typeof t>[0], language);
                      const description = availability.missingTools.length > 0
                        ? `${getAppDescription(app, language)} · ${t('desktop.capability.missingTools', language, { tools: availability.missingTools.join(', ') })}`
                        : `${getAppDescription(app, language)} · ${availabilityLabel}`;

                      return (
                        <div
                          key={app.key}
                          role="button"
                          tabIndex={focusedAppKey === app.key ? 0 : -1}
                          data-launchpad-app={app.key}
                          className={`launchpad-app-button capability-${availability.status}`}
                          aria-disabled={availability.status === 'unsupported' || availability.status === 'missing' || availability.status === 'checking'}
                          aria-label={`${appLabel}，${availabilityLabel}`}
                          draggable={false}
                          onPointerDown={(event) => onPointerDown(event, app.key)}
                          onDragStart={(event) => event.preventDefault()}
                          onMouseEnter={(event) => showTooltip(event.currentTarget, description)}
                          onMouseLeave={() => setTooltip(null)}
                          onFocus={(event) => {
                            setFocusedAppKey(app.key);
                            showTooltip(event.currentTarget, description);
                          }}
                          onBlur={() => setTooltip(null)}
                          onClick={() => activateApp(app.key)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              activateApp(app.key);
                            }
                          }}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            onContextMenu(app.key, event.clientX, event.clientY);
                          }}
                        >
                          <span className={`desktop-app-icon-shell desktop-app-icon-${app.key}`}>
                            <DesktopAppIcon appKey={app.key} />
                          </span>
                          <strong className="launchpad-app-name">
                            <span>{appLabel}</span>
                            <span
                              className={`launchpad-capability-dot ${availability.status}`}
                              title={availabilityLabel}
                              aria-hidden="true"
                            />
                          </strong>
                          {getAppCapability(app.key).introducedInVersion > seenAppCatalogVersion
                            ? <span className="launchpad-new-badge">{t('desktop.capability.new', language)}</span>
                            : null}
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))}
              {!apps.length ? <div className="launchpad-empty">{t('desktop.launchpad.noSearchResults', language)}</div> : null}
            </div>
          </section>
        </div>,
        document.body,
      )}
      {tooltip ? createPortal(
        <div className={`launchpad-tooltip ${tooltip.placement}`} style={{ left: tooltip.x, top: tooltip.y }} role="tooltip">
          {tooltip.description}
        </div>,
        document.body,
      ) : null}
    </>
  );
}
