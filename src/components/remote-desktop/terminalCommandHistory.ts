const maximumRuntimeHistoryEntries = 200;
const maximumRuntimeHistoryScopes = 32;
const maximumRuntimeCommandLength = 2048;
const runtimeCommandHistories = new Map<string, string[]>();
const sensitiveCommandPattern = /(?:^|\s)(?:sshpass|(?:password|passwd|passphrase|secret|token|api[_-]?key|authorization)\s*[:=]|--(?:password|passphrase|secret|token|api-key)(?:=|\s)|(?:-u|--user)\s+\S+:\S+|[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@)/iu;

function normalizeRuntimeCommand(command: string) {
  const normalized = command.trim();
  if (
    !normalized
    || normalized.length > maximumRuntimeCommandLength
    || normalized.includes('\r')
    || normalized.includes('\n')
    || sensitiveCommandPattern.test(normalized)
  ) {
    return '';
  }
  return normalized;
}

function getRuntimeHistory(scope: string, create: boolean) {
  const normalizedScope = scope.trim().slice(0, 256);
  if (!normalizedScope) {
    return null;
  }
  const existing = runtimeCommandHistories.get(normalizedScope);
  if (existing || !create) {
    return existing ?? null;
  }
  const history: string[] = [];
  runtimeCommandHistories.set(normalizedScope, history);
  while (runtimeCommandHistories.size > maximumRuntimeHistoryScopes) {
    const oldestScope = runtimeCommandHistories.keys().next().value;
    if (typeof oldestScope !== 'string') {
      break;
    }
    runtimeCommandHistories.delete(oldestScope);
  }
  return history;
}

export function rememberRuntimeTerminalCommand(scope: string, command: string) {
  const normalized = normalizeRuntimeCommand(command);
  if (!normalized) {
    return;
  }
  const runtimeCommandHistory = getRuntimeHistory(scope, true);
  if (!runtimeCommandHistory) {
    return;
  }
  const existingIndex = runtimeCommandHistory.indexOf(normalized);
  if (existingIndex >= 0) {
    runtimeCommandHistory.splice(existingIndex, 1);
  }
  runtimeCommandHistory.unshift(normalized);
  runtimeCommandHistory.splice(maximumRuntimeHistoryEntries);
}

export function suggestRuntimeTerminalCommand(
  scope: string,
  input: string,
  snippets: ShellDeskTerminalSnippet[] = [],
) {
  const prefix = input.trimStart();
  if (!prefix || prefix.length > maximumRuntimeCommandLength) {
    return '';
  }
  const normalizedPrefix = prefix.toLocaleLowerCase();
  const candidates = [
    ...(getRuntimeHistory(scope, false) ?? []),
    ...snippets.map((snippet) => normalizeRuntimeCommand(snippet.command)).filter(Boolean),
  ];
  return candidates.find((candidate) => (
    candidate.length > prefix.length
    && candidate.toLocaleLowerCase().startsWith(normalizedPrefix)
  )) ?? '';
}

export function listRuntimeTerminalCommands(scope: string) {
  return [...(getRuntimeHistory(scope, false) ?? [])];
}

export function clearRuntimeTerminalCommandHistory(scope?: string) {
  if (scope) {
    runtimeCommandHistories.delete(scope.trim().slice(0, 256));
    return;
  }
  runtimeCommandHistories.clear();
}
