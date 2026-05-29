import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import {
  createDetectPackageManagerCommand,
  createPackageActionCommand,
  createPackageListCommand,
  createPackageSearchCommand,
  getPackageManagerLabel,
  normalizePackageManager,
  parsePackageOutput,
  type PackageAction,
  type PackageManagerKind,
  type PackageView,
  type RemotePackageInfo,
} from './packageProviders';
import { isWindowsSystem } from './remoteSystem';
import type { RemoteTerminalLaunchOptions } from './RemoteTerminal';
import type { RemoteSystemType } from './types';

interface RemotePackageManagerProps {
  connectionId: string;
  systemType?: RemoteSystemType;
  onOpenTerminal?: (launchOptions?: RemoteTerminalLaunchOptions) => void;
}

interface PendingPackageAction {
  action: PackageAction;
  label: string;
  command: string;
  packageName?: string;
  danger?: boolean;
}

const packageViews: Array<{ key: Exclude<PackageView, 'search'>; label: string }> = [
  { key: 'upgradable', label: '可升级' },
  { key: 'installed', label: '已安装' },
];

function runCmd(connectionId: string, command: string) {
  const api = window.guiSSH?.connections;

  if (!api) {
    throw new Error('ShellDesk IPC 未就绪。');
  }

  return api.runCommand(connectionId, command);
}

function getPackageVersion(pkg: RemotePackageInfo) {
  if (pkg.upgradable && pkg.latestVersion) {
    return `${pkg.version ?? '-'} → ${pkg.latestVersion}`;
  }

  return pkg.version || pkg.latestVersion || '-';
}

function RemotePackageManager({ connectionId, systemType, onOpenTerminal }: RemotePackageManagerProps) {
  const isWindowsHost = isWindowsSystem(systemType);
  const [managerKind, setManagerKind] = useState<PackageManagerKind>('unknown');
  const [activeView, setActiveView] = useState<PackageView>('upgradable');
  const [packages, setPackages] = useState<RemotePackageInfo[]>([]);
  const [selectedName, setSelectedName] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [lastSearchQuery, setLastSearchQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [actionRunning, setActionRunning] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [lastRefreshedAt, setLastRefreshedAt] = useState('');
  const [pendingAction, setPendingAction] = useState<PendingPackageAction | null>(null);
  const loadRequestIdRef = useRef(0);
  const bootKeyRef = useRef('');

  const selectedPackage = useMemo(() => {
    return packages.find((pkg) => pkg.name === selectedName) ?? packages[0] ?? null;
  }, [packages, selectedName]);
  const selectedPrimaryAction = useMemo(() => {
    if (!selectedPackage) {
      return null;
    }

    if (selectedPackage.upgradable) {
      return { label: '升级', action: 'upgrade' as PackageAction, disabled: false };
    }

    if (selectedPackage.installed) {
      return { label: '已安装', action: null, disabled: true };
    }

    return { label: '安装', action: 'install' as PackageAction, disabled: false };
  }, [selectedPackage]);

  const detectManager = useCallback(async () => {
    setLoading(true);
    setError('');

    try {
      const result = await runCmd(connectionId, createDetectPackageManagerCommand(isWindowsHost));
      const kind = normalizePackageManager(result.stdout.split(/\r?\n/).find(Boolean) ?? 'unknown');
      setManagerKind(kind);
      return kind;
    } catch (error) {
      setError(getErrorMessage(error));
      return 'unknown' as PackageManagerKind;
    } finally {
      setLoading(false);
    }
  }, [connectionId, isWindowsHost]);

  const loadPackages = useCallback(async (view: PackageView, kind = managerKind, query = '') => {
    const requestId = loadRequestIdRef.current + 1;
    loadRequestIdRef.current = requestId;

    if (kind === 'unknown') {
      setPackages([]);
      setError('未检测到支持的包管理器。');
      return;
    }

    setLoading(true);
    setError('');
    setNotice('');
    setPackages([]);
    setSelectedName('');
    setActiveView(view);
    if (view === 'search') {
      setLastSearchQuery(query.trim());
    }

    try {
      const command = view === 'search'
        ? createPackageSearchCommand(kind, query)
        : createPackageListCommand(kind, view);
      const result = await runCmd(connectionId, command);

      if (requestId !== loadRequestIdRef.current) {
        return;
      }

      const nextPackages = parsePackageOutput(kind, view, result.stdout);
      setPackages(nextPackages);
      setSelectedName(nextPackages[0]?.name ?? '');
      setLastRefreshedAt(new Date().toLocaleTimeString(getShellDeskLocale()));
      if (result.stderr.trim()) {
        setNotice(result.stderr.trim());
      }
    } catch (error) {
      if (requestId !== loadRequestIdRef.current) {
        return;
      }

      setError(getErrorMessage(error));
    } finally {
      if (requestId === loadRequestIdRef.current) {
        setLoading(false);
      }
    }
  }, [connectionId, managerKind]);

  useEffect(() => {
    const bootKey = `${connectionId}:${isWindowsHost ? 'windows' : 'unix'}`;
    if (bootKeyRef.current === bootKey) {
      return;
    }
    bootKeyRef.current = bootKey;

    const boot = async () => {
      const kind = await detectManager();
      if (kind !== 'unknown') {
        await loadPackages('upgradable', kind);
      }
    };

    void boot();
  }, [detectManager, loadPackages]);

  const prepareAction = (action: PackageAction, pkg?: RemotePackageInfo) => {
    try {
      const packageName = pkg?.name;
      const command = createPackageActionCommand(managerKind, action, packageName);
      const labels: Record<PackageAction, string> = {
        install: '安装',
        remove: '卸载',
        upgrade: '升级',
        'upgrade-all': '升级全部',
        refresh: '刷新元数据',
      };

      setPendingAction({
        action,
        label: labels[action],
        command,
        packageName,
        danger: action === 'remove' || action === 'upgrade-all',
      });
    } catch (error) {
      setError(getErrorMessage(error));
    }
  };

  const copyPendingCommand = async () => {
    if (!pendingAction) return;
    await navigator.clipboard.writeText(pendingAction.command);
    setNotice('已复制命令。');
  };

  const runPendingInTerminal = () => {
    if (!pendingAction) return;
    onOpenTerminal?.({
      title: pendingAction.label,
      initialCommand: pendingAction.command,
    });
    setPendingAction(null);
  };

  const executePendingAction = async () => {
    if (!pendingAction) return;

    setActionRunning(true);
    setError('');
    setNotice('');

    try {
      const result = await runCmd(connectionId, pendingAction.command);
      setNotice(result.stdout || result.stderr || `${pendingAction.label}命令已执行。`);
      setPendingAction(null);
      await loadPackages(activeView, managerKind, activeView === 'search' ? lastSearchQuery : '');
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setActionRunning(false);
    }
  };

  return (
    <section className="package-manager">
      <header className="package-toolbar">
        <div className="package-status">
          <span>包管理器</span>
          <strong>{getPackageManagerLabel(managerKind)}</strong>
          {lastRefreshedAt ? <em>{lastRefreshedAt}</em> : null}
        </div>
        <div className="package-toolbar-actions">
          <button type="button" onClick={detectManager} disabled={loading}>重新检测</button>
          <button type="button" onClick={() => prepareAction('refresh')} disabled={managerKind === 'unknown'}>刷新元数据</button>
          <button type="button" className="primary" onClick={() => prepareAction('upgrade-all')} disabled={managerKind === 'unknown'}>升级全部</button>
        </div>
      </header>

      {error ? <div className="package-alert danger">{error}</div> : null}
      {notice ? <div className="package-alert info">{notice}</div> : null}

      <div className="package-layout">
        <aside className="package-sidebar">
          <div className="package-nav-group">
            <span className="package-sidebar-label">列表视图</span>
            <div className="package-tabs">
              {packageViews.map((view) => (
                <button
                  key={view.key}
                  type="button"
                  className={activeView === view.key ? 'active' : ''}
                  onClick={() => loadPackages(view.key)}
                  disabled={loading || managerKind === 'unknown'}
                >
                  {view.label}
                </button>
              ))}
            </div>
          </div>
          <div className="package-search-box">
            <span className="package-sidebar-label">仓库查询</span>
            <input
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void loadPackages('search', managerKind, searchQuery);
              }}
              placeholder="包名，例如 htop"
              aria-label="查询仓库包名"
            />
            <button type="button" onClick={() => loadPackages('search', managerKind, searchQuery)} disabled={loading || managerKind === 'unknown'}>
              查询包名
            </button>
          </div>
          {activeView === 'search' ? (
            <div className="package-search-state">
              <span>当前结果</span>
              <strong>{lastSearchQuery || '-'}</strong>
            </div>
          ) : null}
          <div className="package-summary">
            <strong>{packages.length}</strong>
            <span>{activeView === 'upgradable' ? '个可升级包' : activeView === 'installed' ? '个已安装包' : '条查询结果'}</span>
          </div>
        </aside>

        <main className="package-list-panel">
          <div className="package-table-wrap">
            <table className="package-table">
              <thead>
                <tr>
                  <th>包名</th>
                  <th>版本</th>
                  <th>说明</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {packages.map((pkg) => (
                  <tr key={`${pkg.name}-${pkg.version ?? pkg.latestVersion ?? ''}`} className={selectedPackage?.name === pkg.name ? 'selected' : ''} onClick={() => setSelectedName(pkg.name)}>
                    <td><strong>{pkg.name}</strong></td>
                    <td>{getPackageVersion(pkg)}</td>
                    <td title={pkg.description || pkg.source || ''}>{pkg.description || pkg.source || '-'}</td>
                    <td>{pkg.upgradable ? <span className="package-pill warning">可升级</span> : pkg.installed ? <span className="package-pill success">已安装</span> : <span className="package-pill">可安装</span>}</td>
                  </tr>
                ))}
                {!loading && packages.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="package-empty">没有包数据。</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </main>

        <aside className="package-detail-panel">
          {selectedPackage ? (
            <>
              <div className="package-detail-title">
                <span>包详情</span>
                <strong>{selectedPackage.name}</strong>
              </div>
              <dl>
                <div><dt>当前版本</dt><dd>{selectedPackage.version || '-'}</dd></div>
                <div><dt>最新版本</dt><dd>{selectedPackage.latestVersion || '-'}</dd></div>
                <div><dt>说明</dt><dd>{selectedPackage.description || selectedPackage.source || '-'}</dd></div>
              </dl>
              <div className="package-detail-actions">
                <button
                  type="button"
                  className="primary"
                  onClick={() => {
                    if (selectedPrimaryAction?.action) {
                      prepareAction(selectedPrimaryAction.action, selectedPackage);
                    }
                  }}
                  disabled={selectedPrimaryAction?.disabled}
                >
                  {selectedPrimaryAction?.label ?? '安装'}
                </button>
                <button type="button" className="danger" onClick={() => prepareAction('remove', selectedPackage)} disabled={!selectedPackage.installed}>卸载</button>
                <button type="button" onClick={() => navigator.clipboard.writeText(selectedPackage.name).then(() => setNotice('已复制包名。'))}>复制包名</button>
              </div>
              <div className="package-note">
                安装、卸载和升级会先展示命令。需要交互式 sudo 时，建议在终端中运行。
              </div>
            </>
          ) : (
            <div className="package-empty detail">选择一个包查看详情。</div>
          )}
        </aside>
      </div>

      {pendingAction ? createPortal(
        <div className="package-modal-backdrop" role="presentation" onClick={() => setPendingAction(null)}>
          <div className="package-confirm-dialog" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="package-confirm-header">
              <span>{pendingAction.danger ? '需要确认' : '确认命令'}</span>
              <strong>{pendingAction.label}{pendingAction.packageName ? ` ${pendingAction.packageName}` : ''}</strong>
            </div>
            <pre>{pendingAction.command}</pre>
            <div className="package-confirm-actions">
              <button type="button" onClick={() => setPendingAction(null)}>取消</button>
              <button type="button" onClick={copyPendingCommand}>复制命令</button>
              <button type="button" onClick={runPendingInTerminal} disabled={!onOpenTerminal}>终端运行</button>
              <button type="button" className={pendingAction.danger ? 'danger' : 'primary'} onClick={executePendingAction} disabled={actionRunning}>
                {actionRunning ? '执行中' : '直接执行'}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </section>
  );
}

export default RemotePackageManager;
