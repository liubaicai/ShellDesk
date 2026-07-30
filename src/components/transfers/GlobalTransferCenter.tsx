import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CheckCircle2,
  CircleX,
  LoaderCircle,
  Trash2,
  X,
} from 'lucide-react';

import type { AppLanguage } from '../../i18n';
import { formatBytes } from '../remote-desktop/fileExplorerUtils';

interface GlobalTransferCenterProps {
  language: AppLanguage;
}

const messages = {
  'zh-CN': {
    title: '全局传输中心',
    empty: '还没有文件传输记录',
    queued: '排队中',
    active: '进行中',
    completed: '已完成',
    failed: '失败',
    canceled: '已取消',
    paused: '已暂停',
    cancel: '取消传输',
    remove: '移除记录',
    clear: '清除已结束',
    close: '关闭传输中心',
    source: '来源',
    target: '目标',
    interrupted: 'ShellDesk 上次退出时传输中断。',
  },
  'en-US': {
    title: 'Global transfer center',
    empty: 'No file transfer history yet',
    queued: 'Queued',
    active: 'Active',
    completed: 'Completed',
    failed: 'Failed',
    canceled: 'Canceled',
    paused: 'Paused',
    cancel: 'Cancel transfer',
    remove: 'Remove record',
    clear: 'Clear finished',
    close: 'Close transfer center',
    source: 'Source',
    target: 'Target',
    interrupted: 'Transfer interrupted when ShellDesk last exited.',
  },
} as const;

function transferRatio(task: ShellDeskTransferTask) {
  if (task.total <= 0) return 0;
  return Math.max(0, Math.min(1, task.transferred / task.total));
}

function taskStatusLabel(task: ShellDeskTransferTask, language: AppLanguage) {
  const text = messages[language];
  if (task.status === 'queued') return text.queued;
  if (task.status === 'running') return text.active;
  if (task.status === 'completed') return text.completed;
  if (task.status === 'canceled') return text.canceled;
  if (task.status === 'paused') return text.paused;
  return text.failed;
}

function taskIsActive(task: ShellDeskTransferTask) {
  return task.status === 'queued' || task.status === 'running' || task.status === 'paused';
}

function taskTimestamp(task: ShellDeskTransferTask, language: AppLanguage) {
  const date = new Date(task.updatedAt || task.createdAt);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(language === 'zh-CN' ? 'zh-CN' : 'en-US', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function upsertTask(tasks: ShellDeskTransferTask[], task: ShellDeskTransferTask) {
  const index = tasks.findIndex((item) => item.id === task.id);
  const next = index < 0
    ? [task, ...tasks]
    : tasks.map((item, itemIndex) => itemIndex === index ? task : item);
  return [...next].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export default function GlobalTransferCenter({ language }: GlobalTransferCenterProps) {
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState<ShellDeskTransferTask[]>([]);
  const [error, setError] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const text = messages[language];

  const loadTasks = useCallback(async () => {
    const listTransfers = window.guiSSH?.connections?.listTransfers;
    if (!listTransfers) return;
    try {
      const nextTasks = await listTransfers();
      setTasks([...nextTasks].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
      setError('');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, []);

  useEffect(() => {
    void loadTasks();
    const removeTaskChanged = window.guiSSH?.events.onTransferTaskChanged((task) => {
      setTasks((current) => upsertTask(current, task));
    });
    return () => removeTaskChanged?.();
  }, [loadTasks]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    window.addEventListener('pointerdown', closeOnPointerDown);
    return () => {
      window.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('pointerdown', closeOnPointerDown);
    };
  }, [open]);

  const activeCount = useMemo(
    () => tasks.filter(taskIsActive).length,
    [tasks],
  );
  const failedCount = useMemo(
    () => tasks.filter((task) => task.status === 'failed').length,
    [tasks],
  );
  const visibleTasks = tasks.slice(0, 50);

  const cancelTask = useCallback(async (task: ShellDeskTransferTask) => {
    if (!task.connectionId) return;
    try {
      await window.guiSSH?.connections.cancelTransfer(task.connectionId, task.queueId || task.id);
      setError('');
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : String(cancelError));
    }
  }, []);

  const removeTask = useCallback(async (task: ShellDeskTransferTask) => {
    try {
      const removed = await window.guiSSH?.connections.removeTransfer(task.id);
      if (removed) {
        setTasks((current) => current.filter((item) => item.id !== task.id));
      }
      setError('');
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : String(removeError));
    }
  }, []);

  const clearFinished = useCallback(async () => {
    try {
      await window.guiSSH?.connections.clearFinishedTransfers();
      setTasks((current) => current.filter(taskIsActive));
      setError('');
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : String(clearError));
    }
  }, []);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`global-transfer-trigger${open ? ' active' : ''}${failedCount ? ' attention' : ''}`}
        aria-label={text.title}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={text.title}
        onClick={() => {
          setOpen((current) => !current);
          if (!open) void loadTasks();
        }}
      >
        <ArrowDownToLine aria-hidden="true" />
        {activeCount ? <span className="global-transfer-badge">{activeCount}</span> : null}
      </button>
      {open ? createPortal(
        <div
          ref={panelRef}
          className="global-transfer-panel no-drag"
          role="dialog"
          aria-modal="false"
          aria-label={text.title}
        >
          <header>
            <div>
              <strong>{text.title}</strong>
              <small>{activeCount ? `${text.active} ${activeCount}` : `${tasks.length}`}</small>
            </div>
            <div className="global-transfer-header-actions">
              <button type="button" onClick={() => void clearFinished()} disabled={tasks.every(taskIsActive)}>
                <Trash2 aria-hidden="true" />
                {text.clear}
              </button>
              <button type="button" className="icon-only" aria-label={text.close} title={text.close} onClick={() => {
                setOpen(false);
                triggerRef.current?.focus();
              }}>
                <X aria-hidden="true" />
              </button>
            </div>
          </header>
          {error ? <p className="global-transfer-error" role="alert">{error}</p> : null}
          <div className="global-transfer-list" aria-live="polite">
            {!visibleTasks.length ? <p className="global-transfer-empty">{text.empty}</p> : visibleTasks.map((task) => {
              const ratio = transferRatio(task);
              const running = task.status === 'running';
              const cancelable = task.status === 'running' || task.status === 'queued';
              const Icon = task.type === 'upload' ? ArrowUpFromLine : ArrowDownToLine;
              const StatusIcon = running ? LoaderCircle : task.status === 'completed' ? CheckCircle2 : CircleX;
              return (
                <article key={task.id} className={`global-transfer-task status-${task.status}`}>
                  <span className="global-transfer-direction" aria-hidden="true"><Icon /></span>
                  <div className="global-transfer-task-body">
                    <div className="global-transfer-task-title">
                      <strong>{task.label || task.fileName}</strong>
                      <span><StatusIcon className={running ? 'spin' : ''} aria-hidden="true" />{taskStatusLabel(task, language)}</span>
                    </div>
                    <div className="global-transfer-progress" aria-label={`${Math.round(ratio * 100)}%`}>
                      <span style={{ width: `${ratio * 100}%` }} />
                    </div>
                    <div className="global-transfer-task-meta">
                      <span>{task.hostName || task.connectionId || 'SSH'}</span>
                      <span>{formatBytes(task.transferred)} / {task.total > 0 ? formatBytes(task.total) : '—'}</span>
                      <time>{taskTimestamp(task, language)}</time>
                    </div>
                    {(task.sourcePaths?.length || task.targetPath) ? (
                      <details>
                        <summary>{text.source} / {text.target}</summary>
                        {task.sourcePaths?.length ? <code>{task.sourcePaths.join('\n')}</code> : null}
                        {task.targetPath ? <code>{task.targetPath}</code> : null}
                      </details>
                    ) : null}
                    {task.errorCode === 'interrupted-on-exit' || task.error ? (
                      <p className="global-transfer-task-error">
                        {task.errorCode === 'interrupted-on-exit' ? text.interrupted : task.error}
                      </p>
                    ) : null}
                  </div>
                  <div className="global-transfer-task-actions">
                    {cancelable ? (
                      <button type="button" aria-label={text.cancel} title={text.cancel} onClick={() => void cancelTask(task)}>
                        <CircleX aria-hidden="true" />
                      </button>
                    ) : task.status !== 'paused' ? (
                      <button type="button" aria-label={text.remove} title={text.remove} onClick={() => void removeTask(task)}>
                        <Trash2 aria-hidden="true" />
                      </button>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
