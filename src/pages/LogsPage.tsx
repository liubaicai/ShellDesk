import { useMemo, useState } from 'react';
import type { LogCategory, LogEntry, LogLevel } from '../App';
import { t, useCurrentAppLanguage, type MessageId } from '../i18n';

interface LogsPageProps {
  logs: LogEntry[];
  onClearLogs: () => void;
}

const categoryLabelIds: Record<LogCategory, MessageId> = {
  connection: 'logs.category.connection',
  host: 'logs.category.host',
  key: 'logs.category.key',
  config: 'logs.category.config',
  system: 'logs.category.system',
};

const levelLabelIds: Record<LogLevel, MessageId> = {
  info: 'logs.level.info',
  success: 'logs.level.success',
  warning: 'logs.level.warning',
  error: 'logs.level.error',
};

const levelIcons: Record<LogLevel, string> = {
  info: 'ℹ',
  success: '✓',
  warning: '⚠',
  error: '✕',
};

const noHostFilterKey = '__none__';
const visibleHostFilterOptionCount = 5;

function formatTimestamp(isoString: string) {
  try {
    const date = new Date(isoString);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  } catch {
    return isoString;
  }
}

function getLogHostKey(log: LogEntry) {
  return log.hostId || log.hostAddress || log.hostName || '';
}

function getLogHostLabel(log: LogEntry, noHostLabel: string) {
  if (!getLogHostKey(log)) {
    return noHostLabel;
  }

  if (log.hostName && log.hostAddress && log.hostName !== log.hostAddress) {
    return `${log.hostName} (${log.hostAddress})`;
  }

  return log.hostName || log.hostAddress || log.hostId || noHostLabel;
}

function getLogComponentLabel(log: LogEntry) {
  return log.component?.trim() ?? '';
}

function LogsPage({ logs, onClearLogs }: LogsPageProps) {
  const language = useCurrentAppLanguage();
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<LogCategory | 'all'>('all');
  const [levelFilter, setLevelFilter] = useState<LogLevel | 'all'>('all');
  const [hostFilter, setHostFilter] = useState('all');

  const filteredLogs = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const noHostLabel = t('logs.host.unassigned', language);

    return logs.filter((log) => {
      const matchesCategory = categoryFilter === 'all' || log.category === categoryFilter;
      const matchesLevel = levelFilter === 'all' || log.level === levelFilter;
      const logHostKey = getLogHostKey(log);
      const matchesHost = hostFilter === 'all' || (hostFilter === noHostFilterKey ? !logHostKey : logHostKey === hostFilter);
      const matchesQuery = !query || `${log.message} ${log.detail} ${getLogHostLabel(log, noHostLabel)} ${getLogComponentLabel(log)}`.toLowerCase().includes(query);
      return matchesCategory && matchesLevel && matchesHost && matchesQuery;
    });
  }, [logs, searchQuery, categoryFilter, levelFilter, hostFilter, language]);

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { all: logs.length };
    for (const log of logs) {
      counts[log.category] = (counts[log.category] ?? 0) + 1;
    }
    return counts;
  }, [logs]);

  const levelCounts = useMemo(() => {
    const counts: Record<string, number> = { all: logs.length };
    for (const log of logs) {
      counts[log.level] = (counts[log.level] ?? 0) + 1;
    }
    return counts;
  }, [logs]);

  const hostOptions = useMemo(() => {
    const noHostLabel = t('logs.host.unassigned', language);
    const options = new Map<string, { label: string; count: number }>();

    for (const log of logs) {
      const key = getLogHostKey(log) || noHostFilterKey;
      const current = options.get(key);

      if (current) {
        current.count += 1;
        continue;
      }

      options.set(key, {
        label: getLogHostLabel(log, noHostLabel),
        count: 1,
      });
    }

    return Array.from(options.entries())
      .map(([key, option]) => ({ key, ...option }))
      .sort((first, second) => first.label.localeCompare(second.label, language === 'zh-CN' ? 'zh-CN' : 'en-US'));
  }, [logs, language]);
  const visibleHostOptions = hostOptions.slice(0, visibleHostFilterOptionCount);
  const overflowHostOptions = hostOptions.slice(visibleHostFilterOptionCount);
  const selectedOverflowHost = overflowHostOptions.some((option) => option.key === hostFilter)
    ? hostFilter
    : '';

  return (
    <>
      <div className="command-bar no-drag logs-command-bar">
        <strong>{t('logs.title', language)}</strong>
        <label className="global-search logs-search">
          <span>{t('logs.search.label', language)}</span>
          <input
            type="search"
            placeholder={t('logs.search.placeholder', language)}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
        </label>
        <button type="button" className="command-button" onClick={onClearLogs} disabled={!logs.length}>
          {t('logs.clear', language)}
        </button>
      </div>
      <section className="vault-content logs-page">
        <div className="logs-filters">
          <div className="logs-filter-group">
            <span className="logs-filter-label">{t('logs.category.label', language)}</span>
            <div className="logs-filter-chips">
              <button
                type="button"
                className={`logs-filter-chip ${categoryFilter === 'all' ? 'active' : ''}`}
                onClick={() => setCategoryFilter('all')}
              >
                {t('logs.filter.all', language)} <small>{categoryCounts.all ?? 0}</small>
              </button>
              {(Object.keys(categoryLabelIds) as LogCategory[]).map((key) => (
                categoryCounts[key] != null ? (
                  <button
                    key={key}
                    type="button"
                    className={`logs-filter-chip ${categoryFilter === key ? 'active' : ''}`}
                    onClick={() => setCategoryFilter(key)}
                  >
                    {t(categoryLabelIds[key], language)} <small>{categoryCounts[key] ?? 0}</small>
                  </button>
                ) : null
              ))}
            </div>
          </div>
          <div className="logs-filter-group">
            <span className="logs-filter-label">{t('logs.level.label', language)}</span>
            <div className="logs-filter-chips">
              <button
                type="button"
                className={`logs-filter-chip ${levelFilter === 'all' ? 'active' : ''}`}
                onClick={() => setLevelFilter('all')}
              >
                {t('logs.filter.all', language)} <small>{levelCounts.all ?? 0}</small>
              </button>
              {(Object.keys(levelLabelIds) as LogLevel[]).map((key) => (
                levelCounts[key] != null ? (
                  <button
                    key={key}
                    type="button"
                    className={`logs-filter-chip ${levelFilter === key ? 'active' : ''}`}
                    onClick={() => setLevelFilter(key)}
                  >
                    {t(levelLabelIds[key], language)} <small>{levelCounts[key] ?? 0}</small>
                  </button>
                ) : null
              ))}
            </div>
          </div>
          {hostOptions.length ? (
            <div className="logs-filter-group logs-host-filter-group">
              <span className="logs-filter-label">{t('logs.host.label', language)}</span>
              <div className="logs-host-filter-row">
                <div className="logs-filter-chips logs-host-filter-chips">
                  <button
                    type="button"
                    className={`logs-filter-chip ${hostFilter === 'all' ? 'active' : ''}`}
                    onClick={() => setHostFilter('all')}
                  >
                    {t('logs.filter.all', language)} <small>{logs.length}</small>
                  </button>
                  {visibleHostOptions.map((option) => (
                    <button
                      key={option.key}
                      type="button"
                      className={`logs-filter-chip ${hostFilter === option.key ? 'active' : ''}`}
                      onClick={() => setHostFilter(option.key)}
                    >
                      {option.label} <small>{option.count}</small>
                    </button>
                  ))}
                </div>
                {overflowHostOptions.length ? (
                  <select
                    className={`logs-host-overflow-select ${selectedOverflowHost ? 'active' : ''}`}
                    aria-label={t('logs.host.more', language, { count: String(overflowHostOptions.length) })}
                    value={selectedOverflowHost}
                    onChange={(event) => setHostFilter(event.target.value)}
                  >
                    <option value="" disabled>{t('logs.host.more', language, { count: String(overflowHostOptions.length) })}</option>
                    {overflowHostOptions.map((option) => (
                      <option key={option.key} value={option.key}>{option.label} ({option.count})</option>
                    ))}
                  </select>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        {filteredLogs.length ? (
          <div className="logs-list">
            {filteredLogs.map((log) => (
              <article key={log.id} className={`log-entry log-level-${log.level}`}>
                <span className={`log-level-indicator ${log.level}`} title={t(levelLabelIds[log.level], language)}>
                  {levelIcons[log.level]}
                </span>
                <div className="log-body">
                  <div className="log-header">
                    <strong className="log-message">{log.message}</strong>
                    <span className="log-category">{t(categoryLabelIds[log.category], language)}</span>
                    {getLogComponentLabel(log) ? <span className="log-component">{getLogComponentLabel(log)}</span> : null}
                    {getLogHostKey(log) ? <span className="log-host">{getLogHostLabel(log, t('logs.host.unassigned', language))}</span> : null}
                    <time className="log-time">{formatTimestamp(log.timestamp)}</time>
                  </div>
                  {log.detail ? <p className="log-detail">{log.detail}</p> : null}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <span>LOGS</span>
            <h3>{logs.length ? t('logs.empty.noMatches.title', language) : t('logs.empty.noLogs.title', language)}</h3>
            <p>{logs.length ? t('logs.empty.noMatches.description', language) : t('logs.empty.noLogs.description', language)}</p>
          </div>
        )}
      </section>
    </>
  );
}

export default LogsPage;
