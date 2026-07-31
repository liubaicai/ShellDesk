import { expect, test } from '@playwright/test';

import { createTerminalOutputFlowController } from '../../src/components/remote-desktop/terminalOutputFlow';

function createScheduler() {
  const microtasks: Array<() => void> = [];
  const animationFrames = new Map<number, () => void>();
  const timers = new Map<number, () => void>();
  let sequence = 0;
  return {
    scheduler: {
      queueMicrotask: (callback: () => void) => microtasks.push(callback),
      requestAnimationFrame: (callback: () => void) => {
        sequence += 1;
        animationFrames.set(sequence, callback);
        return sequence;
      },
      cancelAnimationFrame: (handle: number) => animationFrames.delete(handle),
      setTimeout: (callback: () => void) => {
        sequence += 1;
        timers.set(sequence, callback);
        return sequence;
      },
      clearTimeout: (handle: number) => timers.delete(handle),
    },
    runMicrotask: () => microtasks.shift()?.(),
    runAnimationFrame: () => animationFrames.values().next().value?.(),
    runTimer: () => timers.values().next().value?.(),
    pendingAnimationFrames: () => animationFrames.size,
    pendingTimers: () => timers.size,
  };
}

test('coalesces output and acknowledges only after the xterm write completes', () => {
  const fake = createScheduler();
  const writes: Array<{ data: string; done: () => void }> = [];
  const acknowledgements: Array<[number, number]> = [];
  const controller = createTerminalOutputFlowController({
    scheduler: fake.scheduler,
    write: (data, done) => writes.push({ data, done }),
    acknowledge: (sequence, byteLength) => acknowledgements.push([sequence, byteLength]),
  });

  controller.enqueue({ data: 'hello', sequence: 1, byteLength: 5 });
  controller.enqueue({ data: ' world', sequence: 2, byteLength: 6 });
  fake.runMicrotask();
  expect(writes).toHaveLength(1);
  expect(writes[0].data).toBe('hello world');
  expect(acknowledgements).toEqual([]);

  writes[0].done();
  expect(acknowledgements).toEqual([[2, 11]]);
  controller.dispose();
});

test('holds hidden output until visible and uses a timeout fallback for alternate screens', () => {
  const fake = createScheduler();
  const writes: Array<{ data: string; done: () => void }> = [];
  const controller = createTerminalOutputFlowController({
    scheduler: fake.scheduler,
    initiallyVisible: false,
    write: (data, done) => writes.push({ data, done }),
    acknowledge: () => undefined,
  });

  controller.enqueue({ data: 'background', sequence: 1, byteLength: 10 });
  expect(writes).toEqual([]);
  expect(controller.pendingBytes()).toBe(10);

  controller.setAlternateScreen(true);
  controller.setVisible(true);
  expect(fake.pendingAnimationFrames()).toBe(1);
  expect(fake.pendingTimers()).toBe(1);
  fake.runTimer();
  expect(writes[0].data).toBe('background');
  writes[0].done();
  expect(fake.pendingAnimationFrames()).toBe(0);
  expect(fake.pendingTimers()).toBe(0);
  controller.dispose();
});

test('runs drain callbacks after queued output reaches xterm', () => {
  const fake = createScheduler();
  const writes: Array<{ data: string; done: () => void }> = [];
  const events: string[] = [];
  const controller = createTerminalOutputFlowController({
    scheduler: fake.scheduler,
    write: (data, done) => writes.push({ data, done }),
    acknowledge: () => undefined,
  });

  controller.enqueue({ data: 'last output' });
  controller.whenDrained(() => events.push('drained'));
  fake.runMicrotask();
  expect(events).toEqual([]);
  writes[0].done();
  expect(events).toEqual(['drained']);
  controller.dispose();
});

test('keeps acknowledgements ordered when an internal chunk is hidden', () => {
  const fake = createScheduler();
  const writes: Array<{ data: string; done: () => void }> = [];
  const acknowledgements: Array<[number, number]> = [];
  const controller = createTerminalOutputFlowController({
    scheduler: fake.scheduler,
    maxBatchBytes: 5,
    write: (data, done) => writes.push({ data, done }),
    acknowledge: (sequence, byteLength) => acknowledgements.push([sequence, byteLength]),
  });

  controller.enqueue({ data: 'shown', sequence: 1, byteLength: 5 });
  fake.runMicrotask();
  controller.enqueue({ data: '', sequence: 2, byteLength: 20 });
  expect(acknowledgements).toEqual([]);

  writes[0].done();
  fake.runMicrotask();
  expect(acknowledgements).toEqual([[1, 5], [2, 20]]);
  controller.dispose();
});
