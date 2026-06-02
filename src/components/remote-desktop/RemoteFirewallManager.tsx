import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import DismissibleAlert from './DismissibleAlert';

import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import {
  createFirewallAddRuleCommand,
  createFirewallDeleteRuleCommand,
  createFirewallReloadCommand,
  createFirewallSetEnabledCommand,
  createFirewallStatusCommand,
  getFirewallBackendLabel,
  isFirewallEnabled,
  isFirewallSshPortAllowed,
  isRiskyFirewallDraft,
  parseFirewallSnapshot,
  type FirewallRule,
  type FirewallRuleDraft,
  type FirewallSnapshot,
} from './firewallProviders';
import { isWindowsSystem } from './remoteSystem';
import type { RemoteSystemType } from './types';
import { tCurrent } from '../../i18n';

interface RemoteFirewallManagerProps {
  connectionId: string;
  sshPort: number;
  systemType?: RemoteSystemType;
}

type FirewallTab = 'rules' | 'raw';

interface PendingFirewallAction {
  title: string;
  command: string;
  description?: string;
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
    throw new Error(tCurrent('auto.remoteFirewallManager.g77vf3'));
  }

  return api.runCommand(connectionId, command);
}

function getActionLabel(action: FirewallRule['action']) {
  if (action === 'allow') return tCurrent('auto.remoteFirewallManager.11bz44c');
  if (action === 'deny') return tCurrent('auto.remoteFirewallManager.1qrntx4');
  if (action === 'reject') return tCurrent('auto.remoteFirewallManager.1y9ly2h');
  if (action === 'limit') return tCurrent('auto.remoteFirewallManager.11z7j5c');
  return tCurrent('auto.remoteFirewallManager.1lpnuh4');
}

function getProtocolLabel(protocol?: FirewallRule['protocol']) {
  if (protocol === 'tcp') return 'TCP';
  if (protocol === 'udp') return 'UDP';
  if (protocol === 'any') return 'ANY';
  return '-';
}

function formatRule(rule: FirewallRule) {
  return [
    tCurrent('auto.remoteFirewallManager.e9yzls', { value0: getActionLabel(rule.action) }),
    tCurrent('auto.remoteFirewallManager.snmvc3', { value0: getProtocolLabel(rule.protocol) }),
    tCurrent('auto.remoteFirewallManager.1nxunke', { value0: rule.port || '-' }),
    tCurrent('auto.remoteFirewallManager.9537r7', { value0: rule.source || '-' }),
    tCurrent('auto.remoteFirewallManager.q05xva', { value0: rule.direction || '-' }),
    tCurrent('auto.remoteFirewallManager.f6igbh', { value0: rule.target || '-' }),
    '',
    rule.raw,
  ].join('\n');
}

function isInactiveUfwSnapshot(snapshot: FirewallSnapshot) {
  return snapshot.backend === 'ufw' && /inactive|\u4e0d\u6d3b\u52a8|\u672a\u542f\u7528|\u505c\u7528/i.test(snapshot.status);
}

function RemoteFirewallManager({ connectionId, sshPort, systemType }: RemoteFirewallManagerProps) {
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
  const canToggleFirewall = Boolean(snapshot && (snapshot.backend === 'ufw' || snapshot.backend === 'firewalld'));
  const firewallEnabled = snapshot ? isFirewallEnabled(snapshot) : false;

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
        setNotice(result.stderr || result.stdout || tCurrent('auto.remoteFirewallManager.44dttz'));
      } else if (isInactiveUfwSnapshot(nextSnapshot)) {
        setNotice(tCurrent('auto.remoteFirewallManager.1nwvtug'));
      } else if (nextSnapshot.backend === 'firewalld' && !isFirewallEnabled(nextSnapshot)) {
        setNotice(tCurrent('auto.remoteFirewallManager.1p7xlqd'));
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
        title: tCurrent('auto.remoteFirewallManager.mgaey3', { value0: rule.target || rule.port || rule.id }),
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
        title: tCurrent('auto.remoteFirewallManager.1y6e5fr'),
        command: createFirewallReloadCommand(snapshot.backend),
        afterRun: refreshFirewall,
      });
    } catch (error) {
      setError(getErrorMessage(error));
    }
  };

  const prepareSetFirewallEnabled = (enabled: boolean) => {
    if (!snapshot) {
      return;
    }

    try {
      const command = createFirewallSetEnabledCommand(snapshot.backend, enabled);
      const sshPortAllowed = isFirewallSshPortAllowed(snapshot, sshPort);
      const missingSshRuleWarning = enabled && !sshPortAllowed
        ? tCurrent('auto.remoteFirewallManager.14ddiq3', { value0: sshPort })
        : '';

      setPendingAction({
        title: enabled ? tCurrent('auto.remoteFirewallManager.19kpgmg') : tCurrent('auto.remoteFirewallManager.1yno50l'),
        command,
        description: missingSshRuleWarning || (enabled
          ? tCurrent('auto.remoteFirewallManager.nk3yh3')
          : tCurrent('auto.remoteFirewallManager.yrtpie')),
        danger: !enabled || Boolean(missingSshRuleWarning),
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
        throw new Error(result.stderr || result.stdout || tCurrent('auto.remoteFirewallManager.kzqb0h'));
      }

      setNotice(result.stdout || result.stderr || tCurrent('auto.remoteFirewallManager.1m6h6ak'));
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
    setNotice(tCurrent('auto.remoteFirewallManager.1ys75c3'));
  };

  const copyRule = async (rule: FirewallRule) => {
    await navigator.clipboard.writeText(formatRule(rule));
    setNotice(tCurrent('auto.remoteFirewallManager.1bovukl'));
  };

  return (
    <section className="firewall-manager">
      <header className="firewall-toolbar">
        <div className="firewall-status-block">
          <span>{tCurrent('auto.remoteFirewallManager.1209dfd')}</span>
          <strong>{snapshot ? getFirewallBackendLabel(snapshot.backend) : tCurrent('auto.remoteFirewallManager.xr2jgj')}</strong>
          <em>{snapshot?.status || (loading ? tCurrent('auto.remoteFirewallManager.10y5j8r') : tCurrent('auto.remoteFirewallManager.18vm84u'))}</em>
        </div>
        <div className="firewall-toolbar-actions">
          <button type="button" className="primary" onClick={refreshFirewall} disabled={loading}>
            {loading ? tCurrent('auto.remoteFirewallManager.1taxqz1') : tCurrent('auto.remoteFirewallManager.12qo56a')}
          </button>
          <button type="button" className="primary" onClick={() => prepareSetFirewallEnabled(true)} disabled={!canToggleFirewall || firewallEnabled || actionRunning}>
            {tCurrent('auto.remoteFirewallManager.5pm2ma')}</button>
          <button type="button" className="danger" onClick={() => prepareSetFirewallEnabled(false)} disabled={!canToggleFirewall || !firewallEnabled || actionRunning}>
            {tCurrent('auto.remoteFirewallManager.6q9o5l')}</button>
          <button type="button" onClick={prepareReload} disabled={!snapshot || snapshot.backend === 'unknown'}>
            Reload
          </button>
          <span>{snapshot?.defaultPolicy || tCurrent('auto.remoteFirewallManager.unhp5')}{refreshedAt ? ` · ${refreshedAt}` : ''}</span>
        </div>
      </header>

      {error ? <DismissibleAlert className="firewall-alert danger" onDismiss={() => setError('')} role="alert">{error}</DismissibleAlert> : null}
      {notice ? <DismissibleAlert className="firewall-alert info" onDismiss={() => setNotice('')}>{notice}</DismissibleAlert> : null}

      <div className="firewall-content">
        <aside className="firewall-form-panel">
          <div className="firewall-form-title">
            <span>{tCurrent('auto.remoteFirewallManager.66ztdg')}</span>
            <strong>{tCurrent('auto.remoteFirewallManager.w5xi8w')}</strong>
          </div>
          <label>
            <span>{tCurrent('auto.remoteFirewallManager.1d335ap')}</span>
            <select value={draft.action} onChange={(event) => updateDraft('action', event.target.value as FirewallRuleDraft['action'])}>
              <option value="allow">{tCurrent('auto.remoteFirewallManager.11bz44c2')}</option>
              <option value="deny">{tCurrent('auto.remoteFirewallManager.1qrntx42')}</option>
              <option value="reject">{tCurrent('auto.remoteFirewallManager.1y9ly2h2')}</option>
            </select>
          </label>
          <label>
            <span>{tCurrent('auto.remoteFirewallManager.7j43ow')}</span>
            <select value={draft.protocol} onChange={(event) => updateDraft('protocol', event.target.value as FirewallRuleDraft['protocol'])}>
              <option value="tcp">TCP</option>
              <option value="udp">UDP</option>
              <option value="any">Any</option>
            </select>
          </label>
          <label>
            <span>{tCurrent('auto.remoteFirewallManager.19ijc5j')}</span>
            <input value={draft.port} onChange={(event) => updateDraft('port', event.target.value)} placeholder={tCurrent('auto.remoteFirewallManager.18tmk8t')} />
          </label>
          <label>
            <span>{tCurrent('auto.remoteFirewallManager.2tds9c')}</span>
            <input value={draft.source} onChange={(event) => updateDraft('source', event.target.value)} placeholder={tCurrent('auto.remoteFirewallManager.m2z9iz')} />
          </label>
          {riskHint ? (
            <div className="firewall-risk-note">
              {tCurrent('auto.remoteFirewallManager.18z0ik0')}</div>
          ) : null}
          <button type="button" className="firewall-add-button" onClick={prepareAddRule} disabled={!snapshot || snapshot.backend === 'unknown'}>
            {tCurrent('auto.remoteFirewallManager.1i8qzb')}</button>

          <div className="firewall-detail">
            <span>{tCurrent('auto.remoteFirewallManager.byif8s')}</span>
            {selectedRule ? (
              <>
                <strong>{selectedRule.target || selectedRule.port || selectedRule.id}</strong>
                <dl>
                  <div><dt>{tCurrent('auto.remoteFirewallManager.1d335ap2')}</dt><dd>{getActionLabel(selectedRule.action)}</dd></div>
                  <div><dt>{tCurrent('auto.remoteFirewallManager.7j43ow2')}</dt><dd>{getProtocolLabel(selectedRule.protocol)}</dd></div>
                  <div><dt>{tCurrent('auto.remoteFirewallManager.2tds9c2')}</dt><dd>{selectedRule.source || '-'}</dd></div>
                  <div><dt>{tCurrent('auto.remoteFirewallManager.3tp9vj')}</dt><dd>{selectedRule.direction || '-'}</dd></div>
                </dl>
                <div className="firewall-detail-actions">
                  <button type="button" onClick={() => copyRule(selectedRule)}>{tCurrent('auto.remoteFirewallManager.1xbipwq')}</button>
                  <button type="button" className="danger" onClick={() => prepareDeleteRule(selectedRule)}>{tCurrent('auto.remoteFirewallManager.1t2vi4h')}</button>
                </div>
              </>
            ) : (
              <p>{tCurrent('auto.remoteFirewallManager.qke2u3')}</p>
            )}
          </div>
        </aside>

        <main className="firewall-main-panel">
          <div className="firewall-tabs">
            <button type="button" className={tab === 'rules' ? 'active' : ''} onClick={() => setTab('rules')}>{tCurrent('auto.remoteFirewallManager.16w14qm')}</button>
            <button type="button" className={tab === 'raw' ? 'active' : ''} onClick={() => setTab('raw')}>{tCurrent('auto.remoteFirewallManager.1sxtwbe')}</button>
            <span>{snapshot?.zone ? `Zone ${snapshot.zone} · ` : ''}{snapshot?.rules.length ?? 0} {tCurrent('auto.remoteFirewallManager.1rfm5gs')}</span>
          </div>

          {tab === 'rules' ? (
            <div className="firewall-table-wrap">
              <table className="firewall-table">
                <thead>
                  <tr>
                    <th>{tCurrent('auto.remoteFirewallManager.1d335ap3')}</th>
                    <th>{tCurrent('auto.remoteFirewallManager.7j43ow3')}</th>
                    <th>{tCurrent('auto.remoteFirewallManager.1cjvky2')}</th>
                    <th>{tCurrent('auto.remoteFirewallManager.2tds9c3')}</th>
                    <th>{tCurrent('auto.remoteFirewallManager.3tp9vj2')}</th>
                    <th>{tCurrent('auto.remoteFirewallManager.1d31yso')}</th>
                    <th>{tCurrent('auto.remoteFirewallManager.501w24')}</th>
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
                          <button type="button" onClick={(event) => { event.stopPropagation(); void copyRule(rule); }}>{tCurrent('auto.remoteFirewallManager.1xbipwq2')}</button>
                          <button type="button" className="danger" onClick={(event) => { event.stopPropagation(); prepareDeleteRule(rule); }}>{tCurrent('auto.remoteFirewallManager.1t2vi4h2')}</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {!loading && (!snapshot || snapshot.rules.length === 0) ? (
                    <tr><td colSpan={7} className="firewall-empty">{tCurrent('auto.remoteFirewallManager.rtesm4')}</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          ) : (
            <pre className="firewall-raw">{snapshot?.rawOutput || tCurrent('auto.remoteFirewallManager.xo22k2')}</pre>
          )}
        </main>
      </div>

      {pendingAction ? createPortal(
        <div className="firewall-modal-backdrop" role="presentation" onClick={() => setPendingAction(null)}>
          <div className={`firewall-confirm-dialog ${pendingAction.danger ? 'danger' : ''}`} role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="firewall-confirm-header">
              <span>{pendingAction.danger ? tCurrent('auto.remoteFirewallManager.jeo5v1') : tCurrent('auto.remoteFirewallManager.17ojhw6')}</span>
              <strong>{pendingAction.title}</strong>
            </div>
            {pendingAction.description ? <p>{pendingAction.description}</p> : null}
            <pre>{pendingAction.command}</pre>
            <div className="firewall-confirm-actions">
              <button type="button" onClick={() => setPendingAction(null)}>{tCurrent('auto.remoteFirewallManager.1589w37')}</button>
              <button type="button" onClick={copyPendingCommand}>{tCurrent('auto.remoteFirewallManager.qxd4qr')}</button>
              <button type="button" className={pendingAction.danger ? 'danger' : 'primary'} onClick={executePendingAction} disabled={actionRunning}>
                {actionRunning ? tCurrent('auto.remoteFirewallManager.6svkbt') : tCurrent('auto.remoteFirewallManager.6azgji')}
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
