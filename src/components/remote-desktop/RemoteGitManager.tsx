import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import DismissibleAlert from './DismissibleAlert';

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
import { tCurrent } from '../../i18n';

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
    throw new Error(tCurrent('auto.remoteGitManager.g77vf3'));
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
    const [groupName = tCurrent('auto.remoteGitManager.dcd4ul')] = branch.name.split('/');
    const key = branch.name.includes('/') ? groupName : tCurrent('auto.remoteGitManager.zgeech');
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
      setNotice(nextSnapshot.clean ? tCurrent('auto.remoteGitManager.1i65qku') : tCurrent('auto.remoteGitManager.1bm0lc', { value0: nextSnapshot.files.length }));
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
      setDiffText(tCurrent('auto.remoteGitManager.10snm6x'));
      setActiveTab('diff');
      return;
    }

    setDiffLoading(true);
    setError('');
    setNotice('');

    try {
      const command = createGitDiffCommand(snapshot.rootPath, file.path, mode === 'staged', isWindowsHost);
      const result = await runCmd(connectionId, command);
      setDiffText(result.stdout || result.stderr || tCurrent('auto.remoteGitManager.1oy3sst'));
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
      const output = result.stdout || result.stderr || tCurrent('auto.remoteGitManager.105ee9t', { value0: label });

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
        ? `${mode === 'stage' ? tCurrent('auto.remoteGitManager.87712f') : tCurrent('auto.remoteGitManager.x30y3l')} ${file.path}`
        : mode === 'stage'
          ? tCurrent('auto.remoteGitManager.1fbifn7')
          : tCurrent('auto.remoteGitManager.19osu15');

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
        create: tCurrent('auto.remoteGitManager.fn0jnw'),
        delete: tCurrent('auto.remoteGitManager.16695em'),
        checkoutRemote: tCurrent('auto.remoteGitManager.zdcnzy'),
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
      setError(tCurrent('auto.remoteGitManager.1juhj20'));
      return;
    }

    if (stagedCount === 0) {
      setError(tCurrent('auto.remoteGitManager.jd6ihz'));
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
      const output = result.stdout || result.stderr || tCurrent('auto.remoteGitManager.105ee9t2', { value0: pendingAction.label });

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
    setNotice(tCurrent('auto.remoteGitManager.178s1g3'));
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
    setNotice(tCurrent('auto.remoteGitManager.1t743o3'));
  };

  const handlePickRepository = (path: string) => {
    setFilePickerVisible(false);
    setRepoPath(path);
    void loadRepository(path);
  };

  return (
    <section className="git-manager">
      <header className="git-sourcetree-toolbar">
        <div className="git-toolbar-actions-main" aria-label={tCurrent('auto.remoteGitManager.18eq20w')}>
          <button type="button" onClick={prepareCommit} disabled={!snapshot || loading || actionRunning || stagedCount === 0 || conflictedCount > 0}>
            <strong>{tCurrent('auto.remoteGitManager.ybr38x')}</strong>
          </button>
          <button type="button" onClick={() => prepareAction('pull')} disabled={!snapshot || loading || actionRunning}>
            <strong>{tCurrent('auto.remoteGitManager.1ohpwom')}</strong>
          </button>
          <button type="button" onClick={() => prepareAction('push')} disabled={!snapshot || loading || actionRunning}>
            <strong>{tCurrent('auto.remoteGitManager.1uechsy')}</strong>
          </button>
          <button type="button" onClick={() => prepareAction('fetch')} disabled={!snapshot || loading || actionRunning}>
            <strong>{tCurrent('auto.remoteGitManager.1c6hn8g')}</strong>
          </button>
          <button type="button" onClick={() => branchNameInputRef.current?.focus()} disabled={!snapshot || loading || actionRunning}>
            <strong>{tCurrent('auto.remoteGitManager.8krd2a')}</strong>
          </button>
          <button type="button" onClick={() => prepareAction('checkout')} disabled={!snapshot || loading || actionRunning || !selectedBranch || selectedBranch === snapshot.branch}>
            <strong>{tCurrent('auto.remoteGitManager.1fl58wc')}</strong>
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
            placeholder={isWindowsHost ? tCurrent('auto.remoteGitManager.1ln4d9j') : '/home/user/project'}
            disabled={loading || actionRunning}
          />
          <button type="submit" disabled={loading || actionRunning || !repoPath.trim()}>{loading ? tCurrent('auto.remoteGitManager.10y5j8r') : tCurrent('auto.remoteGitManager.tfk7tw')}</button>
          <button type="button" onClick={() => setFilePickerVisible(true)} disabled={loading || actionRunning}>{tCurrent('auto.remoteGitManager.1mr11z6')}</button>
          <button type="button" onClick={() => loadRepository(snapshot?.rootPath ?? repoPath)} disabled={loading || actionRunning || !repoPath}>{tCurrent('auto.remoteGitManager.12qo56a')}</button>
        </form>
      </header>

      {(error || notice) ? (
        <div className="git-alert-stack">
          {error ? <DismissibleAlert className="git-alert danger" onDismiss={() => setError('')} role="alert">{error}</DismissibleAlert> : null}
          {notice ? <DismissibleAlert className="git-alert info" onDismiss={() => setNotice('')}>{notice}</DismissibleAlert> : null}
        </div>
      ) : null}

      <div className="git-sourcetree-shell">
        <aside className="git-source-sidebar">
          <section className="git-sidebar-section workspace">
            <div className="git-section-title"><span>▱</span><strong>WORKSPACE</strong></div>
            <button type="button" className={activeTab === 'changes' ? 'active' : ''} onClick={() => setActiveTab('changes')}>
              <span>{tCurrent('auto.remoteGitManager.r16361')}</span><em>{changedCount}</em>
            </button>
            <button type="button" className={activeTab === 'commits' ? 'active' : ''} onClick={() => setActiveTab('commits')}>
              <span>History</span><em>{snapshot?.commits.length ?? 0}</em>
            </button>
            <button type="button" className={activeTab === 'raw' ? 'active' : ''} onClick={() => setActiveTab('raw')}>
              <span>{tCurrent('auto.remoteGitManager.es77i5')}</span>
            </button>
          </section>

          <label className="git-sidebar-search">
            <span>{tCurrent('auto.remoteGitManager.367f3v')}</span>
            <input value={commitSearch} onChange={(event) => { setCommitSearch(event.target.value); setActiveTab('commits'); }} placeholder={tCurrent('auto.remoteGitManager.mhzk6y')} />
          </label>

          <section className="git-sidebar-section branch-tree">
            <div className="git-section-title"><span>⑂</span><strong>{tCurrent('auto.remoteGitManager.8krd2a2')}</strong><em>{localBranches.length}</em></div>
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
            {!localBranches.length ? <div className="git-empty-compact">{tCurrent('auto.remoteGitManager.1klleg')}</div> : null}
          </section>

          <section className="git-branch-control">
            <input
              ref={branchNameInputRef}
              value={newBranchName}
              onChange={(event) => setNewBranchName(event.target.value)}
              placeholder={tCurrent('auto.remoteGitManager.1s89mxx')}
              disabled={!snapshot || actionRunning}
            />
            <div>
              <button type="button" onClick={prepareCreateBranch} disabled={!snapshot || actionRunning || !newBranchName.trim()}>{tCurrent('auto.remoteGitManager.1f9r5fz')}</button>
              <button type="button" onClick={() => selectedLocalBranch && prepareCheckoutBranch(selectedLocalBranch.name)} disabled={!snapshot || actionRunning || !selectedLocalBranch || selectedLocalBranch.current}>{tCurrent('auto.remoteGitManager.1fl58wc2')}</button>
              <button type="button" className="danger" onClick={() => selectedLocalBranch && prepareBranchAction('delete', selectedLocalBranch.name)} disabled={!snapshot || actionRunning || !selectedLocalBranch || selectedLocalBranch.current}>{tCurrent('auto.remoteGitManager.1t2vi4h')}</button>
            </div>
          </section>

          <section className="git-sidebar-section branch-tree">
            <div className="git-section-title"><span>☁</span><strong>{tCurrent('auto.remoteGitManager.9vo8a8')}</strong><em>{remoteBranches.length}</em></div>
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
            {!remoteBranches.length ? <div className="git-empty-compact">{tCurrent('auto.remoteGitManager.xdp87h')}</div> : null}
            <button type="button" className="git-track-remote-btn" onClick={() => prepareBranchAction('checkoutRemote', selectedRemoteBranch)} disabled={!snapshot || actionRunning || !selectedRemoteBranchItem}>
              {tCurrent('auto.remoteGitManager.r5xduz')}</button>
          </section>

          <details className="git-sidebar-section tags" open={false}>
            <summary><span>◇</span><strong>{tCurrent('auto.remoteGitManager.bydnm0')}</strong><em>{snapshot?.tags.length ?? 0}</em></summary>
            {(snapshot?.tags ?? []).slice(0, 12).map((tag) => (
              <div key={tag.name} className="git-tag-row"><span>{tag.name}</span><em>{tag.subject}</em></div>
            ))}
          </details>
        </aside>

        <main className="git-sourcetree-main">
          <div className="git-history-filterbar">
            <strong>{activeTab === 'changes' ? tCurrent('auto.remoteGitManager.r163612') : activeTab === 'raw' ? tCurrent('auto.remoteGitManager.es77i52') : 'History'}</strong>
            <span>{filteredCommits.length} commits · {localBranches.length} local branches · {remoteBranches.length} remote branches</span>
            <div className={`git-branch-card ${snapshot?.clean ? 'clean' : 'dirty'}`}>
              <strong>{snapshot?.branch ?? tCurrent('auto.remoteGitManager.18vm84u')}</strong>
              <span>{snapshot?.upstream ? `${snapshot.upstream} · +${snapshot.ahead} / -${snapshot.behind}` : lastRefreshedAt || tCurrent('auto.remoteGitManager.exgzv')}</span>
            </div>
          </div>

          {activeTab === 'changes' ? (
            <section className="git-workspace-panel">
              <div className="git-commit-box">
                <div className="git-commit-box-head">
                  <strong>{tCurrent('auto.remoteGitManager.1xw6tmj')}</strong>
                  <span>{stagedCount} staged · {unstagedCount} unstaged</span>
                </div>
                <textarea
                  ref={commitMessageRef}
                  value={commitMessage}
                  placeholder={tCurrent('auto.remoteGitManager.1j66bbh')}
                  rows={3}
                  disabled={!snapshot || actionRunning}
                  onChange={(event) => setCommitMessage(event.target.value)}
                />
                <div className="git-commit-actions">
                  <button type="button" onClick={() => void executeStageAction('stage')} disabled={!snapshot || actionRunning || unstagedCount === 0}>{tCurrent('auto.remoteGitManager.5wd4fz')}</button>
                  <button type="button" onClick={() => void executeStageAction('unstage')} disabled={!snapshot || actionRunning || stagedCount === 0}>{tCurrent('auto.remoteGitManager.x30y3l2')}</button>
                  <button type="button" className="primary" onClick={prepareCommit} disabled={!snapshot || actionRunning || stagedCount === 0 || conflictedCount > 0}>{tCurrent('auto.remoteGitManager.ybr38x2')}</button>
                </div>
              </div>
              <div className="git-workspace-metrics">
                <div><span>{tCurrent('auto.remoteGitManager.j1lqcp')}</span><strong>{changedCount}</strong></div>
                <div><span>{tCurrent('auto.remoteGitManager.mxd2tz')}</span><strong>{stagedCount}</strong></div>
                <div><span>{tCurrent('auto.remoteGitManager.1q1wtkf')}</span><strong>{unstagedCount}</strong></div>
                <div><span>{tCurrent('auto.remoteGitManager.v10se4')}</span><strong>{conflictedCount}</strong></div>
              </div>
              <pre className="git-raw-status">{snapshot?.rawStatus || tCurrent('auto.remoteGitManager.o2l703')}</pre>
            </section>
          ) : null}

          {activeTab === 'commits' ? (
            <section className="git-history-table">
              <div className="git-history-head">
                <span>{tCurrent('auto.remoteGitManager.1vrv0c0')}</span>
                <span>{tCurrent('auto.remoteGitManager.1kxyax6')}</span>
                <span>{tCurrent('auto.remoteGitManager.14s86i5')}</span>
                <span>{tCurrent('auto.remoteGitManager.41rk3e')}</span>
                <span>{tCurrent('auto.remoteGitManager.ybr38x3')}</span>
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
                {!filteredCommits.length ? <div className="git-empty-state">{tCurrent('auto.remoteGitManager.2ogdey')}</div> : null}
              </div>
            </section>
          ) : null}

          {activeTab === 'diff' ? (
            <section className="git-diff-panel">
              <div className="git-diff-toolbar">
                <div>
                  <span>Diff</span>
                  <strong>{selectedFile?.path ?? tCurrent('auto.remoteGitManager.16wk7re')}</strong>
                </div>
                <div className="git-diff-actions">
                  <button type="button" className={diffMode === 'worktree' ? 'active' : ''} onClick={() => { setDiffMode('worktree'); void loadDiff(selectedFile, 'worktree'); }}>Unstaged</button>
                  <button type="button" className={diffMode === 'staged' ? 'active' : ''} onClick={() => { setDiffMode('staged'); void loadDiff(selectedFile, 'staged'); }}>Staged</button>
                </div>
              </div>
              <pre className="git-diff-output">{diffLoading ? tCurrent('auto.remoteGitManager.9ddmii') : diffText || tCurrent('auto.remoteGitManager.1fc4ohf')}</pre>
            </section>
          ) : null}

          {activeTab === 'raw' ? <pre className="git-command-output">{commandOutput || snapshot?.rawOutput || tCurrent('auto.remoteGitManager.1c58myw')}</pre> : null}

          <section className="git-bottom-panes">
            <div className="git-commit-detail">
              <div className="git-pane-head">
                <strong>{selectedCommit ? selectedCommit.subject : tCurrent('auto.remoteGitManager.lyfuaz')}</strong>
                <button type="button" onClick={copyRepositorySummary} disabled={!snapshot}>{tCurrent('auto.remoteGitManager.18nulp1')}</button>
              </div>
              <dl>
                <div><dt>{tCurrent('auto.remoteGitManager.ybr38x4')}</dt><dd>{selectedCommit?.hash ?? '-'}</dd></div>
                <div><dt>{tCurrent('auto.remoteGitManager.nwsuwa')}</dt><dd>{snapshot?.commits[1]?.shortHash ?? '-'}</dd></div>
                <div><dt>{tCurrent('auto.remoteGitManager.41rk3e2')}</dt><dd>{selectedCommit?.author ?? '-'}</dd></div>
                <div><dt>{tCurrent('auto.remoteGitManager.14s86i52')}</dt><dd>{selectedCommit ? formatDate(selectedCommit.date) : '-'}</dd></div>
              </dl>
              <p>{selectedCommit?.subject ?? (snapshot ? tCurrent('auto.remoteGitManager.nasjul') : tCurrent('auto.remoteGitManager.19ao44r'))}</p>
            </div>
            <div className="git-changed-files-panel">
              <div className="git-pane-head">
                <strong>{tCurrent('auto.remoteGitManager.bxcyok')}</strong>
                <span>{snapshot?.clean ? 'clean' : `${changedCount} files`}</span>
                <button type="button" onClick={copyCommandOutput} disabled={!commandOutput && !snapshot?.rawOutput}>{tCurrent('auto.remoteGitManager.tinpzn')}</button>
              </div>
              <div className="git-selected-actions">
                <button type="button" onClick={() => void executeStageAction('stage', selectedFile)} disabled={!snapshot || actionRunning || !selectedFileCanStage}>{tCurrent('auto.remoteGitManager.h9ma4l')}</button>
                <button type="button" onClick={() => void executeStageAction('unstage', selectedFile)} disabled={!snapshot || actionRunning || !selectedFileCanUnstage}>{tCurrent('auto.remoteGitManager.x30y3l3')}</button>
                <button type="button" onClick={() => loadDiff()} disabled={!selectedFile || diffLoading}>{tCurrent('auto.remoteGitManager.1yzzm3k')}</button>
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
                {!snapshot || snapshot.files.length === 0 ? <div className="git-empty-state">{tCurrent('auto.remoteGitManager.533d9g')}</div> : null}
              </div>
            </div>
          </section>
        </main>
      </div>

      {pendingAction ? createPortal(
        <div className="git-modal-backdrop" role="presentation" onClick={() => setPendingAction(null)}>
          <div className={`git-confirm-dialog ${pendingAction.danger ? 'danger' : ''}`} role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="git-confirm-header">
              <span>{pendingAction.action === 'commit' ? tCurrent('auto.remoteGitManager.1n9goln') : pendingAction.danger ? tCurrent('auto.remoteGitManager.103m2z0') : tCurrent('auto.remoteGitManager.17ojhw6')}</span>
              <strong>{pendingAction.label}{pendingAction.branch ? ` ${pendingAction.branch}` : ''}</strong>
            </div>
            <dl>
              <div><dt>{tCurrent('auto.remoteGitManager.bq2r6r')}</dt><dd>{snapshot?.rootPath ?? repoPath}</dd></div>
              <div><dt>{tCurrent('auto.remoteGitManager.qteeve')}</dt><dd>{snapshot?.branch ?? '-'}</dd></div>
              {pendingAction.branch ? <div><dt>{tCurrent('auto.remoteGitManager.tllx09')}</dt><dd>{pendingAction.branch}</dd></div> : null}
              {pendingAction.message ? <div><dt>{tCurrent('auto.remoteGitManager.1j66bbh2')}</dt><dd>{pendingAction.message}</dd></div> : null}
            </dl>
            <pre>{pendingAction.command.command}</pre>
            <div className="git-confirm-actions">
              <button type="button" onClick={() => setPendingAction(null)}>{tCurrent('auto.remoteGitManager.1589w37')}</button>
              <button type="button" className={pendingAction.danger ? 'danger' : 'primary'} onClick={executePendingAction} disabled={actionRunning}>
                {actionRunning ? tCurrent('auto.remoteGitManager.6svkbt') : pendingAction.action === 'commit' ? tCurrent('auto.remoteGitManager.ybr38x5') : tCurrent('auto.remoteGitManager.6azgji')}
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
        title={tCurrent('auto.remoteGitManager.1u85yo2')}
        visible={filePickerVisible}
        initialPath={repoPath || undefined}
        confirmLabel={tCurrent('auto.remoteGitManager.1f0cn5d')}
        onConfirm={handlePickRepository}
        onCancel={() => setFilePickerVisible(false)}
      />
    </section>
  );
}

export default RemoteGitManager;
