import { useCallback, useEffect, useRef, useState } from 'react';

import { getErrorMessage } from '../remote-desktop/desktopUtils';
import type { SftpTransferTask } from './types';

interface UseTransferQueueOptions {
  connectionId: string;
  onTransferFinished: () => void;
}

export function useTransferQueue({ connectionId, onTransferFinished }: UseTransferQueueOptions) {
  const [tasks, setTasks] = useState<SftpTransferTask[]>([]);
  const [concurrency, setConcurrency] = useState(2);
  const tasksRef = useRef(tasks);
  const activeTaskIdsRef = useRef(new Set<string>());
  const pauseRequestedRef = useRef(new Set<string>());
  const cancelRequestedRef = useRef(new Set<string>());
  const progressSnapshotRef = useRef(new Map<string, { bytes: number; time: number; speed?: number; phase?: ShellDeskTransferProgress['phase'] }>());
  const pendingProgressRef = useRef(new Map<string, ShellDeskTransferProgress>());
  const progressFrameRef = useRef<number | null>(null);

  useEffect(() => { tasksRef.current = tasks; }, [tasks]);

  const patchTask = useCallback((id: string, patch: Partial<SftpTransferTask>) => {
    setTasks((current) => current.map((task) => task.id === id ? { ...task, ...patch } : task));
  }, []);

  useEffect(() => {
    const flushProgress = () => {
      progressFrameRef.current = null;
      const pending = Array.from(pendingProgressRef.current.entries());
      pendingProgressRef.current.clear();
      if (!pending.length) return;
      const patches = new Map<string, Pick<SftpTransferTask, 'progress' | 'speed'>>();
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
        patches.set(taskId, { progress: payload, speed });
      }
      setTasks((current) => current.map((task) => {
        const patch = patches.get(task.id);
        return patch ? { ...task, ...patch } : task;
      }));
    };
    const removeProgress = window.guiSSH?.events.onTransferProgress((payload) => {
      if (payload.connectionId && payload.connectionId !== connectionId) return;
      const taskId = payload.clientId;
      if (!taskId) return;
      pendingProgressRef.current.set(taskId, payload);
      if (progressFrameRef.current === null) {
        progressFrameRef.current = window.requestAnimationFrame(flushProgress);
      }
    });
    return () => {
      removeProgress?.();
      if (progressFrameRef.current !== null) {
        window.cancelAnimationFrame(progressFrameRef.current);
        progressFrameRef.current = null;
      }
      pendingProgressRef.current.clear();
    };
  }, [connectionId]);

  const runTask = useCallback(async (task: SftpTransferTask) => {
    if (!window.guiSSH?.connections) return;
    activeTaskIdsRef.current.add(task.id);
    const plannedProgress = task.plannedSize !== undefined ? {
      connectionId,
      clientId: task.id,
      type: task.direction,
      fileName: task.label,
      transferred: 0,
      total: task.plannedSize,
      completedFiles: 0,
      totalFiles: task.plannedFileCount ?? 0,
      completedItems: 0,
      totalItems: task.plannedFileCount ?? 0,
      phase: 'transferring',
    } satisfies ShellDeskTransferProgress : {
      connectionId,
      clientId: task.id,
      type: task.direction,
      fileName: task.label,
      transferred: 0,
      total: 0,
      completedFiles: 0,
      totalFiles: 0,
      completedItems: 0,
      totalItems: 0,
      phase: 'planning',
      discoveredFiles: 0,
      discoveredDirectories: 0,
    } satisfies ShellDeskTransferProgress;
    patchTask(task.id, { status: 'running', startedAt: Date.now(), error: '', progress: plannedProgress });
    try {
      let result: { size?: number; fileCount?: number };
      if (task.direction === 'upload') {
        result = await window.guiSSH.connections.sftpUploadLocalPaths(
          connectionId,
          task.targetPath,
          task.sourcePaths.map((path) => ({ path })),
          { transferClientId: task.id, expectedTotal: task.plannedSize, expectedFileCount: task.plannedFileCount, conflictPolicy: task.conflictPolicy },
        );
      } else {
        result = await window.guiSSH.connections.sftpDownloadPaths(
          connectionId,
          task.sourcePaths,
          task.targetPath,
          { transferClientId: task.id, expectedTotal: task.plannedSize, expectedFileCount: task.plannedFileCount, conflictPolicy: task.conflictPolicy },
        );
      }
      if (pauseRequestedRef.current.has(task.id)) {
        patchTask(task.id, { status: 'paused' });
      } else {
        const currentProgress = tasksRef.current.find((item) => item.id === task.id)?.progress;
        const actualTotal = Math.max(result.size ?? 0, currentProgress?.total ?? 0, task.plannedSize ?? 0);
        patchTask(task.id, {
          status: 'completed',
          finishedAt: Date.now(),
          progress: {
            connectionId,
            clientId: task.id,
            type: task.direction,
            fileName: currentProgress?.fileName ?? task.label,
            transferred: actualTotal,
            total: actualTotal,
            completedFiles: result.fileCount ?? currentProgress?.totalFiles ?? task.plannedFileCount ?? 0,
            totalFiles: result.fileCount ?? currentProgress?.totalFiles ?? task.plannedFileCount ?? 0,
            completedItems: result.fileCount ?? currentProgress?.totalItems ?? task.plannedFileCount ?? 0,
            totalItems: result.fileCount ?? currentProgress?.totalItems ?? task.plannedFileCount ?? 0,
            phase: 'transferring',
            discoveredFiles: result.fileCount ?? currentProgress?.discoveredFiles ?? task.plannedFileCount ?? 0,
            discoveredDirectories: currentProgress?.discoveredDirectories ?? 0,
            preparedDirectories: currentProgress?.preparedDirectories ?? 0,
            totalDirectories: currentProgress?.totalDirectories ?? 0,
          },
        });
        onTransferFinished();
      }
    } catch (error) {
      if (pauseRequestedRef.current.has(task.id)) {
        patchTask(task.id, { status: 'paused', error: '' });
      } else if (cancelRequestedRef.current.has(task.id)) {
        patchTask(task.id, { status: 'canceled', finishedAt: Date.now() });
      } else {
        patchTask(task.id, { status: 'failed', error: getErrorMessage(error), finishedAt: Date.now() });
      }
    } finally {
      activeTaskIdsRef.current.delete(task.id);
      pauseRequestedRef.current.delete(task.id);
      cancelRequestedRef.current.delete(task.id);
      progressSnapshotRef.current.delete(task.id);
      pendingProgressRef.current.delete(task.id);
      setTasks((current) => [...current]);
    }
  }, [connectionId, onTransferFinished, patchTask]);

  useEffect(() => {
    const available = Math.max(0, concurrency - activeTaskIdsRef.current.size);
    if (!available) return;
    const nextTasks = tasks.filter((task) => task.status === 'queued' && !activeTaskIdsRef.current.has(task.id)).slice(0, available);
    nextTasks.forEach((task) => { void runTask(task); });
  }, [concurrency, runTask, tasks]);

  const enqueue = useCallback((tasksToAdd: Omit<SftpTransferTask, 'id' | 'createdAt' | 'status'>[]) => {
    const now = Date.now();
    setTasks((current) => [...current, ...tasksToAdd.map((task, index) => ({
      ...task,
      id: `sftp-${now}-${index}-${Math.random().toString(36).slice(2, 7)}`,
      createdAt: now + index,
      status: 'queued' as const,
    }))]);
  }, []);

  const cancel = useCallback(async (id: string) => {
    const task = tasksRef.current.find((item) => item.id === id);
    if (!task) return;
    if (task.status === 'running') {
      cancelRequestedRef.current.add(id);
      patchTask(id, { status: 'canceled' });
      await window.guiSSH?.connections.cancelTransfer(connectionId, id).catch(() => undefined);
    } else {
      patchTask(id, { status: 'canceled', finishedAt: Date.now() });
    }
  }, [connectionId, patchTask]);

  const pause = useCallback(async (id: string) => {
    const task = tasksRef.current.find((item) => item.id === id);
    if (!task) return;
    if (task.status === 'running') {
      pauseRequestedRef.current.add(id);
      patchTask(id, { status: 'paused' });
      await window.guiSSH?.connections.cancelTransfer(connectionId, id).catch(() => undefined);
    } else if (task.status === 'queued') {
      patchTask(id, { status: 'paused' });
    }
  }, [connectionId, patchTask]);

  const resume = useCallback((id: string) => {
    patchTask(id, { status: 'queued', progress: undefined, speed: undefined, error: '' });
  }, [patchTask]);
  const retry = useCallback((id: string) => {
    patchTask(id, { status: 'queued', progress: undefined, speed: undefined, error: '', finishedAt: undefined });
  }, [patchTask]);
  const remove = useCallback((id: string) => setTasks((current) => current.filter((task) => task.id !== id)), []);
  const clearFinished = useCallback(() => setTasks((current) => current.filter((task) => ['queued', 'running', 'paused'].includes(task.status))), []);

  return { tasks, concurrency, setConcurrency, enqueue, cancel, pause, resume, retry, remove, clearFinished };
}
