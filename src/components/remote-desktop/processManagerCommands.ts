import { t, type AppLanguage } from '../../i18n';
import { powershellCommand, powershellStdinCommand } from './remoteSystem';
import type { RemoteProcessManagerSortKey, SignalDefinition } from './processManagerTypes';

export const SIGNALS: SignalDefinition[] = [
  {
    value: '15',
    name: 'TERM',
    label: 'TERM',
    descriptionId: 'process.signal.term.description',
  },
  {
    value: '9',
    name: 'KILL',
    label: 'KILL',
    descriptionId: 'process.signal.kill.description',
  },
  {
    value: '2',
    name: 'INT',
    label: 'INT',
    descriptionId: 'process.signal.int.description',
  },
  {
    value: '1',
    name: 'HUP',
    label: 'HUP',
    descriptionId: 'process.signal.hup.description',
  },
];

export const DEFAULT_SIGNAL = SIGNALS[0];

export function getSignalByValue(value: string) {
  return SIGNALS.find((signal) => signal.value === value) ?? DEFAULT_SIGNAL;
}

export function getVisibleProcessSortKey(sortKey: RemoteProcessManagerSortKey | undefined): RemoteProcessManagerSortKey {
  if (sortKey && sortKey !== 'state' && sortKey !== 'startTime' && sortKey !== 'runtime') {
    return sortKey;
  }

  return 'cpu';
}

export function getLinuxSignalCommand(signalValue: string, pid: number) {
  const signal = getSignalByValue(signalValue).value;

  return `
if [ "$(id -u 2>/dev/null)" = "0" ]; then
  kill -${signal} ${pid} 2>&1
elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  sudo -n kill -${signal} ${pid} 2>&1
else
  kill -${signal} ${pid} 2>&1
fi
`;
}

export function getProcessSignalCommand(isWindowsHost: boolean, signalValue: string, pid: number) {
  return isWindowsHost
    ? powershellCommand(`Stop-Process -Id ${pid} -Force -ErrorAction Stop`)
    : getLinuxSignalCommand(signalValue, pid);
}

export function getLinuxProcessListCommand(language: AppLanguage) {
  const noCommand = t('process.placeholder.noCommand', language);
  const noDataMessage = t('process.error.noProcessData', language);

  return `
format='pid=,ppid=,user=,pcpu=,pmem=,vsz=,rss=,tty=,stat=,start=,etime=,time=,args='
output="$(ps -eo "$format" 2>/dev/null || true)"
if [ -z "$output" ]; then
  output="$(ps -eo pid=,ppid=,user=,pcpu=,pmem=,vsz=,rss=,tty=,stat=,start=,etime=,time=,command= 2>/dev/null || true)"
fi
if [ -z "$output" ]; then
  output="$(ps aux 2>/dev/null || true)"
fi
if [ -n "$output" ]; then
  if printf '%s\\n' "$output" | head -n 800 | awk '
    BEGIN { OFS = "\\t"; count = 0 }
    /^[[:space:]]*USER[[:space:]]+PID[[:space:]]+/ { next }
    {
      if ($1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ && $4 ~ /^[0-9.]+$/ && $5 ~ /^[0-9.]+$/) {
        command = ""
        for (i = 13; i <= NF; i++) command = command (i == 13 ? "" : " ") $i
        print "PROC", $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, command
        count += 1
        next
      }
      if ($2 ~ /^[0-9]+$/ && $3 ~ /^[0-9.]+$/ && $4 ~ /^[0-9.]+$/) {
        command = ""
        for (i = 11; i <= NF; i++) command = command (i == 11 ? "" : " ") $i
        print "PROC", $2, "", $1, $3, $4, $5, $6, $7, $8, $9, "", $10, command
        count += 1
      }
    }
    END { exit count > 0 ? 0 : 1 }
  '; then
    exit 0
  fi
fi

if [ -d /proc ]; then
  mem_total_kb="$(awk '/^MemTotal:/ { print $2; exit }' /proc/meminfo 2>/dev/null)"
  case "$mem_total_kb" in ''|*[!0-9]*) mem_total_kb=0 ;; esac
  uptime_seconds="$(awk '{ print $1; exit }' /proc/uptime 2>/dev/null)"
  clk_tck="$(getconf CLK_TCK 2>/dev/null || printf '100')"
  page_size_bytes="$(getconf PAGESIZE 2>/dev/null || getconf PAGE_SIZE 2>/dev/null || printf '4096')"
  case "$clk_tck" in ''|*[!0-9]*) clk_tck=100 ;; esac
  case "$page_size_bytes" in ''|*[!0-9]*) page_size_bytes=4096 ;; esac
  page_size_kb=$((page_size_bytes / 1024))
  [ "$page_size_kb" -gt 0 ] || page_size_kb=4
  count=0
  for d in /proc/[0-9]*; do
    [ -d "$d" ] || continue
    pid="\${d##*/}"
    stat_line=""
    [ -r "$d/stat" ] && stat_line="$(cat "$d/stat" 2>/dev/null || true)"
    stat_values=""
    if [ -n "$stat_line" ]; then
      stat_values="$(printf '%s\\n' "$stat_line" | sed 's/^.*) //' | awk -v uptime="$uptime_seconds" -v hz="$clk_tck" -v page_kb="$page_size_kb" -v mem_total="$mem_total_kb" '
        {
          utime = $12 + 0
          stime = $13 + 0
          start_ticks = $20 + 0
          rss_pages = $22 + 0
          cpu = "-"
          mem = "-"
          rss_from_stat = rss_pages * page_kb
          if (uptime > 0 && hz > 0 && start_ticks > 0) {
            elapsed = uptime - (start_ticks / hz)
            if (elapsed > 0) cpu = sprintf("%.2f", ((utime + stime) / hz) / elapsed * 100)
          }
          if (mem_total > 0 && rss_from_stat > 0) {
            mem = sprintf("%.2f", rss_from_stat / mem_total * 100)
          }
          printf " cpu=%s mem=%s rss_stat=%s", cpu, mem, rss_from_stat
        }
      ' 2>/dev/null || true)"
    fi
    status="$(awk '
      /^PPid:/ { ppid = $2 }
      /^Uid:/ { uid = $2 }
      /^State:/ { state = $2 }
      /^VmSize:/ { vsz = $2 }
      /^VmRSS:/ { rss = $2 }
      END {
        if (ppid == "") ppid = "-"
        if (uid == "") uid = "-"
        if (state == "") state = "-"
        if (vsz == "") vsz = "-"
        if (rss == "") rss = "-"
        printf "ppid=%s uid=%s state=%s vsz=%s rss=%s", ppid, uid, state, vsz, rss
      }
    ' "$d/status" 2>/dev/null || true)"
    [ -n "$status" ] || continue
    status="\${status}\${stat_values}"

    command=""
    if [ -r "$d/cmdline" ]; then
      command="$(tr '\\000' ' ' < "$d/cmdline" 2>/dev/null | sed 's/[[:space:]]*$//')"
    fi
    if [ -z "$command" ] && [ -r "$d/comm" ]; then
      comm="$(cat "$d/comm" 2>/dev/null | head -n 1)"
      [ -n "$comm" ] && command="[$comm]"
    fi
    [ -n "$command" ] || command="${noCommand}"

    printf 'PROCFS\\t%s\\t%s\\t%s\\n' "$pid" "$status" "$command"
    count=$((count + 1))
    [ "$count" -ge 800 ] && break
  done
  [ "$count" -gt 0 ] && exit 0
fi

printf '%s\\n' '${noDataMessage}' >&2
exit 1
`;
}

export function getWindowsProcessListCommand(language: AppLanguage) {
  const readFailedMessage = t('process.error.listReadFailed', language);

  return powershellStdinCommand(`
$tab = [char]9

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

function Get-ProcessOwnerText($processEntry) {
  if ($null -eq $processEntry) { return '-' }
  try {
    $userNameProperty = $processEntry.PSObject.Properties['UserName']
    if ($userNameProperty -and -not (Is-Blank $userNameProperty.Value)) {
      return [string]$userNameProperty.Value
    }
  } catch {}

  return '-'
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
  $owner = Get-ProcessOwnerText $proc

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

if ($rowCount -eq 0) {
  [Console]::Error.WriteLine("${readFailedMessage}")
  exit 1
}
`);
}

export function getLinuxProcessDetailCommand(pid: number) {
  return `
{ pwdx ${pid} 2>/dev/null | sed 's/^[^:]*:[[:space:]]*/CWD\\t/'; } || true
if [ -r /proc/${pid}/io ]; then
  awk '
    /^(read_bytes|write_bytes|syscr|syscw|rchar|wchar):/ {
      key = $1
      gsub(":", "", key)
      print "IO\\t" key "\\t" $2
    }
  ' /proc/${pid}/io 2>/dev/null || true
fi
if [ -d /proc/${pid}/task ]; then
  count=0
  for task in /proc/${pid}/task/[0-9]*; do
    [ -d "$task" ] || continue
    tid="\${task##*/}"
    state="$(awk '/^State:/ { print $2; exit }' "$task/status" 2>/dev/null)"
    name="$(cat "$task/comm" 2>/dev/null | head -n 1)"
    printf 'THREAD\\t%s\\t%s\\t\\t\\t%s\\n' "$tid" "\${state:-"-"}" "$name"
    count=$((count + 1))
    [ "$count" -ge 120 ] && break
  done
fi
if command -v ss >/dev/null 2>&1; then
  ss -Htunlp 2>/dev/null | awk -v pid='pid=${pid},' 'index($0, pid) { print "PORT\\t" $0 }'
elif command -v netstat >/dev/null 2>&1; then
  netstat -tunlp 2>/dev/null | awk -v pid='${pid}/' 'index($0, pid) { print "PORT\\t" $0 }'
fi
`;
}

export function getWindowsProcessDetailCommand(pid: number) {
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
  $psProc = Get-Process -Id ${pid} -ErrorAction Stop
  $ioRows = @(
    @('Read bytes', $psProc.IOReadBytes),
    @('Write bytes', $psProc.IOWriteBytes),
    @('Read ops', $psProc.IOReadOperations),
    @('Write ops', $psProc.IOWriteOperations)
  )
  foreach ($row in $ioRows) {
    if ($null -ne $row[1]) { "IO" + $tab + $row[0] + $tab + $row[1] }
  }
  $threadCount = 0
  foreach ($thread in @($psProc.Threads)) {
    if ($threadCount -ge 120) { break }
    $threadCount += 1
    $cpu = ''
    try { if ($thread.TotalProcessorTime) { $cpu = $thread.TotalProcessorTime.ToString() } } catch {}
    "THREAD" + $tab + $thread.Id + $tab + $thread.ThreadState + $tab + $cpu + $tab + $thread.PriorityLevel + $tab + $thread.WaitReason
  }
} catch {}
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
