import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { AiToolDetails } from './types';

const DEFAULT_MAX_OUTPUT_LENGTH = 50000;

const SHELLDESK_APP_KEYS = [
  'files',
  'terminal',
  'notepad',
  'code-editor',
  'browser',
  'vnc',
  'log-viewer',
  'monitor',
  'mysql',
  'clickhouse',
  'redis',
  'service-manager',
  'container-manager',
  'port-manager',
  'firewall-manager',
  'iptables-manager',
  'network-diagnostics',
  'disk-analyzer',
  'disk-manager',
  'package-manager',
  'git-manager',
  'cert-manager',
  'nginx-manager',
  'caddy-manager',
  'apache-manager',
  'scheduled-tasks',
  'postgres',
  'mongo',
  'search-cluster',
  'message-queue',
  's3-browser',
  'frp-manager',
  'frps-manager',
  'security-audit',
  'login-sessions',
  'api-debugger',
  'procmanager',
  'ai-chat',
  'settings',
  'sqlite',
] as const satisfies readonly ShellDeskDesktopAppKey[];

export const SHARED_TOOL_DEFINITIONS = [
  {
    name: 'run_command',
    description: 'Execute a shell command on the connected remote host.',
  },
  {
    name: 'read_file',
    description: 'Read a text file from the connected remote host.',
  },
  {
    name: 'write_file',
    description: 'Write text content to a file on the connected remote host.',
  },
  {
    name: 'list_dir',
    description: 'List directory contents on the connected remote host.',
  },
  {
    name: 'search_files',
    description: 'Search file names or file contents on the connected remote host.',
  },
  {
    name: 'get_system_info',
    description: 'Collect OS, uptime, CPU, memory, disk, and network summary from the connected remote host.',
  },
  {
    name: 'list_services',
    description: 'List services on the connected remote host, optionally filtered by name.',
  },
  {
    name: 'get_service_status',
    description: 'Inspect one service on the connected remote host.',
  },
  {
    name: 'restart_service',
    description: 'Restart one service on the connected remote host.',
  },
  {
    name: 'list_processes',
    description: 'List top processes on the connected remote host.',
  },
  {
    name: 'inspect_process',
    description: 'Inspect one process by PID on the connected remote host.',
  },
  {
    name: 'kill_process',
    description: 'Send a signal to one process on the connected remote host.',
  },
  {
    name: 'list_containers',
    description: 'List Docker or Podman containers on the connected remote host.',
  },
  {
    name: 'container_logs',
    description: 'Read Docker or Podman container logs on the connected remote host.',
  },
  {
    name: 'compose_status',
    description: 'Show Docker Compose or Podman Compose status in a remote directory.',
  },
  {
    name: 'read_journal',
    description: 'Read systemd journal entries on the connected remote host.',
  },
  {
    name: 'tail_file',
    description: 'Tail a remote log or text file.',
  },
  {
    name: 'search_logs',
    description: 'Search remote log files for text.',
  },
  {
    name: 'check_port',
    description: 'Check TCP connectivity from the connected remote host to a host and port.',
  },
  {
    name: 'curl_url',
    description: 'Fetch a URL from the connected remote host with curl.',
  },
  {
    name: 'dns_lookup',
    description: 'Resolve a hostname from the connected remote host.',
  },
  {
    name: 'trace_route',
    description: 'Trace network path from the connected remote host.',
  },
  {
    name: 'query_mysql',
    description: 'Run a read-only MySQL query using mysql CLI on the connected remote host.',
  },
  {
    name: 'query_postgres',
    description: 'Run a read-only PostgreSQL query using psql CLI on the connected remote host.',
  },
  {
    name: 'query_redis',
    description: 'Run a read-only Redis command using redis-cli on the connected remote host.',
  },
  {
    name: 'check_ssh_security',
    description: 'Inspect SSH server security-relevant settings on the connected remote host.',
  },
  {
    name: 'check_firewall',
    description: 'Inspect firewall status and rules on the connected remote host.',
  },
  {
    name: 'check_users',
    description: 'Inspect local users, privileged groups, and active login sessions on the connected remote host.',
  },
  {
    name: 'open_desktop_app',
    description: 'Open a ShellDesk remote desktop component window.',
  },
] as const;

interface SharedToolsOptions {
  systemType?: string;
  onOpenApp?: (appKey: ShellDeskDesktopAppKey) => void;
}

interface RunCommandParams {
  command: string;
}

interface PathParams {
  path: string;
}

interface WriteFileParams {
  path: string;
  content: string;
}

interface SearchFilesParams {
  path: string;
  query: string;
  mode?: 'content' | 'name';
}

type ToolParams = Record<string, string | undefined>;

function isWindowsSystem(systemType: string | undefined) {
  return systemType === 'windows';
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function toBase64(value: string): string {
  return btoa(unescape(encodeURIComponent(value)));
}

function truncateOutput(output: string, maxOutputLength = DEFAULT_MAX_OUTPUT_LENGTH): string {
  if (output.length <= maxOutputLength) {
    return output;
  }

  return `${output.slice(0, maxOutputLength)}\n\n[Output truncated at ${maxOutputLength} characters]`;
}

function toPositiveInt(value: string | undefined, fallback: number, max: number) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, max);
}

function isValidPort(value: string | undefined) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535;
}

function normalizeSignal(value: string | undefined) {
  const signal = (value || 'TERM').trim().toUpperCase().replace(/^SIG/, '');
  const allowed = new Set(['TERM', 'KILL', 'INT', 'HUP', 'QUIT', 'USR1', 'USR2']);
  return allowed.has(signal) ? signal : 'TERM';
}

function normalizeReadOnlySql(query: string | undefined): { query?: string; error?: string } {
  const trimmed = query?.trim() ?? '';

  if (!trimmed) {
    return { error: 'Query is required.' };
  }

  const statement = trimmed.replace(/;+\s*$/, '');

  if (statement.includes(';')) {
    return { error: 'Only one SQL statement is allowed.' };
  }

  const firstWord = statement.match(/^\s*([a-z]+)/i)?.[1]?.toLowerCase();
  const allowedFirstWords = new Set(['select', 'show', 'describe', 'desc', 'explain', 'with']);
  const forbidden = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|replace|call|execute|copy|load|set|reset|vacuum|analyze)\b/i;

  if (!firstWord || !allowedFirstWords.has(firstWord) || forbidden.test(statement)) {
    return { error: 'Only read-only SQL statements are allowed.' };
  }

  return { query: statement };
}

function normalizeRedisReadOnlyCommand(command: string | undefined): { args?: string[]; error?: string } {
  const trimmed = command?.trim() ?? '';

  if (!trimmed) {
    return { error: 'Redis command is required.' };
  }

  const args = trimmed.match(/"[^"]*"|'[^']*'|\S+/g)?.map((part) => {
    if ((part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"))) {
      return part.slice(1, -1);
    }
    return part;
  }) ?? [];
  const commandName = args[0]?.toLowerCase();
  const allowed = new Set([
    'dbsize',
    'exists',
    'get',
    'hget',
    'hgetall',
    'hlen',
    'info',
    'keys',
    'llen',
    'lrange',
    'memory',
    'mget',
    'ping',
    'scan',
    'scard',
    'smembers',
    'ttl',
    'type',
    'xinfo',
    'xlen',
    'xrange',
    'xrevrange',
    'zcard',
    'zrange',
    'zrevrange',
  ]);

  if (!commandName || !allowed.has(commandName)) {
    return { error: 'Only read-only Redis commands are allowed.' };
  }

  return { args };
}

export function formatToolResult(result: { stdout?: string; stderr?: string; code?: number }, maxOutputLength = DEFAULT_MAX_OUTPUT_LENGTH): string {
  const parts: string[] = [];

  if (result.stdout) {
    parts.push(`stdout:\n${result.stdout}`);
  }

  if (result.stderr) {
    parts.push(`stderr:\n${result.stderr}`);
  }

  if (result.code !== undefined && result.code !== 0) {
    parts.push(`exit code: ${result.code}`);
  }

  return truncateOutput(parts.join('\n\n') || '(no output)', maxOutputLength);
}

async function runRemoteCommand(
  connectionId: string | undefined,
  command: string,
): Promise<{ text: string; details: AiToolDetails }> {
  if (!connectionId) {
    return {
      text: 'Error: no remote connection is available for this tool.',
      details: { command },
    };
  }

  const api = window.guiSSH?.connections;

  if (!api?.runCommand) {
    return {
      text: 'Error: ShellDesk IPC is not available.',
      details: { command },
    };
  }

  try {
    const result = await api.runCommand(connectionId, command);

    return {
      text: formatToolResult(result),
      details: { command, exitCode: result.code, stderr: result.stderr },
    };
  } catch (error) {
    return {
      text: truncateOutput(`Error: ${error instanceof Error ? error.message : String(error)}`),
      details: { command },
    };
  }
}

function textResult(text: string, details: AiToolDetails = {}) {
  return {
    content: [{ type: 'text' as const, text }],
    details,
  };
}

function createRemoteCommandTool(
  name: string,
  label: string,
  description: string,
  parameters: ReturnType<typeof Type.Object>,
  buildCommand: (params: ToolParams, options: SharedToolsOptions) => string | { error: string },
  connectionId: string | undefined,
  options: SharedToolsOptions,
): AgentTool {
  return {
    name,
    label,
    description,
    parameters,
    execute: async (_toolCallId, params) => {
      const command = buildCommand(params as ToolParams, options);

      if (typeof command !== 'string') {
        return textResult(`Error: ${command.error}`);
      }

      const result = await runRemoteCommand(connectionId, command);
      return textResult(result.text, result.details);
    },
    executionMode: 'sequential',
  };
}

function detectContainerRuntimeCommand() {
  return 'rt=$(command -v docker 2>/dev/null || command -v podman 2>/dev/null); if [ -z "$rt" ]; then echo "No docker or podman CLI found"; exit 127; fi';
}

function buildSystemInfoCommand(isWindows: boolean) {
  if (isWindows) {
    return [
      'powershell -NoProfile -Command',
      psQuote([
        '$os = Get-CimInstance Win32_OperatingSystem',
        '$cs = Get-CimInstance Win32_ComputerSystem',
        '$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1',
        'Write-Output "hostname:"; hostname',
        'Write-Output "`nos:"; $os | Select-Object Caption,Version,BuildNumber,LastBootUpTime | Format-List | Out-String -Width 220',
        'Write-Output "`ncpu:"; $cpu | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors,LoadPercentage | Format-List | Out-String -Width 220',
        'Write-Output "`nmemory:"; $cs | Select-Object TotalPhysicalMemory | Format-List | Out-String -Width 220',
        'Write-Output "`ndisks:"; Get-Volume | Format-Table -AutoSize | Out-String -Width 220',
        'Write-Output "`nnetwork:"; Get-NetIPConfiguration | Format-List | Out-String -Width 220',
      ].join('; ')),
    ].join(' ');
  }

  return [
    'printf "hostname:\\n"; hostnamectl 2>/dev/null || hostname',
    'printf "\\nuname:\\n"; uname -a 2>/dev/null',
    'printf "\\nuptime:\\n"; uptime 2>/dev/null',
    'printf "\\ncpu:\\n"; lscpu 2>/dev/null | sed -n "1,25p" || cat /proc/cpuinfo 2>/dev/null | sed -n "1,30p"',
    'printf "\\nmemory:\\n"; free -h 2>/dev/null || vm_stat 2>/dev/null',
    'printf "\\ndisks:\\n"; df -hT 2>/dev/null || df -h 2>/dev/null',
    'printf "\\nnetwork:\\n"; ip -brief addr 2>/dev/null || ifconfig -a 2>/dev/null',
  ].join('; ');
}

function createDatabaseCliOptions(params: ToolParams, kind: 'mysql' | 'postgres' | 'redis') {
  const parts: string[] = [];

  if (params.host?.trim()) {
    parts.push(kind === 'postgres' ? '-h' : '-h', shellQuote(params.host.trim()));
  }

  if (params.port?.trim()) {
    if (!isValidPort(params.port)) {
      return { error: 'Port must be between 1 and 65535.' };
    }
    parts.push(kind === 'postgres' ? '-p' : '-P', shellQuote(params.port.trim()));
  }

  if (params.user?.trim()) {
    parts.push(kind === 'postgres' ? '-U' : '-u', shellQuote(params.user.trim()));
  }

  return { args: parts.join(' ') };
}

function createSharedRemoteTools(connectionId: string | undefined, options: SharedToolsOptions): AgentTool[] {
  const isWindows = isWindowsSystem(options.systemType);

  return [
    {
      name: 'run_command',
      label: 'Run command',
      description: 'Execute a shell command on the connected remote host.',
      parameters: Type.Object({
        command: Type.String({ description: 'Shell command to execute.' }),
      }),
      execute: async (_toolCallId, params) => {
        const { command } = params as RunCommandParams;
        const result = await runRemoteCommand(connectionId, command);
        return textResult(result.text, result.details);
      },
      executionMode: 'sequential',
    },
    {
      name: 'read_file',
      label: 'Read file',
      description: 'Read a text file from the connected remote host using cat or PowerShell.',
      parameters: Type.Object({
        path: Type.String({ description: 'Absolute or relative file path to read.' }),
      }),
      execute: async (_toolCallId, params) => {
        const { path } = params as PathParams;
        const command = isWindows
          ? `powershell -NoProfile -Command ${psQuote(`Get-Content -LiteralPath ${psQuote(path)} -Raw`)}`
          : `cat -- ${shellQuote(path)}`;
        const result = await runRemoteCommand(connectionId, command);
        return textResult(result.text, result.details);
      },
      executionMode: 'sequential',
    },
    {
      name: 'write_file',
      label: 'Write file',
      description: 'Write UTF-8 text content to a remote file. Path and content are base64-encoded before reaching the shell.',
      parameters: Type.Object({
        path: Type.String({ description: 'Absolute or relative file path to write.' }),
        content: Type.String({ description: 'UTF-8 text content to write.' }),
      }),
      execute: async (_toolCallId, params) => {
        const { path, content } = params as WriteFileParams;
        const encodedPath = toBase64(path);
        const encodedContent = toBase64(content);
        const command = isWindows
          ? [
            'powershell -NoProfile -Command',
            psQuote([
              `$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${psQuote(encodedPath)}))`,
              `$bytes = [Convert]::FromBase64String(${psQuote(encodedContent)})`,
              '$parent = Split-Path -Parent $path',
              'if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }',
              '[IO.File]::WriteAllBytes($path, $bytes)',
              'Write-Output "wrote $($bytes.Length) bytes to $path"',
            ].join('; ')),
          ].join(' ')
          : [
            'python3 - <<\'PY\'',
            'import base64',
            'import pathlib',
            `path = pathlib.Path(base64.b64decode(${JSON.stringify(encodedPath)}).decode("utf-8"))`,
            `content = base64.b64decode(${JSON.stringify(encodedContent)})`,
            'if path.parent != pathlib.Path("."):',
            '    path.parent.mkdir(parents=True, exist_ok=True)',
            'path.write_bytes(content)',
            'print(f"wrote {len(content)} bytes to {path}")',
            'PY',
          ].join('\n');
        const result = await runRemoteCommand(connectionId, command);
        return textResult(result.text, result.details);
      },
      executionMode: 'sequential',
    },
    {
      name: 'list_dir',
      label: 'List directory',
      description: 'List directory contents on the connected remote host.',
      parameters: Type.Object({
        path: Type.String({ description: 'Directory path to list.' }),
      }),
      execute: async (_toolCallId, params) => {
        const { path } = params as PathParams;
        const command = isWindows
          ? `powershell -NoProfile -Command ${psQuote(`Get-ChildItem -Force -LiteralPath ${psQuote(path)} | Format-Table -AutoSize | Out-String -Width 220`)}`
          : `ls -la -- ${shellQuote(path)}`;
        const result = await runRemoteCommand(connectionId, command);
        return textResult(result.text, result.details);
      },
      executionMode: 'sequential',
    },
    {
      name: 'search_files',
      label: 'Search files',
      description: 'Search file names or file contents on the connected remote host.',
      parameters: Type.Object({
        path: Type.String({ description: 'Directory path to search.' }),
        query: Type.String({ description: 'Search query.' }),
        mode: Type.Optional(Type.Union([
          Type.Literal('content'),
          Type.Literal('name'),
        ], { description: 'Use content for grep/Select-String or name for find/Get-ChildItem.' })),
      }),
      execute: async (_toolCallId, params) => {
        const { path, query, mode = 'content' } = params as SearchFilesParams;
        const command = isWindows
          ? mode === 'name'
            ? `powershell -NoProfile -Command ${psQuote(`Get-ChildItem -Recurse -Force -LiteralPath ${psQuote(path)} -ErrorAction SilentlyContinue | Where-Object { $_.Name -like ${psQuote(`*${query}*`)} } | Select-Object -First 200 -ExpandProperty FullName`)}`
            : `powershell -NoProfile -Command ${psQuote(`Select-String -Path (Join-Path ${psQuote(path)} '*') -Pattern ${psQuote(query)} -Recurse -ErrorAction SilentlyContinue | Select-Object -First 200 | Out-String -Width 220`)}`
          : mode === 'name'
            ? `find ${shellQuote(path)} -iname ${shellQuote(`*${query}*`)} -print | head -n 200`
            : `grep -RIn -- ${shellQuote(query)} ${shellQuote(path)} | head -n 200`;
        const result = await runRemoteCommand(connectionId, command);
        return textResult(result.text, result.details);
      },
      executionMode: 'sequential',
    },
    createRemoteCommandTool(
      'get_system_info',
      'Get system info',
      'Collect OS, uptime, CPU, memory, disk, and network summary from the connected remote host.',
      Type.Object({}),
      () => buildSystemInfoCommand(isWindows),
      connectionId,
      options,
    ),
    createRemoteCommandTool(
      'list_services',
      'List services',
      'List services on the connected remote host, optionally filtered by name.',
      Type.Object({
        query: Type.Optional(Type.String({ description: 'Optional service name filter.' })),
      }),
      (params) => {
        const query = params.query?.trim();
        if (isWindows) {
          const filter = query ? ` | Where-Object { $_.Name -like ${psQuote(`*${query}*`)} -or $_.DisplayName -like ${psQuote(`*${query}*`)} }` : '';
          return `powershell -NoProfile -Command ${psQuote(`Get-Service${filter} | Sort-Object Name | Format-Table -AutoSize | Out-String -Width 220`)}`;
        }
        const base = 'systemctl list-units --type=service --all --no-pager --plain 2>/dev/null || service --status-all 2>/dev/null';
        return query ? `${base} | grep -i -- ${shellQuote(query)} | head -n 200` : `${base} | head -n 200`;
      },
      connectionId,
      options,
    ),
    createRemoteCommandTool(
      'get_service_status',
      'Get service status',
      'Inspect one service on the connected remote host.',
      Type.Object({
        service: Type.String({ description: 'Service name.' }),
      }),
      (params) => {
        const service = params.service?.trim();
        if (!service) {
          return { error: 'Service name is required.' };
        }
        return isWindows
          ? `powershell -NoProfile -Command ${psQuote(`Get-Service -Name ${psQuote(service)} | Format-List *; Get-CimInstance Win32_Service -Filter "Name='${service.replace(/'/g, "''")}'" | Format-List * | Out-String -Width 220`)}`
          : `systemctl status --no-pager --full ${shellQuote(service)} 2>&1 || service ${shellQuote(service)} status 2>&1`;
      },
      connectionId,
      options,
    ),
    createRemoteCommandTool(
      'restart_service',
      'Restart service',
      'Restart one service on the connected remote host. This may require privileges.',
      Type.Object({
        service: Type.String({ description: 'Service name to restart.' }),
      }),
      (params) => {
        const service = params.service?.trim();
        if (!service) {
          return { error: 'Service name is required.' };
        }
        return isWindows
          ? `powershell -NoProfile -Command ${psQuote(`Restart-Service -Name ${psQuote(service)} -ErrorAction Stop; Get-Service -Name ${psQuote(service)} | Format-List * | Out-String -Width 220`)}`
          : `(sudo -n systemctl restart ${shellQuote(service)} 2>&1 || systemctl restart ${shellQuote(service)} 2>&1); systemctl status --no-pager --full ${shellQuote(service)} 2>&1`;
      },
      connectionId,
      options,
    ),
    createRemoteCommandTool(
      'list_processes',
      'List processes',
      'List top processes on the connected remote host.',
      Type.Object({
        sort: Type.Optional(Type.Union([
          Type.Literal('cpu'),
          Type.Literal('memory'),
        ], { description: 'Sort by cpu or memory.' })),
        limit: Type.Optional(Type.String({ description: 'Maximum rows, default 80.' })),
      }),
      (params) => {
        const limit = toPositiveInt(params.limit, 80, 300);
        const sort = params.sort === 'memory' ? 'WS' : 'CPU';
        if (isWindows) {
          return `powershell -NoProfile -Command ${psQuote(`Get-Process | Sort-Object -Descending ${sort} | Select-Object -First ${limit} Id,ProcessName,CPU,WS,Path | Format-Table -AutoSize | Out-String -Width 240`)}`;
        }
        const unixSort = params.sort === 'memory' ? '-%mem' : '-%cpu';
        return `ps -eo pid,ppid,user,stat,pcpu,pmem,etime,comm,args --sort=${unixSort} 2>/dev/null | head -n ${limit + 1}`;
      },
      connectionId,
      options,
    ),
    createRemoteCommandTool(
      'inspect_process',
      'Inspect process',
      'Inspect one process by PID on the connected remote host.',
      Type.Object({
        pid: Type.String({ description: 'Process ID.' }),
      }),
      (params) => {
        const pid = params.pid?.trim();
        if (!pid || !/^\d+$/.test(pid)) {
          return { error: 'PID must be a positive integer.' };
        }
        return isWindows
          ? `powershell -NoProfile -Command ${psQuote(`Get-Process -Id ${pid} | Format-List * | Out-String -Width 240; Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Format-List * | Out-String -Width 240`)}`
          : `ps -p ${pid} -o pid,ppid,user,stat,pcpu,pmem,etime,comm,args 2>&1; printf "\\n/proc status:\\n"; cat /proc/${pid}/status 2>/dev/null; printf "\\nopen files:\\n"; lsof -p ${pid} 2>/dev/null | head -n 80`;
      },
      connectionId,
      options,
    ),
    createRemoteCommandTool(
      'kill_process',
      'Kill process',
      'Send a signal to one process on the connected remote host.',
      Type.Object({
        pid: Type.String({ description: 'Process ID.' }),
        signal: Type.Optional(Type.String({ description: 'Signal name: TERM, KILL, INT, HUP, QUIT, USR1, USR2. Defaults to TERM.' })),
      }),
      (params) => {
        const pid = params.pid?.trim();
        if (!pid || !/^\d+$/.test(pid)) {
          return { error: 'PID must be a positive integer.' };
        }
        const signal = normalizeSignal(params.signal);
        return isWindows
          ? `powershell -NoProfile -Command ${psQuote(`Stop-Process -Id ${pid} -Force; Write-Output "stopped process ${pid}"`)}`
          : `kill -s ${signal} ${pid} && echo "sent SIG${signal} to ${pid}"`;
      },
      connectionId,
      options,
    ),
    createRemoteCommandTool(
      'list_containers',
      'List containers',
      'List Docker or Podman containers on the connected remote host.',
      Type.Object({}),
      () => isWindows
        ? 'docker ps -a 2>&1'
        : `${detectContainerRuntimeCommand()}; "$rt" ps -a --format "table {{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}" 2>&1`,
      connectionId,
      options,
    ),
    createRemoteCommandTool(
      'container_logs',
      'Container logs',
      'Read Docker or Podman container logs on the connected remote host.',
      Type.Object({
        container: Type.String({ description: 'Container ID or name.' }),
        tail: Type.Optional(Type.String({ description: 'Number of log lines, default 200.' })),
      }),
      (params) => {
        const container = params.container?.trim();
        if (!container) {
          return { error: 'Container name or ID is required.' };
        }
        const tail = toPositiveInt(params.tail, 200, 2000);
        return isWindows
          ? `docker logs --tail ${tail} ${shellQuote(container)} 2>&1`
          : `${detectContainerRuntimeCommand()}; "$rt" logs --tail ${tail} ${shellQuote(container)} 2>&1`;
      },
      connectionId,
      options,
    ),
    createRemoteCommandTool(
      'compose_status',
      'Compose status',
      'Show Docker Compose or Podman Compose status in a remote directory.',
      Type.Object({
        path: Type.Optional(Type.String({ description: 'Compose project directory. Defaults to current directory.' })),
      }),
      (params) => {
        const path = params.path?.trim() || '.';
        return isWindows
          ? `cd /d ${shellQuote(path)} && docker compose ps 2>&1`
          : `cd ${shellQuote(path)} && (docker compose ps 2>&1 || docker-compose ps 2>&1 || podman compose ps 2>&1 || podman-compose ps 2>&1)`;
      },
      connectionId,
      options,
    ),
    createRemoteCommandTool(
      'read_journal',
      'Read journal',
      'Read systemd journal entries on the connected remote host.',
      Type.Object({
        unit: Type.Optional(Type.String({ description: 'Optional systemd unit name.' })),
        since: Type.Optional(Type.String({ description: 'Optional journalctl --since value.' })),
        lines: Type.Optional(Type.String({ description: 'Number of lines, default 200.' })),
      }),
      (params) => {
        if (isWindows) {
          const lines = toPositiveInt(params.lines, 200, 2000);
          return `powershell -NoProfile -Command ${psQuote(`Get-WinEvent -LogName System -MaxEvents ${lines} | Format-List TimeCreated,ProviderName,Id,LevelDisplayName,Message | Out-String -Width 240`)}`;
        }
        const lines = toPositiveInt(params.lines, 200, 2000);
        const unit = params.unit?.trim() ? ` -u ${shellQuote(params.unit.trim())}` : '';
        const since = params.since?.trim() ? ` --since ${shellQuote(params.since.trim())}` : '';
        return `journalctl --no-pager -n ${lines}${unit}${since} 2>&1`;
      },
      connectionId,
      options,
    ),
    createRemoteCommandTool(
      'tail_file',
      'Tail file',
      'Tail a remote log or text file.',
      Type.Object({
        path: Type.String({ description: 'File path.' }),
        lines: Type.Optional(Type.String({ description: 'Number of lines, default 200.' })),
      }),
      (params) => {
        const path = params.path?.trim();
        if (!path) {
          return { error: 'Path is required.' };
        }
        const lines = toPositiveInt(params.lines, 200, 2000);
        return isWindows
          ? `powershell -NoProfile -Command ${psQuote(`Get-Content -LiteralPath ${psQuote(path)} -Tail ${lines}`)}`
          : `tail -n ${lines} -- ${shellQuote(path)} 2>&1`;
      },
      connectionId,
      options,
    ),
    createRemoteCommandTool(
      'search_logs',
      'Search logs',
      'Search remote log files for text.',
      Type.Object({
        path: Type.String({ description: 'File or directory path.' }),
        query: Type.String({ description: 'Search query.' }),
        lines: Type.Optional(Type.String({ description: 'Maximum matches, default 200.' })),
      }),
      (params) => {
        const path = params.path?.trim();
        const query = params.query?.trim();
        if (!path || !query) {
          return { error: 'Path and query are required.' };
        }
        const lines = toPositiveInt(params.lines, 200, 2000);
        return isWindows
          ? `powershell -NoProfile -Command ${psQuote(`Select-String -Path ${psQuote(path)} -Pattern ${psQuote(query)} -ErrorAction SilentlyContinue | Select-Object -First ${lines} | Out-String -Width 240`)}`
          : `grep -RIn -- ${shellQuote(query)} ${shellQuote(path)} 2>/dev/null | head -n ${lines}`;
      },
      connectionId,
      options,
    ),
    createRemoteCommandTool(
      'check_port',
      'Check port',
      'Check TCP connectivity from the connected remote host to a host and port.',
      Type.Object({
        host: Type.String({ description: 'Target host.' }),
        port: Type.String({ description: 'Target TCP port.' }),
      }),
      (params) => {
        const host = params.host?.trim();
        const port = params.port?.trim();
        if (!host || !isValidPort(port)) {
          return { error: 'Host and valid TCP port are required.' };
        }
        return isWindows
          ? `powershell -NoProfile -Command ${psQuote(`Test-NetConnection -ComputerName ${psQuote(host)} -Port ${port} | Format-List * | Out-String -Width 220`)}`
          : `(nc -vz -w 5 ${shellQuote(host)} ${port} 2>&1 || timeout 5 bash -lc ${shellQuote(`</dev/tcp/${host}/${port}`)} 2>&1)`;
      },
      connectionId,
      options,
    ),
    createRemoteCommandTool(
      'curl_url',
      'Curl URL',
      'Fetch a URL from the connected remote host with curl.',
      Type.Object({
        url: Type.String({ description: 'URL to fetch.' }),
        method: Type.Optional(Type.String({ description: 'HTTP method, default GET.' })),
      }),
      (params) => {
        const url = params.url?.trim();
        const method = (params.method?.trim() || 'GET').toUpperCase();
        if (!url || !/^https?:\/\//i.test(url)) {
          return { error: 'Only http and https URLs are supported.' };
        }
        if (!/^[A-Z]+$/.test(method)) {
          return { error: 'HTTP method is invalid.' };
        }
        return `curl -i -L --max-time 20 -X ${method} ${shellQuote(url)} 2>&1 | head -c ${DEFAULT_MAX_OUTPUT_LENGTH}`;
      },
      connectionId,
      options,
    ),
    createRemoteCommandTool(
      'dns_lookup',
      'DNS lookup',
      'Resolve a hostname from the connected remote host.',
      Type.Object({
        host: Type.String({ description: 'Hostname to resolve.' }),
      }),
      (params) => {
        const host = params.host?.trim();
        if (!host) {
          return { error: 'Hostname is required.' };
        }
        return isWindows
          ? `powershell -NoProfile -Command ${psQuote(`Resolve-DnsName ${psQuote(host)} | Format-Table -AutoSize | Out-String -Width 220`)}`
          : `(dig +short ${shellQuote(host)} 2>/dev/null || nslookup ${shellQuote(host)} 2>/dev/null || getent hosts ${shellQuote(host)} 2>/dev/null)`;
      },
      connectionId,
      options,
    ),
    createRemoteCommandTool(
      'trace_route',
      'Trace route',
      'Trace network path from the connected remote host.',
      Type.Object({
        host: Type.String({ description: 'Destination hostname or IP.' }),
      }),
      (params) => {
        const host = params.host?.trim();
        if (!host) {
          return { error: 'Host is required.' };
        }
        return isWindows
          ? `tracert ${shellQuote(host)}`
          : `(traceroute ${shellQuote(host)} 2>&1 || tracepath ${shellQuote(host)} 2>&1 || ping -c 4 ${shellQuote(host)} 2>&1)`;
      },
      connectionId,
      options,
    ),
    createRemoteCommandTool(
      'query_mysql',
      'Query MySQL',
      'Run a read-only MySQL query using mysql CLI on the connected remote host. Uses existing mysql auth config or supplied host/user/database, no password parameter.',
      Type.Object({
        query: Type.String({ description: 'Read-only SQL query.' }),
        database: Type.Optional(Type.String({ description: 'Optional database name.' })),
        host: Type.Optional(Type.String({ description: 'Optional host.' })),
        port: Type.Optional(Type.String({ description: 'Optional port.' })),
        user: Type.Optional(Type.String({ description: 'Optional user.' })),
      }),
      (params) => {
        const normalized = normalizeReadOnlySql(params.query);
        if (normalized.error) {
          return { error: normalized.error };
        }
        const optionsResult = createDatabaseCliOptions(params, 'mysql');
        if (optionsResult.error) {
          return { error: optionsResult.error };
        }
        const database = params.database?.trim() ? ` ${shellQuote(params.database.trim())}` : '';
        return `mysql --batch --raw --table ${optionsResult.args} ${database} -e ${shellQuote(normalized.query!)} 2>&1`;
      },
      connectionId,
      options,
    ),
    createRemoteCommandTool(
      'query_postgres',
      'Query PostgreSQL',
      'Run a read-only PostgreSQL query using psql CLI on the connected remote host. Uses existing psql auth config or supplied host/user/database, no password parameter.',
      Type.Object({
        query: Type.String({ description: 'Read-only SQL query.' }),
        database: Type.Optional(Type.String({ description: 'Optional database name.' })),
        host: Type.Optional(Type.String({ description: 'Optional host.' })),
        port: Type.Optional(Type.String({ description: 'Optional port.' })),
        user: Type.Optional(Type.String({ description: 'Optional user.' })),
      }),
      (params) => {
        const normalized = normalizeReadOnlySql(params.query);
        if (normalized.error) {
          return { error: normalized.error };
        }
        const optionsResult = createDatabaseCliOptions(params, 'postgres');
        if (optionsResult.error) {
          return { error: optionsResult.error };
        }
        const database = params.database?.trim() ? ` -d ${shellQuote(params.database.trim())}` : '';
        return `psql -X -P pager=off ${optionsResult.args}${database} -c ${shellQuote(normalized.query!)} 2>&1`;
      },
      connectionId,
      options,
    ),
    createRemoteCommandTool(
      'query_redis',
      'Query Redis',
      'Run a read-only Redis command using redis-cli on the connected remote host. Uses existing Redis auth config, no password parameter.',
      Type.Object({
        command: Type.String({ description: 'Read-only Redis command, for example INFO, GET key, HGETALL key, LRANGE key 0 20.' }),
        host: Type.Optional(Type.String({ description: 'Optional host.' })),
        port: Type.Optional(Type.String({ description: 'Optional port.' })),
      }),
      (params) => {
        const normalized = normalizeRedisReadOnlyCommand(params.command);
        if (normalized.error) {
          return { error: normalized.error };
        }
        const host = params.host?.trim() ? ` -h ${shellQuote(params.host.trim())}` : '';
        if (params.port?.trim() && !isValidPort(params.port)) {
          return { error: 'Port must be between 1 and 65535.' };
        }
        const port = params.port?.trim() ? ` -p ${shellQuote(params.port.trim())}` : '';
        const args = normalized.args!.map(shellQuote).join(' ');
        return `redis-cli${host}${port} --raw ${args} 2>&1`;
      },
      connectionId,
      options,
    ),
    createRemoteCommandTool(
      'check_ssh_security',
      'Check SSH security',
      'Inspect SSH server security-relevant settings on the connected remote host.',
      Type.Object({}),
      () => isWindows
        ? 'powershell -NoProfile -Command "Write-Output \'OpenSSH server config:\'; Get-Content $env:ProgramData\\ssh\\sshd_config -ErrorAction SilentlyContinue"'
        : [
          'printf "effective sshd settings:\\n"',
          'sshd -T 2>/dev/null | grep -Ei "^(port|permitrootlogin|passwordauthentication|pubkeyauthentication|permitemptypasswords|kbdinteractiveauthentication|challengeresponseauthentication|maxauthtries|allowusers|denyusers|x11forwarding|allowtcpforwarding)" || true',
          'printf "\\nconfig snippets:\\n"',
          'grep -RInE "^(\\s*)?(Port|PermitRootLogin|PasswordAuthentication|PubkeyAuthentication|PermitEmptyPasswords|KbdInteractiveAuthentication|ChallengeResponseAuthentication|MaxAuthTries|AllowUsers|DenyUsers|X11Forwarding|AllowTcpForwarding)" /etc/ssh/sshd_config /etc/ssh/sshd_config.d 2>/dev/null || true',
        ].join('; '),
      connectionId,
      options,
    ),
    createRemoteCommandTool(
      'check_firewall',
      'Check firewall',
      'Inspect firewall status and rules on the connected remote host.',
      Type.Object({}),
      () => isWindows
        ? 'powershell -NoProfile -Command "Get-NetFirewallProfile | Format-List * | Out-String -Width 220; Get-NetFirewallRule -Enabled True | Select-Object -First 100 DisplayName,Direction,Action,Profile | Format-Table -AutoSize | Out-String -Width 220"'
        : '(ufw status verbose 2>&1 || true); printf "\\nfirewalld:\\n"; (firewall-cmd --state 2>&1 && firewall-cmd --list-all 2>&1 || true); printf "\\nnftables:\\n"; (nft list ruleset 2>/dev/null | head -n 200 || true); printf "\\niptables:\\n"; (iptables -S 2>/dev/null | head -n 200 || true)',
      connectionId,
      options,
    ),
    createRemoteCommandTool(
      'check_users',
      'Check users',
      'Inspect local users, privileged groups, and active login sessions on the connected remote host.',
      Type.Object({}),
      () => isWindows
        ? 'powershell -NoProfile -Command "Get-LocalUser | Format-Table -AutoSize | Out-String -Width 220; Write-Output \'Administrators:\'; Get-LocalGroupMember Administrators | Format-Table -AutoSize | Out-String -Width 220; quser 2>$null"'
        : [
          'printf "interactive users:\\n"',
          'awk -F: \'($3 >= 1000 || $3 == 0) {print $1 ":" $3 ":" $6 ":" $7}\' /etc/passwd 2>/dev/null',
          'printf "\\nprivileged groups:\\n"',
          'getent group sudo wheel admin 2>/dev/null || true',
          'printf "\\ncurrent sessions:\\n"',
          'who 2>/dev/null || true',
          'printf "\\nrecent logins:\\n"',
          'last -n 20 2>/dev/null || true',
        ].join('; '),
      connectionId,
      options,
    ),
  ];
}

function createOpenDesktopAppTool(options: SharedToolsOptions): AgentTool {
  return {
    name: 'open_desktop_app',
    label: 'Open component',
    description: `Open a ShellDesk remote desktop component window. Available appKey values: ${SHELLDESK_APP_KEYS.join(', ')}.`,
    parameters: Type.Object({
      appKey: Type.String({ description: 'ShellDesk component app key to open.' }),
    }),
    execute: async (_toolCallId, params) => {
      const appKey = (params as ToolParams).appKey?.trim() as ShellDeskDesktopAppKey | undefined;

      if (!appKey || !SHELLDESK_APP_KEYS.includes(appKey)) {
        return textResult(`Error: appKey must be one of: ${SHELLDESK_APP_KEYS.join(', ')}`);
      }

      if (!options.onOpenApp) {
        return textResult('Error: ShellDesk component opening is not available in this context.');
      }

      window.setTimeout(() => options.onOpenApp?.(appKey), 0);
      return textResult(`Opened ShellDesk component: ${appKey}`);
    },
    executionMode: 'sequential',
  };
}

export function createSharedTools(connectionId?: string, options: SharedToolsOptions = {}): AgentTool[] {
  return [
    ...createSharedRemoteTools(connectionId, options),
    createOpenDesktopAppTool(options),
  ];
}

export async function executeForAi(connectionId: string, command: string): Promise<string> {
  const result = await runRemoteCommand(connectionId, command);
  return result.text;
}
