import type { IDisposable, Terminal as XTerminal } from '@xterm/xterm';

const kittyKeyCodes: Record<string, number> = {
  Escape: 27,
  Enter: 13,
  Tab: 9,
  Backspace: 127,
  Insert: 57348,
  Delete: 57349,
  ArrowLeft: 57350,
  ArrowRight: 57351,
  ArrowUp: 57352,
  ArrowDown: 57353,
  PageUp: 57354,
  PageDown: 57355,
  Home: 57356,
  End: 57357,
  CapsLock: 57358,
  ScrollLock: 57359,
  NumLock: 57360,
  PrintScreen: 57361,
  Pause: 57362,
  ContextMenu: 57363,
  F1: 57364,
  F2: 57365,
  F3: 57366,
  F4: 57367,
  F5: 57368,
  F6: 57369,
  F7: 57370,
  F8: 57371,
  F9: 57372,
  F10: 57373,
  F11: 57374,
  F12: 57375,
};

function firstParam(params: (number | number[])[], fallback: number) {
  const value = params[0];
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function modifierParameter(event: KeyboardEvent) {
  let modifiers = 1;
  if (event.shiftKey) modifiers += 1;
  if (event.altKey) modifiers += 2;
  if (event.ctrlKey) modifiers += 4;
  if (event.metaKey) modifiers += 8;
  return modifiers;
}

function keyCode(event: KeyboardEvent) {
  const special = kittyKeyCodes[event.key];
  if (special) return special;
  const characters = [...event.key];
  if (characters.length === 1) return characters[0].codePointAt(0) ?? 0;
  return 0;
}

export interface TerminalKittyKeyboardRuntime {
  handleKeyEvent: (event: KeyboardEvent) => boolean;
  dispose: () => void;
}

export function createTerminalKittyKeyboardRuntime({
  terminal,
  enabled,
  writeInput,
}: {
  terminal: XTerminal;
  enabled: () => boolean;
  writeInput: (data: string) => void;
}): TerminalKittyKeyboardRuntime {
  let flags = 0;
  const stack: number[] = [];
  const disposables: IDisposable[] = [];

  const setFlags = (value: number) => {
    flags = Math.min(Math.max(value, 0), 31);
  };

  disposables.push(
    terminal.parser.registerCsiHandler({ prefix: '>', final: 'u' }, (params) => {
      if (!enabled()) return false;
      if (stack.length >= 32) stack.shift();
      stack.push(flags);
      setFlags(firstParam(params, flags));
      return true;
    }),
    terminal.parser.registerCsiHandler({ prefix: '=', final: 'u' }, (params) => {
      if (!enabled()) return false;
      setFlags(firstParam(params, flags));
      return true;
    }),
    terminal.parser.registerCsiHandler({ prefix: '<', final: 'u' }, (params) => {
      if (!enabled()) return false;
      const popCount = Math.max(1, firstParam(params, 1));
      for (let index = 0; index < popCount; index += 1) {
        const previous = stack.pop();
        if (previous === undefined) break;
        flags = previous;
      }
      return true;
    }),
    terminal.parser.registerCsiHandler({ prefix: '?', final: 'u' }, () => {
      if (!enabled()) return false;
      writeInput(`\x1b[?${flags}u`);
      return true;
    }),
  );

  return {
    handleKeyEvent: (event) => {
      if (!enabled() || flags === 0 || event.isComposing || event.key === 'Dead' || event.key === 'Process') {
        return true;
      }
      const reportEventTypes = Boolean(flags & 2);
      if (event.type === 'keyup' && !reportEventTypes) return true;
      if (event.type !== 'keydown' && event.type !== 'keyup') return true;
      const code = keyCode(event);
      if (!code) return true;
      const modifiers = modifierParameter(event);
      const special = kittyKeyCodes[event.key] !== undefined;
      const reportAllKeys = Boolean(flags & 8);
      const disambiguate = Boolean(flags & 1);
      if (!special && modifiers === 1 && !reportAllKeys) return true;
      if (!special && !disambiguate && !reportAllKeys) return true;
      const eventType = event.type === 'keyup' ? 3 : event.repeat ? 2 : 1;
      const eventSuffix = reportEventTypes ? `:${eventType}` : '';
      writeInput(`\x1b[${code};${modifiers}${eventSuffix}u`);
      return false;
    },
    dispose: () => {
      flags = 0;
      stack.length = 0;
      disposables.forEach((disposable) => disposable.dispose());
    },
  };
}
