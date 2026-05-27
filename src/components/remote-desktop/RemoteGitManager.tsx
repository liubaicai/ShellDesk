import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { getErrorMessage } from './desktopUtils';
import {
  createGitActionCommand,
  createGitCommitCommand,
  createGitDiffCommand,
  createGitSnapshotCommand,
  createGitStageAllCommand,
  createGitStageCommand,
  getGitStatusLabel,
  parseGitSnapshotOutput,
  type GitAction,
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
type PendingGitActionKind = GitAction | 'commit';

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

  return new Date(timestamp).toLocaleString('zh-CN');
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

function RemoteGitManager({ connectionId, systemType }: RemoteGitManagerProps) {
  const isWindowsHost = isWindowsSystem(systemType);
  const commitMessageRef = useRef<HTMLTextAreaElement | null>(null);
  const [repoPath, setRepoPath] = useState(() => rememberedGitRepositoryPaths.get(connectionId) ?? '');
  const [snapshot, setSnapshot] = useState<GitRepositorySnapshot | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState('');
  const [selectedBranch, setSelectedBranch] = useState('');
  const [activeTab, setActiveTab] = useState<GitTab>('changes');
  const [diffMode, setDiffMode] = useState<DiffMode>('worktree');
  const [diffText, setDiffText] = useState('');
  const [commitMessage, setCommitMessage] = useState('');
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
  const branchOptions = snapshot?.branches.filter((branch) => branch.name !== 'DETACHED') ?? [];

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
      setCommandOutput(nextSnapshot.rawOutput);
      setLastRefreshedAt(new Date().toLocaleTimeString('zh-CN'));
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
      <header className="git-toolbar">
        <div className={`git-branch-card ${snapshot?.clean ? 'clean' : 'dirty'}`}>
          <span>Git 仓库</span>
          <strong>{snapshot?.branch ?? '未加载'}</strong>
          <em>{snapshot?.upstream ? `${snapshot.upstream} · +${snapshot.ahead} / -${snapshot.behind}` : lastRefreshedAt || '请选择仓库目录'}</em>
        </div>
        <form
          className="git-path-form"
          onSubmit={(event) => {
            event.preventDefault();
            setFilePickerVisible(true);
          }}
        >
          <input value={repoPath} readOnly placeholder="点击打开选择 Git 仓库目录" />
          <button type="submit" className="primary" disabled={loading || actionRunning}>{loading ? '读取中' : '打开'}</button>
        </form>
        <div className="git-toolbar-actions">
          <button type="button" onClick={() => loadRepository(snapshot?.rootPath ?? repoPath)} disabled={loading || actionRunning || !repoPath}>刷新</button>
        </div>
      </header>

      <section className="git-action-strip" aria-label="Git 常用操作">
        <div className="git-action-strip-title">
          <span>常用操作</span>
          <strong>{snapshot ? `${snapshot.branch} · ${snapshot.clean ? 'clean' : `${changedCount} files changed`}` : '选择仓库后可用'}</strong>
        </div>
        <div className="git-action-buttons">
          <button type="button" className="stage" onClick={() => void executeStageAction('stage')} disabled={!snapshot || loading || actionRunning || unstagedCount === 0}>
            <span>Stage All</span>
            <em>暂存变更</em>
          </button>
          <button type="button" className="commit" onClick={prepareCommit} disabled={!snapshot || loading || actionRunning || stagedCount === 0 || conflictedCount > 0}>
            <span>Commit</span>
            <em>提交暂存</em>
          </button>
          <button type="button" className="primary" onClick={() => prepareAction('pull')} disabled={!snapshot || loading || actionRunning}>
            <span>Pull</span>
            <em>拉取更新</em>
          </button>
          <button type="button" className="push" onClick={() => prepareAction('push')} disabled={!snapshot || loading || actionRunning}>
            <span>Push</span>
            <em>推送提交</em>
          </button>
          <button type="button" onClick={() => prepareAction('fetch')} disabled={!snapshot || loading || actionRunning}>
            <span>Fetch</span>
            <em>同步远端</em>
          </button>
          <button type="button" onClick={() => loadRepository(snapshot?.rootPath ?? repoPath)} disabled={loading || actionRunning || !repoPath}>
            <span>Refresh</span>
            <em>刷新状态</em>
          </button>
        </div>
      </section>

      {error ? <div className="git-alert danger">{error}</div> : null}
      {notice ? <div className="git-alert info">{notice}</div> : null}

      <div className="git-layout">
        <aside className="git-sidebar">
          <div className="git-summary-grid">
            <div><span>变更</span><strong>{changedCount}</strong></div>
            <div><span>已暂存</span><strong>{stagedCount}</strong></div>
            <div><span>未暂存</span><strong>{unstagedCount}</strong></div>
            <div><span>Ahead</span><strong>{snapshot?.ahead ?? 0}</strong></div>
            <div><span>Behind</span><strong>{snapshot?.behind ?? 0}</strong></div>
            <div><span>冲突</span><strong>{conflictedCount}</strong></div>
          </div>

          <label className="git-branch-select">
            <span>切换分支</span>
            <select value={selectedBranch} onChange={(event) => setSelectedBranch(event.target.value)} disabled={!branchOptions.length}>
              {branchOptions.map((branch) => (
                <option key={branch.name} value={branch.name}>{branch.current ? `* ${branch.name}` : branch.name}</option>
              ))}
            </select>
          </label>
          <button type="button" className="git-checkout-btn" onClick={() => prepareAction('checkout')} disabled={!snapshot || loading || actionRunning || !selectedBranch || selectedBranch === snapshot.branch}>
            Checkout
          </button>

          <div className="git-commit-box">
            <div className="git-commit-box-head">
              <strong>提交</strong>
              <span>{stagedCount} staged</span>
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

          <div className="git-file-list-head">
            <strong>变更文件</strong>
            <span>{snapshot?.clean ? 'clean' : `${changedCount} files`}</span>
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
        </aside>

        <main className="git-main">
          <nav className="git-tabs">
            <button type="button" className={activeTab === 'changes' ? 'active' : ''} onClick={() => setActiveTab('changes')}>状态</button>
            <button type="button" className={activeTab === 'commits' ? 'active' : ''} onClick={() => setActiveTab('commits')}>历史</button>
            <button type="button" className={activeTab === 'diff' ? 'active' : ''} onClick={() => loadDiff()}>Diff</button>
            <button type="button" className={activeTab === 'raw' ? 'active' : ''} onClick={() => setActiveTab('raw')}>原始输出</button>
            <button type="button" onClick={copyRepositorySummary} disabled={!snapshot}>复制摘要</button>
            <button type="button" onClick={copyCommandOutput} disabled={!commandOutput && !snapshot?.rawOutput}>复制输出</button>
          </nav>

          {activeTab === 'changes' ? (
            <section className="git-status-panel">
              <div className="git-hero">
                <span>{snapshot?.rootPath ?? '尚未打开仓库'}</span>
                <strong>{snapshot?.clean ? '工作区干净' : `${changedCount} 个文件有变更`}</strong>
                <em>{snapshot?.upstream ? `上游：${snapshot.upstream}` : '未检测到上游分支'}</em>
              </div>
              <div className="git-metric-grid">
                <div><span>已暂存</span><strong>{stagedCount}</strong></div>
                <div><span>未暂存</span><strong>{unstagedCount}</strong></div>
                <div><span>冲突</span><strong>{conflictedCount}</strong></div>
                <div><span>提交历史</span><strong>{snapshot?.commits.length ?? 0}</strong></div>
              </div>
              <pre className="git-raw-status">{snapshot?.rawStatus || '点击“打开”选择远程 Git 仓库目录。'}</pre>
            </section>
          ) : null}

          {activeTab === 'commits' ? (
            <section className="git-commit-list">
              {(snapshot?.commits ?? []).map((commit) => (
                <article key={commit.hash} className="git-commit-row">
                  <strong>{commit.subject}</strong>
                  <span>{commit.author} · {formatDate(commit.date)}</span>
                  <code>{commit.shortHash}</code>
                </article>
              ))}
              {!snapshot?.commits.length ? <div className="git-empty-state">暂无提交记录。</div> : null}
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
        </main>

        <aside className="git-detail">
          <div className="git-detail-head">
            <strong>仓库摘要</strong>
            <span>{snapshot?.rootPath ?? '-'}</span>
          </div>
          <dl>
            <div><dt>当前分支</dt><dd>{snapshot?.branch ?? '-'}</dd></div>
            <div><dt>上游分支</dt><dd>{snapshot?.upstream ?? '-'}</dd></div>
            <div><dt>同步状态</dt><dd>+{snapshot?.ahead ?? 0} / -{snapshot?.behind ?? 0}</dd></div>
            <div><dt>远程地址</dt><dd>{snapshot?.remotes[0] ?? '-'}</dd></div>
            <div><dt>刷新时间</dt><dd>{lastRefreshedAt || '-'}</dd></div>
          </dl>
          <div className="git-detail-note">
            Commit 只提交已暂存内容；Pull 使用 `--ff-only`，Push 使用当前仓库默认 upstream；会改变仓库或远端状态的操作都会先确认。
          </div>
        </aside>
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
