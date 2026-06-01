import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import DismissibleAlert from './DismissibleAlert';

import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import {
  createFirewallAddRuleCommand,
  createFirewallDeleteRuleCommand,
  createFirewallReloadCommand,
  createFirewallStatusCommand,
  getFirewallBackendLabel,
  isRiskyFirewallDraft,
  parseFirewallSnapshot,
  type FirewallRule,
  type FirewallRuleDraft,
  type FirewallSnapshot,
} from './firewallProviders';
import { isWindowsSystem } from './remoteSystem';
import type { RemoteSystemType } from './types';

interface RemoteFirewallManagerProps {
  connectionId: string;
  systemType?: RemoteSystemType;
}

type FirewallTab = 'rules' | 'raw';

interface PendingFirewallAction {
  title: string;
  command: string;
  danger?: boolean;
  afterRun?: () => Promise<void>;
}

const initialDraft: FirewallRuleDraft = {
  action: 'allow',
  protocol: 'tcp',
  port: '80',
  source: '',
};

function runCmd(connectionId: string, command: string) {
  const api = window.guiSSH?.connections;

  if (!api) {
    throw new Error('ShellDesk IPC 未就绪。');
  }

  return api.runCommand(connectionId, command);
}

function getActionLabel(action: FirewallRule['action']) {
  if (action === 'allow') return '允许';
  if (action === 'deny') return '拒绝';
  if (action === 'reject') return '拒收';
  if (action === 'limit') return '限速';
  return '未知';
}

function getProtocolLabel(protocol?: FirewallRule['protocol']) {
  if (protocol === 'tcp') return 'TCP';
  if (protocol === 'udp') return 'UDP';
  if (protocol === 'any') return 'ANY';
  return '-';
}

function formatRule(rule: FirewallRule) {
  return [
    `动作：${getActionLabel(rule.action)}`,
    `协议：${getProtocolLabel(rule.protocol)}`,
    `端口：${rule.port || '-'}`,
    `来源：${rule.source || '-'}`,
    `方向：${rule.direction || '-'}`,
    `目标：${rule.target || '-'}`,
    '',
    rule.raw,
  ].join('\n');
}

function isInactiveUfwSnapshot(snapshot: FirewallSnapshot) {
  return snapshot.backend === 'ufw' && /inactive|不活动|未启用|停用/i.test(snapshot.status);
}

function RemoteFirewallManager({ connectionId, systemType }: RemoteFirewallManagerProps) {
  const isWindowsHost = isWindowsSystem(systemType);
  const [snapshot, setSnapshot] = useState<FirewallSnapshot | null>(null);
  const [selectedRuleId, setSelectedRuleId] = useState('');
  const [draft, setDraft] = useState<FirewallRuleDraft>(initialDraft);
  const [tab, setTab] = useState<FirewallTab>('rules');
  const [loading, setLoading] = useState(false);
  const [actionRunning, setActionRunning] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refreshedAt, setRefreshedAt] = useState('');
  const [pendingAction, setPendingAction] = useState<PendingFirewallAction | null>(null);

  const selectedRule = useMemo(() => {
    return snapshot?.rules.find((rule) => rule.id === selectedRuleId) ?? snapshot?.rules[0] ?? null;
  }, [selectedRuleId, snapshot?.rules]);

  const riskHint = useMemo(() => isRiskyFirewallDraft(draft), [draft]);

  const refreshFirewall = useCallback(async () => {
    setLoading(true);
    setError('');
    setNotice('');

    try {
      const result = await runCmd(connectionId, createFirewallStatusCommand(isWindowsHost));
      const nextSnapshot = parseFirewallSnapshot(result.stdout, result.stderr, isWindowsHost);
      setSnapshot(nextSnapshot);
      setSelectedRuleId((currentId) => (nextSnapshot.rules.some((rule) => rule.id === currentId) ? currentId : nextSnapshot.rules[0]?.id ?? ''));
      setRefreshedAt(new Date().toLocaleTimeString(getShellDeskLocale()));

      if (result.code !== 0 && nextSnapshot.backend === 'unknown') {
        setNotice(result.stderr || result.stdout || '未检测到可用防火墙工具。');
      } else if (isInactiveUfwSnapshot(nextSnapshot)) {
        setNotice('UFW 当前未启用，列表中的规则只存在于配置中，不会拦截端口。确认 SSH 规则后，可在终端执行 sudo ufw enable。');
      } else if (result.stderr.trim()) {
        setNotice(result.stderr.trim());
      }
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [connectionId, isWindowsHost]);

  useEffect(() => {
    void refreshFirewall();
  }, [refreshFirewall]);

  const updateDraft = <Key extends keyof FirewallRuleDraft>(key: Key, value: FirewallRuleDraft[Key]) => {
    setDraft((currentDraft) => ({ ...currentDraft, [key]: value }));
  };

  const prepareAddRule = () => {
    if (!snapshot) {
      return;
    }

    try {
      const command = createFirewallAddRuleCommand(snapshot.backend, draft, snapshot.zone);
      setPendingAction({
        title: `${getActionLabel(draft.action)} ${draft.port}/${draft.protocol === 'any' ? 'tcp' : draft.protocol}`,
        command,
        danger: riskHint,
        afterRun: refreshFirewall,
      });
    } catch (error) {
      setError(getErrorMessage(error));
    }
  };

  const prepareDeleteRule = (rule: FirewallRule) => {
    if (!snapshot) {
      return;
    }

    try {
      setPendingAction({
        title: `删除规则 ${rule.target || rule.port || rule.id}`,
        command: createFirewallDeleteRuleCommand(snapshot.backend, rule, snapshot.zone),
        danger: true,
        afterRun: refreshFirewall,
      });
    } catch (error) {
      setError(getErrorMessage(error));
    }
  };

  const prepareReload = () => {
    if (!snapshot) {
      return;
    }

    try {
      setPendingAction({
        title: '重新加载防火墙',
        command: createFirewallReloadCommand(snapshot.backend),
        afterRun: refreshFirewall,
      });
    } catch (error) {
      setError(getErrorMessage(error));
    }
  };

  const executePendingAction = async () => {
    if (!pendingAction) {
      return;
    }

    setActionRunning(true);
    setError('');
    setNotice('');

    try {
      const result = await runCmd(connectionId, pendingAction.command);

      if (result.code !== 0) {
        throw new Error(result.stderr || result.stdout || '防火墙命令执行失败。');
      }

      setNotice(result.stdout || result.stderr || '操作已完成。');
      const afterRun = pendingAction.afterRun;
      setPendingAction(null);
      await afterRun?.();
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setActionRunning(false);
    }
  };

  const copyPendingCommand = async () => {
    if (!pendingAction) {
      return;
    }

    await navigator.clipboard.writeText(pendingAction.command);
    setNotice('已复制命令。');
  };

  const copyRule = async (rule: FirewallRule) => {
    await navigator.clipboard.writeText(formatRule(rule));
    setNotice('已复制规则信息。');
  };

  return (
    <section className="firewall-manager">
      <header className="firewall-toolbar">
        <div className="firewall-status-block">
          <span>防火墙</span>
          <strong>{snapshot ? getFirewallBackendLabel(snapshot.backend) : '检测中'}</strong>
          <em>{snapshot?.status || (loading ? '读取中' : '未加载')}</em>
        </div>
        <div className="firewall-toolbar-actions">
          <button type="button" className="primary" onClick={refreshFirewall} disabled={loading}>
            {loading ? '刷新中' : '刷新'}
          </button>
          <button type="button" onClick={prepareReload} disabled={!snapshot || snapshot.backend === 'unknown'}>
            Reload
          </button>
          <span>{snapshot?.defaultPolicy || '默认策略未知'}{refreshedAt ? ` · ${refreshedAt}` : ''}</span>
        </div>
      </header>

      {error ? <DismissibleAlert className="firewall-alert danger" onDismiss={() => setError('')} role="alert">{error}</DismissibleAlert> : null}
      {notice ? <DismissibleAlert className="firewall-alert info" onDismiss={() => setNotice('')}>{notice}</DismissibleAlert> : null}

      <div className="firewall-content">
        <aside className="firewall-form-panel">
          <div className="firewall-form-title">
            <span>新增规则</span>
            <strong>开放或拒绝端口</strong>
          </div>
          <label>
            <span>动作</span>
            <select value={draft.action} onChange={(event) => updateDraft('action', event.target.value as FirewallRuleDraft['action'])}>
              <option value="allow">允许</option>
              <option value="deny">拒绝</option>
              <option value="reject">拒收</option>
            </select>
          </label>
          <label>
            <span>协议</span>
            <select value={draft.protocol} onChange={(event) => updateDraft('protocol', event.target.value as FirewallRuleDraft['protocol'])}>
              <option value="tcp">TCP</option>
              <option value="udp">UDP</option>
              <option value="any">Any</option>
            </select>
          </label>
          <label>
            <span>端口</span>
            <input value={draft.port} onChange={(event) => updateDraft('port', event.target.value)} placeholder="80 或 8000-8010" />
          </label>
          <label>
            <span>来源</span>
            <input value={draft.source} onChange={(event) => updateDraft('source', event.target.value)} placeholder="留空表示任意来源" />
          </label>
          {riskHint ? (
            <div className="firewall-risk-note">
              该规则可能对任意来源开放，或涉及常见敏感端口，请确认来源地址和服务暴露范围。
            </div>
          ) : null}
          <button type="button" className="firewall-add-button" onClick={prepareAddRule} disabled={!snapshot || snapshot.backend === 'unknown'}>
            生成并确认命令
          </button>

          <div className="firewall-detail">
            <span>选中规则</span>
            {selectedRule ? (
              <>
                <strong>{selectedRule.target || selectedRule.port || selectedRule.id}</strong>
                <dl>
                  <div><dt>动作</dt><dd>{getActionLabel(selectedRule.action)}</dd></div>
                  <div><dt>协议</dt><dd>{getProtocolLabel(selectedRule.protocol)}</dd></div>
                  <div><dt>来源</dt><dd>{selectedRule.source || '-'}</dd></div>
                  <div><dt>方向</dt><dd>{selectedRule.direction || '-'}</dd></div>
                </dl>
                <div className="firewall-detail-actions">
                  <button type="button" onClick={() => copyRule(selectedRule)}>复制</button>
                  <button type="button" className="danger" onClick={() => prepareDeleteRule(selectedRule)}>删除</button>
                </div>
              </>
            ) : (
              <p>选择规则后查看详情。</p>
            )}
          </div>
        </aside>

        <main className="firewall-main-panel">
          <div className="firewall-tabs">
            <button type="button" className={tab === 'rules' ? 'active' : ''} onClick={() => setTab('rules')}>规则</button>
            <button type="button" className={tab === 'raw' ? 'active' : ''} onClick={() => setTab('raw')}>原始输出</button>
            <span>{snapshot?.zone ? `Zone ${snapshot.zone} · ` : ''}{snapshot?.rules.length ?? 0} 条</span>
          </div>

          {tab === 'rules' ? (
            <div className="firewall-table-wrap">
              <table className="firewall-table">
                <thead>
                  <tr>
                    <th>动作</th>
                    <th>协议</th>
                    <th>端口/服务</th>
                    <th>来源</th>
                    <th>方向</th>
                    <th>原始规则</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot?.rules.map((rule) => (
                    <tr key={rule.id} className={selectedRule?.id === rule.id ? 'selected' : ''} onClick={() => setSelectedRuleId(rule.id)}>
                      <td><span className={`firewall-action ${rule.action}`}>{getActionLabel(rule.action)}</span></td>
                      <td>{getProtocolLabel(rule.protocol)}</td>
                      <td>{rule.port || rule.target || '-'}</td>
                      <td title={rule.source}>{rule.source || '-'}</td>
                      <td>{rule.direction || '-'}</td>
                      <td title={rule.raw}>{rule.raw}</td>
                      <td className="firewall-table-actions">
                        <div>
                          <button type="button" onClick={(event) => { event.stopPropagation(); void copyRule(rule); }}>复制</button>
                          <button type="button" className="danger" onClick={(event) => { event.stopPropagation(); prepareDeleteRule(rule); }}>删除</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {!loading && (!snapshot || snapshot.rules.length === 0) ? (
                    <tr><td colSpan={7} className="firewall-empty">没有可展示的防火墙规则。</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          ) : (
            <pre className="firewall-raw">{snapshot?.rawOutput || '尚未读取。'}</pre>
          )}
        </main>
      </div>

      {pendingAction ? createPortal(
        <div className="firewall-modal-backdrop" role="presentation" onClick={() => setPendingAction(null)}>
          <div className={`firewall-confirm-dialog ${pendingAction.danger ? 'danger' : ''}`} role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="firewall-confirm-header">
              <span>{pendingAction.danger ? '高风险操作确认' : '确认命令'}</span>
              <strong>{pendingAction.title}</strong>
            </div>
            <pre>{pendingAction.command}</pre>
            <div className="firewall-confirm-actions">
              <button type="button" onClick={() => setPendingAction(null)}>取消</button>
              <button type="button" onClick={copyPendingCommand}>复制命令</button>
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

export default RemoteFirewallManager;
