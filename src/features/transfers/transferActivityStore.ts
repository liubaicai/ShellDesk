import { useSyncExternalStore } from 'react';

export interface TransferActivityApi {
  list: () => Promise<ShellDeskTransferTask[]>;
  subscribe: (listener: (task: ShellDeskTransferTask) => void) => (() => void) | undefined;
  cancel: (connectionId: string, queueId: string) => Promise<void>;
  remove: (transferId: string) => Promise<boolean>;
  clearFinished: () => Promise<number>;
}

interface TransferActivitySnapshot {
  tasks: ShellDeskTransferTask[];
  error: string;
}

export interface TransferActivityStore {
  subscribe: (listener: () => void) => () => void;
  getTasks: () => ShellDeskTransferTask[];
  getError: () => string;
  getActiveCount: () => number;
  getFailedCount: () => number;
  refresh: () => Promise<void>;
  cancel: (task: ShellDeskTransferTask) => Promise<void>;
  remove: (task: ShellDeskTransferTask) => Promise<void>;
  clearFinished: () => Promise<void>;
}

export function taskIsActive(task: ShellDeskTransferTask) {
  return task.status === 'queued' || task.status === 'running' || task.status === 'paused';
}

function sortTasks(tasks: ShellDeskTransferTask[]) {
  return [...tasks].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function upsertTask(tasks: ShellDeskTransferTask[], task: ShellDeskTransferTask) {
  const index = tasks.findIndex((item) => item.id === task.id);
  const next = index < 0
    ? [task, ...tasks]
    : tasks.map((item, itemIndex) => itemIndex === index ? task : item);
  return sortTasks(next);
}

function mergeConcurrentTaskChanges(
  loadedTasks: ShellDeskTransferTask[],
  currentTasks: ShellDeskTransferTask[],
) {
  const merged = new Map(loadedTasks.map((task) => [task.id, task]));
  currentTasks.forEach((task) => {
    const loaded = merged.get(task.id);
    if (!loaded || task.updatedAt >= loaded.updatedAt) {
      merged.set(task.id, task);
    }
  });
  return sortTasks([...merged.values()]);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function createWindowTransferActivityApi(): TransferActivityApi {
  return {
    list: async () => window.guiSSH?.connections?.listTransfers?.() ?? [],
    subscribe: (listener) => window.guiSSH?.events?.onTransferTaskChanged?.(listener),
    cancel: async (connectionId, queueId) => {
      await window.guiSSH?.connections?.cancelTransfer?.(connectionId, queueId);
    },
    remove: async (transferId) => window.guiSSH?.connections?.removeTransfer?.(transferId) ?? false,
    clearFinished: async () => window.guiSSH?.connections?.clearFinishedTransfers?.() ?? 0,
  };
}

export function createTransferActivityStore(api: TransferActivityApi): TransferActivityStore {
  let snapshot: TransferActivitySnapshot = { tasks: [], error: '' };
  let eventRevision = 0;
  let removeTaskListener: (() => void) | undefined;
  const listeners = new Set<() => void>();

  const publish = (nextSnapshot: TransferActivitySnapshot) => {
    if (nextSnapshot.tasks === snapshot.tasks && nextSnapshot.error === snapshot.error) {
      return;
    }
    snapshot = nextSnapshot;
    listeners.forEach((listener) => listener());
  };

  const setError = (error: string) => {
    publish({ ...snapshot, error });
  };

  const start = () => {
    if (removeTaskListener) {
      return;
    }
    removeTaskListener = api.subscribe((task) => {
      eventRevision += 1;
      publish({
        tasks: upsertTask(snapshot.tasks, task),
        error: '',
      });
    }) ?? (() => {});
  };

  const stop = () => {
    removeTaskListener?.();
    removeTaskListener = undefined;
  };

  const refresh = async () => {
    const revisionAtStart = eventRevision;
    try {
      const loadedTasks = sortTasks(await api.list());
      const tasks = revisionAtStart === eventRevision
        ? loadedTasks
        : mergeConcurrentTaskChanges(loadedTasks, snapshot.tasks);
      publish({ tasks, error: '' });
    } catch (error) {
      setError(errorMessage(error));
    }
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      if (listeners.size === 1) {
        start();
        void refresh();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          stop();
        }
      };
    },
    getTasks: () => snapshot.tasks,
    getError: () => snapshot.error,
    getActiveCount: () => snapshot.tasks.filter(taskIsActive).length,
    getFailedCount: () => snapshot.tasks.filter((task) => task.status === 'failed').length,
    refresh,
    cancel: async (task) => {
      if (!task.connectionId) {
        return;
      }
      try {
        await api.cancel(task.connectionId, task.queueId || task.id);
        setError('');
      } catch (error) {
        setError(errorMessage(error));
      }
    },
    remove: async (task) => {
      try {
        const removed = await api.remove(task.id);
        if (removed) {
          eventRevision += 1;
          publish({
            tasks: snapshot.tasks.filter((item) => item.id !== task.id),
            error: '',
          });
        } else {
          setError('');
        }
      } catch (error) {
        setError(errorMessage(error));
      }
    },
    clearFinished: async () => {
      try {
        await api.clearFinished();
        eventRevision += 1;
        publish({
          tasks: snapshot.tasks.filter(taskIsActive),
          error: '',
        });
      } catch (error) {
        setError(errorMessage(error));
      }
    },
  };
}

export const transferActivityStore = createTransferActivityStore(createWindowTransferActivityApi());

export function useTransferActivityTasks(store = transferActivityStore) {
  return useSyncExternalStore(store.subscribe, store.getTasks, store.getTasks);
}

export function useTransferActivityError(store = transferActivityStore) {
  return useSyncExternalStore(store.subscribe, store.getError, store.getError);
}

export function useActiveTransferCount(store = transferActivityStore) {
  return useSyncExternalStore(store.subscribe, store.getActiveCount, store.getActiveCount);
}

export function useFailedTransferCount(store = transferActivityStore) {
  return useSyncExternalStore(store.subscribe, store.getFailedCount, store.getFailedCount);
}
