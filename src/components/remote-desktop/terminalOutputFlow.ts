export interface TerminalOutputChunk {
  data: string;
  sequence?: number;
  byteLength?: number;
}

interface TerminalOutputScheduler {
  queueMicrotask: (callback: () => void) => void;
  requestAnimationFrame: (callback: () => void) => number;
  cancelAnimationFrame: (handle: number) => void;
  setTimeout: (callback: () => void, delayMs: number) => number;
  clearTimeout: (handle: number) => void;
  now: () => number;
}

interface TerminalOutputFlowOptions {
  write: (data: string, done: () => void) => void;
  acknowledge: (sequence: number, byteLength: number) => void;
  scheduler?: TerminalOutputScheduler;
  maxBatchBytes?: number;
  floodBatchBytes?: number;
  floodThresholdBytes?: number;
  maxQueueItems?: number;
  drainTimeBudgetMs?: number;
  animationFrameFallbackMs?: number;
  initiallyVisible?: boolean;
}

export interface TerminalOutputFlowController {
  enqueue: (chunk: TerminalOutputChunk) => void;
  whenDrained: (callback: () => void) => void;
  setAlternateScreen: (active: boolean) => void;
  setVisible: (visible: boolean) => void;
  pendingBytes: () => number;
  dispose: () => void;
}

const defaultMaxBatchBytes = 128 * 1024;
const defaultFloodBatchBytes = 512 * 1024;
const defaultFloodThresholdBytes = 512 * 1024;
const defaultMaxQueueItems = 32;
const defaultDrainTimeBudgetMs = 10;
const defaultAnimationFrameFallbackMs = 50;
const outputEncoder = new TextEncoder();

function createBrowserScheduler(): TerminalOutputScheduler {
  return {
    queueMicrotask: (callback) => queueMicrotask(callback),
    requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
    cancelAnimationFrame: (handle) => window.cancelAnimationFrame(handle),
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimeout: (handle) => window.clearTimeout(handle),
    now: () => globalThis.performance?.now?.() ?? Date.now(),
  };
}

export function createTerminalOutputFlowController({
  write,
  acknowledge,
  scheduler = createBrowserScheduler(),
  maxBatchBytes = defaultMaxBatchBytes,
  floodBatchBytes = defaultFloodBatchBytes,
  floodThresholdBytes = defaultFloodThresholdBytes,
  maxQueueItems = defaultMaxQueueItems,
  drainTimeBudgetMs = defaultDrainTimeBudgetMs,
  animationFrameFallbackMs = defaultAnimationFrameFallbackMs,
  initiallyVisible = true,
}: TerminalOutputFlowOptions): TerminalOutputFlowController {
  let queue: TerminalOutputChunk[] = [];
  let queuedBytes = 0;
  let visible = initiallyVisible;
  let alternateScreen = false;
  let writing = false;
  let scheduled = false;
  let disposed = false;
  let animationFrame: number | null = null;
  let fallbackTimer: number | null = null;
  let drainCallbacks: Array<() => void> = [];
  let drainTurnStartedAt = 0;

  const notifyDrained = () => {
    if (disposed || writing || queue.length || scheduled || !drainCallbacks.length) {
      return;
    }
    const callbacks = drainCallbacks;
    drainCallbacks = [];
    callbacks.forEach((callback) => callback());
  };

  const clearScheduledHandles = () => {
    if (animationFrame !== null) {
      scheduler.cancelAnimationFrame(animationFrame);
      animationFrame = null;
    }
    if (fallbackTimer !== null) {
      scheduler.clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
  };

  const compactQueue = () => {
    if (queue.length <= maxQueueItems) {
      return;
    }
    const compacted: TerminalOutputChunk[] = [];
    const targetItems = Math.max(1, Math.floor(maxQueueItems / 2));
    const groupSize = Math.max(2, Math.ceil(queue.length / targetItems));
    for (let index = 0; index < queue.length; index += groupSize) {
      const group = queue.slice(index, index + groupSize);
      const sequenced = group.filter((chunk) => Number.isSafeInteger(chunk.sequence));
      compacted.push({
        data: group.map((chunk) => chunk.data).join(''),
        sequence: sequenced.at(-1)?.sequence,
        byteLength: group.reduce((total, chunk) => total + Math.max(chunk.byteLength ?? 0, 0), 0),
      });
    }
    queue = compacted;
  };

  const takeBatch = () => {
    const chunks: TerminalOutputChunk[] = [];
    let bytes = 0;
    const batchLimit = queuedBytes >= floodThresholdBytes
      ? Math.max(maxBatchBytes, floodBatchBytes)
      : maxBatchBytes;
    while (queue.length) {
      const next = queue[0];
      const nextBytes = Math.max(next.byteLength ?? outputEncoder.encode(next.data).byteLength, 0);
      if (chunks.length && bytes + nextBytes > batchLimit) {
        break;
      }
      queue.shift();
      chunks.push(next);
      bytes += nextBytes;
      queuedBytes = Math.max(0, queuedBytes - nextBytes);
    }
    return chunks;
  };

  const schedule = (yieldToEventLoop = false) => {
    if (disposed || scheduled || writing || !visible || !queue.length) {
      return;
    }
    scheduled = true;

    const run = () => {
      if (!scheduled) {
        return;
      }
      scheduled = false;
      clearScheduledHandles();
      if (disposed || writing || !visible || !queue.length) {
        return;
      }
      if (!drainTurnStartedAt) {
        drainTurnStartedAt = scheduler.now();
      }

      const chunks = takeBatch();
      const data = chunks.map((chunk) => chunk.data).join('');
      const sequencedChunks = chunks.filter((chunk) => (
        Number.isSafeInteger(chunk.sequence)
        && typeof chunk.byteLength === 'number'
        && chunk.byteLength >= 0
      ));
      const sequence = sequencedChunks.at(-1)?.sequence;
      const acknowledgedBytes = sequencedChunks.reduce(
        (total, chunk) => total + (chunk.byteLength ?? 0),
        0,
      );

      writing = true;
      let completed = false;
      const done = () => {
        if (completed) {
          return;
        }
        completed = true;
        writing = false;
        if (sequence !== undefined && acknowledgedBytes > 0) {
          acknowledge(sequence, acknowledgedBytes);
        }
        const shouldYield = scheduler.now() - drainTurnStartedAt >= drainTimeBudgetMs;
        if (shouldYield) {
          drainTurnStartedAt = 0;
        }
        schedule(shouldYield);
        notifyDrained();
      };

      try {
        if (data) {
          write(data, done);
        } else {
          done();
        }
      } catch {
        done();
      }
    };

    if (yieldToEventLoop) {
      fallbackTimer = scheduler.setTimeout(run, 0);
      return;
    }

    if (!alternateScreen) {
      scheduler.queueMicrotask(run);
      return;
    }

    animationFrame = scheduler.requestAnimationFrame(run);
    fallbackTimer = scheduler.setTimeout(run, animationFrameFallbackMs);
  };

  return {
    enqueue: (chunk) => {
      if (disposed) {
        return;
      }
      const hasAcknowledgement = Number.isSafeInteger(chunk.sequence)
        && typeof chunk.sequence === 'number'
        && typeof chunk.byteLength === 'number'
        && chunk.byteLength > 0;
      if (!chunk.data && !hasAcknowledgement) {
        return;
      }
      const byteLength = Math.max(
        chunk.byteLength ?? outputEncoder.encode(chunk.data).byteLength,
        0,
      );
      queue.push({ ...chunk, byteLength });
      queuedBytes += byteLength;
      compactQueue();
      schedule();
    },
    whenDrained: (callback) => {
      if (disposed) {
        return;
      }
      drainCallbacks.push(callback);
      notifyDrained();
    },
    setAlternateScreen: (active) => {
      alternateScreen = active;
      if (scheduled && active) {
        scheduled = false;
        clearScheduledHandles();
      }
      schedule();
    },
    setVisible: (nextVisible) => {
      visible = nextVisible;
      if (!visible && scheduled) {
        scheduled = false;
        clearScheduledHandles();
      }
      schedule();
    },
    pendingBytes: () => queuedBytes,
    dispose: () => {
      disposed = true;
      scheduled = false;
      clearScheduledHandles();
      queue = [];
      queuedBytes = 0;
      drainTurnStartedAt = 0;
      drainCallbacks = [];
    },
  };
}
