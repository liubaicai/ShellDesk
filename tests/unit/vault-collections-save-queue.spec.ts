import { expect, test } from '@playwright/test';

import {
  createLatestRequestGate,
  createLatestWinsSingleFlightQueue,
  isCollectionsSnapshotCurrent,
} from '../../src/features/vault/latestSaveQueue';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function createDeferred<T = void>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

test('vault snapshots require the request revision to remain current after saves settle', () => {
  expect(isCollectionsSnapshotCurrent(7, 7, false)).toBe(true);
  expect(isCollectionsSnapshotCurrent(7, 7, true)).toBe(false);
  expect(isCollectionsSnapshotCurrent(7, 8, false)).toBe(false);
});

test('external vault snapshots only apply the latest response when requests finish out of order', async () => {
  const gate = createLatestRequestGate();
  const older = createDeferred<string>();
  const newer = createDeferred<string>();
  const applied: string[] = [];
  let currentRevision = 4;
  let hasSaveWork = false;

  const applyWhenCurrent = async (snapshot: Deferred<string>) => {
    const requestId = gate.begin();
    const requestRevision = currentRevision;
    const value = await snapshot.promise;
    if (
      gate.isCurrent(requestId)
      && isCollectionsSnapshotCurrent(requestRevision, currentRevision, hasSaveWork)
    ) {
      applied.push(value);
    }
  };

  const olderRequest = applyWhenCurrent(older);
  const newerRequest = applyWhenCurrent(newer);

  newer.resolve('newer');
  await newerRequest;
  older.resolve('older');
  await olderRequest;

  expect(applied).toEqual(['newer']);

  const staleAfterMutation = createDeferred<string>();
  const staleRequest = applyWhenCurrent(staleAfterMutation);
  currentRevision += 1;
  hasSaveWork = true;
  staleAfterMutation.resolve('stale-after-mutation');
  await staleRequest;
  expect(applied).toEqual(['newer']);
});

function createSaveHarness(values: string[]) {
  const gates = new Map(values.map((value) => [value, createDeferred()]));
  const calls: string[] = [];
  let active = 0;
  let maxActive = 0;

  return {
    calls,
    gates,
    get maxActive() {
      return maxActive;
    },
    save: async (value: string) => {
      calls.push(value);
      active += 1;
      maxActive = Math.max(maxActive, active);

      try {
        await gates.get(value)!.promise;
      } finally {
        active -= 1;
      }
    },
  };
}

test('broad collections forced drain waits for the call-time value and newer pending values', async () => {
  const harness = createSaveHarness(['A', 'C', 'D']);
  const queue = createLatestWinsSingleFlightQueue({
    getKey: (value: string) => value,
    save: harness.save,
  });

  queue.enqueue('A');
  await flushMicrotasks();
  queue.enqueue('B');
  const drainPromise = queue.drain('C');

  expect(harness.calls).toEqual(['A']);
  expect(queue.hasWork()).toBe(true);

  harness.gates.get('A')!.resolve();
  await flushMicrotasks();
  expect(harness.calls).toEqual(['A', 'C']);

  queue.enqueue('D');
  harness.gates.get('C')!.resolve();
  await flushMicrotasks();
  expect(harness.calls).toEqual(['A', 'C', 'D']);

  harness.gates.get('D')!.resolve();
  await drainPromise;

  expect(queue.hasWork()).toBe(false);
  expect(harness.maxActive).toBe(1);
});

test('broad collections failure reports the error and continues with the pending value', async () => {
  const harness = createSaveHarness(['A', 'B']);
  const reportedErrors: Array<{ error: unknown; value: string }> = [];
  const queue = createLatestWinsSingleFlightQueue({
    getKey: (value: string) => value,
    save: harness.save,
    onError: (error, value) => reportedErrors.push({ error, value }),
  });
  const failure = new Error('save A failed');

  queue.enqueue('A');
  await flushMicrotasks();
  queue.enqueue('B');
  const drainPromise = queue.drain();

  harness.gates.get('A')!.reject(failure);
  await flushMicrotasks();
  expect(harness.calls).toEqual(['A', 'B']);

  harness.gates.get('B')!.resolve();
  await drainPromise;

  expect(reportedErrors).toEqual([{ error: failure, value: 'A' }]);
  expect(queue.hasWork()).toBe(false);
  expect(harness.maxActive).toBe(1);
});

test('broad collections forced drain rejects once when the final latest save fails', async () => {
  const harness = createSaveHarness(['A']);
  const reportedErrors: Array<{ error: unknown; value: string }> = [];
  const queue = createLatestWinsSingleFlightQueue({
    getKey: (value: string) => value,
    save: harness.save,
    onError: (error, value) => reportedErrors.push({ error, value }),
  });
  const failure = new Error('latest save failed');
  const drainPromise = queue.drain('A');

  await flushMicrotasks();
  expect(harness.calls).toEqual(['A']);
  harness.gates.get('A')!.reject(failure);

  let rejection: unknown;
  try {
    await drainPromise;
  } catch (error) {
    rejection = error;
  }

  expect(rejection).toBe(failure);
  expect(reportedErrors).toEqual([{ error: failure, value: 'A' }]);
  expect(queue.hasWork()).toBe(false);
  expect(harness.maxActive).toBe(1);
});

test('broad collections save only persists the latest pending value', async () => {
  const harness = createSaveHarness(['A', 'D']);
  const queue = createLatestWinsSingleFlightQueue({
    getKey: (value: string) => value,
    save: harness.save,
  });

  queue.enqueue('A');
  await flushMicrotasks();
  queue.enqueue('B');
  queue.enqueue('C');
  queue.enqueue('D');
  const drainPromise = queue.drain();

  harness.gates.get('A')!.resolve();
  await flushMicrotasks();
  expect(harness.calls).toEqual(['A', 'D']);

  harness.gates.get('D')!.resolve();
  await drainPromise;

  expect(harness.calls).toEqual(['A', 'D']);
  expect(harness.maxActive).toBe(1);
});
