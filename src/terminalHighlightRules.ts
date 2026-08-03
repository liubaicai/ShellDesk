export const defaultTerminalHighlightRules: ShellDeskTerminalHighlightRule[] = [
  {
    id: 'builtin:error',
    label: 'Error',
    pattern: 'error|failed|failure|denied|exception|fatal',
    mode: 'regex',
    foreground: '#fff1f2',
    background: '#7f1d1d',
    enabled: true,
    builtin: true,
  },
  {
    id: 'builtin:warning',
    label: 'Warning',
    pattern: 'warning|warn|deprecated|timeout',
    mode: 'regex',
    foreground: '#fff7d6',
    background: '#713f12',
    enabled: true,
    builtin: true,
  },
  {
    id: 'builtin:success',
    label: 'Success',
    pattern: 'success|succeeded|passed|completed|healthy',
    mode: 'regex',
    foreground: '#ecfdf5',
    background: '#14532d',
    enabled: true,
    builtin: true,
  },
];

export function cloneDefaultTerminalHighlightRules() {
  return defaultTerminalHighlightRules.map((rule) => ({ ...rule }));
}

const unsafeRegularExpressionPattern = /(?:\\[1-9]|\\k<|\(\?<(?=[=!])|\((?:[^()]|\\.)*[+*{](?:[^()]|\\.)*\)\s*(?:[+*]|\{)|(?:\.\*|\.\+).*(?:\.\*|\.\+))/u;

export function isSafeTerminalHighlightPattern(
  pattern: string,
  mode: ShellDeskTerminalHighlightRule['mode'],
) {
  const normalized = pattern.trim();
  if (!normalized || normalized.length > 512) return false;
  if (mode === 'literal') return true;
  if (unsafeRegularExpressionPattern.test(normalized)) return false;
  try {
    new RegExp(normalized, 'giu');
    return true;
  } catch {
    return false;
  }
}
