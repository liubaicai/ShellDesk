import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import DismissibleAlert from './DismissibleAlert';

import { getErrorMessage } from './desktopUtils';
import {
  createIptablesAddRuleCommand,
  createIptablesDeleteRuleCommand,
  createIptablesStatusCommand,
  getIptablesTargetLabel,
  getIptablesTargetTone,
  isRiskyIptablesDraft,
  parseIptablesSnapshot,
  type IptablesFamily,
  type IptablesPolicy,
  type IptablesRule,
  type IptablesRuleDraft,
  type IptablesSnapshot,
} from './iptablesProviders';
import { isWindowsSystem } from './remoteSystem';
import type { RemoteSystemType } from './types';

interface RemoteIptablesManagerProps {
  connectionId: string;
  systemType?: RemoteSystemType;
}

type IptablesTab = 'rules' | 'policies' | 'raw';
type IptablesFilterValue = 'all' | string;

interface PendingIptablesAction {
  title: string;
  command: string;
  note?: string;
  danger?: boolean;
  afterRun?: () => Promise<void>;
}

const initialDraft: IptablesRuleDraft = {
  family: 'ipv4',
  table: 'filter',
  chain: 'INPUT',
  target: 'ACCEPT',
  protocol: 'tcp',
  port: '80',
  source: '',
  destination: '',
  position: 'top',
  comment: '',
};

function runCmd(connectionId: string, command: string) {
  const api = window.guiSSH?.connections;

  if (!api) {
    throw new Error('ShellDesk IPC 未就绪。');
  }

  return api.runCommand(connectionId, command);
}

function uniqSorted(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort((first, second) => first.localeCompare(second));
}

function getFamilyLabel(family: string) {
  if (family === 'ipv4') return 'IPv4';
  if (family === 'ipv6') return 'IPv6';
  return family;
}

function getProtocolLabel(protocol?: string) {
  if (!protocol || protocol === 'any') return 'ANY';
  return protocol.toUpperCase();
}

function formatEndpoint(value?: string) {
  return value && value !== '0.0.0.0/0' && value !== '::/0' ? value : value || '-';
}

function formatRule(rule: IptablesRule) {
  return [
    `${getFamilyLabel(rule.family)} ${rule.table}/${rule.chain} #${rule.index}`,
    `动作：${getIptablesTargetLabel(rule.target)}`,
    `协议：${getProtocolLabel(rule.protocol)}`,
    `端口：${rule.destinationPort || '-'}`,
    `来源：${formatEndpoint(rule.source)}`,
    `目标：${formatEndpoint(rule.destination)}`,
    `备注：${rule.comment || '-'}`,
    '',
    rule.raw,
  ].join('\n');
}

function formatPolicy(policy: IptablesPolicy) {
  return `${getFamilyLabel(policy.family)} ${policy.table}/${policy.chain} ${policy.policy}${policy.counters ? ` ${policy.counters}` : ''}`;
}

function RemoteIptablesManager({ connectionId, systemType }: RemoteIptablesManagerProps) {
  const isWindowsHost = isWindowsSystem(systemType);
  const [snapshot, setSnapshot] = useState<IptablesSnapshot | null>(null);
  const [selectedRuleId, setSelectedRuleId] = useState('');
  const [draft, setDraft] = useState<IptablesRuleDraft>(initialDraft);
  const [tab, setTab] = useState<IptablesTab>('rules');
  const [filterFamily, setFilterFamily] = useState<IptablesFilterValue>('all');
  const [filterTable, setFilterTable] = useState<IptablesFilterValue>('all');
  const [filterChain, setFilterChain] = useState<IptablesFilterValue>('all');
  const [loading, setLoading] = useState(false);
  const [actionRunning, setActionRunning] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pendingAction, setPendingAction] = useState<PendingIptablesAction | null>(null);

  const filteredRules = useMemo(() => {
    return (snapshot?.rules ?? []).filter((rule) => (
      (filterFamily === 'all' || rule.family === filterFamily)
      && (filterTable === 'all' || rule.table === filterTable)
      && (filterChain === 'all' || rule.chain === filterChain)
    ));
  }, [filterChain, filterFamily, filterTable, snapshot?.rules]);

  const familyOptions = useMemo(() => uniqSorted((snapshot?.rules ?? []).map((rule) => rule.family)), [snapshot?.rules]);
  const tableOptions = useMemo(() => uniqSorted((snapshot?.rules ?? []).map((rule) => rule.table)), [snapshot?.rules]);
  const chainOptions = useMemo(() => {
    return uniqSorted((snapshot?.rules ?? [])
      .filter((rule) => filterFamily === 'all' || rule.family === filterFamily)
      .filter((rule) => filterTable === 'all' || rule.table === filterTable)
      .map((rule) => rule.chain));
  }, [filterFamily, filterTable, snapshot?.rules]);
  const selectedRule = useMemo(() => {
    return filteredRules.find((rule) => rule.id === selectedRuleId) ?? filteredRules[0] ?? null;
  }, [filteredRules, selectedRuleId]);
  const riskHint = useMemo(() => isRiskyIptablesDraft(draft), [draft]);

  const refreshIptables = useCallback(async () => {
    setError('');
    setNotice('');

    if (isWindowsHost) {
      setSnapshot(null);
      setError('iptables 管理器仅支持 Linux / Unix 主机。');
      return;
    }

    setLoading(true);

    try {
      const result = await runCmd(connectionId, createIptablesStatusCommand());
      const nextSnapshot = parseIptablesSnapshot(result.stdout, result.stderr);
      setSnapshot(nextSnapshot);
      setSelectedRuleId((currentId) => (
        nextSnapshot.rules.some((rule) => rule.id === currentId)
          ? currentId
          : nextSnapshot.rules[0]?.id ?? ''
      ));

      if (nextSnapshot.notice) {
        setNotice(nextSnapshot.notice);
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
    void refreshIptables();
  }, [refreshIptables]);

  const updateDraft = <Key extends keyof IptablesRuleDraft>(key: Key, value: IptablesRuleDraft[Key]) => {
    setDraft((currentDraft) => ({ ...currentDraft, [key]: value }));
  };

  const prepareAddRule = () => {
    if (!snapshot?.available) {
      return;
    }

    try {
      const command = createIptablesAddRuleCommand(draft);
      setPendingAction({
        title: `${draft.target} ${draft.chain}${draft.port.trim() ? ` ${draft.protocol}/${draft.port.trim()}` : ''}`,
        command,
        danger: riskHint,
        note: 'iptables 直接修改运行时规则，重启后可能丢失；如需持久化，请在目标系统使用既有的 iptables-save 或 netfilter-persistent 流程。',
        afterRun: refreshIptables,
      });
    } catch (error) {
      setError(getErrorMessage(error));
    }
  };

  const prepareDeleteRule = (rule: IptablesRule) => {
    try {
      setPendingAction({
        title: `删除 ${getFamilyLabel(rule.family)} ${rule.table}/${rule.chain} #${rule.index}`,
        command: createIptablesDeleteRuleCommand(rule),
        danger: true,
        note: '删除命令使用当前刷新结果里的链内序号。若远程主机规则刚被其他会话修改，请先刷新后再执行。',
        afterRun: refreshIptables,
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
        throw new Error(result.stderr || result.stdout || 'iptables 命令执行失败。');
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

  const copyRule = async (rule: IptablesRule) => {
    await navigator.clipboard.writeText(formatRule(rule));
    setNotice('已复制规则信息。');
  };

  return (
    <section className="iptables-manager">
      <header className="iptables-toolbar">
        <div className="iptables-status-block">
          <span>iptables</span>
          <strong>{snapshot?.available ? '规则链管理' : loading ? '检测中' : '未就绪'}</strong>
          <em>{snapshot?.status || (loading ? '读取中' : '未加载')}</em>
        </div>
        <div className="iptables-toolbar-actions">
          <button type="button" className="primary" onClick={refreshIptables} disabled={loading}>
            {loading ? '刷新中' : '刷新'}
          </button>
        </div>
      </header>

      {error ? <DismissibleAlert className="iptables-alert danger" onDismiss={() => setError('')} role="alert">{error}</DismissibleAlert> : null}
      {notice ? <DismissibleAlert className="iptables-alert info" onDismiss={() => setNotice('')}>{notice}</DismissibleAlert> : null}

      <div className="iptables-content">
        <aside className="iptables-form-panel">
          <div className="iptables-form-title">
            <span>新增规则</span>
            <strong>filter 链运行时规则</strong>
          </div>
          <label>
            <span>地址族</span>
            <select value={draft.family} onChange={(event) => updateDraft('family', event.target.value as IptablesFamily)}>
              <option value="ipv4">IPv4</option>
              <option value="ipv6">IPv6</option>
            </select>
          </label>
          <label>
            <span>表</span>
            <select value={draft.table} onChange={(event) => updateDraft('table', event.target.value as IptablesRuleDraft['table'])}>
              <option value="filter">filter</option>
              <option value="nat">nat</option>
              <option value="mangle">mangle</option>
              <option value="raw">raw</option>
              <option value="security">security</option>
            </select>
          </label>
          <label>
            <span>链</span>
            <input value={draft.chain} onChange={(event) => updateDraft('chain', event.target.value)} placeholder="INPUT / FORWARD / OUTPUT" />
          </label>
          <label>
            <span>动作</span>
            <select value={draft.target} onChange={(event) => updateDraft('target', event.target.value as IptablesRuleDraft['target'])}>
              <option value="ACCEPT">ACCEPT</option>
              <option value="DROP">DROP</option>
              <option value="REJECT">REJECT</option>
            </select>
          </label>
          <label>
            <span>协议</span>
            <select value={draft.protocol} onChange={(event) => updateDraft('protocol', event.target.value as IptablesRuleDraft['protocol'])}>
              <option value="tcp">TCP</option>
              <option value="udp">UDP</option>
              <option value="any">Any</option>
            </select>
          </label>
          <label>
            <span>目标端口</span>
            <input value={draft.port} onChange={(event) => updateDraft('port', event.target.value)} placeholder="80 或 8000-8010；留空表示不限端口" />
          </label>
          <label>
            <span>来源</span>
            <input value={draft.source} onChange={(event) => updateDraft('source', event.target.value)} placeholder="留空表示任意来源" />
          </label>
          <label>
            <span>目标地址</span>
            <input value={draft.destination} onChange={(event) => updateDraft('destination', event.target.value)} placeholder="留空表示任意目标" />
          </label>
          <label>
            <span>位置</span>
            <select value={draft.position} onChange={(event) => updateDraft('position', event.target.value as IptablesRuleDraft['position'])}>
              <option value="top">插入链首</option>
              <option value="append">追加链尾</option>
            </select>
          </label>
          <label>
            <span>备注</span>
            <input value={draft.comment} onChange={(event) => updateDraft('comment', event.target.value)} placeholder="默认写入 ShellDesk 标记" />
          </label>
          {riskHint ? (
            <div className="iptables-risk-note">
              该规则可能影响任意来源、整条链或常见敏感端口。请确认规则顺序和远程访问不会被锁死。
            </div>
          ) : null}
          <button type="button" className="iptables-add-button" onClick={prepareAddRule} disabled={!snapshot?.available || isWindowsHost}>
            生成并确认命令
          </button>

          <div className="iptables-detail">
            <span>选中规则</span>
            {selectedRule ? (
              <>
                <strong>{`${getFamilyLabel(selectedRule.family)} ${selectedRule.table}/${selectedRule.chain} #${selectedRule.index}`}</strong>
                <dl>
                  <div><dt>动作</dt><dd>{getIptablesTargetLabel(selectedRule.target)}</dd></div>
                  <div><dt>协议</dt><dd>{getProtocolLabel(selectedRule.protocol)}</dd></div>
                  <div><dt>端口</dt><dd>{selectedRule.destinationPort || '-'}</dd></div>
                  <div><dt>备注</dt><dd>{selectedRule.comment || '-'}</dd></div>
                </dl>
                <div className="iptables-detail-actions">
                  <button type="button" onClick={() => copyRule(selectedRule)}>复制</button>
                  <button type="button" className="danger" onClick={() => prepareDeleteRule(selectedRule)}>删除</button>
                </div>
              </>
            ) : (
              <p>选择规则后查看详情。</p>
            )}
          </div>
        </aside>

        <main className="iptables-main-panel">
          <div className="iptables-tabs">
            <div className="iptables-tab-buttons">
              <button type="button" className={tab === 'rules' ? 'active' : ''} onClick={() => setTab('rules')}>规则</button>
              <button type="button" className={tab === 'policies' ? 'active' : ''} onClick={() => setTab('policies')}>默认策略</button>
              <button type="button" className={tab === 'raw' ? 'active' : ''} onClick={() => setTab('raw')}>原始输出</button>
            </div>
            <span>{filteredRules.length} / {snapshot?.rules.length ?? 0} 条</span>
          </div>

          <div className="iptables-filters">
            <label>
              <span>地址族</span>
              <select value={filterFamily} onChange={(event) => setFilterFamily(event.target.value)}>
                <option value="all">全部</option>
                {familyOptions.map((family) => <option key={family} value={family}>{getFamilyLabel(family)}</option>)}
              </select>
            </label>
            <label>
              <span>表</span>
              <select value={filterTable} onChange={(event) => setFilterTable(event.target.value)}>
                <option value="all">全部</option>
                {tableOptions.map((table) => <option key={table} value={table}>{table}</option>)}
              </select>
            </label>
            <label>
              <span>链</span>
              <select value={filterChain} onChange={(event) => setFilterChain(event.target.value)}>
                <option value="all">全部</option>
                {chainOptions.map((chain) => <option key={chain} value={chain}>{chain}</option>)}
              </select>
            </label>
          </div>

          {tab === 'rules' ? (
            <div className="iptables-table-wrap">
              <table className="iptables-table">
                <thead>
                  <tr>
                    <th>族</th>
                    <th>表/链</th>
                    <th>#</th>
                    <th>动作</th>
                    <th>协议</th>
                    <th>端口</th>
                    <th>来源</th>
                    <th>目标</th>
                    <th>原始规则</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRules.map((rule) => (
                    <tr key={rule.id} className={selectedRule?.id === rule.id ? 'selected' : ''} onClick={() => setSelectedRuleId(rule.id)}>
                      <td>{getFamilyLabel(rule.family)}</td>
                      <td>{rule.table}/{rule.chain}</td>
                      <td>{rule.index}</td>
                      <td><span className={`iptables-target ${getIptablesTargetTone(rule.target)}`}>{getIptablesTargetLabel(rule.target)}</span></td>
                      <td>{getProtocolLabel(rule.protocol)}</td>
                      <td>{rule.destinationPort || '-'}</td>
                      <td title={rule.source}>{formatEndpoint(rule.source)}</td>
                      <td title={rule.destination}>{formatEndpoint(rule.destination)}</td>
                      <td title={rule.raw}>{rule.raw}</td>
                      <td>
                        <button type="button" onClick={(event) => { event.stopPropagation(); void copyRule(rule); }}>复制</button>
                        <button type="button" className="danger" onClick={(event) => { event.stopPropagation(); prepareDeleteRule(rule); }}>删除</button>
                      </td>
                    </tr>
                  ))}
                  {!loading && filteredRules.length === 0 ? (
                    <tr><td colSpan={10} className="iptables-empty">没有可展示的 iptables 规则。</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          ) : tab === 'policies' ? (
            <div className="iptables-policy-list">
              {(snapshot?.policies ?? []).map((policy) => (
                <div key={`${policy.family}:${policy.table}:${policy.chain}`} className="iptables-policy-row">
                  <strong>{formatPolicy(policy)}</strong>
                  <span>{policy.counters || '无计数器'}</span>
                </div>
              ))}
              {!loading && (!snapshot || snapshot.policies.length === 0) ? (
                <div className="iptables-empty">没有读取到默认策略。</div>
              ) : null}
            </div>
          ) : (
            <pre className="iptables-raw">{snapshot?.rawOutput || '尚未读取。'}</pre>
          )}
        </main>
      </div>

      {pendingAction ? createPortal(
        <div className="iptables-modal-backdrop" role="presentation" onClick={() => setPendingAction(null)}>
          <div className={`iptables-confirm-dialog ${pendingAction.danger ? 'danger' : ''}`} role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="iptables-confirm-header">
              <span>{pendingAction.danger ? '高风险命令确认' : '确认命令'}</span>
              <strong>{pendingAction.title}</strong>
            </div>
            {pendingAction.note ? <p>{pendingAction.note}</p> : null}
            <pre>{pendingAction.command}</pre>
            <div className="iptables-confirm-actions">
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

export default RemoteIptablesManager;
