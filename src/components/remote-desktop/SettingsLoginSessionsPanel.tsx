import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import DismissibleAlert from './DismissibleAlert';
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
import { useRemoteSettingsCommand } from './settingsShared';
import type { RemoteSystemType } from './types';
import { tCurrent } from '../../i18n';

interface SettingsLoginSessionsPanelProps {
  connectionId: string;
  systemType?: RemoteSystemType;
}

type LoginRecord = LoginSessionEntry | LoginHistoryEntry;

function isHistoryEntry(record: LoginRecord): record is LoginHistoryEntry {
  return 'success' in record;
}

function LoginRecordDetailDialog({
  activeTab,
  record,
  onClose,
  onCopyRecord,
  onCopySource,
}: {
  activeTab: LoginSessionTab;
  record: LoginRecord;
  onClose: () => void;
  onCopyRecord: (record: LoginRecord) => Promise<void>;
  onCopySource: (source: string) => Promise<void>;
}) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  if (typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div className="login-detail-modal-backdrop" role="presentation" onClick={onClose}>
      <section className="login-record-detail login-detail-modal" role="dialog" aria-modal="true" aria-label={tCurrent('auto.remoteLoginSessions.detailTitle')} data-testid="login-detail-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="login-detail-title">
          <span>{isHistoryEntry(record) ? (record.success ? tCurrent('auto.remoteLoginSessions.1c45v7w2') : tCurrent('auto.remoteLoginSessions.72f95b3')) : tCurrent('auto.remoteLoginSessions.17fvhtt2')}</span>
          <strong>{record.user}</strong>
          <button type="button" className="login-detail-close" onClick={onClose} aria-label={tCurrent('common.close')}>&times;</button>
        </div>
        <dl>
          <div><dt>{tCurrent('auto.remoteLoginSessions.2tds9c2')}</dt><dd>{record.source || '-'}</dd></div>
          {isHistoryEntry(record) ? (
            <>
              <div><dt>{tCurrent('auto.remoteLoginSessions.9jqa4c')}</dt><dd>{record.startedAt || '-'}</dd></div>
              <div><dt>{tCurrent('auto.remoteLoginSessions.8893k7')}</dt><dd>{record.endedAt || '-'}</dd></div>
              <div><dt>{tCurrent('auto.remoteLoginSessions.1d8dbqr')}</dt><dd>{record.duration || '-'}</dd></div>
            </>
          ) : (
            <>
              <div><dt>TTY</dt><dd>{record.tty || '-'}</dd></div>
              <div><dt>{tCurrent('auto.remoteLoginSessions.1yggxgd')}</dt><dd>{record.loginAt || '-'}</dd></div>
              <div><dt>{tCurrent('auto.remoteLoginSessions.emgxwk')}</dt><dd>{record.command || '-'}</dd></div>
            </>
          )}
        </dl>
        <div className="login-detail-actions">
          <button type="button" onClick={() => void onCopyRecord(record)}>{tCurrent('auto.remoteLoginSessions.3o3a75')}</button>
          <button type="button" onClick={() => (record.source ? void onCopySource(record.source) : undefined)} disabled={!record.source}>{tCurrent('auto.remoteLoginSessions.p1fn07')}</button>
          <button type="button" onClick={onClose}>{tCurrent('common.close')}</button>
        </div>
        <pre>{record.raw}</pre>
        {activeTab === 'failed' ? (
          <div className="login-advice">
            {tCurrent('auto.remoteLoginSessions.1f24xiy')}
          </div>
        ) : null}
      </section>
    </div>,
    document.body,
  );
}

export default function SettingsLoginSessionsPanel({ systemType }: SettingsLoginSessionsPanelProps) {
  const runCommand = useRemoteSettingsCommand();
  const isWindowsHost = isWindowsSystem(systemType);
  const [activeTab, setActiveTab] = useState<LoginSessionTab>('current');
  const [currentSessions, setCurrentSessions] = useState<LoginSessionEntry[]>([]);
  const [historyEntries, setHistoryEntries] = useState<LoginHistoryEntry[]>([]);
  const [failedEntries, setFailedEntries] = useState<LoginHistoryEntry[]>([]);
  const [detailRecord, setDetailRecord] = useState<LoginRecord | null>(null);
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
  const failedSourceStats = useMemo(() => aggregateLoginSources(failedEntries).slice(0, 8), [failedEntries]);
  const emptyMessage = activeTab === 'current'
    ? tCurrent('auto.remoteLoginSessions.currentEmpty')
    : tCurrent('auto.remoteLoginSessions.1qd5m2o');

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
      const result = await runCommand(command);

      if (tab === 'current') {
        const entries = parseCurrentSessions(result.stdout, isWindowsHost);
        setCurrentSessions(entries);
      } else if (tab === 'history') {
        const entries = parseLoginHistory(result.stdout, true, isWindowsHost);
        setHistoryEntries(entries);
      } else {
        const entries = parseLoginHistory(result.stdout, false, isWindowsHost);
        setFailedEntries(entries);
      }

      setLoadedAt(new Date().toLocaleTimeString(getShellDeskLocale()));
      setLoadedTabs((current) => new Set(current).add(tab));
      if (result.code !== 0 || result.stderr.trim()) {
        setNotice(result.stderr || tCurrent('auto.remoteLoginSessions.xxe616'));
      }
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoadingTab(null);
    }
  }, [isWindowsHost, runCommand]);

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
    setDetailRecord(null);
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
    <div className="settings-panel-content">
      <div className="settings-panel-header">
        <div>
          <h3>{tCurrent('remoteSettings.tab.loginsessions.label')}</h3>
          <p>{isWindowsHost ? 'Windows Event Log' : 'w / last / lastb'}{loadedAt ? ` · ${loadedAt}` : ''}</p>
        </div>
        <button type="button" className="settings-action-btn" onClick={() => loadTab(activeTab)} disabled={loadingTab !== null}>
          {loadingTab === activeTab ? tCurrent('auto.remoteLoginSessions.1taxqz1') : tCurrent('auto.remoteLoginSessions.12qo56a')}
        </button>
      </div>

      <section className="login-sessions">
        <header className="login-toolbar">
          <div className="login-tabs" role="tablist" aria-label={tCurrent('auto.remoteLoginSessions.y0rj8c')}>
            <button type="button" className={activeTab === 'current' ? 'active' : ''} onClick={() => switchTab('current')}>{tCurrent('auto.remoteLoginSessions.t0dnkg')}</button>
            <button type="button" className={activeTab === 'history' ? 'active' : ''} onClick={() => switchTab('history')}>{tCurrent('auto.remoteLoginSessions.a5jayx')}</button>
            <button type="button" className={activeTab === 'failed' ? 'active' : ''} onClick={() => switchTab('failed')}>{tCurrent('auto.remoteLoginSessions.72f95b')}</button>
          </div>
          <div className="login-toolbar-actions">
            <span>{activeEntries.length} {tCurrent('auto.remoteLoginSessions.1rfm5gs')}</span>
          </div>
        </header>

        {error ? <DismissibleAlert className="login-alert danger" source="RemoteSettings" onDismiss={() => setError('')} role="alert">{error}</DismissibleAlert> : null}
        {notice ? <DismissibleAlert className="login-alert info" source="RemoteSettings" onDismiss={() => setNotice('')}>{notice}</DismissibleAlert> : null}

        {activeTab === 'failed' && failedSourceStats.length ? (
          <section className="login-source-stats login-source-stats-inline">
            <h3>{tCurrent('auto.remoteLoginSessions.1cgmhak')}</h3>
            {failedSourceStats.map((item) => (
              <button key={item.source} type="button" onClick={() => copySource(item.source)}>
                <strong>{item.source}</strong>
                <span>{item.count} {tCurrent('auto.remoteLoginSessions.a5jtgs')}</span>
              </button>
            ))}
          </section>
        ) : null}

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
                    <tr key={entry.id} data-testid={`login-session-row-${entry.user}`} onClick={() => setDetailRecord(entry)}>
                      <td><strong>{entry.user}</strong></td>
                      <td title={entry.source}>{entry.source || '-'}</td>
                      <td>{isHistoryEntry(entry) ? entry.startedAt || '-' : entry.tty || '-'}</td>
                      <td>{isHistoryEntry(entry) ? [entry.endedAt, entry.duration].filter(Boolean).join(' · ') || '-' : entry.idle || '-'}</td>
                      <td title={entry.raw}>{entry.raw}</td>
                    </tr>
                  ))}
                  {!loadingTab && activeEntries.length === 0 ? (
                    <tr><td colSpan={5} className="login-empty-cell">{emptyMessage}</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </main>
        </div>
      </section>
      {detailRecord ? (
        <LoginRecordDetailDialog
          activeTab={activeTab}
          record={detailRecord}
          onClose={() => setDetailRecord(null)}
          onCopyRecord={copyRecord}
          onCopySource={copySource}
        />
      ) : null}
    </div>
  );
}
