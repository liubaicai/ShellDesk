import type { Terminal as XTerminal } from '@xterm/xterm';

const SYNC_START = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';
const CLEAR_SCREEN = '\x1b[2J';
const CLEAR_SCROLLBACK = '\x1b[3J';
const CURSOR_HOME = '\x1b[H';
const CURSOR_HOME_EXPLICIT = '\x1b[1;1H';
const MARKERS = [SYNC_START, SYNC_END, CLEAR_SCREEN, CLEAR_SCROLLBACK, CURSOR_HOME, CURSOR_HOME_EXPLICIT];
const SYNC_TIMEOUT_MS = 1_000;

function splitPendingMarkerSuffix(input: string) {
  const maxLength = Math.min(input.length, Math.max(...MARKERS.map((marker) => marker.length)) - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    const suffix = input.slice(-length);
    if (MARKERS.some((marker) => marker.startsWith(suffix) && marker.length > suffix.length)) {
      return { emit: input.slice(0, -length), pending: suffix };
    }
  }
  return { emit: input, pending: '' };
}

export class TerminalOutputProtocolFilter {
  private pending = '';
  private inSyncBlock = false;
  private syncStartedAt = 0;
  private pendingCursorHome = '';
  private fullRedrawBlock = false;

  constructor(
    private readonly terminal: XTerminal,
    private readonly clearWipesScrollback: () => boolean,
  ) {}

  filter(data: string) {
    let prefix = '';
    if (this.inSyncBlock && Date.now() - this.syncStartedAt > SYNC_TIMEOUT_MS) {
      prefix = this.pendingCursorHome;
      this.resetSyncBlock();
    }
    if (!this.pending && !this.inSyncBlock && !data.includes('\x1b')) return data;
    const { emit, pending } = splitPendingMarkerSuffix(`${this.pending}${data}`);
    this.pending = pending;
    if (!emit) return prefix;
    let output = prefix;
    let index = 0;
    while (index < emit.length) {
      if (emit.startsWith(SYNC_START, index)) {
        output += this.releaseCursorHome();
        this.inSyncBlock = true;
        this.syncStartedAt = Date.now();
        this.fullRedrawBlock = false;
        output += SYNC_START;
        index += SYNC_START.length;
        continue;
      }
      if (emit.startsWith(SYNC_END, index)) {
        output += this.releaseCursorHome();
        this.resetSyncBlock();
        output += SYNC_END;
        index += SYNC_END.length;
        continue;
      }
      if (!this.clearWipesScrollback() && emit.startsWith(CLEAR_SCROLLBACK, index)) {
        index += CLEAR_SCROLLBACK.length;
        continue;
      }
      if (this.inSyncBlock) {
        const home = emit.startsWith(CURSOR_HOME_EXPLICIT, index)
          ? CURSOR_HOME_EXPLICIT
          : emit.startsWith(CURSOR_HOME, index) ? CURSOR_HOME : '';
        if (home) {
          if (this.isReadingScrollback()) this.pendingCursorHome = home;
          else output += home;
          index += home.length;
          continue;
        }
        if (emit.startsWith(CLEAR_SCREEN, index)) {
          if (this.pendingCursorHome) {
            output += this.releaseCursorHome();
            if (this.isReadingScrollback()) this.fullRedrawBlock = true;
            else output += CLEAR_SCREEN;
          } else if (!this.fullRedrawBlock || !this.isReadingScrollback()) {
            output += CLEAR_SCREEN;
          }
          index += CLEAR_SCREEN.length;
          continue;
        }
      }
      output += this.releaseCursorHome();
      const nextEscape = emit.indexOf('\x1b', index + 1);
      const end = nextEscape === -1 ? emit.length : nextEscape;
      output += emit.slice(index, end);
      index = end;
    }
    return output;
  }

  flush() {
    const output = `${this.pendingCursorHome}${this.pending}`;
    this.pending = '';
    this.resetSyncBlock();
    return output;
  }

  private isReadingScrollback() {
    const buffer = this.terminal.buffer.active;
    return buffer.type === 'normal' && buffer.baseY - buffer.viewportY >= 2;
  }

  private releaseCursorHome() {
    const value = this.pendingCursorHome;
    this.pendingCursorHome = '';
    return value;
  }

  private resetSyncBlock() {
    this.inSyncBlock = false;
    this.syncStartedAt = 0;
    this.pendingCursorHome = '';
    this.fullRedrawBlock = false;
  }
}
