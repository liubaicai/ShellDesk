import { useCallback, useEffect, useMemo, useState } from 'react';

import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import {
  aggregateLoginSources,
  createCurrentSessionsCommand,
  createFailedLoginCommand,
  createLoginHistoryCommand,
  formatLoginRecord,
  parseCurrentSessions,
  parseLoginHistory,
  type LoginHistoryEntry,
  type LoginSessionEntry,
  type LoginSessionTab,
} from './loginSessionParsers';
import { isWindowsSystem } from './remoteSystem';
import type { RemoteSystemType } from './types';

interface RemoteLoginSessionsProps {
  connectionId: string;
  systemType?: RemoteSystemType;
  onOpenSecurityAudit?: () => void;
}

type LoginRecord = LoginSessionEntry | LoginHistoryEntry;

function runCmd(connectionId: string, command: string) {
  const api = window.guiSSH?.connections;

  if (!api) {
    throw new Error('ShellDesk IPC 未就绪。');
  }

  return api.runCommand(connectionId, command);
}

function isHistoryEntry(record: LoginRecord): record is LoginHistoryEntry {
  return 'success' in record;
}

function RemoteLoginSessions({ connectionId, systemType, onOpenSecurityAudit }: RemoteLoginSessionsProps) {
  const isWindowsHost = isWindowsSystem(systemType);
  const [activeTab, setActiveTab] = useState<LoginSessionTab>('current');
  const [currentSessions, setCurrentSessions] = useState<LoginSessionEntry[]>([]);
  const [historyEntries, setHistoryEntries] = useState<LoginHistoryEntry[]>([]);
  const [failedEntries, setFailedEntries] = useState<LoginHistoryEntry[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [loadingTab, setLoadingTab] = useState<LoginSessionTab | null>(null);
  const [loadedTabs, setLoadedTabs] = useState<Set<LoginSessionTab>>(() => new Set());
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loadedAt, setLoadedAt] = useState('');

  const activeEntries = useMemo<LoginRecord[]>(() => {
    if (activeTab === 'current') return currentSessions;
    if (activeTab === 'history') return historyEntries;
    return failedEntries;
  }, [activeTab, currentSessions, failedEntries, historyEntries]);
  const selectedRecord = activeEntries.find((entry) => entry.id === selectedId) ?? activeEntries[0] ?? null;
  const failedSourceStats = useMemo(() => aggregateLoginSources(failedEntries).slice(0, 8), [failedEntries]);

  const loadTab = useCallback(async (tab: LoginSessionTab) => {
    setLoadingTab(tab);
    setError('');
    setNotice('');

    try {
      const command = tab === 'current'
        ? createCurrentSessionsCommand(isWindowsHost)
        : tab === 'history'
          ? createLoginHistoryCommand(isWindowsHost)
          : createFailedLoginCommand(isWindowsHost);
      const result = await runCmd(connectionId, command);

      if (tab === 'current') {
        const entries = parseCurrentSessions(result.stdout, isWindowsHost);
        setCurrentSessions(entries);
        setSelectedId((currentId) => (entries.some((entry) => entry.id === currentId) ? currentId : entries[0]?.id ?? ''));
      } else if (tab === 'history') {
        const entries = parseLoginHistory(result.stdout, true, isWindowsHost);
        setHistoryEntries(entries);
        setSelectedId((currentId) => (entries.some((entry) => entry.id === currentId) ? currentId : entries[0]?.id ?? ''));
      } else {
        const entries = parseLoginHistory(result.stdout, false, isWindowsHost);
        setFailedEntries(entries);
        setSelectedId((currentId) => (entries.some((entry) => entry.id === currentId) ? currentId : entries[0]?.id ?? ''));
      }

      setLoadedAt(new Date().toLocaleTimeString(getShellDeskLocale()));
      setLoadedTabs((current) => new Set(current).add(tab));
      if (result.code !== 0 || result.stderr.trim()) {
        setNotice(result.stderr || '命令返回非零状态，已尽量解析可用输出。');
      }
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setLoadingTab(null);
    }
  }, [connectionId, isWindowsHost]);

  useEffect(() => {
    void loadTab('current');
  }, [loadTab]);

  useEffect(() => {
    if (!loadedTabs.has(activeTab)) {
      void loadTab(activeTab);
    }
  }, [activeTab, loadTab, loadedTabs]);

  const switchTab = (tab: LoginSessionTab) => {
    setActiveTab(tab);
    setSelectedId('');
    setError('');
    setNotice('');
  };

  const copyRecord = async (record: LoginRecord) => {
    await navigator.clipboard.writeText(formatLoginRecord(record));
    setNotice('已复制登录记录。');
  };

  const copySource = async (source: string) => {
    await navigator.clipboard.writeText(source);
    setNotice('已复制来源地址。');
  };

  return (
    <section className="login-sessions">
      <header className="login-toolbar">
        <div className="login-tabs" role="tablist" aria-label="登录会话视图">
          <button type="button" className={activeTab === 'current' ? 'active' : ''} onClick={() => switchTab('current')}>当前在线</button>
          <button type="button" className={activeTab === 'history' ? 'active' : ''} onClick={() => switchTab('history')}>登录历史</button>
          <button type="button" className={activeTab === 'failed' ? 'active' : ''} onClick={() => switchTab('failed')}>失败登录</button>
        </div>
        <div className="login-toolbar-actions">
          <button type="button" className="primary" onClick={() => loadTab(activeTab)} disabled={loadingTab !== null}>
            {loadingTab === activeTab ? '刷新中' : '刷新'}
          </button>
          <button type="button" onClick={onOpenSecurityAudit} disabled={!onOpenSecurityAudit}>安全巡检</button>
          <span>{isWindowsHost ? 'Windows Event Log' : 'w / last / lastb'}{loadedAt ? ` · ${loadedAt}` : ''}</span>
        </div>
      </header>

      {error ? <div className="login-alert danger">{error}</div> : null}
      {notice ? <div className="login-alert info">{notice}</div> : null}

      <div className="login-content">
        <main className="login-table-panel">
          <div className="login-table-head">
            <strong>{activeTab === 'current' ? '在线会话' : activeTab === 'history' ? '成功登录' : '失败登录'}</strong>
            <span>{activeEntries.length} 条</span>
          </div>
          <div className="login-table-wrap">
            <table className="login-table">
              <thead>
                <tr>
                  <th>用户</th>
                  <th>来源</th>
                  <th>{activeTab === 'current' ? 'TTY' : '开始时间'}</th>
                  <th>{activeTab === 'current' ? '空闲' : '结束/持续'}</th>
                  <th>原始记录</th>
                </tr>
              </thead>
              <tbody>
                {activeEntries.map((entry) => (
                  <tr key={entry.id} className={selectedRecord?.id === entry.id ? 'selected' : ''} onClick={() => setSelectedId(entry.id)}>
                    <td><strong>{entry.user}</strong></td>
                    <td title={entry.source}>{entry.source || '-'}</td>
                    <td>{isHistoryEntry(entry) ? entry.startedAt || '-' : entry.tty || '-'}</td>
                    <td>{isHistoryEntry(entry) ? [entry.endedAt, entry.duration].filter(Boolean).join(' · ') || '-' : entry.idle || '-'}</td>
                    <td title={entry.raw}>{entry.raw}</td>
                  </tr>
                ))}
                {!loadingTab && activeEntries.length === 0 ? (
                  <tr><td colSpan={5} className="login-empty-cell">没有可展示的登录记录。</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </main>

        <aside className="login-detail-panel">
          {activeTab === 'failed' && failedSourceStats.length ? (
            <section className="login-source-stats">
              <h3>失败来源聚合</h3>
              {failedSourceStats.map((item) => (
                <button key={item.source} type="button" onClick={() => copySource(item.source)}>
                  <strong>{item.source}</strong>
                  <span>{item.count} 次</span>
                </button>
              ))}
            </section>
          ) : null}

          {selectedRecord ? (
            <section className="login-record-detail">
              <div className="login-detail-title">
                <span>{isHistoryEntry(selectedRecord) ? (selectedRecord.success ? '成功登录' : '失败登录') : '在线会话'}</span>
                <strong>{selectedRecord.user}</strong>
              </div>
              <dl>
                <div><dt>来源</dt><dd>{selectedRecord.source || '-'}</dd></div>
                {isHistoryEntry(selectedRecord) ? (
                  <>
                    <div><dt>开始</dt><dd>{selectedRecord.startedAt || '-'}</dd></div>
                    <div><dt>结束</dt><dd>{selectedRecord.endedAt || '-'}</dd></div>
                    <div><dt>持续</dt><dd>{selectedRecord.duration || '-'}</dd></div>
                  </>
                ) : (
                  <>
                    <div><dt>TTY</dt><dd>{selectedRecord.tty || '-'}</dd></div>
                    <div><dt>登录</dt><dd>{selectedRecord.loginAt || '-'}</dd></div>
                    <div><dt>命令</dt><dd>{selectedRecord.command || '-'}</dd></div>
                  </>
                )}
              </dl>
              <div className="login-detail-actions">
                <button type="button" onClick={() => copyRecord(selectedRecord)}>复制记录</button>
                <button type="button" onClick={() => selectedRecord.source ? copySource(selectedRecord.source) : undefined} disabled={!selectedRecord.source}>复制来源</button>
              </div>
              <pre>{selectedRecord.raw}</pre>
              {activeTab === 'failed' ? (
                <div className="login-advice">
                  失败来源频繁出现时，可结合安全巡检和防火墙规则限制来源。
                </div>
              ) : null}
            </section>
          ) : (
            <div className="login-empty-detail">选择一条记录查看详情。</div>
          )}
        </aside>
      </div>
    </section>
  );
}

export default RemoteLoginSessions;
