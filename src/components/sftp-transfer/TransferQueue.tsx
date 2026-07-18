import { Ban, CheckCircle2, CirclePause, CirclePlay, Clock3, RotateCcw, Trash2, X } from 'lucide-react';

import { formatBytes } from '../remote-desktop/fileExplorerUtils';
import type { SftpMessageKey } from './messages';
import { getPathName } from './pathUtils';
import type { SftpTransferTask, TransferTaskStatus } from './types';

interface TransferQueueProps {
  tasks: SftpTransferTask[];
  filter: 'all' | 'queued' | 'running' | 'completed' | 'failed';
  onFilterChange: (filter: TransferQueueProps['filter']) => void;
  concurrency: number;
  onConcurrencyChange: (value: number) => void;
  onCancel: (id: string) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
  onClearFinished: () => void;
  t: (key: SftpMessageKey, params?: Record<string, string | number>) => string;
}

// SFTP file open/close requests have a visible fixed cost, especially for
// directory transfers containing many small files. Count each completed file
// as 64 KiB of progress so a large file followed by small files cannot sit at
// 99% for minutes.
const FILE_PROGRESS_WEIGHT_BYTES = 64 * 1024;

function progressRatio(task: SftpTransferTask) {
  if (task.status === 'completed') return 1;
  const progress = task.progress;
  if (!progress) return 0;
  const totalFiles = progress.totalFiles ?? task.plannedFileCount ?? 0;
  const completedFiles = progress.completedFiles ?? 0;
  const weightedTotal = progress.total + totalFiles * FILE_PROGRESS_WEIGHT_BYTES;
  if (weightedTotal <= 0) return 0;
  const weightedTransferred = progress.transferred + completedFiles * FILE_PROGRESS_WEIGHT_BYTES;
  return Math.min(1, weightedTransferred / weightedTotal);
}

function percent(task: SftpTransferTask) {
  return Math.round(progressRatio(task) * 100);
}

function statusKey(status: TransferTaskStatus): SftpMessageKey {
  return {
    queued: 'statusQueued', running: 'statusRunning', paused: 'statusPaused', completed: 'statusCompleted', failed: 'statusFailed', canceled: 'statusCanceled',
  }[status] as SftpMessageKey;
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.ceil(seconds % 60)}s`;
}

export default function TransferQueue(props: TransferQueueProps) {
  const { tasks, filter, t } = props;
  const visibleTasks = tasks.filter((task) => {
    if (filter === 'all') return true;
    if (filter === 'queued') return task.status === 'queued' || task.status === 'paused';
    if (filter === 'running') return task.status === 'running';
    if (filter === 'completed') return task.status === 'completed';
    return task.status === 'failed' || task.status === 'canceled';
  });
  const counts = {
    queued: tasks.filter((task) => task.status === 'queued' || task.status === 'paused').length,
    running: tasks.filter((task) => task.status === 'running').length,
    completed: tasks.filter((task) => task.status === 'completed').length,
    failed: tasks.filter((task) => task.status === 'failed' || task.status === 'canceled').length,
  };

  return (
    <section id="sftp-transfer-queue" className="sftp-transfer-queue">
      <header className="sftp-queue-header">
        <strong>{t('transferQueue')}</strong>
        <nav>
          {(['all', 'queued', 'running', 'completed', 'failed'] as const).map((key) => (
            <button type="button" key={key} className={filter === key ? 'active' : ''} onClick={() => props.onFilterChange(key)}>
              {t(key === 'all' ? 'all' : key === 'queued' ? 'queue' : key === 'running' ? 'transferring' : key)}
              {key !== 'all' ? <span>{counts[key]}</span> : null}
            </button>
          ))}
        </nav>
      </header>
      <div className="sftp-queue-table-frame">
        <table className="sftp-queue-table">
          <thead><tr><th>{t('name')}</th><th>{t('direction')}</th><th>{t('target')}</th><th>{t('size')}</th><th>{t('progress')}</th><th>{t('speed')}</th><th>{t('remaining')}</th><th>{t('status')}</th><th>{t('action')}</th></tr></thead>
          <tbody>
            {visibleTasks.map((task) => {
              const planning = task.status === 'running' && task.progress?.phase === 'planning';
              const preparing = task.status === 'running' && task.progress?.phase === 'preparing';
              const taskPercent = percent(task);
              const total = task.progress?.total ?? task.plannedSize ?? 0;
              const completedFiles = task.progress?.completedFiles ?? 0;
              const totalFiles = task.progress?.totalFiles ?? task.plannedFileCount ?? 0;
              const discoveredFiles = task.progress?.discoveredFiles ?? 0;
              const discoveredDirectories = task.progress?.discoveredDirectories ?? 0;
              const preparedDirectories = task.progress?.preparedDirectories ?? 0;
              const totalDirectories = task.progress?.totalDirectories ?? 0;
              const preparationPercent = totalDirectories > 0 ? Math.min(100, Math.round((preparedDirectories / totalDirectories) * 100)) : 0;
              const indeterminate = planning || (preparing && totalDirectories === 0);
              const ratio = progressRatio(task);
              const elapsedSeconds = task.startedAt ? Math.max(0, (Date.now() - task.startedAt) / 1000) : 0;
              const remaining = ratio > 0 && ratio < 1 ? elapsedSeconds * ((1 - ratio) / ratio) : Number.NaN;
              return (
                <tr key={task.id} className={task.status}>
                  <td><span className="queue-file-name">{task.status === 'completed' ? <CheckCircle2 aria-hidden="true" /> : task.status === 'failed' ? <Ban aria-hidden="true" /> : <Clock3 aria-hidden="true" />}<span>{task.label}</span></span></td>
                  <td className={`direction ${task.direction}`}>{task.direction === 'upload' ? '→' : '←'}</td>
                  <td title={task.targetPath}>{task.targetPath}</td>
                  <td>{total ? formatBytes(total) : '—'}</td>
                  <td>
                    <div className={`queue-progress ${indeterminate ? 'planning' : ''}`}><span style={{ width: indeterminate ? undefined : `${preparing ? preparationPercent : taskPercent}%` }} /><b>{planning ? t('scanning') : preparing ? t('preparing') : `${taskPercent}%`}</b></div>
                    {planning ? <small className="queue-progress-detail" title={task.progress?.fileName}><span>{t('scanningPath', { path: getPathName(task.progress?.fileName ?? task.label) })}</span><span>{t('discoveredEntries', { files: discoveredFiles, directories: discoveredDirectories })}</span></small> : preparing ? <small className="queue-progress-detail">{totalDirectories > 0 ? t('preparedDirectories', { completed: preparedDirectories, total: totalDirectories }) : t('establishingSession')}</small> : totalFiles > 1 ? <small className="queue-progress-detail">{completedFiles}/{totalFiles} {t('files')}</small> : null}
                  </td>
                  <td>{task.speed ? `${formatBytes(task.speed)}/s` : '—'}</td>
                  <td>{formatDuration(remaining)}</td>
                  <td><span className={`queue-status ${task.status}`}>{planning ? t('scanning') : preparing ? t('preparing') : t(statusKey(task.status))}</span>{task.error ? <small title={task.error}>{task.error}</small> : null}</td>
                  <td><div className="queue-actions">
                    {task.status === 'running' || task.status === 'queued' ? <button type="button" onClick={() => props.onPause(task.id)} title={t('pause')}><CirclePause aria-hidden="true" /></button> : null}
                    {task.status === 'paused' ? <button type="button" onClick={() => props.onResume(task.id)} title={t('resume')}><CirclePlay aria-hidden="true" /></button> : null}
                    {task.status === 'failed' || task.status === 'canceled' ? <button type="button" onClick={() => props.onRetry(task.id)} title={t('retry')}><RotateCcw aria-hidden="true" /></button> : null}
                    {task.status === 'running' || task.status === 'queued' || task.status === 'paused' ? <button type="button" onClick={() => props.onCancel(task.id)} title={t('cancel')}><X aria-hidden="true" /></button> : <button type="button" onClick={() => props.onRemove(task.id)} title={t('remove')}><Trash2 aria-hidden="true" /></button>}
                  </div></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!visibleTasks.length ? <div className="sftp-queue-empty">{t('transferQueue')} · 0</div> : null}
      </div>
      <footer className="sftp-queue-footer">
        <button type="button" onClick={props.onClearFinished}><Trash2 aria-hidden="true" />{t('clearFinished')}</button>
        <label><span>{t('concurrency')}</span><select value={props.concurrency} onChange={(event) => props.onConcurrencyChange(Number(event.target.value))}><option value={1}>1</option><option value={2}>2</option><option value={3}>3</option><option value={4}>4</option></select></label>
        <label><span>{t('afterComplete')}</span><select><option>{t('doNothing')}</option></select></label>
      </footer>
    </section>
  );
}
