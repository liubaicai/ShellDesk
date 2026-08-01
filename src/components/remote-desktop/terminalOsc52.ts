import type { IDisposable, Terminal as XTerminal } from '@xterm/xterm';

const MAX_OSC52_BYTES = 1024 * 1024;

export type TerminalOsc52Action = 'ignore' | 'write' | 'prompt-read' | 'read';

export function resolveTerminalOsc52Action(
  mode: ShellDeskAppSettings['terminalOsc52Mode'],
  payload: string,
): TerminalOsc52Action {
  if (mode === 'off' || (payload === '?' && mode === 'write-only')) return 'ignore';
  if (payload !== '?') return 'write';
  return mode === 'prompt' ? 'prompt-read' : 'read';
}

function sanitizeSelection(value: string) {
  return /^[cps0-7]{0,16}$/u.test(value) ? value || 'c' : 'c';
}

function decodeBase64Text(value: string) {
  if (value.length > Math.ceil(MAX_OSC52_BYTES * 4 / 3) + 8) return null;
  try {
    const binary = atob(value);
    if (binary.length > MAX_OSC52_BYTES) return null;
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function encodeBase64Text(value: string) {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > MAX_OSC52_BYTES) return null;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

export function attachTerminalOsc52({
  terminal,
  mode,
  writeInput,
  onReadRequest,
}: {
  terminal: XTerminal;
  mode: () => ShellDeskAppSettings['terminalOsc52Mode'];
  writeInput: (data: string) => void;
  onReadRequest: (respond: () => void) => void;
}): IDisposable {
  return terminal.parser.registerOscHandler(52, (value) => {
    const separator = value.indexOf(';');
    if (separator < 0) return true;
    const selection = sanitizeSelection(value.slice(0, separator));
    const payload = value.slice(separator + 1);
    const currentMode = mode();
    const action = resolveTerminalOsc52Action(currentMode, payload);
    if (action === 'ignore') return true;
    if (action === 'write') {
      const text = decodeBase64Text(payload);
      if (text !== null && navigator.clipboard) void navigator.clipboard.writeText(text).catch(() => undefined);
      return true;
    }
    const respond = () => {
      if (!navigator.clipboard) return;
      void navigator.clipboard.readText().then((text) => {
        const encoded = encodeBase64Text(text);
        if (encoded !== null) writeInput(`\x1b]52;${selection};${encoded}\x07`);
      }).catch(() => undefined);
    };
    if (action === 'prompt-read') onReadRequest(respond);
    else respond();
    return true;
  });
}
