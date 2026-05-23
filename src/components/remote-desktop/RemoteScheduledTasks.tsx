import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

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
    throw new Error('ShellDesk IPC 未就绪。');
  }

  return api.runCommand(connectionId, command);
}

function shellSingleQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
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
      lastRunTime: String(row.LastRunTime ?? '').trim(),
      nextRunTime: String(row.NextRunTime ?? '').trim(),
    }))
    .filter((task) => Boolean(task.name));
}

function createWindowsTasksCommand() {
  return powershellCommand(`
Get-ScheduledTask | Select-Object -First 400 TaskName,TaskPath,State,@{Name='LastRunTime';Expression={(Get-ScheduledTaskInfo -TaskName $_.TaskName -TaskPath $_.TaskPath -ErrorAction SilentlyContinue).LastRunTime}},@{Name='NextRunTime';Expression={(Get-ScheduledTaskInfo -TaskName $_.TaskName -TaskPath $_.TaskPath -ErrorAction SilentlyContinue).NextRunTime}} | ConvertTo-Json -Depth 4
`);
}

function createWindowsTaskActionCommand(action: 'enable' | 'disable' | 'start', task: WindowsTaskSummary) {
  const cmdlet = action === 'enable' ? 'Enable-ScheduledTask' : action === 'disable' ? 'Disable-ScheduledTask' : 'Start-ScheduledTask';
  return powershellCommand(`${cmdlet} -TaskName ${powershellSingleQuote(task.name)} -TaskPath ${powershellSingleQuote(task.path)}`);
}

function createSystemdTimerActionCommand(action: 'start' | 'stop' | 'enable' | 'disable', timer: SystemdTimerSummary) {
  return `systemctl ${action} ${shellSingleQuote(timer.name)}`;
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
      if (!nextTimers.length) setNotice('未读取到 systemd timer，目标系统可能不使用 systemd。');
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
      title: '保存 crontab',
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
    if (!pendingAction) return;
    await navigator.clipboard.writeText(pendingAction.command);
    setNotice('已复制命令。');
  };

  return (
    <section className="scheduled-tasks">
      <header className="scheduled-toolbar">
        <div className="scheduled-tabs">
          <button type="button" className={activeTab === 'cron' ? 'active' : ''} onClick={() => setActiveTab('cron')}>Crontab</button>
          <button type="button" className={activeTab === 'systemd' ? 'active' : ''} onClick={() => setActiveTab('systemd')}>systemd Timer</button>
          <button type="button" className={activeTab === 'windows' ? 'active' : ''} onClick={() => setActiveTab('windows')}>Windows 任务</button>
        </div>
        <button type="button" onClick={() => (activeTab === 'cron' ? loadCron() : activeTab === 'systemd' ? loadTimers() : loadWindowsTasks())} disabled={loading}>
          {loading ? '刷新中' : '刷新'}
        </button>
      </header>

      {error ? <div className="scheduled-alert danger">{error}</div> : null}
      {notice ? <div className="scheduled-alert info">{notice}</div> : null}

      {activeTab === 'cron' ? (
        <div className="scheduled-layout cron">
          <aside className="scheduled-list">
            <div className="scheduled-list-head">
              <strong>Crontab</strong>
              <button type="button" onClick={addCronTask}>新增</button>
            </div>
            {cronLines.filter((line) => line.kind === 'task').map((line) => (
              <button key={line.id} type="button" className={selectedCron?.id === line.id ? 'active' : ''} onClick={() => setSelectedCronId(line.id)}>
                <strong>{line.command || '未命名任务'}</strong>
                <span>{line.enabled ? '启用' : '禁用'} · {line.minute} {line.hour} {line.dayOfMonth} {line.month} {line.dayOfWeek}</span>
              </button>
            ))}
            {cronLines.filter((line) => line.kind === 'task').length === 0 ? <div className="scheduled-empty">当前 crontab 没有任务。</div> : null}
          </aside>

          <main className="cron-editor">
            {selectedCron ? (
              <>
                <div className="cron-grid">
                  <label><span>分钟</span><input value={selectedCron.minute} onChange={(event) => updateSelectedCron({ minute: event.target.value })} /></label>
                  <label><span>小时</span><input value={selectedCron.hour} onChange={(event) => updateSelectedCron({ hour: event.target.value })} /></label>
                  <label><span>日期</span><input value={selectedCron.dayOfMonth} onChange={(event) => updateSelectedCron({ dayOfMonth: event.target.value })} /></label>
                  <label><span>月份</span><input value={selectedCron.month} onChange={(event) => updateSelectedCron({ month: event.target.value })} /></label>
                  <label><span>星期</span><input value={selectedCron.dayOfWeek} onChange={(event) => updateSelectedCron({ dayOfWeek: event.target.value })} /></label>
                </div>
                <label className="cron-command">
                  <span>命令</span>
                  <input value={selectedCron.command} onChange={(event) => updateSelectedCron({ command: event.target.value })} />
                </label>
                <div className="cron-hint">{describeCronExpression(selectedCron)}</div>
                <div className="cron-actions">
                  <button type="button" className="primary" onClick={prepareCronSave}>保存 crontab</button>
                  <button type="button" onClick={() => updateSelectedCron({ enabled: !selectedCron.enabled })}>{selectedCron.enabled ? '禁用' : '启用'}</button>
                  <button type="button" className="danger" onClick={removeCronTask}>删除</button>
                  <button type="button" onClick={() => setRawCronVisible((visible) => !visible)}>{rawCronVisible ? '隐藏原文' : '查看原文'}</button>
                </div>
                {rawCronVisible ? <pre className="cron-raw">{rawCronText || '# 空 crontab'}</pre> : null}
              </>
            ) : (
              <div className="scheduled-empty detail">选择或新增一个任务。</div>
            )}
          </main>
        </div>
      ) : null}

      {activeTab === 'systemd' ? (
        <div className="scheduled-table-panel">
          <table className="scheduled-table">
            <thead><tr><th>Timer</th><th>下次</th><th>剩余</th><th>上次</th><th>Unit</th><th>操作</th></tr></thead>
            <tbody>
              {timers.map((timer) => (
                <tr key={timer.name} className={selectedTimer?.name === timer.name ? 'selected' : ''} onClick={() => setSelectedTimerName(timer.name)}>
                  <td><strong>{timer.name}</strong></td>
                  <td>{timer.next || '-'}</td>
                  <td>{timer.left || '-'}</td>
                  <td>{timer.last || '-'}</td>
                  <td>{timer.unit || '-'}</td>
                  <td>
                    <button type="button" onClick={(event) => { event.stopPropagation(); setPendingAction({ title: `启动 ${timer.name}`, command: createSystemdTimerActionCommand('start', timer), afterRun: loadTimers }); }}>启动</button>
                    <button type="button" onClick={(event) => { event.stopPropagation(); setPendingAction({ title: `停止 ${timer.name}`, command: createSystemdTimerActionCommand('stop', timer), afterRun: loadTimers }); }}>停止</button>
                    <button type="button" onClick={(event) => { event.stopPropagation(); setPendingAction({ title: `启用 ${timer.name}`, command: createSystemdTimerActionCommand('enable', timer), afterRun: loadTimers }); }}>启用</button>
                    <button type="button" onClick={(event) => { event.stopPropagation(); setPendingAction({ title: `禁用 ${timer.name}`, command: createSystemdTimerActionCommand('disable', timer), afterRun: loadTimers }); }}>禁用</button>
                  </td>
                </tr>
              ))}
              {!timers.length ? <tr><td colSpan={6} className="scheduled-empty-cell">没有 timer 数据。</td></tr> : null}
            </tbody>
          </table>
        </div>
      ) : null}

      {activeTab === 'windows' ? (
        <div className="scheduled-table-panel">
          <table className="scheduled-table">
            <thead><tr><th>任务</th><th>路径</th><th>状态</th><th>上次运行</th><th>下次运行</th><th>操作</th></tr></thead>
            <tbody>
              {windowsTasks.map((task) => (
                <tr key={`${task.path}-${task.name}`} className={selectedWindowsTask?.name === task.name ? 'selected' : ''} onClick={() => setSelectedWindowsTaskName(task.name)}>
                  <td><strong>{task.name}</strong></td>
                  <td>{task.path}</td>
                  <td><span className="scheduled-pill">{task.state || '-'}</span></td>
                  <td>{task.lastRunTime || '-'}</td>
                  <td>{task.nextRunTime || '-'}</td>
                  <td>
                    <button type="button" onClick={(event) => { event.stopPropagation(); setPendingAction({ title: `运行 ${task.name}`, command: createWindowsTaskActionCommand('start', task), afterRun: loadWindowsTasks }); }}>运行</button>
                    <button type="button" onClick={(event) => { event.stopPropagation(); setPendingAction({ title: `启用 ${task.name}`, command: createWindowsTaskActionCommand('enable', task), afterRun: loadWindowsTasks }); }}>启用</button>
                    <button type="button" onClick={(event) => { event.stopPropagation(); setPendingAction({ title: `禁用 ${task.name}`, command: createWindowsTaskActionCommand('disable', task), afterRun: loadWindowsTasks }); }}>禁用</button>
                  </td>
                </tr>
              ))}
              {!windowsTasks.length ? <tr><td colSpan={6} className="scheduled-empty-cell">没有计划任务数据。</td></tr> : null}
            </tbody>
          </table>
        </div>
      ) : null}

      {pendingAction ? createPortal(
        <div className="scheduled-modal-backdrop" role="presentation" onClick={() => setPendingAction(null)}>
          <div className="scheduled-confirm-dialog" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="scheduled-confirm-header">
              <span>确认操作</span>
              <strong>{pendingAction.title}</strong>
            </div>
            <pre>{pendingAction.command}</pre>
            <div className="scheduled-confirm-actions">
              <button type="button" onClick={() => setPendingAction(null)}>取消</button>
              <button type="button" onClick={copyPendingCommand}>复制命令</button>
              <button type="button" className="primary" onClick={executePendingAction} disabled={actionRunning}>{actionRunning ? '执行中' : '执行'}</button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </section>
  );
}

export default RemoteScheduledTasks;
