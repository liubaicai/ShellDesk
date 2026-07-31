import { Search, TerminalSquare } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type UIEvent } from 'react';

import type { AgentWorkspaceHost } from '../ai/agentWorkspaceTools';
import type { AppLanguage } from '../i18n';

interface AgentHostPickerProps {
  hosts: AgentWorkspaceHost[];
  selectedHostId: string | null;
  conversationStatuses: Record<string, string>;
  language: AppLanguage;
  hostLabel: (host: AgentWorkspaceHost) => string;
  onSelectHost: (host: AgentWorkspaceHost) => void;
}

const rowHeight = 50;
const overscan = 5;
const fallbackViewportHeight = 420;

export function getNextHostPickerIndex(
  key: string,
  currentIndex: number,
  itemCount: number,
  pageSize: number,
) {
  if (!itemCount) return -1;
  const safeIndex = currentIndex >= 0 ? currentIndex : 0;
  switch (key) {
    case 'ArrowUp':
      return Math.max(0, safeIndex - 1);
    case 'ArrowDown':
      return Math.min(itemCount - 1, currentIndex < 0 ? 0 : currentIndex + 1);
    case 'Home':
      return 0;
    case 'End':
      return itemCount - 1;
    case 'PageUp':
      return Math.max(0, safeIndex - pageSize);
    case 'PageDown':
      return Math.min(itemCount - 1, safeIndex + pageSize);
    default:
      return currentIndex;
  }
}

function AgentHostPicker({
  hosts,
  selectedHostId,
  conversationStatuses,
  language,
  hostLabel,
  onSelectHost,
}: AgentHostPickerProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState('');
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(fallbackViewportHeight);
  const filteredHosts = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return hosts;
    return hosts.filter((host) => [
      hostLabel(host),
      host.address,
      host.username,
      host.port,
    ].join(' ').toLocaleLowerCase().includes(normalizedQuery));
  }, [hostLabel, hosts, query]);
  const selectedIndex = filteredHosts.findIndex((host) => host.id === selectedHostId);
  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const endIndex = Math.min(
    filteredHosts.length,
    Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan,
  );
  const visibleHosts = filteredHosts.slice(startIndex, endIndex);
  const listLabel = language === 'zh-CN' ? 'SD-Agent 主机列表' : 'SD-Agent host list';

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const updateHeight = () => setViewportHeight(list.clientHeight || fallbackViewportHeight);
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (selectedIndex < 0) return;
    const list = listRef.current;
    if (!list) return;
    const rowTop = selectedIndex * rowHeight;
    const rowBottom = rowTop + rowHeight;
    if (rowTop < list.scrollTop) {
      list.scrollTop = rowTop;
    } else if (rowBottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = rowBottom - list.clientHeight;
    }
  }, [selectedIndex]);

  const selectIndex = (index: number) => {
    const host = filteredHosts[index];
    if (!host) return;
    onSelectHost(host);
  };

  const handleListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' && selectedIndex >= 0) {
      event.preventDefault();
      selectIndex(selectedIndex);
      return;
    }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) return;
    event.preventDefault();
    const pageSize = Math.max(1, Math.floor(viewportHeight / rowHeight) - 1);
    selectIndex(getNextHostPickerIndex(event.key, selectedIndex, filteredHosts.length, pageSize));
  };

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop);
  };

  return (
    <section className="agent-host-picker">
      <div className="agent-host-list-heading">
        <span>{language === 'zh-CN' ? '主机' : 'Hosts'}</span>
        <span>{filteredHosts.length === hosts.length ? hosts.length : `${filteredHosts.length}/${hosts.length}`}</span>
      </div>
      {hosts.length > 20 ? (
        <label className="agent-host-filter">
          <Search aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setScrollTop(0);
              if (listRef.current) listRef.current.scrollTop = 0;
            }}
            placeholder={language === 'zh-CN' ? '搜索主机、地址或用户' : 'Search hosts, addresses, or users'}
            aria-label={language === 'zh-CN' ? '搜索 SD-Agent 主机' : 'Search SD-Agent hosts'}
          />
        </label>
      ) : null}
      <div
        ref={listRef}
        className="agent-host-list"
        role="listbox"
        aria-label={listLabel}
        aria-activedescendant={selectedIndex >= 0 ? `agent-host-option-${filteredHosts[selectedIndex].id}` : undefined}
        tabIndex={0}
        onKeyDown={handleListKeyDown}
        onScroll={handleScroll}
      >
        {filteredHosts.length ? (
          <div className="agent-host-virtual-spacer" style={{ height: filteredHosts.length * rowHeight }}>
            {visibleHosts.map((host, offset) => {
              const isSelected = host.id === selectedHostId;
              const conversationStatus = conversationStatuses[`host:${host.id}`] ?? 'idle';
              return (
                <button
                  id={`agent-host-option-${host.id}`}
                  key={host.id}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  className={`agent-host-row virtual ${isSelected ? 'selected' : ''}`}
                  aria-selected={isSelected}
                  style={{ transform: `translateY(${(startIndex + offset) * rowHeight}px)` }}
                  onClick={() => onSelectHost(host)}
                >
                  <span className="agent-host-icon"><TerminalSquare aria-hidden="true" /></span>
                  <span className="agent-host-copy">
                    <strong>{hostLabel(host)}</strong>
                    <small>{host.username ? `${host.username}@` : ''}{host.address}:{host.port}</small>
                  </span>
                  <i className={conversationStatus} title={conversationStatus} />
                </button>
              );
            })}
          </div>
        ) : (
          <div className="agent-host-empty">
            <strong>{language === 'zh-CN' ? '没有匹配的主机' : 'No matching hosts'}</strong>
            <span>{hosts.length
              ? (language === 'zh-CN' ? '尝试其他名称、地址或用户名。' : 'Try another name, address, or username.')
              : (language === 'zh-CN' ? '先在主机页添加 SSH 主机。' : 'Add an SSH host from the Hosts page first.')}
            </span>
          </div>
        )}
      </div>
    </section>
  );
}

export default AgentHostPicker;
