export interface LatestWinsSingleFlightQueueOptions<T> {
  getKey: (value: T) => string;
  save: (value: T) => Promise<void>;
  onError?: (error: unknown, value: T) => void;
}

export interface LatestWinsSingleFlightQueue<T> {
  enqueue: (value: T) => void;
  drain: {
    (): Promise<void>;
    (value: T): Promise<void>;
  };
  hasWork: () => boolean;
}

export interface LatestRequestGate {
  begin: () => number;
  isCurrent: (requestId: number) => boolean;
}

export function createLatestRequestGate(): LatestRequestGate {
  let latestRequestId = 0;

  return {
    begin: () => {
      latestRequestId += 1;
      return latestRequestId;
    },
    isCurrent: (requestId) => requestId === latestRequestId,
  };
}

export function isCollectionsSnapshotCurrent(
  requestRevision: number,
  currentRevision: number,
  hasSaveWork: boolean,
) {
  return requestRevision === currentRevision && !hasSaveWork;
}

// Each instance coordinates one logical latest-wins stream, not independent save protocols.
type QueueEntry<T> = {
  value: T;
  key: string;
  outcome: 'pending' | 'in-flight' | 'succeeded' | 'failed';
  error?: unknown;
};

export function createLatestWinsSingleFlightQueue<T>(
  options: LatestWinsSingleFlightQueueOptions<T>,
): LatestWinsSingleFlightQueue<T> {
  let pending: QueueEntry<T> | null = null;
  let inFlight: QueueEntry<T> | null = null;
  let latest: QueueEntry<T> | null = null;
  let runPromise: Promise<void> | null = null;

  const runPending = async () => {
    while (pending) {
      const entry = pending;
      pending = null;
      inFlight = entry;
      entry.outcome = 'in-flight';

      try {
        await options.save(entry.value);
        entry.outcome = 'succeeded';
      } catch (error) {
        entry.outcome = 'failed';
        entry.error = error;

        try {
          options.onError?.(error, entry.value);
        } catch {
          // Error reporting must not prevent a newer pending save from running.
        }
      } finally {
        inFlight = null;
      }
    }
  };

  const ensureRun = () => {
    if (runPromise || !pending) {
      return;
    }

    runPromise = Promise.resolve()
      .then(runPending)
      .finally(() => {
        runPromise = null;

        if (pending) {
          ensureRun();
        }
      });
  };

  const enqueue = (value: T) => {
    const key = options.getKey(value);

    if (pending?.key === key) {
      pending.value = value;
      latest = pending;
      return;
    }

    if (inFlight?.key === key) {
      pending = null;
      latest = inFlight;
      return;
    }

    pending = {
      value,
      key,
      outcome: 'pending',
    };
    latest = pending;
    ensureRun();
  };

  async function drain(...values: [] | [T]) {
    if (values.length > 0) {
      enqueue(values[0] as T);
    }

    while (runPromise || pending || inFlight) {
      ensureRun();

      const currentRun = runPromise;
      if (currentRun) {
        await currentRun;
      } else {
        await Promise.resolve();
      }
    }

    if (latest?.outcome === 'failed') {
      throw latest.error;
    }
  }

  return {
    enqueue,
    drain,
    hasWork: () => Boolean(runPromise || pending || inFlight),
  };
}
