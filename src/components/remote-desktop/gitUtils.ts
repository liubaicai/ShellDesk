import { powershellSingleQuote, powershellStdinCommand, type RemoteCommandInput } from './remoteSystem';

export type GitFileStatusKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'conflicted' | 'typechange' | 'unknown';

export interface GitFileChange {
  path: string;
  originalPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  kind: GitFileStatusKind;
}

export interface GitCommitSummary {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
}

export interface GitBranchSummary {
  name: string;
  current: boolean;
}

export interface GitRepositorySnapshot {
  inputPath: string;
  rootPath: string;
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  clean: boolean;
  files: GitFileChange[];
  branches: GitBranchSummary[];
  commits: GitCommitSummary[];
  remotes: string[];
  rawStatus: string;
  rawOutput: string;
}

export type GitAction = 'fetch' | 'pull' | 'push' | 'checkout';
export type GitStageMode = 'stage' | 'unstage';

const sectionNames = ['root', 'status', 'branches', 'log', 'remotes', 'error'] as const;
type GitSectionName = (typeof sectionNames)[number];

function shellSingleQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function validateText(value: string, label: string, maxLength = 520) {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    throw new Error(`请输入${label}。`);
  }

  if (trimmedValue.length > maxLength || /[\u0000\r\n]/.test(trimmedValue)) {
    throw new Error(`${label}无效。`);
  }

  return trimmedValue;
}

function validateGitCommitMessage(value: string) {
  const normalizedValue = value.replace(/\r\n?/g, '\n').trim();

  if (!normalizedValue) {
    throw new Error('请输入提交信息。');
  }

  if (normalizedValue.length > 2000 || normalizedValue.includes('\u0000')) {
    throw new Error('提交信息无效。');
  }

  return normalizedValue;
}

export function validateGitPath(value: string) {
  return validateText(value, '仓库路径');
}

function validateGitFilePath(value: string) {
  return validateText(value, '文件路径', 800);
}

export function validateGitBranchName(value: string) {
  const trimmedValue = validateText(value, '分支名', 220);

  if (
    trimmedValue.startsWith('-')
    || trimmedValue.includes('..')
    || trimmedValue.includes('@{')
    || /[\s~^:?*[\\\u0000]/.test(trimmedValue)
  ) {
    throw new Error('分支名包含不安全字符。');
  }

  return trimmedValue;
}

function createPosixGitSnapshotCommand(path: string) {
  const repoPath = shellSingleQuote(validateGitPath(path));

  return `
repo=${repoPath}
section() { printf '\\n__SHELLDESK_GIT_%s__\\n' "$1"; }
if ! git -C "$repo" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  section ERROR
  git -C "$repo" rev-parse --is-inside-work-tree 2>&1 || true
  exit 2
fi
root=$(git -C "$repo" rev-parse --show-toplevel 2>/dev/null)
section ROOT
printf '%s\\n' "$root"
section STATUS
git -C "$root" status --porcelain=v1 -b 2>&1
section BRANCHES
git -C "$root" branch --format='%(HEAD)%(refname:short)' 2>&1
section LOG
git -C "$root" log --date=iso-strict --pretty=format:'%H%x09%an%x09%ad%x09%s' -n 50 2>&1 || true
printf '\\n'
section REMOTES
git -C "$root" remote -v 2>&1 || true
`.trim();
}

function createWindowsGitSnapshotCommand(path: string): RemoteCommandInput {
  const repoPath = validateGitPath(path);

  return powershellStdinCommand(`
$Repo = ${powershellSingleQuote(repoPath)}
function Write-Section([string]$Name) { [Console]::Out.WriteLine(""); [Console]::Out.WriteLine("__SHELLDESK_GIT_$($Name)__") }
& git -C $Repo rev-parse --is-inside-work-tree *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Section "ERROR"
  & git -C $Repo rev-parse --is-inside-work-tree 2>&1 | Out-String -Width 240
  exit 2
}
$Root = (& git -C $Repo rev-parse --show-toplevel 2>$null | Select-Object -First 1)
Write-Section "ROOT"
[Console]::Out.WriteLine($Root)
Write-Section "STATUS"
& git -C $Root status --porcelain=v1 -b 2>&1 | Out-String -Width 240
Write-Section "BRANCHES"
& git -C $Root branch --format='%(HEAD)%(refname:short)' 2>&1 | Out-String -Width 240
Write-Section "LOG"
& git -C $Root log --date=iso-strict --pretty=format:'%H%x09%an%x09%ad%x09%s' -n 50 2>&1 | Out-String -Width 240
Write-Section "REMOTES"
& git -C $Root remote -v 2>&1 | Out-String -Width 240
`);
}

export function createGitSnapshotCommand(path: string, isWindowsHost: boolean): RemoteCommandInput {
  if (isWindowsHost) {
    return createWindowsGitSnapshotCommand(path);
  }

  return { command: createPosixGitSnapshotCommand(path) };
}

export function createGitDiffCommand(path: string, filePath: string, staged: boolean, isWindowsHost: boolean): RemoteCommandInput {
  const repoPath = validateGitPath(path);
  const targetFile = validateGitFilePath(filePath);

  if (isWindowsHost) {
    return powershellStdinCommand(`
$Repo = ${powershellSingleQuote(repoPath)}
$File = ${powershellSingleQuote(targetFile)}
if (${staged ? '$true' : '$false'}) {
  & git -C $Repo diff --cached -- $File
} else {
  & git -C $Repo diff -- $File
}
exit $LASTEXITCODE
`);
  }

  const diffMode = staged ? '--cached ' : '';
  return {
    command: `git -C ${shellSingleQuote(repoPath)} diff ${diffMode}-- ${shellSingleQuote(targetFile)}`,
  };
}

export function createGitActionCommand(path: string, action: GitAction, branch: string, isWindowsHost: boolean): RemoteCommandInput {
  const repoPath = validateGitPath(path);
  const safeBranch = action === 'checkout' ? validateGitBranchName(branch) : '';

  if (isWindowsHost) {
    if (action === 'checkout') {
      return powershellStdinCommand(`& git -C ${powershellSingleQuote(repoPath)} checkout ${powershellSingleQuote(safeBranch)}; exit $LASTEXITCODE`);
    }

    const command = action === 'fetch' ? 'fetch --prune' : action === 'push' ? 'push' : 'pull --ff-only';
    return powershellStdinCommand(`& git -C ${powershellSingleQuote(repoPath)} ${command}; exit $LASTEXITCODE`);
  }

  if (action === 'checkout') {
    return { command: `git -C ${shellSingleQuote(repoPath)} checkout ${shellSingleQuote(safeBranch)}` };
  }

  return {
    command: action === 'fetch'
      ? `git -C ${shellSingleQuote(repoPath)} fetch --prune`
      : action === 'push'
        ? `git -C ${shellSingleQuote(repoPath)} push`
      : `git -C ${shellSingleQuote(repoPath)} pull --ff-only`,
  };
}

export function createGitStageCommand(path: string, filePath: string, mode: GitStageMode, isWindowsHost: boolean): RemoteCommandInput {
  const repoPath = validateGitPath(path);
  const targetFile = validateGitFilePath(filePath);

  if (isWindowsHost) {
    return powershellStdinCommand(`
$Repo = ${powershellSingleQuote(repoPath)}
$File = ${powershellSingleQuote(targetFile)}
${mode === 'stage'
    ? '& git -C $Repo add -- $File'
    : `& git -C $Repo reset -- $File 2>$null
if ($LASTEXITCODE -ne 0) {
  & git -C $Repo rm -r --cached -- $File
}`}
exit $LASTEXITCODE
`);
  }

  if (mode === 'stage') {
    return { command: `git -C ${shellSingleQuote(repoPath)} add -- ${shellSingleQuote(targetFile)}` };
  }

  return {
    command: `git -C ${shellSingleQuote(repoPath)} reset -- ${shellSingleQuote(targetFile)} 2>/dev/null || git -C ${shellSingleQuote(repoPath)} rm -r --cached -- ${shellSingleQuote(targetFile)}`,
  };
}

export function createGitStageAllCommand(path: string, mode: GitStageMode, isWindowsHost: boolean): RemoteCommandInput {
  const repoPath = validateGitPath(path);

  if (isWindowsHost) {
    return powershellStdinCommand(`
$Repo = ${powershellSingleQuote(repoPath)}
${mode === 'stage'
    ? '& git -C $Repo add -A'
    : `& git -C $Repo reset -- . 2>$null
if ($LASTEXITCODE -ne 0) {
  & git -C $Repo rm -r --cached -- .
}`}
exit $LASTEXITCODE
`);
  }

  if (mode === 'stage') {
    return { command: `git -C ${shellSingleQuote(repoPath)} add -A` };
  }

  return {
    command: `git -C ${shellSingleQuote(repoPath)} reset -- . 2>/dev/null || git -C ${shellSingleQuote(repoPath)} rm -r --cached -- .`,
  };
}

export function createGitCommitCommand(path: string, message: string, isWindowsHost: boolean): RemoteCommandInput {
  const repoPath = validateGitPath(path);
  const commitMessage = validateGitCommitMessage(message);

  if (isWindowsHost) {
    return powershellStdinCommand(`
$Repo = ${powershellSingleQuote(repoPath)}
$Message = ${powershellSingleQuote(commitMessage)}
$TempMessageFile = [System.IO.Path]::GetTempFileName()
try {
  $Utf8NoBom = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($TempMessageFile, $Message, $Utf8NoBom)
  & git -C $Repo commit -F $TempMessageFile
  exit $LASTEXITCODE
} finally {
  Remove-Item -LiteralPath $TempMessageFile -Force -ErrorAction SilentlyContinue
}
`);
  }

  return {
    command: `git -C ${shellSingleQuote(repoPath)} commit -F -`,
    stdin: `${commitMessage}\n`,
  };
}

function splitSections(output: string) {
  const sections: Partial<Record<GitSectionName, string[]>> = {};
  let activeSection: GitSectionName | null = null;

  output.split(/\r?\n/).forEach((line) => {
    const marker = line.match(/^__SHELLDESK_GIT_(ROOT|STATUS|BRANCHES|LOG|REMOTES|ERROR)__$/);

    if (marker) {
      const sectionName = marker[1].toLowerCase() as GitSectionName;
      activeSection = sectionNames.includes(sectionName) ? sectionName : null;
      if (activeSection) sections[activeSection] = [];
      return;
    }

    if (activeSection) {
      sections[activeSection]?.push(line);
    }
  });

  return sections;
}

function parseStatusHeader(line: string) {
  const value = line.replace(/^##\s*/, '').trim();
  const aheadMatch = value.match(/ahead\s+(\d+)/i);
  const behindMatch = value.match(/behind\s+(\d+)/i);
  const upstreamMatch = value.match(/\.\.\.([^\s[]+)/);
  let branch = value
    .replace(/\s*\[.*]$/, '')
    .replace(/\.\.\..*$/, '')
    .replace(/^No commits yet on\s+/, '')
    .trim();

  if (!branch || /^HEAD/i.test(branch)) {
    branch = 'DETACHED';
  }

  return {
    branch,
    upstream: upstreamMatch?.[1],
    ahead: aheadMatch ? Number.parseInt(aheadMatch[1], 10) : 0,
    behind: behindMatch ? Number.parseInt(behindMatch[1], 10) : 0,
  };
}

function getStatusKind(indexStatus: string, worktreeStatus: string): GitFileStatusKind {
  const status = `${indexStatus}${worktreeStatus}`;

  if (status.includes('U') || status.includes('A') && status.includes('D') || status.includes('D') && status.includes('A')) return 'conflicted';
  if (status.includes('?')) return 'untracked';
  if (status.includes('R')) return 'renamed';
  if (status.includes('C')) return 'copied';
  if (status.includes('A')) return 'added';
  if (status.includes('D')) return 'deleted';
  if (status.includes('T')) return 'typechange';
  if (status.includes('M')) return 'modified';
  return 'unknown';
}

function parseFileChange(line: string): GitFileChange | null {
  if (!line || line.startsWith('##')) return null;

  const indexStatus = line[0] ?? ' ';
  const worktreeStatus = line[1] ?? ' ';
  const rawPath = line.slice(3).trim();

  if (!rawPath) return null;

  const renameParts = rawPath.split(' -> ');
  const path = renameParts.at(-1) ?? rawPath;
  const originalPath = renameParts.length > 1 ? renameParts[0] : undefined;

  return {
    path,
    originalPath,
    indexStatus,
    worktreeStatus,
    kind: getStatusKind(indexStatus, worktreeStatus),
  };
}

function parseBranches(lines: string[], currentBranch: string): GitBranchSummary[] {
  const branches = lines
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^fatal:/i.test(line))
    .map((line) => {
      const current = line.startsWith('*');
      const name = line.replace(/^\*\s*/, '').trim();
      return { name, current: current || name === currentBranch };
    })
    .filter((branch) => branch.name && !branch.name.includes('->'));

  if (!branches.some((branch) => branch.current) && currentBranch !== 'DETACHED') {
    branches.unshift({ name: currentBranch, current: true });
  }

  return branches;
}

function parseCommits(lines: string[]): GitCommitSummary[] {
  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^fatal:/i.test(line))
    .map((line) => {
      const [hash = '', author = '', date = '', ...subjectParts] = line.split('\t');
      const subject = subjectParts.join('\t');

      return {
        hash,
        shortHash: hash.slice(0, 8),
        author,
        date,
        subject,
      };
    })
    .filter((commit) => commit.hash && commit.subject);
}

export function parseGitSnapshotOutput(inputPath: string, stdout: string, stderr: string): GitRepositorySnapshot {
  const rawOutput = [stdout, stderr].filter(Boolean).join('\n');
  const sections = splitSections(rawOutput);
  const errorText = sections.error?.join('\n').trim();

  if (errorText) {
    throw new Error(errorText || '当前路径不是 Git 仓库。');
  }

  const statusLines = sections.status ?? [];
  const header = parseStatusHeader(statusLines.find((line) => line.startsWith('##')) ?? '## DETACHED');
  const files = statusLines.map(parseFileChange).filter((file): file is GitFileChange => Boolean(file));
  const rootPath = sections.root?.find((line) => line.trim())?.trim() || validateGitPath(inputPath);
  const branches = parseBranches(sections.branches ?? [], header.branch);
  const commits = parseCommits(sections.log ?? []);
  const remotes = Array.from(new Set((sections.remotes ?? []).map((line) => line.trim()).filter(Boolean)));

  return {
    inputPath,
    rootPath,
    branch: header.branch,
    upstream: header.upstream,
    ahead: header.ahead,
    behind: header.behind,
    clean: files.length === 0,
    files,
    branches,
    commits,
    remotes,
    rawStatus: statusLines.join('\n'),
    rawOutput,
  };
}

export function getGitStatusLabel(change: GitFileChange) {
  const labels: Record<GitFileStatusKind, string> = {
    modified: '修改',
    added: '新增',
    deleted: '删除',
    renamed: '重命名',
    copied: '复制',
    untracked: '未跟踪',
    conflicted: '冲突',
    typechange: '类型变更',
    unknown: '变更',
  };

  return labels[change.kind];
}
