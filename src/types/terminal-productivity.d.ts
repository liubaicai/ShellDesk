export {};

declare global {
  interface ShellDeskTerminalHighlightRule {
    id: string;
    label: string;
    pattern: string;
    mode: 'literal' | 'regex';
    foreground: string;
    background: string;
    enabled: boolean;
    builtin?: boolean;
  }

  interface ShellDeskAppSettings {
    terminalHighlightRules: ShellDeskTerminalHighlightRule[];
    terminalSftpFollowCwd: boolean;
    terminalContextMenuInAlternateScreen: boolean;
  }
}
