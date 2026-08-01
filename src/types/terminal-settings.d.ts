export {};

declare global {
  interface ShellDeskAppSettings {
    terminalTermType: 'xterm-256color' | 'xterm-16color' | 'xterm';
    terminalDrawBoldInBrightColors: boolean;
    terminalCursorLineHighlight: boolean;
    terminalSmoothScrolling: boolean;
    terminalScrollOnOutput: boolean;
    terminalWordSeparators: string;
    terminalLinkModifier: 'none' | 'ctrl' | 'alt' | 'meta';
    terminalOptionArrowWordJump: boolean;
    terminalShiftEnterNewlineEnabled: boolean;
    terminalShiftEnterNewlineText: string;
    terminalMiddleClickBehavior: 'context-menu' | 'paste' | 'disabled';
    terminalNormalizeCopiedText: boolean;
    terminalDynamicTitle: 'off' | 'tmux' | 'all';
    terminalOsc52Mode: 'off' | 'write-only' | 'prompt' | 'read-write';
    terminalClearWipesScrollback: boolean;
  }
}
