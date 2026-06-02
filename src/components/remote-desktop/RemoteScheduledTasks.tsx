import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import DismissibleAlert from './DismissibleAlert';

import {
  createEmptyCronTask,
  describeCronExpression,
  parseCronText,
  serializeCronLines,
  validateCronTask,
  type CronLine,
} from './cronUtils';
import { getErrorMessage } from './desktopUtils';
import { isWindowsSystem, powershellCommand, powershellSingleQuote } from './remoteSystem';
import type { RemoteSystemType } from './types';
import { tCurrent } from '../../i18n';

interface RemoteScheduledTasksProps {
  connectionId: string;
  systemType?: RemoteSystemType;
}

interface SystemdTimerSummary {
  name: string;
  next?: string;
  left?: string;
  last?: string;
  passed?: string;
  unit?: string;
  raw: string;
}

interface WindowsTaskSummary {
  name: string;
  path: string;
  state: string;
  lastRunTime?: string;
  nextRunTime?: string;
}

type ScheduledTab = 'cron' | 'systemd' | 'windows';
type PendingAction = { title: string; command: string; afterRun?: () => Promise<void> };

function runCmd(connectionId: string, command: string) {
  const api = window.guiSSH?.connections;

  if (!api) {
    throw new Error(tCurrent('auto.remoteScheduledTasks.g77vf3'));
  }

  return api.runCommand(connectionId, command);
}

function shellSingleQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function withLinuxPrivilege(command: string) {
  return `if [ "$(id -u 2>/dev/null)" = "0" ]; then
${command}
else
sudo -n sh -c ${shellSingleQuote(command)}
fi`;
}

function createWriteCrontabCommand(content: string) {
  const marker = `SHELLDESK_CRON_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return `tmp="\${TMPDIR:-/tmp}/shelldesk-cron-$(date +%s)-$$"; cat > "$tmp" <<'${marker}'\n${content}\n${marker}\ncrontab "$tmp" && rm -f "$tmp"`;
}

function parseSystemdTimers(stdout: string): SystemdTimerSummary[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('NEXT ') && !line.startsWith('-') && !line.includes('timers listed'))
    .map((line) => {
      const unitMatch = line.match(/(\S+\.timer)\s+(\S+\.service|\S+)$/);
      const name = unitMatch?.[1] ?? line.split(/\s+/).find((part) => part.endsWith('.timer')) ?? line;
      const unit = unitMatch?.[2];
      const beforeName = line.slice(0, Math.max(0, line.indexOf(name))).trim();
      const parts = beforeName.split(/\s{2,}|\t+/).filter(Boolean);

      return {
        name,
        unit,
        next: parts[0],
        left: parts[1],
        last: parts[2],
        passed: parts[3],
        raw: line,
      };
    });
}

function formatWindowsTaskTimeValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const text = String(value).trim();
    const dotNetDateMatch = text.match(/^\/Date\((-?\d+)\)\/$/);

    if (dotNetDateMatch) {
      const timestamp = Number.parseInt(dotNetDateMatch[1], 10);

      if (Number.isFinite(timestamp)) {
        return new Date(timestamp).toLocaleString();
      }
    }

    return text === '0001-01-01T00:00:00' || text === '1899-12-30T00:00:00' ? '' : text;
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    return '';
  }

  const record = value as Record<string, unknown>;
  const candidates = [
    record.DateTime,
    record.value,
    record.Value,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' || typeof candidate === 'number') {
      const text = String(candidate).trim();

      if (text) {
        return text;
      }
    }
  }

  return '';
}

function parseWindowsTasks(stdout: string): WindowsTaskSummary[] {
  const trimmedText = stdout.trim();
  if (!trimmedText) return [];

  const parsedJson = JSON.parse(trimmedText) as unknown;
  const rows = Array.isArray(parsedJson) ? parsedJson : [parsedJson];

  return rows
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row))
    .map((row) => ({
      name: String(row.TaskName ?? '').trim(),
      path: String(row.TaskPath ?? '').trim(),
      state: String(row.State ?? '').trim(),
      lastRunTime: formatWindowsTaskTimeValue(row.LastRunTime),
      nextRunTime: formatWindowsTaskTimeValue(row.NextRunTime),
    }))
    .filter((task) => Boolean(task.name));
}

function createWindowsTasksCommand() {
  return powershellCommand(`
function Format-ShellDeskTaskTime($value) {
  if (-not $value -or $value.Year -le 1900) { return '' }
  return $value.ToString('yyyy-MM-dd HH:mm:ss')
}

Get-ScheduledTask | Select-Object -First 400 | ForEach-Object {
  $info = Get-ScheduledTaskInfo -TaskName $_.TaskName -TaskPath $_.TaskPath -ErrorAction SilentlyContinue
  [PSCustomObject]@{
    TaskName = $_.TaskName
    TaskPath = $_.TaskPath
    State = [string]$_.State
    LastRunTime = if ($info) { Format-ShellDeskTaskTime $info.LastRunTime } else { '' }
    NextRunTime = if ($info) { Format-ShellDeskTaskTime $info.NextRunTime } else { '' }
  }
} | ConvertTo-Json -Depth 4
`);
}

function createWindowsTaskActionCommand(action: 'enable' | 'disable' | 'start', task: WindowsTaskSummary) {
  const cmdlet = action === 'enable' ? 'Enable-ScheduledTask' : action === 'disable' ? 'Disable-ScheduledTask' : 'Start-ScheduledTask';
  return powershellCommand(`${cmdlet} -TaskName ${powershellSingleQuote(task.name)} -TaskPath ${powershellSingleQuote(task.path)}`);
}

function createSystemdTimerActionCommand(action: 'start' | 'stop' | 'enable' | 'disable', timer: SystemdTimerSummary) {
  return withLinuxPrivilege(`systemctl ${action} ${shellSingleQuote(timer.name)}`);
}

function RemoteScheduledTasks({ connectionId, systemType }: RemoteScheduledTasksProps) {
  const isWindowsHost = isWindowsSystem(systemType);
  const [activeTab, setActiveTab] = useState<ScheduledTab>(isWindowsHost ? 'windows' : 'cron');
  const [cronLines, setCronLines] = useState<CronLine[]>([]);
  const [selectedCronId, setSelectedCronId] = useState('');
  const [timers, setTimers] = useState<SystemdTimerSummary[]>([]);
  const [selectedTimerName, setSelectedTimerName] = useState('');
  const [windowsTasks, setWindowsTasks] = useState<WindowsTaskSummary[]>([]);
  const [selectedWindowsTaskName, setSelectedWindowsTaskName] = useState('');
  const [loading, setLoading] = useState(false);
  const [actionRunning, setActionRunning] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [rawCronVisible, setRawCronVisible] = useState(false);

  const selectedCron = useMemo(() => cronLines.find((line) => line.id === selectedCronId && line.kind === 'task') ?? cronLines.find((line) => line.kind === 'task') ?? null, [cronLines, selectedCronId]);
  const selectedTimer = useMemo(() => timers.find((timer) => timer.name === selectedTimerName) ?? timers[0] ?? null, [timers, selectedTimerName]);
  const selectedWindowsTask = useMemo(() => windowsTasks.find((task) => task.name === selectedWindowsTaskName) ?? windowsTasks[0] ?? null, [windowsTasks, selectedWindowsTaskName]);
  const rawCronText = useMemo(() => serializeCronLines(cronLines), [cronLines]);

  const loadCron = useCallback(async () => {
    setLoading(true);
    setError('');
    setNotice('');

    try {
      const result = await runCmd(connectionId, 'crontab -l 2>/dev/null || true');
      const lines = parseCronText(result.stdout);
      setCronLines(lines);
      setSelectedCronId(lines.find((line) => line.kind === 'task')?.id ?? '');
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  const loadTimers = useCallback(async () => {
    setLoading(true);
    setError('');
    setNotice('');

    try {
      const result = await runCmd(connectionId, 'systemctl list-timers --all --no-pager --plain 2>/dev/null || true');
      const nextTimers = parseSystemdTimers(result.stdout);
      setTimers(nextTimers);
      setSelectedTimerName(nextTimers[0]?.name ?? '');
      if (!nextTimers.length) setNotice(tCurrent('auto.remoteScheduledTasks.12a2yw8'));
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  const loadWindowsTasks = useCallback(async () => {
    setLoading(true);
    setError('');
    setNotice('');

    try {
      const result = await runCmd(connectionId, createWindowsTasksCommand());
      const nextTasks = parseWindowsTasks(result.stdout);
      setWindowsTasks(nextTasks);
      setSelectedWindowsTaskName(nextTasks[0]?.name ?? '');
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    if (activeTab === 'cron') void loadCron();
    if (activeTab === 'systemd') void loadTimers();
    if (activeTab === 'windows') void loadWindowsTasks();
  }, [activeTab, loadCron, loadTimers, loadWindowsTasks]);

  const updateSelectedCron = (patch: Partial<CronLine>) => {
    if (!selectedCron) return;
    setCronLines((lines) => lines.map((line) => (line.id === selectedCron.id ? { ...line, ...patch } : line)));
  };

  const addCronTask = () => {
    const task = createEmptyCronTask();
    setCronLines((lines) => [...lines, task]);
    setSelectedCronId(task.id);
  };

  const removeCronTask = () => {
    if (!selectedCron) return;
    setCronLines((lines) => lines.filter((line) => line.id !== selectedCron.id));
    setSelectedCronId('');
  };

  const prepareCronSave = () => {
    const invalidLine = cronLines.find((line) => validateCronTask(line));
    const validationError = invalidLine ? validateCronTask(invalidLine) : '';
    if (validationError) {
      setError(validationError);
      return;
    }

    setPendingAction({
      title: tCurrent('auto.remoteScheduledTasks.1v0h57v'),
      command: createWriteCrontabCommand(rawCronText),
      afterRun: loadCron,
    });
  };

  const executePendingAction = async () => {
    if (!pendingAction) return;

    setActionRunning(true);
    setError('');
    setNotice('');

    try {
      const result = await runCmd(connectionId, pendingAction.command);
      setNotice(result.stdout || result.stderr || tCurrent('auto.remoteScheduledTasks.1m6h6ak'));
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
    if (!pendingAction) return;
    await navigator.clipboard.writeText(pendingAction.command);
    setNotice(tCurrent('auto.remoteScheduledTasks.1ys75c3'));
  };

  return (
    <section className="scheduled-tasks">
      <header className="scheduled-toolbar">
        <div className="scheduled-tabs">
          <button type="button" className={activeTab === 'cron' ? 'active' : ''} onClick={() => setActiveTab('cron')}>Crontab</button>
          <button type="button" className={activeTab === 'systemd' ? 'active' : ''} onClick={() => setActiveTab('systemd')}>systemd Timer</button>
          <button type="button" className={activeTab === 'windows' ? 'active' : ''} onClick={() => setActiveTab('windows')}>{tCurrent('auto.remoteScheduledTasks.1m5ch6i')}</button>
        </div>
        <button type="button" onClick={() => (activeTab === 'cron' ? loadCron() : activeTab === 'systemd' ? loadTimers() : loadWindowsTasks())} disabled={loading}>
          {loading ? tCurrent('auto.remoteScheduledTasks.1taxqz1') : tCurrent('auto.remoteScheduledTasks.12qo56a')}
        </button>
      </header>

      {error ? <DismissibleAlert className="scheduled-alert danger" onDismiss={() => setError('')} role="alert">{error}</DismissibleAlert> : null}
      {notice ? <DismissibleAlert className="scheduled-alert info" onDismiss={() => setNotice('')}>{notice}</DismissibleAlert> : null}

      {activeTab === 'cron' ? (
        <div className="scheduled-layout cron">
          <aside className="scheduled-list">
            <div className="scheduled-list-head">
              <strong>Crontab</strong>
              <button type="button" onClick={addCronTask}>{tCurrent('auto.remoteScheduledTasks.159s6ub')}</button>
            </div>
            {cronLines.filter((line) => line.kind === 'task').map((line) => (
              <button key={line.id} type="button" className={selectedCron?.id === line.id ? 'active' : ''} onClick={() => setSelectedCronId(line.id)}>
                <strong>{line.command || tCurrent('auto.remoteScheduledTasks.g7befz')}</strong>
                <span>{line.enabled ? tCurrent('auto.remoteScheduledTasks.5pm2ma') : tCurrent('auto.remoteScheduledTasks.1dcdrxo')} · {line.minute} {line.hour} {line.dayOfMonth} {line.month} {line.dayOfWeek}</span>
              </button>
            ))}
            {cronLines.filter((line) => line.kind === 'task').length === 0 ? <div className="scheduled-empty">{tCurrent('auto.remoteScheduledTasks.1bd18l6')}</div> : null}
          </aside>

          <main className="cron-editor">
            {selectedCron ? (
              <>
                <div className="cron-grid">
                  <label><span>{tCurrent('auto.remoteScheduledTasks.1cm49zm')}</span><input value={selectedCron.minute} onChange={(event) => updateSelectedCron({ minute: event.target.value })} /></label>
                  <label><span>{tCurrent('auto.remoteScheduledTasks.e8ttp4')}</span><input value={selectedCron.hour} onChange={(event) => updateSelectedCron({ hour: event.target.value })} /></label>
                  <label><span>{tCurrent('auto.remoteScheduledTasks.14s86i5')}</span><input value={selectedCron.dayOfMonth} onChange={(event) => updateSelectedCron({ dayOfMonth: event.target.value })} /></label>
                  <label><span>{tCurrent('auto.remoteScheduledTasks.1fsw60u')}</span><input value={selectedCron.month} onChange={(event) => updateSelectedCron({ month: event.target.value })} /></label>
                  <label><span>{tCurrent('auto.remoteScheduledTasks.7id25f')}</span><input value={selectedCron.dayOfWeek} onChange={(event) => updateSelectedCron({ dayOfWeek: event.target.value })} /></label>
                </div>
                <label className="cron-command">
                  <span>{tCurrent('auto.remoteScheduledTasks.emgxwk')}</span>
                  <input value={selectedCron.command} onChange={(event) => updateSelectedCron({ command: event.target.value })} />
                </label>
                <div className="cron-hint">{describeCronExpression(selectedCron)}</div>
                <div className="cron-actions">
                  <button type="button" className="primary" onClick={prepareCronSave}>{tCurrent('auto.remoteScheduledTasks.1v0h57v2')}</button>
                  <button type="button" onClick={() => updateSelectedCron({ enabled: !selectedCron.enabled })}>{selectedCron.enabled ? tCurrent('auto.remoteScheduledTasks.1dcdrxo2') : tCurrent('auto.remoteScheduledTasks.5pm2ma2')}</button>
                  <button type="button" className="danger" onClick={removeCronTask}>{tCurrent('auto.remoteScheduledTasks.1t2vi4h')}</button>
                  <button type="button" onClick={() => setRawCronVisible((visible) => !visible)}>{rawCronVisible ? tCurrent('auto.remoteScheduledTasks.1vnw8am') : tCurrent('auto.remoteScheduledTasks.1n84b87')}</button>
                </div>
                {rawCronVisible ? <pre className="cron-raw">{rawCronText || tCurrent('auto.remoteScheduledTasks.dioqvr')}</pre> : null}
              </>
            ) : (
              <div className="scheduled-empty detail">{tCurrent('auto.remoteScheduledTasks.dqufdr')}</div>
            )}
          </main>
        </div>
      ) : null}

      {activeTab === 'systemd' ? (
        <div className="scheduled-table-panel systemd-timers">
          <table className="scheduled-table systemd-table">
            <colgroup>
              <col className="timer-col-name" />
              <col className="timer-col-next" />
              <col className="timer-col-left" />
              <col className="timer-col-last" />
              <col className="timer-col-unit" />
              <col className="timer-col-actions" />
            </colgroup>
            <thead><tr><th>Timer</th><th>{tCurrent('auto.remoteScheduledTasks.3t8cj5')}</th><th>{tCurrent('auto.remoteScheduledTasks.1cqxrfr')}</th><th>{tCurrent('auto.remoteScheduledTasks.dssrsk')}</th><th>Unit</th><th>{tCurrent('auto.remoteScheduledTasks.501w24')}</th></tr></thead>
            <tbody>
              {timers.map((timer) => (
                <tr key={timer.name} className={selectedTimer?.name === timer.name ? 'selected' : ''} onClick={() => setSelectedTimerName(timer.name)}>
                  <td><strong>{timer.name}</strong></td>
                  <td>{timer.next || '-'}</td>
                  <td>{timer.left || '-'}</td>
                  <td>{timer.last || '-'}</td>
                  <td>{timer.unit || '-'}</td>
                  <td className="scheduled-actions-cell">
                    <button type="button" onClick={(event) => { event.stopPropagation(); setPendingAction({ title: tCurrent('auto.remoteScheduledTasks.30kjgb', { value0: timer.name }), command: createSystemdTimerActionCommand('start', timer), afterRun: loadTimers }); }}>{tCurrent('auto.remoteScheduledTasks.155xe0y')}</button>
                    <button type="button" onClick={(event) => { event.stopPropagation(); setPendingAction({ title: tCurrent('auto.remoteScheduledTasks.10geya8', { value0: timer.name }), command: createSystemdTimerActionCommand('stop', timer), afterRun: loadTimers }); }}>{tCurrent('auto.remoteScheduledTasks.1pnni9n')}</button>
                    <button type="button" onClick={(event) => { event.stopPropagation(); setPendingAction({ title: tCurrent('auto.remoteScheduledTasks.s67jej', { value0: timer.name }), command: createSystemdTimerActionCommand('enable', timer), afterRun: loadTimers }); }}>{tCurrent('auto.remoteScheduledTasks.5pm2ma3')}</button>
                    <button type="button" onClick={(event) => { event.stopPropagation(); setPendingAction({ title: tCurrent('auto.remoteScheduledTasks.1ewbgjl', { value0: timer.name }), command: createSystemdTimerActionCommand('disable', timer), afterRun: loadTimers }); }}>{tCurrent('auto.remoteScheduledTasks.1dcdrxo3')}</button>
                  </td>
                </tr>
              ))}
              {!timers.length ? <tr><td colSpan={6} className="scheduled-empty-cell">{tCurrent('auto.remoteScheduledTasks.7a0bp6')}</td></tr> : null}
            </tbody>
          </table>
        </div>
      ) : null}

      {activeTab === 'windows' ? (
        <div className="scheduled-table-panel windows-tasks">
          <table className="scheduled-table">
            <thead><tr><th>{tCurrent('auto.remoteScheduledTasks.cm180x')}</th><th>{tCurrent('auto.remoteScheduledTasks.c8pdny')}</th><th>{tCurrent('auto.remoteScheduledTasks.1ccx4t4')}</th><th>{tCurrent('auto.remoteScheduledTasks.1h2g8kg')}</th><th>{tCurrent('auto.remoteScheduledTasks.1o2ffot')}</th><th>{tCurrent('auto.remoteScheduledTasks.501w242')}</th></tr></thead>
            <tbody>
              {windowsTasks.map((task) => (
                <tr key={`${task.path}-${task.name}`} className={selectedWindowsTask?.name === task.name ? 'selected' : ''} onClick={() => setSelectedWindowsTaskName(task.name)}>
                  <td><strong>{task.name}</strong></td>
                  <td>{task.path}</td>
                  <td><span className="scheduled-pill">{task.state || '-'}</span></td>
                  <td>{task.lastRunTime || '-'}</td>
                  <td>{task.nextRunTime || '-'}</td>
                  <td className="scheduled-actions-cell">
                    <button type="button" onClick={(event) => { event.stopPropagation(); setPendingAction({ title: tCurrent('auto.remoteScheduledTasks.hqi816', { value0: task.name }), command: createWindowsTaskActionCommand('start', task), afterRun: loadWindowsTasks }); }}>{tCurrent('auto.remoteScheduledTasks.1kn0p6h')}</button>
                    <button type="button" onClick={(event) => { event.stopPropagation(); setPendingAction({ title: tCurrent('auto.remoteScheduledTasks.s67jej2', { value0: task.name }), command: createWindowsTaskActionCommand('enable', task), afterRun: loadWindowsTasks }); }}>{tCurrent('auto.remoteScheduledTasks.5pm2ma4')}</button>
                    <button type="button" onClick={(event) => { event.stopPropagation(); setPendingAction({ title: tCurrent('auto.remoteScheduledTasks.1ewbgjl2', { value0: task.name }), command: createWindowsTaskActionCommand('disable', task), afterRun: loadWindowsTasks }); }}>{tCurrent('auto.remoteScheduledTasks.1dcdrxo4')}</button>
                  </td>
                </tr>
              ))}
              {!windowsTasks.length ? <tr><td colSpan={6} className="scheduled-empty-cell">{tCurrent('auto.remoteScheduledTasks.1r3qxxs')}</td></tr> : null}
            </tbody>
          </table>
        </div>
      ) : null}

      {pendingAction ? createPortal(
        <div className="scheduled-modal-backdrop" role="presentation" onClick={() => setPendingAction(null)}>
          <div className="scheduled-confirm-dialog" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="scheduled-confirm-header">
              <span>{tCurrent('auto.remoteScheduledTasks.1gm39ou')}</span>
              <strong>{pendingAction.title}</strong>
            </div>
            <pre>{pendingAction.command}</pre>
            <div className="scheduled-confirm-actions">
              <button type="button" onClick={() => setPendingAction(null)}>{tCurrent('auto.remoteScheduledTasks.1589w37')}</button>
              <button type="button" onClick={copyPendingCommand}>{tCurrent('auto.remoteScheduledTasks.qxd4qr')}</button>
              <button type="button" className="primary" onClick={executePendingAction} disabled={actionRunning}>{actionRunning ? tCurrent('auto.remoteScheduledTasks.6svkbt') : tCurrent('auto.remoteScheduledTasks.6azgji')}</button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </section>
  );
}

export default RemoteScheduledTasks;
