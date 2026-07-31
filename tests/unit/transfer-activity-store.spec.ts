import { expect, test } from '@playwright/test';

import {
  createTransferActivityStore,
  type TransferActivityApi,
} from '../../src/features/transfers/transferActivityStore';

function transferTask(
  id: string,
  status: ShellDeskTransferTask['status'],
  updatedAt: string,
  transferred = 0,
): ShellDeskTransferTask {
  return {
    id,
    connectionId: 'connection-1',
    queueId: id,
    type: 'download',
    fileName: `${id}.log`,
    transferred,
    total: 100,
    status,
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt,
  };
}

function createFakeApi(initialTasks: ShellDeskTransferTask[] = []) {
  let taskListener: ((task: ShellDeskTransferTask) => void) | undefined;
  let tasks = initialTasks;
  const api: TransferActivityApi = {
    list: async () => tasks,
    subscribe: (listener) => {
      taskListener = listener;
      return () => {
        taskListener = undefined;
      };
    },
    cancel: async () => {},
    remove: async () => true,
    clearFinished: async () => 0,
  };

  return {
    api,
    emit: (task: ShellDeskTransferTask) => taskListener?.(task),
    replaceTasks: (nextTasks: ShellDeskTransferTask[]) => {
      tasks = nextTasks;
    },
  };
}

test('transfer activity exposes stable leaf snapshots during byte progress', async () => {
  const fake = createFakeApi([
    transferTask('task-1', 'running', '2026-07-31T00:00:01.000Z', 10),
  ]);
  const store = createTransferActivityStore(fake.api);
  const unsubscribe = store.subscribe(() => {});
  await store.refresh();

  const tasksBeforeProgress = store.getTasks();
  const activeCountBeforeProgress = store.getActiveCount();
  const failedCountBeforeProgress = store.getFailedCount();

  fake.emit(transferTask('task-1', 'running', '2026-07-31T00:00:02.000Z', 60));

  expect(store.getTasks()).not.toBe(tasksBeforeProgress);
  expect(store.getTasks()[0]?.transferred).toBe(60);
  expect(store.getActiveCount()).toBe(activeCountBeforeProgress);
  expect(store.getFailedCount()).toBe(failedCountBeforeProgress);

  fake.emit(transferTask('task-1', 'completed', '2026-07-31T00:00:03.000Z', 100));
  expect(store.getActiveCount()).toBe(0);

  unsubscribe();
});

test('transfer refresh does not overwrite a newer event received while listing', async () => {
  let resolveList: ((tasks: ShellDeskTransferTask[]) => void) | undefined;
  const fake = createFakeApi();
  fake.api.list = () => new Promise((resolve) => {
    resolveList = resolve;
  });
  const store = createTransferActivityStore(fake.api);
  const unsubscribe = store.subscribe(() => {});

  const refresh = store.refresh();
  const eventTask = transferTask('task-1', 'running', '2026-07-31T00:00:05.000Z', 80);
  fake.emit(eventTask);
  resolveList?.([
    transferTask('task-1', 'running', '2026-07-31T00:00:04.000Z', 20),
  ]);
  await refresh;

  expect(store.getTasks()[0]?.transferred).toBe(80);
  unsubscribe();
});
