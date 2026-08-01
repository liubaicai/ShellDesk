import { listRuntimeTerminalCommands } from './terminalCommandHistory';

export interface TerminalCompletionCandidate {
  value: string;
  label: string;
  detail: string;
  source: 'history' | 'snippet' | 'remote-path';
}

interface CachedDirectory {
  expiresAt: number;
  entries: ShellDeskRemoteFileEntry[];
}

const directoryCache = new Map<string, CachedDirectory>();
const directoryRequests = new Map<string, Promise<ShellDeskRemoteFileEntry[]>>();
const directoryCacheTtlMs = 5_000;
const maximumDirectoryCaches = 64;
const maximumCandidates = 12;
const pathCommands = new Set([
  'cd', 'ls', 'cat', 'less', 'more', 'tail', 'head', 'vim', 'vi', 'nano', 'code',
  'rm', 'cp', 'mv', 'mkdir', 'rmdir', 'chmod', 'chown', 'stat', 'du', 'find', 'tar',
]);

function fuzzyScore(candidate: string, query: string) {
  const normalizedCandidate = candidate.toLocaleLowerCase();
  const normalizedQuery = query.toLocaleLowerCase();
  if (normalizedCandidate.startsWith(normalizedQuery)) {
    return 10_000 - candidate.length;
  }
  let cursor = 0;
  let score = 0;
  for (const character of normalizedQuery) {
    const index = normalizedCandidate.indexOf(character, cursor);
    if (index < 0) {
      return -1;
    }
    score += Math.max(1, 100 - index);
    cursor = index + 1;
  }
  return score;
}

function shellEscapePath(path: string, windows: boolean) {
  if (windows) {
    return /[\s&|<>^()]/u.test(path) ? `"${path.replace(/"/gu, '""')}"` : path;
  }
  return /[\s'"\\$`!*?()[\]{};&|<>]/u.test(path)
    ? `'${path.replace(/'/gu, `'"'"'`)}'`
    : path;
}

function joinPath(parent: string, child: string, windows: boolean) {
  const separator = windows ? '\\' : '/';
  const normalizedParent = parent.replace(/[\\/]+$/u, '');
  return normalizedParent ? `${normalizedParent}${separator}${child}` : child;
}

function resolvePathRequest(input: string, workingDirectory: string, windows: boolean) {
  const match = input.match(/(?:^|\s)((?:["']?)[^\s"']*)$/u);
  if (!match) {
    return null;
  }
  const rawToken = match[1] ?? '';
  const token = rawToken.replace(/^["']/u, '');
  const command = input.trimStart().split(/\s+/u)[0]?.toLocaleLowerCase() ?? '';
  if (!token || (!pathCommands.has(command) && !/[\\/.~]/u.test(token))) {
    return null;
  }
  const separatorIndex = Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\'));
  const directoryToken = separatorIndex >= 0 ? token.slice(0, separatorIndex + 1) : '';
  const namePrefix = separatorIndex >= 0 ? token.slice(separatorIndex + 1) : token;
  const absolute = windows ? /^[a-z]:[\\/]/iu.test(token) : token.startsWith('/');
  const directory = absolute
    ? (directoryToken || token)
    : joinPath(workingDirectory || '.', directoryToken || '.', windows);
  return {
    startIndex: input.length - rawToken.length,
    token,
    directory,
    directoryToken,
    namePrefix,
  };
}

async function listRemoteDirectory(
  api: ShellDeskApi,
  connectionId: string,
  directory: string,
) {
  const key = `${connectionId}\u0000${directory}`;
  const cached = directoryCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.entries;
  }
  const pending = directoryRequests.get(key);
  if (pending) {
    return pending;
  }
  const request = api.connections.sftpListDirectory(connectionId, directory)
    .then((result) => {
      directoryCache.set(key, { entries: result.entries, expiresAt: Date.now() + directoryCacheTtlMs });
      while (directoryCache.size > maximumDirectoryCaches) {
        const oldestKey = directoryCache.keys().next().value;
        if (typeof oldestKey !== 'string') break;
        directoryCache.delete(oldestKey);
      }
      return result.entries;
    })
    .finally(() => directoryRequests.delete(key));
  directoryRequests.set(key, request);
  return request;
}

export function collectTerminalCompletionCandidates(
  scope: string,
  input: string,
  snippets: ShellDeskTerminalSnippet[] = [],
) {
  const query = input.trimStart();
  if (!query || query.length > 2_048) {
    return [];
  }
  const seen = new Set<string>();
  return [
    ...listRuntimeTerminalCommands(scope).map((value) => ({ value, label: value, detail: 'History', source: 'history' as const })),
    ...snippets.map((snippet) => ({ value: snippet.command, label: snippet.label, detail: snippet.group || 'Snippet', source: 'snippet' as const })),
  ]
    .map((candidate) => ({ candidate, score: fuzzyScore(candidate.value, query) }))
    .filter(({ candidate, score }) => score >= 0 && candidate.value !== query && !seen.has(candidate.value) && Boolean(seen.add(candidate.value)))
    .sort((left, right) => right.score - left.score)
    .slice(0, maximumCandidates)
    .map(({ candidate }) => candidate);
}

export async function collectRemotePathCompletionCandidates({
  api,
  connectionId,
  input,
  workingDirectory,
  windows,
}: {
  api: ShellDeskApi;
  connectionId: string;
  input: string;
  workingDirectory: string;
  windows: boolean;
}): Promise<TerminalCompletionCandidate[]> {
  const request = resolvePathRequest(input, workingDirectory, windows);
  if (!request) {
    return [];
  }
  const entries = await listRemoteDirectory(api, connectionId, request.directory);
  const normalizedPrefix = request.namePrefix.toLocaleLowerCase();
  return entries
    .filter((entry) => entry.name !== '.' && entry.name !== '..' && entry.name.toLocaleLowerCase().startsWith(normalizedPrefix))
    .sort((left, right) => {
      if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
      return left.name.localeCompare(right.name);
    })
    .slice(0, maximumCandidates)
    .map((entry) => {
      const suffix = entry.type === 'directory' ? (windows ? '\\' : '/') : '';
      const completedToken = `${request.directoryToken}${entry.name}${suffix}`;
      const escaped = shellEscapePath(completedToken, windows);
      return {
        value: `${input.slice(0, request.startIndex)}${escaped}`,
        label: `${entry.name}${suffix}`,
        detail: entry.type === 'directory' ? 'Remote directory' : 'Remote file',
        source: 'remote-path' as const,
      };
    });
}

export function clearTerminalCompletionCaches() {
  directoryCache.clear();
  directoryRequests.clear();
}
