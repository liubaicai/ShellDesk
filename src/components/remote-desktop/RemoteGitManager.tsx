import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import { getErrorMessage } from './desktopUtils';
import {
  createGitActionCommand,
  createGitDiffCommand,
  createGitSnapshotCommand,
  getGitStatusLabel,
  parseGitSnapshotOutput,
  type GitAction,
  type GitFileChange,
  type GitRepositorySnapshot,
} from './gitUtils';
import { isWindowsSystem, type RemoteCommandInput } from './remoteSystem';
import type { RemoteSystemType } from './types';

interface RemoteGitManagerProps {
  connectionId: string;
  systemType?: RemoteSystemType;
}

type GitTab = 'changes' | 'commits' | 'diff' | 'raw';
type DiffMode = 'worktree' | 'staged';

interface PendingGitAction {
  action: GitAction;
  label: string;
  command: RemoteCommandInput;
  branch?: string;
  danger?: boolean;
}

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

function RemoteGitManager({ connectionId, systemType }: RemoteGitManagerProps) {
  const isWindowsHost = isWindowsSystem(systemType);
  const [repoPath, setRepoPath] = useState('.');
  const [snapshot, setSnapshot] = useState<GitRepositorySnapshot | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState('');
  const [selectedBranch, setSelectedBranch] = useState('');
  const [activeTab, setActiveTab] = useState<GitTab>('changes');
  const [diffMode, setDiffMode] = useState<DiffMode>('worktree');
  const [diffText, setDiffText] = useState('');
  const [commandOutput, setCommandOutput] = useState('');
  const [loading, setLoading] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [actionRunning, setActionRunning] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [lastRefreshedAt, setLastRefreshedAt] = useState('');
  const [pendingAction, setPendingAction] = useState<PendingGitAction | null>(null);

  const selectedFile = useMemo(() => {
    return snapshot?.files.find((file) => file.path === selectedFilePath) ?? snapshot?.files[0] ?? null;
  }, [selectedFilePath, snapshot?.files]);

  const changedCount = snapshot?.files.length ?? 0;
  const branchOptions = snapshot?.branches.filter((branch) => branch.name !== 'DETACHED') ?? [];

  const loadRepository = useCallback(async (path = repoPath) => {
    setLoading(true);
    setError('');
    setNotice('');

    try {
      const command = createGitSnapshotCommand(path, isWindowsHost);
      const result = await runCmd(connectionId, command);
      const nextSnapshot = parseGitSnapshotOutput(path, result.stdout, result.stderr);

      setSnapshot(nextSnapshot);
      setRepoPath(nextSnapshot.rootPath);
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
  }, [connectionId, isWindowsHost, repoPath]);

  useEffect(() => {
    void loadRepository('.');
  }, [connectionId, isWindowsHost]);

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

  const prepareAction = (action: GitAction) => {
    if (!snapshot) return;

    try {
      const labels: Record<GitAction, string> = {
        fetch: 'Fetch',
        pull: 'Pull --ff-only',
        checkout: 'Checkout',
      };
      const command = createGitActionCommand(snapshot.rootPath, action, selectedBranch, isWindowsHost);

      setPendingAction({
        action,
        label: labels[action],
        command,
        branch: action === 'checkout' ? selectedBranch : undefined,
        danger: action !== 'fetch',
      });
    } catch (error) {
      setError(getErrorMessage(error));
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

      setCommandOutput(output);
      setNotice(output);
      setPendingAction(null);
      await loadRepository(snapshot?.rootPath ?? repoPath);
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

  return (
    <section className="git-manager">
      <header className="git-toolbar">
        <div className={`git-branch-card ${snapshot?.clean ? 'clean' : 'dirty'}`}>
          <span>Git 仓库</span>
          <strong>{snapshot?.branch ?? '未加载'}</strong>
          <em>{snapshot?.upstream ? `${snapshot.upstream} · +${snapshot.ahead} / -${snapshot.behind}` : lastRefreshedAt || '等待刷新'}</em>
        </div>
        <form
          className="git-path-form"
          onSubmit={(event) => {
            event.preventDefault();
            void loadRepository(repoPath);
          }}
        >
          <input value={repoPath} onChange={(event) => setRepoPath(event.target.value)} placeholder="/srv/app" />
          <button type="submit" className="primary" disabled={loading}>{loading ? '读取中' : '打开'}</button>
        </form>
        <div className="git-toolbar-actions">
          <button type="button" onClick={() => loadRepository(snapshot?.rootPath ?? repoPath)} disabled={loading}>刷新</button>
          <button type="button" onClick={() => prepareAction('fetch')} disabled={!snapshot || loading}>Fetch</button>
          <button type="button" onClick={() => prepareAction('pull')} disabled={!snapshot || loading}>Pull</button>
        </div>
      </header>

      {error ? <div className="git-alert danger">{error}</div> : null}
      {notice ? <div className="git-alert info">{notice}</div> : null}

      <div className="git-layout">
        <aside className="git-sidebar">
          <div className="git-summary-grid">
            <div><span>变更</span><strong>{changedCount}</strong></div>
            <div><span>Ahead</span><strong>{snapshot?.ahead ?? 0}</strong></div>
            <div><span>Behind</span><strong>{snapshot?.behind ?? 0}</strong></div>
            <div><span>Commits</span><strong>{snapshot?.commits.length ?? 0}</strong></div>
          </div>

          <label className="git-branch-select">
            <span>切换分支</span>
            <select value={selectedBranch} onChange={(event) => setSelectedBranch(event.target.value)} disabled={!branchOptions.length}>
              {branchOptions.map((branch) => (
                <option key={branch.name} value={branch.name}>{branch.current ? `* ${branch.name}` : branch.name}</option>
              ))}
            </select>
          </label>
          <button type="button" className="git-checkout-btn" onClick={() => prepareAction('checkout')} disabled={!snapshot || !selectedBranch || selectedBranch === snapshot.branch}>
            Checkout
          </button>

          <div className="git-file-list-head">
            <strong>变更文件</strong>
            <span>{snapshot?.clean ? 'clean' : `${changedCount} files`}</span>
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
            <button type="button" className={activeTab === 'commits' ? 'active' : ''} onClick={() => setActiveTab('commits')}>提交</button>
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
              <pre className="git-raw-status">{snapshot?.rawStatus || '输入仓库路径后读取状态。'}</pre>
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
            Pull 使用 `--ff-only`，Checkout 仅对已检测到的本地分支开放；会改变仓库状态的操作都会先确认。
          </div>
        </aside>
      </div>

      {pendingAction ? createPortal(
        <div className="git-modal-backdrop" role="presentation" onClick={() => setPendingAction(null)}>
          <div className={`git-confirm-dialog ${pendingAction.danger ? 'danger' : ''}`} role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="git-confirm-header">
              <span>{pendingAction.danger ? '确认仓库操作' : '确认命令'}</span>
              <strong>{pendingAction.label}{pendingAction.branch ? ` ${pendingAction.branch}` : ''}</strong>
            </div>
            <dl>
              <div><dt>仓库</dt><dd>{snapshot?.rootPath ?? repoPath}</dd></div>
              <div><dt>当前分支</dt><dd>{snapshot?.branch ?? '-'}</dd></div>
              {pendingAction.branch ? <div><dt>目标分支</dt><dd>{pendingAction.branch}</dd></div> : null}
            </dl>
            <pre>{pendingAction.command.command}</pre>
            <div className="git-confirm-actions">
              <button type="button" onClick={() => setPendingAction(null)}>取消</button>
              <button type="button" className={pendingAction.danger ? 'danger' : 'primary'} onClick={executePendingAction} disabled={actionRunning}>
                {actionRunning ? '执行中' : '执行'}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </section>
  );
}

export default RemoteGitManager;
