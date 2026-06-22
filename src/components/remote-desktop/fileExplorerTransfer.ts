import { useCallback, useEffect, useRef, useState } from 'react';

import { t, type AppLanguage } from '../../i18n';
import { getErrorMessage } from './desktopUtils';
import { joinRemotePath } from './fileExplorerPaths';
import {
  getUploadTaskLabel,
  isRemotePathMissingError,
  splitFileNameForDuplicate,
} from './fileExplorerUtils';
import type { ExplorerTransferTask, ExplorerUploadConflictDialog } from './fileExplorerTypes';

type RunWithSudoRetry = <T>(
  operation: string,
  target: string,
  run: (options?: ShellDeskSudoPasswordOptions) => Promise<T>,
) => Promise<T>;

interface UseFileExplorerTransfersOptions {
  connectionId: string;
  remotePath: string;
  isWindowsHost: boolean;
  language: AppLanguage;
  runWithSudoRetry: RunWithSudoRetry;
  refreshFiles: () => void;
  setFilesError: (message: string) => void;
}

export function getTransferProgressPercent(transferProgress: ShellDeskTransferProgress | null) {
  if (!transferProgress) {
    return 0;
  }

  if (transferProgress.total > 0) {
    return Math.max(1, Math.min(100, Math.round((transferProgress.transferred / transferProgress.total) * 100)));
  }

  if ((transferProgress.totalItems ?? 0) > 0) {
    return Math.max(1, Math.min(100, Math.round(((transferProgress.completedItems ?? 0) / (transferProgress.totalItems ?? 1)) * 100)));
  }

  return 10;
}

export function getTransferItemLabel(transferProgress: ShellDeskTransferProgress | null, language: AppLanguage) {
  return transferProgress
    ? t('fileExplorer.transfer.items', language, {
        completed: transferProgress.completedItems ?? 0,
        total: transferProgress.totalItems ? t('fileExplorer.transfer.totalSuffix', language, { total: transferProgress.totalItems }) : '',
      })
    : '';
}

export function useFileExplorerTransfers({
  connectionId,
  remotePath,
  isWindowsHost,
  language,
  runWithSudoRetry,
  refreshFiles,
  setFilesError,
}: UseFileExplorerTransfersOptions) {
  const [transferProgress, setTransferProgress] = useState<ShellDeskTransferProgress | null>(null);
  const [transferQueue, setTransferQueue] = useState<ExplorerTransferTask[]>([]);
  const [uploadConflictDialog, setUploadConflictDialog] = useState<ExplorerUploadConflictDialog | null>(null);

  const transferQueueRef = useRef<ExplorerTransferTask[]>([]);
  const transferProcessingRef = useRef(false);
  const activeTransferTaskIdRef = useRef<string | null>(null);

  useEffect(() => {
    transferQueueRef.current = transferQueue;
  }, [transferQueue]);

  useEffect(() => {
    const unsubscribe = window.guiSSH?.events.onTransferProgress((payload) => {
      if (payload.connectionId && payload.connectionId !== connectionId) {
        return;
      }

      const activeTaskId = activeTransferTaskIdRef.current;

      if (!payload.clientId) {
        setTransferProgress((currentProgress) => {
          if (currentProgress?.queueId && payload.queueId && currentProgress.queueId === payload.queueId) {
            return payload;
          }

          return currentProgress;
        });
        return;
      }

      if (payload.clientId && activeTaskId && payload.clientId !== activeTaskId) {
        return;
      }

      if (!activeTaskId) {
        setTransferProgress((currentProgress) => currentProgress?.clientId === payload.clientId ? payload : currentProgress);
        return;
      }

      setTransferProgress((currentProgress) => {
        if (currentProgress?.queueId && payload.queueId && currentProgress.queueId !== payload.queueId) {
          return currentProgress;
        }

        return payload;
      });

      setTransferQueue((tasks) => tasks.map((task) => task.id === payload.clientId
        ? { ...task, progress: payload }
        : task));
    });
    const unsubEnd = window.guiSSH?.events.onTransferEnd((payload) => {
      if (payload.connectionId && payload.connectionId !== connectionId) {
        return;
      }

      const activeTaskId = activeTransferTaskIdRef.current;

      if (!payload.clientId) {
        setTransferProgress((currentProgress) => {
          if (currentProgress?.queueId && payload.queueId && currentProgress.queueId === payload.queueId) {
            return null;
          }

          return currentProgress;
        });
        return;
      }

      if (payload.clientId && activeTaskId && payload.clientId !== activeTaskId) {
        return;
      }

      setTransferProgress((currentProgress) => {
        if (payload.clientId && currentProgress?.clientId && currentProgress.clientId !== payload.clientId) {
          return currentProgress;
        }

        if (currentProgress?.queueId && payload.queueId && currentProgress.queueId !== payload.queueId) {
          return currentProgress;
        }

        return null;
      });
    });
    return () => { unsubscribe?.(); unsubEnd?.(); };
  }, [connectionId]);

  const updateTransferTask = useCallback((
    taskId: string,
    update: (task: ExplorerTransferTask) => ExplorerTransferTask,
  ) => {
    setTransferQueue((tasks) => {
      const nextTasks = tasks.map((task) => task.id === taskId ? update(task) : task);
      transferQueueRef.current = nextTasks;
      return nextTasks;
    });
  }, []);

  const processTransferQueue = useCallback(async () => {
    if (transferProcessingRef.current) {
      return;
    }

    transferProcessingRef.current = true;

    try {
      for (;;) {
        const task = transferQueueRef.current.find((candidate) => candidate.status === 'queued');

        if (!task) {
          break;
        }

        activeTransferTaskIdRef.current = task.id;
        updateTransferTask(task.id, (currentTask) => ({
          ...currentTask,
          status: 'running',
          error: '',
        }));

        try {
          const withTransferClientId = (options?: ShellDeskSudoPasswordOptions): ShellDeskSudoPasswordOptions => ({
            ...(options ?? {}),
            transferClientId: task.id,
          });

          if (task.type === 'upload') {
            const uploadItems = task.uploadItems ?? [];

            if (!uploadItems.length || !task.uploadTarget) {
              throw new Error(language === 'zh-CN' ? '上传任务缺少本地项目。' : 'Upload task has no local items.');
            }

            const result = await runWithSudoRetry(
              t('fileExplorer.sudo.operation.upload', language),
              task.uploadTarget,
              (options) => window.guiSSH!.connections.uploadLocalPaths(connectionId, task.uploadTarget!, uploadItems, withTransferClientId(options)),
            );

            updateTransferTask(task.id, (currentTask) => ({
              ...currentTask,
              status: result?.canceled ? 'canceled' : 'success',
              progress: currentTask.progress,
            }));

            if (!result?.canceled) {
              refreshFiles();
            }
          } else {
            const remotePaths = task.remotePaths ?? [];

            if (task.downloadFilePath) {
              const result = await runWithSudoRetry(
                t('fileExplorer.sudo.operation.download', language),
                task.downloadFilePath,
                (options) => window.guiSSH!.connections.downloadFile(connectionId, task.downloadFilePath!, withTransferClientId(options)),
              );

              updateTransferTask(task.id, (currentTask) => ({
                ...currentTask,
                status: result?.canceled ? 'canceled' : 'success',
                progress: currentTask.progress,
              }));
            } else if (remotePaths.length) {
              const result = await runWithSudoRetry(
                t('fileExplorer.sudo.operation.download', language),
                remotePath,
                (options) => window.guiSSH!.connections.downloadPaths(connectionId, remotePaths, withTransferClientId(options)),
              );

              updateTransferTask(task.id, (currentTask) => ({
                ...currentTask,
                status: result?.canceled ? 'canceled' : 'success',
                progress: currentTask.progress,
              }));
            } else {
              throw new Error(language === 'zh-CN' ? '下载任务缺少远程路径。' : 'Download task has no remote paths.');
            }
          }
        } catch (error) {
          updateTransferTask(task.id, (currentTask) => ({
            ...currentTask,
            status: 'error',
            error: getErrorMessage(error),
          }));
        } finally {
          activeTransferTaskIdRef.current = null;
          setTransferProgress(null);
        }
      }
    } finally {
      transferProcessingRef.current = false;
    }
  }, [connectionId, language, refreshFiles, remotePath, runWithSudoRetry, updateTransferTask]);

  const enqueueTransferTasks = useCallback((tasks: ExplorerTransferTask[]) => {
    if (!tasks.length) {
      return;
    }

    setTransferQueue((currentTasks) => {
      const nextTasks = [...currentTasks, ...tasks];
      transferQueueRef.current = nextTasks;
      return nextTasks;
    });

    window.setTimeout(() => {
      void processTransferQueue();
    }, 0);
  }, [processTransferQueue]);

  const retryTransferTask = useCallback((taskId: string) => {
    updateTransferTask(taskId, (task) => ({
      ...task,
      status: 'queued',
      error: '',
      progress: undefined,
    }));
    window.setTimeout(() => {
      void processTransferQueue();
    }, 0);
  }, [processTransferQueue, updateTransferTask]);

  const clearFinishedTransferTasks = useCallback(() => {
    setTransferQueue((tasks) => {
      const nextTasks = tasks.filter((task) => task.status === 'queued' || task.status === 'running');
      transferQueueRef.current = nextTasks;
      return nextTasks;
    });
  }, []);

  const enqueueUploadSelection = useCallback((
    items: ShellDeskSelectedUploadItem[],
    remoteNameByPath = new Map<string, string>(),
  ) => {
    if (!items.length) {
      return;
    }

    const uploadItems = items.map((item) => ({
      path: item.path,
      remoteName: remoteNameByPath.get(item.path),
    }));
    const taskId = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    enqueueTransferTasks([{
      id: taskId,
      type: 'upload',
      label: getUploadTaskLabel(items, language),
      detail: remotePath,
      status: 'queued',
      createdAt: Date.now(),
      uploadItems,
      uploadTarget: remotePath,
    }]);
  }, [enqueueTransferTasks, language, remotePath]);

  const findUploadConflicts = useCallback(async (items: ShellDeskSelectedUploadItem[]) => {
    const conflicts: ExplorerUploadConflictDialog['conflicts'] = [];

    for (const item of items) {
      const targetPath = joinRemotePath(remotePath, item.name, isWindowsHost);

      try {
        await runWithSudoRetry(
          t('fileExplorer.sudo.operation.upload', language),
          targetPath,
          (options) => window.guiSSH!.connections.statPath(connectionId, targetPath, options),
        );
        conflicts.push({ item, remotePath: targetPath });
      } catch (error) {
        if (!isRemotePathMissingError(error)) {
          throw error;
        }
      }
    }

    return conflicts;
  }, [connectionId, isWindowsHost, language, remotePath, runWithSudoRetry]);

  const prepareUploadSelection = useCallback(async (items: ShellDeskSelectedUploadItem[]) => {
    if (!items.length) {
      return;
    }

    try {
      setFilesError('');
      const conflicts = await findUploadConflicts(items);

      if (conflicts.length) {
        setUploadConflictDialog({ items, conflicts });
        return;
      }

      enqueueUploadSelection(items);
    } catch (error) {
      setFilesError(getErrorMessage(error));
    }
  }, [enqueueUploadSelection, findUploadConflicts, setFilesError]);

  const resolveDuplicateRemoteName = useCallback(async (name: string) => {
    const { base, ext } = splitFileNameForDuplicate(name);

    for (let index = 1; index <= 100; index += 1) {
      const candidateName = index === 1 ? `${base} copy${ext}` : `${base} copy ${index}${ext}`;
      const candidatePath = joinRemotePath(remotePath, candidateName, isWindowsHost);

      try {
        await window.guiSSH!.connections.statPath(connectionId, candidatePath);
      } catch (error) {
        if (isRemotePathMissingError(error)) {
          return candidateName;
        }

        throw error;
      }
    }

    throw new Error(language === 'zh-CN' ? `无法为 ${name} 找到可用的新名称。` : `Could not find an available name for ${name}.`);
  }, [connectionId, isWindowsHost, language, remotePath]);

  const resolveUploadConflicts = useCallback(async (strategy: 'skip' | 'replace' | 'duplicate') => {
    const dialog = uploadConflictDialog;

    if (!dialog) {
      return;
    }

    setUploadConflictDialog(null);

    try {
      if (strategy === 'replace') {
        enqueueUploadSelection(dialog.items);
        return;
      }

      const conflictPathSet = new Set(dialog.conflicts.map((conflict) => conflict.item.path));

      if (strategy === 'skip') {
        const safeItems = dialog.items.filter((item) => !conflictPathSet.has(item.path));

        if (!safeItems.length) {
          enqueueTransferTasks([{
            id: `upload-skip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            type: 'upload',
            label: getUploadTaskLabel(dialog.items, language),
            detail: remotePath,
            status: 'skipped',
            createdAt: Date.now(),
          }]);
          return;
        }

        enqueueUploadSelection(safeItems);
        return;
      }

      const remoteNameByPath = new Map<string, string>();

      for (const conflict of dialog.conflicts) {
        remoteNameByPath.set(conflict.item.path, await resolveDuplicateRemoteName(conflict.item.name));
      }

      enqueueUploadSelection(dialog.items, remoteNameByPath);
    } catch (error) {
      setFilesError(getErrorMessage(error));
    }
  }, [
    enqueueTransferTasks,
    enqueueUploadSelection,
    language,
    remotePath,
    resolveDuplicateRemoteName,
    setFilesError,
    uploadConflictDialog,
  ]);

  const cancelTransfer = useCallback(async () => {
    try {
      await window.guiSSH?.connections.cancelTransfer(connectionId, transferProgress?.queueId);
    } catch { /* ignore */ }
  }, [connectionId, transferProgress?.queueId]);

  return {
    transferProgress,
    transferQueue,
    uploadConflictDialog,
    setUploadConflictDialog,
    enqueueTransferTasks,
    retryTransferTask,
    clearFinishedTransferTasks,
    prepareUploadSelection,
    resolveUploadConflicts,
    cancelTransfer,
  };
}
