import type { IDisposable, Terminal as XTerminal } from '@xterm/xterm';

export interface TerminalRendererRuntime {
  setVisible: (visible: boolean) => void;
  update: (renderer: ShellDeskAppSettings['terminalRenderer'], inlineImagesEnabled: boolean) => void;
  hibernate: () => void;
  wake: () => void;
  dispose: () => void;
}

const webglRecoveryWindowMs = 60_000;
const webglRecoveryLimit = 2;

export interface TerminalRendererEnvironment {
  isTauri: boolean;
  isWindows: boolean;
}

function readTerminalRendererEnvironment(): TerminalRendererEnvironment {
  return {
    isTauri: typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window,
    isWindows: typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent),
  };
}

export function shouldEnableTerminalWebglRenderer(
  renderer: ShellDeskAppSettings['terminalRenderer'],
  environment = readTerminalRendererEnvironment(),
) {
  if (renderer === 'dom') return false;
  if (renderer === 'webgl') return true;

  // WebGL can initialize successfully in WebView2 while leaving xterm's canvas blank.
  // Keep explicit WebGL available, but make automatic selection compatibility-safe.
  return !(environment.isTauri && environment.isWindows);
}

export function createTerminalRendererRuntime(
  terminal: XTerminal,
  initialRenderer: ShellDeskAppSettings['terminalRenderer'],
  initialInlineImagesEnabled: boolean,
): TerminalRendererRuntime {
  let renderer = initialRenderer;
  let inlineImagesEnabled = initialInlineImagesEnabled;
  let visible = true;
  let hibernated = false;
  let disposed = false;
  let generation = 0;
  let webglAddon: import('@xterm/addon-webgl').WebglAddon | null = null;
  let webglContextLossDisposable: IDisposable | null = null;
  let imageAddon: import('@xterm/addon-image').ImageAddon | null = null;
  let webglRecoveryTimes: number[] = [];
  let webglCircuitOpen = false;

  const disposeWebgl = () => {
    generation += 1;
    webglContextLossDisposable?.dispose();
    webglContextLossDisposable = null;
    webglAddon?.dispose();
    webglAddon = null;
  };

  const disposeImages = () => {
    imageAddon?.dispose();
    imageAddon = null;
  };

  const shouldUseWebgl = () => (
    !disposed
    && !hibernated
    && visible
    && shouldEnableTerminalWebglRenderer(renderer)
    && !webglCircuitOpen
  );

  const ensureWebgl = async () => {
    if (!shouldUseWebgl() || webglAddon) {
      return;
    }
    const currentGeneration = generation;
    try {
      const { WebglAddon } = await import('@xterm/addon-webgl');
      if (disposed || currentGeneration !== generation || !shouldUseWebgl()) {
        return;
      }
      const addon = new WebglAddon();
      terminal.loadAddon(addon);
      if (disposed || currentGeneration !== generation || !shouldUseWebgl()) {
        addon.dispose();
        return;
      }
      webglAddon = addon;
      terminal.refresh(0, Math.max(0, terminal.rows - 1));
      webglContextLossDisposable = addon.onContextLoss(() => {
        const now = Date.now();
        webglRecoveryTimes = webglRecoveryTimes.filter((time) => now - time <= webglRecoveryWindowMs);
        webglRecoveryTimes.push(now);
        disposeWebgl();
        if (webglRecoveryTimes.length > webglRecoveryLimit) {
          webglCircuitOpen = true;
          terminal.refresh(0, Math.max(0, terminal.rows - 1));
          return;
        }
        window.setTimeout(() => {
          terminal.refresh(0, Math.max(0, terminal.rows - 1));
          void ensureWebgl();
        }, 50);
      });
    } catch {
      disposeWebgl();
      if (renderer === 'webgl') {
        webglCircuitOpen = true;
      }
    }
  };

  const ensureImages = async () => {
    if (disposed || hibernated || !inlineImagesEnabled || imageAddon) {
      return;
    }
    const currentGeneration = generation;
    try {
      const { ImageAddon } = await import('@xterm/addon-image');
      if (disposed || currentGeneration !== generation || hibernated || !inlineImagesEnabled) {
        return;
      }
      const addon = new ImageAddon({
        enableSizeReports: false,
        pixelLimit: 8_388_608,
        storageLimit: 32,
        sixelPaletteLimit: 256,
        sixelSizeLimit: 8 * 1024 * 1024,
        iipSizeLimit: 8 * 1024 * 1024,
        showPlaceholder: true,
      });
      terminal.loadAddon(addon);
      if (disposed || currentGeneration !== generation || hibernated || !inlineImagesEnabled) {
        addon.dispose();
        return;
      }
      imageAddon = addon;
    } catch {
      disposeImages();
    }
  };

  const ensureEnabledAddons = () => {
    void ensureWebgl();
    void ensureImages();
  };

  ensureEnabledAddons();

  return {
    setVisible: (nextVisible) => {
      visible = nextVisible;
      if (!visible && renderer === 'auto') {
        disposeWebgl();
      } else {
        ensureEnabledAddons();
      }
    },
    update: (nextRenderer, nextInlineImagesEnabled) => {
      const rendererChanged = renderer !== nextRenderer;
      renderer = nextRenderer;
      inlineImagesEnabled = nextInlineImagesEnabled;
      if (rendererChanged) {
        webglCircuitOpen = false;
        webglRecoveryTimes = [];
        disposeWebgl();
      }
      if (!inlineImagesEnabled) {
        disposeImages();
      }
      ensureEnabledAddons();
    },
    hibernate: () => {
      hibernated = true;
      disposeWebgl();
      disposeImages();
    },
    wake: () => {
      hibernated = false;
      ensureEnabledAddons();
      terminal.refresh(0, Math.max(0, terminal.rows - 1));
    },
    dispose: () => {
      disposed = true;
      disposeWebgl();
      disposeImages();
    },
  };
}
