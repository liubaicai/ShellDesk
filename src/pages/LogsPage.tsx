import { useMemo, useState } from 'react';
import type { LogCategory, LogEntry, LogLevel } from '../App';

interface LogsPageProps {
  logs: LogEntry[];
  onClearLogs: () => void;
}

const categoryLabels: Record<LogCategory, string> = {
  connection: '连接',
  host: '主机',
  key: '密钥',
  config: '配置',
  system: '系统',
};

const levelLabels: Record<LogLevel, string> = {
  info: '信息',
  success: '成功',
  warning: '警告',
  error: '错误',
};

const levelIcons: Record<LogLevel, string> = {
  info: 'ℹ',
  success: '✓',
  warning: '⚠',
  error: '✕',
};

function formatTimestamp(isoString: string) {
  try {
    const date = new Date(isoString);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  } catch {
    return isoString;
  }
}

function LogsPage({ logs, onClearLogs }: LogsPageProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<LogCategory | 'all'>('all');
  const [levelFilter, setLevelFilter] = useState<LogLevel | 'all'>('all');

  const filteredLogs = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    return logs.filter((log) => {
      const matchesCategory = categoryFilter === 'all' || log.category === categoryFilter;
      const matchesLevel = levelFilter === 'all' || log.level === levelFilter;
      const matchesQuery = !query || `${log.message} ${log.detail}`.toLowerCase().includes(query);
      return matchesCategory && matchesLevel && matchesQuery;
    });
  }, [logs, searchQuery, categoryFilter, levelFilter]);

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

  return (
    <>
      <div className="command-bar no-drag logs-command-bar">
        <strong>日志</strong>
        <label className="global-search logs-search">
          <span>搜索</span>
          <input
            type="search"
            placeholder="搜索日志内容..."
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
        </label>
        <button type="button" className="command-button" onClick={onClearLogs} disabled={!logs.length}>
          清空日志
        </button>
      </div>
      <section className="vault-content logs-page">
        <div className="logs-filters">
          <div className="logs-filter-group">
            <span className="logs-filter-label">类别</span>
            <div className="logs-filter-chips">
              <button
                type="button"
                className={`logs-filter-chip ${categoryFilter === 'all' ? 'active' : ''}`}
                onClick={() => setCategoryFilter('all')}
              >
                全部 <small>{categoryCounts.all ?? 0}</small>
              </button>
              {(Object.keys(categoryLabels) as LogCategory[]).map((key) => (
                categoryCounts[key] != null ? (
                  <button
                    key={key}
                    type="button"
                    className={`logs-filter-chip ${categoryFilter === key ? 'active' : ''}`}
                    onClick={() => setCategoryFilter(key)}
                  >
                    {categoryLabels[key]} <small>{categoryCounts[key] ?? 0}</small>
                  </button>
                ) : null
              ))}
            </div>
          </div>
          <div className="logs-filter-group">
            <span className="logs-filter-label">级别</span>
            <div className="logs-filter-chips">
              <button
                type="button"
                className={`logs-filter-chip ${levelFilter === 'all' ? 'active' : ''}`}
                onClick={() => setLevelFilter('all')}
              >
                全部 <small>{levelCounts.all ?? 0}</small>
              </button>
              {(Object.keys(levelLabels) as LogLevel[]).map((key) => (
                levelCounts[key] != null ? (
                  <button
                    key={key}
                    type="button"
                    className={`logs-filter-chip ${levelFilter === key ? 'active' : ''}`}
                    onClick={() => setLevelFilter(key)}
                  >
                    {levelLabels[key]} <small>{levelCounts[key] ?? 0}</small>
                  </button>
                ) : null
              ))}
            </div>
          </div>
        </div>

        {filteredLogs.length ? (
          <div className="logs-list">
            {filteredLogs.map((log) => (
              <article key={log.id} className={`log-entry log-level-${log.level}`}>
                <span className={`log-level-indicator ${log.level}`} title={levelLabels[log.level]}>
                  {levelIcons[log.level]}
                </span>
                <div className="log-body">
                  <div className="log-header">
                    <strong className="log-message">{log.message}</strong>
                    <span className="log-category">{categoryLabels[log.category]}</span>
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
            <h3>{logs.length ? '没有匹配的日志' : '暂无日志'}</h3>
            <p>{logs.length ? '清空搜索条件或切换筛选器后再试。' : '连接、密钥和操作日志会自动记录在这里。'}</p>
          </div>
        )}
      </section>
    </>
  );
}

export default LogsPage;
