import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { getErrorMessage } from './desktopUtils';
import MarkdownReport from './MarkdownReport';
import { isWindowsSystem, powershellCommand, powershellStdinCommand, type RemoteCommandInput } from './remoteSystem';
import type { RemoteSystemType } from './types';

export type RemoteProcessManagerSortKey =
  | 'pid'
  | 'ppid'
  | 'user'
  | 'cpu'
  | 'memory'
  | 'state'
  | 'startTime'
  | 'runtime'
  | 'command';

export type RemoteProcessManagerViewMode = 'table' | 'tree';

export interface RemoteProcessManagerLaunchOptions {
  pid?: number;
  search?: string;
  user?: string;
  sortKey?: RemoteProcessManagerSortKey;
  sortDir?: SortDir;
  viewMode?: RemoteProcessManagerViewMode;
}

interface RemoteProcessManagerProps {
  connectionId: string;
  settings: ShellDeskAppSettings;
  systemType?: RemoteSystemType;
  launchOptions?: RemoteProcessManagerLaunchOptions;
}

export interface RemoteProcessEntry {
  pid: number;
  ppid?: number;
  user?: string;
  cpuPercent?: number;
  cpuSeconds?: number;
  memoryPercent?: number;
  memoryMb?: number;
  state?: string;
  startTime?: string;
  runtime?: string;
  cpuTime?: string;
  tty?: string;
  vszKb?: number;
  rssKb?: number;
  command: string;
  executablePath?: string;
}

interface ProcessDetail {
  pid: number;
  cwd?: string;
  executablePath?: string;
  ports: string[];
  loadedAt: number;
  error?: string;
}

interface ProcessRow {
  process: RemoteProcessEntry;
  depth: number;
}

type SortDir = 'asc' | 'desc';

interface SignalDefinition {
  value: string;
  name: string;
  label: string;
  description: string;
}

interface PendingSignal {
  pid: number;
  command: string;
  signal: SignalDefinition;
}

type ProcessAiReportPhase = 'idle' | 'preparing' | 'requesting' | 'streaming' | 'done' | 'error';

interface ProcessAiSnapshot {
  text: string;
  includedCount: number;
  omittedCount: number;
}

interface ProcessAiInsight {
  pid: number;
  content: string;
  error?: string;
}

const SIGNALS: SignalDefinition[] = [
  {
    value: '15',
    name: 'TERM',
    label: 'TERM',
    description: '请求进程自行退出，适合优先尝试，通常会触发清理逻辑。',
  },
  {
    value: '9',
    name: 'KILL',
    label: 'KILL',
    description: '由系统强制结束进程，进程没有机会保存状态或清理资源。',
  },
  {
    value: '2',
    name: 'INT',
    label: 'INT',
    description: '等同终端 Ctrl+C，适合前台任务或可中断脚本。',
  },
  {
    value: '1',
    name: 'HUP',
    label: 'HUP',
    description: '通知进程挂断或重新加载配置，具体行为由进程自行决定。',
  },
];

const AUTO_REFRESH_OPTIONS = [3000, 5000, 10000] as const;
const DEFAULT_AUTO_REFRESH_MS = 5000;
const DEFAULT_SIGNAL = SIGNALS[0];
const PROCESS_AI_SNAPSHOT_CHAR_LIMIT = 100000;
const PROCESS_AI_FIELD_CHAR_LIMIT = 260;
const PROCESS_AI_REPORT_SYSTEM_PROMPT = `你是 ShellDesk 的 SD-Agent 进程安全分析助手。你只能基于用户提供的进程快照做静态研判，不要假装已经扫描文件、查杀病毒或访问外部情报。

请用中文输出 Markdown 报告，重点判断是否存在病毒、木马、挖矿、横向移动、持久化后门、异常高资源占用、伪装系统进程、可疑路径或可疑命令行。对每个可疑项给出 PID、风险等级、依据、建议核验动作。没有明显风险时也要说明仍建议做哪些人工复核，但后续可疑进程、继续核验和建议处置部分要明显简略，不要为了凑结构输出冗长内容。`;
const PROCESS_AI_INSIGHT_SYSTEM_PROMPT = '你是 ShellDesk 的 SD-Agent 进程解释助手。请用中文简短解释单个进程通常是做什么的，并结合本次快照指出是否有明显异常。不要给出确定性的恶意判定。';

function readInteger(value: string | number | undefined | null) {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const parsedValue = Number.parseInt(value, 10);
  return Number.isInteger(parsedValue) ? parsedValue : undefined;
}

function readNumber(value: string | number | undefined | null) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== 'string' || !value.trim() || value === '-') {
    return undefined;
  }

  const parsedValue = Number.parseFloat(value);
  return Number.isFinite(parsedValue) ? parsedValue : undefined;
}

function clampPercent(value: number | undefined) {
  if (value === undefined) {
    return 0;
  }

  return Math.min(Math.max(value, 0), 100);
}

function formatMetric(value: number | undefined, suffix = '') {
  if (value === undefined || !Number.isFinite(value)) {
    return '-';
  }

  const formattedValue = value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
  return `${formattedValue.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')}${suffix}`;
}

function formatMemory(process: RemoteProcessEntry, isWindowsHost: boolean) {
  if (isWindowsHost) {
    return formatMetric(process.memoryMb, ' MB');
  }

  return formatMetric(process.memoryPercent, '%');
}

function formatCpu(process: RemoteProcessEntry, isWindowsHost: boolean) {
  if (isWindowsHost) {
    return formatMetric(process.cpuSeconds, 's');
  }

  return formatMetric(process.cpuPercent, '%');
}

function getCpuValue(process: RemoteProcessEntry, isWindowsHost: boolean) {
  return isWindowsHost ? process.cpuSeconds ?? 0 : process.cpuPercent ?? 0;
}

function getMemoryValue(process: RemoteProcessEntry, isWindowsHost: boolean) {
  return isWindowsHost ? process.memoryMb ?? 0 : process.memoryPercent ?? 0;
}

function compactAiField(value: string | number | undefined | null, maxLength = PROCESS_AI_FIELD_CHAR_LIMIT) {
  if (value === undefined || value === null || value === '') {
    return '-';
  }

  const normalizedValue = String(value).replace(/\s+/g, ' ').trim();

  if (normalizedValue.length <= maxLength) {
    return normalizedValue || '-';
  }

  return `${normalizedValue.slice(0, maxLength)}...`;
}

function getAiReadinessError(settings: ShellDeskAppSettings) {
  const aiControls = window.guiSSH?.ai;

  if (!aiControls?.chat && !aiControls?.chatStream) {
    return '当前运行环境未提供 SD-Agent 对话接口。';
  }

  if (!settings.aiApiBaseUrl.trim() || !settings.aiApiKey.trim() || !settings.aiModel.trim()) {
    return '请先在设置中完成 SD-Agent 提供商、API 密钥和模型配置。';
  }

  return '';
}

function createAiChatRequest(
  settings: ShellDeskAppSettings,
  messages: ShellDeskAiChatMessage[],
  temperature = 0.2,
): ShellDeskAiChatRequest {
  return {
    provider: settings.aiProvider,
    apiFormat: settings.aiApiFormat,
    apiBaseUrl: settings.aiApiBaseUrl,
    apiKey: settings.aiApiKey,
    model: settings.aiModel,
    temperature,
    messages,
  };
}

function formatProcessAiLine(process: RemoteProcessEntry, isWindowsHost: boolean, index: number) {
  return [
    `#${index + 1}`,
    `pid=${process.pid}`,
    `ppid=${process.ppid ?? '-'}`,
    `user=${compactAiField(process.user)}`,
    `cpu=${compactAiField(formatCpu(process, isWindowsHost))}`,
    `memory=${compactAiField(formatMemory(process, isWindowsHost))}`,
    `state=${compactAiField(process.state)}`,
    `start=${compactAiField(process.startTime)}`,
    `runtime=${compactAiField(process.runtime || process.cpuTime)}`,
    `tty=${compactAiField(process.tty)}`,
    `path=${compactAiField(process.executablePath)}`,
    `command=${compactAiField(process.command)}`,
  ].join('\t');
}

function createProcessAiSnapshot(processes: RemoteProcessEntry[], isWindowsHost: boolean): ProcessAiSnapshot {
  const header = [
    `system=${isWindowsHost ? 'Windows' : 'Linux/Unix'}`,
    `processCount=${processes.length}`,
    `snapshotAt=${new Date().toISOString()}`,
    'fields=index, pid, ppid, user, cpu, memory, state, start, runtime, tty, path, command',
  ].join('\n');
  let text = `${header}\n`;
  let includedCount = 0;

  for (const [index, process] of processes.entries()) {
    const line = formatProcessAiLine(process, isWindowsHost, index);

    if (text.length + line.length + 1 > PROCESS_AI_SNAPSHOT_CHAR_LIMIT) {
      break;
    }

    text += `${line}\n`;
    includedCount += 1;
  }

  const omittedCount = Math.max(0, processes.length - includedCount);

  if (omittedCount > 0) {
    text += `\n[注意] 由于 SD-Agent 单条消息长度限制，后续 ${omittedCount} 个进程未发送。请在报告里明确说明这个限制。\n`;
  }

  return {
    text,
    includedCount,
    omittedCount,
  };
}

function formatProcessContextForAi(
  process: RemoteProcessEntry,
  isWindowsHost: boolean,
  detail: ProcessDetail | null,
  parent: RemoteProcessEntry | null,
  children: RemoteProcessEntry[],
) {
  return [
    `系统：${isWindowsHost ? 'Windows' : 'Linux/Unix'}`,
    `PID：${process.pid}`,
    `PPID：${process.ppid ?? '-'}`,
    `用户：${compactAiField(process.user)}`,
    `CPU：${formatCpu(process, isWindowsHost)}`,
    `内存：${formatMemory(process, isWindowsHost)}`,
    `状态：${compactAiField(process.state)}`,
    `启动：${compactAiField(process.startTime)}`,
    `运行时间：${compactAiField(process.runtime || process.cpuTime)}`,
    `TTY：${compactAiField(process.tty)}`,
    `可执行路径：${compactAiField(detail?.executablePath || process.executablePath, 500)}`,
    `工作目录：${compactAiField(detail?.cwd, 500)}`,
    `命令行：${compactAiField(process.command, 900)}`,
    `父进程：${parent ? `${parent.pid} ${compactAiField(parent.command, 300)}` : '-'}`,
    `子进程：${children.length ? children.slice(0, 8).map((child) => `${child.pid} ${compactAiField(child.command, 180)}`).join(' | ') : '-'}`,
    `端口：${detail?.ports.length ? detail.ports.slice(0, 12).map((port) => compactAiField(port, 180)).join(' | ') : '-'}`,
  ].join('\n');
}

function getAiReportPhaseLabel(phase: ProcessAiReportPhase) {
  if (phase === 'preparing') return '正在整理进程快照...';
  if (phase === 'requesting') return '正在请求 SD-Agent...';
  if (phase === 'streaming') return '正在接收分析报告...';
  if (phase === 'done') return '分析完成';
  if (phase === 'error') return '分析失败';
  return '等待开始';
}

function createAiReportDocument(report: string, generatedAt: string, snapshotNote: string) {
  return [
    '# ShellDesk 进程 AI 风险分析报告',
    generatedAt ? `生成时间：${generatedAt}` : '',
    snapshotNote,
    '',
    report.trim(),
  ].filter(Boolean).join('\n');
}

function createAiReportFileName() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `shelldesk-process-ai-report-${timestamp}.md`;
}

function createStreamedTextUpdater(setText: (value: string) => void, fallbackText: string) {
  let nextText = '';
  let timerId: number | undefined;

  const doFlush = () => {
    timerId = undefined;
    setText(nextText || fallbackText);
  };

  return {
    append(chunk: string) {
      nextText += chunk;

      if (timerId !== undefined) {
        return;
      }

      timerId = window.setTimeout(doFlush, 250);
    },
    cancel() {
      if (timerId !== undefined) {
        window.clearTimeout(timerId);
        timerId = undefined;
      }
    },
    flush() {
      if (timerId !== undefined) {
        window.clearTimeout(timerId);
      }

      doFlush();
    },
  };
}

function getSignalByValue(value: string) {
  return SIGNALS.find((signal) => signal.value === value) ?? DEFAULT_SIGNAL;
}

function parseLinuxProcessLine(line: string): RemoteProcessEntry | null {
  const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/);

  if (!match) {
    return null;
  }

  const pid = readInteger(match[1]);

  if (pid === undefined) {
    return null;
  }

  return {
    pid,
    ppid: readInteger(match[2]),
    user: match[3] || '-',
    cpuPercent: readNumber(match[4]),
    memoryPercent: readNumber(match[5]),
    vszKb: readInteger(match[6]),
    rssKb: readInteger(match[7]),
    tty: match[8],
    state: match[9],
    startTime: match[10],
    runtime: match[11],
    cpuTime: match[12],
    command: match[13]?.trim() || '(无命令)',
  };
}

function parsePsAuxLine(line: string): RemoteProcessEntry | null {
  const parts = line.trim().split(/\s+/);

  if (parts.length < 11 || parts[0].toUpperCase() === 'USER') {
    return null;
  }

  const pid = readInteger(parts[1]);

  if (pid === undefined) {
    return null;
  }

  return {
    pid,
    user: parts[0],
    cpuPercent: readNumber(parts[2]),
    memoryPercent: readNumber(parts[3]),
    vszKb: readInteger(parts[4]),
    rssKb: readInteger(parts[5]),
    tty: parts[6],
    state: parts[7],
    startTime: parts[8],
    cpuTime: parts[9],
    command: parts.slice(10).join(' ') || '(无命令)',
  };
}

function parseLinuxProcessOutput(stdout: string): RemoteProcessEntry[] {
  return stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => parseLinuxProcessLine(line) ?? parsePsAuxLine(line))
    .filter((process): process is RemoteProcessEntry => Boolean(process));
}

function parseWindowsProcessOutput(stdout: string): RemoteProcessEntry[] {
  const text = stdout.trim();

  if (!text) {
    return [];
  }

  try {
    const parsedJson = JSON.parse(text) as unknown;
    const records = Array.isArray(parsedJson) ? parsedJson : [parsedJson];

    return records
      .map<RemoteProcessEntry | null>((record) => {
        if (!record || typeof record !== 'object') {
          return null;
        }

        const item = record as Record<string, unknown>;
        const pid = readInteger(item.pid as string | number | undefined);

        if (pid === undefined) {
          return null;
        }

        const process: RemoteProcessEntry = {
          pid,
          ppid: readInteger(item.ppid as string | number | undefined),
          user: typeof item.user === 'string' && item.user.trim() ? item.user : '-',
          cpuSeconds: readNumber(item.cpuSeconds as string | number | undefined),
          memoryMb: readNumber(item.memoryMb as string | number | undefined),
          state: typeof item.state === 'string' ? item.state : 'Running',
          startTime: typeof item.startTime === 'string' ? item.startTime : '',
          runtime: typeof item.runtime === 'string' ? item.runtime : '',
          cpuTime: typeof item.cpuTime === 'string' ? item.cpuTime : '',
          command: typeof item.command === 'string' && item.command.trim() ? item.command : `PID ${pid}`,
          executablePath: typeof item.executablePath === 'string' ? item.executablePath : undefined,
        };

        return process;
      })
      .filter((process): process is RemoteProcessEntry => Boolean(process));
  } catch {
    return text
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map<RemoteProcessEntry | null>((line) => {
        const parts = line.split('\t');

        if (parts[0] !== 'PROC') {
          return null;
        }

        const pid = readInteger(parts[1]);

        if (pid === undefined) {
          return null;
        }

        return {
          pid,
          ppid: readInteger(parts[2]),
          user: parts[3] || '-',
          cpuSeconds: readNumber(parts[4]),
          memoryMb: readNumber(parts[5]),
          state: parts[6] || 'Running',
          startTime: parts[7] || '',
          runtime: parts[8] || '',
          cpuTime: parts[9] || '',
          command: parts[10]?.trim() || `PID ${pid}`,
          executablePath: parts[11]?.trim() || undefined,
        };
      })
      .filter((process): process is RemoteProcessEntry => Boolean(process));
  }
}

function getLinuxProcessListCommand() {
  return "(ps -eo pid=,ppid=,user=,pcpu=,pmem=,vsz=,rss=,tty=,stat=,start=,etime=,time=,args= 2>/dev/null || ps aux 2>/dev/null) | head -n 800";
}

function getWindowsProcessListCommand() {
  return powershellStdinCommand(`
$tab = [char]9
$hasInvokeCimMethod = [bool](Get-Command Invoke-CimMethod -ErrorAction SilentlyContinue)

function Clean-Field($value) {
  if ($null -eq $value) { return '' }
  return ([string]$value) -replace "[\`r\`n\`t]", ' '
}

function Is-Blank($value) {
  if ($null -eq $value) { return $true }
  return ([string]$value).Trim().Length -eq 0
}

function Write-ProcessRow($processIdValue, $parentProcessIdValue, $owner, $cpuSeconds, $memoryMb, $state, $startTime, $runtime, $cpuTime, $command, $path) {
  $fields = @(
    'PROC',
    $processIdValue,
    $parentProcessIdValue,
    $owner,
    $cpuSeconds,
    $memoryMb,
    $state,
    $startTime,
    $runtime,
    $cpuTime,
    $command,
    $path
  )
  ($fields | ForEach-Object { Clean-Field $_ }) -join $tab
}

function Get-ProcessRecords {
  try {
    return @(Get-CimInstance Win32_Process -ErrorAction Stop)
  } catch {
    try {
      return @(Get-WmiObject Win32_Process -ErrorAction Stop)
    } catch {
      return @()
    }
  }
}

function Get-OwnerText($processRecord) {
  $owner = '-'
  try {
    $ownerInfo = $null
    if ($hasInvokeCimMethod) {
      $ownerInfo = Invoke-CimMethod -InputObject $processRecord -MethodName GetOwner -ErrorAction Stop
    } elseif ($processRecord.PSObject.Methods['GetOwner']) {
      $ownerInfo = $processRecord.GetOwner()
    }

    if ($ownerInfo -and $ownerInfo.ReturnValue -eq 0 -and $ownerInfo.User) {
      if ($ownerInfo.Domain) { $owner = "$($ownerInfo.Domain)\\$($ownerInfo.User)" } else { $owner = $ownerInfo.User }
    }
  } catch {}

  return $owner
}

function Format-ProcessDate($value) {
  if ($null -eq $value) { return '' }
  try {
    if ($value -is [datetime]) { return $value.ToString('yyyy-MM-dd HH:mm') }
    return ([Management.ManagementDateTimeConverter]::ToDateTime([string]$value)).ToString('yyyy-MM-dd HH:mm')
  } catch {
    try { return ([datetime]$value).ToString('yyyy-MM-dd HH:mm') } catch { return [string]$value }
  }
}

$processById = @{}
try {
  Get-Process -ErrorAction SilentlyContinue | ForEach-Object {
    $processById[[int]$_.Id] = $_
  }
} catch {}

$processRecords = Get-ProcessRecords
$rowCount = 0

if (@($processRecords).Count -gt 0) {
foreach ($record in @($processRecords)) {
  if ($rowCount -ge 800) { break }
  $rowCount += 1

  $_ = $record
  $proc = $processById[[int]$_.ProcessId]
  $owner = Get-OwnerText $_

  $cpuSeconds = $null
  if ($proc -and $null -ne $proc.CPU) { $cpuSeconds = [double][math]::Round($proc.CPU, 1) }

  $memoryMb = $null
  if ($null -ne $_.WorkingSetSize) {
    $memoryMb = [double][math]::Round(([double]$_.WorkingSetSize / 1MB), 1)
  } elseif ($proc -and $null -ne $proc.WorkingSet64) {
    $memoryMb = [double][math]::Round(([double]$proc.WorkingSet64 / 1MB), 1)
  }

  $startTime = Format-ProcessDate $_.CreationDate

  $state = 'Running'
  if ($proc -and $proc.Responding -eq $false) { $state = 'NotResponding' }

  $command = $_.CommandLine
  if (Is-Blank $command) { $command = $_.Name }

  $parentPid = $null
  if ($null -ne $_.ParentProcessId) { $parentPid = [int]$_.ParentProcessId }

  $cpuTime = ''
  if ($null -ne $cpuSeconds) { $cpuTime = "$cpuSeconds s" }

  Write-ProcessRow ([int]$_.ProcessId) $parentPid $owner $cpuSeconds $memoryMb $state $startTime '' $cpuTime $command $_.ExecutablePath
}
} elseif ($processById.Count -gt 0) {
  foreach ($processEntry in @($processById.Values)) {
    if ($rowCount -ge 800) { break }
    $rowCount += 1
    $_ = $processEntry
    $cpuSeconds = $null
    if ($null -ne $_.CPU) { $cpuSeconds = [double][math]::Round($_.CPU, 1) }
    $memoryMb = $null
    if ($null -ne $_.WorkingSet64) { $memoryMb = [double][math]::Round(([double]$_.WorkingSet64 / 1MB), 1) }
    $startTime = ''
    try { if ($_.StartTime) { $startTime = $_.StartTime.ToString('yyyy-MM-dd HH:mm') } } catch {}
    $state = 'Running'
    if ($_.Responding -eq $false) { $state = 'NotResponding' }
    $cpuTime = ''
    if ($null -ne $cpuSeconds) { $cpuTime = "$cpuSeconds s" }
    $path = $null
    try { $path = $_.Path } catch {}

    Write-ProcessRow ([int]$_.Id) '' '-' $cpuSeconds $memoryMb $state $startTime '' $cpuTime $_.ProcessName $path
  }
}
`);
}

function parseProcessDetailOutput(stdout: string, pid: number): ProcessDetail {
  const detail: ProcessDetail = {
    pid,
    ports: [],
    loadedAt: Date.now(),
  };

  stdout.split(/\r?\n/).forEach((line) => {
    const [kind, ...rest] = line.split('\t');
    const value = rest.join('\t').trim();

    if (!value) {
      return;
    }

    if (kind === 'CWD') {
      detail.cwd = value;
    } else if (kind === 'PATH') {
      detail.executablePath = value;
    } else if (kind === 'PORT') {
      detail.ports.push(value);
    }
  });

  return detail;
}

function getLinuxProcessDetailCommand(pid: number) {
  return `
{ pwdx ${pid} 2>/dev/null | sed 's/^[^:]*:[[:space:]]*/CWD\\t/'; } || true
if command -v ss >/dev/null 2>&1; then
  ss -Htunlp 2>/dev/null | awk -v pid='pid=${pid},' 'index($0, pid) { print "PORT\\t" $0 }'
elif command -v netstat >/dev/null 2>&1; then
  netstat -tunlp 2>/dev/null | awk -v pid='${pid}/' 'index($0, pid) { print "PORT\\t" $0 }'
fi
`;
}

function getWindowsProcessDetailCommand(pid: number) {
  return powershellStdinCommand(`
$tab = [char]9
$foundPort = $false
$proc = $null
try { $proc = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction Stop } catch {
  try { $proc = Get-WmiObject Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction Stop } catch {}
}
if ($proc -and $proc.ExecutablePath) {
  "PATH" + $tab + $proc.ExecutablePath
} else {
  try {
    $psProc = Get-Process -Id ${pid} -ErrorAction Stop
    if ($psProc.Path) { "PATH" + $tab + $psProc.Path }
  } catch {}
}
try {
  if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
    Get-NetTCPConnection -OwningProcess ${pid} -ErrorAction Stop | ForEach-Object {
      $foundPort = $true
      "PORT" + $tab + "TCP $($_.LocalAddress):$($_.LocalPort) -> $($_.RemoteAddress):$($_.RemotePort) $($_.State)"
    }
  }
} catch {}
try {
  if (Get-Command Get-NetUDPEndpoint -ErrorAction SilentlyContinue) {
    Get-NetUDPEndpoint -OwningProcess ${pid} -ErrorAction Stop | ForEach-Object {
      $foundPort = $true
      "PORT" + $tab + "UDP $($_.LocalAddress):$($_.LocalPort)"
    }
  }
} catch {}
if (-not $foundPort) {
  try {
    netstat -ano | ForEach-Object {
      $line = $_.Trim()
      if ($line -match '^(TCP|UDP)\\s+' -and $line -match '\\s+${pid}$') {
        "PORT" + $tab + $line
      }
    }
  } catch {}
}
`);
}

async function runCmd(connectionId: string, command: string | RemoteCommandInput) {
  const api = window.guiSSH?.connections;

  if (!api) {
    throw new Error('ShellDesk IPC 未就绪。');
  }

  if (typeof command === 'string') {
    return api.runCommand(connectionId, command);
  }

  return api.runCommand(connectionId, command.command, command.stdin);
}

function getStateTone(state?: string) {
  if (!state) {
    return 'idle';
  }

  const normalizedState = state.toUpperCase();

  if (normalizedState.startsWith('R')) {
    return 'running';
  }

  if (normalizedState.startsWith('D') || normalizedState.includes('NOTRESPONDING')) {
    return 'blocked';
  }

  if (normalizedState.startsWith('Z')) {
    return 'zombie';
  }

  return 'idle';
}

function compareProcesses(
  first: RemoteProcessEntry,
  second: RemoteProcessEntry,
  sortKey: RemoteProcessManagerSortKey,
  sortDir: SortDir,
  isWindowsHost: boolean,
) {
  const direction = sortDir === 'asc' ? 1 : -1;

  const readSortValue = (process: RemoteProcessEntry) => {
    if (sortKey === 'pid') return process.pid;
    if (sortKey === 'ppid') return process.ppid ?? -1;
    if (sortKey === 'cpu') return getCpuValue(process, isWindowsHost);
    if (sortKey === 'memory') return getMemoryValue(process, isWindowsHost);
    if (sortKey === 'user') return process.user ?? '';
    if (sortKey === 'state') return process.state ?? '';
    if (sortKey === 'startTime') return process.startTime ?? '';
    if (sortKey === 'runtime') return process.runtime ?? '';
    return process.command;
  };

  const firstValue = readSortValue(first);
  const secondValue = readSortValue(second);

  if (typeof firstValue === 'number' && typeof secondValue === 'number') {
    return (firstValue - secondValue) * direction;
  }

  return String(firstValue).localeCompare(String(secondValue), 'zh-CN') * direction;
}

function matchesQuery(process: RemoteProcessEntry, query: string) {
  if (!query) {
    return true;
  }

  const normalizedQuery = query.toLowerCase();
  const searchableText = [
    process.pid,
    process.ppid,
    process.user,
    process.state,
    process.command,
    process.executablePath,
  ].filter((value) => value !== undefined && value !== null).join(' ').toLowerCase();

  return searchableText.includes(normalizedQuery);
}

function flattenProcessTree(
  processes: RemoteProcessEntry[],
  visiblePids: Set<number>,
  compare: (first: RemoteProcessEntry, second: RemoteProcessEntry) => number,
) {
  const processByPid = new Map(processes.map((process) => [process.pid, process]));
  const childrenByPid = new Map<number, RemoteProcessEntry[]>();

  processes.forEach((process) => {
    if (!visiblePids.has(process.pid)) {
      return;
    }

    const parentPid = process.ppid;

    if (parentPid === undefined || !visiblePids.has(parentPid)) {
      return;
    }

    const children = childrenByPid.get(parentPid) ?? [];
    children.push(process);
    childrenByPid.set(parentPid, children);
  });

  childrenByPid.forEach((children) => children.sort(compare));

  const roots = processes
    .filter((process) => visiblePids.has(process.pid))
    .filter((process) => process.ppid === undefined || !processByPid.has(process.ppid) || !visiblePids.has(process.ppid))
    .sort(compare);
  const rows: ProcessRow[] = [];
  const walkedPids = new Set<number>();

  const walk = (process: RemoteProcessEntry, depth: number) => {
    if (walkedPids.has(process.pid)) {
      return;
    }

    walkedPids.add(process.pid);
    rows.push({ process, depth });
    (childrenByPid.get(process.pid) ?? []).forEach((child) => walk(child, depth + 1));
  };

  roots.forEach((process) => walk(process, 0));

  processes
    .filter((process) => visiblePids.has(process.pid) && !walkedPids.has(process.pid))
    .sort(compare)
    .forEach((process) => rows.push({ process, depth: 0 }));

  return rows;
}

function ProcessManager({ connectionId, settings, systemType, launchOptions }: RemoteProcessManagerProps) {
  const isWindowsHost = isWindowsSystem(systemType);
  const isMountedRef = useRef(true);
  const isRefreshingRef = useRef(false);
  const missingPidNoticeRef = useRef<number | null>(null);
  const [processes, setProcesses] = useState<RemoteProcessEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [signalingPid, setSignalingPid] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [success, setSuccess] = useState('');
  const [search, setSearch] = useState(launchOptions?.search ?? '');
  const [userFilter, setUserFilter] = useState(launchOptions?.user ?? 'all');
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [autoRefreshMs, setAutoRefreshMs] = useState<(typeof AUTO_REFRESH_OPTIONS)[number]>(DEFAULT_AUTO_REFRESH_MS);
  const [sortKey, setSortKey] = useState<RemoteProcessManagerSortKey>(launchOptions?.sortKey ?? 'cpu');
  const [sortDir, setSortDir] = useState<SortDir>(launchOptions?.sortDir ?? 'desc');
  const [viewMode, setViewMode] = useState<RemoteProcessManagerViewMode>(launchOptions?.viewMode ?? 'table');
  const [selectedSignalValue, setSelectedSignalValue] = useState(DEFAULT_SIGNAL.value);
  const [selectedPid, setSelectedPid] = useState<number | null>(launchOptions?.pid ?? null);
  const [processDetail, setProcessDetail] = useState<ProcessDetail | null>(null);
  const [pendingSignal, setPendingSignal] = useState<PendingSignal | null>(null);
  const [aiReportOpen, setAiReportOpen] = useState(false);
  const [aiReportPhase, setAiReportPhase] = useState<ProcessAiReportPhase>('idle');
  const [aiReportText, setAiReportText] = useState('');
  const [aiReportError, setAiReportError] = useState('');
  const [aiReportNotice, setAiReportNotice] = useState('');
  const [aiReportGeneratedAt, setAiReportGeneratedAt] = useState('');
  const [aiReportSnapshotNote, setAiReportSnapshotNote] = useState('');
  const [processInsight, setProcessInsight] = useState<ProcessAiInsight | null>(null);
  const [processInsightLoadingPid, setProcessInsightLoadingPid] = useState<number | null>(null);

  const selectedSignal = getSignalByValue(selectedSignalValue);
  const isAiReportBusy = aiReportPhase === 'preparing' || aiReportPhase === 'requesting' || aiReportPhase === 'streaming';

  const refresh = useCallback(async (options?: { silent?: boolean }) => {
    if (isRefreshingRef.current) {
      return;
    }

    isRefreshingRef.current = true;

    if (!options?.silent) {
      setLoading(true);
    }

    setError('');

    try {
      const result = await runCmd(
        connectionId,
        isWindowsHost ? getWindowsProcessListCommand() : getLinuxProcessListCommand(),
      );
      const nextProcesses = isWindowsHost
        ? parseWindowsProcessOutput(result.stdout || '')
        : parseLinuxProcessOutput(result.stdout || '');

      if (!isMountedRef.current) {
        return;
      }

      setProcesses(nextProcesses);

      if (result.code !== 0 && !nextProcesses.length) {
        setError(result.stderr || '无法读取远程进程列表。');
      }
    } catch (err) {
      if (isMountedRef.current) {
        setError(getErrorMessage(err));
      }
    } finally {
      isRefreshingRef.current = false;

      if (isMountedRef.current && !options?.silent) {
        setLoading(false);
      }
    }
  }, [connectionId, isWindowsHost]);

  const loadProcessDetails = useCallback(async (pid: number) => {
    if (!Number.isInteger(pid) || pid <= 0) {
      return;
    }

    setDetailLoading(true);

    try {
      const result = await runCmd(
        connectionId,
        isWindowsHost ? getWindowsProcessDetailCommand(pid) : getLinuxProcessDetailCommand(pid),
      );
      const nextDetail = parseProcessDetailOutput(result.stdout || '', pid);

      if (result.code !== 0) {
        nextDetail.error = result.stderr || '无法读取进程详情，可能权限不足。';
      }

      if (isMountedRef.current) {
        setProcessDetail(nextDetail);
      }
    } catch (err) {
      if (isMountedRef.current) {
        setProcessDetail({
          pid,
          ports: [],
          loadedAt: Date.now(),
          error: getErrorMessage(err),
        });
      }
    } finally {
      if (isMountedRef.current) {
        setDetailLoading(false);
      }
    }
  }, [connectionId, isWindowsHost]);

  useEffect(() => {
    isMountedRef.current = true;
    void refresh();

    return () => {
      isMountedRef.current = false;
      isRefreshingRef.current = false;
    };
  }, [refresh]);

  useEffect(() => {
    if (!launchOptions) {
      return;
    }

    if (typeof launchOptions.search === 'string') {
      setSearch(launchOptions.search);
    }

    if (typeof launchOptions.user === 'string') {
      setUserFilter(launchOptions.user);
    }

    if (launchOptions.sortKey) {
      setSortKey(launchOptions.sortKey);
    }

    if (launchOptions.sortDir) {
      setSortDir(launchOptions.sortDir);
    }

    if (launchOptions.viewMode) {
      setViewMode(launchOptions.viewMode);
    }

    if (Number.isInteger(launchOptions.pid) && launchOptions.pid! > 0) {
      setSelectedPid(launchOptions.pid!);
    }
  }, [launchOptions]);

  useEffect(() => {
    if (!autoRefresh) {
      return undefined;
    }

    let canceled = false;
    let timerId: number | undefined;

    const scheduleTick = () => {
      if (canceled) {
        return;
      }

      timerId = window.setTimeout(async () => {
        if (!pendingSignal && signalingPid === null) {
          await refresh({ silent: true });
        }

        scheduleTick();
      }, autoRefreshMs);
    };

    scheduleTick();

    return () => {
      canceled = true;

      if (timerId !== undefined) {
        window.clearTimeout(timerId);
      }
    };
  }, [autoRefresh, autoRefreshMs, pendingSignal, refresh, signalingPid]);

  useEffect(() => {
    if (selectedPid === null) {
      setProcessDetail(null);
      return;
    }

    void loadProcessDetails(selectedPid);
  }, [loadProcessDetails, selectedPid]);

  const compare = useCallback((first: RemoteProcessEntry, second: RemoteProcessEntry) => (
    compareProcesses(first, second, sortKey, sortDir, isWindowsHost)
  ), [isWindowsHost, sortDir, sortKey]);

  const users = useMemo(() => {
    const uniqueUsers = new Set(
      processes
        .map((process) => process.user?.trim())
        .filter((user): user is string => Boolean(user && user !== '-')),
    );

    return [...uniqueUsers].sort((first, second) => first.localeCompare(second, 'zh-CN'));
  }, [processes]);

  const baseFilteredProcesses = useMemo(() => {
    const normalizedSearch = search.trim();

    return processes.filter((process) => {
      const matchesUser = userFilter === 'all' || process.user === userFilter;
      return matchesUser && matchesQuery(process, normalizedSearch);
    });
  }, [processes, search, userFilter]);

  const processRows = useMemo<ProcessRow[]>(() => {
    const basePids = new Set(baseFilteredProcesses.map((process) => process.pid));
    const normalizedSearch = search.trim();

    if (viewMode === 'table') {
      return [...baseFilteredProcesses]
        .sort(compare)
        .map((process) => ({ process, depth: 0 }));
    }

    if (normalizedSearch) {
      const processByPid = new Map(processes.map((process) => [process.pid, process]));

      baseFilteredProcesses.forEach((process) => {
        let parentPid = process.ppid;
        let guard = 0;

        while (parentPid !== undefined && guard < 64) {
          const parent = processByPid.get(parentPid);

          if (!parent) {
            break;
          }

          basePids.add(parent.pid);
          parentPid = parent.ppid;
          guard += 1;
        }

        processes
          .filter((candidate) => candidate.ppid === process.pid)
          .forEach((child) => basePids.add(child.pid));
      });
    }

    return flattenProcessTree(processes, basePids, compare);
  }, [baseFilteredProcesses, compare, processes, search, viewMode]);

  const selectedProcess = useMemo(() => {
    if (selectedPid === null) {
      return null;
    }

    return processes.find((process) => process.pid === selectedPid) ?? null;
  }, [processes, selectedPid]);

  const selectedParent = useMemo(() => {
    if (!selectedProcess?.ppid) {
      return null;
    }

    return processes.find((process) => process.pid === selectedProcess.ppid) ?? null;
  }, [processes, selectedProcess]);

  const selectedChildren = useMemo(() => {
    if (!selectedProcess) {
      return [];
    }

    return processes
      .filter((process) => process.ppid === selectedProcess.pid)
      .sort(compare);
  }, [compare, processes, selectedProcess]);

  const maxCpuValue = useMemo(() => Math.max(1, ...processes.map((process) => getCpuValue(process, isWindowsHost))), [isWindowsHost, processes]);
  const maxMemoryValue = useMemo(() => Math.max(1, ...processes.map((process) => getMemoryValue(process, isWindowsHost))), [isWindowsHost, processes]);

  useEffect(() => {
    if (selectedPid !== null && processes.some((process) => process.pid === selectedPid)) {
      missingPidNoticeRef.current = null;
      setNotice('');
      return;
    }

    if (selectedPid !== null && processes.length > 0 && !loading && missingPidNoticeRef.current !== selectedPid) {
      missingPidNoticeRef.current = selectedPid;
      setNotice(`PID ${selectedPid} 当前不在列表中，可能已经退出或权限不可见。`);
    }

    if (selectedPid === null && processRows.length > 0) {
      setSelectedPid(processRows[0].process.pid);
    }
  }, [loading, processRows, processes, selectedPid]);

  const toggleSort = (key: RemoteProcessManagerSortKey) => {
    if (sortKey === key) {
      setSortDir((currentDir) => (currentDir === 'asc' ? 'desc' : 'asc'));
      return;
    }

    setSortKey(key);
    setSortDir(key === 'user' || key === 'command' || key === 'state' ? 'asc' : 'desc');
  };

  const sortIndicator = (key: RemoteProcessManagerSortKey) => {
    if (sortKey !== key) {
      return <span className="proc-sort-icon" aria-hidden="true" />;
    }

    return <span className="proc-sort-icon" aria-hidden="true">{sortDir === 'asc' ? '▲' : '▼'}</span>;
  };

  const copyToClipboard = async (value: string, label: string) => {
    setError('');
    setNotice('');
    setSuccess('');

    try {
      await navigator.clipboard.writeText(value);
      setSuccess(`已复制${label}。`);
    } catch (err) {
      setError(`复制失败：${getErrorMessage(err)}`);
    }
  };

  const requestSignal = (process: RemoteProcessEntry) => {
    setPendingSignal({
      pid: process.pid,
      command: process.command,
      signal: isWindowsHost
        ? {
            value: 'win-kill',
            name: 'Stop-Process',
            label: '结束任务',
            description: 'Windows 将强制结束该 PID，对未保存状态的程序不做清理保证。',
          }
        : selectedSignal,
    });
  };

  const sendSignal = async (pending: PendingSignal) => {
    if (!Number.isInteger(pending.pid) || pending.pid <= 0) {
      setError('PID 无效。');
      return;
    }

    setSignalingPid(pending.pid);
    setError('');
    setNotice('');
    setSuccess('');

    try {
      const command = isWindowsHost
        ? powershellCommand(`Stop-Process -Id ${pending.pid} -Force -ErrorAction Stop`)
        : `kill -${pending.signal.value} ${pending.pid} 2>&1`;
      const result = await runCmd(connectionId, command);

      if (result.code !== 0) {
        throw new Error(result.stderr || result.stdout || '操作失败，PID 可能不存在或当前用户权限不足。');
      }

      setSuccess(isWindowsHost
        ? `已结束 PID ${pending.pid}。`
        : `已向 PID ${pending.pid} 发送 ${pending.signal.name}。`);
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSignalingPid(null);
      setPendingSignal(null);
    }
  };

  const requestAiReport = useCallback(async () => {
    if (isAiReportBusy) {
      setAiReportOpen(true);
      return;
    }

    setAiReportOpen(true);
    setAiReportPhase('preparing');
    setAiReportText('');
    setAiReportError('');
    setAiReportNotice('');
    setAiReportGeneratedAt('');
    setAiReportSnapshotNote('');

    if (!processes.length) {
      setAiReportPhase('error');
      setAiReportError('当前没有可分析的进程快照，请先刷新列表。');
      return;
    }

    const readinessError = getAiReadinessError(settings);

    if (readinessError) {
      setAiReportPhase('error');
      setAiReportError(readinessError);
      return;
    }

    const aiControls = window.guiSSH?.ai;
    const snapshot = createProcessAiSnapshot(processes, isWindowsHost);
    const snapshotNote = snapshot.omittedCount > 0
      ? `已发送 ${snapshot.includedCount} / ${processes.length} 个进程；${snapshot.omittedCount} 个进程因单条消息长度限制未发送。`
      : `已发送 ${snapshot.includedCount} 个进程。`;
    const messages: ShellDeskAiChatMessage[] = [
      {
        role: 'system',
        content: PROCESS_AI_REPORT_SYSTEM_PROMPT,
      },
      {
        role: 'user',
        content: [
          '请分析下面这份 ShellDesk 远程主机进程快照，判断是否存在病毒木马、异常后门、挖矿、伪装系统进程、异常路径、异常命令行、高风险网络服务或其他安全风险。',
          '输出格式：',
          '1. 总体结论：用 2-4 句话概括整体风险。',
          '2. 高风险/可疑进程：用表格列出 PID、进程/命令、风险等级、可疑依据、建议动作。',
          '3. 需要继续核验：列出无法仅凭进程快照确认但值得检查的项。',
          '4. 建议处置：按优先级给出低破坏性的核验和处置步骤。',
          '如果没有明确的威胁进程，请明确说明未发现明显恶意特征，并将第 2、3、4 部分压缩为简短要点；第 2 部分可以写“未发现明确威胁进程”。',
          '',
          snapshot.text,
        ].join('\n'),
      },
    ];
    const request = createAiChatRequest(settings, messages, 0.1);
    let streamedContent = '';
    const streamedTextUpdater = createStreamedTextUpdater(setAiReportText, '正在生成报告...');

    setAiReportSnapshotNote(snapshotNote);
    setAiReportPhase(aiControls?.chatStream ? 'streaming' : 'requesting');

    try {
      let resultContent = '';

      if (aiControls?.chatStream) {
        try {
          const result = await aiControls.chatStream(request, {
            onChunk: (chunk) => {
              streamedContent += chunk;
              streamedTextUpdater.append(chunk);
            },
          });
          streamedTextUpdater.flush();
          resultContent = result.content || streamedContent;
        } catch (streamError) {
          streamedTextUpdater.cancel();

          if (streamedContent || !aiControls.chat) {
            throw streamError;
          }

          setAiReportPhase('requesting');
          const result = await aiControls.chat(request);
          resultContent = result.content;
        }
      } else if (aiControls?.chat) {
        const result = await aiControls.chat(request);
        resultContent = result.content;
      }

      setAiReportText(resultContent || 'SD-Agent 没有返回报告内容。');
      setAiReportGeneratedAt(new Date().toLocaleString('zh-CN'));
      setAiReportPhase('done');
    } catch (err) {
      setAiReportPhase('error');
      setAiReportError(`SD-Agent 请求失败：${getErrorMessage(err)}`);
    }
  }, [isAiReportBusy, isWindowsHost, processes, settings]);

  const requestProcessInsight = useCallback(async () => {
    if (!selectedProcess || processInsightLoadingPid !== null) {
      return;
    }

    const readinessError = getAiReadinessError(settings);

    if (readinessError) {
      setProcessInsight({
        pid: selectedProcess.pid,
        content: '',
        error: readinessError,
      });
      return;
    }

    const aiControls = window.guiSSH?.ai;
    const detail = processDetail?.pid === selectedProcess.pid ? processDetail : null;
    const messages: ShellDeskAiChatMessage[] = [
      {
        role: 'system',
        content: PROCESS_AI_INSIGHT_SYSTEM_PROMPT,
      },
      {
        role: 'user',
        content: [
          '请介绍这个进程通常是做什么的。本次回答只需要 2-4 句话，先说常见用途，再说当前快照中是否有明显异常和需要核验的点。',
          '',
          formatProcessContextForAi(selectedProcess, isWindowsHost, detail, selectedParent, selectedChildren),
        ].join('\n'),
      },
    ];
    const request = createAiChatRequest(settings, messages, 0.2);
    let streamedContent = '';

    setProcessInsightLoadingPid(selectedProcess.pid);
    setProcessInsight({
      pid: selectedProcess.pid,
      content: 'SD-Agent 正在分析这个进程...',
    });

    try {
      let resultContent = '';

      if (aiControls?.chatStream) {
        try {
          const result = await aiControls.chatStream(request, {
            onChunk: (chunk) => {
              streamedContent += chunk;
              setProcessInsight({
                pid: selectedProcess.pid,
                content: streamedContent || 'SD-Agent 正在分析这个进程...',
              });
            },
          });
          resultContent = result.content || streamedContent;
        } catch (streamError) {
          if (streamedContent || !aiControls.chat) {
            throw streamError;
          }

          const result = await aiControls.chat(request);
          resultContent = result.content;
        }
      } else if (aiControls?.chat) {
        const result = await aiControls.chat(request);
        resultContent = result.content;
      }

      setProcessInsight({
        pid: selectedProcess.pid,
        content: resultContent || 'SD-Agent 没有返回进程简介。',
      });
    } catch (err) {
      setProcessInsight({
        pid: selectedProcess.pid,
        content: '',
        error: `SD-Agent 请求失败：${getErrorMessage(err)}`,
      });
    } finally {
      setProcessInsightLoadingPid(null);
    }
  }, [
    isWindowsHost,
    processDetail,
    processInsightLoadingPid,
    selectedChildren,
    selectedParent,
    selectedProcess,
    settings,
  ]);

  const copyAiReport = async () => {
    if (!aiReportText.trim()) {
      return;
    }

    setAiReportNotice('');
    setAiReportError('');

    try {
      await navigator.clipboard.writeText(createAiReportDocument(aiReportText, aiReportGeneratedAt, aiReportSnapshotNote));
      setAiReportNotice('已复制 AI 报告。');
    } catch (err) {
      setAiReportError(`复制失败：${getErrorMessage(err)}`);
    }
  };

  const exportAiReport = async () => {
    if (!aiReportText.trim()) {
      return;
    }

    const saveTextFile = window.guiSSH?.files?.saveTextFile;

    if (!saveTextFile) {
      setAiReportError('当前运行环境不支持导出报告。');
      return;
    }

    setAiReportNotice('');
    setAiReportError('');

    try {
      const filePath = await saveTextFile({
        title: '导出 AI 进程分析报告',
        defaultFileName: createAiReportFileName(),
        content: createAiReportDocument(aiReportText, aiReportGeneratedAt, aiReportSnapshotNote),
      });

      if (filePath) {
        setAiReportNotice(`已导出 AI 报告：${filePath}`);
      }
    } catch (err) {
      setAiReportError(`导出失败：${getErrorMessage(err)}`);
    }
  };

  const renderSortHeader = (key: RemoteProcessManagerSortKey, label: string, className: string) => (
    <th className={className}>
      <button type="button" className="proc-sort-button" onClick={() => toggleSort(key)}>
        <span>{label}</span>
        {sortIndicator(key)}
      </button>
    </th>
  );

  const renderProcessRow = ({ process, depth }: ProcessRow) => {
    const isSelected = selectedPid === process.pid;
    const stateTone = getStateTone(process.state);
    const cpuValue = getCpuValue(process, isWindowsHost);
    const memoryValue = getMemoryValue(process, isWindowsHost);
    const cpuWidth = isWindowsHost ? (cpuValue / maxCpuValue) * 100 : clampPercent(cpuValue);
    const memoryWidth = isWindowsHost ? (memoryValue / maxMemoryValue) * 100 : clampPercent(memoryValue);

    return (
      <tr
        key={process.pid}
        className={`proc-row ${isSelected ? 'selected' : ''} ${stateTone === 'zombie' ? 'proc-zombie' : ''}`}
        onClick={() => setSelectedPid(process.pid)}
      >
        <td className="proc-pid">{process.pid}</td>
        <td className="proc-ppid">{process.ppid ?? '-'}</td>
        <td className="proc-user" title={process.user}>{process.user || '-'}</td>
        <td className="proc-cpu">
          <div className="proc-bar-wrap">
            <div className="proc-bar proc-bar-cpu" style={{ width: `${cpuWidth}%` }} />
            <span>{formatCpu(process, isWindowsHost)}</span>
          </div>
        </td>
        <td className="proc-mem">
          <div className="proc-bar-wrap">
            <div className="proc-bar proc-bar-mem" style={{ width: `${memoryWidth}%` }} />
            <span>{formatMemory(process, isWindowsHost)}</span>
          </div>
        </td>
        <td className="proc-stat">
          <span className={`proc-stat-tag ${stateTone}`}>{process.state || '-'}</span>
        </td>
        <td className="proc-start">{process.startTime || '-'}</td>
        <td className="proc-runtime">{process.runtime || process.cpuTime || '-'}</td>
        <td className="proc-command" title={process.command}>
          {viewMode === 'tree' ? <span className="proc-tree-indent" style={{ width: depth * 14 }} /> : null}
          {viewMode === 'tree' && depth > 0 ? <span className="proc-tree-branch" aria-hidden="true">└</span> : null}
          <span>{process.command}</span>
        </td>
      </tr>
    );
  };

  return (
    <div className="proc-manager">
      <div className="proc-toolbar">
        <div className="proc-toolbar-left">
          <button
            type="button"
            className="proc-tool-button ai"
            onClick={() => void requestAiReport()}
            disabled={loading || (!processes.length && !isAiReportBusy)}
          >
            {isAiReportBusy ? 'AI 分析中' : 'AI分析'}
          </button>

          <button type="button" className="proc-tool-button primary" onClick={() => void refresh()} disabled={loading}>
            {loading ? '刷新中' : '刷新'}
          </button>

          <div className="proc-segmented" aria-label="列表模式">
            <button type="button" className={viewMode === 'table' ? 'active' : ''} onClick={() => setViewMode('table')}>
              表格
            </button>
            <button type="button" className={viewMode === 'tree' ? 'active' : ''} onClick={() => setViewMode('tree')}>
              树
            </button>
          </div>

          <label className="proc-check-label">
            <input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />
            自动刷新
          </label>

          <select
            className="proc-select proc-refresh-select"
            value={autoRefreshMs}
            onChange={(event) => setAutoRefreshMs(Number(event.target.value) as (typeof AUTO_REFRESH_OPTIONS)[number])}
            disabled={!autoRefresh}
            aria-label="自动刷新间隔"
          >
            {AUTO_REFRESH_OPTIONS.map((interval) => (
              <option key={interval} value={interval}>{interval / 1000}s</option>
            ))}
          </select>

          <span className="proc-summary">
            <strong>{processRows.length}</strong> / {processes.length}
          </span>
        </div>

        <div className="proc-toolbar-right">
          <select
            className="proc-select proc-user-filter"
            value={userFilter}
            onChange={(event) => setUserFilter(event.target.value)}
            aria-label="按用户筛选"
          >
            <option value="all">全部用户</option>
            {users.map((user) => (
              <option key={user} value={user}>{user}</option>
            ))}
          </select>

          <input
            type="search"
            className="proc-search"
            placeholder="搜索 PID、用户、命令..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      </div>

      {error ? <div className="proc-alert danger">{error}</div> : null}
      {notice ? <div className="proc-alert info">{notice}</div> : null}
      {success ? <div className="proc-alert success">{success}</div> : null}

      <div className="proc-content">
        <section className="proc-table-panel" aria-label="进程列表">
          <div className="proc-table-wrap">
            <table className="proc-table">
              <thead>
                <tr>
                  {renderSortHeader('pid', 'PID', 'proc-col-pid')}
                  {renderSortHeader('ppid', 'PPID', 'proc-col-ppid')}
                  {renderSortHeader('user', '用户', 'proc-col-user')}
                  {renderSortHeader('cpu', isWindowsHost ? 'CPU(s)' : 'CPU%', 'proc-col-cpu')}
                  {renderSortHeader('memory', isWindowsHost ? '内存 MB' : 'MEM%', 'proc-col-mem')}
                  {renderSortHeader('state', '状态', 'proc-col-stat')}
                  {renderSortHeader('startTime', '启动', 'proc-col-start')}
                  {renderSortHeader('runtime', isWindowsHost ? 'CPU 时间' : '运行', 'proc-col-runtime')}
                  {renderSortHeader('command', '命令', 'proc-col-command')}
                </tr>
              </thead>
              <tbody>
                {processRows.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="proc-empty">
                      {loading ? '正在加载进程列表...' : '暂无匹配的进程。'}
                    </td>
                  </tr>
                ) : (
                  processRows.map(renderProcessRow)
                )}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="proc-detail-panel" aria-label="进程详情">
          {selectedProcess ? (
            <>
              <header className="proc-detail-header">
                <span>PID</span>
                <strong>{selectedProcess.pid}</strong>
                <div className="proc-detail-header-actions">
                  <button
                    type="button"
                    onClick={() => void requestProcessInsight()}
                    disabled={processInsightLoadingPid !== null}
                    title="AI 简介"
                  >
                    {processInsightLoadingPid === selectedProcess.pid ? '分析中' : 'AI'}
                  </button>
                  <button type="button" onClick={() => void copyToClipboard(String(selectedProcess.pid), ' PID')}>
                    复制
                  </button>
                </div>
              </header>

              <div className="proc-detail-metrics">
                <div>
                  <span>{isWindowsHost ? 'CPU 累计' : 'CPU'}</span>
                  <strong>{formatCpu(selectedProcess, isWindowsHost)}</strong>
                </div>
                <div>
                  <span>{isWindowsHost ? '工作集' : '内存'}</span>
                  <strong>{formatMemory(selectedProcess, isWindowsHost)}</strong>
                </div>
              </div>

              <dl className="proc-detail-list">
                <div>
                  <dt>PPID</dt>
                  <dd>{selectedProcess.ppid ?? '-'}</dd>
                </div>
                <div>
                  <dt>用户</dt>
                  <dd title={selectedProcess.user}>{selectedProcess.user || '-'}</dd>
                </div>
                <div>
                  <dt>状态</dt>
                  <dd><span className={`proc-stat-tag ${getStateTone(selectedProcess.state)}`}>{selectedProcess.state || '-'}</span></dd>
                </div>
                <div>
                  <dt>启动</dt>
                  <dd>{selectedProcess.startTime || '-'}</dd>
                </div>
                <div>
                  <dt>{isWindowsHost ? 'CPU 时间' : '运行时间'}</dt>
                  <dd>{selectedProcess.runtime || selectedProcess.cpuTime || '-'}</dd>
                </div>
                <div>
                  <dt>TTY</dt>
                  <dd>{selectedProcess.tty || '-'}</dd>
                </div>
              </dl>

              {processInsight?.pid === selectedProcess.pid ? (
                <section className={`proc-ai-insight ${processInsight.error ? 'danger' : ''}`} aria-label="AI 进程简介">
                  <strong>AI 简介</strong>
                  {processInsight.error ? (
                    <span>{processInsight.error}</span>
                  ) : (
                    <p data-i18n-skip>{processInsight.content}</p>
                  )}
                </section>
              ) : null}

              <section className="proc-detail-section">
                <div className="proc-section-title">
                  <strong>命令行</strong>
                  <button type="button" onClick={() => void copyToClipboard(selectedProcess.command, '命令行')}>
                    复制
                  </button>
                </div>
                <pre className="proc-command-box">{selectedProcess.command}</pre>
                {(processDetail?.cwd || processDetail?.executablePath || selectedProcess.executablePath) ? (
                  <div className="proc-path-list">
                    {processDetail?.cwd ? <span title={processDetail.cwd}>cwd: {processDetail.cwd}</span> : null}
                    {processDetail?.executablePath || selectedProcess.executablePath ? (
                      <span title={processDetail?.executablePath || selectedProcess.executablePath}>
                        path: {processDetail?.executablePath || selectedProcess.executablePath}
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </section>

              <section className="proc-detail-section">
                <div className="proc-section-title">
                  <strong>父子关系</strong>
                  <span>{selectedChildren.length} 个子进程</span>
                </div>
                <div className="proc-relation-list">
                  {selectedParent ? (
                    <button type="button" onClick={() => setSelectedPid(selectedParent.pid)}>
                      <span>父进程</span>
                      <strong>{selectedParent.pid}</strong>
                      <em>{selectedParent.command}</em>
                    </button>
                  ) : (
                    <div className="proc-relation-empty">未在当前快照中找到父进程。</div>
                  )}
                  {selectedChildren.slice(0, 8).map((child) => (
                    <button key={child.pid} type="button" onClick={() => setSelectedPid(child.pid)}>
                      <span>子进程</span>
                      <strong>{child.pid}</strong>
                      <em>{child.command}</em>
                    </button>
                  ))}
                  {selectedChildren.length > 8 ? (
                    <div className="proc-relation-empty">还有 {selectedChildren.length - 8} 个子进程。</div>
                  ) : null}
                </div>
              </section>

              <section className="proc-detail-section">
                <div className="proc-section-title">
                  <strong>端口归属</strong>
                  <button type="button" onClick={() => void loadProcessDetails(selectedProcess.pid)} disabled={detailLoading}>
                    {detailLoading ? '读取中' : '重读'}
                  </button>
                </div>
                {processDetail?.error ? <div className="proc-detail-warning">{processDetail.error}</div> : null}
                {processDetail?.ports.length ? (
                  <div className="proc-port-list">
                    {processDetail.ports.slice(0, 6).map((port) => <code key={port}>{port}</code>)}
                    {processDetail.ports.length > 6 ? <span>还有 {processDetail.ports.length - 6} 条端口记录。</span> : null}
                  </div>
                ) : (
                  <div className="proc-relation-empty">{detailLoading ? '正在读取端口...' : '未发现该进程打开的端口。'}</div>
                )}
              </section>

              <section className="proc-detail-section danger-zone">
                <div className="proc-section-title">
                  <strong>{isWindowsHost ? '结束任务' : '发送信号'}</strong>
                </div>
                {!isWindowsHost ? (
                  <>
                    <select className="proc-select" value={selectedSignalValue} onChange={(event) => setSelectedSignalValue(event.target.value)}>
                      {SIGNALS.map((signal) => (
                        <option key={signal.value} value={signal.value}>{signal.label}</option>
                      ))}
                    </select>
                    <p>{selectedSignal.description}</p>
                  </>
                ) : (
                  <p>Windows 将使用 Stop-Process -Force 结束该 PID。</p>
                )}
                <button
                  type="button"
                  className="proc-danger-button"
                  disabled={signalingPid === selectedProcess.pid}
                  onClick={() => requestSignal(selectedProcess)}
                >
                  {signalingPid === selectedProcess.pid ? '处理中' : isWindowsHost ? '结束进程' : `发送 ${selectedSignal.name}`}
                </button>
              </section>
            </>
          ) : (
            <div className="proc-detail-empty">
              <strong>{selectedPid === null ? '未选中进程' : `PID ${selectedPid} 不在当前快照中`}</strong>
              <span>{selectedPid === null ? '从左侧列表选择一个 PID 查看详情。' : '该进程可能已经退出，或当前用户没有查看权限。'}</span>
            </div>
          )}
        </aside>
      </div>

      {aiReportOpen ? createPortal(
        <div className="proc-modal-overlay" role="presentation" onClick={() => setAiReportOpen(false)}>
          <div
            className="proc-modal proc-ai-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="proc-ai-report-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="proc-ai-modal-header">
              <div>
                <span>SD-Agent</span>
                <strong id="proc-ai-report-title">进程风险分析</strong>
              </div>
              <button type="button" className="proc-ai-close" onClick={() => setAiReportOpen(false)} aria-label="关闭 AI 分析弹窗">×</button>
            </div>

            <div className={`proc-ai-progress ${aiReportPhase}`}>
              <div className="proc-ai-progress-bar" aria-hidden="true">
                <span />
              </div>
              <strong>{getAiReportPhaseLabel(aiReportPhase)}</strong>
              <em>{aiReportSnapshotNote || '将当前进程快照发送给 SD-Agent 进行静态研判。'}</em>
            </div>

            {aiReportError ? <div className="proc-alert danger">{aiReportError}</div> : null}
            {aiReportNotice ? <div className="proc-alert success">{aiReportNotice}</div> : null}

            <MarkdownReport
              className="proc-ai-report"
              content={aiReportText}
              placeholder={isAiReportBusy ? '报告生成中...' : '点击 AI分析 后会在这里显示报告。'}
              renderMarkdown={!isAiReportBusy}
              stickToBottom={isAiReportBusy}
            />

            <div className="proc-modal-actions proc-ai-modal-actions">
              <button type="button" className="proc-modal-btn" onClick={() => setAiReportOpen(false)}>关闭</button>
              <button type="button" className="proc-modal-btn" onClick={() => void copyAiReport()} disabled={!aiReportText.trim()}>
                复制报告
              </button>
              <button type="button" className="proc-modal-btn primary" onClick={() => void exportAiReport()} disabled={!aiReportText.trim()}>
                导出报告
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}

      {pendingSignal ? createPortal(
        <div className="proc-modal-overlay" role="presentation" onClick={() => setPendingSignal(null)}>
          <div
            className="proc-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="proc-signal-confirm-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div id="proc-signal-confirm-title" className="proc-modal-title">
              {isWindowsHost ? '结束进程' : `发送 ${pendingSignal.signal.name}`}
            </div>
            <div className="proc-modal-message">
              <p>目标 PID：<strong>{pendingSignal.pid}</strong></p>
              <p>{pendingSignal.signal.description}</p>
              <code>{pendingSignal.command}</code>
            </div>
            <div className="proc-modal-actions">
              <button type="button" className="proc-modal-btn" onClick={() => setPendingSignal(null)}>取消</button>
              <button type="button" className="proc-modal-btn danger" onClick={() => void sendSignal(pendingSignal)}>
                确认执行
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

export default ProcessManager;
