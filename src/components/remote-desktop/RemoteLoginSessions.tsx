import { useCallback, useEffect, useMemo, useState } from 'react';
import DismissibleAlert from './DismissibleAlert';

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
import { tCurrent } from '../../i18n';

interface RemoteLoginSessionsProps {
  connectionId: string;
  systemType?: RemoteSystemType;
  onOpenSecurityAudit?: () => void;
}

type LoginRecord = LoginSessionEntry | LoginHistoryEntry;

function runCmd(connectionId: string, command: string) {
  const api = window.guiSSH?.connections;

  if (!api) {
    throw new Error(tCurrent('auto.remoteLoginSessions.g77vf3'));
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
        setNotice(result.stderr || tCurrent('auto.remoteLoginSessions.xxe616'));
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
    setNotice(tCurrent('auto.remoteLoginSessions.1a9f3ox'));
  };

  const copySource = async (source: string) => {
    await navigator.clipboard.writeText(source);
    setNotice(tCurrent('auto.remoteLoginSessions.1u8977b'));
  };

  return (
    <section className="login-sessions">
      <header className="login-toolbar">
        <div className="login-tabs" role="tablist" aria-label={tCurrent('auto.remoteLoginSessions.y0rj8c')}>
          <button type="button" className={activeTab === 'current' ? 'active' : ''} onClick={() => switchTab('current')}>{tCurrent('auto.remoteLoginSessions.t0dnkg')}</button>
          <button type="button" className={activeTab === 'history' ? 'active' : ''} onClick={() => switchTab('history')}>{tCurrent('auto.remoteLoginSessions.a5jayx')}</button>
          <button type="button" className={activeTab === 'failed' ? 'active' : ''} onClick={() => switchTab('failed')}>{tCurrent('auto.remoteLoginSessions.72f95b')}</button>
        </div>
        <div className="login-toolbar-actions">
          <button type="button" className="primary" onClick={() => loadTab(activeTab)} disabled={loadingTab !== null}>
            {loadingTab === activeTab ? tCurrent('auto.remoteLoginSessions.1taxqz1') : tCurrent('auto.remoteLoginSessions.12qo56a')}
          </button>
          <button type="button" onClick={onOpenSecurityAudit} disabled={!onOpenSecurityAudit}>{tCurrent('auto.remoteLoginSessions.1r3p6od')}</button>
          <span>{isWindowsHost ? 'Windows Event Log' : 'w / last / lastb'}{loadedAt ? ` · ${loadedAt}` : ''}</span>
        </div>
      </header>

      {error ? <DismissibleAlert className="login-alert danger" onDismiss={() => setError('')} role="alert">{error}</DismissibleAlert> : null}
      {notice ? <DismissibleAlert className="login-alert info" onDismiss={() => setNotice('')}>{notice}</DismissibleAlert> : null}

      <div className="login-content">
        <main className="login-table-panel">
          <div className="login-table-head">
            <strong>{activeTab === 'current' ? tCurrent('auto.remoteLoginSessions.17fvhtt') : activeTab === 'history' ? tCurrent('auto.remoteLoginSessions.1c45v7w') : tCurrent('auto.remoteLoginSessions.72f95b2')}</strong>
            <span>{activeEntries.length} {tCurrent('auto.remoteLoginSessions.1rfm5gs')}</span>
          </div>
          <div className="login-table-wrap">
            <table className="login-table">
              <thead>
                <tr>
                  <th>{tCurrent('auto.remoteLoginSessions.1in002o')}</th>
                  <th>{tCurrent('auto.remoteLoginSessions.2tds9c')}</th>
                  <th>{activeTab === 'current' ? 'TTY' : tCurrent('auto.remoteLoginSessions.j6x7pa')}</th>
                  <th>{activeTab === 'current' ? tCurrent('auto.remoteLoginSessions.15lihe5') : tCurrent('auto.remoteLoginSessions.1j3hwiq')}</th>
                  <th>{tCurrent('auto.remoteLoginSessions.ii3s0o')}</th>
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
                  <tr><td colSpan={5} className="login-empty-cell">{tCurrent('auto.remoteLoginSessions.1qd5m2o')}</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </main>

        <aside className="login-detail-panel">
          {activeTab === 'failed' && failedSourceStats.length ? (
            <section className="login-source-stats">
              <h3>{tCurrent('auto.remoteLoginSessions.1cgmhak')}</h3>
              {failedSourceStats.map((item) => (
                <button key={item.source} type="button" onClick={() => copySource(item.source)}>
                  <strong>{item.source}</strong>
                  <span>{item.count} {tCurrent('auto.remoteLoginSessions.a5jtgs')}</span>
                </button>
              ))}
            </section>
          ) : null}

          {selectedRecord ? (
            <section className="login-record-detail">
              <div className="login-detail-title">
                <span>{isHistoryEntry(selectedRecord) ? (selectedRecord.success ? tCurrent('auto.remoteLoginSessions.1c45v7w2') : tCurrent('auto.remoteLoginSessions.72f95b3')) : tCurrent('auto.remoteLoginSessions.17fvhtt2')}</span>
                <strong>{selectedRecord.user}</strong>
              </div>
              <dl>
                <div><dt>{tCurrent('auto.remoteLoginSessions.2tds9c2')}</dt><dd>{selectedRecord.source || '-'}</dd></div>
                {isHistoryEntry(selectedRecord) ? (
                  <>
                    <div><dt>{tCurrent('auto.remoteLoginSessions.9jqa4c')}</dt><dd>{selectedRecord.startedAt || '-'}</dd></div>
                    <div><dt>{tCurrent('auto.remoteLoginSessions.8893k7')}</dt><dd>{selectedRecord.endedAt || '-'}</dd></div>
                    <div><dt>{tCurrent('auto.remoteLoginSessions.1d8dbqr')}</dt><dd>{selectedRecord.duration || '-'}</dd></div>
                  </>
                ) : (
                  <>
                    <div><dt>TTY</dt><dd>{selectedRecord.tty || '-'}</dd></div>
                    <div><dt>{tCurrent('auto.remoteLoginSessions.1yggxgd')}</dt><dd>{selectedRecord.loginAt || '-'}</dd></div>
                    <div><dt>{tCurrent('auto.remoteLoginSessions.emgxwk')}</dt><dd>{selectedRecord.command || '-'}</dd></div>
                  </>
                )}
              </dl>
              <div className="login-detail-actions">
                <button type="button" onClick={() => copyRecord(selectedRecord)}>{tCurrent('auto.remoteLoginSessions.3o3a75')}</button>
                <button type="button" onClick={() => selectedRecord.source ? copySource(selectedRecord.source) : undefined} disabled={!selectedRecord.source}>{tCurrent('auto.remoteLoginSessions.p1fn07')}</button>
              </div>
              <pre>{selectedRecord.raw}</pre>
              {activeTab === 'failed' ? (
                <div className="login-advice">
                  {tCurrent('auto.remoteLoginSessions.1f24xiy')}</div>
              ) : null}
            </section>
          ) : (
            <div className="login-empty-detail">{tCurrent('auto.remoteLoginSessions.1rwz8oc')}</div>
          )}
        </aside>
      </div>
    </section>
  );
}

export default RemoteLoginSessions;
