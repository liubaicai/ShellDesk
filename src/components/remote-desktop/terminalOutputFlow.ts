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
}

interface TerminalOutputFlowOptions {
  write: (data: string, done: () => void) => void;
  acknowledge: (sequence: number, byteLength: number) => void;
  scheduler?: TerminalOutputScheduler;
  maxBatchBytes?: number;
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
const defaultAnimationFrameFallbackMs = 50;
const outputEncoder = new TextEncoder();

function createBrowserScheduler(): TerminalOutputScheduler {
  return {
    queueMicrotask: (callback) => queueMicrotask(callback),
    requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
    cancelAnimationFrame: (handle) => window.cancelAnimationFrame(handle),
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimeout: (handle) => window.clearTimeout(handle),
  };
}

export function createTerminalOutputFlowController({
  write,
  acknowledge,
  scheduler = createBrowserScheduler(),
  maxBatchBytes = defaultMaxBatchBytes,
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

  const takeBatch = () => {
    const chunks: TerminalOutputChunk[] = [];
    let bytes = 0;
    while (queue.length) {
      const next = queue[0];
      const nextBytes = Math.max(next.byteLength ?? outputEncoder.encode(next.data).byteLength, 0);
      if (chunks.length && bytes + nextBytes > maxBatchBytes) {
        break;
      }
      queue.shift();
      chunks.push(next);
      bytes += nextBytes;
      queuedBytes = Math.max(0, queuedBytes - nextBytes);
    }
    return chunks;
  };

  const schedule = () => {
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
        schedule();
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
      drainCallbacks = [];
    },
  };
}
