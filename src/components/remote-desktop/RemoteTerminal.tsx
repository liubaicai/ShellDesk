import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';

import { getErrorMessage } from './desktopUtils';

interface RemoteTerminalProps {
  connectionId: string;
  terminalId: string;
}

function RemoteTerminal({ connectionId, terminalId }: RemoteTerminalProps) {
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const lastSizeRef = useRef({ columns: 0, rows: 0 });
  const isTerminalReadyRef = useRef(false);
  const useLegacyTerminalIpcRef = useRef(false);

  useEffect(() => {
    const host = terminalHostRef.current;
    const api = window.guiSSH;

    if (!host || !api?.connections || !api.events) {
      return;
    }

    let disposed = false;
    let animationFrame = 0;
    let startWarningTimer = 0;
    const supportsTerminalIpcOptions = typeof api.connections.getIpcCapabilities === 'function';
    isTerminalReadyRef.current = false;
    const terminal = new XTerminal({
      allowTransparency: true,
      cursorBlink: true,
      cursorStyle: 'block',
      fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 10000,
      theme: {
        background: '#000000',
        foreground: '#d7fbe8',
        cursor: '#8cf7d5',
        selectionBackground: '#29546f',
        black: '#111827',
        red: '#ff6f8f',
        green: '#8cf7d5',
        yellow: '#ffe08a',
        blue: '#43c7ff',
        magenta: '#c084fc',
        cyan: '#67e8f9',
        white: '#edf4ff',
      },
    });
    const fitAddon = new FitAddon();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    terminal.focus();

    const getTerminalSize = () => {
      try {
        fitAddon.fit();
      } catch {
        return { columns: 100, rows: 30 };
      }

      return {
        columns: Math.min(Math.max(terminal.cols || 100, 20), 300),
        rows: Math.min(Math.max(terminal.rows || 30, 5), 120),
      };
    };

    const fitAndSyncSize = () => {
      if (disposed) {
        return;
      }

      const { columns, rows } = getTerminalSize();

      if (lastSizeRef.current.columns === columns && lastSizeRef.current.rows === rows) {
        return;
      }

      lastSizeRef.current = { columns, rows };
      if (supportsTerminalIpcOptions) {
        api.connections
          .resizeTerminal(connectionId, terminalId, columns, rows, { legacy: useLegacyTerminalIpcRef.current })
          .catch(() => undefined);
      } else {
        const resizeTerminal = api.connections.resizeTerminal as unknown as (
          nextConnectionId: string,
          nextColumns: number,
          nextRows: number,
        ) => Promise<boolean>;
        resizeTerminal(connectionId, columns, rows).catch(() => undefined);
      }
    };

    const removeTerminalData = api.events.onTerminalData((payload) => {
      if (payload.connectionId === connectionId && (payload.terminalId === terminalId || !payload.terminalId)) {
        if (!payload.terminalId) {
          useLegacyTerminalIpcRef.current = true;
        }

        terminal.write(payload.data);
      }
    });
    const removeTerminalExit = api.events.onTerminalExit((payload) => {
      if (payload.connectionId === connectionId && (payload.terminalId === terminalId || !payload.terminalId)) {
        isTerminalReadyRef.current = false;
        terminal.writeln('\r\n终端会话已结束。');
      }
    });
    const inputDisposable = terminal.onData((data) => {
      if (!isTerminalReadyRef.current) {
        return;
      }

      const writePromise = supportsTerminalIpcOptions
        ? api.connections.writeTerminal(connectionId, terminalId, data, { legacy: useLegacyTerminalIpcRef.current })
        : (api.connections.writeTerminal as unknown as (
            nextConnectionId: string,
            nextData: string,
          ) => Promise<boolean>)(connectionId, data);

      writePromise.catch((error: unknown) => {
        terminal.writeln(`\r\n发送失败：${getErrorMessage(error)}`);
      });
    });
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fitAndSyncSize);

    resizeObserver?.observe(host);
    animationFrame = window.requestAnimationFrame(() => {
      const { columns, rows } = getTerminalSize();
      lastSizeRef.current = { columns, rows };
      startWarningTimer = window.setTimeout(() => {
        if (!disposed && !isTerminalReadyRef.current) {
          terminal.writeln('\r\n终端仍在启动：远程服务器尚未返回 Shell，请检查服务器是否允许交互式登录。');
        }
      }, 12000);

      const capabilitiesPromise = supportsTerminalIpcOptions
        ? api.connections.getIpcCapabilities()
        : Promise.resolve({ terminalSessions: false });

      capabilitiesPromise
        .then((capabilities) => {
          useLegacyTerminalIpcRef.current = !capabilities.terminalSessions;

          if (useLegacyTerminalIpcRef.current) {
            terminal.writeln('检测到旧版 Electron 主进程，使用单终端兼容模式。');
          }

          if (supportsTerminalIpcOptions) {
            return api.connections.startTerminal(connectionId, terminalId, columns, rows, {
              legacy: useLegacyTerminalIpcRef.current,
            });
          }

          return (api.connections.startTerminal as unknown as (nextConnectionId: string) => Promise<boolean>)(connectionId);
        })
        .then(() => {
          window.clearTimeout(startWarningTimer);

          if (disposed) {
            return;
          }

          isTerminalReadyRef.current = true;
          fitAndSyncSize();
          terminal.focus();
        })
        .catch((error: unknown) => {
          window.clearTimeout(startWarningTimer);

          if (disposed) {
            return;
          }

          terminal.writeln(`\r\n终端启动失败：${getErrorMessage(error)}`);
        });
    });

    return () => {
      disposed = true;
      isTerminalReadyRef.current = false;
      window.clearTimeout(startWarningTimer);
      window.cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      inputDisposable.dispose();
      removeTerminalData();
      removeTerminalExit();
      if (supportsTerminalIpcOptions && !useLegacyTerminalIpcRef.current) {
        api.connections.closeTerminal(connectionId, terminalId).catch(() => undefined);
      }

      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [connectionId, terminalId]);

  return (
    <div className="terminal-pane xterm-terminal-pane">
      <div ref={terminalHostRef} className="terminal-host" />
    </div>
  );
}

export default RemoteTerminal;
