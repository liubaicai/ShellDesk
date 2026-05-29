import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import {
  createGitActionCommand,
  createGitBranchActionCommand,
  createGitCommitCommand,
  createGitDiffCommand,
  createGitSnapshotCommand,
  createGitStageAllCommand,
  createGitStageCommand,
  getGitStatusLabel,
  parseGitSnapshotOutput,
  type GitAction,
  type GitBranchAction,
  type GitBranchSummary,
  type GitCommitSummary,
  type GitFileChange,
  type GitRepositorySnapshot,
  type GitStageMode,
} from './gitUtils';
import { isWindowsSystem, type RemoteCommandInput } from './remoteSystem';
import RemoteFilePicker from './RemoteFilePicker';
import type { RemoteSystemType } from './types';

interface RemoteGitManagerProps {
  connectionId: string;
  systemType?: RemoteSystemType;
}

type GitTab = 'changes' | 'commits' | 'diff' | 'raw';
type DiffMode = 'worktree' | 'staged';
type PendingGitActionKind = GitAction | 'commit' | 'branchCreate' | 'branchDelete' | 'branchCheckoutRemote';

interface PendingGitAction {
  action: PendingGitActionKind;
  label: string;
  command: RemoteCommandInput;
  branch?: string;
  message?: string;
  danger?: boolean;
}

const rememberedGitRepositoryPaths = new Map<string, string>();

function runCmd(connectionId: string, input: RemoteCommandInput) {
  const api = window.guiSSH?.connections;

  if (!api) {
    throw new Error('ShellDesk IPC 未就绪。');
  }

  return api.runCommand(connectionId, input.command, input.stdin);
}

function formatDate(value: string) {
  const timestamp = Date.parse(value);

  if (Number.isNaN(timestamp)) {
    return value || '-';
  }

  return new Date(timestamp).toLocaleString(getShellDeskLocale());
}

function getChangeKey(change: GitFileChange) {
  return `${change.indexStatus}${change.worktreeStatus}:${change.path}`;
}

function getChangeTone(change: GitFileChange) {
  if (change.kind === 'conflicted') return 'danger';
  if (change.kind === 'added' || change.kind === 'untracked') return 'success';
  if (change.kind === 'deleted') return 'warning';
  return 'info';
}

function hasStagedChange(change: GitFileChange) {
  return Boolean(change.indexStatus.trim()) && change.indexStatus !== '?';
}

function hasUnstagedChange(change: GitFileChange) {
  return Boolean(change.worktreeStatus.trim()) || change.indexStatus === '?' || change.worktreeStatus === '?';
}

function groupBranches(branches: GitBranchSummary[]) {
  const groups = new Map<string, GitBranchSummary[]>();

  branches.forEach((branch) => {
    const [groupName = '其他'] = branch.name.split('/');
    const key = branch.name.includes('/') ? groupName : '本地';
    groups.set(key, [...(groups.get(key) ?? []), branch]);
  });

  return Array.from(groups, ([name, items]) => ({ name, items }));
}

function getBranchLeafName(name: string) {
  const parts = name.split('/');
  return parts.at(-1) ?? name;
}

function getRemoteName(name: string) {
  return name.split('/')[0] ?? 'origin';
}

function getRemoteBranchLabel(name: string) {
  const [, ...parts] = name.split('/');
  return parts.join('/') || name;
}

function RemoteGitManager({ connectionId, systemType }: RemoteGitManagerProps) {
  const isWindowsHost = isWindowsSystem(systemType);
  const commitMessageRef = useRef<HTMLTextAreaElement | null>(null);
  const branchNameInputRef = useRef<HTMLInputElement | null>(null);
  const [repoPath, setRepoPath] = useState(() => rememberedGitRepositoryPaths.get(connectionId) ?? '');
  const [snapshot, setSnapshot] = useState<GitRepositorySnapshot | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState('');
  const [selectedBranch, setSelectedBranch] = useState('');
  const [selectedRemoteBranch, setSelectedRemoteBranch] = useState('');
  const [selectedCommitHash, setSelectedCommitHash] = useState('');
  const [activeTab, setActiveTab] = useState<GitTab>('changes');
  const [diffMode, setDiffMode] = useState<DiffMode>('worktree');
  const [diffText, setDiffText] = useState('');
  const [commitMessage, setCommitMessage] = useState('');
  const [newBranchName, setNewBranchName] = useState('');
  const [commitSearch, setCommitSearch] = useState('');
  const [commandOutput, setCommandOutput] = useState('');
  const [loading, setLoading] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [actionRunning, setActionRunning] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [lastRefreshedAt, setLastRefreshedAt] = useState('');
  const [pendingAction, setPendingAction] = useState<PendingGitAction | null>(null);
  const [filePickerVisible, setFilePickerVisible] = useState(false);

  const selectedFile = useMemo(() => {
    return snapshot?.files.find((file) => file.path === selectedFilePath) ?? snapshot?.files[0] ?? null;
  }, [selectedFilePath, snapshot?.files]);

  const changedCount = snapshot?.files.length ?? 0;
  const stagedCount = snapshot?.files.filter(hasStagedChange).length ?? 0;
  const unstagedCount = snapshot?.files.filter(hasUnstagedChange).length ?? 0;
  const conflictedCount = snapshot?.files.filter((file) => file.kind === 'conflicted').length ?? 0;
  const selectedFileCanStage = selectedFile ? hasUnstagedChange(selectedFile) : false;
  const selectedFileCanUnstage = selectedFile ? hasStagedChange(selectedFile) : false;
  const localBranches = useMemo(() => snapshot?.branches.filter((branch) => branch.kind === 'local' && branch.name !== 'DETACHED') ?? [], [snapshot?.branches]);
  const remoteBranches = useMemo(() => snapshot?.branches.filter((branch) => branch.kind === 'remote' && !/\/HEAD$/i.test(branch.name)) ?? [], [snapshot?.branches]);
  const localBranchGroups = useMemo(() => groupBranches(localBranches), [localBranches]);
  const remoteBranchGroups = useMemo(() => {
    const groups = new Map<string, GitBranchSummary[]>();

    remoteBranches.forEach((branch) => {
      const remoteName = getRemoteName(branch.name);
      groups.set(remoteName, [...(groups.get(remoteName) ?? []), branch]);
    });

    return Array.from(groups, ([name, items]) => ({ name, items }));
  }, [remoteBranches]);
  const selectedLocalBranch = localBranches.find((branch) => branch.name === selectedBranch) ?? null;
  const selectedRemoteBranchItem = remoteBranches.find((branch) => branch.name === selectedRemoteBranch) ?? null;
  const filteredCommits = useMemo(() => {
    const query = commitSearch.trim().toLowerCase();
    const commits = snapshot?.commits ?? [];

    if (!query) return commits;

    return commits.filter((commit) => (
      commit.subject.toLowerCase().includes(query)
      || commit.author.toLowerCase().includes(query)
      || commit.hash.toLowerCase().includes(query)
      || commit.shortHash.toLowerCase().includes(query)
    ));
  }, [commitSearch, snapshot?.commits]);
  const selectedCommit = useMemo<GitCommitSummary | null>(() => {
    return filteredCommits.find((commit) => commit.hash === selectedCommitHash) ?? filteredCommits[0] ?? null;
  }, [filteredCommits, selectedCommitHash]);

  const loadRepository = useCallback(async (path: string) => {
    setLoading(true);
    setError('');
    setNotice('');

    try {
      const command = createGitSnapshotCommand(path, isWindowsHost);
      const result = await runCmd(connectionId, command);
      const nextSnapshot = parseGitSnapshotOutput(path, result.stdout, result.stderr);

      setSnapshot(nextSnapshot);
      setRepoPath(nextSnapshot.rootPath);
      rememberedGitRepositoryPaths.set(connectionId, nextSnapshot.rootPath);
      setSelectedBranch((current) => (
        current && nextSnapshot.branches.some((branch) => branch.name === current)
          ? current
          : nextSnapshot.branch === 'DETACHED'
            ? nextSnapshot.branches[0]?.name ?? ''
            : nextSnapshot.branch
      ));
      setSelectedFilePath((current) => (
        current && nextSnapshot.files.some((file) => file.path === current)
          ? current
          : nextSnapshot.files[0]?.path ?? ''
      ));
      setSelectedRemoteBranch((current) => (
        current && nextSnapshot.branches.some((branch) => branch.kind === 'remote' && branch.name === current)
          ? current
          : nextSnapshot.branches.find((branch) => branch.kind === 'remote')?.name ?? ''
      ));
      setSelectedCommitHash((current) => (
        current && nextSnapshot.commits.some((commit) => commit.hash === current)
          ? current
          : nextSnapshot.commits[0]?.hash ?? ''
      ));
      setCommandOutput(nextSnapshot.rawOutput);
      setLastRefreshedAt(new Date().toLocaleTimeString(getShellDeskLocale()));
      setNotice(nextSnapshot.clean ? '工作区干净。' : `读取到 ${nextSnapshot.files.length} 个变更文件。`);
    } catch (error) {
      setSnapshot(null);
      setSelectedFilePath('');
      setCommandOutput('');
      setError(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [connectionId, isWindowsHost]);

  useEffect(() => {
    const rememberedPath = rememberedGitRepositoryPaths.get(connectionId);

    if (!rememberedPath) {
      setRepoPath('');
      setSnapshot(null);
      setSelectedFilePath('');
      setSelectedBranch('');
      setSelectedRemoteBranch('');
      setSelectedCommitHash('');
      setCommandOutput('');
      setDiffText('');
      setNotice('');
      setError('');
      return;
    }

    setRepoPath(rememberedPath);
    void loadRepository(rememberedPath);
  }, [connectionId, isWindowsHost, loadRepository]);

  const loadDiff = async (file = selectedFile, mode = diffMode) => {
    if (!snapshot || !file) {
      setDiffText('请选择变更文件。');
      setActiveTab('diff');
      return;
    }

    setDiffLoading(true);
    setError('');
    setNotice('');

    try {
      const command = createGitDiffCommand(snapshot.rootPath, file.path, mode === 'staged', isWindowsHost);
      const result = await runCmd(connectionId, command);
      setDiffText(result.stdout || result.stderr || '该文件在当前 diff 模式下没有差异。');
      setActiveTab('diff');
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setDiffLoading(false);
    }
  };

  const executeGitCommand = async (label: string, command: RemoteCommandInput) => {
    setActionRunning(true);
    setError('');
    setNotice('');

    try {
      const result = await runCmd(connectionId, command);
      const output = result.stdout || result.stderr || `${label} 已执行。`;

      if (result.code !== 0) {
        throw new Error(output);
      }

      await loadRepository(snapshot?.rootPath ?? repoPath);
      setCommandOutput(output);
      setNotice(output);
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setActionRunning(false);
    }
  };

  const executeStageAction = async (mode: GitStageMode, file?: GitFileChange | null) => {
    if (!snapshot) return;

    try {
      const command = file
        ? createGitStageCommand(snapshot.rootPath, file.path, mode, isWindowsHost)
        : createGitStageAllCommand(snapshot.rootPath, mode, isWindowsHost);
      const label = file
        ? `${mode === 'stage' ? '暂存' : '取消暂存'} ${file.path}`
        : mode === 'stage'
          ? '暂存全部变更'
          : '取消全部暂存';

      await executeGitCommand(label, command);
    } catch (error) {
      setError(getErrorMessage(error));
    }
  };

  const prepareAction = (action: GitAction) => {
    if (!snapshot) return;

    try {
      const labels: Record<GitAction, string> = {
        fetch: 'Fetch',
        pull: 'Pull --ff-only',
        push: 'Push',
        checkout: 'Checkout',
      };
      const command = createGitActionCommand(snapshot.rootPath, action, selectedBranch, isWindowsHost);

      setPendingAction({
        action,
        label: labels[action],
        command,
        branch: action === 'checkout' ? selectedBranch : undefined,
        danger: action === 'pull' || action === 'push' || action === 'checkout',
      });
    } catch (error) {
      setError(getErrorMessage(error));
    }
  };

  const prepareCheckoutBranch = (branchName: string) => {
    if (!snapshot) return;

    try {
      const command = createGitActionCommand(snapshot.rootPath, 'checkout', branchName, isWindowsHost);

      setPendingAction({
        action: 'checkout',
        label: 'Checkout',
        command,
        branch: branchName,
        danger: true,
      });
    } catch (error) {
      setError(getErrorMessage(error));
    }
  };

  const prepareBranchAction = (action: GitBranchAction, branchName: string) => {
    if (!snapshot) return;

    try {
      const labels: Record<GitBranchAction, string> = {
        create: '新建分支',
        delete: '删除分支',
        checkoutRemote: '跟踪远程分支',
      };
      const pendingActions: Record<GitBranchAction, PendingGitActionKind> = {
        create: 'branchCreate',
        delete: 'branchDelete',
        checkoutRemote: 'branchCheckoutRemote',
      };
      const command = createGitBranchActionCommand(snapshot.rootPath, action, branchName, isWindowsHost);

      setPendingAction({
        action: pendingActions[action],
        label: labels[action],
        command,
        branch: branchName,
        danger: action === 'delete',
      });
    } catch (error) {
      setError(getErrorMessage(error));
    }
  };

  const prepareCreateBranch = () => {
    setError('');
    setNotice('');
    prepareBranchAction('create', newBranchName);
  };

  const prepareCommit = () => {
    if (!snapshot) return;

    setError('');
    setNotice('');

    if (conflictedCount > 0) {
      setError('当前存在冲突文件，请先解决冲突后再提交。');
      return;
    }

    if (stagedCount === 0) {
      setError('请先暂存至少一个文件。');
      return;
    }

    try {
      const command = createGitCommitCommand(snapshot.rootPath, commitMessage, isWindowsHost);

      setPendingAction({
        action: 'commit',
        label: 'Commit',
        command,
        message: commitMessage.trim(),
      });
    } catch (error) {
      setActiveTab('changes');
      setError(getErrorMessage(error));
      window.setTimeout(() => commitMessageRef.current?.focus(), 0);
    }
  };

  const executePendingAction = async () => {
    if (!pendingAction) return;

    setActionRunning(true);
    setError('');
    setNotice('');

    try {
      const result = await runCmd(connectionId, pendingAction.command);
      const output = result.stdout || result.stderr || `${pendingAction.label} 已执行。`;

      if (result.code !== 0) {
        throw new Error(output);
      }

      if (pendingAction.action === 'commit') {
        setCommitMessage('');
      }
      if (pendingAction.action === 'branchCreate') {
        setNewBranchName('');
      }
      setPendingAction(null);
      await loadRepository(snapshot?.rootPath ?? repoPath);
      setCommandOutput(output);
      setNotice(output);
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setActionRunning(false);
    }
  };

  const copyCommandOutput = async () => {
    await navigator.clipboard.writeText(commandOutput || snapshot?.rawOutput || '');
    setNotice('已复制输出。');
  };

  const copyRepositorySummary = async () => {
    if (!snapshot) return;

    await navigator.clipboard.writeText([
      `path: ${snapshot.rootPath}`,
      `branch: ${snapshot.branch}`,
      `upstream: ${snapshot.upstream ?? '-'}`,
      `ahead: ${snapshot.ahead}`,
      `behind: ${snapshot.behind}`,
      `clean: ${snapshot.clean}`,
      '',
      snapshot.rawStatus,
    ].join('\n'));
    setNotice('已复制仓库摘要。');
  };

  const handlePickRepository = (path: string) => {
    setFilePickerVisible(false);
    setRepoPath(path);
    void loadRepository(path);
  };

  return (
    <section className="git-manager">
      <header className="git-sourcetree-toolbar">
        <div className="git-toolbar-actions-main" aria-label="Git 常用操作">
          <button type="button" onClick={prepareCommit} disabled={!snapshot || loading || actionRunning || stagedCount === 0 || conflictedCount > 0}>
            <strong>提交</strong>
          </button>
          <button type="button" onClick={() => prepareAction('pull')} disabled={!snapshot || loading || actionRunning}>
            <strong>拉取</strong>
          </button>
          <button type="button" onClick={() => prepareAction('push')} disabled={!snapshot || loading || actionRunning}>
            <strong>推送</strong>
          </button>
          <button type="button" onClick={() => prepareAction('fetch')} disabled={!snapshot || loading || actionRunning}>
            <strong>获取</strong>
          </button>
          <button type="button" onClick={() => branchNameInputRef.current?.focus()} disabled={!snapshot || loading || actionRunning}>
            <strong>分支</strong>
          </button>
          <button type="button" onClick={() => prepareAction('checkout')} disabled={!snapshot || loading || actionRunning || !selectedBranch || selectedBranch === snapshot.branch}>
            <strong>切换</strong>
          </button>
        </div>
        <form
          className="git-repo-picker"
          onSubmit={(event) => {
            event.preventDefault();
            void loadRepository(repoPath);
          }}
        >
          <input
            value={repoPath}
            onChange={(event) => setRepoPath(event.target.value)}
            placeholder={isWindowsHost ? 'D:\\Code\\project 或 D:/Code/project' : '/home/user/project'}
            disabled={loading || actionRunning}
          />
          <button type="submit" disabled={loading || actionRunning || !repoPath.trim()}>{loading ? '读取中' : '读取'}</button>
          <button type="button" onClick={() => setFilePickerVisible(true)} disabled={loading || actionRunning}>浏览</button>
          <button type="button" onClick={() => loadRepository(snapshot?.rootPath ?? repoPath)} disabled={loading || actionRunning || !repoPath}>刷新</button>
        </form>
      </header>

      {(error || notice) ? (
        <div className="git-alert-stack">
          {error ? <div className="git-alert danger">{error}</div> : null}
          {notice ? <div className="git-alert info">{notice}</div> : null}
        </div>
      ) : null}

      <div className="git-sourcetree-shell">
        <aside className="git-source-sidebar">
          <section className="git-sidebar-section workspace">
            <div className="git-section-title"><span>▱</span><strong>WORKSPACE</strong></div>
            <button type="button" className={activeTab === 'changes' ? 'active' : ''} onClick={() => setActiveTab('changes')}>
              <span>文件状态</span><em>{changedCount}</em>
            </button>
            <button type="button" className={activeTab === 'commits' ? 'active' : ''} onClick={() => setActiveTab('commits')}>
              <span>History</span><em>{snapshot?.commits.length ?? 0}</em>
            </button>
            <button type="button" className={activeTab === 'raw' ? 'active' : ''} onClick={() => setActiveTab('raw')}>
              <span>命令输出</span>
            </button>
          </section>

          <label className="git-sidebar-search">
            <span>搜索</span>
            <input value={commitSearch} onChange={(event) => { setCommitSearch(event.target.value); setActiveTab('commits'); }} placeholder="提交、作者、hash" />
          </label>

          <section className="git-sidebar-section branch-tree">
            <div className="git-section-title"><span>⑂</span><strong>分支</strong><em>{localBranches.length}</em></div>
            {localBranchGroups.map((group) => (
              <details key={group.name} open>
                <summary>{group.name}</summary>
                {group.items.map((branch) => (
                  <button
                    key={branch.name}
                    type="button"
                    className={`${branch.current ? 'current' : ''} ${selectedBranch === branch.name ? 'active' : ''}`}
                    onClick={() => setSelectedBranch(branch.name)}
                    onDoubleClick={() => {
                      setSelectedBranch(branch.name);
                      prepareCheckoutBranch(branch.name);
                    }}
                  >
                    <span>{branch.current ? '●' : '○'} {getBranchLeafName(branch.name)}</span>
                    {branch.upstream ? <em>{branch.upstream}</em> : null}
                  </button>
                ))}
              </details>
            ))}
            {!localBranches.length ? <div className="git-empty-compact">暂无本地分支</div> : null}
          </section>

          <section className="git-branch-control">
            <input
              ref={branchNameInputRef}
              value={newBranchName}
              onChange={(event) => setNewBranchName(event.target.value)}
              placeholder="新分支名，如 feat/login"
              disabled={!snapshot || actionRunning}
            />
            <div>
              <button type="button" onClick={prepareCreateBranch} disabled={!snapshot || actionRunning || !newBranchName.trim()}>新建</button>
              <button type="button" onClick={() => selectedLocalBranch && prepareCheckoutBranch(selectedLocalBranch.name)} disabled={!snapshot || actionRunning || !selectedLocalBranch || selectedLocalBranch.current}>切换</button>
              <button type="button" className="danger" onClick={() => selectedLocalBranch && prepareBranchAction('delete', selectedLocalBranch.name)} disabled={!snapshot || actionRunning || !selectedLocalBranch || selectedLocalBranch.current}>删除</button>
            </div>
          </section>

          <section className="git-sidebar-section branch-tree">
            <div className="git-section-title"><span>☁</span><strong>远程</strong><em>{remoteBranches.length}</em></div>
            {remoteBranchGroups.map((group) => (
              <details key={group.name} open>
                <summary>{group.name}</summary>
                {group.items.map((branch) => (
                  <button
                    key={branch.name}
                    type="button"
                    className={selectedRemoteBranch === branch.name ? 'active' : ''}
                    onClick={() => setSelectedRemoteBranch(branch.name)}
                    onDoubleClick={() => {
                      setSelectedRemoteBranch(branch.name);
                      prepareBranchAction('checkoutRemote', branch.name);
                    }}
                  >
                    <span>{getRemoteBranchLabel(branch.name)}</span>
                  </button>
                ))}
              </details>
            ))}
            {!remoteBranches.length ? <div className="git-empty-compact">暂无远程分支</div> : null}
            <button type="button" className="git-track-remote-btn" onClick={() => prepareBranchAction('checkoutRemote', selectedRemoteBranch)} disabled={!snapshot || actionRunning || !selectedRemoteBranchItem}>
              跟踪并切换
            </button>
          </section>

          <details className="git-sidebar-section tags" open={false}>
            <summary><span>◇</span><strong>标签</strong><em>{snapshot?.tags.length ?? 0}</em></summary>
            {(snapshot?.tags ?? []).slice(0, 12).map((tag) => (
              <div key={tag.name} className="git-tag-row"><span>{tag.name}</span><em>{tag.subject}</em></div>
            ))}
          </details>
        </aside>

        <main className="git-sourcetree-main">
          <div className="git-history-filterbar">
            <strong>{activeTab === 'changes' ? '文件状态' : activeTab === 'raw' ? '命令输出' : 'History'}</strong>
            <span>{filteredCommits.length} commits · {localBranches.length} local branches · {remoteBranches.length} remote branches</span>
            <div className={`git-branch-card ${snapshot?.clean ? 'clean' : 'dirty'}`}>
              <strong>{snapshot?.branch ?? '未加载'}</strong>
              <span>{snapshot?.upstream ? `${snapshot.upstream} · +${snapshot.ahead} / -${snapshot.behind}` : lastRefreshedAt || '请选择仓库目录'}</span>
            </div>
          </div>

          {activeTab === 'changes' ? (
            <section className="git-workspace-panel">
              <div className="git-commit-box">
                <div className="git-commit-box-head">
                  <strong>提交暂存区</strong>
                  <span>{stagedCount} staged · {unstagedCount} unstaged</span>
                </div>
                <textarea
                  ref={commitMessageRef}
                  value={commitMessage}
                  placeholder="提交信息"
                  rows={3}
                  disabled={!snapshot || actionRunning}
                  onChange={(event) => setCommitMessage(event.target.value)}
                />
                <div className="git-commit-actions">
                  <button type="button" onClick={() => void executeStageAction('stage')} disabled={!snapshot || actionRunning || unstagedCount === 0}>全部暂存</button>
                  <button type="button" onClick={() => void executeStageAction('unstage')} disabled={!snapshot || actionRunning || stagedCount === 0}>取消暂存</button>
                  <button type="button" className="primary" onClick={prepareCommit} disabled={!snapshot || actionRunning || stagedCount === 0 || conflictedCount > 0}>提交</button>
                </div>
              </div>
              <div className="git-workspace-metrics">
                <div><span>变更</span><strong>{changedCount}</strong></div>
                <div><span>已暂存</span><strong>{stagedCount}</strong></div>
                <div><span>未暂存</span><strong>{unstagedCount}</strong></div>
                <div><span>冲突</span><strong>{conflictedCount}</strong></div>
              </div>
              <pre className="git-raw-status">{snapshot?.rawStatus || '点击“打开”选择远程 Git 仓库目录。'}</pre>
            </section>
          ) : null}

          {activeTab === 'commits' ? (
            <section className="git-history-table">
              <div className="git-history-head">
                <span>图谱</span>
                <span>描述</span>
                <span>日期</span>
                <span>作者</span>
                <span>提交</span>
              </div>
              <div className="git-history-body">
                {filteredCommits.map((commit, index) => (
                  <button
                    key={commit.hash}
                    type="button"
                    className={selectedCommit?.hash === commit.hash ? 'active' : ''}
                    onClick={() => setSelectedCommitHash(commit.hash)}
                  >
                    <span className={`git-graph-cell lane-${index % 4}`}><i /></span>
                    <span className="git-history-message">
                      {index === 0 && snapshot?.branch ? <em className="git-ref-badge">{snapshot.branch}</em> : null}
                      {index === 0 && snapshot?.upstream ? <em className="git-ref-badge remote">{snapshot.upstream}</em> : null}
                      <strong>{commit.subject}</strong>
                    </span>
                    <span>{formatDate(commit.date)}</span>
                    <span>{commit.author}</span>
                    <code>{commit.shortHash}</code>
                  </button>
                ))}
                {!filteredCommits.length ? <div className="git-empty-state">暂无提交记录。</div> : null}
              </div>
            </section>
          ) : null}

          {activeTab === 'diff' ? (
            <section className="git-diff-panel">
              <div className="git-diff-toolbar">
                <div>
                  <span>Diff</span>
                  <strong>{selectedFile?.path ?? '未选择文件'}</strong>
                </div>
                <div className="git-diff-actions">
                  <button type="button" className={diffMode === 'worktree' ? 'active' : ''} onClick={() => { setDiffMode('worktree'); void loadDiff(selectedFile, 'worktree'); }}>Unstaged</button>
                  <button type="button" className={diffMode === 'staged' ? 'active' : ''} onClick={() => { setDiffMode('staged'); void loadDiff(selectedFile, 'staged'); }}>Staged</button>
                </div>
              </div>
              <pre className="git-diff-output">{diffLoading ? '读取 diff 中...' : diffText || '选择文件后显示 diff。'}</pre>
            </section>
          ) : null}

          {activeTab === 'raw' ? <pre className="git-command-output">{commandOutput || snapshot?.rawOutput || '暂无输出。'}</pre> : null}

          <section className="git-bottom-panes">
            <div className="git-commit-detail">
              <div className="git-pane-head">
                <strong>{selectedCommit ? selectedCommit.subject : '未选择提交'}</strong>
                <button type="button" onClick={copyRepositorySummary} disabled={!snapshot}>复制摘要</button>
              </div>
              <dl>
                <div><dt>提交</dt><dd>{selectedCommit?.hash ?? '-'}</dd></div>
                <div><dt>父级</dt><dd>{snapshot?.commits[1]?.shortHash ?? '-'}</dd></div>
                <div><dt>作者</dt><dd>{selectedCommit?.author ?? '-'}</dd></div>
                <div><dt>日期</dt><dd>{selectedCommit ? formatDate(selectedCommit.date) : '-'}</dd></div>
              </dl>
              <p>{selectedCommit?.subject ?? (snapshot ? '选择历史记录查看详情。' : '请选择仓库目录。')}</p>
            </div>
            <div className="git-changed-files-panel">
              <div className="git-pane-head">
                <strong>变更文件</strong>
                <span>{snapshot?.clean ? 'clean' : `${changedCount} files`}</span>
                <button type="button" onClick={copyCommandOutput} disabled={!commandOutput && !snapshot?.rawOutput}>复制输出</button>
              </div>
              <div className="git-selected-actions">
                <button type="button" onClick={() => void executeStageAction('stage', selectedFile)} disabled={!snapshot || actionRunning || !selectedFileCanStage}>暂存选中</button>
                <button type="button" onClick={() => void executeStageAction('unstage', selectedFile)} disabled={!snapshot || actionRunning || !selectedFileCanUnstage}>取消暂存</button>
                <button type="button" onClick={() => loadDiff()} disabled={!selectedFile || diffLoading}>查看 Diff</button>
              </div>
              <div className="git-file-list">
                {(snapshot?.files ?? []).map((file) => (
                  <button
                    key={getChangeKey(file)}
                    type="button"
                    className={selectedFile?.path === file.path ? 'active' : ''}
                    onClick={() => {
                      setSelectedFilePath(file.path);
                      void loadDiff(file);
                    }}
                  >
                    <span className={`git-file-status ${getChangeTone(file)}`}>{getGitStatusLabel(file)}</span>
                    <strong title={file.path}>{file.path}</strong>
                    <em>{file.indexStatus.trim() || '-'} / {file.worktreeStatus.trim() || '-'}</em>
                  </button>
                ))}
                {!snapshot || snapshot.files.length === 0 ? <div className="git-empty-state">没有变更文件。</div> : null}
              </div>
            </div>
          </section>
        </main>
      </div>

      {pendingAction ? createPortal(
        <div className="git-modal-backdrop" role="presentation" onClick={() => setPendingAction(null)}>
          <div className={`git-confirm-dialog ${pendingAction.danger ? 'danger' : ''}`} role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="git-confirm-header">
              <span>{pendingAction.action === 'commit' ? '确认提交' : pendingAction.danger ? '确认仓库操作' : '确认命令'}</span>
              <strong>{pendingAction.label}{pendingAction.branch ? ` ${pendingAction.branch}` : ''}</strong>
            </div>
            <dl>
              <div><dt>仓库</dt><dd>{snapshot?.rootPath ?? repoPath}</dd></div>
              <div><dt>当前分支</dt><dd>{snapshot?.branch ?? '-'}</dd></div>
              {pendingAction.branch ? <div><dt>目标分支</dt><dd>{pendingAction.branch}</dd></div> : null}
              {pendingAction.message ? <div><dt>提交信息</dt><dd>{pendingAction.message}</dd></div> : null}
            </dl>
            <pre>{pendingAction.command.command}</pre>
            <div className="git-confirm-actions">
              <button type="button" onClick={() => setPendingAction(null)}>取消</button>
              <button type="button" className={pendingAction.danger ? 'danger' : 'primary'} onClick={executePendingAction} disabled={actionRunning}>
                {actionRunning ? '执行中' : pendingAction.action === 'commit' ? '提交' : '执行'}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}

      <RemoteFilePicker
        connectionId={connectionId}
        systemType={systemType}
        mode="directory"
        title="选择 Git 仓库目录"
        visible={filePickerVisible}
        initialPath={repoPath || undefined}
        confirmLabel="选择文件夹"
        onConfirm={handlePickRepository}
        onCancel={() => setFilePickerVisible(false)}
      />
    </section>
  );
}

export default RemoteGitManager;
