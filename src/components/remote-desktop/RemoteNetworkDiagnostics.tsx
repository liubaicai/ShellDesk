import { useEffect, useMemo, useRef, useState } from 'react';
import DismissibleAlert from './DismissibleAlert';

import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import { isWindowsSystem, powershellCommand, powershellSingleQuote } from './remoteSystem';
import { shellSingleQuote } from './shellUtils';
import type { RemoteSystemType } from './types';
import { tCurrent } from '../../i18n';

interface RemoteNetworkDiagnosticsProps {
  connectionId: string;
  systemType?: RemoteSystemType;
}

type NetworkToolKey = 'ping' | 'dns' | 'trace' | 'curl' | 'tcp' | 'mtr' | 'iperf3' | 'whois' | 'ssl' | 'routes';
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
  { key: 'ping', label: 'Ping', description: tCurrent('auto.remoteNetworkDiagnostics.co4s1f') },
  { key: 'dns', label: tCurrent('auto.remoteNetworkDiagnostics.14nt7zn'), description: tCurrent('auto.remoteNetworkDiagnostics.19nxdtg') },
  { key: 'trace', label: tCurrent('auto.remoteNetworkDiagnostics.1h9kdix'), description: tCurrent('auto.remoteNetworkDiagnostics.k7mqil') },
  { key: 'curl', label: tCurrent('auto.remoteNetworkDiagnostics.18g7zaq'), description: tCurrent('auto.remoteNetworkDiagnostics.expaj0') },
  { key: 'tcp', label: tCurrent('auto.remoteNetworkDiagnostics.uhg353'), description: tCurrent('auto.remoteNetworkDiagnostics.orxu46') },
  { key: 'mtr', label: 'MTR', description: tCurrent('network.tool.mtr.description') },
  { key: 'iperf3', label: 'iperf3', description: tCurrent('network.tool.iperf3.description') },
  { key: 'whois', label: 'Whois', description: tCurrent('network.tool.whois.description') },
  { key: 'ssl', label: 'SSL', description: tCurrent('network.tool.ssl.description') },
  { key: 'routes', label: tCurrent('auto.remoteNetworkDiagnostics.g3ahzj'), description: tCurrent('auto.remoteNetworkDiagnostics.fv1041') },
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
    throw new Error(tCurrent('auto.remoteNetworkDiagnostics.g77vf3'));
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
    throw new Error(tCurrent('auto.remoteNetworkDiagnostics.g77vf32'));
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
    throw new Error(tCurrent('auto.remoteNetworkDiagnostics.1c0dr7n', { value0: label }));
  }

  if (trimmedValue.length > 255 || /[\r\n;&|`$<>]/.test(trimmedValue)) {
    throw new Error(tCurrent('auto.remoteNetworkDiagnostics.1xto81z', { value0: label }));
  }

  return trimmedValue;
}

function validateUrl(value: string) {
  const trimmedValue = value.trim();

  if (!/^https?:\/\/[^\s]+$/i.test(trimmedValue)) {
    throw new Error(tCurrent('auto.remoteNetworkDiagnostics.1qr8q5c'));
  }

  if (trimmedValue.length > 512 || /[\r\n`$<>]/.test(trimmedValue)) {
    throw new Error(tCurrent('auto.remoteNetworkDiagnostics.ug8ntx'));
  }

  return trimmedValue;
}

function buildPingCommand(form: NetworkFormState, isWindowsHost: boolean) {
  const host = validateHost(form.host, tCurrent('auto.remoteNetworkDiagnostics.h6x85v'));
  const count = clampInteger(form.count, 4, 1, 10);

  return isWindowsHost
    ? powershellCommand(`ping -n ${count} ${powershellSingleQuote(host)}`)
    : `ping -c ${count} ${shellSingleQuote(host)}`;
}

function buildDnsCommand(form: NetworkFormState, isWindowsHost: boolean) {
  const domain = validateHost(form.domain, tCurrent('auto.remoteNetworkDiagnostics.57pmxl'));

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
  const host = validateHost(form.host, tCurrent('auto.remoteNetworkDiagnostics.h6x85v2'));

  return isWindowsHost
    ? powershellCommand(`tracert ${powershellSingleQuote(host)}`)
    : tCurrent('auto.remoteNetworkDiagnostics.14pspjf', { value0: shellSingleQuote(host), value1: shellSingleQuote(host) });
}

function buildCurlCommand(form: NetworkFormState, isWindowsHost: boolean) {
  const url = validateUrl(form.url);
  const timeout = clampInteger(form.timeout, 5, 1, 30);

  return isWindowsHost
    ? powershellCommand(tCurrent('auto.remoteNetworkDiagnostics.mnmkjd', { value0: powershellSingleQuote(url), value1: timeout }))
    : `curl -I -L --max-time ${timeout} -w '\\n__SHELLDESK_CURL_SUMMARY__ http_code=%{http_code} time_total=%{time_total} remote_ip=%{remote_ip}\\n' ${shellSingleQuote(url)}`;
}

function buildTcpCommand(form: NetworkFormState, isWindowsHost: boolean) {
  const host = validateHost(form.host, tCurrent('auto.remoteNetworkDiagnostics.h6x85v3'));
  const port = clampInteger(form.port, 80, 1, 65535);

  return isWindowsHost
    ? powershellCommand(`Test-NetConnection -ComputerName ${powershellSingleQuote(host)} -Port ${port} | Format-List | Out-String -Width 220`)
    : tCurrent('auto.remoteNetworkDiagnostics.1wr64u8', { value0: shellSingleQuote(host), value1: port, value2: shellSingleQuote(`cat < /dev/null > /dev/tcp/${host}/${port}`) });
}

function buildMtrCommand(form: NetworkFormState, isWindowsHost: boolean) {
  const host = validateHost(form.host, 'Host');
  const count = clampInteger(form.count, 6, 2, 20);
  return isWindowsHost
    ? powershellCommand(`pathping -q ${count} ${powershellSingleQuote(host)}`)
    : `if command -v mtr >/dev/null 2>&1; then mtr -rwzc ${count} ${shellSingleQuote(host)}; elif command -v traceroute >/dev/null 2>&1; then traceroute ${shellSingleQuote(host)}; else ping -c ${count} ${shellSingleQuote(host)}; fi`;
}

function buildIperfCommand(form: NetworkFormState, isWindowsHost: boolean) {
  const host = validateHost(form.host, 'Host');
  const port = clampInteger(form.port, 5201, 1, 65535);
  const timeout = clampInteger(form.timeout, 5, 1, 60);
  if (isWindowsHost) {
    return powershellCommand(`
if (-not (Get-Command iperf3 -ErrorAction SilentlyContinue)) {
  Write-Error "iperf3 CLI not found on remote host."
  exit 127
}
iperf3 -c ${powershellSingleQuote(host)} -p ${port} -t ${timeout}
`);
  }
  return `if command -v iperf3 >/dev/null 2>&1; then iperf3 -c ${shellSingleQuote(host)} -p ${port} -t ${timeout}; else printf 'iperf3 CLI not found on remote host.\\n' >&2; exit 127; fi`;
}

function buildWhoisCommand(form: NetworkFormState, isWindowsHost: boolean) {
  const domain = validateHost(form.domain, 'Domain/IP');
  if (isWindowsHost) {
    return powershellCommand(`
if (Get-Command whois -ErrorAction SilentlyContinue) {
  whois ${powershellSingleQuote(domain)}
} else {
  Write-Error "whois CLI not found on remote host."
  exit 127
}
`);
  }
  return `if command -v whois >/dev/null 2>&1; then whois ${shellSingleQuote(domain)}; else printf 'whois CLI not found on remote host.\\n' >&2; exit 127; fi`;
}

function buildSslCommand(form: NetworkFormState, isWindowsHost: boolean) {
  const host = validateHost(form.host, 'Host');
  const port = clampInteger(form.port, 443, 1, 65535);
  if (isWindowsHost) {
    return powershellCommand(`
$hostName = ${powershellSingleQuote(host)}
$port = ${port}
$tcp = [Net.Sockets.TcpClient]::new()
$tcp.Connect($hostName, $port)
$ssl = [Net.Security.SslStream]::new($tcp.GetStream(), $false, ({ $true } -as [Net.Security.RemoteCertificateValidationCallback]))
$ssl.AuthenticateAsClient($hostName)
$cert = [Security.Cryptography.X509Certificates.X509Certificate2]::new($ssl.RemoteCertificate)
"Subject: $($cert.Subject)"
"Issuer: $($cert.Issuer)"
"NotBefore: $($cert.NotBefore)"
"NotAfter: $($cert.NotAfter)"
"Thumbprint: $($cert.Thumbprint)"
"Protocol: $($ssl.SslProtocol)"
$ssl.Dispose()
$tcp.Dispose()
`);
  }
  return `if command -v openssl >/dev/null 2>&1; then printf '' | openssl s_client -connect ${shellSingleQuote(`${host}:${port}`)} -servername ${shellSingleQuote(host)} 2>/dev/null | openssl x509 -noout -subject -issuer -dates -fingerprint -sha256; else printf 'openssl CLI not found on remote host.\\n' >&2; exit 127; fi`;
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
    case 'mtr': return buildMtrCommand(form, isWindowsHost);
    case 'iperf3': return buildIperfCommand(form, isWindowsHost);
    case 'whois': return buildWhoisCommand(form, isWindowsHost);
    case 'ssl': return buildSslCommand(form, isWindowsHost);
    case 'routes': return buildRoutesCommand(isWindowsHost);
    default: return '';
  }
}

function getToolTarget(tool: NetworkToolKey, form: NetworkFormState) {
  switch (tool) {
    case 'dns': return form.domain.trim();
    case 'whois': return form.domain.trim();
    case 'curl': return form.url.trim();
    case 'iperf3':
    case 'ssl':
    case 'tcp': return `${form.host.trim()}:${form.port.trim()}`;
    case 'routes': return tCurrent('auto.remoteNetworkDiagnostics.g3ahzj2');
    default: return form.host.trim();
  }
}

function getDefaultPortForTool(tool: NetworkToolKey) {
  if (tool === 'ssl') return '443';
  if (tool === 'iperf3') return '5201';
  return tool === 'tcp' ? '80' : '';
}

function extractSummary(tool: NetworkToolKey, stdout: string, stderr: string, exitCode: number, durationMs: number) {
  const text = `${stdout}\n${stderr}`;
  const summary: Array<{ label: string; value: string }> = [
    { label: tCurrent('auto.remoteNetworkDiagnostics.1cjrdy2'), value: String(exitCode) },
    { label: tCurrent('auto.remoteNetworkDiagnostics.12sj4tc'), value: `${durationMs} ms` },
  ];

  if (tool === 'ping') {
    const lossMatch = text.match(/(\d+(?:\.\d+)?)%\s*(?:packet\s*)?loss/i) ?? text.match(/\((\d+)%\s*loss\)/i);
    const avgMatch = text.match(/(?:avg|Average)\s*[=/]\s*([\d.]+)\s*ms/i) ?? text.match(/\u5e73\u5747\s*=\s*(\d+)ms/i);
    if (lossMatch) summary.push({ label: tCurrent('auto.remoteNetworkDiagnostics.183h3vk'), value: `${lossMatch[1]}%` });
    if (avgMatch) summary.push({ label: tCurrent('auto.remoteNetworkDiagnostics.6r28ho'), value: `${avgMatch[1]} ms` });
  }

  if (tool === 'curl') {
    const httpMatch = text.match(/HTTP\/\S+\s+(\d{3})/) ?? text.match(/HTTP\s+(\d{3})/);
    const curlSummary = text.match(/__SHELLDESK_CURL_SUMMARY__\s+http_code=(\d+)\s+time_total=([\d.]+)\s+remote_ip=([^\s]*)/);
    if (httpMatch || curlSummary) summary.push({ label: tCurrent('auto.remoteNetworkDiagnostics.1whwgyj'), value: httpMatch?.[1] ?? curlSummary?.[1] ?? '-' });
    if (curlSummary) summary.push({ label: tCurrent('auto.remoteNetworkDiagnostics.10i64md'), value: `${Number.parseFloat(curlSummary[2]).toFixed(3)} s` });
    if (curlSummary?.[3]) summary.push({ label: tCurrent('auto.remoteNetworkDiagnostics.1i9g9f9'), value: curlSummary[3] });
  }

  if (tool === 'tcp') {
    const success = /succeeded|TcpTestSucceeded\s*:\s*True|open|\u8fde\u63a5\u6210\u529f/i.test(text);
    summary.push({ label: tCurrent('auto.remoteNetworkDiagnostics.158ywap'), value: success ? tCurrent('auto.remoteNetworkDiagnostics.btshni') : exitCode === 0 ? tCurrent('auto.remoteNetworkDiagnostics.pi1rhw') : tCurrent('auto.remoteNetworkDiagnostics.9sspjt') });
  }

  if (tool === 'dns') {
    const answerCount = text.split(/\r?\n/).filter((line) => /\b(A|AAAA|CNAME|MX|Name|Address)\b/i.test(line)).length;
    summary.push({ label: tCurrent('auto.remoteNetworkDiagnostics.1o242jm'), value: String(answerCount) });
  }

  if (tool === 'trace') {
    const hopCount = text.split(/\r?\n/).filter((line) => /^\s*\d+/.test(line)).length;
    summary.push({ label: tCurrent('auto.remoteNetworkDiagnostics.1spkigm'), value: hopCount ? String(hopCount) : '-' });
  }

  if (tool === 'mtr') {
    const hopCount = text.split(/\r?\n/).filter((line) => /^\s*(?:\d+\.|\d+\s+)/.test(line)).length;
    const lossMatch = text.match(/(\d+(?:\.\d+)?)%\s+Snt/i);
    summary.push({ label: tCurrent('auto.remoteNetworkDiagnostics.1spkigm'), value: hopCount ? String(hopCount) : '-' });
    if (lossMatch) summary.push({ label: tCurrent('auto.remoteNetworkDiagnostics.183h3vk'), value: `${lossMatch[1]}%` });
  }

  if (tool === 'iperf3') {
    const senderMatch = text.match(/([\d.]+)\s+([KMG]bits\/sec)\s+sender/i);
    const receiverMatch = text.match(/([\d.]+)\s+([KMG]bits\/sec)\s+receiver/i);
    if (senderMatch) summary.push({ label: 'Sender', value: `${senderMatch[1]} ${senderMatch[2]}` });
    if (receiverMatch) summary.push({ label: 'Receiver', value: `${receiverMatch[1]} ${receiverMatch[2]}` });
  }

  if (tool === 'whois') {
    const registrar = text.match(/Registrar:\s*(.+)/i)?.[1]?.trim();
    const organization = text.match(/(?:OrgName|Organization):\s*(.+)/i)?.[1]?.trim();
    if (registrar) summary.push({ label: 'Registrar', value: registrar });
    if (organization) summary.push({ label: 'Org', value: organization });
  }

  if (tool === 'ssl') {
    const notAfter = text.match(/(?:notAfter=|NotAfter:\s*)(.+)/i)?.[1]?.trim();
    const issuer = text.match(/(?:issuer=|Issuer:\s*)(.+)/i)?.[1]?.trim();
    if (notAfter) summary.push({ label: 'Expires', value: notAfter });
    if (issuer) summary.push({ label: 'Issuer', value: issuer });
  }

  if (tool === 'routes') {
    const routeCount = text.split(/\r?\n/).filter((line) => line.trim()).length;
    summary.push({ label: tCurrent('auto.remoteNetworkDiagnostics.nuzder'), value: String(routeCount) });
  }

  return summary;
}

function formatRunOutput(run: NetworkDiagnosticRun) {
  return [
    `[${run.title}] ${run.startedAt}`,
    tCurrent('auto.remoteNetworkDiagnostics.1nxtfs5', { value0: run.status === 'running' ? tCurrent('network.status.running') : run.exitCode }),
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
    return tCurrent('auto.remoteNetworkDiagnostics.1ikvqbj', { value0: run.startedAt });
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

  const selectTool = (tool: NetworkToolKey) => {
    setActiveTool(tool);
    const defaultPort = getDefaultPortForTool(tool);
    if (!defaultPort) return;
    setForm((currentForm) => ({ ...currentForm, port: defaultPort }));
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
          { label: tCurrent('auto.remoteNetworkDiagnostics.1ccx4t4'), value: tCurrent('auto.remoteNetworkDiagnostics.6svkbt') },
          { label: tCurrent('auto.remoteNetworkDiagnostics.1cjrdy22'), value: '-' },
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
              { label: tCurrent('auto.remoteNetworkDiagnostics.1cjrdy23'), value: '1' },
              { label: tCurrent('auto.remoteNetworkDiagnostics.12sj4tc2'), value: `${durationMs} ms` },
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
      <aside className="network-tool-list" aria-label={tCurrent('auto.remoteNetworkDiagnostics.wi2y15')}>
        <div className="network-tool-list-header">
          <strong>{tCurrent('auto.remoteNetworkDiagnostics.1p2hkqx')}</strong>
          <span>{isWindowsHost ? 'Windows' : 'Linux/Unix'} {tCurrent('auto.remoteNetworkDiagnostics.s75ils')}</span>
        </div>
        {toolDefinitions.map((tool) => {
          const latestRun = runs.find((run) => run.tool === tool.key);
          return (
            <button
              key={tool.key}
              type="button"
              className={activeTool === tool.key ? 'active' : ''}
              onClick={() => selectTool(tool.key)}
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
            <span>{tCurrent('auto.remoteNetworkDiagnostics.1yrzdfw')}</span>
            <strong>{activeDefinition.label}</strong>
          </div>
          <button type="button" className="network-run-btn" onClick={executeTool} disabled={running}>
            {running ? tCurrent('auto.remoteNetworkDiagnostics.6svkbt2') : tCurrent('auto.remoteNetworkDiagnostics.6azgji')}
          </button>
        </header>

        {error ? <DismissibleAlert className="network-alert danger" onDismiss={() => setError('')} role="alert">{error}</DismissibleAlert> : null}

        <section className="network-form">
          {activeTool === 'ping' || activeTool === 'trace' || activeTool === 'tcp' || activeTool === 'mtr' || activeTool === 'iperf3' || activeTool === 'ssl' ? (
            <label>
              <span>{tCurrent('auto.remoteNetworkDiagnostics.h6x85v4')}</span>
              <input value={form.host} onChange={(event) => updateForm('host', event.target.value)} />
            </label>
          ) : null}

          {activeTool === 'dns' || activeTool === 'whois' ? (
            <label>
              <span>{tCurrent('auto.remoteNetworkDiagnostics.57pmxl2')}</span>
              <input value={form.domain} onChange={(event) => updateForm('domain', event.target.value)} />
            </label>
          ) : null}

          {activeTool === 'curl' ? (
            <label className="wide">
              <span>URL</span>
              <input value={form.url} onChange={(event) => updateForm('url', event.target.value)} />
            </label>
          ) : null}

          {activeTool === 'tcp' || activeTool === 'iperf3' || activeTool === 'ssl' ? (
            <label>
              <span>{tCurrent('auto.remoteNetworkDiagnostics.19ijc5j')}</span>
              <input inputMode="numeric" value={form.port} onChange={(event) => updateForm('port', event.target.value)} />
            </label>
          ) : null}

          {activeTool === 'ping' || activeTool === 'mtr' ? (
            <label>
              <span>{tCurrent('auto.remoteNetworkDiagnostics.fotggk')}</span>
              <input inputMode="numeric" value={form.count} onChange={(event) => updateForm('count', event.target.value)} />
            </label>
          ) : null}

          {activeTool === 'curl' || activeTool === 'iperf3' ? (
            <label>
              <span>{tCurrent('auto.remoteNetworkDiagnostics.tabbi8')}</span>
              <input inputMode="numeric" value={form.timeout} onChange={(event) => updateForm('timeout', event.target.value)} />
            </label>
          ) : null}

          {activeTool === 'routes' ? (
            <div className="network-form-note">{tCurrent('auto.remoteNetworkDiagnostics.2a3s9p')}</div>
          ) : null}
        </section>

        <section className="network-result">
          <div className="network-result-head">
            <div>
              <span>{tCurrent('auto.remoteNetworkDiagnostics.q9h21m')}</span>
              <strong>{activeRun?.title ?? tCurrent('auto.remoteNetworkDiagnostics.7n0mou')}</strong>
            </div>
            <button type="button" onClick={copyActiveRun} disabled={!activeRun}>{tCurrent('auto.remoteNetworkDiagnostics.y9ieg5')}</button>
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
                {activeRun.output || activeRun.stdout || activeRun.stderr || (activeRun.status === 'running' ? tCurrent('auto.remoteNetworkDiagnostics.9ipmuf') : tCurrent('auto.remoteNetworkDiagnostics.opwb2z'))}
              </pre>
            </>
          ) : (
            <div className="network-placeholder">{tCurrent('auto.remoteNetworkDiagnostics.dgl6wz')}</div>
          )}
        </section>
      </main>

      <aside className="network-history">
        <div className="network-history-header">
          <strong>{tCurrent('auto.remoteNetworkDiagnostics.m67vtd')}</strong>
          <span>{tCurrent('auto.remoteNetworkDiagnostics.1a41w7e')}{maxHistoryRuns} {tCurrent('auto.remoteNetworkDiagnostics.a5jtgs')}</span>
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
          {runs.length === 0 ? <div className="network-history-empty">{tCurrent('auto.remoteNetworkDiagnostics.2b0wb')}</div> : null}
        </div>
      </aside>
    </section>
  );
}

export default RemoteNetworkDiagnostics;
