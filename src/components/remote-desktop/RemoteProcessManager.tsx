import { useCallback, useEffect, useRef, useState } from 'react';

import { getErrorMessage } from './desktopUtils';
import { isWindowsSystem, powershellCommand } from './remoteSystem';
import type { RemoteSystemType } from './types';

interface RemoteProcessManagerProps {
  connectionId: string;
  systemType?: RemoteSystemType;
}

interface Process {
  pid: number;
  user: string;
  cpu: string;
  mem: string;
  vsz: string;
  rss: string;
  tty: string;
  stat: string;
  start: string;
  time: string;
  command: string;
}

type SortKey = keyof Process;
type SortDir = 'asc' | 'desc';

const SIGNALS = [
  { value: '15', label: 'SIGTERM（优雅终止）' },
  { value: '9', label: 'SIGKILL（强制终止）' },
  { value: '2', label: 'SIGINT（Ctrl+C）' },
  { value: '1', label: 'SIGHUP（挂断）' },
] as const;

function parsePsOutput(stdout: string): Process[] {
  const lines = stdout.trim().split('\n');
  if (lines.length < 2) return [];

  // Skip header line
  const dataLines = lines.slice(1);
  const processes: Process[] = [];

  for (const line of dataLines) {
    if (!line.trim()) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 11) continue;

    processes.push({
      pid: Number.parseInt(parts[0], 10),
      user: parts[1],
      cpu: parts[2],
      mem: parts[3],
      vsz: parts[4],
      rss: parts[5],
      tty: parts[6],
      stat: parts[7],
      start: parts[8],
      time: parts[9],
      command: parts.slice(10).join(' '),
    });
  }

  return processes;
}

function parseWindowsProcessOutput(stdout: string): Process[] {
  return stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('\t');
      const pid = Number.parseInt(parts[0] ?? '', 10);
      const name = parts[1] || 'Process';
      const cpu = parts[2] || '0';
      const mem = parts[3] || '0';
      const start = parts[4] || '';

      if (!Number.isInteger(pid)) {
        return null;
      }

      return {
        pid,
        user: '-',
        cpu,
        mem,
        vsz: '-',
        rss: '-',
        tty: '-',
        stat: 'R',
        start,
        time: `${cpu}s`,
        command: name,
      };
    })
    .filter((process): process is Process => Boolean(process));
}

async function runCmd(connectionId: string, command: string) {
  return window.guiSSH!.connections!.runCommand(connectionId, command);
}

function ProcessManager({ connectionId, systemType }: RemoteProcessManagerProps) {
  const isWindowsHost = isWindowsSystem(systemType);
  const [processes, setProcesses] = useState<Process[]>([]);
  const [filtered, setFiltered] = useState<Process[]>([]);
  const [loading, setLoading] = useState(false);
  const [killing, setKilling] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [search, setSearch] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('cpu');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [selectedSignal, setSelectedSignal] = useState('15');
  const [killingPid, setKillingPid] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      if (isWindowsHost) {
        const result = await runCmd(connectionId, powershellCommand(`
Get-Process | Sort-Object -Property CPU -Descending | Select-Object -First 300 | ForEach-Object {
  $cpu = if ($null -eq $_.CPU) { 0 } else { [math]::Round($_.CPU, 1) }
  $mem = [math]::Round($_.WorkingSet64 / 1MB, 1)
  $start = ''
  try { $start = $_.StartTime.ToString('yyyy-MM-dd HH:mm') } catch {}
  $tab = [char]9
  '{0}{1}{2}{1}{3}{1}{4}{1}{5}' -f $_.Id, $tab, $_.ProcessName, $cpu, $mem, $start
}
`));
        setProcesses(parseWindowsProcessOutput(result.stdout || ''));
      } else {
        const result = await runCmd(connectionId, 'ps aux --sort=-%cpu 2>/dev/null || ps aux 2>/dev/null');
        setProcesses(parsePsOutput(result.stdout || ''));
      }
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [connectionId, isWindowsHost]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!autoRefresh) {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      return;
    }
    timerRef.current = setInterval(() => void refresh(), 3000);
    return () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };
  }, [autoRefresh, refresh]);

  const killProcess = async (pid: number) => {
    if (!Number.isInteger(pid) || pid <= 0) {
      setError('PID 无效。');
      return;
    }

    const signal = SIGNALS.some((item) => item.value === selectedSignal) ? selectedSignal : '15';
    setKilling(pid);
    setError('');
    setSuccess('');
    try {
      const result = await runCmd(
        connectionId,
        isWindowsHost ? powershellCommand(`Stop-Process -Id ${pid} -Force -ErrorAction Stop`) : `kill -${signal} ${pid} 2>&1`,
      );
      if (result.code !== 0) {
        throw new Error(result.stderr || '终止进程失败，可能需要 root 权限。');
      }
      setSuccess(isWindowsHost ? `已终止 PID ${pid}。` : `已向 PID ${pid} 发送 SIG${signal} 信号。`);
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setKilling(null);
      setKillingPid(null);
    }
  };

  // Filter and sort
  useEffect(() => {
    let list = processes;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((p) =>
        p.command.toLowerCase().includes(q) ||
        p.user.toLowerCase().includes(q) ||
        String(p.pid).includes(q)
      );
    }
    list = [...list].sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'pid') cmp = a.pid - b.pid;
      else if (sortKey === 'cpu' || sortKey === 'mem') cmp = Number.parseFloat(a[sortKey]) - Number.parseFloat(b[sortKey]);
      else cmp = String(a[sortKey]).localeCompare(String(b[sortKey]));
      return sortDir === 'desc' ? -cmp : cmp;
    });
    setFiltered(list);
  }, [processes, search, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const sortIndicator = (key: SortKey) => {
    if (sortKey !== key) return <span className="proc-sort-icon">&nbsp;</span>;
    return <span className="proc-sort-icon">{sortDir === 'asc' ? '▲' : '▼'}</span>;
  };

  return (
    <div className="proc-manager">
      {/* Toolbar */}
      <div className="proc-toolbar">
        <div className="proc-toolbar-left">
          <button type="button" className="settings-action-btn" onClick={refresh} disabled={loading}>
            {loading ? '加载中...' : '刷新'}
          </button>
          <label className="proc-check-label">
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
            自动刷新 (3s)
          </label>
          <span className="proc-summary">
            共 <strong>{filtered.length}</strong> / {processes.length} 个进程
          </span>
        </div>
        <div className="proc-toolbar-right">
          <input
            type="text"
            className="settings-input proc-search"
            placeholder="搜索进程名、用户或 PID..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {!isWindowsHost ? (
            <select className="settings-select proc-signal-select" value={selectedSignal} onChange={(e) => setSelectedSignal(e.target.value)}>
              {SIGNALS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          ) : null}
        </div>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}
      {success ? <div className="settings-success-banner">{success}</div> : null}

      {/* Confirm Kill Dialog */}
      {killingPid !== null ? (
        <div className="proc-kill-confirm" role="alertdialog">
          <p>确定要终止 PID <strong>{killingPid}</strong> 吗？</p>
          <div className="proc-kill-actions">
            <button type="button" className="settings-action-btn" onClick={() => setKillingPid(null)}>取消</button>
            <button type="button" className="settings-action-btn danger" onClick={() => { const pid = killingPid; setKillingPid(null); void killProcess(pid); }}>
              确认终止
            </button>
          </div>
        </div>
      ) : null}

      {/* Process Table */}
      <div className="proc-table-wrap">
        <table className="proc-table">
          <thead>
            <tr>
              <th className="proc-col-pid" onClick={() => toggleSort('pid')}>PID{sortIndicator('pid')}</th>
              <th className="proc-col-user" onClick={() => toggleSort('user')}>用户{sortIndicator('user')}</th>
              <th className="proc-col-cpu" onClick={() => toggleSort('cpu')}>{isWindowsHost ? 'CPU(s)' : 'CPU%'}{sortIndicator('cpu')}</th>
              <th className="proc-col-mem" onClick={() => toggleSort('mem')}>{isWindowsHost ? '内存 MB' : 'MEM%'}{sortIndicator('mem')}</th>
              <th className="proc-col-stat">状态</th>
              <th className="proc-col-time">时间</th>
              <th className="proc-col-command">命令</th>
              <th className="proc-col-action">操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={8} className="proc-empty">
                  {loading ? '正在加载进程列表...' : '暂无匹配的进程。'}
                </td>
              </tr>
            ) : (
              filtered.map((proc) => (
                <tr key={proc.pid} className={`proc-row ${proc.stat.startsWith('Z') ? 'proc-zombie' : ''}`}>
                  <td className="proc-pid">{proc.pid}</td>
                  <td className="proc-user" title={proc.user}>{proc.user}</td>
                  <td className="proc-cpu">
                    <div className="proc-bar-wrap">
                      <div className="proc-bar proc-bar-cpu" style={{ width: `${Math.min(Number.parseFloat(proc.cpu), 100)}%` }} />
                      <span>{proc.cpu}</span>
                    </div>
                  </td>
                  <td className="proc-mem">
                    <div className="proc-bar-wrap">
                      <div className="proc-bar proc-bar-mem" style={{ width: `${Math.min(Number.parseFloat(proc.mem), 100)}%` }} />
                      <span>{proc.mem}</span>
                    </div>
                  </td>
                  <td className="proc-stat">
                    <span className={`proc-stat-tag ${proc.stat.startsWith('Z') ? 'zombie' : proc.stat.startsWith('R') ? 'running' : proc.stat.startsWith('D') ? 'blocked' : 'idle'}`}>
                      {proc.stat[0]}
                    </span>
                  </td>
                  <td className="proc-time">{proc.time}</td>
                  <td className="proc-command" title={proc.command}>{proc.command}</td>
                  <td className="proc-action">
                    <button
                      type="button"
                      className="proc-kill-btn"
                      disabled={killing === proc.pid}
                      onClick={() => setKillingPid(proc.pid)}
                      title={isWindowsHost ? '终止进程' : `发送 SIG${selectedSignal}`}
                    >
                      {killing === proc.pid ? '...' : '终止'}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default ProcessManager;
