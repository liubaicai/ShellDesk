import { type FormEvent, useCallback, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Columns3,
  Eye,
  EyeOff,
  FolderSync,
  GitCompareArrows,
  LockKeyhole,
  Pencil,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';

import type { AppLanguage } from '../../i18n';
import type { RemoteConnectionInfo } from '../remote-desktop/types';
import { formatBytes } from '../remote-desktop/fileExplorerUtils';
import { getErrorMessage } from '../remote-desktop/desktopUtils';
import FilePane from './FilePane';
import TransferQueue from './TransferQueue';
import { getSftpMessages } from './messages';
import { getPathName, isWindowsPlatform, joinPanePath } from './pathUtils';
import type { FileOperationDialog, SftpTransferConflictDialog, TransferFileEntry, TransferPaneKind } from './types';
import { useFilePane } from './useFilePane';
import { useTransferQueue } from './useTransferQueue';

interface SftpTransferWindowProps {
  connection: RemoteConnectionInfo;
  language: AppLanguage;
}

function topLevelDifferenceNames(paths: string[]) {
  return new Set(paths.map((path) => path.replaceAll('\\', '/').split('/')[0]).filter(Boolean));
}

export default function SftpTransferWindow({ connection, language }: SftpTransferWindowProps) {
  const t = useMemo(() => getSftpMessages(language), [language]);
  const windowsLocal = isWindowsPlatform(window.guiSSH?.platform);
  const [activePane, setActivePane] = useState<TransferPaneKind>('local');
  const [showHidden, setShowHidden] = useState(false);
  const [queueVisible, setQueueVisible] = useState(true);
  const [queueFilter, setQueueFilter] = useState<'all' | 'queued' | 'running' | 'completed' | 'failed'>('all');
  const [dialog, setDialog] = useState<FileOperationDialog | null>(null);
  const [dialogValue, setDialogValue] = useState('');
  const [recursivePermissions, setRecursivePermissions] = useState(false);
  const [notice, setNotice] = useState('');
  const [localDifferences, setLocalDifferences] = useState(new Set<string>());
  const [remoteDifferences, setRemoteDifferences] = useState(new Set<string>());
  const [comparing, setComparing] = useState(false);
  const [conflictDialog, setConflictDialog] = useState<SftpTransferConflictDialog | null>(null);
  const [resolvingConflicts, setResolvingConflicts] = useState(false);
  const [conflictError, setConflictError] = useState('');

  const loadLocalDirectory = useCallback((path: string) => {
    if (!window.guiSSH?.files.listLocalDirectory) return Promise.reject(new Error('Local file browsing is unavailable.'));
    return window.guiSSH.files.listLocalDirectory(path);
  }, []);
  const loadRemoteDirectory = useCallback((path: string) => {
    if (!window.guiSSH?.connections.sftpListDirectory) return Promise.reject(new Error(t('sftpUnavailable')));
    return window.guiSSH.connections.sftpListDirectory(connection.id, path);
  }, [connection.id, t]);

  const localPane = useFilePane({ kind: 'local', initialPath: '/', loadDirectory: loadLocalDirectory });
  const remotePane = useFilePane({ kind: 'remote', initialPath: '.', loadDirectory: loadRemoteDirectory });
  const refreshBoth = useCallback(() => {
    void Promise.allSettled([localPane.refresh(), remotePane.refresh()]);
  }, [localPane.refresh, remotePane.refresh]);
  const transferQueue = useTransferQueue({ connectionId: connection.id, onTransferFinished: refreshBoth });

  const paneFor = (kind: TransferPaneKind) => kind === 'local' ? localPane : remotePane;
  const entryPath = (kind: TransferPaneKind, entry: TransferFileEntry) => {
    const pane = paneFor(kind);
    return joinPanePath(kind, pane.state.path, entry.name, kind === 'local' && windowsLocal);
  };

  const queueUpload = useCallback((entries: TransferFileEntry[], summaries: ShellDeskSftpTransferSummary[] = [], conflictPolicy: 'overwrite' | 'skip' = 'overwrite') => {
    if (!entries.length) return;
    const summaryByName = new Map(summaries.map((summary) => [summary.name, summary]));
    const hasUnplannedDirectory = entries.some((entry) => entry.type === 'directory' && !summaryByName.has(entry.name));
    const plannedSize = conflictPolicy === 'skip' || hasUnplannedDirectory ? undefined : entries.reduce((total, entry) => total + (summaryByName.get(entry.name)?.size ?? entry.size), 0);
    const plannedFileCount = conflictPolicy === 'skip' || hasUnplannedDirectory ? undefined : entries.reduce((total, entry) => total + (summaryByName.get(entry.name)?.fileCount ?? 1), 0);
    transferQueue.enqueue([{
      direction: 'upload',
      label: entries.length === 1 ? entries[0].name : `${entries.length} ${t('items')}`,
      sourcePaths: entries.map((entry) => joinPanePath('local', localPane.state.path, entry.name, windowsLocal)),
      targetPath: remotePane.state.path,
      plannedSize,
      plannedFileCount,
      conflictPolicy,
    }]);
    setQueueVisible(true);
    setQueueFilter('all');
  }, [localPane.state.path, remotePane.state.path, t, transferQueue.enqueue, windowsLocal]);
  const queueDownload = useCallback((entries: TransferFileEntry[], summaries: ShellDeskSftpTransferSummary[] = [], conflictPolicy: 'overwrite' | 'skip' = 'overwrite') => {
    if (!entries.length) return;
    const summaryByName = new Map(summaries.map((summary) => [summary.name, summary]));
    const hasUnplannedDirectory = entries.some((entry) => entry.type === 'directory' && !summaryByName.has(entry.name));
    const plannedSize = conflictPolicy === 'skip' || hasUnplannedDirectory ? undefined : entries.reduce((total, entry) => total + (summaryByName.get(entry.name)?.size ?? entry.size), 0);
    const plannedFileCount = conflictPolicy === 'skip' || hasUnplannedDirectory ? undefined : entries.reduce((total, entry) => total + (summaryByName.get(entry.name)?.fileCount ?? 1), 0);
    transferQueue.enqueue([{
      direction: 'download',
      label: entries.length === 1 ? entries[0].name : `${entries.length} ${t('items')}`,
      sourcePaths: entries.map((entry) => joinPanePath('remote', remotePane.state.path, entry.name, false)),
      targetPath: localPane.state.path,
      plannedSize,
      plannedFileCount,
      conflictPolicy,
    }]);
    setQueueVisible(true);
    setQueueFilter('all');
  }, [localPane.state.path, remotePane.state.path, t, transferQueue.enqueue]);

  const findConflicts = useCallback((entries: TransferFileEntry[], direction: 'upload' | 'download') => {
    const destinations = direction === 'upload' ? remotePane.state.entries : localPane.state.entries;
    const normalizeName = (name: string) => direction === 'download' && windowsLocal ? name.toLocaleLowerCase() : name;
    const destinationByName = new Map(destinations.map((entry) => [normalizeName(entry.name), entry]));
    return entries.flatMap((source) => {
      const destination = destinationByName.get(normalizeName(source.name));
      return destination ? [{ source, destination }] : [];
    });
  }, [localPane.state.entries, remotePane.state.entries, windowsLocal]);

  const requestTransfer = useCallback((
    direction: 'upload' | 'download',
    entries: TransferFileEntry[],
    summaries: ShellDeskSftpTransferSummary[] = [],
  ) => {
    if (!entries.length) return;
    const conflicts = findConflicts(entries, direction);
    if (conflicts.length) {
      setConflictError('');
      setConflictDialog({ direction, entries, summaries, conflicts });
      return;
    }
    if (direction === 'upload') queueUpload(entries, summaries);
    else queueDownload(entries, summaries);
  }, [findConflicts, queueDownload, queueUpload]);

  const enqueueUpload = useCallback((entries: TransferFileEntry[], summaries: ShellDeskSftpTransferSummary[] = []) => {
    requestTransfer('upload', entries, summaries);
  }, [requestTransfer]);
  const enqueueDownload = useCallback((entries: TransferFileEntry[], summaries: ShellDeskSftpTransferSummary[] = []) => {
    requestTransfer('download', entries, summaries);
  }, [requestTransfer]);

  const resolveTransferConflicts = useCallback(async (action: 'overwrite' | 'skip') => {
    if (!conflictDialog || resolvingConflicts) return;
    setResolvingConflicts(true);
    setConflictError('');
    try {
      if (action === 'skip') {
        if (conflictDialog.direction === 'upload') queueUpload(conflictDialog.entries, conflictDialog.summaries, 'skip');
        else queueDownload(conflictDialog.entries, conflictDialog.summaries, 'skip');
        setNotice(t('conflictSkipApplied'));
      } else {
        const guiSSH = window.guiSSH;
        if (!guiSSH) throw new Error(t('sftpUnavailable'));
        const typeMismatches = conflictDialog.conflicts.filter(({ source, destination }) => source.type !== destination.type);
        for (const { destination } of typeMismatches) {
          if (conflictDialog.direction === 'upload') {
            const path = joinPanePath('remote', remotePane.state.path, destination.name, false);
            await guiSSH.connections.sftpDeletePath(connection.id, path, destination.type);
          } else {
            const path = joinPanePath('local', localPane.state.path, destination.name, windowsLocal);
            await guiSSH.files.deleteLocalPath(path, destination.type);
          }
        }
        if (conflictDialog.direction === 'upload') queueUpload(conflictDialog.entries, conflictDialog.summaries);
        else queueDownload(conflictDialog.entries, conflictDialog.summaries);
      }
      setConflictDialog(null);
      await Promise.allSettled([localPane.refresh(), remotePane.refresh()]);
    } catch (error) {
      setConflictError(getErrorMessage(error));
    } finally {
      setResolvingConflicts(false);
    }
  }, [conflictDialog, connection.id, localPane.refresh, localPane.state.path, queueDownload, queueUpload, remotePane.refresh, remotePane.state.path, resolvingConflicts, t, windowsLocal]);

  const openDialog = useCallback(async (kind: FileOperationDialog['kind'], pane: TransferPaneKind, entries: TransferFileEntry[] = []) => {
    const next: FileOperationDialog = { kind, pane, entries };
    setDialog(next);
    setDialogValue(kind === 'rename' ? entries[0]?.name ?? '' : kind === 'properties' ? '0644' : '');
    setRecursivePermissions(false);
    if (kind === 'properties' && entries[0]) {
      setDialog({ ...next, loading: true });
      try {
        const guiSSH = window.guiSSH;
        if (!guiSSH) throw new Error(t('sftpUnavailable'));
        const path = entryPath(pane, entries[0]);
        const stat = pane === 'local'
          ? await guiSSH.files.statLocalPath(path)
          : await guiSSH.connections.sftpStatPath(connection.id, path);
        setDialog({ ...next, stat, loading: false });
        setDialogValue(stat.mode ? stat.mode.toString(8).padStart(4, '0') : '0644');
      } catch (error) {
        setDialog({ ...next, error: getErrorMessage(error), loading: false });
      }
    }
  }, [connection.id, entryPath, t]);

  const compareDirectories = useCallback(async () => {
    const controls = window.guiSSH?.connections;
    if (!controls?.sftpCompareDirectory) throw new Error(t('sftpUnavailable'));
    setComparing(true);
    try {
      const comparison = await controls.sftpCompareDirectory(
        connection.id,
        localPane.state.path,
        remotePane.state.path,
      );
      setLocalDifferences(topLevelDifferenceNames(comparison.localDifferences));
      setRemoteDifferences(topLevelDifferenceNames(comparison.remoteDifferences));
      setNotice(comparison.differenceCount ? t('compareDifferent', { count: comparison.differenceCount }) : t('compareSame'));
      return comparison;
    } finally {
      setComparing(false);
    }
  }, [connection.id, localPane.state.path, remotePane.state.path, t]);

  const runDialogOperation = async (event: FormEvent) => {
    event.preventDefault();
    if (!dialog) return;
    const pane = paneFor(dialog.pane);
    const isLocal = dialog.pane === 'local';
    const guiSSH = window.guiSSH;
    setDialog((current) => current ? { ...current, loading: true, error: '' } : current);
    try {
      if (!guiSSH) throw new Error(t('sftpUnavailable'));
      const controls = guiSSH.connections;
      if (dialog.kind === 'new-folder' || dialog.kind === 'new-file') {
        const target = joinPanePath(dialog.pane, pane.state.path, dialogValue.trim(), isLocal && windowsLocal);
        if (isLocal) {
          if (dialog.kind === 'new-folder') await guiSSH.files.createLocalDirectory(target);
          else await guiSSH.files.createLocalFile(target);
        } else if (dialog.kind === 'new-folder') await controls.sftpCreateDirectory(connection.id, target);
        else await controls.sftpCreateFile(connection.id, target);
      } else if (dialog.kind === 'rename' && dialog.entries[0]) {
        const oldPath = entryPath(dialog.pane, dialog.entries[0]);
        const newPath = joinPanePath(dialog.pane, pane.state.path, dialogValue.trim(), isLocal && windowsLocal);
        if (isLocal) await guiSSH.files.renameLocalPath(oldPath, newPath);
        else await controls.sftpRenamePath(connection.id, oldPath, newPath);
      } else if (dialog.kind === 'delete') {
        for (const entry of dialog.entries) {
          const path = entryPath(dialog.pane, entry);
          if (isLocal) await guiSSH.files.deleteLocalPath(path, entry.type);
          else await controls.sftpDeletePath(connection.id, path, entry.type);
        }
      } else if (dialog.kind === 'properties' && dialog.entries[0] && !isLocal) {
        const parsedMode = Number.parseInt(dialogValue.replace(/^0o?/, ''), 8);
        if (!Number.isFinite(parsedMode)) throw new Error('Invalid permission mode.');
        await controls.sftpSetPathPermissions(connection.id, entryPath('remote', dialog.entries[0]), { mode: parsedMode, recursive: recursivePermissions });
      } else if (dialog.kind === 'sync') {
        const comparison = await compareDirectories();
        if (dialog.pane === 'local') {
          const transferNames = new Set(comparison.localTransferItems.map((item) => item.name));
          enqueueUpload(
            localPane.state.entries.filter((entry) => transferNames.has(entry.name)),
            comparison.localTransferItems,
          );
        } else {
          const transferNames = new Set(comparison.remoteTransferItems.map((item) => item.name));
          enqueueDownload(
            remotePane.state.entries.filter((entry) => transferNames.has(entry.name)),
            comparison.remoteTransferItems,
          );
        }
      }
      setDialog(null);
      await pane.refresh();
    } catch (error) {
      setDialog((current) => current ? { ...current, loading: false, error: getErrorMessage(error) } : current);
    }
  };

  const activeController = paneFor(activePane);
  const activeSelection = activeController.selectedEntries;
  const uploadEntries = localPane.selectedEntries.length ? localPane.selectedEntries : localPane.state.entries;
  const downloadEntries = remotePane.selectedEntries.length ? remotePane.selectedEntries : remotePane.state.entries;
  const toolbarOperation = (kind: FileOperationDialog['kind']) => {
    if ((kind === 'rename' || kind === 'properties') && activeSelection.length !== 1) return;
    if (kind === 'delete' && !activeSelection.length) return;
    void openDialog(kind, activePane, activeSelection);
  };

  return (
    <main className={`sftp-transfer-workspace no-drag${queueVisible ? '' : ' queue-hidden'}`}>
      <section className="sftp-session-strip">
        <div className="session-identity"><span className="connection-dot" /><strong>{t('connected')}</strong><b>SFTP</b><span>{connection.host.username}@{connection.host.address}:{connection.host.port}</span></div>
        <div className="session-security"><LockKeyhole aria-hidden="true" /><span>{t('protected')}</span><ShieldCheck aria-hidden="true" /><span>{t('verified')}</span></div>
      </section>

      <nav className="sftp-command-toolbar" aria-label={t('title')}>
        <button type="button" onClick={refreshBoth}><RefreshCw aria-hidden="true" />{t('refresh')}</button>
        <button type="button" onClick={() => toolbarOperation('rename')} disabled={activeSelection.length !== 1}><Pencil aria-hidden="true" />{t('rename')}</button>
        <button type="button" className="danger-action" onClick={() => toolbarOperation('delete')} disabled={!activeSelection.length}><Trash2 aria-hidden="true" />{t('delete')}</button>
        <span className="toolbar-separator" />
        <button type="button" onClick={() => void openDialog('sync', activePane)} disabled={comparing}><FolderSync aria-hidden="true" />{t('sync')}</button>
        <button type="button" onClick={() => void compareDirectories().catch((error) => setNotice(getErrorMessage(error)))} disabled={comparing}><GitCompareArrows className={comparing ? 'spin' : ''} aria-hidden="true" />{t('compare')}</button>
        <span className="toolbar-spacer" />
        <button type="button" className={showHidden ? 'active' : ''} onClick={() => setShowHidden((value) => !value)}>{showHidden ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}{t('showHidden')}</button>
        <button
          type="button"
          className={queueVisible ? 'active' : ''}
          aria-controls="sftp-transfer-queue"
          aria-expanded={queueVisible}
          aria-pressed={queueVisible}
          onClick={() => setQueueVisible((visible) => !visible)}
        ><Settings2 aria-hidden="true" />{t('transferQueue')}</button>
      </nav>

      {notice ? <div className="sftp-inline-notice"><CheckCircle2 aria-hidden="true" />{notice}<button type="button" onClick={() => setNotice('')}><X aria-hidden="true" /></button></div> : null}

      <section className="sftp-dual-pane">
        <FilePane kind="local" controller={localPane} windowsLocal={windowsLocal} differences={localDifferences} showHidden={showHidden} isActive={activePane === 'local'} t={t} onActivate={() => setActivePane('local')} onNewFolder={() => void openDialog('new-folder', 'local')} onNewFile={() => void openDialog('new-file', 'local')} onRename={(entry) => void openDialog('rename', 'local', [entry])} onDelete={(entries) => void openDialog('delete', 'local', entries)} onProperties={(entry) => void openDialog('properties', 'local', [entry])} onTransfer={enqueueUpload} />
        <aside className="sftp-transfer-rail">
          <button type="button" onClick={() => enqueueUpload(uploadEntries)} disabled={!uploadEntries.length} title={t('uploadArrow')}><ArrowRight aria-hidden="true" /><span>{t('upload')}</span></button>
          <button type="button" onClick={() => enqueueDownload(downloadEntries)} disabled={!downloadEntries.length} title={t('downloadArrow')}><ArrowLeft aria-hidden="true" /><span>{t('download')}</span></button>
          <i />
          <button type="button" onClick={() => void compareDirectories().catch((error) => setNotice(getErrorMessage(error)))} disabled={comparing}><Columns3 className={comparing ? 'spin' : ''} aria-hidden="true" /><span>{t('compare')}</span></button>
        </aside>
        <FilePane kind="remote" controller={remotePane} windowsLocal={windowsLocal} differences={remoteDifferences} showHidden={showHidden} isActive={activePane === 'remote'} t={t} onActivate={() => setActivePane('remote')} onNewFolder={() => void openDialog('new-folder', 'remote')} onNewFile={() => void openDialog('new-file', 'remote')} onRename={(entry) => void openDialog('rename', 'remote', [entry])} onDelete={(entries) => void openDialog('delete', 'remote', entries)} onProperties={(entry) => void openDialog('properties', 'remote', [entry])} onTransfer={enqueueDownload} />
      </section>

      {queueVisible ? <TransferQueue tasks={transferQueue.tasks} filter={queueFilter} onFilterChange={setQueueFilter} concurrency={transferQueue.concurrency} onConcurrencyChange={transferQueue.setConcurrency} onCancel={(id) => void transferQueue.cancel(id)} onPause={(id) => void transferQueue.pause(id)} onResume={transferQueue.resume} onRetry={transferQueue.retry} onRemove={transferQueue.remove} onClearFinished={transferQueue.clearFinished} t={t} /> : null}

      <footer className="sftp-workspace-status">
        <span>{t('localSummary', { count: localPane.state.entries.length })}</span><span>{localPane.selectedEntries.length ? `${t('selected')}: ${formatBytes(localPane.selectedEntries.reduce((sum, entry) => sum + entry.size, 0))}` : '—'}</span>
        <span>{t('remoteSummary', { count: remotePane.state.entries.length })}</span><span>{remotePane.selectedEntries.length ? `${t('selected')}: ${formatBytes(remotePane.selectedEntries.reduce((sum, entry) => sum + entry.size, 0))}` : '—'}</span>
        <span className="sftp-status-protocol"><span className="connection-dot" />russh · SFTP v3</span>
      </footer>

      {dialog ? createPortal(
        <div className="sftp-dialog-overlay" role="presentation">
          <form className="sftp-operation-dialog" onSubmit={(event) => void runDialogOperation(event)} role="dialog" aria-modal="true">
            <header><strong>{t(dialog.kind === 'new-folder' ? 'newFolderTitle' : dialog.kind === 'new-file' ? 'newFileTitle' : dialog.kind === 'rename' ? 'renameTitle' : dialog.kind === 'delete' ? 'deleteTitle' : dialog.kind === 'sync' ? 'syncTitle' : 'propertiesTitle')}</strong><button type="button" onClick={() => setDialog(null)}><X aria-hidden="true" /></button></header>
            <div className="sftp-dialog-body">
              {dialog.kind === 'delete' ? <><p>{t('deleteMessage', { count: dialog.entries.length })}</p>{dialog.loading ? <div className="dialog-loading"><RefreshCw className="spin" aria-hidden="true" /><span>{t('deleting')}</span></div> : null}</> : null}
              {dialog.kind === 'sync' ? <div className="sftp-sync-options"><button type="button" className={dialog.pane === 'local' ? 'selected' : ''} onClick={() => setDialog({ ...dialog, pane: 'local' })}><ArrowRight aria-hidden="true" /><strong>{t('syncLocalRemote')}</strong><span>{localPane.state.path} → {remotePane.state.path}</span></button><button type="button" className={dialog.pane === 'remote' ? 'selected' : ''} onClick={() => setDialog({ ...dialog, pane: 'remote' })}><ArrowLeft aria-hidden="true" /><strong>{t('syncRemoteLocal')}</strong><span>{remotePane.state.path} → {localPane.state.path}</span></button></div> : null}
              {dialog.kind === 'new-folder' || dialog.kind === 'new-file' || dialog.kind === 'rename' ? <label><span>{t('inputName')}</span><input autoFocus value={dialogValue} onChange={(event) => setDialogValue(event.target.value)} required /></label> : null}
              {dialog.kind === 'properties' ? dialog.loading ? <div className="dialog-loading"><RefreshCw className="spin" aria-hidden="true" /></div> : <div className="sftp-properties-grid"><span>{t('name')}</span><b>{dialog.entries[0]?.name}</b><span>{t('type')}</span><b>{dialog.stat?.type ?? '—'}</b><span>{t('size')}</span><b>{dialog.stat ? formatBytes(dialog.stat.size) : '—'}</b><span>{t('modified')}</span><b>{dialog.stat?.modifiedAt ?? '—'}</b>{dialog.pane === 'remote' ? <><label className="permission-field"><span>{t('mode')}</span><input value={dialogValue} onChange={(event) => setDialogValue(event.target.value)} pattern="[0-7]{3,4}" /></label><label className="recursive-field"><input type="checkbox" checked={recursivePermissions} onChange={(event) => setRecursivePermissions(event.target.checked)} />{t('recursive')}</label></> : null}</div> : null}
              {dialog.error ? <div className="sftp-dialog-error" role="alert">{dialog.error}</div> : null}
            </div>
            <footer><button type="button" onClick={() => setDialog(null)} disabled={dialog.loading}>{t('cancel')}</button>{dialog.kind !== 'properties' || dialog.pane === 'remote' ? <button type="submit" className={dialog.kind === 'delete' ? 'danger' : 'primary'} disabled={dialog.loading}>{dialog.loading && dialog.kind === 'delete' ? t('deleting') : dialog.kind === 'properties' ? t('save') : t('confirm')}</button> : null}</footer>
          </form>
        </div>, document.body,
      ) : null}

      {conflictDialog ? createPortal(
        <div className="sftp-dialog-overlay" role="presentation">
          <section className="sftp-operation-dialog sftp-conflict-dialog" role="dialog" aria-modal="true" aria-labelledby="sftp-conflict-title">
            <header><strong id="sftp-conflict-title"><AlertTriangle aria-hidden="true" />{t('conflictTitle')}</strong><button type="button" onClick={() => setConflictDialog(null)} disabled={resolvingConflicts}><X aria-hidden="true" /></button></header>
            <div className="sftp-dialog-body">
              <p>{t('conflictMessage', { count: conflictDialog.conflicts.length })}</p>
              <div className="sftp-conflict-list">
                {conflictDialog.conflicts.slice(0, 6).map(({ source, destination }) => (
                  <div key={source.name} className="sftp-conflict-item">
                    <span className={`conflict-kind ${source.type}`}>{source.type === 'directory' ? t('folderType') : t('fileType')}</span>
                    <strong title={source.name}>{source.name}</strong>
                    {source.type !== destination.type ? <em>{source.type === 'directory' ? t('folderType') : t('fileType')} → {destination.type === 'directory' ? t('folderType') : t('fileType')}</em> : null}
                  </div>
                ))}
                {conflictDialog.conflicts.length > 6 ? <small>{t('conflictMore', { count: conflictDialog.conflicts.length - 6 })}</small> : null}
              </div>
              <div className="sftp-conflict-guidance"><span>{t('conflictMergeHint')}</span><span>{t('conflictSkipHint')}</span>{conflictDialog.conflicts.some(({ source, destination }) => source.type !== destination.type) ? <b>{t('conflictTypeMismatch', { count: conflictDialog.conflicts.filter(({ source, destination }) => source.type !== destination.type).length })}</b> : null}</div>
              {resolvingConflicts ? <div className="dialog-loading compact"><RefreshCw className="spin" aria-hidden="true" /><span>{t('conflictResolving')}</span></div> : null}
              {conflictError ? <div className="sftp-dialog-error" role="alert">{conflictError}</div> : null}
            </div>
            <footer><button type="button" onClick={() => setConflictDialog(null)} disabled={resolvingConflicts}>{t('cancel')}</button><button type="button" onClick={() => void resolveTransferConflicts('skip')} disabled={resolvingConflicts}>{t('conflictSkip')}</button><button type="button" className="primary" onClick={() => void resolveTransferConflicts('overwrite')} disabled={resolvingConflicts}>{t('conflictOverwrite')}</button></footer>
          </section>
        </div>, document.body,
      ) : null}
    </main>
  );
}
