import type { ReactNode } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  FolderSync,
  MoreHorizontal,
  Network,
  Pencil,
  Route,
  Terminal,
  Trash2,
} from 'lucide-react';

import { t, type AppLanguage } from '../i18n';

interface HostListPanelHost {
  id: string;
  name: string;
  address: string;
  port: number;
  username: string;
  group: string;
  tags: string[];
  note: string;
  jumpHostId: string;
  canBeJumpHost: boolean;
  proxyProfileId: string;
  systemName: string;
  systemType: string;
  lastConnectionStatus: string;
  lastConnectionAt: string;
  lastConnectionError: string;
}

interface HostConnectionStateView {
  className: string;
  title: string;
}

function getHostRouteLabels(appLanguage: AppLanguage) {
  return {
    jumpHost: appLanguage === 'zh-CN' ? '可作为跳板机' : 'Jump host',
    viaJumpHost: appLanguage === 'zh-CN' ? '通过跳板机连接' : 'Connects via jump host',
  };
}

interface HostListPanelProps<THost extends HostListPanelHost> {
  hosts: THost[];
  filteredHosts: THost[];
  pagedHosts: THost[];
  isVaultReady: boolean;
  appLanguage: AppLanguage;
  hostViewMode: 'list' | 'grid';
  selectedHostId: string | null;
  onSelectHost: (hostId: string) => void;
  onOpenHost: (host: THost) => void;
  onOpenSftp: (host: THost) => void;
  onDeleteHost: (host: THost) => void;
  onEditHost: (host: THost) => void;
  hostPage: number;
  hostPageCount: number;
  hostPageNumbers: number[];
  hostPageSize: number;
  hostPageSizeOptions: readonly number[];
  onPageSizeChange: (pageSize: number) => void;
  onPageChange: (page: number) => void;
  isHostConnecting: (hostId: string) => boolean;
  proxyProfileById: Map<string, ShellDeskProxyProfile>;
  closeHostCardMenu: (trigger: HTMLElement | null) => void;
  formatRelativeTime: (value: string, language: AppLanguage) => string;
  getHostChipClassName: (kind: 'group' | 'tag', value: string, active: boolean) => string;
  getHostConnectionStateView: (host: THost, language: AppLanguage) => HostConnectionStateView;
  getHostSystemLabel: (host: THost, language: AppLanguage) => string;
  getProxyConfigTypeLabel: (config: ShellDeskProxyConfig | undefined) => string;
  renderHostSystemIcon: (host: THost) => ReactNode;
}

function HostRouteIcons<THost extends HostListPanelHost>({ host, appLanguage }: { host: THost; appLanguage: AppLanguage }) {
  if (!host.canBeJumpHost && !host.jumpHostId) return null;

  const labels = getHostRouteLabels(appLanguage);

  return (
    <span className="host-route-icons" aria-label={[host.canBeJumpHost ? labels.jumpHost : '', host.jumpHostId ? labels.viaJumpHost : ''].filter(Boolean).join(', ')}>
      {host.canBeJumpHost ? (
        <span className="host-route-icon jump-host" title={labels.jumpHost}>
          <Network aria-hidden="true" />
        </span>
      ) : null}
      {host.jumpHostId ? (
        <span className="host-route-icon via-jump-host" title={labels.viaJumpHost}>
          <Route aria-hidden="true" />
        </span>
      ) : null}
    </span>
  );
}

function HostListPanel<THost extends HostListPanelHost>({
  hosts,
  filteredHosts,
  pagedHosts,
  isVaultReady,
  appLanguage,
  hostViewMode,
  selectedHostId,
  onSelectHost,
  onOpenHost,
  onOpenSftp,
  onDeleteHost,
  onEditHost,
  hostPage,
  hostPageCount,
  hostPageNumbers,
  hostPageSize,
  hostPageSizeOptions,
  onPageSizeChange,
  onPageChange,
  isHostConnecting,
  proxyProfileById,
  closeHostCardMenu,
  formatRelativeTime,
  getHostChipClassName,
  getHostConnectionStateView,
  getHostSystemLabel,
  getProxyConfigTypeLabel,
  renderHostSystemIcon,
}: HostListPanelProps<THost>) {
  return (
    <div className={`host-table-frame ${hostViewMode === 'grid' ? 'card-mode' : 'table-mode'}`}>
      {!isVaultReady ? (
        <div className="empty-state">
          <span>LOADING</span>
          <h3>{t('app.host.loadingTitle', appLanguage)}</h3>
          <p>{t('app.host.loadingDescription', appLanguage)}</p>
        </div>
      ) : filteredHosts.length ? (
        <>
          {hostViewMode === 'grid' ? (
            <div className="host-card-scroll">
              <div className="host-card-grid" role="list">
                {pagedHosts.map((host) => {
                  const connectionState = getHostConnectionStateView(host, appLanguage);
                  const isConnecting = isHostConnecting(host.id);
                  const proxyProfile = host.proxyProfileId ? proxyProfileById.get(host.proxyProfileId) ?? null : null;
                  const isSelected = selectedHostId === host.id;
                  const hostTags = host.tags.length ? host.tags : [t('app.host.noTags', appLanguage)];

                  return (
                    <article
                      key={host.id}
                      className={`host-list-card ${isSelected ? 'selected' : ''} ${isConnecting ? 'connecting' : ''}`}
                      role="listitem"
                      aria-selected={isSelected}
                      aria-busy={isConnecting}
                      onClick={() => onSelectHost(host.id)}
                      onDoubleClick={() => onOpenHost(host)}
                    >
                      {isConnecting ? (
                        <div className="host-card-loading" role="status">
                          <span className="host-card-spinner" aria-hidden="true" />
                          <strong>{t('app.host.connectingButton', appLanguage)}</strong>
                          <small>{host.username}@{host.address}:{host.port}</small>
                        </div>
                      ) : null}
                      <header className="host-list-card-header">
                        <div className="host-card-titleline">
                          {renderHostSystemIcon(host)}
                          <div className="host-card-name">
                            <span className={`host-presence-dot ${connectionState.className}`} title={connectionState.title} aria-hidden="true" />
                            <strong>{host.name}</strong>
                          </div>
                        </div>
                        <div className="host-card-top-actions" onClick={(event) => event.stopPropagation()}>
                          <details className="host-card-menu host-card-top-menu">
                            <summary className="table-icon-button" aria-label={t('app.host.actions', appLanguage)}>
                              <MoreHorizontal aria-hidden="true" />
                            </summary>
                            <div className="host-card-menu-panel">
                              <button type="button" onClick={(event) => { closeHostCardMenu(event.currentTarget); onOpenSftp(host); }}>
                                <FolderSync aria-hidden="true" />
                                {appLanguage === 'zh-CN' ? '文件传输' : 'File transfer'}
                              </button>
                              <button type="button" onClick={(event) => { closeHostCardMenu(event.currentTarget); onEditHost(host); }}>{t('app.host.edit', appLanguage)}</button>
                              <button type="button" className="danger-text" onClick={(event) => { closeHostCardMenu(event.currentTarget); onDeleteHost(host); }}>{t('app.host.delete', appLanguage)}</button>
                            </div>
                          </details>
                        </div>
                      </header>

                      <div className="host-card-badges">
                        <span className={getHostChipClassName('group', host.group, Boolean(host.group))}>{host.group || t('app.host.group.ungrouped', appLanguage)}</span>
                        {hostTags.slice(0, 2).map((tag) => (
                          <span key={`${host.id}:card:${tag}`} className={getHostChipClassName('tag', tag, Boolean(host.tags.length))}>{tag}</span>
                        ))}
                        {host.tags.length > 2 ? <span className="host-chip muted">+{host.tags.length - 2}</span> : null}
                        {proxyProfile ? <span className="host-chip proxy-chip">{getProxyConfigTypeLabel(proxyProfile.config)}</span> : null}
                      </div>

                      <div className="host-card-meta">
                        <span className="host-endpoint-line mono-cell">
                          <HostRouteIcons host={host} appLanguage={appLanguage} />
                          <span>{host.address}:{host.port}</span>
                        </span>
                      </div>

                      <div className="host-card-footer">
                        <span className="host-card-recent">
                          <span>{formatRelativeTime(host.lastConnectionAt, appLanguage)}</span>
                        </span>
                        <button
                          type="button"
                          className="host-card-connect"
                          disabled={isConnecting}
                          onClick={(event) => {
                            event.stopPropagation();
                            onOpenHost(host);
                          }}
                        >
                          <Terminal aria-hidden="true" />
                          {t('app.host.card.connect', appLanguage)}
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="host-table-scroll">
              <table className="host-table">
                <thead>
                  <tr>
                    <th>{appLanguage === 'zh-CN' ? '主机名称' : 'Host name'}</th>
                    <th>{appLanguage === 'zh-CN' ? '分组' : 'Group'}</th>
                    <th>{appLanguage === 'zh-CN' ? '主机/IP' : 'Host/IP'}</th>
                    <th>{appLanguage === 'zh-CN' ? '用户' : 'User'}</th>
                    <th>{appLanguage === 'zh-CN' ? '端口' : 'Port'}</th>
                    <th>{appLanguage === 'zh-CN' ? '标签' : 'Tags'}</th>
                    <th>{appLanguage === 'zh-CN' ? '最近连接' : 'Last connection'}</th>
                    <th>{appLanguage === 'zh-CN' ? '操作' : 'Actions'}</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedHosts.map((host) => {
                    const connectionState = getHostConnectionStateView(host, appLanguage);
                    const isConnecting = isHostConnecting(host.id);
                    const proxyProfile = host.proxyProfileId ? proxyProfileById.get(host.proxyProfileId) ?? null : null;
                    const isSelected = selectedHostId === host.id;
                    const hostTags = host.tags.length ? host.tags : [t('app.host.noTags', appLanguage)];

                    return (
                      <tr
                        key={host.id}
                        className={`${isSelected ? 'selected' : ''} ${isConnecting ? 'connecting' : ''}`}
                        aria-selected={isSelected}
                        aria-busy={isConnecting}
                        onClick={() => onSelectHost(host.id)}
                        onDoubleClick={() => onOpenHost(host)}
                      >
                        <td className="host-name-cell">
                          <span className={`host-presence-dot ${connectionState.className}`} aria-hidden="true" />
                          {renderHostSystemIcon(host)}
                          <span className="host-name-copy">
                            <strong>{host.name}</strong>
                            <small>{host.note || getHostSystemLabel(host, appLanguage)}</small>
                          </span>
                        </td>
                        <td>
                          <span className={getHostChipClassName('group', host.group, Boolean(host.group))}>{host.group || t('app.host.group.ungrouped', appLanguage)}</span>
                        </td>
                        <td>
                          <span className="host-endpoint-line mono-cell">
                            <HostRouteIcons host={host} appLanguage={appLanguage} />
                            <span>{host.address}</span>
                          </span>
                        </td>
                        <td className="mono-cell">{host.username}</td>
                        <td className="mono-cell">{host.port}</td>
                        <td className="host-tag-cell">
                          {proxyProfile ? <span className="host-chip proxy-chip">{getProxyConfigTypeLabel(proxyProfile.config)}</span> : null}
                          {hostTags.slice(0, 2).map((tag) => (
                            <span key={`${host.id}:${tag}`} className={getHostChipClassName('tag', tag, Boolean(host.tags.length))}>{tag}</span>
                          ))}
                          {host.tags.length > 2 ? <span className="host-chip muted">+{host.tags.length - 2}</span> : null}
                        </td>
                        <td>{formatRelativeTime(host.lastConnectionAt, appLanguage)}</td>
                        <td className="host-table-actions" onClick={(event) => event.stopPropagation()}>
                          <div className="host-table-action-buttons">
                            <button type="button" className="table-icon-button sftp-action" onClick={() => onOpenSftp(host)} aria-label={appLanguage === 'zh-CN' ? '打开文件传输' : 'Open file transfer'} title={appLanguage === 'zh-CN' ? '文件传输' : 'File transfer'}>
                              <FolderSync aria-hidden="true" />
                            </button>
                            <button type="button" className="table-icon-button" onClick={() => onEditHost(host)} aria-label={t('app.host.edit', appLanguage)}>
                              <Pencil aria-hidden="true" />
                            </button>
                            <button type="button" className="table-icon-button danger-action" onClick={() => onDeleteHost(host)} aria-label={t('app.host.delete', appLanguage)}>
                              <Trash2 aria-hidden="true" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="host-table-pagination">
            <span>{t('app.host.count', appLanguage, { count: String(filteredHosts.length) })}</span>
            <div className="host-pagination-controls">
              <label className="page-size-control">
                <span>{appLanguage === 'zh-CN' ? '每页' : 'Per page'}</span>
                <select
                  value={hostPageSize}
                  onChange={(event) => onPageSizeChange(Number(event.target.value))}
                  aria-label={appLanguage === 'zh-CN' ? '每页主机数量' : 'Hosts per page'}
                >
                  {hostPageSizeOptions.map((pageSize) => (
                    <option key={pageSize} value={pageSize}>
                      {appLanguage === 'zh-CN' ? `${pageSize} 条/页` : `${pageSize} / page`}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" className="page-nav-button" onClick={() => onPageChange(1)} disabled={hostPage === 1} aria-label={appLanguage === 'zh-CN' ? '第一页' : 'First page'}>
                <ChevronsLeft aria-hidden="true" />
              </button>
              <button type="button" className="page-nav-button" onClick={() => onPageChange(hostPage - 1)} disabled={hostPage === 1} aria-label={appLanguage === 'zh-CN' ? '上一页' : 'Previous page'}>
                <ChevronLeft aria-hidden="true" />
              </button>
              {hostPageNumbers.map((pageNumber) => (
                <button
                  key={pageNumber}
                  type="button"
                  className={`page-nav-button page-number ${pageNumber === hostPage ? 'active' : ''}`}
                  onClick={() => onPageChange(pageNumber)}
                  aria-current={pageNumber === hostPage ? 'page' : undefined}
                >
                  {pageNumber}
                </button>
              ))}
              <button type="button" className="page-nav-button" onClick={() => onPageChange(hostPage + 1)} disabled={hostPage === hostPageCount} aria-label={appLanguage === 'zh-CN' ? '下一页' : 'Next page'}>
                <ChevronRight aria-hidden="true" />
              </button>
              <button type="button" className="page-nav-button" onClick={() => onPageChange(hostPageCount)} disabled={hostPage === hostPageCount} aria-label={appLanguage === 'zh-CN' ? '最后一页' : 'Last page'}>
                <ChevronsRight aria-hidden="true" />
              </button>
            </div>
          </div>
        </>
      ) : (
        <div className="empty-state">
          <span>EMPTY</span>
          <h3>{t(hosts.length ? 'app.host.emptyNoMatchesTitle' : 'app.host.emptyNoHostsTitle', appLanguage)}</h3>
          <p>{t(hosts.length ? 'app.host.emptyNoMatchesDescription' : 'app.host.emptyNoHostsDescription', appLanguage)}</p>
        </div>
      )}
    </div>
  );
}

export default HostListPanel;
