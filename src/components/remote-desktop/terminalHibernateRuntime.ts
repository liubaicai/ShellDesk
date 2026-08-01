import type { Terminal as XTerminal } from '@xterm/xterm';

import type { TerminalRendererRuntime } from './terminalRendererRuntime';

export interface TerminalHibernateRuntime {
  setVisible: (visible: boolean) => void;
  update: (enabled: boolean, delaySeconds: number) => void;
  dispose: () => void;
}

const maximumSnapshotLines = 2_000;
const maximumSnapshotCharacters = 2 * 1024 * 1024;
const retryDelayMs = 30_000;

export function createTerminalHibernateRuntime({
  terminal,
  renderer,
  enabled: initialEnabled,
  delaySeconds: initialDelaySeconds,
  canHibernate,
  onStateChange,
}: {
  terminal: XTerminal;
  renderer: TerminalRendererRuntime;
  enabled: boolean;
  delaySeconds: number;
  canHibernate: () => boolean;
  onStateChange?: (hibernated: boolean) => void;
}): TerminalHibernateRuntime {
  let enabled = initialEnabled;
  let delaySeconds = initialDelaySeconds;
  let visible = true;
  let disposed = false;
  let hibernated = false;
  let timer: number | null = null;
  let serializeAddon: import('@xterm/addon-serialize').SerializeAddon | null = null;
  let addonPromise: Promise<import('@xterm/addon-serialize').SerializeAddon | null> | null = null;

  const clearTimer = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };

  const ensureSerializeAddon = () => {
    if (serializeAddon) {
      return Promise.resolve(serializeAddon);
    }
    addonPromise ??= import('@xterm/addon-serialize')
      .then(({ SerializeAddon }) => {
        if (disposed) {
          return null;
        }
        const addon = new SerializeAddon();
        terminal.loadAddon(addon);
        serializeAddon = addon;
        return addon;
      })
      .catch(() => null);
    return addonPromise;
  };

  const schedule = (delayMs = Math.max(30, delaySeconds) * 1_000) => {
    clearTimer();
    if (disposed || visible || !enabled || hibernated) {
      return;
    }
    timer = window.setTimeout(() => {
      timer = null;
      if (disposed || visible || !enabled || hibernated) {
        return;
      }
      if (!canHibernate() || terminal.buffer.active.type === 'alternate') {
        schedule(retryDelayMs);
        return;
      }
      void ensureSerializeAddon().then((addon) => {
        if (!addon || disposed || visible || !enabled || hibernated || !canHibernate()) {
          schedule(retryDelayMs);
          return;
        }
        try {
          const snapshot = addon.serialize({
            scrollback: Math.min(maximumSnapshotLines, terminal.options.scrollback ?? maximumSnapshotLines),
            excludeAltBuffer: true,
          }).slice(-maximumSnapshotCharacters);
          if (!snapshot) {
            schedule(retryDelayMs);
            return;
          }
          terminal.reset();
          terminal.write(snapshot);
          hibernated = true;
          renderer.hibernate();
          onStateChange?.(true);
        } catch {
          schedule(retryDelayMs);
        }
      });
    }, delayMs);
  };

  return {
    setVisible: (nextVisible) => {
      visible = nextVisible;
      if (visible) {
        clearTimer();
        if (hibernated) {
          hibernated = false;
          renderer.wake();
          onStateChange?.(false);
        }
        return;
      }
      schedule();
    },
    update: (nextEnabled, nextDelaySeconds) => {
      enabled = nextEnabled;
      delaySeconds = nextDelaySeconds;
      if (!enabled && hibernated) {
        hibernated = false;
        renderer.wake();
        onStateChange?.(false);
      }
      schedule();
    },
    dispose: () => {
      disposed = true;
      clearTimer();
      serializeAddon?.dispose();
      serializeAddon = null;
      addonPromise = null;
    },
  };
}
