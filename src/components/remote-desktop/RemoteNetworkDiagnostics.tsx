import { useEffect, useMemo, useRef, useState } from 'react';

import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import { isWindowsSystem, powershellCommand, powershellSingleQuote } from './remoteSystem';
import type { RemoteSystemType } from './types';

interface RemoteNetworkDiagnosticsProps {
  connectionId: string;
  systemType?: RemoteSystemType;
}

type NetworkToolKey = 'ping' | 'dns' | 'trace' | 'curl' | 'tcp' | 'routes';
type RunStatus = 'running' | 'success' | 'error';

interface NetworkDiagnosticRun {
  id: string;
  tool: NetworkToolKey;
  title: string;
  startedAt: string;
  durationMs: number;
  exitCode: number;
  stdout: string;
  stderr: string;
  output: string;
  summary: Array<{ label: string; value: string }>;
  status: RunStatus;
}

interface NetworkFormState {
  host: string;
  domain: string;
  url: string;
  port: string;
  count: string;
  timeout: string;
}

const maxHistoryRuns = 20;

const toolDefinitions: Array<{ key: NetworkToolKey; label: string; description: string }> = [
  { key: 'ping', label: 'Ping', description: '连通性、延迟和丢包' },
  { key: 'dns', label: 'DNS 查询', description: '解析记录与 DNS 返回' },
  { key: 'trace', label: '路径追踪', description: '路由跳数和路径' },
  { key: 'curl', label: 'HTTP 检测', description: '状态码、耗时和响应头' },
  { key: 'tcp', label: 'TCP 探测', description: '目标端口可达性' },
  { key: 'routes', label: '路由表', description: '远程主机路由视图' },
];

const initialFormState: NetworkFormState = {
  host: '127.0.0.1',
  domain: 'example.com',
  url: 'https://example.com',
  port: '80',
  count: '4',
  timeout: '5',
};

function runCmd(connectionId: string, command: string) {
  const api = window.guiSSH?.connections;

  if (!api) {
    throw new Error('ShellDesk IPC 未就绪。');
  }

  return api.runCommand(connectionId, command);
}

function runCmdStream(
  connectionId: string,
  command: string,
  onChunk: (chunk: string, stream: 'stdout' | 'stderr') => void,
) {
  const api = window.guiSSH?.connections;

  if (!api) {
    throw new Error('ShellDesk IPC 未就绪。');
  }

  if (api.runCommandStream) {
    return api.runCommandStream(connectionId, command, undefined, { onChunk });
  }

  return runCmd(connectionId, command).then((result) => {
    if (result.stdout) {
      onChunk(result.stdout, 'stdout');
    }

    if (result.stderr) {
      onChunk(result.stderr, 'stderr');
    }

    return result;
  });
}

function shellSingleQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function clampInteger(value: string, fallback: number, min: number, max: number) {
  const parsedValue = Number.parseInt(value, 10);

  if (!Number.isInteger(parsedValue)) {
    return fallback;
  }

  return Math.min(Math.max(parsedValue, min), max);
}

function validateHost(value: string, label: string) {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    throw new Error(`请输入${label}。`);
  }

  if (trimmedValue.length > 255 || /[\r\n;&|`$<>]/.test(trimmedValue)) {
    throw new Error(`${label}包含不安全字符。`);
  }

  return trimmedValue;
}

function validateUrl(value: string) {
  const trimmedValue = value.trim();

  if (!/^https?:\/\/[^\s]+$/i.test(trimmedValue)) {
    throw new Error('请输入 http:// 或 https:// 开头的 URL。');
  }

  if (trimmedValue.length > 512 || /[\r\n`$<>]/.test(trimmedValue)) {
    throw new Error('URL 包含不安全字符。');
  }

  return trimmedValue;
}

function buildPingCommand(form: NetworkFormState, isWindowsHost: boolean) {
  const host = validateHost(form.host, '目标主机');
  const count = clampInteger(form.count, 4, 1, 10);

  return isWindowsHost
    ? powershellCommand(`ping -n ${count} ${powershellSingleQuote(host)}`)
    : `ping -c ${count} ${shellSingleQuote(host)}`;
}

function buildDnsCommand(form: NetworkFormState, isWindowsHost: boolean) {
  const domain = validateHost(form.domain, '域名');

  return isWindowsHost
    ? powershellCommand(`
try {
  Resolve-DnsName -Name ${powershellSingleQuote(domain)} | Format-Table -AutoSize | Out-String -Width 220
} catch {
  nslookup ${powershellSingleQuote(domain)}
}
`)
    : `if command -v dig >/dev/null 2>&1; then dig ${shellSingleQuote(domain)}; else nslookup ${shellSingleQuote(domain)}; fi`;
}

function buildTraceCommand(form: NetworkFormState, isWindowsHost: boolean) {
  const host = validateHost(form.host, '目标主机');

  return isWindowsHost
    ? powershellCommand(`tracert ${powershellSingleQuote(host)}`)
    : `if command -v tracepath >/dev/null 2>&1; then tracepath ${shellSingleQuote(host)}; elif command -v traceroute >/dev/null 2>&1; then traceroute ${shellSingleQuote(host)}; else echo '缺少 tracepath 或 traceroute。' >&2; exit 127; fi`;
}

function buildCurlCommand(form: NetworkFormState, isWindowsHost: boolean) {
  const url = validateUrl(form.url);
  const timeout = clampInteger(form.timeout, 5, 1, 30);

  return isWindowsHost
    ? powershellCommand(`
$watch = [System.Diagnostics.Stopwatch]::StartNew()
try {
  $response = Invoke-WebRequest -Uri ${powershellSingleQuote(url)} -Method Head -MaximumRedirection 5 -TimeoutSec ${timeout} -UseBasicParsing
  $watch.Stop()
  [Console]::Out.WriteLine("HTTP $($response.StatusCode) $($response.StatusDescription)")
  [Console]::Out.WriteLine("耗时 $($watch.ElapsedMilliseconds) ms")
  $response.Headers.GetEnumerator() | Sort-Object Key | ForEach-Object { [Console]::Out.WriteLine("$($_.Key): $($_.Value)") }
} catch {
  $watch.Stop()
  [Console]::Out.WriteLine("耗时 $($watch.ElapsedMilliseconds) ms")
  throw
}
`)
    : `curl -I -L --max-time ${timeout} -w '\\n__SHELLDESK_CURL_SUMMARY__ http_code=%{http_code} time_total=%{time_total} remote_ip=%{remote_ip}\\n' ${shellSingleQuote(url)}`;
}

function buildTcpCommand(form: NetworkFormState, isWindowsHost: boolean) {
  const host = validateHost(form.host, '目标主机');
  const port = clampInteger(form.port, 80, 1, 65535);

  return isWindowsHost
    ? powershellCommand(`Test-NetConnection -ComputerName ${powershellSingleQuote(host)} -Port ${port} | Format-List | Out-String -Width 220`)
    : `if command -v nc >/dev/null 2>&1; then nc -vz -w 5 ${shellSingleQuote(host)} ${port}; else timeout 6 bash -lc ${shellSingleQuote(`cat < /dev/null > /dev/tcp/${host}/${port}`)} && echo 'TCP 连接成功' || { echo 'TCP 连接失败' >&2; exit 1; }; fi`;
}

function buildRoutesCommand(isWindowsHost: boolean) {
  return isWindowsHost
    ? powershellCommand('Get-NetRoute | Sort-Object RouteMetric, DestinationPrefix | Format-Table -AutoSize | Out-String -Width 240')
    : 'ip route 2>/dev/null || route -n';
}

function buildCommand(tool: NetworkToolKey, form: NetworkFormState, isWindowsHost: boolean) {
  switch (tool) {
    case 'ping': return buildPingCommand(form, isWindowsHost);
    case 'dns': return buildDnsCommand(form, isWindowsHost);
    case 'trace': return buildTraceCommand(form, isWindowsHost);
    case 'curl': return buildCurlCommand(form, isWindowsHost);
    case 'tcp': return buildTcpCommand(form, isWindowsHost);
    case 'routes': return buildRoutesCommand(isWindowsHost);
    default: return '';
  }
}

function getToolTarget(tool: NetworkToolKey, form: NetworkFormState) {
  switch (tool) {
    case 'dns': return form.domain.trim();
    case 'curl': return form.url.trim();
    case 'tcp': return `${form.host.trim()}:${form.port.trim()}`;
    case 'routes': return '路由表';
    default: return form.host.trim();
  }
}

function extractSummary(tool: NetworkToolKey, stdout: string, stderr: string, exitCode: number, durationMs: number) {
  const text = `${stdout}\n${stderr}`;
  const summary: Array<{ label: string; value: string }> = [
    { label: '退出码', value: String(exitCode) },
    { label: '耗时', value: `${durationMs} ms` },
  ];

  if (tool === 'ping') {
    const lossMatch = text.match(/(\d+(?:\.\d+)?)%\s*(?:packet\s*)?loss/i) ?? text.match(/\((\d+)%\s*loss\)/i);
    const avgMatch = text.match(/(?:avg|Average)\s*[=/]\s*([\d.]+)\s*ms/i) ?? text.match(/平均\s*=\s*(\d+)ms/i);
    if (lossMatch) summary.push({ label: '丢包', value: `${lossMatch[1]}%` });
    if (avgMatch) summary.push({ label: '平均延迟', value: `${avgMatch[1]} ms` });
  }

  if (tool === 'curl') {
    const httpMatch = text.match(/HTTP\/\S+\s+(\d{3})/) ?? text.match(/HTTP\s+(\d{3})/);
    const curlSummary = text.match(/__SHELLDESK_CURL_SUMMARY__\s+http_code=(\d+)\s+time_total=([\d.]+)\s+remote_ip=([^\s]*)/);
    if (httpMatch || curlSummary) summary.push({ label: '状态码', value: httpMatch?.[1] ?? curlSummary?.[1] ?? '-' });
    if (curlSummary) summary.push({ label: '请求耗时', value: `${Number.parseFloat(curlSummary[2]).toFixed(3)} s` });
    if (curlSummary?.[3]) summary.push({ label: '远端 IP', value: curlSummary[3] });
  }

  if (tool === 'tcp') {
    const success = /succeeded|TcpTestSucceeded\s*:\s*True|open|连接成功/i.test(text);
    summary.push({ label: '连通', value: success ? '是' : exitCode === 0 ? '可能可达' : '否' });
  }

  if (tool === 'dns') {
    const answerCount = text.split(/\r?\n/).filter((line) => /\b(A|AAAA|CNAME|MX|Name|Address)\b/i.test(line)).length;
    summary.push({ label: '结果行', value: String(answerCount) });
  }

  if (tool === 'trace') {
    const hopCount = text.split(/\r?\n/).filter((line) => /^\s*\d+/.test(line)).length;
    summary.push({ label: '跳数', value: hopCount ? String(hopCount) : '-' });
  }

  if (tool === 'routes') {
    const routeCount = text.split(/\r?\n/).filter((line) => line.trim()).length;
    summary.push({ label: '路由行', value: String(routeCount) });
  }

  return summary;
}

function formatRunOutput(run: NetworkDiagnosticRun) {
  return [
    `[${run.title}] ${run.startedAt}`,
    `退出码: ${run.status === 'running' ? '执行中' : run.exitCode}`,
    run.stdout ? `\nSTDOUT\n${run.stdout}` : '',
    run.stderr ? `\nSTDERR\n${run.stderr}` : '',
    !run.stdout && !run.stderr && run.output ? `\nOUTPUT\n${run.output}` : '',
  ].filter(Boolean).join('\n');
}

function getRunBadge(run: NetworkDiagnosticRun) {
  if (run.status === 'running') return 'RUN';
  return run.exitCode === 0 ? 'OK' : 'ERR';
}

function getRunHistoryMeta(run: NetworkDiagnosticRun) {
  if (run.status === 'running') {
    return `${run.startedAt} · 执行中`;
  }

  return `${run.startedAt} · ${run.durationMs} ms · code ${run.exitCode}`;
}

function RemoteNetworkDiagnostics({ connectionId, systemType }: RemoteNetworkDiagnosticsProps) {
  const isWindowsHost = isWindowsSystem(systemType);
  const outputRef = useRef<HTMLPreElement | null>(null);
  const [activeTool, setActiveTool] = useState<NetworkToolKey>('ping');
  const [form, setForm] = useState<NetworkFormState>(initialFormState);
  const [runs, setRuns] = useState<NetworkDiagnosticRun[]>([]);
  const [activeRunId, setActiveRunId] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  const activeRun = useMemo(() => {
    return runs.find((run) => run.id === activeRunId) ?? runs[0] ?? null;
  }, [activeRunId, runs]);

  const activeDefinition = toolDefinitions.find((tool) => tool.key === activeTool) ?? toolDefinitions[0];

  useEffect(() => {
    if (activeRun?.status !== 'running') {
      return;
    }

    const outputElement = outputRef.current;

    if (outputElement) {
      outputElement.scrollTop = outputElement.scrollHeight;
    }
  }, [activeRun?.output, activeRun?.status]);

  const updateForm = (key: keyof NetworkFormState, value: string) => {
    setForm((currentForm) => ({ ...currentForm, [key]: value }));
  };

  const executeTool = async () => {
    setRunning(true);
    setError('');
    const started = performance.now();
    let runId = '';

    try {
      const command = buildCommand(activeTool, form, isWindowsHost);
      runId = createId('network-run');
      const startedAt = new Date().toLocaleTimeString(getShellDeskLocale());
      const title = `${activeDefinition.label} · ${getToolTarget(activeTool, form)}`;
      const initialRun: NetworkDiagnosticRun = {
        id: runId,
        tool: activeTool,
        title,
        startedAt,
        durationMs: 0,
        exitCode: -1,
        stdout: '',
        stderr: '',
        output: '',
        summary: [
          { label: '状态', value: '执行中' },
          { label: '退出码', value: '-' },
        ],
        status: 'running',
      };

      setRuns((currentRuns) => [initialRun, ...currentRuns].slice(0, maxHistoryRuns));
      setActiveRunId(runId);

      const result = await runCmdStream(connectionId, command, (chunk, stream) => {
        setRuns((currentRuns) => currentRuns.map((run) => {
          if (run.id !== runId) {
            return run;
          }

          return {
            ...run,
            stdout: stream === 'stdout' ? `${run.stdout}${chunk}` : run.stdout,
            stderr: stream === 'stderr' ? `${run.stderr}${chunk}` : run.stderr,
            output: `${run.output}${chunk}`,
          };
        }));
      });
      const durationMs = Math.round(performance.now() - started);
      const fallbackOutput = [result.stdout, result.stderr].filter(Boolean).join('\n');

      setRuns((currentRuns) => currentRuns.map((run) => {
        if (run.id !== runId) {
          return run;
        }

        return {
          ...run,
          durationMs,
          exitCode: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
          output: fallbackOutput || run.output,
          summary: extractSummary(activeTool, result.stdout, result.stderr, result.code, durationMs),
          status: result.code === 0 ? 'success' : 'error',
        };
      }));
    } catch (error) {
      const message = getErrorMessage(error);

      if (!runId) {
        setError(message);
      } else {
        const durationMs = Math.round(performance.now() - started);

        setRuns((currentRuns) => currentRuns.map((run) => {
          if (run.id !== runId) {
            return run;
          }

          const stderr = `${run.stderr}${run.stderr ? '\n' : ''}${message}`;

          return {
            ...run,
            durationMs,
            exitCode: 1,
            stderr,
            output: `${run.output}${run.output ? '\n' : ''}${message}`,
            summary: [
              { label: '退出码', value: '1' },
              { label: '耗时', value: `${durationMs} ms` },
            ],
            status: 'error',
          };
        }));
      }
    } finally {
      setRunning(false);
    }
  };

  const copyActiveRun = async () => {
    if (!activeRun) {
      return;
    }

    await navigator.clipboard.writeText(formatRunOutput(activeRun));
  };

  return (
    <section className="network-diagnostics">
      <aside className="network-tool-list" aria-label="网络诊断工具">
        <div className="network-tool-list-header">
          <strong>网络诊断</strong>
          <span>{isWindowsHost ? 'Windows' : 'Linux/Unix'} 远程视角</span>
        </div>
        {toolDefinitions.map((tool) => {
          const latestRun = runs.find((run) => run.tool === tool.key);
          return (
            <button
              key={tool.key}
              type="button"
              className={activeTool === tool.key ? 'active' : ''}
              onClick={() => setActiveTool(tool.key)}
            >
              <span>
                <strong>{tool.label}</strong>
                <small>{tool.description}</small>
              </span>
              {latestRun ? <em className={latestRun.status}>{getRunBadge(latestRun)}</em> : null}
            </button>
          );
        })}
      </aside>

      <main className="network-main">
        <header className="network-header">
          <div>
            <span>工具箱</span>
            <strong>{activeDefinition.label}</strong>
          </div>
          <button type="button" className="network-run-btn" onClick={executeTool} disabled={running}>
            {running ? '执行中' : '执行'}
          </button>
        </header>

        {error ? <div className="network-alert danger">{error}</div> : null}

        <section className="network-form">
          {activeTool === 'ping' || activeTool === 'trace' || activeTool === 'tcp' ? (
            <label>
              <span>目标主机</span>
              <input value={form.host} onChange={(event) => updateForm('host', event.target.value)} />
            </label>
          ) : null}

          {activeTool === 'dns' ? (
            <label>
              <span>域名</span>
              <input value={form.domain} onChange={(event) => updateForm('domain', event.target.value)} />
            </label>
          ) : null}

          {activeTool === 'curl' ? (
            <label className="wide">
              <span>URL</span>
              <input value={form.url} onChange={(event) => updateForm('url', event.target.value)} />
            </label>
          ) : null}

          {activeTool === 'tcp' ? (
            <label>
              <span>端口</span>
              <input inputMode="numeric" value={form.port} onChange={(event) => updateForm('port', event.target.value)} />
            </label>
          ) : null}

          {activeTool === 'ping' ? (
            <label>
              <span>次数</span>
              <input inputMode="numeric" value={form.count} onChange={(event) => updateForm('count', event.target.value)} />
            </label>
          ) : null}

          {activeTool === 'curl' ? (
            <label>
              <span>超时秒数</span>
              <input inputMode="numeric" value={form.timeout} onChange={(event) => updateForm('timeout', event.target.value)} />
            </label>
          ) : null}

          {activeTool === 'routes' ? (
            <div className="network-form-note">路由表工具无需参数，会直接读取远程主机当前路由。</div>
          ) : null}
        </section>

        <section className="network-result">
          <div className="network-result-head">
            <div>
              <span>结果</span>
              <strong>{activeRun?.title ?? '尚未执行'}</strong>
            </div>
            <button type="button" onClick={copyActiveRun} disabled={!activeRun}>复制结果</button>
          </div>

          {activeRun ? (
            <>
              <div className="network-summary-grid">
                {activeRun.summary.map((item) => (
                  <div key={`${activeRun.id}-${item.label}`}>
                    <span>{item.label}</span>
                    <strong>{item.value}</strong>
                  </div>
                ))}
              </div>
              <pre ref={outputRef} className="network-output">
                {activeRun.output || activeRun.stdout || activeRun.stderr || (activeRun.status === 'running' ? '等待远程输出...' : '命令没有输出。')}
              </pre>
            </>
          ) : (
            <div className="network-placeholder">选择工具并执行后，这里会显示摘要和原始输出。</div>
          )}
        </section>
      </main>

      <aside className="network-history">
        <div className="network-history-header">
          <strong>历史</strong>
          <span>最近 {maxHistoryRuns} 次</span>
        </div>
        <div className="network-history-list">
          {runs.map((run) => (
            <button
              key={run.id}
              type="button"
              className={`${activeRun?.id === run.id ? 'active' : ''} ${run.status}`}
              onClick={() => setActiveRunId(run.id)}
            >
              <strong>{run.title}</strong>
              <span>{getRunHistoryMeta(run)}</span>
            </button>
          ))}
          {runs.length === 0 ? <div className="network-history-empty">暂无历史。</div> : null}
        </div>
      </aside>
    </section>
  );
}

export default RemoteNetworkDiagnostics;
