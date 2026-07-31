import { useCallback, useEffect, useRef, useState } from 'react';

import { getErrorMessage } from '../remote-desktop/desktopUtils';
import type { SftpTransferProfile, SftpTransferTask, TransferTaskStatus } from './types';

const TRANSFER_PROFILE_STORAGE_KEY = 'shelldesk.sftp-transfer-profile';

function readTransferProfile(): SftpTransferProfile {
  try {
    return window.localStorage.getItem(TRANSFER_PROFILE_STORAGE_KEY) === 'compatibility'
      ? 'compatibility'
      : 'balanced';
  } catch {
    return 'balanced';
  }
}

interface UseTransferQueueOptions {
  connectionId: string;
  hostId: string;
  hostName: string;
  onTransferFinished: () => void;
}

function historyStatus(status: ShellDeskTransferTask['status']): TransferTaskStatus {
  return status;
}

function historyTaskToQueueTask(task: ShellDeskTransferTask): SftpTransferTask | null {
  if (!task.sourcePaths?.length || !task.targetPath) return null;
  return {
    id: task.queueId || task.id,
    direction: task.type,
    label: task.label || task.fileName,
    sourcePaths: task.sourcePaths,
    targetPath: task.targetPath,
    plannedSize: task.total,
    plannedFileCount: task.totalFiles,
    transferProfile: task.transferProfile,
    status: historyStatus(task.status),
    createdAt: Date.parse(task.createdAt) || Date.now(),
    startedAt: task.status === 'running' ? Date.parse(task.updatedAt) || Date.now() : undefined,
    finishedAt: task.finishedAt ? Date.parse(task.finishedAt) || Date.now() : undefined,
    progress: task,
    error: task.error,
  };
}

export function useTransferQueue({ connectionId, hostId, hostName, onTransferFinished }: UseTransferQueueOptions) {
  const [tasks, setTasks] = useState<SftpTransferTask[]>([]);
  const [concurrency, setConcurrency] = useState(2);
  const [transferProfile, setTransferProfile] = useState<SftpTransferProfile>(readTransferProfile);
  const tasksRef = useRef(tasks);
  const pauseRequestedRef = useRef(new Set<string>());
  const completedTaskIdsRef = useRef(new Set<string>());
  const progressSnapshotRef = useRef(new Map<string, { bytes: number; time: number; speed?: number; phase?: ShellDeskTransferProgress['phase'] }>());
  const pendingProgressRef = useRef(new Map<string, ShellDeskTransferProgress>());
  const progressFrameRef = useRef<number | null>(null);

  useEffect(() => { tasksRef.current = tasks; }, [tasks]);
  useEffect(() => {
    try {
      window.localStorage.setItem(TRANSFER_PROFILE_STORAGE_KEY, transferProfile);
    } catch {
      // A locked-down WebView can disable local storage; the in-memory choice still applies.
    }
  }, [transferProfile]);

  const patchTask = useCallback((id: string, patch: Partial<SftpTransferTask>) => {
    setTasks((current) => current.map((task) => task.id === id ? { ...task, ...patch } : task));
  }, []);

  useEffect(() => {
    let active = true;
    void window.guiSSH?.connections.listTransfers().then((history) => {
      if (!active) return;
      const restored = history
        .filter((task) => task.connectionId === connectionId)
        .map(historyTaskToQueueTask)
        .filter((task): task is SftpTransferTask => Boolean(task));
      setTasks((current) => {
        const currentIds = new Set(current.map((task) => task.id));
        return [...current, ...restored.filter((task) => !currentIds.has(task.id))]
          .sort((left, right) => left.createdAt - right.createdAt);
      });
    }).catch(() => undefined);
    return () => { active = false; };
  }, [connectionId]);

  useEffect(() => {
    const flushProgress = () => {
      progressFrameRef.current = null;
      const pending = Array.from(pendingProgressRef.current.entries());
      pendingProgressRef.current.clear();
      if (!pending.length) return;
      const patches = new Map<string, Pick<SftpTransferTask, 'progress' | 'speed' | 'status'>>();
      for (const [taskId, payload] of pending) {
        const now = Date.now();
        const previous = progressSnapshotRef.current.get(taskId);
        const isTransferring = payload.phase === undefined || payload.phase === 'transferring';
        const instantSpeed = isTransferring && previous && (previous.phase === undefined || previous.phase === 'transferring') && now > previous.time
          ? Math.max(0, ((payload.transferred - previous.bytes) * 1000) / (now - previous.time))
          : undefined;
        const speed = !isTransferring || (previous?.phase !== undefined && previous.phase !== 'transferring') ? undefined : instantSpeed === undefined
          ? previous?.speed
          : previous?.speed === undefined ? instantSpeed : previous.speed * 0.65 + instantSpeed * 0.35;
        progressSnapshotRef.current.set(taskId, { bytes: payload.transferred, time: now, speed, phase: payload.phase });
        patches.set(taskId, {
          progress: payload,
          speed,
          status: pauseRequestedRef.current.has(taskId) ? 'paused' : 'running',
        });
      }
      setTasks((current) => current.map((task) => {
        const patch = patches.get(task.id);
        return patch ? { ...task, ...patch } : task;
      }));
    };
    const removeProgress = window.guiSSH?.events.onTransferProgress((payload) => {
      if (payload.connectionId && payload.connectionId !== connectionId) return;
      const taskId = payload.clientId || payload.queueId;
      if (!taskId) return;
      pendingProgressRef.current.set(taskId, payload);
      if (progressFrameRef.current === null) {
        progressFrameRef.current = window.requestAnimationFrame(flushProgress);
      }
    });
    const removeTaskChanged = window.guiSSH?.events.onTransferTaskChanged((historyTask) => {
      if (historyTask.connectionId !== connectionId) return;
      const taskId = historyTask.queueId || historyTask.id;
      const requestedPause = pauseRequestedRef.current.has(taskId);
      const nextStatus = requestedPause && historyTask.status === 'canceled'
        ? 'paused'
        : historyStatus(historyTask.status);
      patchTask(taskId, {
        status: nextStatus,
        finishedAt: historyTask.finishedAt ? Date.parse(historyTask.finishedAt) || Date.now() : undefined,
        error: requestedPause ? '' : historyTask.error || '',
        progress: historyTask,
      });
      if (historyTask.status === 'completed' && !completedTaskIdsRef.current.has(taskId)) {
        completedTaskIdsRef.current.add(taskId);
        onTransferFinished();
      }
    });
    return () => {
      removeProgress?.();
      removeTaskChanged?.();
      if (progressFrameRef.current !== null) {
        window.cancelAnimationFrame(progressFrameRef.current);
        progressFrameRef.current = null;
      }
      pendingProgressRef.current.clear();
    };
  }, [connectionId, onTransferFinished, patchTask]);

  const submitTasks = useCallback(async (tasksToSubmit: SftpTransferTask[]) => {
    if (!tasksToSubmit.length) return;
    const connections = window.guiSSH?.connections;
    if (!connections) return;
    try {
      await connections.sftpEnqueueTransfers(
        connectionId,
        tasksToSubmit.map((task) => ({
          id: task.id,
          direction: task.direction,
          label: task.label,
          sourcePaths: task.sourcePaths,
          targetPath: task.targetPath,
          plannedSize: task.plannedSize,
          plannedFileCount: task.plannedFileCount,
          conflictPolicy: task.conflictPolicy,
          transferProfile: task.transferProfile,
          hostId,
          hostName,
        })),
        concurrency,
      );
    } catch (error) {
      const message = getErrorMessage(error);
      const failedIds = new Set(tasksToSubmit.map((task) => task.id));
      setTasks((current) => current.map((task) => failedIds.has(task.id)
        ? { ...task, status: 'failed', error: message, finishedAt: Date.now() }
        : task));
    }
  }, [concurrency, connectionId, hostId, hostName]);

  const enqueue = useCallback((tasksToAdd: Omit<SftpTransferTask, 'id' | 'createdAt' | 'status'>[]) => {
    const now = Date.now();
    const createdTasks = tasksToAdd.map((task, index) => ({
      ...task,
      transferProfile: task.transferProfile ?? transferProfile,
      id: `sftp-${now}-${index}-${Math.random().toString(36).slice(2, 7)}`,
      createdAt: now + index,
      status: 'queued' as const,
    }));
    setTasks((current) => [...current, ...createdTasks]);
    void submitTasks(createdTasks);
  }, [submitTasks, transferProfile]);

  const cancel = useCallback(async (id: string) => {
    const task = tasksRef.current.find((item) => item.id === id);
    if (!task) return;
    pauseRequestedRef.current.delete(id);
    if (task.status === 'queued' || task.status === 'running') {
      const canceled = await window.guiSSH?.connections.cancelTransfer(connectionId, id).catch(() => false);
      if (!canceled) return;
    }
    patchTask(id, { status: 'canceled', finishedAt: Date.now() });
  }, [connectionId, patchTask]);

  const pause = useCallback(async (id: string) => {
    const task = tasksRef.current.find((item) => item.id === id);
    if (!task) return;
    pauseRequestedRef.current.add(id);
    if (task.status === 'queued' || task.status === 'running') {
      await window.guiSSH?.connections.cancelTransfer(connectionId, id).catch(() => undefined);
    }
    patchTask(id, { status: 'paused', error: '' });
  }, [connectionId, patchTask]);

  const restartTask = useCallback((id: string) => {
    const task = tasksRef.current.find((item) => item.id === id);
    if (!task) return;
    pauseRequestedRef.current.delete(id);
    completedTaskIdsRef.current.delete(id);
    const restarted = {
      ...task,
      status: 'queued' as const,
      progress: undefined,
      speed: undefined,
      error: '',
      finishedAt: undefined,
    };
    patchTask(id, restarted);
    void submitTasks([restarted]);
  }, [patchTask, submitTasks]);

  const remove = useCallback(async (id: string) => {
    const removed = await window.guiSSH?.connections.removeTransfer(id).catch(() => false);
    if (removed) {
      setTasks((current) => current.filter((task) => task.id !== id));
    }
  }, []);
  const clearFinished = useCallback(async () => {
    const finishedIds = tasksRef.current
      .filter((task) => !['queued', 'running', 'paused'].includes(task.status))
      .map((task) => task.id);
    const removedIds = new Set(
      (await Promise.all(finishedIds.map(async (id) => (
        await window.guiSSH?.connections.removeTransfer(id).catch(() => false) ? id : ''
      )))).filter(Boolean),
    );
    if (removedIds.size) {
      setTasks((current) => current.filter((task) => !removedIds.has(task.id)));
    }
  }, []);

  return {
    tasks,
    concurrency,
    setConcurrency,
    transferProfile,
    setTransferProfile,
    enqueue,
    cancel,
    pause,
    resume: restartTask,
    retry: restartTask,
    remove,
    clearFinished,
  };
}
