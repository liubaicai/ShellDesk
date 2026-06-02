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
import { tCurrent } from '../../i18n';

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
    throw new Error(tCurrent('auto.remoteIptablesManager.g77vf3'));
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
    tCurrent('auto.remoteIptablesManager.e9yzls', { value0: getIptablesTargetLabel(rule.target) }),
    tCurrent('auto.remoteIptablesManager.snmvc3', { value0: getProtocolLabel(rule.protocol) }),
    tCurrent('auto.remoteIptablesManager.1nxunke', { value0: rule.destinationPort || '-' }),
    tCurrent('auto.remoteIptablesManager.9537r7', { value0: formatEndpoint(rule.source) }),
    tCurrent('auto.remoteIptablesManager.f6igbh', { value0: formatEndpoint(rule.destination) }),
    tCurrent('auto.remoteIptablesManager.1ol3kmt', { value0: rule.comment || '-' }),
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
      setError(tCurrent('auto.remoteIptablesManager.14dazbv'));
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
        note: tCurrent('auto.remoteIptablesManager.1h9qazr'),
        afterRun: refreshIptables,
      });
    } catch (error) {
      setError(getErrorMessage(error));
    }
  };

  const prepareDeleteRule = (rule: IptablesRule) => {
    try {
      setPendingAction({
        title: tCurrent('auto.remoteIptablesManager.13tdd7z', { value0: getFamilyLabel(rule.family), value1: rule.table, value2: rule.chain, value3: rule.index }),
        command: createIptablesDeleteRuleCommand(rule),
        danger: true,
        note: tCurrent('auto.remoteIptablesManager.1l9hppx'),
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
        throw new Error(result.stderr || result.stdout || tCurrent('auto.remoteIptablesManager.1bjgsa7'));
      }

      setNotice(result.stdout || result.stderr || tCurrent('auto.remoteIptablesManager.1m6h6ak'));
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
    setNotice(tCurrent('auto.remoteIptablesManager.1ys75c3'));
  };

  const copyRule = async (rule: IptablesRule) => {
    await navigator.clipboard.writeText(formatRule(rule));
    setNotice(tCurrent('auto.remoteIptablesManager.1bovukl'));
  };

  return (
    <section className="iptables-manager">
      <header className="iptables-toolbar">
        <div className="iptables-status-block">
          <span>iptables</span>
          <strong>{snapshot?.available ? tCurrent('auto.remoteIptablesManager.10v1p4f') : loading ? tCurrent('auto.remoteIptablesManager.xr2jgj') : tCurrent('auto.remoteIptablesManager.8p4owa')}</strong>
          <em>{snapshot?.status || (loading ? tCurrent('auto.remoteIptablesManager.10y5j8r') : tCurrent('auto.remoteIptablesManager.18vm84u'))}</em>
        </div>
        <div className="iptables-toolbar-actions">
          <button type="button" className="primary" onClick={refreshIptables} disabled={loading}>
            {loading ? tCurrent('auto.remoteIptablesManager.1taxqz1') : tCurrent('auto.remoteIptablesManager.12qo56a')}
          </button>
        </div>
      </header>

      {error ? <DismissibleAlert className="iptables-alert danger" onDismiss={() => setError('')} role="alert">{error}</DismissibleAlert> : null}
      {notice ? <DismissibleAlert className="iptables-alert info" onDismiss={() => setNotice('')}>{notice}</DismissibleAlert> : null}

      <div className="iptables-content">
        <aside className="iptables-form-panel">
          <div className="iptables-form-title">
            <span>{tCurrent('auto.remoteIptablesManager.66ztdg')}</span>
            <strong>{tCurrent('auto.remoteIptablesManager.rvg2du')}</strong>
          </div>
          <label>
            <span>{tCurrent('auto.remoteIptablesManager.99o8m')}</span>
            <select value={draft.family} onChange={(event) => updateDraft('family', event.target.value as IptablesFamily)}>
              <option value="ipv4">IPv4</option>
              <option value="ipv6">IPv6</option>
            </select>
          </label>
          <label>
            <span>{tCurrent('auto.remoteIptablesManager.1tjg76f')}</span>
            <select value={draft.table} onChange={(event) => updateDraft('table', event.target.value as IptablesRuleDraft['table'])}>
              <option value="filter">filter</option>
              <option value="nat">nat</option>
              <option value="mangle">mangle</option>
              <option value="raw">raw</option>
              <option value="security">security</option>
            </select>
          </label>
          <label>
            <span>{tCurrent('auto.remoteIptablesManager.xvyyu9')}</span>
            <input value={draft.chain} onChange={(event) => updateDraft('chain', event.target.value)} placeholder="INPUT / FORWARD / OUTPUT" />
          </label>
          <label>
            <span>{tCurrent('auto.remoteIptablesManager.1d335ap')}</span>
            <select value={draft.target} onChange={(event) => updateDraft('target', event.target.value as IptablesRuleDraft['target'])}>
              <option value="ACCEPT">ACCEPT</option>
              <option value="DROP">DROP</option>
              <option value="REJECT">REJECT</option>
            </select>
          </label>
          <label>
            <span>{tCurrent('auto.remoteIptablesManager.7j43ow')}</span>
            <select value={draft.protocol} onChange={(event) => updateDraft('protocol', event.target.value as IptablesRuleDraft['protocol'])}>
              <option value="tcp">TCP</option>
              <option value="udp">UDP</option>
              <option value="any">Any</option>
            </select>
          </label>
          <label>
            <span>{tCurrent('auto.remoteIptablesManager.12fgbrw')}</span>
            <input value={draft.port} onChange={(event) => updateDraft('port', event.target.value)} placeholder={tCurrent('auto.remoteIptablesManager.14nvkrk')} />
          </label>
          <label>
            <span>{tCurrent('auto.remoteIptablesManager.2tds9c')}</span>
            <input value={draft.source} onChange={(event) => updateDraft('source', event.target.value)} placeholder={tCurrent('auto.remoteIptablesManager.m2z9iz')} />
          </label>
          <label>
            <span>{tCurrent('auto.remoteIptablesManager.w4v742')}</span>
            <input value={draft.destination} onChange={(event) => updateDraft('destination', event.target.value)} placeholder={tCurrent('auto.remoteIptablesManager.1c4we71')} />
          </label>
          <label>
            <span>{tCurrent('auto.remoteIptablesManager.1r64x4y')}</span>
            <select value={draft.position} onChange={(event) => updateDraft('position', event.target.value as IptablesRuleDraft['position'])}>
              <option value="top">{tCurrent('auto.remoteIptablesManager.1bsb0r8')}</option>
              <option value="append">{tCurrent('auto.remoteIptablesManager.197zqro')}</option>
            </select>
          </label>
          <label>
            <span>{tCurrent('auto.remoteIptablesManager.b5m1l6')}</span>
            <input value={draft.comment} onChange={(event) => updateDraft('comment', event.target.value)} placeholder={tCurrent('auto.remoteIptablesManager.153ze6z')} />
          </label>
          {riskHint ? (
            <div className="iptables-risk-note">
              {tCurrent('auto.remoteIptablesManager.a4x7au')}</div>
          ) : null}
          <button type="button" className="iptables-add-button" onClick={prepareAddRule} disabled={!snapshot?.available || isWindowsHost}>
            {tCurrent('auto.remoteIptablesManager.1i8qzb')}</button>

          <div className="iptables-detail">
            <span>{tCurrent('auto.remoteIptablesManager.byif8s')}</span>
            {selectedRule ? (
              <>
                <strong>{`${getFamilyLabel(selectedRule.family)} ${selectedRule.table}/${selectedRule.chain} #${selectedRule.index}`}</strong>
                <dl>
                  <div><dt>{tCurrent('auto.remoteIptablesManager.1d335ap2')}</dt><dd>{getIptablesTargetLabel(selectedRule.target)}</dd></div>
                  <div><dt>{tCurrent('auto.remoteIptablesManager.7j43ow2')}</dt><dd>{getProtocolLabel(selectedRule.protocol)}</dd></div>
                  <div><dt>{tCurrent('auto.remoteIptablesManager.19ijc5j')}</dt><dd>{selectedRule.destinationPort || '-'}</dd></div>
                  <div><dt>{tCurrent('auto.remoteIptablesManager.b5m1l62')}</dt><dd>{selectedRule.comment || '-'}</dd></div>
                </dl>
                <div className="iptables-detail-actions">
                  <button type="button" onClick={() => copyRule(selectedRule)}>{tCurrent('auto.remoteIptablesManager.1xbipwq')}</button>
                  <button type="button" className="danger" onClick={() => prepareDeleteRule(selectedRule)}>{tCurrent('auto.remoteIptablesManager.1t2vi4h')}</button>
                </div>
              </>
            ) : (
              <p>{tCurrent('auto.remoteIptablesManager.qke2u3')}</p>
            )}
          </div>
        </aside>

        <main className="iptables-main-panel">
          <div className="iptables-tabs">
            <div className="iptables-tab-buttons">
              <button type="button" className={tab === 'rules' ? 'active' : ''} onClick={() => setTab('rules')}>{tCurrent('auto.remoteIptablesManager.16w14qm')}</button>
              <button type="button" className={tab === 'policies' ? 'active' : ''} onClick={() => setTab('policies')}>{tCurrent('auto.remoteIptablesManager.10xmwzs')}</button>
              <button type="button" className={tab === 'raw' ? 'active' : ''} onClick={() => setTab('raw')}>{tCurrent('auto.remoteIptablesManager.1sxtwbe')}</button>
            </div>
            <span>{filteredRules.length} / {snapshot?.rules.length ?? 0} {tCurrent('auto.remoteIptablesManager.1rfm5gs')}</span>
          </div>

          <div className="iptables-filters">
            <label>
              <span>{tCurrent('auto.remoteIptablesManager.99o8m2')}</span>
              <select value={filterFamily} onChange={(event) => setFilterFamily(event.target.value)}>
                <option value="all">{tCurrent('auto.remoteIptablesManager.q6w6ul')}</option>
                {familyOptions.map((family) => <option key={family} value={family}>{getFamilyLabel(family)}</option>)}
              </select>
            </label>
            <label>
              <span>{tCurrent('auto.remoteIptablesManager.1tjg76f2')}</span>
              <select value={filterTable} onChange={(event) => setFilterTable(event.target.value)}>
                <option value="all">{tCurrent('auto.remoteIptablesManager.q6w6ul2')}</option>
                {tableOptions.map((table) => <option key={table} value={table}>{table}</option>)}
              </select>
            </label>
            <label>
              <span>{tCurrent('auto.remoteIptablesManager.xvyyu92')}</span>
              <select value={filterChain} onChange={(event) => setFilterChain(event.target.value)}>
                <option value="all">{tCurrent('auto.remoteIptablesManager.q6w6ul3')}</option>
                {chainOptions.map((chain) => <option key={chain} value={chain}>{chain}</option>)}
              </select>
            </label>
          </div>

          {tab === 'rules' ? (
            <div className="iptables-table-wrap">
              <table className="iptables-table">
                <thead>
                  <tr>
                    <th>{tCurrent('auto.remoteIptablesManager.kp6xfi')}</th>
                    <th>{tCurrent('auto.remoteIptablesManager.1ss090i')}</th>
                    <th>#</th>
                    <th>{tCurrent('auto.remoteIptablesManager.1d335ap3')}</th>
                    <th>{tCurrent('auto.remoteIptablesManager.7j43ow3')}</th>
                    <th>{tCurrent('auto.remoteIptablesManager.19ijc5j2')}</th>
                    <th>{tCurrent('auto.remoteIptablesManager.2tds9c2')}</th>
                    <th>{tCurrent('auto.remoteIptablesManager.1xibtz6')}</th>
                    <th>{tCurrent('auto.remoteIptablesManager.1d31yso')}</th>
                    <th>{tCurrent('auto.remoteIptablesManager.501w24')}</th>
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
                        <button type="button" onClick={(event) => { event.stopPropagation(); void copyRule(rule); }}>{tCurrent('auto.remoteIptablesManager.1xbipwq2')}</button>
                        <button type="button" className="danger" onClick={(event) => { event.stopPropagation(); prepareDeleteRule(rule); }}>{tCurrent('auto.remoteIptablesManager.1t2vi4h2')}</button>
                      </td>
                    </tr>
                  ))}
                  {!loading && filteredRules.length === 0 ? (
                    <tr><td colSpan={10} className="iptables-empty">{tCurrent('auto.remoteIptablesManager.fqotxw')}</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          ) : tab === 'policies' ? (
            <div className="iptables-policy-list">
              {(snapshot?.policies ?? []).map((policy) => (
                <div key={`${policy.family}:${policy.table}:${policy.chain}`} className="iptables-policy-row">
                  <strong>{formatPolicy(policy)}</strong>
                  <span>{policy.counters || tCurrent('auto.remoteIptablesManager.a3cmci')}</span>
                </div>
              ))}
              {!loading && (!snapshot || snapshot.policies.length === 0) ? (
                <div className="iptables-empty">{tCurrent('auto.remoteIptablesManager.109ibg7')}</div>
              ) : null}
            </div>
          ) : (
            <pre className="iptables-raw">{snapshot?.rawOutput || tCurrent('auto.remoteIptablesManager.xo22k2')}</pre>
          )}
        </main>
      </div>

      {pendingAction ? createPortal(
        <div className="iptables-modal-backdrop" role="presentation" onClick={() => setPendingAction(null)}>
          <div className={`iptables-confirm-dialog ${pendingAction.danger ? 'danger' : ''}`} role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="iptables-confirm-header">
              <span>{pendingAction.danger ? tCurrent('auto.remoteIptablesManager.kbpg3p') : tCurrent('auto.remoteIptablesManager.17ojhw6')}</span>
              <strong>{pendingAction.title}</strong>
            </div>
            {pendingAction.note ? <p>{pendingAction.note}</p> : null}
            <pre>{pendingAction.command}</pre>
            <div className="iptables-confirm-actions">
              <button type="button" onClick={() => setPendingAction(null)}>{tCurrent('auto.remoteIptablesManager.1589w37')}</button>
              <button type="button" onClick={copyPendingCommand}>{tCurrent('auto.remoteIptablesManager.qxd4qr')}</button>
              <button type="button" className={pendingAction.danger ? 'danger' : 'primary'} onClick={executePendingAction} disabled={actionRunning}>
                {actionRunning ? tCurrent('auto.remoteIptablesManager.6svkbt') : tCurrent('auto.remoteIptablesManager.6azgji')}
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
